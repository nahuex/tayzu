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
import { randomBytes } from 'node:crypto';

import type { Route } from '@orpc/server';
import {
  digestInvitationToken,
  emitAccountLinkEvent,
  emitIdentityEvent,
  generateInvitationToken,
  wouldLeaveNoSignInMethod,
  type AuthInstance,
} from '@tayzu/auth';
import { RESOURCE_KINDS, type CerbosClient } from '@tayzu/authz';

import type { AuthRepository } from './identity/auth-repository.js';
import type { EmailTenantGate } from './identity/email-tenant-gate.js';
import { canonicalEmail, isValidIdentityEmail } from './identity/email-canonical.js';
import { buildInvitationLink } from './identity/invitation-link.js';
import { createDefineIdentityOperation } from './identity/define-operation.js';
import {
  createIdentityTargetResolver,
  type IdentityTargetResolver,
  type ResolvedIdentityTarget,
} from './identity/identity-target.js';
import { runWithIdentityContext } from './identity/identity-context.js';

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
  /** The one gate that sends invitation emails (task 6.5c). */
  readonly emailGate?: EmailTenantGate;
  /** The trusted `INVITATION_LINK_BASE_URL`; the link's origin comes only from it. */
  readonly invitationLinkBaseUrl?: string;
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** Canonicalizes an address and rejects one the platform cannot hold (Q33), before any side effect. */
function holdableEmail(raw: string): string {
  const canonical = canonicalEmail(raw);
  if (!isValidIdentityEmail(canonical)) throw new IdentityInputError();
  return canonical;
}

function parseInput(raw: unknown): CreateUserInput {
  if (typeof raw !== 'object' || raw === null) throw new IdentityInputError();
  const { email, name, role } = raw as Record<string, unknown>;
  if (!isNonEmptyString(email) || !isNonEmptyString(name) || !isNonEmptyString(role)) {
    throw new IdentityInputError();
  }
  if (!(ASSIGNABLE_ORG_ROLES as readonly string[]).includes(role)) throw new IdentityInputError();
  return { email: holdableEmail(email), name, role: role as AssignableOrgRole };
}

function parseInviteInput(raw: unknown): InviteUserInput {
  if (typeof raw !== 'object' || raw === null) throw new IdentityInputError();
  const { email, role } = raw as Record<string, unknown>;
  if (!isNonEmptyString(email) || !isNonEmptyString(role)) throw new IdentityInputError();
  // Exact match (design D4 "Roles"): no splitting, trimming or case folding.
  if (!(ASSIGNABLE_ORG_ROLES as readonly string[]).includes(role)) throw new IdentityInputError();
  return { email: holdableEmail(email), role: role as AssignableOrgRole };
}

/** The `{invitation}` identifier of a cancel as an invitation target; malformed input yields an id the resolver rejects. */
function invitationTargetOf(raw: unknown): { kind: 'invitation'; id: string } {
  const invitation =
    typeof raw === 'object' && raw !== null
      ? (raw as Record<string, unknown>)['invitation']
      : undefined;
  return { kind: 'invitation', id: invitation as string };
}

/** The Visma Connect provider id of the `account` row (design D23/D24). */
const SSO_PROVIDER_ID = 'visma-connect';

export interface SsoLinkInput {
  /** The `_user` identifier of the target (Resolved decision Q31), not a Better Auth id. */
  readonly user: string;
  readonly subject: string;
}

function parseLinkInput(raw: unknown): SsoLinkInput {
  if (typeof raw !== 'object' || raw === null) throw new IdentityInputError();
  const { user, subject } = raw as Record<string, unknown>;
  if (!isNonEmptyString(user) || !isNonEmptyString(subject)) throw new IdentityInputError();
  return { user, subject };
}

/** The slice of Better Auth's internal adapter the admin-recorded linking uses (design D24 path (b)). */
interface AccountAdapterSurface {
  readonly internalAdapter: {
    linkAccount(account: {
      userId: string;
      providerId: string;
      accountId: string;
    }): Promise<unknown>;
    deleteAccount(id: string): Promise<void>;
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

/** A single-use, system-generated temporary password (design D22's "shown once" discipline). */
function generateTemporaryPassword(): string {
  return randomBytes(24).toString('base64url');
}

type OperationObject = Parameters<Extract<Route['spec'], (...args: never[]) => unknown>>[0];

/** Q50: `x-tayzu-risk: high`, so the D4 step-up guard applies to the procedure. */
const HIGH_RISK_ROUTE = {
  spec: (current: OperationObject): OperationObject => {
    const marked = { ...current, 'x-tayzu-risk': 'high' };
    return marked;
  },
};

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

  /** The `user` identifier of a link/unlink body as a user target; malformed input yields an id the resolver rejects. */
  function userTargetOf(raw: unknown): { kind: 'user'; id: string } {
    const user =
      typeof raw === 'object' && raw !== null
        ? (raw as Record<string, unknown>)['user']
        : undefined;
    return { kind: 'user', id: user as string };
  }

  return {
    identity: {
      users: {
        // Authorization runs before input parsing: a denied caller learns nothing about validity.
        create: defineIdentityOperation({
          authorization: {
            kind: RESOURCE_KINDS.user,
            action: 'create',
            resolveTarget: () => undefined,
          },
          handler: async ({ context, input: rawInput }): Promise<CreateUserOutput> => {
            const input = parseInput(rawInput);
            const temporaryPassword = generateTemporaryPassword();
            const adminId = (context['actor'] as { id: string }).id;
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
          handler: async ({ context, input: rawInput }): Promise<InviteUserOutput> => {
            const input = parseInviteInput(rawInput);
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
          handler: async ({ context, target }): Promise<void> => {
            const headers = context[REQUEST_HEADERS];
            if (!(headers instanceof Headers)) throw new IdentityInputError();
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
          handler: async ({ context, target }): Promise<InviteUserOutput> => {
            const { emailGate, invitationLinkBaseUrl } = options;
            if (emailGate === undefined || invitationLinkBaseUrl === undefined) {
              throw new IdentityInputError();
            }
            const tenantId = rawTenantId(context);
            const invitation = await options.authRepository.invitationById(
              tenantId,
              (target as ResolvedIdentityTarget).id,
            );
            if (invitation === undefined) throw new IdentityInputError();
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
            resolveTarget: userTargetOf,
          },
          route: HIGH_RISK_ROUTE,
          handler: async ({ context, input: rawInput, target }): Promise<void> => {
            const input = parseLinkInput(rawInput);
            const adapter = (await authContext()).internalAdapter;
            const existing = await options.authRepository.globalAccountByKey(
              SSO_PROVIDER_ID,
              input.subject,
            );
            if (existing !== undefined) throw new IdentityLinkRejectedError();
            try {
              await adapter.linkAccount({
                userId: (target as ResolvedIdentityTarget).id,
                providerId: SSO_PROVIDER_ID,
                accountId: input.subject,
              });
            } catch (error) {
              // A concurrent link of the same `sub` (Q29): same generic rejection.
              if (isAccountUniqueViolation(error)) throw new IdentityLinkRejectedError();
              throw error;
            }
            emitAdminLinkEvent('linked', context);
          },
        }),
        unlinkSsoAccount: defineIdentityOperation({
          authorization: {
            kind: RESOURCE_KINDS.user,
            action: 'update',
            resolveTarget: userTargetOf,
          },
          route: HIGH_RISK_ROUTE,
          handler: async ({ context, target }): Promise<void> => {
            const userId = (target as ResolvedIdentityTarget).id;
            const adapter = (await authContext()).internalAdapter;
            const accounts = await options.authRepository.globalAccountsOf(userId);
            const sso = accounts.filter((a) => a.providerId === SSO_PROVIDER_ID);
            // Design D24: never leave the user with no password and no linked SSO account.
            if (sso.length > 0 && wouldLeaveNoSignInMethod(accounts, sso)) {
              throw new IdentityLinkRejectedError();
            }
            for (const account of sso) await adapter.deleteAccount(account.id);
            if (sso.length > 0) emitAdminLinkEvent('unlinked', context);
          },
        }),
      },
    },
  };
}
