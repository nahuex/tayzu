/**
 * Integration test for task 18.3 (openspec/changes/002-auth-and-rbac; design
 * D22, Resolved decision Q16; `specs/auth-and-rbac/spec.md`, "Public self
 * sign-up is not available").
 *
 * Task 18.3: "`identity.users.create`: a Cerbos-gated oRPC procedure (`admin`
 * role, `user.yaml` resource policy) calling `auth.api.createUser` in-process,
 * fixing the created user's initial role and returning a system-generated
 * temporary password once, in the creation response only."
 *
 * Scenarios covered (verbatim from the spec):
 * - "An org admin can create a user": GIVEN a caller with the `admin` role,
 *   WHEN they create a user with an email and a fixed actor kind, THEN a
 *   Tayzu user account exists, and a temporary credential is returned once in
 *   the response.
 * - "A member cannot create a user": GIVEN a caller with only the `member`
 *   role, WHEN they attempt to create a user, THEN it fails with
 *   `AUTH_FORBIDDEN`.
 *
 * The test lives in `apps/api` because it is the only package depending on
 * `@tayzu/auth` and `@tayzu/authz` together (`@tayzu/auth` has no dependency
 * on `@tayzu/authz`), same reason `user-sync.int.test.ts` gives.
 *
 * ## Production symbols assumed (none of them exists yet)
 *
 * - `./identity-router.js` exports `createIdentityRouter({ auth, authz })`,
 *   an oRPC router (called in-process with `createRouterClient`, never over
 *   HTTP, design D18/CLAUDE.md "No network exposure") with one procedure at
 *   `identity.users.create`. `auth` is the `AuthInstance`, `authz` the
 *   `CerbosClient` from `@tayzu/authz`.
 * - The procedure's host-supplied context is the same raw shape the catalog
 *   router takes: `{ tenantId, actor, principal: { roles } }`. It checks
 *   Cerbos for resource kind `user`, action `create` (`user.yaml`, no policy
 *   change needed: `admin` gets `*`, `member` only `view`/`list`). A deny
 *   throws an error whose `code` is `AUTH_FORBIDDEN` (`AuthorizationError`)
 *   and nothing is created.
 * - Input: `{ email, name, role }` -- `role` is the created user's fixed
 *   initial (Better Auth admin plugin) role. The caller never supplies a
 *   password: the procedure generates it.
 * - Output includes `temporaryPassword` (a non-empty string) and `email`.
 *   The password is real: signing in with it succeeds. It is returned in the
 *   creation response only (no email is sent, 002 ships no email sender).
 *
 * The spec's scenario says "an email and a fixed actor kind"; the task text
 * says "initial role". This test treats it as the one `role` input field.
 * Nothing about organization membership is asserted: the spec does not say.
 */
import { randomUUID } from 'node:crypto';

import { createRouterClient } from '@orpc/server';
import { authSchema, createAuth, type AuthInstance } from '@tayzu/auth';
import { createCerbosClient } from '@tayzu/authz';
import { runMigrations } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import {
  createAdminUser,
  signInAdminUser,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { harnessPools } from './__fixtures__/pools.js';
// The module under test (task 18.3): does not exist yet.
import { createIdentityRouter } from './identity-router.js';
import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';

function randomIp(): string {
  const octet = (): string => String(1 + Math.floor(Math.random() * 254));
  return `10.${octet()}.${octet()}.${octet()}`;
}

interface CreateOrganizationSurface {
  createOrganization(args: {
    body: { name: string; slug: string; userId: string };
  }): Promise<{ id: string }>;
}

type UserRow = { readonly id: string; readonly role: string | null };

describe('identity.users.create (task 18.3, design D22)', () => {
  let authPool: Pool;
  let auth: AuthInstance;
  let client: ReturnType<
    typeof createRouterClient<ReturnType<typeof createIdentityRouter>, Record<string, unknown>>
  >;

  beforeAll(async () => {
    const pools = await harnessPools();
    authPool = pools.authPool;
    await runMigrations(authPool);
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
    });
    const cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    client = createRouterClient(createIdentityRouter({ auth, authz: cerbos }), {
      context: (raw: Record<string, unknown>) => raw,
    });
  }, 60_000);

  async function freshTenantId(): Promise<string> {
    const id = randomUUID();
    const owner = await createAdminUser(auth, {
      name: 'Tenant Owner',
      email: `owner-${id}@example.test`,
      password: 'correct-horse-battery-staple',
    });
    const org = await (auth.api as CreateOrganizationSurface).createOrganization({
      body: { name: 'Admin Creation Org', slug: `admin-creation-${id}`, userId: owner.userId },
    });
    return org.id;
  }

  function context(tenantId: string, roles: readonly string[]): Record<string, unknown> {
    return {
      tenantId,
      actor: { type: 'user', id: `caller-${randomUUID()}` },
      principal: { roles },
    };
  }

  async function findUser(email: string): Promise<UserRow | undefined> {
    const db = drizzle(authPool, { schema: authSchema });
    const result = await db.execute<UserRow>(sql`
      select id, role from auth."user" where email = ${email}
    `);
    return result.rows[0];
  }

  it('An org admin can create a user: the account exists and a working temporary password is returned in the response', async () => {
    const tenantId = await freshTenantId();
    const email = `created-${randomUUID()}@example.test`;

    // GIVEN a caller with the `admin` role; WHEN they create a user.
    const result = await client.identity.users.create(
      { email, name: 'Created By Admin', role: 'user' },
      { context: context(tenantId, ['admin']) },
    );

    // THEN a Tayzu user account exists, with the fixed initial role...
    const row = await findUser(email);
    expect(row, 'a user account exists for the email').toBeDefined();
    expect(row?.role).toBe('user');

    // ...and a temporary credential is returned in the response.
    expect(typeof result.temporaryPassword).toBe('string');
    expect(result.temporaryPassword.length).toBeGreaterThan(0);

    // The returned credential is real: it signs the new user in.
    const signedIn = await signInAdminUser(auth, {
      email,
      password: result.temporaryPassword,
      ip: randomIp(),
    });
    expect(signedIn.email).toBe(email);
  }, 60_000);

  it('A member cannot create a user: it fails with AUTH_FORBIDDEN and no account is created', async () => {
    const tenantId = await freshTenantId();
    const email = `forbidden-${randomUUID()}@example.test`;

    // GIVEN a caller with only the `member` role; WHEN they attempt to create a user.
    const thrown: unknown = await client.identity.users
      .create(
        { email, name: 'Should Not Exist', role: 'user' },
        { context: context(tenantId, ['member']) },
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // THEN it fails with `AUTH_FORBIDDEN`...
    expect(thrown, 'the call must be rejected').toBeDefined();
    expect((thrown as { code?: unknown }).code).toBe('AUTH_FORBIDDEN');

    // ...and nothing was created.
    expect(await findUser(email)).toBeUndefined();
  }, 60_000);
});
