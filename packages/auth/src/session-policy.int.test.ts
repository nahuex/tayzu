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

import { SeverityNumber } from '@opentelemetry/api-logs';
import { runMigrations } from '@tayzu/db';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// Import order is load-bearing (task 2.4; design D1; `packages/observability/
// CLAUDE.md`, "Import order"): the harness must register before `./auth.js`,
// which imports a telemetry/instruments module that creates its tracer,
// meter and logger at import time. Same rationale as every other int test
// file in this package (for example `context-resolver.int.test.ts`'s own
// identical import-order comment). Task 3.2's own describe block below
// asserts no telemetry itself; task 3.3's describe block (this file's
// second one, added for task 3.3) does, so the named `registration`/
// `TelemetryTestHarness` bindings are imported here too, alongside the
// side-effecting registration import every other describe block in this
// file already relies on.
import { bootstrapTestTenant, createAdminUser } from './__fixtures__/admin-user.js';
import { registration, type TelemetryTestHarness } from './__fixtures__/registered-harness.js';
import { createAuth, type AuthInstance } from './auth.js';
import { createContextResolver, type ContextResolver } from './context-resolver.js';
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
  let appPool: TestDb['$client'];

  beforeAll(async () => {
    db = connect(databaseUrl());
    await runMigrations(db.$client);
    auth = createAuth({ db, secret: TEST_SECRET });
    appPool = connect(databaseUrl()).$client;
    appPool.on('connect', (client) => {
      void client.query('SET ROLE tayzu_app');
    });
    resolveContext = createContextResolver({ auth, revocationPool: appPool });
  }, 60_000);

  afterAll(async () => {
    await endQuietly(appPool);
    await endQuietly(db.$client);
  });

  /**
   * Task 18.1 (design D22): creates a user through the admin-creation path
   * (`./__fixtures__/admin-user.js`'s `bootstrapTestTenant`) instead of
   * Better Auth's own `/sign-up/email` route, gives them a single
   * organization membership, then signs them in so the returned session
   * already carries that organization as its `activeOrganizationId` (task
   * 2.4's own, already-green exactly-one-membership rule) -- the membership
   * row exists before `bootstrapTestTenant`'s own, single sign-in call, so
   * that one session already gets an active organization.
   */
  async function signUpWithOrganization(): Promise<{
    readonly cookie: string;
    readonly token: string;
    readonly userId: string;
    readonly organizationId: string;
  }> {
    const tenant = await bootstrapTestTenant(auth, {
      name: TEST_USER_NAME,
      email: randomEmail(),
      password: TEST_PASSWORD,
      organizationName: 'Session Policy Test Org',
      organizationSlug: randomSlug(),
      ip: randomIp(),
    });

    return {
      cookie: tenant.cookie,
      token: tenant.token,
      userId: tenant.userId,
      organizationId: tenant.organizationId,
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
      // Task 9.5, Q26: the organization creator is the `owner` -> `admin`.
      principal: { roles: ['admin'], teams: [], moderatedBlueprints: [] },
    });
  });
});

/**
 * Integration test for task 3.3 (design D3; `specs/auth-and-rbac/spec.md`,
 * "Session policy"). "`changePassword` called with `revokeOtherSessions:
 * true`." This describe block covers exactly the one scenario task 3.3's own
 * Verify clause names, quoted from `specs/auth-and-rbac/spec.md`:
 *
 * #### Scenario: Password change revokes other sessions
 * - GIVEN a user signed in on two devices
 * - WHEN they change their password from the first device
 * - THEN the second device's session fails exactly as `CATALOG_CONTEXT_REQUIRED`
 *   on its next use
 *
 * plus the same Verify clause's "the resulting `auth.security.session_revoked`
 * log event" (design.md, "Observability contract" -> Log events table:
 * `auth.security.session_revoked`, INFO, `tayzu.tenant.id`,
 * `tayzu.actor.id`, `tayzu.auth.revocation.reason`
 * (`password_change`\|`admin_action`)).
 *
 * The requirement text above the scenario (same spec section) is this
 * behavior's source: "A password change MUST revoke every other active
 * session belonging to that user." Design D3 names the exact mechanism:
 * "`changePassword` is called with `revokeOtherSessions: true`" -- read
 * together with the requirement's "MUST revoke every *other* active
 * session" (not "every session the caller happens to ask about"), this is
 * production code's own responsibility, not something left to whichever
 * caller happens to invoke `changePassword`. That is exactly what this test
 * drives: the WHEN step below calls Better Auth's `changePassword` endpoint
 * *without* passing `revokeOtherSessions` itself, so the only way the THEN
 * step can observe the second device's session revoked is if `./auth.ts`'s
 * own `createAuth` configuration forces `revokeOtherSessions: true` on every
 * `changePassword` call, exactly as D3 states.
 *
 * ## Why this is expected to fail for the right reason right now
 *
 * `./auth.ts` (tasks 2.1-2.4, already green) registers no hook and no
 * endpoint-level default around `/change-password` at all -- confirmed by
 * reading the file before writing this one: nothing there ever sets
 * `revokeOtherSessions`. Better Auth's own installed `changePassword` route
 * (`better-auth@1.7.6`, `dist/api/routes/update-user.mjs`) only revokes other
 * sessions when its caller explicitly passes `revokeOtherSessions: true` in
 * the request body -- verified against that installed source, which reads
 * `const { newPassword, currentPassword, revokeOtherSessions } = ctx.body;`
 * and only calls `internalAdapter.deleteUserSessions` inside `if
 * (revokeOtherSessions)`. This test's WHEN step deliberately omits that
 * field, so today the second device's session survives the password change
 * and the THEN step's `expectContextRequiredRejection` assertion fails
 * (the promise resolves instead of rejecting) -- a plain **assertion
 * failure**, not a missing export or a typo: `./auth.js`, `createAuth`,
 * `createContextResolver` and every other import here already exist and are
 * exercised unchanged by this file's own first describe block and by
 * `context-resolver.int.test.ts`. The `auth.security.session_revoked` log
 * assertion fails the same way, for the same underlying reason: nothing
 * today emits that event name at all, so the captured-log-records array is
 * empty.
 *
 * ## Why this test connects, seeds and asserts the way it does
 *
 * Same shared-`DATABASE_URL` / `runMigrations`-then-random-per-test isolation
 * pattern as this file's own first describe block (task 3.2) and as
 * `auth-flow.int.test.ts` (task 2.3/2.4), reusing that same file's top-level
 * helpers (`handlerOf`, `postJson`, `cookieHeaderFrom`, `apiOf`, `randomIp`,
 * `randomEmail`, `randomSlug`, `expectContextRequiredRejection`) rather than
 * redefining them. Task 18.1 (design D22): the user under test is created
 * through the admin-creation path (`./__fixtures__/admin-user.js`'s
 * `createAdminUser`), not Better Auth's own `/sign-up/email` route -- "two
 * devices" is then two independent `/sign-in/email` calls for that same
 * account, each from its own random IP (so task 2.5's pre-auth rate limiter,
 * keyed by IP and by normalized email, never conflates the two sign-ins or
 * the later `changePassword` call).
 *
 * `changePassword` is called directly through `auth.api.changePassword`
 * (not `auth.handler`), passing `headers` carrying device 1's cookie so
 * Better Auth's `sensitiveSessionMiddleware` resolves the authoritative
 * session the same way `./context-resolver.ts`'s own `api.getSession({
 * headers })` calls already do (`session.cookieCache` stays off, design D2:
 * "no revocation-latency gap to explain" -- so there is no separate,
 * stateless cookie-cache path this call could instead be reading). The
 * telemetry harness (`./__fixtures__/registered-harness.js`, registered
 * while this file's module graph loaded, before `./auth.js`) is reset
 * immediately before the `changePassword` call under test, discarding
 * whatever sign-up/organization-creation/sign-in emitted, so the captured
 * log records after `forceFlush()` reflect only the `changePassword` call
 * itself -- the same reset-then-assert pattern `auth-flow.int.test.ts`'s own
 * task 2.4 describe block already establishes.
 */
describe('changePassword revokes other sessions (task 3.3, design D3)', () => {
  let db: TestDb;
  let auth: AuthInstance;
  let resolveContext: ContextResolver;
  let appPool: TestDb['$client'];
  let harness: TelemetryTestHarness;

  /** The harness `./__fixtures__/registered-harness.js` registered while the module graph loaded. */
  function registeredHarness(): TelemetryTestHarness {
    if ('error' in registration) {
      throw new Error(
        `createTelemetryTestHarness() failed while the test module graph loaded: ${String(registration.error)}`,
        { cause: registration.error },
      );
    }
    return registration.harness;
  }

  beforeAll(async () => {
    db = connect(databaseUrl());
    await runMigrations(db.$client);
    auth = createAuth({ db, secret: TEST_SECRET });
    appPool = connect(databaseUrl()).$client;
    appPool.on('connect', (client) => {
      void client.query('SET ROLE tayzu_app');
    });
    resolveContext = createContextResolver({ auth, revocationPool: appPool });
    harness = registeredHarness();
  }, 60_000);

  afterEach(async () => {
    await harness.reset();
  });

  afterAll(async () => {
    await endQuietly(appPool);
    await endQuietly(db.$client);
  });

  /** design.md, Log events table: `auth.security.session_revoked`'s only reason this task exercises. */
  const PASSWORD_CHANGE_REVOCATION_REASON = 'password_change';

  const NEW_PASSWORD = 'a brand new correct horse battery staple';

  /**
   * The narrow slice of `auth.api` this describe block additionally needs
   * (`changePassword`), typed locally the same "introspect the narrower
   * production type locally" pattern this file's own top-level `AuthApiSurface`
   * (createOrganization only) and `auth-flow.int.test.ts`'s own
   * `AuthApiSurface` already use -- kept as its own, separate interface
   * rather than widening either of those, since neither is this describe
   * block's to change.
   */
  interface ChangePasswordApiSurface {
    changePassword(args: {
      body: {
        readonly currentPassword: string;
        readonly newPassword: string;
        readonly revokeOtherSessions?: boolean;
      };
      headers: Headers;
    }): Promise<{ readonly token: string | null; readonly user: { readonly id: string } }>;
  }

  function changePasswordApiOf(authInstance: AuthInstance): ChangePasswordApiSurface {
    return authInstance.api as ChangePasswordApiSurface;
  }

  it('Password change revokes other sessions', async () => {
    const handler = handlerOf(auth);
    const email = randomEmail();
    const slug = randomSlug();

    // GIVEN "a user signed in on two devices": one admin-created user (task
    // 18.1, design D22 -- no self-service sign-up left to call), one
    // organization (so both sign-ins below resolve an activeOrganizationId,
    // task 2.4's exactly-one-membership rule), then two independent
    // `/sign-in/email` calls for the same account, each from its own random
    // IP.
    const adminUser = await createAdminUser(auth, {
      name: TEST_USER_NAME,
      email,
      password: TEST_PASSWORD,
    });

    const organization = await apiOf(auth).createOrganization({
      body: { name: 'Password Change Test Org', slug, userId: adminUser.userId },
    });

    const device1SignIn = await postJson(
      handler,
      '/sign-in/email',
      { email, password: TEST_PASSWORD },
      randomIp(),
    );
    expect(device1SignIn.status, 'device 1 sign-in succeeds').toBe(200);
    const device1Cookie = cookieHeaderFrom(device1SignIn);

    const device2SignIn = await postJson(
      handler,
      '/sign-in/email',
      { email, password: TEST_PASSWORD },
      randomIp(),
    );
    expect(device2SignIn.status, 'device 2 sign-in succeeds').toBe(200);
    const device2Cookie = cookieHeaderFrom(device2SignIn);

    // GIVEN sanity check: device 2's session resolves successfully before
    // the password change, independent of whatever the WHEN step below does
    // to it.
    const device2Before = await resolveContext(new Headers({ cookie: device2Cookie }));
    expect(device2Before).toEqual({
      tenantId: organization.id,
      actor: { type: 'user', id: adminUser.userId },
      // Task 9.5, Q26: the organization creator is the `owner` -> `admin`.
      principal: { roles: ['admin'], teams: [], moderatedBlueprints: [] },
    });

    // Discard whatever admin-user-creation/organization-creation/sign-in emitted: only
    // the changePassword call below is under test.
    await harness.reset();

    // WHEN "they change their password from the first device". No
    // `revokeOtherSessions` is passed here: design D3 places that
    // responsibility on production code's own `changePassword` call, not on
    // whichever caller happens to invoke this endpoint.
    await changePasswordApiOf(auth).changePassword({
      body: { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD },
      headers: new Headers({ cookie: device1Cookie }),
    });

    await harness.forceFlush();

    // THEN "the second device's session fails exactly as
    // `CATALOG_CONTEXT_REQUIRED` on its next use".
    await expectContextRequiredRejection(resolveContext(new Headers({ cookie: device2Cookie })));

    // AND "the resulting `auth.security.session_revoked` log event"
    // (design.md, Log events table).
    const logs = [...harness.logExporter.getFinishedLogRecords()].filter(
      (record) => record.eventName === 'auth.security.session_revoked',
    );
    expect(logs, 'exactly one session_revoked log record').toHaveLength(1);
    const record = logs[0];
    expect(record?.severityNumber).toBe(SeverityNumber.INFO);
    expect(record?.attributes).toEqual({
      'tayzu.tenant.id': organization.id,
      'tayzu.actor.id': adminUser.userId,
      'tayzu.auth.revocation.reason': PASSWORD_CHANGE_REVOCATION_REASON,
    });
  });
});

/**
 * Task 23.16 (design Q46, D3, D18): `/change-password` becomes reachable over
 * HTTP, and it must still revoke every other session. This drives the HTTP
 * route (`auth.handler`), without `revokeOtherSessions` in the body, exactly as
 * an allowlisted browser call would.
 */
describe('POST /change-password over HTTP revokes other sessions (task 23.16, design Q46)', () => {
  let db: TestDb;
  let auth: AuthInstance;
  let resolveContext: ContextResolver;
  let appPool: TestDb['$client'];

  beforeAll(async () => {
    db = connect(databaseUrl());
    await runMigrations(db.$client);
    auth = createAuth({ db, secret: TEST_SECRET });
    appPool = connect(databaseUrl()).$client;
    appPool.on('connect', (client) => {
      void client.query('SET ROLE tayzu_app');
    });
    resolveContext = createContextResolver({ auth, revocationPool: appPool });
  }, 60_000);

  afterAll(async () => {
    await endQuietly(appPool);
    await endQuietly(db.$client);
  });

  it('Password change revokes other sessions: the second device fails after the first changes the password over HTTP', async () => {
    const handler = handlerOf(auth);
    const email = randomEmail();
    const adminUser = await createAdminUser(auth, {
      name: TEST_USER_NAME,
      email,
      password: TEST_PASSWORD,
    });
    await apiOf(auth).createOrganization({
      body: { name: 'Http Password Change Org', slug: randomSlug(), userId: adminUser.userId },
    });
    const device1SignIn = await postJson(
      handler,
      '/sign-in/email',
      { email, password: TEST_PASSWORD },
      randomIp(),
    );
    expect(device1SignIn.status).toBe(200);
    const device1Cookie = cookieHeaderFrom(device1SignIn);
    const device2SignIn = await postJson(
      handler,
      '/sign-in/email',
      { email, password: TEST_PASSWORD },
      randomIp(),
    );
    expect(device2SignIn.status).toBe(200);
    const device2Cookie = cookieHeaderFrom(device2SignIn);
    await expect(resolveContext(new Headers({ cookie: device2Cookie }))).resolves.toBeDefined();

    const changed = await handler(
      new Request(`${AUTH_BASE_URL}/change-password`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': randomIp(),
          origin: 'http://localhost:3000',
          cookie: device1Cookie,
        },
        body: JSON.stringify({
          currentPassword: TEST_PASSWORD,
          newPassword: 'a brand new correct horse battery staple',
        }),
      }),
    );
    expect(changed.status).toBe(200);

    await expectContextRequiredRejection(resolveContext(new Headers({ cookie: device2Cookie })));
  });
});
