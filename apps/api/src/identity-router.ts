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
import type { AuthInstance } from '@tayzu/auth';
import { buildAttributes, RESOURCE_KINDS, type CerbosClient } from '@tayzu/authz';

/** Same code and message as the catalog's `AuthorizationError` (design D11). */
class IdentityForbiddenError extends Error {
  readonly code = 'AUTH_FORBIDDEN' as const;

  constructor() {
    super('Action is not permitted');
    this.name = 'IdentityForbiddenError';
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

/** Cerbos `user` / `create` for the host-supplied principal; anything but an explicit allow is a deny. */
async function assertMayCreateUser(authz: CerbosClient, rawContext: RawContext): Promise<void> {
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
            id: 'new',
            attr: buildAttributes(tenantId, {}),
          },
          actions: ['create'],
        },
      ],
    });
    allowed = checked.results[0]?.isAllowed('create') === true;
  } catch {
    allowed = false;
  }
  if (!allowed) throw new IdentityForbiddenError();
}

/** A single-use, system-generated temporary password (design D22's "shown once" discipline). */
function generateTemporaryPassword(): string {
  return randomBytes(24).toString('base64url');
}

export function createIdentityRouter(options: CreateIdentityRouterOptions) {
  const base = os.$context<RawContext>();
  const userApi = options.auth.api as CreateUserApiSurface;

  return {
    identity: {
      users: {
        // Authorization runs before input parsing: a denied caller learns nothing about validity.
        create: base.handler(async ({ context, input: rawInput }): Promise<CreateUserOutput> => {
          await assertMayCreateUser(options.authz, context);
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
          return { userId: user.id, email: user.email, temporaryPassword };
        }),
      },
    },
  };
}
