/**
 * Integration test for task 18.2 (design D22, resolved decision Q16;
 * `specs/auth-and-rbac/spec.md`, "Public self sign-up is not available").
 *
 * "`emailAndPassword.disableSignUp: true` on the Better Auth instance; the
 * sign-up route is not added to D18's allowlist (design D22)." This file
 * covers exactly the two scenarios task 18.2's own Verify clause names:
 *
 * - "Self sign-up is not available": WHEN a request is sent to Better Auth's
 *   sign-up route over HTTP, THEN it fails with the same 404 response as a
 *   request to a path that does not exist.
 * - "In-process sign-up is refused": WHEN the sign-up handler is invoked
 *   in-process, bypassing HTTP entirely, THEN it is refused and no user
 *   account is created.
 *
 * "An org admin can create a user"/"A member cannot create a user" (task
 * 18.3) and "Bootstrapping an organization's first admin is idempotent"
 * (task 18.4) are later tasks' own scenarios, not this file's.
 *
 * ## Why `auth.handler(new Request(...))` for the first scenario
 *
 * `apps/api` (group 11) does not exist yet as a running Fastify listener --
 * still an empty scaffold (task 1.2; `apps/api/CLAUDE.md`, "Scaffolding
 * state") -- and `packages/auth` deliberately has no `fastify` dependency of
 * its own (its `package.json` lists none). "A request is sent to Better
 * Auth's sign-up route over HTTP" is therefore exercised the same way every
 * other HTTP-shaped scenario in this package already is when `apps/api`
 * cannot yet stand in for it (`enumeration-resistance.int.test.ts`,
 * `pre-auth-rate-limit.int.test.ts`): a real `Request`/`Response` pair driven
 * directly through the production `createAuth` instance's own `.handler`,
 * Better Auth's real, documented HTTP entry point (`auth.handler`), not
 * `auth.api.signUpEmail` (which bypasses the router's `onRequest`/path
 * -matching stage entirely -- verified against the installed
 * `better-call@1.4.0` source, `dist/router.mjs`: `auth.api.*` calls the
 * endpoint function directly, never through `processRequest`). Whatever
 * mechanism task 18.2's green phase uses to make the sign-up route
 * indistinguishable from an unknown one (Better Auth's own `disabledPaths`
 * option, a wrapping check in `createAuth`, or something else) has to be
 * observable through this same real HTTP entry point -- the one `apps/api`
 * will mount unchanged in task 11.1 -- or it does not satisfy the scenario at
 * all.
 *
 * A fresh, random `x-forwarded-for` value per request (the same `randomIp()`
 * helper shape `enumeration-resistance.int.test.ts` and
 * `pre-auth-rate-limit.int.test.ts` already establish) keeps every request
 * this file makes in its own rate-limit bucket, so task 2.5's already-green
 * pre-authentication rate limiter (currently wired only for `/sign-in/email`,
 * `./rate-limit/pre-auth-rate-limit.ts`'s own `PRE_AUTH_RATE_LIMIT_RULES`)
 * can never surface a `429 AUTH_RATE_LIMITED` in place of the `404` this file
 * actually asserts, now or if a later task extends that rule table to cover
 * `/sign-up/email` too.
 *
 * ## Why this file compares two *live* responses, not a hardcoded 404 shape
 *
 * The scenario's own wording is relational -- "the same 404 response as a
 * request to a path that does not exist" -- not "a 404 response." Hardcoding
 * an assumed body/shape for "path does not exist" would silently stop
 * encoding the scenario the moment Better Auth's own unmatched-route response
 * shape changed for any reason unrelated to this capability. Instead, this
 * file drives a second request, to a path this package neither registers nor
 * ever will (`GARBAGE_PATH` below, clearly not a real Better Auth route by
 * construction), through the identical `auth.handler`, and asserts the
 * sign-up response's status and body text equal that live comparison
 * response's status and body text -- exactly the "same ... as" the scenario
 * describes, mirroring `enumeration-resistance.int.test.ts`'s own "compare
 * two live responses to each other" pattern for its own "same status, error
 * code, and body shape" scenario. Response body text (not only status) is
 * compared because D18's own reasoning for this entire design (design.md,
 * "any `/api/auth/*` path not on the allowlist returns 404, identical to an
 * unknown route, never a 403 -- a 403 would confirm the route exists")
 * targets exactly this: nothing about the response may let a caller tell the
 * sign-up route apart from one that was never registered at all. A same
 * -status-different-body response would still leak that distinction through
 * the body, defeating the entire point of returning 404 in the first place.
 *
 * ## Why this is expected to fail for the right reason right now
 *
 * `./auth.ts` (tasks 2.1-18.1) sets `emailAndPassword.disableSignUp: true`
 * already (task 18.1's own green phase; confirmed by reading the file before
 * writing this test), which makes Better Auth's own `/sign-up/email` route
 * throw `APIError.from("BAD_REQUEST", { code: "EMAIL_PASSWORD_SIGN_UP_
 * DISABLED" })` (verified against the installed source, `dist/api/routes/
 * sign-up.mjs`) -- a real `400` response with a JSON body naming the route
 * explicitly, not a `404`. Nothing in `./auth.ts` yet makes this route
 * indistinguishable from an unmatched one (no `disabledPaths` entry, no
 * wrapping check). Driving this exact request through the real, unmodified
 * `createAuth` instance's `.handler` (confirmed by running it against a
 * migrated database before writing this file) returns that `400`/
 * `EMAIL_PASSWORD_SIGN_UP_DISABLED` body, so the first assertion below (`toBe
 * (404)`) fails on a plain, expected assertion failure -- not a missing
 * export or a typo: `./auth.js`, `createAuth`, and `.handler` all already
 * exist and are exercised unchanged by every other int test file in this
 * package.
 *
 * ## Why the second scenario is expected to already pass, not fail
 *
 * `auth.api.signUpEmail` reaches the identical `disableSignUp` check
 * (`sign-up.mjs`'s own early guard, quoted above) directly -- confirmed by
 * running it against a migrated database before writing this file: it
 * rejects with the same `APIError`, and no `auth.user` row is ever inserted
 * for the attempted email (the route throws before any database write).
 * Task 18.1 already made `emailAndPassword.disableSignUp: true` true; this
 * scenario needs nothing beyond that already-green line, so it is expected
 * to **already pass** against the current `./auth.ts`, with no production
 * change needed for this half of task 18.2's own Verify clause -- reported
 * explicitly to the orchestrator below rather than forcing an artificial
 * failure, per this assignment's own instructions ("if they already pass ...
 * report that clearly instead of forcing a failure").
 *
 * ## Why this test connects, seeds and asserts the way it does
 *
 * Same shared-`DATABASE_URL` / `runMigrations`-then-`randomUUID()`-per-test
 * isolation pattern every other int test file in `@tayzu/auth` already
 * establishes (`auth-flow.int.test.ts`, `enumeration-resistance.int.test.ts`),
 * and the same `drizzle(url, { schema: authSchema })` handle those files use
 * (`@better-auth/drizzle-adapter`'s model resolution needs the Drizzle
 * instance to have been constructed with that schema). The second scenario
 * queries `auth."user"` directly (the same raw-SQL pattern
 * `auth-flow.int.test.ts`'s own `findUserByEmail` establishes) rather than
 * trusting the rejected promise alone, so a (wrong) implementation that threw
 * *after* an insert would still be caught.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { runMigrations } from '@tayzu/db';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Import order is load-bearing (task 2.4; design D1; `packages/observability/
// CLAUDE.md`, "Import order"): the harness must register before `./auth.js`,
// even though this file asserts no telemetry itself -- see the identical
// comment in `enumeration-resistance.int.test.ts`.
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

const TEST_SECRET = 'int-test-only-secret-not-used-for-anything-real-0123456789';

/** A password long enough for Better Auth's default 8-character minimum. */
const TEST_PASSWORD = 'correct horse battery staple';

function randomEmail(): string {
  return `signup-disabled-${randomUUID()}@example.test`;
}

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

/** `./auth.ts`'s `AuthInstance.api`/`$context` are typed `unknown`; `.handler` is Better Auth's real, documented HTTP entry point, not otherwise exposed on `AuthInstance` -- same cast every int test file in this package already uses locally. */
function handlerOf(auth: AuthInstance): (request: Request) => Promise<Response> {
  return (auth as unknown as { handler: (request: Request) => Promise<Response> }).handler;
}

const AUTH_BASE_URL = 'http://localhost:3000/api/auth';
const SIGN_UP_PATH = '/sign-up/email';
/** Clearly not a real Better Auth route by construction: no plugin in `./auth.ts` registers anything under this path. */
const GARBAGE_PATH = '/this-route-definitely-does-not-exist-signup-disabled-test';

function requestFor(path: string, ip: string, body: unknown): Request {
  return new Request(`${AUTH_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': ip,
    },
    body: JSON.stringify(body),
  });
}

// A type literal (not an interface), so it satisfies `db.execute`'s
// `TRow extends Record<string, unknown>` constraint (TypeScript's implicit
// index signature applies to object type literals, not interfaces; see the
// same note in `packages/catalog/src/service/__fixtures__/
// blueprint-test-helpers.ts` and `auth-flow.int.test.ts`'s identical `UserRow`).
type CreateUserRow = {
  readonly id: string;
  readonly email: string;
};

async function findUserByEmail(db: TestDb, email: string): Promise<CreateUserRow | undefined> {
  const result = await db.execute<CreateUserRow>(sql`
    select id, email from auth."user" where email = ${email}
  `);
  return result.rows[0];
}

/**
 * `AuthInstance.api` is typed `unknown`; this narrows the one method this
 * file's second scenario needs, the same "introspect the narrower production
 * type locally" pattern every int test file in this package already uses.
 */
interface SignUpEmailApiSurface {
  signUpEmail(args: { body: { name: string; email: string; password: string } }): Promise<unknown>;
}

describe('Public self sign-up is not available (task 18.2, design D22)', () => {
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

  it('Self sign-up is not available: a sign-up request over HTTP fails with the same 404 response as a request to a path that does not exist', async () => {
    const handler = handlerOf(auth);

    // WHEN a request is sent to Better Auth's sign-up route over HTTP ...
    const signUpResponse = await handler(
      requestFor(SIGN_UP_PATH, randomIp(), {
        name: 'Signup Disabled Test User',
        email: randomEmail(),
        password: TEST_PASSWORD,
      }),
    );

    // ... THEN it fails with the same 404 response as a request to a path
    // that does not exist: compared against a live request to a path this
    // package never registers, not a hardcoded assumption about that
    // response's shape (module doc comment, "Why this file compares two live
    // responses").
    const unknownRouteResponse = await handler(requestFor(GARBAGE_PATH, randomIp(), {}));

    expect(unknownRouteResponse.status, 'the unknown-path request itself returns 404').toBe(404);
    expect(
      signUpResponse.status,
      'the sign-up route responds with the same 404 status as a path that does not exist',
    ).toBe(404);

    const signUpBody = await signUpResponse.text();
    const unknownRouteBody = await unknownRouteResponse.text();
    expect(
      signUpBody,
      'the sign-up route responds with the identical body as a path that does not exist -- nothing in the response may reveal that the route exists at all',
    ).toBe(unknownRouteBody);
  });

  it('In-process sign-up is refused: invoking the sign-up handler in-process, bypassing HTTP entirely, is refused and creates no user account', async () => {
    const email = randomEmail();
    const api = auth.api as SignUpEmailApiSurface;

    // WHEN the sign-up handler is invoked in-process, bypassing HTTP
    // entirely: `auth.api.signUpEmail` is Better Auth's own in-process
    // surface, calling the endpoint function directly, never through
    // `auth.handler`'s router (module doc comment).
    await expect(
      api.signUpEmail({
        body: { name: 'Signup Disabled Test User', email, password: TEST_PASSWORD },
      }),
      'the in-process sign-up call is refused, not merely slow to reject',
    ).rejects.toThrow();

    // THEN ... no user account is created.
    const userRow = await findUserByEmail(db, email);
    expect(
      userRow,
      `no auth."user" row exists for ${email} after the refused in-process sign-up attempt`,
    ).toBeUndefined();
  });
});
