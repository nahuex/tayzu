/**
 * Integration test for task 3.5 (design D19; `specs/auth-and-rbac/spec.md`,
 * "Tenant-switch membership is independently re-verified").
 *
 * "Better Auth's `setActiveOrganization` rejects setting an organization the
 * caller is not a member of (design D19)." This file covers exactly the one
 * scenario task 3.5's own Verify clause names, quoted in full from
 * `specs/auth-and-rbac/spec.md`:
 *
 * #### Scenario: Setting an active organization you are not a member of is rejected
 * - GIVEN a signed-in user who is not a member of organization `t2`
 * - WHEN they attempt to set their active organization to `t2`
 * - THEN the request is rejected and their active organization is unchanged
 *
 * The sibling scenario named in the same requirement, "Context resolution
 * independently rejects a stale non-membership", is task 3.6's own Verify
 * clause (`context-resolver.int.test.ts`, "using a membership row removed
 * after the session was established" -- a different fixture, a
 * `resolveContext` re-check rather than `setActiveOrganization` itself), not
 * this file's.
 *
 * ## Why "unchanged" -- not merely "rejected" -- is asserted here
 *
 * The requirement text is explicit that both halves of the THEN clause are
 * load-bearing: "the request is rejected **and** their active organization
 * is unchanged." D19's own prose frames this scenario as the reason a
 * *second*, independent defense (task 3.6's `resolveContext` re-check) is
 * needed at all: "The VCDM pre-assessment found no task verifying that
 * Better Auth's `setActiveOrganization` endpoint ... refuses to set an
 * organization the caller is not a member of." A test that only checked "the
 * request errors" would leave a real gap unexercised: Better Auth's own
 * installed `/organization/set-active` route (`better-auth@1.7.6`,
 * `dist/plugins/organization/routes/crud-org.mjs`) does throw a `FORBIDDEN`
 * `APIError` (`USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION`) when
 * `adapter.checkMembership` fails -- but, in the very same branch, it first
 * calls `adapter.setActiveOrganization(session.session.token, null, ctx)`,
 * which persists `activeOrganizationId = null` on the session row *before*
 * throwing. Confirmed directly against a live instance while writing this
 * file (`DATABASE_URL`-backed probe script, discarded, not committed): a
 * user with an active organization who attempts to switch to an org they do
 * not belong to gets a `403 FORBIDDEN
 * USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION` response, and their session's
 * `active_organization_id` column is left `null`, not restored to the
 * organization it held immediately before the attempt. That is a rejected
 * request whose active organization was still *changed* (from a real
 * organization to none), which is not what "unchanged" means. This test
 * therefore asserts both halves, exactly as the scenario states.
 *
 * ## Why this is expected to fail for the right reason right now
 *
 * `./auth.ts` (task 2.1 onward) registers the `organization` plugin with no
 * options and adds no hook around `/organization/set-active` at all: the
 * rejection half of this test already passes today (Better Auth's own
 * membership check, unmodified), but the "active organization is unchanged"
 * assertion fails -- a plain **assertion failure** (the read-back
 * `active_organization_id` is `null` instead of the organization the session
 * held before the attempt), not a missing export or a typo: `./auth.js`,
 * `createAuth`, and every table this file queries already exist (tasks
 * 2.1-2.4).
 *
 * ## Why this test connects, seeds and asserts the way it does
 *
 * Same shared-`DATABASE_URL` / `runMigrations`-then-`randomUUID()`-per-test
 * isolation pattern every other int test file in `@tayzu/auth` already
 * establishes (`auth-flow.int.test.ts`, `context-resolver.int.test.ts`,
 * `session-policy.int.test.ts`), and the same `drizzle(url, { schema:
 * authSchema })` handle those files use.
 *
 * Real session cookies are obtained by signing up/in through
 * `auth.handler(new Request(...))`, not `auth.api.signUpEmail`/
 * `signInEmail` (no `Set-Cookie` header to read back from the latter),
 * matching every other int test file in this package. Every request below
 * carries its own fresh, random `x-forwarded-for` IP (`randomIp()`), per this
 * task's own instructions, even though `./auth.ts`'s custom rate limiter
 * (task 2.5) is never configured by this file (`createAuth({ db, secret })`,
 * no `rateLimit` option) and so is not in play either way.
 *
 * `POST /organization/set-active` is a cookie-authenticated, state-changing
 * route, so Better Auth's own origin-check middleware
 * (`dist/api/middlewares/origin-check.mjs`, `originCheckMiddleware`) runs
 * for it: any request carrying a `cookie` header must also carry a
 * same-origin `origin` header, or it fails with `403
 * MISSING_OR_NULL_ORIGIN` before the membership check this scenario is about
 * ever runs (confirmed directly against a live instance while writing this
 * file). `./auth.ts` sets no `baseURL`, so Better Auth derives its trusted
 * origin from the incoming request itself (its own startup warning: "Without
 * it the origin is derived from the incoming request") -- `AUTH_BASE_URL`
 * below (`http://localhost:3000/api/auth`, the same constant every other int
 * test file in this package uses) is passed as both the request URL's origin
 * and the `origin` header on this one mutating call, so the scenario's own
 * membership check is what is exercised, not an incidental CSRF rejection. A
 * real browser sending this same request would include this header
 * automatically; this test supplies it explicitly for the same reason
 * `x-forwarded-for` is supplied explicitly throughout this package's int
 * tests.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { runMigrations } from '@tayzu/db';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Import order is load-bearing (design D1; `packages/observability/CLAUDE.md`,
// "Import order"): the harness must register before `./auth.js`, which
// imports a telemetry/instruments module that creates its tracer, meter and
// logger at import time. Same rationale as every other int test file in this
// package; this file asserts no telemetry itself.
import { bootstrapTestTenant, createAdminUser } from './__fixtures__/admin-user.js';
import './__fixtures__/registered-harness.js';
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

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

function randomEmail(prefix: string): string {
  return `${prefix}-${randomUUID()}@example.test`;
}

function randomSlug(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

/** A password long enough for Better Auth's default 8-character minimum. */
const TEST_PASSWORD = 'correct horse battery staple';
const TEST_SECRET = 'int-test-only-secret-not-used-for-anything-real-0123456789';

const AUTH_BASE_URL = 'http://localhost:3000/api/auth';
/** Same origin as `AUTH_BASE_URL` -- see this file's own module doc comment. */
const TEST_ORIGIN = 'http://localhost:3000';

/**
 * `./auth.ts`'s `AuthInstance.api` is typed `unknown`; `.handler` is Better
 * Auth's real, documented HTTP entry point, not otherwise exposed on
 * `AuthInstance` yet -- same cast every other int test file in this package
 * already uses.
 */
function handlerOf(auth: AuthInstance): (request: Request) => Promise<Response> {
  return (auth as unknown as { handler: (request: Request) => Promise<Response> }).handler;
}

interface CreateOrganizationResult {
  readonly id: string;
  readonly slug: string;
}

/**
 * The narrow slice of `auth.api` this file drives in-process (organization
 * creation only -- sign-up/sign-in/set-active go through `auth.handler`
 * instead, see this file's own module doc comment), typed locally the same
 * way `auth-flow.int.test.ts`'s own `AuthApiSurface` is.
 */
interface AuthApiSurface {
  createOrganization(args: {
    body: { name: string; slug: string; userId: string };
  }): Promise<CreateOrganizationResult>;
}

function apiOf(auth: AuthInstance): AuthApiSurface {
  return auth.api as AuthApiSurface;
}

function postJson(
  handler: (request: Request) => Promise<Response>,
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<Response> {
  return handler(
    new Request(`${AUTH_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
}

type SessionRow = {
  readonly active_organization_id: string | null;
};

async function findSessionByToken(db: TestDb, token: string): Promise<SessionRow | undefined> {
  const result = await db.execute<SessionRow>(sql`
    select active_organization_id from auth.session where token = ${token}
  `);
  return result.rows[0];
}

describe('setActiveOrganization: rejects a non-member organization (task 3.5, design D19)', () => {
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

  it('Setting an active organization you are not a member of is rejected', async () => {
    const handler = handlerOf(auth);

    // GIVEN "a signed-in user who is not a member of organization t2": task
    // 18.1 (design D22) provisions the user under test through the
    // admin-creation path (`./__fixtures__/admin-user.js`'s
    // `bootstrapTestTenant`, no self-service `/sign-up/email` route left to
    // call), becoming t1's sole member; a second, unrelated user (also
    // admin-created) creates a second organization (t2) that the user under
    // test never joins.
    const userA = await bootstrapTestTenant(auth, {
      name: 'Active Org Test User A',
      email: randomEmail('active-org-a'),
      password: TEST_PASSWORD,
      organizationName: 'Active Org Test Org 1',
      organizationSlug: randomSlug('active-org-t1'),
      ip: randomIp(),
    });
    const t1Id = userA.organizationId;
    const cookieA = userA.cookie;

    const adminB = await createAdminUser(auth, {
      name: 'Active Org Test User B',
      email: randomEmail('active-org-b'),
      password: TEST_PASSWORD,
    });
    const t2 = await apiOf(auth).createOrganization({
      body: {
        name: 'Active Org Test Org 2',
        slug: randomSlug('active-org-t2'),
        userId: adminB.userId,
      },
    });

    // GIVEN sanity check: the signed-in session really is active on t1, and
    // user A really has no membership row for t2 -- independent of whatever
    // `/organization/set-active` itself does with it.
    const beforeAttempt = await findSessionByToken(db, userA.token);
    expect(
      beforeAttempt?.active_organization_id,
      "user A's session is active on their own organization (t1) before the attempt",
    ).toBe(t1Id);

    // WHEN "they attempt to set their active organization to t2".
    const setActiveResponse = await postJson(
      handler,
      '/organization/set-active',
      { organizationId: t2.id },
      { cookie: cookieA, origin: TEST_ORIGIN, 'x-forwarded-for': randomIp() },
    );

    // THEN "the request is rejected ...".
    expect(
      setActiveResponse.ok,
      'setting an active organization the caller is not a member of fails',
    ).toBe(false);

    // THEN "... and their active organization is unchanged": still t1, the
    // same organization the session was active on immediately before the
    // rejected attempt -- not `null`, and not t2.
    const afterAttempt = await findSessionByToken(db, userA.token);
    expect(
      afterAttempt?.active_organization_id,
      "user A's active organization is unchanged (still t1) after the rejected attempt",
    ).toBe(t1Id);
  });
});
