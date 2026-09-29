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

import { os } from '@orpc/server';
import type { AuthInstance, UserSyncPort } from '@tayzu/auth';
import { buildAttributes, RESOURCE_KINDS, type CerbosClient } from '@tayzu/authz';

/** Same code and message as the catalog's `AuthorizationError` (design D11). */
class IdentityForbiddenError extends Error {
  readonly code = 'AUTH_FORBIDDEN' as const;

  constructor() {
    super('Action is not permitted');
    this.name = 'IdentityForbiddenError';
  }
}

/** Same code as the catalog's not-found; a cross-tenant and a nonexistent target are indistinguishable. */
class IdentityNotFoundError extends Error {
  readonly code = 'CATALOG_NOT_FOUND' as const;

  constructor() {
    super('The requested resource was not found');
    this.name = 'IdentityNotFoundError';
  }
}

/** Generic on purpose: never says which user, if any, already holds the subject. */
class IdentityLinkRejectedError extends Error {
  readonly code = 'CATALOG_VALIDATION_FAILED' as const;

  constructor() {
    super('The account link was rejected');
    this.name = 'IdentityLinkRejectedError';
  }
}

class IdentityInputError extends Error {
  readonly code = 'CATALOG_VALIDATION_FAILED' as const;

  constructor() {
    super('The request input is invalid');
    this.name = 'IdentityInputError';
  }
}

export interface CreateIdentityRouterOptions {
  readonly auth: AuthInstance;
  readonly authz: CerbosClient;
  /**
   * Task 18.5 (design D22): upserts the created user's `_user` entity through
   * the `system` actor path, directly and not through a Better Auth hook.
   */
  readonly userSync?: UserSyncPort;
}

export interface CreateUserInput {
  readonly email: string;
  readonly name: string;
  readonly role: string;
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
}

type RawContext = Record<string, unknown>;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function parseInput(raw: unknown): CreateUserInput {
  if (typeof raw !== 'object' || raw === null) throw new IdentityInputError();
  const { email, name, role } = raw as Record<string, unknown>;
  if (!isNonEmptyString(email) || !isNonEmptyString(name) || !isNonEmptyString(role)) {
    throw new IdentityInputError();
  }
  return { email, name, role };
}

/** Cerbos `user` / `<action>` for the host-supplied principal; anything but an explicit allow is a deny. */
async function assertMayOnUser(
  authz: CerbosClient,
  rawContext: RawContext,
  action: 'create' | 'update',
  resourceId: string,
  resourceTenantId?: string,
): Promise<void> {
  const { tenantId, actor, principal } = rawContext as {
    tenantId?: unknown;
    actor?: { id?: unknown } | null;
    principal?: { roles?: unknown } | null;
  };
  const roles = principal?.roles;
  if (
    !isNonEmptyString(tenantId) ||
    !isNonEmptyString(actor?.id) ||
    !Array.isArray(roles) ||
    roles.length === 0 ||
    !roles.every(isNonEmptyString)
  ) {
    throw new IdentityForbiddenError();
  }
  let allowed: boolean;
  try {
    const checked = await authz.checkResources({
      principal: { id: actor.id, roles: [...roles], attr: buildAttributes(tenantId, {}) },
      resources: [
        {
          resource: {
            kind: RESOURCE_KINDS.user,
            id: resourceId,
            attr: buildAttributes(resourceTenantId ?? tenantId, {}),
          },
          actions: [action],
        },
      ],
    });
    allowed = checked.results[0]?.isAllowed(action) === true;
  } catch {
    allowed = false;
  }
  if (!allowed) throw new IdentityForbiddenError();
}

function parseLinkInputUserId(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null) throw new IdentityInputError();
  const { userId } = raw as Record<string, unknown>;
  if (!isNonEmptyString(userId)) throw new IdentityInputError();
  return userId;
}

/** The Visma Connect provider id of the `account` row (design D23/D24). */
const SSO_PROVIDER_ID = 'visma-connect';

export interface SsoLinkInput {
  readonly userId: string;
  readonly subject: string;
}

function parseLinkInput(raw: unknown): SsoLinkInput {
  if (typeof raw !== 'object' || raw === null) throw new IdentityInputError();
  const { userId, subject } = raw as Record<string, unknown>;
  if (!isNonEmptyString(userId) || !isNonEmptyString(subject)) throw new IdentityInputError();
  return { userId, subject };
}

/** The slice of Better Auth's internal adapter the admin-recorded linking uses (design D24 path (b)). */
interface AccountAdapterSurface {
  readonly internalAdapter: {
    linkAccount(account: {
      userId: string;
      providerId: string;
      accountId: string;
    }): Promise<unknown>;
    findAccounts(userId: string): Promise<{ id: string; providerId: string }[]>;
    findAccountByKey(key: { providerId: string; accountId: string }): Promise<unknown>;
    deleteAccount(id: string): Promise<void>;
  };
  readonly adapter: {
    findMany<T>(args: { model: string; where: { field: string; value: string }[] }): Promise<T[]>;
  };
}

/** The tenant of the caller; `assertMayCreateUser` already proved it is a non-empty string. */
function rawTenantId(context: RawContext): string {
  return context['tenantId'] as string;
}

/** A single-use, system-generated temporary password (design D22's "shown once" discipline). */
function generateTemporaryPassword(): string {
  return randomBytes(24).toString('base64url');
}

export function createIdentityRouter(options: CreateIdentityRouterOptions) {
  const base = os.$context<RawContext>();
  const userApi = options.auth.api as CreateUserApiSurface;
  const authContext = (): Promise<AccountAdapterSurface> =>
    options.auth.$context as Promise<AccountAdapterSurface>;

  /**
   * Design D24 / spec "cross-tenant looks like not found": the Cerbos resource
   * carries the target's real tenant, resolved server-side from its
   * memberships, never taken from input. The caller-tenant check runs first, so
   * an unauthorized caller gets the same deny for any target; then, when the
   * target is not a member of the caller's tenant, the check against the
   * target's tenant denies and is reported as not-found (as is a nonexistent
   * target).
   */
  async function authorizeTarget(context: RawContext, targetUserId: string): Promise<void> {
    await assertMayOnUser(options.authz, context, 'update', targetUserId);
    const callerTenant = rawTenantId(context);
    const memberships = await (
      await authContext()
    ).adapter.findMany<{ organizationId: string }>({
      model: 'member',
      where: [{ field: 'userId', value: targetUserId }],
    });
    const tenants = memberships.map((m) => m.organizationId);
    if (tenants.includes(callerTenant)) return;
    const [targetTenant] = tenants;
    if (targetTenant === undefined) throw new IdentityNotFoundError();
    try {
      await assertMayOnUser(options.authz, context, 'update', targetUserId, targetTenant);
    } catch {
      // Denied by the cross-tenant rule (or Cerbos failed): fail closed as not-found.
    }
    throw new IdentityNotFoundError();
  }

  return {
    identity: {
      users: {
        // Authorization runs before input parsing: a denied caller learns nothing about validity.
        create: base.handler(async ({ context, input: rawInput }): Promise<CreateUserOutput> => {
          await assertMayOnUser(options.authz, context, 'create', 'new');
          const input = parseInput(rawInput);
          const temporaryPassword = generateTemporaryPassword();
          const { user } = await userApi.createUser({
            body: {
              name: input.name,
              email: input.email,
              password: temporaryPassword,
              role: input.role,
            },
          });
          await options.userSync?.upsertUser({
            tenantId: rawTenantId(context),
            email: user.email,
            name: input.name,
            portRole: input.role === 'admin' ? 'admin' : 'member',
            status: 'Active',
          });
          return { userId: user.id, email: user.email, temporaryPassword };
        }),
        // Design D24 path (b): a `sub`-keyed `account` row for a target user, never keyed on email.
        linkSsoAccount: base.handler(async ({ context, input: rawInput }): Promise<void> => {
          const input = parseLinkInput(rawInput);
          await authorizeTarget(context, input.userId);
          const adapter = (await authContext()).internalAdapter;
          const key = { providerId: SSO_PROVIDER_ID, accountId: input.subject };
          // NOTE: check-then-insert; atomic only once `auth.account` has a unique
          // (provider_id, account_id) constraint (needs a migration, Checkpoint 3).
          if ((await adapter.findAccountByKey(key)) != null) throw new IdentityLinkRejectedError();
          await adapter.linkAccount({
            userId: input.userId,
            providerId: SSO_PROVIDER_ID,
            accountId: input.subject,
          });
        }),
        unlinkSsoAccount: base.handler(async ({ context, input: rawInput }): Promise<void> => {
          const userId = parseLinkInputUserId(rawInput);
          await authorizeTarget(context, userId);
          const adapter = (await authContext()).internalAdapter;
          for (const account of await adapter.findAccounts(userId)) {
            if (account.providerId === SSO_PROVIDER_ID) await adapter.deleteAccount(account.id);
          }
        }),
      },
    },
  };
}
