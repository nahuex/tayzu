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

import { SeverityNumber, type AnyValueMap } from '@opentelemetry/api-logs';
import { runMigrations } from '@tayzu/db';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
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
import { registration, type TelemetryTestHarness } from './__fixtures__/registered-harness.js';
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

/**
 * Task 13.4b (design D13, Resolved decisions Q54 and Q97, VCDM G3). Spec
 * scenario: "A disabled user's sessions stop working" (`specs/
 * identity-lifecycle-and-org-admin/spec.md`): "a new sign-in (local or SSO) is
 * refused"; the uniformity is `002`'s "Sign-in failures are identical" rule.
 *
 * GIVEN a banned user with the correct password, a user with a wrong password
 * and an unknown email, WHEN each signs in through `auth.handler`, THEN the
 * three responses have the same status, error code and body, no session row
 * exists for the banned user, and `auth.security.login_failed` carries
 * `account_disabled` for the banned attempt and `bad_credentials` for the wrong
 * password. The timing is not asserted.
 *
 * ## Production symbols expected
 *
 * None new: a `hooks.after` on `/sign-in/email` in `auth.ts` that returns a
 * `Response` equal to the wrong password's, and a login_failed emitter that
 * accepts the reason `account_disabled`.
 */
describe('A banned user signs in exactly like any other failure (task 13.4b, D13, Q54)', () => {
  let db: TestDb;
  let auth: AuthInstance;
  let harness: TelemetryTestHarness;

  beforeAll(async () => {
    db = connect(databaseUrl());
    await runMigrations(db.$client);
    auth = createAuth({
      db,
      secret: TEST_SECRET,
      rateLimit: {
        signIn: { window: SIGN_IN_RATE_LIMIT_WINDOW_SECONDS, max: SIGN_IN_RATE_LIMIT_MAX },
      },
    });
    if ('error' in registration) {
      throw new Error('createTelemetryTestHarness() failed while the module graph loaded', {
        cause: registration.error,
      });
    }
    harness = registration.harness;
  }, 60_000);

  afterAll(async () => {
    await endQuietly(db.$client);
  });

  async function loginFailedReasons(): Promise<
    { severity: SeverityNumber | undefined; attributes: AnyValueMap }[]
  > {
    await harness.forceFlush();
    return [...harness.logExporter.getFinishedLogRecords()]
      .filter((record) => record.eventName === 'auth.security.login_failed')
      .map((record) => ({ severity: record.severityNumber, attributes: record.attributes }));
  }

  it('A banned user with the correct password, a wrong password and an unknown email get the same status, error code and body, with no session for the banned user', async () => {
    const handler = handlerOf(auth);
    const bannedEmail = randomEmail();
    const wrongEmail = randomEmail();
    const unknownEmail = randomEmail();
    const banned = await createAdminUser(auth, {
      name: 'Banned Enumeration User',
      email: bannedEmail,
      password: TEST_PASSWORD,
    });
    await createAdminUser(auth, {
      name: 'Wrong Password Enumeration User',
      email: wrongEmail,
      password: TEST_PASSWORD,
    });
    await db.execute(sql`update auth."user" set banned = true where id = ${banned.userId}`);

    await harness.reset();
    const bannedResponse = await postSignIn(handler, {
      ip: randomIp(),
      email: bannedEmail,
      password: TEST_PASSWORD,
    });
    const bannedLogs = await loginFailedReasons();

    await harness.reset();
    const wrongResponse = await postSignIn(handler, {
      ip: randomIp(),
      email: wrongEmail,
      password: WRONG_PASSWORD,
    });
    const wrongLogs = await loginFailedReasons();

    const unknownResponse = await postSignIn(handler, {
      ip: randomIp(),
      email: unknownEmail,
      password: TEST_PASSWORD,
    });

    expect(wrongResponse.status, 'control: a wrong password is a failure').toBeGreaterThanOrEqual(
      400,
    );
    expect(bannedResponse.status, 'the response status itself equals the wrong password').toBe(
      wrongResponse.status,
    );
    expect(unknownResponse.status).toBe(wrongResponse.status);

    const wrongBody = (await wrongResponse.json()) as AuthErrorBody;
    expect(typeof wrongBody.code).toBe('string');
    expect(await bannedResponse.json(), 'same error code and body').toEqual(wrongBody);
    expect(await unknownResponse.json()).toEqual(wrongBody);
    expect(
      bannedResponse.headers.getSetCookie().some((c) => c.includes('session_token')),
      'no session cookie',
    ).toBe(false);

    const sessions = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from auth.session where user_id = ${banned.userId}`,
    );
    expect(Number(sessions.rows[0]?.n ?? -1), 'no session row for the banned user').toBe(0);

    expect(bannedLogs, 'exactly one login_failed for the banned attempt').toHaveLength(1);
    expect(bannedLogs[0]?.severity).toBe(SeverityNumber.WARN);
    expect(bannedLogs[0]?.attributes).toEqual({ 'tayzu.auth.failure_reason': 'account_disabled' });
    expect(wrongLogs).toHaveLength(1);
    expect(wrongLogs[0]?.attributes).toEqual({ 'tayzu.auth.failure_reason': 'bad_credentials' });
  }, 60_000);
});

/**
 * Task 8.13 (044 design D7, Q28). Spec scenario "The sign-in fence does not reveal an account":
 * GIVEN an address with a password and an address with no account, WHEN each is submitted to the
 * sign-in route, THEN both answers have the same status, code and body shape, and the fence
 * performs the same single credential lookup for each.
 *
 * The counting adapter is a wrapper on the Postgres pool of the Drizzle handle. A credential-hash
 * lookup is a SELECT on `"auth"."account"` that binds the provider id `credential`; Better Auth's
 * own reads of a user's accounts filter by user id only, so they do not count. Both attempts use a
 * wrong password, so the only lookup is the fence's `hooks.before` one.
 *
 * ## Production symbols expected
 *
 * None new: the `hooks.before` lookup on `/sign-in/email` in `auth.ts`.
 */
describe('The sign-in fence does not reveal an account (task 8.13, D7, Q28)', () => {
  let pool: Pool;
  let auth: AuthInstance;
  let db: ReturnType<typeof drizzle<typeof authSchema>>;
  let statements: { text: string; values: readonly unknown[] }[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl() });
    const originalQuery = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;
    (pool as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = (
      ...args: unknown[]
    ): Promise<unknown> => {
      const first = args[0];
      const text =
        typeof first === 'string' ? first : ((first as { text?: string } | undefined)?.text ?? '');
      const values =
        (Array.isArray(args[1]) ? (args[1] as unknown[]) : undefined) ??
        (first as { values?: unknown[] } | undefined)?.values ??
        [];
      statements.push({ text, values });
      return originalQuery(...args);
    };
    db = drizzle(pool, { schema: authSchema });
    await runMigrations(pool);
    auth = createAuth({
      db,
      secret: TEST_SECRET,
      rateLimit: {
        signIn: { window: SIGN_IN_RATE_LIMIT_WINDOW_SECONDS, max: SIGN_IN_RATE_LIMIT_MAX },
      },
    });
  }, 60_000);

  afterAll(async () => {
    await endQuietly(pool);
  });

  function credentialLookups(): number {
    return statements.filter(
      (s) =>
        /^\s*select/i.test(s.text) &&
        s.text.includes('"auth"."account"') &&
        s.values.includes('credential'),
    ).length;
  }

  it('a known and an unknown address answer sign-in with the same status, code and body shape, and one credential-hash lookup each', async () => {
    const handler = handlerOf(auth);
    const knownEmail = randomEmail();
    await createAdminUser(auth, {
      name: 'Fence Enumeration User',
      email: knownEmail,
      password: TEST_PASSWORD,
    });
    const unknownEmail = randomEmail();

    statements = [];
    const knownResponse = await postSignIn(handler, {
      ip: randomIp(),
      email: knownEmail,
      password: WRONG_PASSWORD,
    });
    const knownLookups = credentialLookups();

    statements = [];
    const unknownResponse = await postSignIn(handler, {
      ip: randomIp(),
      email: unknownEmail,
      password: WRONG_PASSWORD,
    });
    const unknownLookups = credentialLookups();

    expect(knownResponse.status, 'control: a wrong password is a failure').toBeGreaterThanOrEqual(
      400,
    );
    expect(unknownResponse.status, 'same status').toBe(knownResponse.status);
    const knownBody = (await knownResponse.json()) as AuthErrorBody;
    expect(typeof knownBody.code).toBe('string');
    expect(await unknownResponse.json(), 'same code and body shape').toEqual(knownBody);

    expect(knownLookups, 'one credential-hash lookup for the known address').toBe(1);
    expect(unknownLookups, 'one credential-hash lookup for the unknown address').toBe(1);
  }, 60_000);
});
