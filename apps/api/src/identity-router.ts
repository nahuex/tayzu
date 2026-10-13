/**
 * The `identity.*` oRPC router (task 18.3; design D22, Resolved decision Q16).
 * `identity.users.create` is the only way an org admin creates a user: Better
 * Auth's own `POST /admin/create-user` stays off D18's allowlist, and
 * self sign-up is disabled. Called in-process only, through
 * `createRouterClient(router, { context })`; no HTTP route mounts it.
 *
 * The context is the raw, host-supplied value (`tenantId`, `actor`,
 * `principal.roles`), the same shape the catalog router takes. Cerbos is
 * asked first (`user` / `create`, `user.yaml`); any deny, malformed context
 * or Cerbos failure fails closed with `AUTH_FORBIDDEN` before anything is
 * created. The system-generated temporary password is returned in the
 * creation response only, never logged or emailed.
 */
import type { Route } from '@orpc/server';
import type { Pool } from 'pg';
import {
  digestInvitationToken,
  emitAccountLinkEvent,
  emitIdentityEvent,
  emitSessionRevoked,
  generateInvitationToken,
  generateTemporaryPassword,
  nextStatus,
  validatePassword,
  withIdentitySpan,
  wouldLeaveNoSignInMethod,
  type AuthInstance,
} from '@tayzu/auth';
import { RESOURCE_KINDS, type CerbosClient } from '@tayzu/authz';

import {
  createServiceAccount,
  deleteServiceAccount,
  isValidServiceAccountIdentifier,
} from './identity/service-accounts.js';
import type { UserSyncAdapter } from './identity/user-sync-adapter.js';
import type { AuthRepository } from './identity/auth-repository.js';
import type { EmailTenantGate } from './identity/email-tenant-gate.js';
import type { WithUserLock } from './identity/user-lock.js';
import { canonicalEmail, isValidIdentityEmail } from './identity/email-canonical.js';
import { buildInvitationLink } from './identity/invitation-link.js';
import { createDefineIdentityOperation } from './identity/define-operation.js';
import {
  createIdentityTargetResolver,
  type IdentityTargetResolver,
  type ResolvedIdentityTarget,
} from './identity/identity-target.js';
import { runWithIdentityContext } from './identity/identity-context.js';
import {
  parseIdentityInput,
  type InputSchema,
  type ParsedIdentityInput,
} from './identity/parse-input.js';
import {
  CREDENTIAL_NAME_PATTERN,
  DEFAULT_CREDENTIAL_CAP,
  createCredential,
  listCredentials,
  CredentialTargetNotFoundError,
  revokeCredential,
  rotateCredential,
  serviceAccountExists,
} from './identity/credentials.js';

/** Generic on purpose: never says which user, if any, already holds the subject. */
class IdentityLinkRejectedError extends Error {
  readonly code = 'CATALOG_VALIDATION_FAILED' as const;

  constructor() {
    super('The account link was rejected');
    this.name = 'IdentityLinkRejectedError';
  }
}

const ACCOUNT_UNIQUE_CONSTRAINT = 'account_provider_account_uq';

/** Matches by constraint name, never SQLSTATE alone; walks `cause` (drizzle wraps pg errors). */
function isAccountUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    if ((current as { constraint?: unknown }).constraint === ACCOUNT_UNIQUE_CONSTRAINT) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Generic on purpose: never says whether the address already has an account, here or elsewhere. */
class IdentityCreateRejectedError extends Error {
  readonly code = 'CATALOG_VALIDATION_FAILED' as const;

  constructor() {
    super('The user could not be created');
    this.name = 'IdentityCreateRejectedError';
  }
}

class IdentityInputError extends Error {
  readonly code = 'CATALOG_VALIDATION_FAILED' as const;

  constructor() {
    super('The request input is invalid');
    this.name = 'IdentityInputError';
  }
}

/** Better Auth's `APIError` shape, read structurally: its `status` name and `body.code`. */
function providerError(error: unknown): { status?: unknown; code?: unknown } {
  if (typeof error !== 'object' || error === null) return {};
  const { status, body } = error as { status?: unknown; body?: { code?: unknown } | null };
  return { status, code: body?.code };
}

/** Provider codes of an invitation refused for an existing member or a full invitation list (task 7.12). */
const INVITATION_REFUSAL_CODES: readonly unknown[] = [
  'USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION',
  'INVITATION_LIMIT_REACHED',
];

/**
 * Rethrows the generic rejection when `refused` matches a Better Auth refusal, so no
 * provider text or membership information reaches the response (task 7.12).
 */
async function withGenericRefusal<T>(
  call: () => Promise<T>,
  refused: (error: { status?: unknown; code?: unknown }) => boolean,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (refused(providerError(error))) throw new IdentityInputError();
    throw error;
  }
}

export interface CreateIdentityRouterOptions {
  readonly auth: AuthInstance;
  readonly authz: CerbosClient;
  /** The only reader of the `auth` schema (design D14). */
  readonly authRepository: AuthRepository;
  /** The per-user advisory lock `linkSsoAccount` runs its check and link inside (task 8.5i). */
  readonly withUserLock: WithUserLock;
  /** The one gate that sends invitation emails (task 6.5c). */
  readonly emailGate?: EmailTenantGate;
  /** The trusted `INVITATION_LINK_BASE_URL`; the link's origin comes only from it. */
  readonly invitationLinkBaseUrl?: string;
  /** The `tayzu_app` pool the revocation list is read through (task 9.2). */
  readonly appPool?: Pool;
  /** The credential cap of task 9.5d; the viewer's page size. Default 200. */
  readonly credentialCap?: number;
  /** The most service accounts a tenant holds (task 10.8, Q56). Default 50. */
  readonly serviceAccountCap?: number;
  /** The Q30 adapter every `_user` write goes through (service accounts, task 10.3). */
  readonly userSync?: UserSyncAdapter;
}

export interface CreateUserInput {
  readonly email: string;
  readonly name: string;
  readonly role: AssignableOrgRole;
}

export interface CreateUserOutput {
  readonly userId: string;
  readonly email: string;
  readonly temporaryPassword: string;
}

interface CreateUserApiSurface {
  createUser(args: {
    body: { name: string; email: string; password: string; role: string };
  }): Promise<{ user: { id: string; email: string } }>;
  addMember(args: {
    body: { userId: string; role: 'member' | 'admin'; organizationId: string };
  }): Promise<unknown>;
}

/** Design Q37: `role` is an organization role; the global adminRoles are never assignable. */
const ASSIGNABLE_ORG_ROLES = ['member', 'admin'] as const;
type AssignableOrgRole = (typeof ASSIGNABLE_ORG_ROLES)[number];

/** The fixed global Better Auth role every created user gets (design Q37). */
const GLOBAL_USER_ROLE = 'user';

/** The expiry the invitation email states; matches `invitationExpiresIn` (48 hours). */
const INVITATION_EXPIRY_TEXT = '48 hours';

/** The host key carrying the request's session headers (Resolved decision Q42). */
const REQUEST_HEADERS = '__requestHeaders';

interface InviteApiSurface {
  createInvitation(args: {
    body: { email: string; role: 'member' | 'admin'; organizationId: string };
    headers: Headers;
  }): Promise<{ id: string; expiresAt: Date | string }>;
}

interface CancelInvitationApiSurface {
  cancelInvitation(args: { body: { invitationId: string }; headers: Headers }): Promise<unknown>;
}

interface VerificationAdapterSurface {
  readonly internalAdapter: {
    createVerificationValue(data: {
      identifier: string;
      value: string;
      expiresAt: Date;
    }): Promise<unknown>;
    updateVerificationByIdentifier(identifier: string, data: { value: string }): Promise<unknown>;
  };
}

export interface InviteUserInput {
  readonly email: string;
  readonly role: AssignableOrgRole;
}

/** Never carries the token or the link: only the email does. */
export interface InviteUserOutput {
  readonly invitationId: string;
}

type RawContext = Record<string, unknown>;

/** Canonicalizes an address and rejects one the platform cannot hold (Q33), before any side effect. */
function holdableEmail(raw: string): string {
  const canonical = canonicalEmail(raw);
  if (!isValidIdentityEmail(canonical)) throw new IdentityInputError();
  return canonical;
}

const EMAIL_FIELD = { kind: 'string', maxLength: 254 } as const;
const ROLE_FIELD = { kind: 'string', maxLength: 16 } as const;
/** A `{user}` path value: an email or a `svc-...` identifier. */
const USER_PARAM = { user: EMAIL_FIELD } as const;
const INVITATION_PARAM = { invitation: { kind: 'string', maxLength: 64 } } as const;
const CREDENTIAL_PARAM = { credential: { kind: 'string', maxLength: 64 } } as const;

/** The detailed input shape of each procedure (design D10 "Input contract"). */
const SCHEMAS = {
  createUser: {
    body: { email: EMAIL_FIELD, name: { kind: 'string', maxLength: 200 }, role: ROLE_FIELD },
  },
  invite: { body: { email: EMAIL_FIELD, role: ROLE_FIELD } },
  invitation: { params: INVITATION_PARAM },
  setStatus: { params: USER_PARAM, body: { status: { kind: 'string', maxLength: 16 } } },
  link: { params: USER_PARAM, body: { subject: { kind: 'string', maxLength: 256 } } },
  user: { params: USER_PARAM },
  createServiceAccount: {
    body: {
      identifier: { kind: 'string', maxLength: 64 },
      role: { ...ROLE_FIELD, optional: true },
      moderatedBlueprints: {
        kind: 'stringList',
        maxItems: 64,
        item: { maxLength: 128 },
        optional: true,
      },
    },
  },
  createCredential: {
    body: {
      name: { kind: 'string', maxLength: 32, pattern: CREDENTIAL_NAME_PATTERN },
      kind: { kind: 'string', maxLength: 16 },
      userId: { kind: 'string', maxLength: 64, optional: true },
    },
  },
  listCredentials: { query: {} },
  credential: { params: CREDENTIAL_PARAM },
} satisfies Record<string, InputSchema>;

/**
 * Parses the detailed input of a request. oRPC's `detailed` structure also carries the
 * request `headers`; no procedure reads them (the session travels in the host context),
 * so that one transport section is set aside and the rest goes through the strict parser.
 */
function parseDetailedInput(schema: InputSchema, raw: unknown): ParsedIdentityInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return parseIdentityInput(schema, raw);
  }
  const sections: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  delete sections['headers'];
  return parseIdentityInput(schema, sections);
}

/**
 * The `{invitation}` identifier as an invitation target. The input is parsed first, so a hostile or
 * oversized request is refused before the resolver looks anything up (task 14.10).
 */
function invitationTargetOf(raw: unknown): { kind: 'invitation'; id: string } {
  const { params } = parseDetailedInput(SCHEMAS.invitation, raw);
  return { kind: 'invitation', id: params['invitation'] as string };
}

/** The `{credential}` identifier as a credential target, parsed before any lookup (task 14.10). */
function credentialTargetOf(raw: unknown): { kind: 'credential'; id: string } {
  const { params } = parseDetailedInput(SCHEMAS.credential, raw);
  return { kind: 'credential', id: params['credential'] as string };
}

/** The `{user}` identifier as a user target, parsed with the procedure's schema before any lookup. */
function userTargetOf(schema: InputSchema): (raw: unknown) => { kind: 'user'; id: string } {
  return (raw) => {
    const { params } = parseDetailedInput(schema, raw);
    return { kind: 'user', id: params['user'] as string };
  };
}

/** The role of an invite or a create: exact match (design D4 "Roles"), no trimming or case folding. */
function assignableRole(role: unknown): AssignableOrgRole {
  if (!(ASSIGNABLE_ORG_ROLES as readonly string[]).includes(role as string)) {
    throw new IdentityInputError();
  }
  return role as AssignableOrgRole;
}

/** The Visma Connect provider id of the `account` row (design D23/D24). */
const SSO_PROVIDER_ID = 'visma-connect';

/** The slice of Better Auth's internal adapter the admin-recorded linking uses (design D24 path (b)). */
interface AccountAdapterSurface {
  readonly internalAdapter: {
    linkAccount(account: {
      userId: string;
      providerId: string;
      accountId: string;
    }): Promise<unknown>;
    deleteAccount(id: string): Promise<void>;
    listSessions(userId: string): Promise<readonly unknown[]>;
    deleteUserSessions(userId: string): Promise<unknown>;
    findUserById(userId: string): Promise<{ name: string } | null>;
    updateUser(userId: string, data: { banned: boolean }): Promise<unknown>;
  };
}

/** The tenant of the caller; the wrapper already proved it is a non-empty string. */
function rawTenantId(context: RawContext): string {
  return context['tenantId'] as string;
}

/** Audit signal for an admin-recorded link/unlink (design D24); the context was validated by `the wrapper`. */
function emitAdminLinkEvent(event: 'linked' | 'unlinked', context: RawContext): void {
  emitAccountLinkEvent(event, 'admin', {
    actorId: (context['actor'] as { id: string }).id,
    tenantId: rawTenantId(context),
  });
}

type OperationObject = Parameters<Extract<Route['spec'], (...args: never[]) => unknown>>[0];

/** Q50: `x-tayzu-risk: high`, so the D4 step-up guard applies to the procedure. */
function markHighRisk(current: OperationObject): OperationObject {
  const marked = { ...current, 'x-tayzu-risk': 'high' };
  return marked;
}

/** A route declaration of design D10; `inputStructure: 'detailed'` on every one. */
function identityRoute(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  options: { readonly highRisk?: true } = {},
): Route {
  return {
    method,
    path: path as `/${string}`,
    inputStructure: 'detailed',
    ...(options.highRisk === true ? { spec: markHighRisk } : {}),
  };
}

export function createIdentityRouter(options: CreateIdentityRouterOptions) {
  const userApi = options.auth.api as CreateUserApiSurface;
  const inviteApi = options.auth.api as InviteApiSurface;
  const cancelApi = options.auth.api as CancelInvitationApiSurface;
  const verificationContext = (): Promise<VerificationAdapterSurface> =>
    options.auth.$context as Promise<VerificationAdapterSurface>;
  const authContext = (): Promise<AccountAdapterSurface> =>
    options.auth.$context as Promise<AccountAdapterSurface>;

  const baseResolver = createIdentityTargetResolver({ authRepository: options.authRepository });
  /**
   * Maps the `{user}` identifier to the Better Auth user before the tenant check
   * (Resolved decision Q31). An identifier with no user is passed on as is, so
   * the resolver answers it exactly like any other unknown target.
   */
  const targetResolver: IdentityTargetResolver = {
    async resolve(context, rawTarget) {
      const identifier = (rawTarget as { id?: unknown }).id;
      if (typeof identifier === 'string') {
        const found = await options.authRepository.globalUserByEmail(identifier);
        if (found !== undefined)
          return baseResolver.resolve(context, { kind: 'user', id: found.id });
      }
      return baseResolver.resolve(context, rawTarget);
    },
  };

  const defineIdentityOperation = createDefineIdentityOperation({
    authz: options.authz,
    targetResolver,
  });

  /** Logs the internal cause of a refused create or link: opaque identifiers and a bounded reason only (Q115). */
  function emitConflictRefused(
    context: RawContext,
    reason: 'account_exists' | 'target_in_other_tenant' | 'sub_already_linked',
    userId?: string,
  ): void {
    emitIdentityEvent({
      name: 'catalog.security.identity_conflict_refused',
      severity: 'WARN',
      attributes: {
        'tayzu.tenant.id': rawTenantId(context),
        'tayzu.actor.id': (context['actor'] as { id: string }).id,
        'tayzu.identity.conflict.reason': reason,
        ...(userId === undefined ? {} : { 'tayzu.identity.user.id': userId }),
      },
    });
  }

  /** `002` VCDM M10: an account with a membership in a second tenant is never linked or unlinked from one tenant. */
  async function refuseMultiTenantTarget(userId: string, context?: RawContext): Promise<void> {
    if ((await options.authRepository.globalMembershipTenantsOf(userId)).length > 1) {
      if (context !== undefined) emitConflictRefused(context, 'target_in_other_tenant', userId);
      throw new IdentityLinkRejectedError();
    }
  }

  /**
   * Q88: an admin never records a `sub` on an admin or an owner of the tenant (identity laundering).
   * The cause is logged with opaque identifiers only (Q115); the caller sees the generic rejection.
   */
  async function refuseAdminOrOwnerTarget(context: RawContext, userId: string): Promise<void> {
    const tenantId = rawTenantId(context);
    const member = await options.authRepository.memberOf(tenantId, userId);
    if (member?.role !== 'admin' && member?.role !== 'owner') return;
    emitIdentityEvent({
      name: 'catalog.security.identity_conflict_refused',
      severity: 'WARN',
      attributes: {
        'tayzu.tenant.id': tenantId,
        'tayzu.actor.id': (context['actor'] as { id: string }).id,
        'tayzu.identity.conflict.reason': 'target_is_admin_or_owner',
        'tayzu.identity.user.id': userId,
      },
    });
    throw new IdentityLinkRejectedError();
  }

  return {
    identity: {
      credentials: {
        // Step-up applies (D4); the key's limits are plugin-level configuration (Q44).
        create: defineIdentityOperation({
          authorization: {
            kind: RESOURCE_KINDS.credential,
            action: 'create',
            resolveTarget: () => undefined,
          },
          route: identityRoute('POST', '/v1/credentials', { highRisk: true }),
          handler: async ({ context, input: rawInput }) => {
            const { body } = parseDetailedInput(SCHEMAS.createCredential, rawInput);
            const name = body['name'] as string;
            const kind = body['kind'];
            const userId = body['userId'] as string | undefined;
            if (kind !== 'integration' && kind !== 'agent') throw new IdentityInputError();
            const created = await createCredential({
              authRepository: options.authRepository,
              ...(options.appPool === undefined ? {} : { appPool: options.appPool }),
              ...(userId === undefined ? {} : { userId }),
              cap: options.credentialCap ?? DEFAULT_CREDENTIAL_CAP,
              auth: options.auth,
              tenantId: rawTenantId(context),
              adminId: (context['actor'] as { id: string }).id,
              name,
              kind,
            });
            emitIdentityEvent({
              name: 'catalog.audit.credential_created',
              severity: 'INFO',
              attributes: {
                'tayzu.tenant.id': rawTenantId(context),
                'tayzu.actor.id': (context['actor'] as { id: string }).id,
                'tayzu.identity.credential.id': created.id,
                'tayzu.identity.credential.kind': kind,
              },
            });
            return created;
          },
        }),
        // Step-up applies (D4); the old key is resolved inside the tenant by the target resolver.
        rotate: defineIdentityOperation({
          authorization: {
            kind: RESOURCE_KINDS.credential,
            action: 'rotate',
            resolveTarget: credentialTargetOf,
          },
          route: identityRoute('POST', '/v1/credentials/{credential}/rotate', { highRisk: true }),
          handler: ({ context, input: rawInput, target }) => {
            parseDetailedInput(SCHEMAS.credential, rawInput);
            // Fail closed when the host did not wire the revocation-list pool.
            if (options.appPool === undefined || target === undefined) {
              throw new IdentityInputError();
            }
            return rotateCredential({
              auth: options.auth,
              authRepository: options.authRepository,
              appPool: options.appPool,
              tenantId: rawTenantId(context),
              adminId: (context['actor'] as { id: string }).id,
              credentialId: target.id,
            });
          },
        }),
        // Step-up applies (D4); permanent, and a repeat is a no-op.
        revoke: defineIdentityOperation({
          authorization: {
            kind: RESOURCE_KINDS.credential,
            action: 'revoke',
            resolveTarget: credentialTargetOf,
          },
          route: identityRoute('POST', '/v1/credentials/{credential}/revoke', { highRisk: true }),
          handler: async ({ context, input: rawInput, target }) => {
            parseDetailedInput(SCHEMAS.credential, rawInput);
            // Fail closed when the host did not wire the revocation-list pool.
            if (options.appPool === undefined || target === undefined) {
              throw new IdentityInputError();
            }
            await revokeCredential({
              auth: options.auth,
              appPool: options.appPool,
              tenantId: rawTenantId(context),
              adminId: (context['actor'] as { id: string }).id,
              credentialId: target.id,
            });
          },
        }),
        list: defineIdentityOperation({
          authorization: {
            kind: RESOURCE_KINDS.credential,
            action: 'list',
            resolveTarget: () => undefined,
          },
          route: identityRoute('GET', '/v1/credentials'),
          handler: ({ context, input: rawInput }) => {
            parseDetailedInput(SCHEMAS.listCredentials, rawInput);
            // Fail closed when the host did not wire the revocation-list pool.
            if (options.appPool === undefined) throw new IdentityInputError();
            return listCredentials({
              authRepository: options.authRepository,
              appPool: options.appPool,
              tenantId: rawTenantId(context),
              cap: options.credentialCap ?? DEFAULT_CREDENTIAL_CAP,
            });
          },
        }),
      },
      serviceAccounts: {
        // Step-up applies (D4); the secret is returned once.
        create: defineIdentityOperation({
          authorization: {
            kind: RESOURCE_KINDS.serviceAccount,
            action: 'create',
            resolveTarget: () => undefined,
          },
          route: identityRoute('POST', '/v1/service-accounts', { highRisk: true }),
          handler: async ({ context, input: rawInput }) => {
            // Fail closed when the host did not wire the lookups and the writer.
            if (options.appPool === undefined || options.userSync === undefined) {
              throw new IdentityInputError();
            }
            const { body } = parseDetailedInput(SCHEMAS.createServiceAccount, rawInput);
            const identifier = body['identifier'] as string;
            // Ceiling (D6): only `member` and an empty `moderatedBlueprints` list, before anything is written.
            if (body['role'] !== undefined && body['role'] !== 'member') {
              throw new IdentityInputError();
            }
            const moderated = body['moderatedBlueprints'];
            if (Array.isArray(moderated) && moderated.length > 0) {
              throw new IdentityInputError();
            }
            return await createServiceAccount({
              auth: options.auth,
              authz: options.authz,
              appPool: options.appPool,
              authRepository: options.authRepository,
              userSync: options.userSync,
              tenantId: rawTenantId(context),
              adminId: (context['actor'] as { id: string }).id,
              identifier,
              ...(options.serviceAccountCap === undefined
                ? {}
                : { cap: options.serviceAccountCap }),
            });
          },
        }),
        // Step-up applies (D4); the target is resolved as a service account by the handler (10.7b).
        delete: defineIdentityOperation({
          authorization: {
            kind: RESOURCE_KINDS.serviceAccount,
            action: 'delete',
            resolveTarget: () => undefined,
          },
          route: identityRoute('DELETE', '/v1/service-accounts/{user}', { highRisk: true }),
          handler: async ({ context, input: rawInput }): Promise<void> => {
            // Fail closed when the host did not wire the lookups.
            if (options.appPool === undefined) throw new IdentityInputError();
            const user = parseDetailedInput(SCHEMAS.user, rawInput).params['user'] as string;
            await deleteServiceAccount({
              auth: options.auth,
              authz: options.authz,
              appPool: options.appPool,
              authRepository: options.authRepository,
              tenantId: rawTenantId(context),
              adminId: (context['actor'] as { id: string }).id,
              identifier: user,
            });
          },
        }),
      },
      users: {
        // Authorization runs before input parsing: a denied caller learns nothing about validity.
        create: defineIdentityOperation({
          authorization: {
            kind: RESOURCE_KINDS.user,
            action: 'create',
            resolveTarget: () => undefined,
          },
          route: identityRoute('POST', '/v1/users', { highRisk: true }),
          handler: async ({ context, input: rawInput }): Promise<CreateUserOutput> => {
            const { body } = parseDetailedInput(SCHEMAS.createUser, rawInput);
            const input: CreateUserInput = {
              email: holdableEmail(body['email'] as string),
              name: body['name'] as string,
              role: assignableRole(body['role']),
            };
            const temporaryPassword = generateTemporaryPassword();
            // Admin `createUser` enforces only the maximum length: the policy minimum is applied here (Q22).
            if (!validatePassword(temporaryPassword).ok) throw new IdentityInputError();
            const adminId = (context['actor'] as { id: string }).id;
            // One generic answer to every existing-account cause; the cause is only logged (Q115).
            const existingUser = await options.authRepository.globalUserByEmail(input.email);
            if (existingUser !== undefined) {
              const tenants = await options.authRepository.globalMembershipTenantsOf(
                existingUser.id,
              );
              emitConflictRefused(
                context,
                tenants.some((tenant) => tenant !== rawTenantId(context))
                  ? 'target_in_other_tenant'
                  : 'account_exists',
                existingUser.id,
              );
              throw new IdentityCreateRejectedError();
            }
            // The membership hook is the single `_user` writer; it reads the admin from the store (Q76, Q117).
            const { user } = await runWithIdentityContext({ adminId }, async () => {
              const created = await userApi.createUser({
                body: {
                  name: input.name,
                  email: input.email,
                  password: temporaryPassword,
                  role: GLOBAL_USER_ROLE,
                },
              });
              // `addMember` answers FORBIDDEN past the membership limit.
              await withGenericRefusal(
                () =>
                  userApi.addMember({
                    body: {
                      userId: created.user.id,
                      role: input.role,
                      organizationId: rawTenantId(context),
                    },
                  }),
                ({ status }) => status === 'FORBIDDEN',
              );
              return created;
            });
            // Design D4 (Q110): the user now exists, so a pending invitation of this tenant to the address is moot.
            const tenantId = rawTenantId(context);
            const pending = await options.authRepository.pendingInvitationsByEmail(
              tenantId,
              input.email,
            );
            for (const invitation of pending) {
              const headers = context[REQUEST_HEADERS];
              if (!(headers instanceof Headers)) throw new IdentityInputError();
              const attributes = {
                'tayzu.identity.invitation.id': invitation.id,
                'tayzu.identity.invitation.reason': 'user_created',
              };
              await withIdentitySpan('identity.invitation.cancel', attributes, () =>
                cancelApi.cancelInvitation({ body: { invitationId: invitation.id }, headers }),
              );
              emitIdentityEvent({
                name: 'catalog.audit.invitation_cancelled',
                severity: 'INFO',
                attributes: {
                  'tayzu.tenant.id': tenantId,
                  'tayzu.actor.id': adminId,
                  ...attributes,
                },
              });
            }
            emitIdentityEvent({
              name: 'catalog.audit.user_created',
              severity: 'INFO',
              attributes: {
                'tayzu.tenant.id': tenantId,
                'tayzu.actor.id': adminId,
                'tayzu.identity.user.id': user.id,
                'tayzu.identity.user.role': input.role,
                'tayzu.identity.user.source': 'admin',
              },
            });
            return { userId: user.id, email: user.email, temporaryPassword };
          },
        }),
        // Design D4 (Q42, Q76): the admin's session headers go to Better Auth; its hook writes the `_user`.
        invite: defineIdentityOperation({
          authorization: {
            kind: RESOURCE_KINDS.user,
            action: 'invite',
            resolveTarget: () => undefined,
          },
          route: identityRoute('POST', '/v1/users/invitations', { highRisk: true }),
          handler: async ({ context, input: rawInput }): Promise<InviteUserOutput> => {
            const { body } = parseDetailedInput(SCHEMAS.invite, rawInput);
            const input: InviteUserInput = {
              email: holdableEmail(body['email'] as string),
              role: assignableRole(body['role']),
            };
            const { emailGate, invitationLinkBaseUrl } = options;
            // Fail closed when the host did not wire the email path: nothing is created.
            if (emailGate === undefined || invitationLinkBaseUrl === undefined) {
              throw new IdentityInputError();
            }
            const headers = context[REQUEST_HEADERS];
            if (!(headers instanceof Headers)) throw new IdentityInputError();
            const tenantId = rawTenantId(context);
            const adminId = (context['actor'] as { id: string }).id;
            const invitation = await runWithIdentityContext({ adminId }, () =>
              withGenericRefusal(
                () =>
                  inviteApi.createInvitation({
                    body: { email: input.email, role: input.role, organizationId: tenantId },
                    headers,
                  }),
                ({ code }) => INVITATION_REFUSAL_CODES.includes(code),
              ),
            );
            const token = generateInvitationToken();
            await (
              await verificationContext()
            ).internalAdapter.createVerificationValue({
              identifier: `invitation-accept:${invitation.id}`,
              value: digestInvitationToken(token),
              expiresAt: new Date(invitation.expiresAt),
            });
            await emailGate.send({
              tenantId,
              to: input.email,
              template: {
                kind: 'InvitationEmail',
                link: buildInvitationLink({
                  baseUrl: invitationLinkBaseUrl,
                  invitationId: invitation.id,
                  token,
                }),
                expiryText: INVITATION_EXPIRY_TEXT,
              },
            });
            emitIdentityEvent({
              name: 'catalog.audit.invitation_created',
              severity: 'INFO',
              attributes: {
                'tayzu.tenant.id': tenantId,
                'tayzu.actor.type': (context['actor'] as { type: string }).type,
                'tayzu.actor.id': adminId,
                'tayzu.identity.invitation.id': invitation.id,
                'tayzu.identity.invitation.role': input.role,
              },
            });
            return { invitationId: invitation.id };
          },
        }),
        // Design D4 (Q47): resolved on the server, cancelled with the admin's forwarded session headers.
        cancelInvitation: defineIdentityOperation({
          authorization: {
            kind: RESOURCE_KINDS.user,
            action: 'invite',
            resolveTarget: invitationTargetOf,
          },
          route: identityRoute('POST', '/v1/users/invitations/{invitation}/cancel'),
          handler: async ({ context, input: rawInput, target }): Promise<void> => {
            parseDetailedInput(SCHEMAS.invitation, rawInput);
            const headers = context[REQUEST_HEADERS];
            if (!(headers instanceof Headers)) throw new IdentityInputError();
            // Better Auth's cancel ignores the status, so only a `pending` invitation is cancelled (Q123, Q129).
            const invitation = await options.authRepository.invitationById(
              rawTenantId(context),
              (target as ResolvedIdentityTarget).id,
            );
            if (invitation?.status !== 'pending') throw new IdentityInputError();
            await cancelApi.cancelInvitation({
              body: { invitationId: (target as ResolvedIdentityTarget).id },
              headers,
            });
          },
        }),
        // Design D4 "Resend": a new token on the same verification row, so the expiry and the invitation stay as they are.
        resendInvitation: defineIdentityOperation({
          authorization: {
            kind: RESOURCE_KINDS.user,
            action: 'invite',
            resolveTarget: invitationTargetOf,
          },
          route: identityRoute('POST', '/v1/users/invitations/{invitation}/resend'),
          handler: async ({ context, input: rawInput, target }): Promise<InviteUserOutput> => {
            parseDetailedInput(SCHEMAS.invitation, rawInput);
            const { emailGate, invitationLinkBaseUrl } = options;
            if (emailGate === undefined || invitationLinkBaseUrl === undefined) {
              throw new IdentityInputError();
            }
            const tenantId = rawTenantId(context);
            const invitation = await options.authRepository.invitationById(
              tenantId,
              (target as ResolvedIdentityTarget).id,
            );
            // Only a `pending` invitation is resent (Q123).
            if (invitation?.status !== 'pending') throw new IdentityInputError();
            const token = generateInvitationToken();
            await (
              await verificationContext()
            ).internalAdapter.updateVerificationByIdentifier(`invitation-accept:${invitation.id}`, {
              value: digestInvitationToken(token),
            });
            await emailGate.send({
              tenantId,
              to: invitation.email,
              template: {
                kind: 'InvitationEmail',
                link: buildInvitationLink({
                  baseUrl: invitationLinkBaseUrl,
                  invitationId: invitation.id,
                  token,
                }),
                expiryText: INVITATION_EXPIRY_TEXT,
              },
            });
            return { invitationId: invitation.id };
          },
        }),
        // Design D24 path (b): a `sub`-keyed `account` row for a target user, never keyed on email.
        linkSsoAccount: defineIdentityOperation({
          authorization: {
            kind: RESOURCE_KINDS.user,
            action: 'update',
            resolveTarget: userTargetOf(SCHEMAS.link),
          },
          route: identityRoute('POST', '/v1/users/{user}/sso-account', { highRisk: true }),
          handler: async ({ context, input: rawInput, target }): Promise<void> => {
            const { body } = parseDetailedInput(SCHEMAS.link, rawInput);
            const input = { subject: body['subject'] as string };
            const adapter = (await authContext()).internalAdapter;
            const userId = (target as ResolvedIdentityTarget).id;
            await options.withUserLock(userId, async () => {
              // The checks run inside the lock (task 8.5i).
              await refuseMultiTenantTarget(userId, context);
              await refuseAdminOrOwnerTarget(context, userId);
              const existing = await options.authRepository.globalAccountByKey(
                SSO_PROVIDER_ID,
                input.subject,
              );
              if (existing !== undefined) {
                emitConflictRefused(context, 'sub_already_linked', userId);
                throw new IdentityLinkRejectedError();
              }
              try {
                await adapter.linkAccount({
                  userId,
                  providerId: SSO_PROVIDER_ID,
                  accountId: input.subject,
                });
              } catch (error) {
                // A concurrent link of the same `sub` (Q29): same generic rejection.
                if (isAccountUniqueViolation(error)) throw new IdentityLinkRejectedError();
                throw error;
              }
            });
            emitAdminLinkEvent('linked', context);
          },
        }),
        // Tenant-scoped (Q25): the tenant's sessions go always; the global ban only for a single membership.
        setStatus: defineIdentityOperation({
          authorization: {
            kind: RESOURCE_KINDS.user,
            action: 'updateStatus',
            // A service account has no Better Auth user to resolve: an identifier of its shape
            // skips the user lookup, and the handler resolves its `accountKind` (Q62, task 11.5).
            resolveTarget: (raw) => {
              const target = userTargetOf(SCHEMAS.setStatus)(raw);
              return typeof target.id === 'string' && isValidServiceAccountIdentifier(target.id)
                ? undefined
                : target;
            },
          },
          route: identityRoute('PUT', '/v1/users/{user}/status', { highRisk: true }),
          handler: async ({ context, input: rawInput, target }): Promise<void> => {
            // Fail closed when the host did not wire the writer.
            const { userSync } = options;
            if (userSync === undefined) throw new IdentityInputError();
            const parsed = parseDetailedInput(SCHEMAS.setStatus, rawInput);
            const status = parsed.body['status'];
            if (status !== 'Active' && status !== 'Disabled') throw new IdentityInputError();
            const tenantId = rawTenantId(context);
            const adminId = (context['actor'] as { id: string }).id;
            const change = status === 'Disabled' ? 'admin_disable' : 'admin_enable';
            if (target === undefined) {
              // Service-account branch: only `_user.status` is written (no Better Auth user).
              const identifier = parsed.params['user'] as string;
              if (
                options.appPool === undefined ||
                !(await serviceAccountExists(options.appPool, tenantId, identifier))
              ) {
                throw new CredentialTargetNotFoundError();
              }
              nextStatus(await userSync.readStatus({ tenantId, email: identifier }), change);
              await runWithIdentityContext({ adminId }, () =>
                userSync.writeUserChange({
                  tenantId,
                  email: identifier,
                  name: identifier,
                  change,
                  userId: identifier,
                  accountKind: 'service',
                  principal: { kind: 'admin', id: adminId },
                  onBehalfOf: { type: 'user', id: adminId },
                }),
              );
              return;
            }
            const userId = target.id;
            const adapter = (await authContext()).internalAdapter;
            const user = await options.authRepository.userInTenant(tenantId, userId);
            const authUser = await adapter.findUserById(userId);
            if (user === undefined || authUser === null) throw new IdentityInputError();
            const current = await userSync.readStatus({ tenantId, email: user.email });
            nextStatus(current, change);
            await runWithIdentityContext({ adminId }, () =>
              userSync.writeUserChange({
                tenantId,
                email: user.email,
                name: authUser.name,
                change,
                userId,
                principal: { kind: 'admin', id: adminId },
                onBehalfOf: { type: 'user', id: adminId },
              }),
            );
            const single =
              (await options.authRepository.globalMembershipTenantsOf(userId)).length === 1;
            if (status === 'Active') {
              if (single) await adapter.updateUser(userId, { banned: false });
              return;
            }
            // Design D13 (Q63, Q123): the pending invitations to the user and those the user created
            // in this tenant are cancelled; any other status is skipped.
            const toCancel = [
              {
                reason: 'user_disabled',
                invitations: await options.authRepository.pendingInvitationsByEmail(
                  tenantId,
                  user.email,
                ),
              },
              {
                reason: 'inviter_disabled',
                invitations: await options.authRepository.pendingInvitationsByInviter(
                  tenantId,
                  userId,
                ),
              },
            ];
            for (const { reason, invitations } of toCancel) {
              for (const invitation of invitations) {
                const attributes = {
                  'tayzu.identity.invitation.id': invitation.id,
                  'tayzu.identity.invitation.reason': reason,
                };
                const cancelled = await withIdentitySpan(
                  'identity.invitation.cancel',
                  attributes,
                  () => options.authRepository.markInvitationCancelled(tenantId, invitation.id),
                );
                if (!cancelled) continue;
                emitIdentityEvent({
                  name: 'catalog.audit.invitation_cancelled',
                  severity: 'INFO',
                  attributes: {
                    'tayzu.tenant.id': tenantId,
                    'tayzu.actor.id': adminId,
                    ...attributes,
                  },
                });
              }
            }
            const revoked = await options.authRepository.deleteSessionsOf(tenantId, userId);
            for (let index = 0; index < revoked; index += 1) {
              emitSessionRevoked({ actorId: userId, tenantId, reason: 'admin_action' });
            }
            if (single) {
              await adapter.updateUser(userId, { banned: true });
              await adapter.deleteUserSessions(userId);
            }
          },
        }),
        unlinkSsoAccount: defineIdentityOperation({
          authorization: {
            kind: RESOURCE_KINDS.user,
            action: 'update',
            resolveTarget: userTargetOf(SCHEMAS.user),
          },
          route: identityRoute('DELETE', '/v1/users/{user}/sso-account', { highRisk: true }),
          handler: async ({ context, input: rawInput, target }): Promise<void> => {
            parseDetailedInput(SCHEMAS.user, rawInput);
            const userId = (target as ResolvedIdentityTarget).id;
            const adapter = (await authContext()).internalAdapter;
            await refuseMultiTenantTarget(userId);
            const accounts = await options.authRepository.globalAccountsOf(userId);
            const sso = accounts.filter((a) => a.providerId === SSO_PROVIDER_ID);
            // Design D24: never leave the user with no password and no linked SSO account.
            if (sso.length > 0 && wouldLeaveNoSignInMethod(accounts, sso)) {
              throw new IdentityLinkRejectedError();
            }
            for (const account of sso) await adapter.deleteAccount(account.id);
            if (sso.length === 0) return;
            // Q86: a session issued through the link must not outlive it.
            const sessions = await adapter.listSessions(userId);
            await adapter.deleteUserSessions(userId);
            for (let index = 0; index < sessions.length; index += 1) {
              emitSessionRevoked({
                actorId: userId,
                tenantId: rawTenantId(context),
                reason: 'sso_link_shed',
              });
            }
            emitAdminLinkEvent('unlinked', context);
          },
        }),
      },
    },
  };
}
