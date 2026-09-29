/**
 * Integration test for task 2.6 (design Non-Goals: "Sign-up and sign-in,
 * which do ship in 002, still carry the enumeration-resistance requirement
 * below"; `specs/auth-and-rbac/spec.md`, "Authentication responses resist
 * account enumeration").
 *
 * "Sign-in/sign-up failure responses are identical in status, error code,
 * and body shape regardless of whether the account exists." This file
 * covers exactly the scenario task 2.6's own Verify clause names, "Sign-in
 * failure looks the same for an unknown account and a wrong password":
 *
 * - GIVEN one email with no account and one email with an account and a
 *   known password
 * - WHEN sign-in is attempted for the first with any password, and for the
 *   second with the wrong password
 * - THEN both attempts fail with the same status, error code, and body shape
 *
 * ## Sign-up is deliberately not covered here
 *
 * The requirement's own prose also says "Sign-up ... responses MUST NOT
 * reveal whether an email address has an account," but
 * `specs/auth-and-rbac/spec.md` names exactly one `#### Scenario:` under
 * this requirement -- the sign-in one quoted above -- and task 2.6's own
 * Verify clause in `tasks.md` names only that same scenario for this file.
 * There is no "sign-up for an already-registered email" Scenario in the
 * spec to encode a body-shape comparison against (what the "same" response
 * should even look like -- a generic success, a generic conflict, something
 * else -- is exactly the kind of implementation detail a missing Scenario
 * leaves unspecified). Per the test-writer discipline ("each spec scenario
 * becomes at least one test," not the surrounding requirement prose taken in
 * isolation), this file does not invent one. Flagged explicitly in this
 * file's own report to the orchestrator, who owns deciding whether a
 * follow-up scenario/task is needed, rather than silently treating sign-up
 * as either covered or out of scope.
 *
 * ## Why `auth.handler(new Request(...))`, not `auth.api.signInEmail`
 *
 * Same reasoning as `pre-auth-rate-limit.int.test.ts` (task 2.5): `apps/api`
 * (group 11) does not exist yet, so this file drives the production
 * `createAuth` instance directly, in-process, through its real HTTP entry
 * point. `auth.api.signInEmail` bypasses `auth.handler`'s router entirely
 * (verified against the installed `better-auth@1.7.6` source: `auth.api.*`
 * invokes the endpoint function directly, never through the router's
 * `onRequest` stage), so it would not exercise task 2.5's already-green
 * pre-authentication rate limiter the way a real HTTP request does -- this
 * file needs that real path exercised (see the next section) even though it
 * is not the thing under test here.
 *
 * ## Why a fresh random IP per request, and a generous configured rate limit
 *
 * Task 2.5 (already green) added a pre-authentication rate limiter
 * (`./rate-limit/pre-auth-rate-limit.ts`) keyed by both the caller's IP and
 * the normalized submitted email on `/sign-in/email`. If every sign-in
 * attempt in this file shared one IP, a later attempt could observe `429
 * AUTH_RATE_LIMITED` instead of the `INVALID_EMAIL_OR_PASSWORD` comparison
 * this file actually tests -- an unrelated failure mode this file must not
 * depend on triggering *or* avoiding by accident. Every request below
 * therefore carries its own fresh, random `x-forwarded-for` IP (the design's
 * own `getIP`/`ipAddressHeaders` mechanism, same as
 * `pre-auth-rate-limit.int.test.ts`'s own `randomIp()`), and `createAuth` is
 * additionally configured with a deliberately generous `rateLimit.signIn`
 * limit (`window: 60, max: 1000`) as a second, independent guard against the
 * same interference -- belt and suspenders, not required by either measure
 * alone.
 *
 * ## Why this file compares normalized (parsed) bodies, not raw text or status alone
 *
 * The scenario's THEN clause makes three independent claims -- "the same
 * status, error code, and body shape" -- not just "both attempts fail."
 * Comparing `response.status` alone would still pass even if the two bodies
 * differed (for example, one response echoing the submitted email back: the
 * literal enumeration leak this requirement exists to prevent). This file
 * parses each response's JSON body and asserts deep equality between the
 * two parsed objects (not raw response text, which could differ only in
 * insignificant whitespace/key order and still represent the "same" body),
 * in addition to asserting both responses are non-2xx failures -- so a
 * (wrong) implementation where both calls trivially returned an identical
 * `200` success body (which would also make the bodies "equal" without ever
 * proving enumeration resistance) is still caught.
 *
 * ## Why this is expected to already pass, not fail, right now
 *
 * `./auth.ts` (tasks 2.1-2.5) never wires a bespoke "same response for
 * unknown account vs. wrong password" behavior of its own -- that identical
 * response already comes from Better Auth's own `/sign-in/email` route
 * (verified against the installed source, `dist/api/routes/sign-in.mjs`):
 * both "no user found for this email" and "password does not match" throw
 * the textually identical `APIError.from("UNAUTHORIZED",
 * BASE_ERROR_CODES.INVALID_EMAIL_OR_PASSWORD)`, which `better-call`'s own
 * `toResponse` (verified against the installed `better-call@1.4.0` source,
 * `dist/to-response.mjs`) turns into the same `401` status and the same
 * `{ message: "Invalid email or password", code: "INVALID_EMAIL_OR_PASSWORD" }`
 * JSON body for both cases, with no per-request field (no cookie is set on
 * either failure path, since session creation happens only after both
 * checks succeed). So this scenario is expected to **already pass** against
 * the current, task-2.5-green `./auth.ts`, with no production change needed
 * for task 2.6's own Verify clause -- reported explicitly to the
 * orchestrator below rather than forcing an artificial failure, per this
 * assignment's own instructions ("if they already pass ... report that
 * clearly instead of forcing a failure").
 *
 * ## Why this test connects, seeds and asserts the way it does
 *
 * Same shared-`DATABASE_URL` / `runMigrations`-then-`randomUUID()`-per-test
 * isolation pattern every other int test file in `@tayzu/auth` already
 * establishes (`auth-flow.int.test.ts`, `pre-auth-rate-limit.int.test.ts`),
 * and the same `drizzle(url, { schema: authSchema })` handle those files use
 * (`@better-auth/drizzle-adapter`'s model resolution needs the Drizzle
 * instance to have been constructed with that schema).
 */
import { randomInt, randomUUID } from 'node:crypto';

import { runMigrations } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Import order is load-bearing (task 2.4; design D1; `packages/observability/
// CLAUDE.md`, "Import order"): the harness must register before `./auth.js`,
// which imports a telemetry/instruments module that creates its tracer,
// meter and logger at import time. Same rationale as
// `auth-flow.int.test.ts`'s and `pre-auth-rate-limit.int.test.ts`'s
// identical import-order comments, even though this file asserts no
// telemetry itself: an unregistered harness would make `./auth.js`'s own
// instruments permanent no-ops for every other test file sharing the module
// graph within the same worker.
import { createAdminUser } from './__fixtures__/admin-user.js';
import './__fixtures__/registered-harness.js';
import { createAuth, type AuthInstance, type CreateAuthOptions } from './auth.js';
import * as authSchema from './persistence/schema.js';
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

/** A password long enough for Better Auth's default 8-character minimum. */
const TEST_PASSWORD = 'correct horse battery staple';
const WRONG_PASSWORD = 'definitely the wrong password, not correct';

/**
 * Deliberately generous (module doc comment, "Why a fresh random IP per
 * request, and a generous configured rate limit"): large enough that no
 * request this file makes could ever hit it, even combined with the
 * per-request fresh IP already isolating every call into its own bucket.
 */
const SIGN_IN_RATE_LIMIT_WINDOW_SECONDS = 60;
const SIGN_IN_RATE_LIMIT_MAX = 1000;

/** `./auth.ts`'s `AuthInstance.api` is typed `unknown`; `.handler` is Better Auth's real, documented HTTP entry point, not otherwise exposed on `AuthInstance` yet. Same pattern `pre-auth-rate-limit.int.test.ts`'s own `handlerOf` establishes. */
function handlerOf(auth: AuthInstance): (request: Request) => Promise<Response> {
  return (auth as unknown as { handler: (request: Request) => Promise<Response> }).handler;
}

const SIGN_IN_URL = 'http://localhost:3000/api/auth/sign-in/email';

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

function randomEmail(): string {
  return `enum-${randomUUID()}@example.test`;
}

interface SignInAttempt {
  readonly ip: string;
  readonly email: string;
  readonly password: string;
}

function postSignIn(
  handler: (request: Request) => Promise<Response>,
  attempt: SignInAttempt,
): Promise<Response> {
  return handler(
    new Request(SIGN_IN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': attempt.ip,
      },
      body: JSON.stringify({ email: attempt.email, password: attempt.password }),
    }),
  );
}

interface AuthErrorBody {
  readonly code?: string;
  readonly message?: string;
}

describe('Enumeration resistance: sign-in failure status/error-code/body-shape parity (task 2.6, spec "Authentication responses resist account enumeration")', () => {
  let db: TestDb;
  let auth: AuthInstance;

  beforeAll(async () => {
    db = connect(databaseUrl());
    await runMigrations(db.$client);
    const options: CreateAuthOptions = {
      db,
      secret: TEST_SECRET,
      rateLimit: {
        signIn: {
          window: SIGN_IN_RATE_LIMIT_WINDOW_SECONDS,
          max: SIGN_IN_RATE_LIMIT_MAX,
        },
      },
    };
    auth = createAuth(options);
  }, 60_000);

  afterAll(async () => {
    await endQuietly(db.$client);
  });

  it('Sign-in failure looks the same for an unknown account and a wrong password (spec scenario)', async () => {
    const handler = handlerOf(auth);

    // GIVEN ... one email with an account and a known password. Task 18.1
    // (design D22): no self-service sign-up left to exercise -- the
    // admin-creation path (`./__fixtures__/admin-user.js`'s
    // `createAdminUser`, `auth.api.createUser`) is what now creates the
    // known account; it throws if creation fails, so no separate "setup
    // succeeded" assertion is needed (same pattern `auth-flow.int.test.ts`'s
    // migrated fixtures already establish).
    const knownEmail = randomEmail();
    await createAdminUser(auth, {
      name: 'Enumeration Resistance Test User',
      email: knownEmail,
      password: TEST_PASSWORD,
    });

    // GIVEN ... one email with no account.
    const unknownEmail = randomEmail();

    // WHEN sign-in is attempted for the first with any password ...
    const unknownAccountResponse = await postSignIn(handler, {
      ip: randomIp(),
      email: unknownEmail,
      password: 'any password whatsoever, this account was never created',
    });

    // ... and for the second with the wrong password.
    const wrongPasswordResponse = await postSignIn(handler, {
      ip: randomIp(),
      email: knownEmail,
      password: WRONG_PASSWORD,
    });

    // THEN both attempts fail (neither reveals account existence by
    // trivially succeeding) ...
    expect(
      unknownAccountResponse.status,
      'the unknown-account sign-in attempt fails, it does not succeed',
    ).not.toBe(200);
    expect(
      wrongPasswordResponse.status,
      'the wrong-password sign-in attempt fails, it does not succeed',
    ).not.toBe(200);

    // ... with the same status ...
    expect(
      unknownAccountResponse.status,
      'both failed sign-in attempts return the identical HTTP status',
    ).toBe(wrongPasswordResponse.status);

    // ... the same error code, and the same body shape: compare normalized
    // (parsed) bodies against each other, not raw response text and not
    // status alone (module doc comment, "Why this file compares normalized
    // bodies").
    const unknownAccountBody = (await unknownAccountResponse.json()) as AuthErrorBody;
    const wrongPasswordBody = (await wrongPasswordResponse.json()) as AuthErrorBody;

    expect(
      typeof unknownAccountBody.code,
      'the unknown-account failure body carries a string error code',
    ).toBe('string');
    expect(
      unknownAccountBody.code,
      'the error code is a real value, not an empty placeholder',
    ).not.toBe('');

    expect(
      wrongPasswordBody,
      'both failed sign-in attempts return the identical, parsed response body (same error code, same body shape)',
    ).toEqual(unknownAccountBody);
  });
});
