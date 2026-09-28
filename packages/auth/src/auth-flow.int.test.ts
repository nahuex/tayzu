/**
 * Integration test for task 2.3 (design D2, D13; Migration Plan step 1).
 * "Mount Better Auth's sign-up and sign-in behind `apps/api` (built in group
 * 11, stubbed here with an in-process handler call)."
 *
 * `apps/api` does not exist yet (group 11), so this test drives the
 * production `createAuth` instance (`./auth.js`, task 2.1) directly,
 * in-process, through `auth.api.signUpEmail`/`createOrganization`/
 * `signInEmail` — the same calling convention Better Auth's own
 * `getTestInstance` helper uses to exercise these endpoints without a real
 * HTTP request (verified against the installed `better-auth@1.7.6` source,
 * `dist/test-utils/test-instance.mjs`), and one of the two forms this task's
 * own text names ("`auth.handler(new Request(...))` or `auth.api.*`"). Once
 * `apps/api` mounts `auth.handler` at `/api/auth/*` (task 11.1), an HTTP-level
 * test takes over this same behavior; this cycle only needs the Better Auth
 * instance itself to behave correctly.
 *
 * This file covers exactly the two things task 2.3's Verify clause names:
 *
 * - The precondition of the later (task 12.2) scenario "Signing up creates a
 *   matching `_user` entity" (`specs/auth-and-rbac/spec.md`): "a new user
 *   signs up and joins an organization" — so a Better Auth `user` row and an
 *   `organization` row (with a `member` row joining them) exist. This test
 *   does **not** assert anything about a `_user` catalog entity: that upsert
 *   is task 12.2's own hook, wired through `@tayzu/catalog`, which this
 *   package does not depend on (design D1's acyclic package graph).
 * - "Sign in with the correct password succeeds": a user who has already
 *   signed up can sign in again with the same password and gets back a
 *   session token, independent of the two-factor plugin task 4.1 layers on
 *   top later (this cycle's user has no enrolled TOTP factor).
 *
 * ## Why this is expected to fail for the right reason right now
 *
 * `./auth.ts` (task 2.1) registers the `organization`/`admin`/`two-factor`/
 * `jwt`/`apiKey` plugins but never sets `emailAndPassword: { enabled: true }`.
 * Better Auth's own `/sign-up/email` and `/sign-in/email` routes both check
 * `ctx.context.options.emailAndPassword?.enabled` first and throw a
 * `BAD_REQUEST` (`EMAIL_PASSWORD_SIGN_UP_DISABLED`) / `EMAIL_PASSWORD_DISABLED`
 * `APIError` before doing anything else (verified against the installed
 * source, `dist/api/routes/sign-up.mjs`/`sign-in.mjs`) — so both tests below
 * fail on that thrown `APIError`, not on a missing export or a typo: this
 * package, `./auth.js` and `createAuth` all already exist (task 2.1).
 *
 * ## Why this test connects, seeds and asserts the way it does
 *
 * Same shared-`DATABASE_URL`, `runMigrations`-then-`randomUUID()`-per-test
 * isolation pattern `packages/catalog/src/service/blueprints.int.test.ts`
 * (001) and `packages/db/src/schema.int.test.ts` (task 2.2) already
 * establish, adapted here because `@tayzu/auth`'s own tables have no
 * `tenant_id` column to key a fresh tenant off (design D6: "`tenant_id` =
 * `organization.id`", `organization` itself is the tenant); "a fresh random
 * tenant/org per test" instead means a freshly created `organization` row
 * (random `slug`) and a freshly signed-up `user` row (random `email`) per
 * test, so concurrent test files never collide on either unique constraint
 * (`user_email_uq`, `organization_slug_uq`, `packages/auth/src/persistence/
 * schema.ts`).
 *
 * The Drizzle handle passed to `createAuth`'s `db` option is built with
 * `drizzle(url, { schema: authSchema })`, not the bare `drizzle(url)` overload
 * `blueprints.int.test.ts` uses: `@better-auth/drizzle-adapter`'s own
 * `getSchema(model)` falls back to `db._.fullSchema` when
 * `drizzleAdapter`'s own `config.schema` option is not set (verified against
 * the installed `@better-auth/drizzle-adapter@1.7.6` source,
 * `dist/index.mjs`), and `./auth.ts` (task 2.1) never sets `config.schema`
 * either — so the adapter can only resolve a Better Auth model name (for
 * example `"user"`) to a real table object when the Drizzle instance itself
 * was constructed with that schema, exactly the way `apps/api` will build it
 * in task 11.1.
 *
 * Migrations are applied with `@tayzu/db`'s own `runMigrations(pool)`, the
 * same standard harness pattern every other int test file in this repo uses
 * (for example `packages/catalog/src/service/blueprints.int.test.ts`):
 * `packages/auth/package.json` now declares `@tayzu/db` as a dependency, so
 * this file builds its Drizzle handle exactly like `blueprint-test-
 * helpers.ts`'s own `connect`/`databaseUrl`/`endQuietly` trio does, then runs
 * migrations through `db.$client` (the underlying `pg.Pool`
 * `drizzle(url, { schema })` builds for a string `url`, `TClient` defaulting
 * to `Pool` — verified against the installed `drizzle-orm@0.45.3` source,
 * `drizzle-orm/node-postgres/driver.d.ts`) instead of a bare, unlocked
 * `drizzle-orm/node-postgres/migrator` call: `runMigrations` holds the same
 * session-level advisory lock every other int test file relies on to
 * serialize concurrent first-time appliers on a fresh database (design D12).
 */
import { randomUUID } from 'node:crypto';

import { runMigrations } from '@tayzu/db';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAuth, type AuthInstance } from './auth.js';
import * as authSchema from './persistence/schema.js';

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
  return `flow-${randomUUID()}@example.test`;
}

function randomSlug(): string {
  return `org-${randomUUID()}`;
}

/** A password long enough for Better Auth's default 8-character minimum. */
const TEST_PASSWORD = 'correct horse battery staple';
const TEST_SECRET = 'int-test-only-secret-not-used-for-anything-real-0123456789';

interface SignUpEmailResult {
  readonly token: string | null;
  readonly user: { readonly id: string; readonly email: string };
}

interface SignInEmailResult {
  readonly token: string | null;
  readonly user: { readonly id: string; readonly email: string };
}

interface CreateOrganizationResult {
  readonly id: string;
  readonly slug: string;
}

/**
 * The narrow slice of `auth.api` this file drives, typed locally: `./auth.ts`
 * (task 2.1) deliberately types `AuthInstance.api` as `unknown` (its own
 * comment: "callers introspect it by name"), the same pattern
 * `auth-instance.test.ts` already uses for its own, narrower per-plugin
 * assertions.
 */
interface AuthApiSurface {
  signUpEmail(args: {
    body: { name: string; email: string; password: string };
  }): Promise<SignUpEmailResult>;
  signInEmail(args: { body: { email: string; password: string } }): Promise<SignInEmailResult>;
  createOrganization(args: {
    body: { name: string; slug: string; userId: string };
  }): Promise<CreateOrganizationResult>;
}

function apiOf(auth: AuthInstance): AuthApiSurface {
  return auth.api as AuthApiSurface;
}

// Type literals (not interfaces), so each satisfies `db.execute`'s
// `TRow extends Record<string, unknown>` constraint (TypeScript's implicit
// index signature applies to object type literals, not interfaces; see the
// same note in `packages/catalog/src/service/__fixtures__/
// blueprint-test-helpers.ts`).
type UserRow = {
  readonly id: string;
  readonly email: string;
};

type OrganizationRow = {
  readonly id: string;
  readonly slug: string;
};

type MemberRow = {
  readonly user_id: string;
  readonly organization_id: string;
  readonly role: string;
};

async function findUserByEmail(db: TestDb, email: string): Promise<UserRow | undefined> {
  const result = await db.execute<UserRow>(sql`
    select id, email from auth."user" where email = ${email}
  `);
  return result.rows[0];
}

async function findOrganizationById(
  db: TestDb,
  organizationId: string,
): Promise<OrganizationRow | undefined> {
  const result = await db.execute<OrganizationRow>(sql`
    select id, slug from auth.organization where id = ${organizationId}
  `);
  return result.rows[0];
}

async function findMember(
  db: TestDb,
  organizationId: string,
  userId: string,
): Promise<MemberRow | undefined> {
  const result = await db.execute<MemberRow>(sql`
    select user_id, organization_id, role
      from auth.member
     where organization_id = ${organizationId} and user_id = ${userId}
  `);
  return result.rows[0];
}

describe('Better Auth sign-up and sign-in behind apps/api (task 2.3, design D2, D13)', () => {
  let db: TestDb;
  let auth: AuthInstance;
  let api: AuthApiSurface;

  beforeAll(async () => {
    db = connect(databaseUrl());
    await runMigrations(db.$client);
    auth = createAuth({ db, secret: TEST_SECRET });
    api = apiOf(auth);
  }, 60_000);

  afterAll(async () => {
    await endQuietly(db.$client);
  });

  it('the "Signing up creates a matching `_user` entity" precondition holds: an organization and a Better Auth user exist', async () => {
    const email = randomEmail();
    const slug = randomSlug();

    const signUp = await api.signUpEmail({
      body: { name: 'Flow Test User', email, password: TEST_PASSWORD },
    });

    expect(signUp.user.email).toBe(email);

    const userRow = await findUserByEmail(db, email);
    expect(userRow, `a Better Auth "user" row exists for ${email}`).toBeDefined();
    expect(userRow?.id).toBe(signUp.user.id);

    // "... and joins an organization" (spec "Signing up creates a matching
    // `_user` entity"): the signed-up user creates, and so joins, one.
    const organization = await api.createOrganization({
      body: { name: 'Flow Test Org', slug, userId: signUp.user.id },
    });

    expect(organization.slug).toBe(slug);

    const organizationRow = await findOrganizationById(db, organization.id);
    expect(
      organizationRow,
      `a Better Auth "organization" row exists for slug ${slug}`,
    ).toBeDefined();
    expect(organizationRow?.slug).toBe(slug);

    const memberRow = await findMember(db, organization.id, signUp.user.id);
    expect(
      memberRow,
      'a Better Auth "member" row joins the signed-up user to the organization',
    ).toBeDefined();
  });

  it('Sign in with the correct password succeeds', async () => {
    const email = randomEmail();
    await api.signUpEmail({
      body: { name: 'Flow Test User', email, password: TEST_PASSWORD },
    });

    const signIn = await api.signInEmail({
      body: { email, password: TEST_PASSWORD },
    });

    expect(signIn.token).toBeTypeOf('string');
    expect(signIn.token).not.toBe('');
    expect(signIn.user.email).toBe(email);
  });
});
