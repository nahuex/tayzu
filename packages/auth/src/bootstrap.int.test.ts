/**
 * Integration test for task 18.4 (design D22, resolved decision Q16;
 * `specs/auth-and-rbac/spec.md`, "Public self sign-up is not available").
 *
 * "`packages/auth/scripts/bootstrap-admin.ts`: an idempotent,
 * non-HTTP-reachable script creating an organization and its first `admin`
 * -role user, via the same `auth.api.createUser` call as 18.3 (design D22)."
 * This file covers exactly the one scenario task 18.4's own Verify clause
 * names:
 *
 * - "Bootstrapping an organization's first admin is idempotent"
 *   (`specs/auth-and-rbac/spec.md`): GIVEN an organization that has already
 *   been bootstrapped with a first admin, WHEN the bootstrap script is run
 *   again for that same organization, THEN no duplicate organization or user
 *   is created.
 *
 * "An org admin can create a user"/"A member cannot create a user" (task
 * 18.3, `identity.users.create`) are a different task's own scenarios, not
 * this file's -- this file never touches Cerbos or any oRPC procedure. Task
 * 18.4's script reuses `auth.api.createUser` the same way task 18.1's test
 * -only `createAdminUser` fixture already does
 * (`./__fixtures__/admin-user.ts`'s own module doc comment).
 *
 * ## Why this is expected to fail for the right reason right now
 *
 * `packages/auth/scripts/bootstrap-admin.ts` does not exist yet (confirmed by
 * listing `packages/auth/scripts/` before writing this file: the directory
 * itself has no files, task 18.4 not started). Importing `bootstrapAdmin` from
 * `../scripts/bootstrap-admin.js` below is therefore expected to fail to
 * resolve the module -- "Cannot find module" (or Vite/esbuild's equivalent
 * "Failed to resolve import") -- not a typo or a broken fixture: every other
 * import in this file (`@tayzu/db`'s `runMigrations`, `./auth.js`'s
 * `createAuth`, `./persistence/schema.js`) already exists and is exercised
 * unchanged by every other int test file in this package.
 *
 * ## Why this file calls the production symbol it does
 *
 * `bootstrapAdmin(auth, params)` is the one production entry point this test
 * needs: an exported, pure function taking an already-constructed
 * `AuthInstance` (this file's own `auth`, built the same
 * `createAuth({ db, secret })` way every other int test file in this package
 * builds it) plus the four fields the scenario's GIVEN/WHEN need to identify
 * "that same organization" across two runs (`organizationName`,
 * `organizationSlug`, `adminName`, `adminEmail`) -- the same "accept an
 * already-built `AuthInstance` rather than construct one internally" shape
 * `./__fixtures__/admin-user.ts`'s own `bootstrapTestTenant` already
 * establishes for this package's tests, so a real, non-HTTP-reachable CLI
 * entry point (reading `process.env`, building its own `AuthInstance`, then
 * calling this same exported function) can sit in the same file without
 * changing what this test drives. This test does not exercise that CLI
 * entry point at all -- only the exported, idempotent core the design's own
 * text names ("idempotent (re-running it for an already-bootstrapped tenant
 * is a no-op, not a duplicate)").
 *
 * ## Why this file asserts the way it does
 *
 * Both `auth.organization` (`slug` unique) and `auth.user` (`email` unique)
 * carry a unique constraint (`packages/auth/src/persistence/schema.ts`), so a
 * naively duplicate-creating implementation would not silently succeed --
 * it would throw a constraint violation, or (more likely, since Better Auth's
 * own `/organization/create`/`/admin/create-user` routes both check for an
 * existing slug/email first and throw a `BAD_REQUEST` `APIError`
 * -- `ORGANIZATION_ALREADY_EXISTS`/`USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`
 * respectively, verified against the installed `better-auth@1.7.6` source,
 * `dist/plugins/organization/routes/crud-org.mjs` and
 * `dist/plugins/admin/routes.mjs` -- reject the second call outright rather
 * than silently create a duplicate. Either failure mode (a thrown error, or a
 * duplicate row) would violate "is idempotent"/"no duplicate organization or
 * user is created", so this test asserts both halves directly: the second
 * call resolves without throwing (a script that must be safe to re-run
 * cannot itself fail on the re-run), and a live count against the database
 * (not only the resolved value, which an implementation careless about a
 * *third*, since-superseded row could still get right) shows exactly one
 * `organization` row for that slug and exactly one `user` row for that email
 * after both calls -- the same "trust a live database query over the
 * returned promise alone" discipline `signup-disabled.int.test.ts`'s own
 * `findUserByEmail` establishes for its own negative case.
 *
 * ## Why this test connects, seeds and asserts the way it does
 *
 * Same shared-`DATABASE_URL` / `runMigrations`-then-`randomUUID()`-per-test
 * isolation pattern every other int test file in this package already
 * establishes (`auth-flow.int.test.ts`, `signup-disabled.int.test.ts`): a
 * fresh, random `organizationSlug`/`adminEmail` pair per test run, so
 * concurrent test files never collide on either unique constraint. No
 * `x-forwarded-for`/`randomIp()` is needed here (unlike this package's
 * HTTP-shaped int tests): `bootstrapAdmin` is expected to call `auth.api.*`
 * in-process, the same headerless calling convention
 * `./__fixtures__/admin-user.ts`'s `createAdminUser`/`bootstrapTestTenant`
 * already use for `createUser`/`createOrganization`, which task 2.5's
 * pre-authentication rate limiter does not wrap (`./rate-limit/pre-auth-rate
 * -limit.ts`'s own `PRE_AUTH_RATE_LIMIT_RULES` only cover `/sign-in/email`,
 * `/two-factor/verify*`, and sign-up/email-verification routes) -- so no
 * request in this file can ever be rate-limited.
 */
import { randomUUID } from 'node:crypto';

import { runMigrations } from '@tayzu/db';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Import order is load-bearing (task 2.4; design D1; `packages/observability/
// CLAUDE.md`, "Import order"): the harness must register before `./auth.js`
// (imported below to build this file's own `AuthInstance`), even though this
// test asserts no telemetry itself -- see the identical comment in
// `signup-disabled.int.test.ts`/`auth-flow.int.test.ts`.
import './__fixtures__/registered-harness.js';
import { createAuth, type AuthInstance } from './auth.js';
import * as authSchema from './persistence/schema.js';
// The module under test (task 18.4): does not exist yet (module doc comment,
// "Why this is expected to fail for the right reason right now").
import { bootstrapAdmin } from '../scripts/bootstrap-admin.js';
import { TEST_SECRET } from './__fixtures__/test-secret.js';

/** Same fail-fast pattern as every other int test file in this repo. */
function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim() === '') {
    throw new Error(
      'DATABASE_URL is not set: the int project global setup should have stopped this run.',
    );
  }
  return url;
}

function connect(url: string): ReturnType<typeof drizzle<typeof authSchema>> {
  return drizzle(url, { schema: authSchema });
}

type TestDb = ReturnType<typeof connect>;

async function endQuietly(closeable: {
  on(event: 'error', listener: (error: unknown) => void): unknown;
  end(): Promise<void>;
}): Promise<void> {
  closeable.on('error', () => {
    // Expected only during teardown; nothing left to report it to.
  });
  await closeable.end();
}

function randomEmail(): string {
  return `bootstrap-${randomUUID()}@example.test`;
}

function randomSlug(): string {
  return `bootstrap-org-${randomUUID()}`;
}

// A type literal (not an interface), so it satisfies `db.execute`'s
// `TRow extends Record<string, unknown>` constraint (TypeScript's implicit
// index signature applies to object type literals, not interfaces; see the
// same note in `auth-flow.int.test.ts`'s own `UserRow`/`OrganizationRow`).
type CountRow = {
  readonly count: string;
};

async function countOrganizationsBySlug(db: TestDb, slug: string): Promise<number> {
  const result = await db.execute<CountRow>(sql`
    select count(*)::text as count from auth.organization where slug = ${slug}
  `);
  return Number(result.rows[0]?.count ?? '0');
}

async function countUsersByEmail(db: TestDb, email: string): Promise<number> {
  const result = await db.execute<CountRow>(sql`
    select count(*)::text as count from auth."user" where email = ${email}
  `);
  return Number(result.rows[0]?.count ?? '0');
}

describe("Bootstrapping an organization's first admin is idempotent (task 18.4, design D22)", () => {
  let db: TestDb;
  let auth: AuthInstance;

  beforeAll(async () => {
    db = connect(databaseUrl());
    await runMigrations(db.$client);
    auth = createAuth({ db, secret: TEST_SECRET });
  }, 60_000);

  afterAll(async () => {
    await endQuietly(db.$client);
  });

  it('running the bootstrap script twice for the same organization creates no duplicate organization or user', async () => {
    const params = {
      organizationName: 'Bootstrap Test Org',
      organizationSlug: randomSlug(),
      adminName: 'Bootstrap Admin',
      adminEmail: randomEmail(),
    };

    // GIVEN an organization that has already been bootstrapped with a first
    // admin: the first run must itself succeed, establishing the state the
    // scenario's GIVEN clause requires.
    await bootstrapAdmin(auth, params);
    expect(
      await countOrganizationsBySlug(db, params.organizationSlug),
      'the first bootstrap run creates exactly one organization for this slug',
    ).toBe(1);
    expect(
      await countUsersByEmail(db, params.adminEmail),
      'the first bootstrap run creates exactly one user for this email',
    ).toBe(1);

    // WHEN the bootstrap script is run again for that same organization: a
    // script that must be safe to re-run cannot itself fail on the re-run
    // ("idempotent ... a no-op, not a duplicate", design D22).
    await expect(
      bootstrapAdmin(auth, params),
      'running the bootstrap script again for an already-bootstrapped organization does not throw',
    ).resolves.toBeDefined();

    // THEN no duplicate organization or user is created: a live count
    // against the database, not only the resolved value (module doc
    // comment, "Why this file asserts the way it does").
    expect(
      await countOrganizationsBySlug(db, params.organizationSlug),
      'no duplicate organization exists for this slug after the second run',
    ).toBe(1);
    expect(
      await countUsersByEmail(db, params.adminEmail),
      'no duplicate user exists for this email after the second run',
    ).toBe(1);
  });
});
