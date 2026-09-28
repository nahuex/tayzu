/**
 * Integration test for task 3.2 (design D3;
 * `specs/auth-and-rbac/spec.md`, "Session policy").
 *
 * "A 12-hour idle timeout layered on top of Better Auth's own 7-day
 * `expiresIn`/1-day `updateAge`." This file covers exactly the two scenarios
 * task 3.2's own Verify clause names, quoted from
 * `specs/auth-and-rbac/spec.md`:
 *
 * #### Scenario: Idle session expires after 12 hours
 * - GIVEN a session last used 13 hours ago, within its 7-day window
 * - WHEN it is used again
 * - THEN it fails exactly as `CATALOG_CONTEXT_REQUIRED`
 *
 * #### Scenario: Active session rolls forward up to 7 days
 * - GIVEN a session used every day for 10 days
 * - WHEN it is used on day 10
 * - THEN it is still valid
 *
 * The requirement text above the scenarios (same spec section) is the source
 * for the 12-hour figure and the "whichever limit is reached first" framing:
 * "A session MUST expire 7 days after its last use and MUST roll forward on
 * use, up to that 7-day cap. It MUST additionally expire after 12 hours of
 * inactivity, whichever limit is reached first." Design D3 names the exact
 * mechanism this file drives state through directly: "every session row's
 * `updatedAt` is checked against 'now' on each use; a session whose last use
 * exceeds 12 hours is treated as expired even though Better Auth's own
 * `expiresIn` has not elapsed." The third scenario in this requirement,
 * "Password change revokes other sessions", is task 3.3's own Verify-named
 * scenario, not this one's, and is not covered here.
 *
 * ## Module under test
 *
 * `./context-resolver.ts` (task 3.1, already green): its session-cookie
 * branch is where design D3 says the 12-hour check belongs -- it is the
 * function called "on each use" (`resolveContext(headers)`, `tasks.md`'s own
 * call-site spelling), and it already independently rejects a missing
 * session or a session with no active organization with the identical
 * `CATALOG_CONTEXT_REQUIRED` shape this file asserts against
 * (`context-resolver.int.test.ts`, task 3.1). This file assumes task 3.2's
 * green phase extends `createContextResolver`'s returned function with the
 * idle check, not a new, separately-imported function: nothing in `tasks.md`
 * or the design names a second entry point, and the design's own "checked...
 * on each use" phrasing describes a check performed as part of resolving a
 * context, not a standalone helper called elsewhere. Flagged here, per this
 * assignment's own instructions, in case task 3.2's green phase settles on a
 * different shape -- the scenario coverage below does not depend on which
 * shape wins, only the `resolveContext(new Headers({ cookie }))` call sites
 * below would need to change.
 *
 * ## Why "GIVEN a session last used 13 hours ago" is set up via direct SQL
 *
 * There is no way to make 13 real hours pass inside a test. Every other int
 * test file in this package that needs a real session cookie signs one up
 * through `auth.handler(new Request(...))` (`context-resolver.int.test.ts`'s
 * own module doc comment explains why: `auth.api.signUpEmail`/`signInEmail`
 * never produce an HTTP `Response`, so there is no `Set-Cookie` header to read
 * back). This file does the same, then reaches directly into `auth.session`
 * (`./persistence/schema.ts`) through the same `db.execute(sql\`...\`)`
 * pattern `context-resolver.int.test.ts`'s own `findSessionByToken` already
 * establishes, and overwrites `updated_at`/`expires_at` (and, for the second
 * scenario, `created_at`) to the exact timestamps the GIVEN clause describes,
 * relative to the real wall-clock "now" `resolveContext` itself will see when
 * it runs moments later. `expires_at` is always set far enough in the future
 * in both scenarios that Better Auth's own, already-correct `expiresAt < now`
 * check (`dist/api/routes/session.mjs`, verified against the installed
 * `better-auth@1.7.6` source) never itself rejects the session -- the only
 * question either scenario probes is what the *new*, task-3.2 idle check does
 * with a stale-but-not-yet-expired `updated_at`.
 *
 * ## Why the second scenario is set up as one direct state, not a 10-call loop
 *
 * The GIVEN clause's "used every day for 10 days" describes history, not a
 * sequence this test needs to replay call by call: only the *state* the
 * session is in at the moment of the WHEN ("it is used on day 10") decides
 * the THEN. A user "used every day" necessarily touches the session more than
 * once every 24 hours (a single once-a-day touch, spaced a full 24 hours
 * apart, would itself exceed the 12-hour idle threshold this same
 * requirement sets -- the two clauses of the requirement are only jointly
 * satisfiable if "used every day" means multiple touches within each day, no
 * single gap ever reaching 12 hours). This file represents the state right
 * before that WHEN with `created_at` ten days in the past (so a policy that
 * incorrectly measures idleness from *creation* rather than *last use* would
 * fail this test -- exactly the bug design D3's "checked against... on each
 * use", not "since creation", phrasing rules out) and `updated_at` a few
 * hours in the past (comfortably under the 12-hour threshold, standing in for
 * "last touched earlier today, as part of day 10's continued use"), with
 * `expires_at` recomputed as `updated_at + 7 days` -- the same rolling
 * relationship Better Auth's own `updateAge`-driven refresh already produces
 * on a session kept in continuous use (design D3: "kept, this is the
 * rolling-refresh granularity"), so this state is reachable by exactly the
 * kind of repeated, same-day-spanning use the GIVEN clause describes, without
 * this file needing to depend on the precise cadence of Better Auth's own
 * internal refresh trigger to construct it.
 *
 * ## Why this is expected to fail for the right reason right now
 *
 * `./context-resolver.ts`'s session-cookie branch (task 3.1, already green)
 * has exactly two rejection paths -- no session, and no active organization
 * -- and no idle-timeout check at all yet (confirmed by reading the file
 * before writing this one): nothing on the path this file exercises reads
 * `updated_at` or compares it to "now". So the first scenario below is
 * expected to fail as a plain **assertion failure**: `resolveContext`
 * resolves the stale session successfully instead of rejecting it, because
 * the 12-hour check task 3.2 adds does not exist yet. This is not a missing
 * export or a typo -- `./context-resolver.js`, `./auth.js` and every other
 * import below already exist and are exercised unchanged by
 * `context-resolver.int.test.ts` in this same package.
 *
 * The second scenario is expected to **already pass**, unmodified, against
 * today's code: with no idle-timeout check on this path yet, and with
 * `expires_at` set (by this file) to a valid future timestamp, nothing
 * currently rejects a session whose `created_at` is old but whose
 * `updated_at` is recent. Per this assignment's own instructions, that is
 * reported here as an already-green scenario rather than forced to fail --
 * task 3.2's green phase must keep it green (a correct idle-timeout
 * implementation, keyed off `updated_at` rather than `created_at`, does not
 * change this outcome), and this test guards exactly that non-regression.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { runMigrations } from '@tayzu/db';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Import order is load-bearing (task 2.4; design D1; `packages/observability/
// CLAUDE.md`, "Import order"): the harness must register before `./auth.js`,
// which imports a telemetry/instruments module that creates its tracer,
// meter and logger at import time. Same rationale as every other int test
// file in this package (for example `context-resolver.int.test.ts`'s own
// identical import-order comment), even though this file asserts no
// telemetry itself.
import './__fixtures__/registered-harness.js';
import { createAuth, type AuthInstance } from './auth.js';
import { createContextResolver, type ContextResolver } from './context-resolver.js';
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

function randomEmail(): string {
  return `session-policy-${randomUUID()}@example.test`;
}

function randomSlug(): string {
  return `session-policy-org-${randomUUID()}`;
}

/** A password long enough for Better Auth's default 8-character minimum. */
const TEST_PASSWORD = 'correct horse battery staple';
const TEST_SECRET = 'int-test-only-secret-not-used-for-anything-real-0123456789';
const TEST_USER_NAME = 'Session Policy Test User';

const AUTH_BASE_URL = 'http://localhost:3000/api/auth';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * `./auth.ts`'s `AuthInstance.api` is typed `unknown`; `.handler` is Better
 * Auth's real, documented HTTP entry point, not otherwise exposed on
 * `AuthInstance` yet -- same cast `context-resolver.int.test.ts`'s own
 * `handlerOf` already uses.
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
 * creation only -- sign-up/sign-in go through `auth.handler` instead), typed
 * locally the same way `context-resolver.int.test.ts`'s own `AuthApiSurface`
 * is.
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
  ip: string,
): Promise<Response> {
  return handler(
    new Request(`${AUTH_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': ip,
      },
      body: JSON.stringify(body),
    }),
  );
}

interface SignUpEmailResponseBody {
  readonly token: string | null;
  readonly user: { readonly id: string; readonly email: string };
}

interface SignInEmailResponseBody {
  readonly token: string | null;
  readonly user: { readonly id: string; readonly email: string };
}

/**
 * A real `cookie` header value built from a Better Auth HTTP response's own
 * `Set-Cookie` header(s) -- same helper as `context-resolver.int.test.ts`'s
 * own `cookieHeaderFrom`.
 */
function cookieHeaderFrom(response: Response): string {
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length === 0) {
    throw new Error('expected response to carry at least one Set-Cookie header');
  }
  return setCookies.map((raw) => raw.split(';')[0]).join('; ');
}

type SessionTimestampRow = {
  readonly updated_at: string;
  readonly expires_at: string;
};

/**
 * Overwrites the timestamps of the `auth.session` row named by `token`,
 * standing in for real elapsed time (see this file's own module doc
 * comment, "Why 'GIVEN a session last used 13 hours ago' is set up via
 * direct SQL"). `createdAt` is optional: the first scenario never needs to
 * move it, only the second does.
 */
async function setSessionTimestamps(
  db: TestDb,
  token: string,
  params: { readonly updatedAt: Date; readonly expiresAt: Date; readonly createdAt?: Date },
): Promise<void> {
  if (params.createdAt !== undefined) {
    await db.execute(sql`
      update auth.session
      set updated_at = ${params.updatedAt}, expires_at = ${params.expiresAt}, created_at = ${params.createdAt}
      where token = ${token}
    `);
    return;
  }
  await db.execute(sql`
    update auth.session
    set updated_at = ${params.updatedAt}, expires_at = ${params.expiresAt}
    where token = ${token}
  `);
}

async function readSessionTimestamps(db: TestDb, token: string): Promise<SessionTimestampRow> {
  const result = await db.execute<SessionTimestampRow>(sql`
    select updated_at, expires_at from auth.session where token = ${token}
  `);
  const [row] = result.rows;
  if (row === undefined) {
    throw new Error(`expected a session row for token ${token}`);
  }
  return row;
}

/**
 * "fails exactly as `CATALOG_CONTEXT_REQUIRED`" -- same structural,
 * `@tayzu/catalog`-import-free assertion `context-resolver.int.test.ts`'s
 * own `expectContextRequiredRejection` already establishes and explains.
 */
async function expectContextRequiredRejection(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code: 'CATALOG_CONTEXT_REQUIRED' });
}

describe('resolveContext: 12-hour idle timeout (task 3.2, design D3)', () => {
  let db: TestDb;
  let auth: AuthInstance;
  let resolveContext: ContextResolver;

  beforeAll(async () => {
    db = connect(databaseUrl());
    await runMigrations(db.$client);
    auth = createAuth({ db, secret: TEST_SECRET });
    resolveContext = createContextResolver({ auth });
  }, 60_000);

  afterAll(async () => {
    await endQuietly(db.$client);
  });

  /**
   * Signs a fresh user up, gives them a single organization membership, then
   * signs in again so the returned session already carries that
   * organization as its `activeOrganizationId` (task 2.4's own,
   * already-green exactly-one-membership rule -- the same two-step "sign up,
   * create org, sign in again" sequence `context-resolver.int.test.ts`'s own
   * first scenario uses, and for the same reason: the sign-up session is
   * created before the membership row exists, so only the *second* session
   * gets an active organization).
   */
  async function signUpWithOrganization(): Promise<{
    readonly cookie: string;
    readonly token: string;
    readonly userId: string;
    readonly organizationId: string;
  }> {
    const handler = handlerOf(auth);
    const email = randomEmail();
    const slug = randomSlug();

    const signUpResponse = await postJson(
      handler,
      '/sign-up/email',
      { name: TEST_USER_NAME, email, password: TEST_PASSWORD },
      randomIp(),
    );
    expect(signUpResponse.status, 'sign-up succeeds').toBe(200);
    const signUp = (await signUpResponse.json()) as SignUpEmailResponseBody;

    const organization = await apiOf(auth).createOrganization({
      body: { name: 'Session Policy Test Org', slug, userId: signUp.user.id },
    });

    const signInResponse = await postJson(
      handler,
      '/sign-in/email',
      { email, password: TEST_PASSWORD },
      randomIp(),
    );
    expect(signInResponse.status, 'sign-in succeeds').toBe(200);
    const signIn = (await signInResponse.json()) as SignInEmailResponseBody;

    return {
      cookie: cookieHeaderFrom(signInResponse),
      token: String(signIn.token),
      userId: signUp.user.id,
      organizationId: organization.id,
    };
  }

  it('Idle session expires after 12 hours', async () => {
    const session = await signUpWithOrganization();

    // GIVEN "a session last used 13 hours ago, within its 7-day window":
    // `updated_at` is moved 13 hours into the past, and `expires_at` is left
    // comfortably valid (6 days out) so Better Auth's own `expiresAt < now`
    // check has no independent reason to reject this session -- the only
    // question is what the 12-hour idle check does.
    const now = Date.now();
    await setSessionTimestamps(db, session.token, {
      updatedAt: new Date(now - 13 * HOUR_MS),
      expiresAt: new Date(now + 6 * DAY_MS),
    });

    // GIVEN sanity check: the manipulated row really is 13 hours stale and
    // still within its (Better-Auth-level) 7-day window, independent of
    // whatever `resolveContext` itself does with it.
    const stored = await readSessionTimestamps(db, session.token);
    expect(
      now - new Date(stored.updated_at).getTime(),
      'the session was last used at least 13 hours ago',
    ).toBeGreaterThanOrEqual(13 * HOUR_MS - 1000);
    expect(
      new Date(stored.expires_at).getTime(),
      "the session's own expires_at has not yet elapsed",
    ).toBeGreaterThan(now);

    // WHEN "it is used again".
    await expectContextRequiredRejection(resolveContext(new Headers({ cookie: session.cookie })));
  });

  it('Active session rolls forward up to 7 days', async () => {
    const session = await signUpWithOrganization();

    // GIVEN "a session used every day for 10 days": `created_at` is moved
    // ten days into the past (so a check that measures idleness from
    // creation, rather than from last use, would wrongly reject this
    // session -- see this file's own module doc comment for why that
    // distinction is exactly what this scenario probes), while `updated_at`
    // is only a few hours old and `expires_at` is recomputed as
    // `updated_at + 7 days` -- the same relationship Better Auth's own
    // `updateAge`-driven refresh produces on a session kept in continuous
    // use, standing in for "last touched a few hours ago, as part of day
    // 10's continued use".
    const now = Date.now();
    const updatedAt = new Date(now - 6 * HOUR_MS);
    const expiresAt = new Date(updatedAt.getTime() + 7 * DAY_MS);
    await setSessionTimestamps(db, session.token, {
      createdAt: new Date(now - 10 * DAY_MS),
      updatedAt,
      expiresAt,
    });

    // GIVEN sanity check: the manipulated row really is old-but-recently-used,
    // independent of whatever `resolveContext` itself does with it.
    const stored = await readSessionTimestamps(db, session.token);
    expect(
      now - new Date(stored.updated_at).getTime(),
      'the session was last used a few hours ago, well under the 12-hour threshold',
    ).toBeLessThan(12 * HOUR_MS);
    expect(
      new Date(stored.expires_at).getTime(),
      "the session's own expires_at has not yet elapsed",
    ).toBeGreaterThan(now);

    // WHEN "it is used on day 10".
    const resolved = await resolveContext(new Headers({ cookie: session.cookie }));

    // THEN "it is still valid": resolution succeeds with the same shape the
    // session-cookie branch always produces (task 3.1, design D3),
    // unaffected by the session's ten-day-old `created_at`.
    expect(resolved).toEqual({
      tenantId: session.organizationId,
      actor: { type: 'user', id: session.userId },
    });
  });
});
