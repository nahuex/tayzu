/**
 * Task 18.4 (design D22, resolved decision Q16; `specs/auth-and-rbac/spec.md`,
 * "Public self sign-up is not available"): a non-HTTP-reachable, idempotent
 * bootstrap for a brand-new tenant's first organization and its first admin
 * user, run out-of-band by an operator (`tsx scripts/bootstrap-admin.ts`),
 * never mounted on any route.
 *
 * Calls the same in-process path task 18.3's `identity.users.create` calls,
 * `auth.api.createUser` (Better Auth's `admin` plugin, `POST
 * /admin/create-user`, task 2.1) -- never Better Auth's own `/sign-up/email`,
 * which `disableSignUp: true` (task 18.2) refuses outright. Better Auth's own
 * organization role for the creator is left at its default, `"owner"`:
 * design Q2 maps both `owner` and `admin` organization roles to Cerbos's
 * `admin` role at the attribute-builder layer (`packages/authz`, task 7.1),
 * so this script has no reason to (and must not) rename that role itself.
 *
 * Idempotency ("Bootstrapping an organization's first admin is idempotent",
 * this file's own `../src/bootstrap.int.test.ts`): re-running this for an
 * already-bootstrapped organization is a no-op, not a duplicate or a thrown
 * error. Both Better Auth routes this script calls already refuse a
 * duplicate outright -- `auth.api.createUser` throws
 * `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL` for a taken email
 * (`better-auth@1.7.6`, `dist/plugins/admin/routes.mjs`), and `auth.api.
 * createOrganization` throws `ORGANIZATION_ALREADY_EXISTS` for a taken slug
 * (`dist/plugins/organization/routes/crud-org.mjs`) -- so `bootstrapAdmin`
 * treats either as "already bootstrapped" and returns without creating
 * anything else. Since both calls happen together on every run, a
 * `createUser` failure alone is enough to short-circuit before ever calling
 * `createOrganization`.
 *
 * The CLI entry point at the bottom of this file is guarded to run only when
 * this file is executed directly, never on import: `../src/bootstrap.int.
 * test.ts` imports `bootstrapAdmin` from this same file and must not trigger
 * a real database connection attempt as a side effect of that import.
 */
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { createPool } from '@tayzu/db';
import { isAPIError } from 'better-auth/api';
import { drizzle } from 'drizzle-orm/node-postgres';

import { createAuth, type AuthInstance, type UserSyncPort } from '../src/auth.js';
import * as authSchema from '../src/persistence/schema.js';

export interface BootstrapAdminParams {
  readonly organizationName: string;
  readonly organizationSlug: string;
  readonly adminName: string;
  readonly adminEmail: string;
}

export interface BootstrapAdminResult {
  readonly organizationSlug: string;
  readonly adminEmail: string;
  /**
   * `false` on the idempotent no-op path: an already-bootstrapped
   * organization or user was found, so nothing was created this run.
   */
  readonly created: boolean;
  /**
   * The system-generated temporary password, present only when `created` is
   * `true` -- shown once, on the one run that actually created the account
   * (design D22's "shown once" discipline, same as `identity.users.create`,
   * task 18.3). Never logged, never re-derivable on a later, idempotent run.
   */
  readonly temporaryPassword?: string;
}

export interface BootstrapAdminOptions {
  /** Task 18.5 (design D22): upserts the first admin's `_user` entity directly. */
  readonly userSync?: UserSyncPort;
}

interface CreateUserApiSurface {
  createUser(args: {
    body: { name: string; email: string; password: string };
  }): Promise<{ user: { id: string; email: string } }>;
}

interface CreateOrganizationApiSurface {
  createOrganization(args: {
    body: { name: string; slug: string; userId: string };
  }): Promise<{ id: string; slug: string }>;
}

/**
 * `better-auth@1.7.6`, `dist/plugins/admin/routes.mjs`:
 * `ADMIN_ERROR_CODES.USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`, thrown by
 * `auth.api.createUser` for a duplicate email.
 */
const USER_ALREADY_EXISTS_CODE = 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL';

/**
 * `better-auth@1.7.6`, `dist/plugins/organization/routes/crud-org.mjs`:
 * `ORGANIZATION_ERROR_CODES.ORGANIZATION_ALREADY_EXISTS`, thrown by
 * `auth.api.createOrganization` for a duplicate slug.
 */
const ORGANIZATION_ALREADY_EXISTS_CODE = 'ORGANIZATION_ALREADY_EXISTS';

/** The Better Auth error code carried on a thrown `auth.api.*` `APIError`, if any. */
function errorCode(error: unknown): string | undefined {
  return isAPIError(error) ? error.body?.code : undefined;
}

/**
 * A single-use, system-generated temporary password (design D22's "shown
 * once" discipline) -- never persisted anywhere beyond the one Better Auth
 * credential account it seeds, never logged.
 */
function generateTemporaryPassword(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Creates `params.organizationSlug`'s first organization and its first
 * admin user, both through the same in-process `auth.api.createUser`/
 * `createOrganization` calls Better Auth's own `admin`/`organization`
 * plugins already expose (task 2.1). Safe to call more than once for the
 * same organization: a second call for parameters that already succeeded
 * once resolves without creating a duplicate organization or user (module
 * doc comment).
 */
export async function bootstrapAdmin(
  auth: AuthInstance,
  params: BootstrapAdminParams,
  options: BootstrapAdminOptions = {},
): Promise<BootstrapAdminResult> {
  const noOp: BootstrapAdminResult = {
    organizationSlug: params.organizationSlug,
    adminEmail: params.adminEmail,
    created: false,
  };

  const temporaryPassword = generateTemporaryPassword();
  const userApi = auth.api as CreateUserApiSurface;
  let userId: string;
  try {
    const result = await userApi.createUser({
      body: { name: params.adminName, email: params.adminEmail, password: temporaryPassword },
    });
    userId = result.user.id;
  } catch (error) {
    if (errorCode(error) === USER_ALREADY_EXISTS_CODE) {
      return noOp;
    }
    throw error;
  }

  const organizationApi = auth.api as CreateOrganizationApiSurface;
  let organizationId: string;
  try {
    const organization = await organizationApi.createOrganization({
      body: { name: params.organizationName, slug: params.organizationSlug, userId },
    });
    organizationId = organization.id;
  } catch (error) {
    if (errorCode(error) === ORGANIZATION_ALREADY_EXISTS_CODE) {
      return noOp;
    }
    throw error;
  }

  await options.userSync?.upsertUser({
    tenantId: organizationId,
    email: params.adminEmail,
    name: params.adminName,
    portRole: 'admin',
    change: { intent: 'membership_added', banned: false },
  });

  return { ...noOp, created: true, temporaryPassword };
}

// --- CLI entry point (never imported for its side effects; see module doc comment) ---

/** Fails closed: an operator running this script without every required variable set gets an explicit error, not a partial bootstrap. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is not set: bootstrap-admin needs it to run.`);
  }
  return value;
}

async function main(): Promise<void> {
  const pool = createPool(requireEnv('DATABASE_URL'));
  try {
    const auth = createAuth({
      db: drizzle(pool, { schema: authSchema }),
      secret: requireEnv('BETTER_AUTH_SECRET'),
    });
    const result = await bootstrapAdmin(auth, {
      organizationName: requireEnv('BOOTSTRAP_ORGANIZATION_NAME'),
      organizationSlug: requireEnv('BOOTSTRAP_ORGANIZATION_SLUG'),
      adminName: requireEnv('BOOTSTRAP_ADMIN_NAME'),
      adminEmail: requireEnv('BOOTSTRAP_ADMIN_EMAIL'),
    });
    if (result.created) {
      // The one and only time this temporary password is ever shown
      // (design D22): printed directly to the operator's own terminal, never
      // logged through `@tayzu/observability` or emailed.
      console.log(
        `Bootstrapped organization "${result.organizationSlug}". Sign in as ${result.adminEmail} with this one-time temporary password and change it immediately: ${result.temporaryPassword ?? ''}`,
      );
    } else {
      console.log(
        `Organization "${result.organizationSlug}" is already bootstrapped; nothing to do.`,
      );
    }
  } finally {
    await pool.end();
  }
}

const isDirectlyExecuted =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectlyExecuted) {
  await main();
}
