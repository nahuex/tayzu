/**
 * Integration test for task 3.1 (design D3, D19;
 * `specs/auth-and-rbac/spec.md`, "Session and tenant resolution").
 *
 * "`resolveContext(headers)` in `packages/auth`: the session-cookie branch
 * resolves `{ tenantId: session.activeOrganizationId, actor: { type: 'user',
 * id: user.id } }`." This file covers exactly the three scenarios task 3.1's
 * own Verify clause names, quoted from `specs/auth-and-rbac/spec.md`:
 *
 * #### Scenario: Session cookie resolves a human context
 * - GIVEN a signed-in user with an active organization
 * - WHEN they call a catalog operation over HTTP
 * - THEN it runs with `actor.type` `user` and `tenantId` equal to their
 *   active organization
 *
 * #### Scenario: Missing credential is rejected like a missing context
 * - WHEN a catalog operation is called over HTTP with no session cookie and
 *   no `Authorization` header
 * - THEN it fails exactly as `CATALOG_CONTEXT_REQUIRED`
 *
 * #### Scenario: Session without an active organization is rejected
 * - WHEN a signed-in user with no active organization calls a catalog
 *   operation
 * - THEN it fails exactly as `CATALOG_CONTEXT_REQUIRED`
 *
 * The surrounding requirement text (same spec section) is the source for the
 * exact resolved shape asserted by the first scenario: "A valid session
 * cookie MUST resolve to `{ tenantId: session.activeOrganizationId, actor: {
 * type: 'user', id: user.id } }`." The requirement's other two clauses
 * ("This resolution MUST run before the catalog operation pipeline" and "It
 * MUST NOT read `tenantId` or `actor` from the request body, path, or query
 * string") are not exercised here: `apps/api` (group 11) does not exist yet,
 * so there is no pipeline or request body/path/query to observe
 * `resolveContext` ignoring; the "onBehalfOf" clause is task 3.4's own
 * Verify-named scenario, not this one's.
 *
 * ## Assumed API of `./context-resolver.ts` (task 3.1; does not exist yet)
 *
 * ```ts
 * export interface ContextResolverOptions {
 *   // The Better Auth instance whose session cookie `resolveContext`
 *   // resolves against (`./auth.js`'s `createAuth`, task 2.1).
 *   readonly auth: AuthInstance;
 * }
 *
 * export interface ResolvedActor {
 *   readonly type: 'user';
 *   readonly id: string;
 * }
 *
 * export interface ResolvedContext {
 *   readonly tenantId: string;
 *   readonly actor: ResolvedActor;
 * }
 *
 * export type ContextResolver = (headers: Headers) => Promise<ResolvedContext>;
 *
 * export function createContextResolver(options: ContextResolverOptions): ContextResolver;
 * ```
 *
 * `createContextResolver(options)` is this file's own assumption, not
 * something the design or `tasks.md` spells out verbatim: `tasks.md`
 * consistently writes the call site as `resolveContext(headers)` (task 3.1
 * and 3.4 alike), a one-argument call, while `resolveContext` still needs
 * access to the `AuthInstance` built by `createAuth` (task 2.1) to look up a
 * session at all. A factory returning the bound one-argument function is the
 * same "options object in, function/instance out" shape this package already
 * uses for `createAuth(options): AuthInstance` and
 * `preAuthRateLimitPlugin(options)` (`./rate-limit/pre-auth-rate-limit.ts`),
 * so `const resolveContext = createContextResolver({ auth });` then
 * `resolveContext(headers)` matches every call site `tasks.md` writes,
 * literally. Flagged explicitly here and in this file's own report to the
 * orchestrator, per this assignment's own instructions, in case task 3.1's
 * green phase settles on a different shape (for example a bare two-argument
 * `resolveContext(auth, headers)`) -- the scenario coverage below does not
 * depend on which shape wins, only the constructor call at the top of each
 * `describe` block would need to change.
 *
 * This file deliberately does **not** import `CatalogContext`/`CatalogError`
 * from `@tayzu/catalog`: `packages/auth/package.json` does not declare
 * `@tayzu/catalog` as a dependency (only `@tayzu/db` and
 * `@tayzu/observability`), and `@tayzu/catalog`'s own package entry
 * (`src/index.ts`) currently exports nothing anyway. The design's own
 * "`CatalogContext.actor.onBehalfOf` (001 D3) is reused, not redefined" note
 * is read as reusing the *shape* the requirement's prose already spells out
 * in full (`{ tenantId, actor: { type, id } }`), not as evidence that
 * `@tayzu/auth` imports the type or the `CatalogError` class from
 * `@tayzu/catalog` -- doing so would need a new declared dependency, an
 * implementation decision that belongs to the green phase, not to this test.
 * The "fails exactly as `CATALOG_CONTEXT_REQUIRED`" clause is asserted the
 * same way throughout: whatever `resolveContext` rejects with must carry a
 * `code` property equal to the string `'CATALOG_CONTEXT_REQUIRED'`, checked
 * structurally (`expect(...).rejects.toMatchObject({ code: ... })`), which
 * passes equally whether the green phase throws a real, imported
 * `CatalogError` or a package-local error object shaped the same way.
 *
 * ## Why this is expected to fail for the right reason right now
 *
 * `./context-resolver.ts` does not exist: `packages/auth/src/` has no file
 * by that name (confirmed by listing the directory before writing this
 * file). Every test below therefore fails on the same root cause, a
 * `Cannot find module './context-resolver.js'` (or equivalent
 * `ERR_MODULE_NOT_FOUND`) raised while this file's own module graph loads --
 * not a typo, a wrong import path elsewhere, or a broken fixture: every
 * other import in this file (`./auth.js`, `./persistence/schema.js`,
 * `@tayzu/db`, `./__fixtures__/registered-harness.js`) already exists and is
 * exercised, unchanged, by `auth-flow.int.test.ts` and
 * `pre-auth-rate-limit.int.test.ts` in this same package.
 *
 * ## Why this test connects, seeds and asserts the way it does
 *
 * Same shared-`DATABASE_URL` / `runMigrations`-then-`randomUUID()`-per-test
 * isolation pattern every other int test file in `@tayzu/auth` already
 * establishes (`auth-flow.int.test.ts`, `pre-auth-rate-limit.int.test.ts`,
 * `enumeration-resistance.int.test.ts`), and the same
 * `drizzle(url, { schema: authSchema })` handle those files use
 * (`@better-auth/drizzle-adapter`'s model resolution needs the Drizzle
 * instance to have been constructed with that schema).
 *
 * Real session cookies are obtained by signing up/in through
 * `auth.handler(new Request(...))`, not `auth.api.signUpEmail`/
 * `signInEmail`: the latter never produces an HTTP `Response` at all (no
 * `Set-Cookie` header to read back), and `resolveContext(headers)`'s own
 * contract is to resolve a `Headers` object carrying a real `cookie` header,
 * the same shape a browser would send. Every request below carries its own
 * fresh, random `x-forwarded-for` IP (`randomIp()`, same helper shape as
 * `pre-auth-rate-limit.int.test.ts`'s own), per this task's own instructions
 * -- `./auth.ts` (task 2.5, already green) disables Better Auth's built-in
 * IP+path rate limiter unconditionally and only enables the custom
 * IP+email-keyed limiter when `createAuth` is given a `rateLimit` option
 * (which this file never passes), so no request below is at risk of being
 * throttled either way; the fresh IP is included anyway for hygiene and
 * consistency with every other int test file in this package that drives
 * `auth.handler` directly.
 *
 * "A user with exactly one membership gets an active organization
 * automatically" is task 2.4's own, already-green
 * `databaseHooks.session.create.before` behavior (`./auth.ts`, verified
 * directly by `auth-flow.int.test.ts`'s own sign-in-telemetry describe
 * block): a session created for a user who belongs to exactly one
 * organization gets that organization as `activeOrganizationId`; a session
 * created for a user with zero memberships gets `null`. So the first
 * scenario below signs a user up (zero memberships at that point), creates
 * one organization for them (`auth.api.createOrganization`, the same
 * in-process, no-headers call `auth-flow.int.test.ts` already uses), and
 * then signs in again -- the *second* session, created after the membership
 * row exists, is the one whose cookie is read back -- while the third
 * scenario signs a user up and stops there, reading the sign-up response's
 * own session cookie directly, with no organization ever created for that
 * user.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { runMigrations } from '@tayzu/db';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Import order is load-bearing (task 2.4; design D1; `packages/observability/
// CLAUDE.md`, "Import order"): the harness must register before `./auth.js`,
// which imports a telemetry/instruments module that creates its tracer,
// meter and logger at import time. Same rationale as
// `enumeration-resistance.int.test.ts`'s identical import-order comment,
// even though this file asserts no telemetry itself: an unregistered harness
// would make `./auth.js`'s own instruments permanent no-ops for every other
// test file sharing the module graph within the same worker.
import {
  bootstrapTestTenant,
  createAdminUser,
  signInAdminUser,
} from './__fixtures__/admin-user.js';
import './__fixtures__/registered-harness.js';
import { createAuth, type AuthInstance } from './auth.js';
// The module under test (task 3.1). Does not exist yet -- see this file's
// own module doc comment, "Why this is expected to fail for the right
// reason right now".
import { createContextResolver } from './context-resolver.js';
// Task 5.4's own two new scenarios (below, at the end of this file's one
// `describe` block) reuse task 5.1's and 5.3's already-green production
// code, unchanged, to provision a real machine credential and exchange it
// for a real access token -- neither import below is "the module under
// test" for task 5.4 (that is still `./context-resolver.js`'s still-missing
// access-token branch, see each new test's own doc comment).
import { createMachineCredential } from './machine-credentials.js';
import type { CreatedMachineCredential } from './machine-credentials.js';
import * as authSchema from './persistence/schema.js';
import { exchangeMachineToken } from './token-exchange.js';

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
  return `resolver-${randomUUID()}@example.test`;
}

function randomSlug(): string {
  return `resolver-org-${randomUUID()}`;
}

/** A password long enough for Better Auth's default 8-character minimum. */
const TEST_PASSWORD = 'correct horse battery staple';
const TEST_SECRET = 'int-test-only-secret-not-used-for-anything-real-0123456789';
const TEST_USER_NAME = 'Context Resolver Test User';

// Task 18.1 (design D22): this file no longer drives `auth.handler`/
// `auth.api` directly for user provisioning -- every fixture below goes
// through `./__fixtures__/admin-user.js`'s `createAdminUser`/
// `signInAdminUser`/`bootstrapTestTenant` instead (no self-service
// `/sign-up/email` route left to call), so the local `handlerOf`/`apiOf`/
// `postJson`/`cookieHeaderFrom`/response-body-shape helpers every earlier
// revision of this file defined are no longer needed here.

type SessionRow = {
  readonly active_organization_id: string | null;
};

async function findSessionByToken(db: TestDb, token: string): Promise<SessionRow | undefined> {
  const result = await db.execute<SessionRow>(sql`
    select active_organization_id from auth.session where token = ${token}
  `);
  return result.rows[0];
}

/**
 * Task 3.6 (design D19): removes the `auth.member` row naming `userId` as a
 * member of `organizationId`, direct SQL against the same schema
 * `context-resolver.int.test.ts`'s other queries already read (`auth.member`,
 * `packages/auth/src/persistence/schema.ts`'s `member` table) -- standing in
 * for "a membership row removed after the session was established", the
 * fixture task 3.6's own Verify clause names explicitly, independent of
 * whatever `resolveContext` itself does with the resulting stale session.
 */
async function deleteMembership(db: TestDb, organizationId: string, userId: string): Promise<void> {
  await db.execute(sql`
    delete from auth.member where organization_id = ${organizationId} and user_id = ${userId}
  `);
}

/**
 * "fails exactly as `CATALOG_CONTEXT_REQUIRED`" (spec, both rejection
 * scenarios below): whatever `resolveContext` rejects with must carry a
 * `code` property equal to this string, checked structurally so this file
 * does not need to import `CatalogError` from `@tayzu/catalog` (see this
 * file's own module doc comment for why).
 */
async function expectContextRequiredRejection(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code: 'CATALOG_CONTEXT_REQUIRED' });
}

/**
 * `./context-resolver.js` does not exist yet (see this file's own module
 * doc comment), so the `createContextResolver` binding this file imports
 * from it resolves to `any` at the type level. This local factory type
 * (the same "Assumed API" shape documented at the top of this file) is cast
 * onto that binding once, here, so every call site below is a type-checked,
 * non-`any` function call instead of an unsafe one -- the same
 * "introspect/extend the narrower production type locally" pattern
 * `auth-flow.int.test.ts`'s own `AuthApiSurface` already establishes for
 * `auth.api`.
 */
type ContextResolverFactory = (options: {
  readonly auth: AuthInstance;
}) => (headers: Headers) => Promise<unknown>;

/**
 * The narrow slice of `auth.api.signJWT`'s installed, `serverOnly` endpoint
 * (`better-auth@1.7.6`, `dist/plugins/jwt/index.mjs`) task 5.4's own
 * "Expired machine access token is rejected" scenario needs: the same
 * primitive `./token-exchange.ts`'s own, already-green `exchangeMachineToken`
 * (task 5.3) calls internally to mint a real access token, exposed here
 * because that scenario needs one whose `iat`/`exp` are already an hour in
 * the past -- not something `exchangeMachineToken`'s own, fixed "+1 hour from
 * now" call can ever produce (see `signExpiredMachineToken`'s own doc
 * comment below for why this is built this way instead of waiting or faking
 * the system clock).
 */
interface SignJwtApiSurface {
  signJWT(args: {
    body: { payload: Record<string, unknown> };
  }): Promise<{ readonly token: string }>;
}

function signJwtOf(auth: AuthInstance): SignJwtApiSurface {
  return auth.api as SignJwtApiSurface;
}

/** design D5: "a 1-hour access token." Mirrors `./token-exchange.ts`'s own identically-named constant. */
const ONE_HOUR_SECONDS = 60 * 60;
const TWO_HOURS_SECONDS = 2 * ONE_HOUR_SECONDS;

/**
 * Builds an access token carrying the exact `{ tenantId, actor: { type, id }
 * }` claim shape design D5 names for `POST /v1/auth/token`'s own minted
 * token (`./token-exchange.ts`'s `exchangeMachineToken`, task 5.3) -- but
 * with an explicit `iat`/`exp` pair already an hour in the past, standing in
 * for "an access token issued more than 1 hour ago" (task 5.4's own
 * Verify-named scenario), the same "manipulate the persisted/signed
 * timestamp directly rather than waiting a real hour or faking the system
 * clock" practice `session-policy.int.test.ts`'s own idle-timeout fixtures
 * already establish for this package, adapted here to a signed JWT claim
 * instead of a database row -- a machine access token carries its own expiry
 * inside the token itself, not in a queryable column, so there is no row to
 * backdate.
 */
async function signExpiredMachineToken(
  auth: AuthInstance,
  credential: CreatedMachineCredential,
): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const signed = await signJwtOf(auth).signJWT({
    body: {
      payload: {
        tenantId: credential.organizationId,
        actor: { type: credential.actorKind, id: credential.id },
        iat: nowSeconds - TWO_HOURS_SECONDS,
        exp: nowSeconds - ONE_HOUR_SECONDS,
      },
    },
  });
  return signed.token;
}

describe('resolveContext: session-cookie branch (task 3.1, design D3, D19)', () => {
  let db: TestDb;
  let auth: AuthInstance;
  let resolveContext: (headers: Headers) => Promise<unknown>;

  beforeAll(async () => {
    db = connect(databaseUrl());
    await runMigrations(db.$client);
    auth = createAuth({ db, secret: TEST_SECRET });
    resolveContext = (createContextResolver as ContextResolverFactory)({ auth });
  }, 60_000);

  afterAll(async () => {
    await endQuietly(db.$client);
  });

  it('Session cookie resolves a human context', async () => {
    // GIVEN "a signed-in user with an active organization": task 18.1
    // (design D22) provisions this through the admin-creation path
    // (`./__fixtures__/admin-user.js`'s `bootstrapTestTenant`) instead of
    // Better Auth's own `/sign-up/email` route -- the created user's one
    // organization membership already exists before `bootstrapTestTenant`'s
    // own, single sign-in call, so that session already carries it as its
    // `activeOrganizationId` (task 2.4's own, already-green
    // exactly-one-membership rule).
    const tenant = await bootstrapTestTenant(auth, {
      name: TEST_USER_NAME,
      email: randomEmail(),
      password: TEST_PASSWORD,
      organizationName: 'Context Resolver Test Org',
      organizationSlug: randomSlug(),
      ip: randomIp(),
    });

    // GIVEN sanity check: the session row this cookie names really does
    // carry the created organization as its active one, independent of
    // whatever `resolveContext` itself does with it.
    const sessionRow = await findSessionByToken(db, tenant.token);
    expect(
      sessionRow?.active_organization_id,
      "the signed-in session's active_organization_id is the created organization",
    ).toBe(tenant.organizationId);

    const resolved = await resolveContext(new Headers({ cookie: tenant.cookie }));

    // Requirement text: "A valid session cookie MUST resolve to
    // `{ tenantId: session.activeOrganizationId, actor: { type: 'user', id:
    // user.id } }`." Scenario THEN: "it runs with `actor.type` `user` and
    // `tenantId` equal to their active organization."
    expect(resolved).toEqual({
      tenantId: tenant.organizationId,
      actor: { type: 'user', id: tenant.userId },
    });
  });

  it('Missing credential is rejected like a missing context', async () => {
    // WHEN: no session cookie and no Authorization header at all.
    await expectContextRequiredRejection(resolveContext(new Headers()));
  });

  it('Session without an active organization is rejected', async () => {
    const email = randomEmail();

    // Task 18.1 (design D22): an admin-created user with zero memberships
    // (`./__fixtures__/admin-user.js`, no self-service `/sign-up/email` left
    // to call) -- task 2.4's own exactly-one-membership rule leaves
    // `activeOrganizationId` `null` on the resulting session (no
    // organization is ever created for this user).
    const adminUser = await createAdminUser(auth, {
      name: TEST_USER_NAME,
      email,
      password: TEST_PASSWORD,
    });
    const signedIn = await signInAdminUser(auth, {
      email,
      password: TEST_PASSWORD,
      ip: randomIp(),
    });
    expect(signedIn.userId).toBe(adminUser.userId);

    // GIVEN sanity check: this session really has no active organization,
    // independent of whatever `resolveContext` itself does with it.
    const sessionRow = await findSessionByToken(db, signedIn.token);
    expect(
      sessionRow?.active_organization_id,
      "a zero-membership user's session has no active organization",
    ).toBeNull();

    // WHEN: a signed-in user with no active organization calls a catalog
    // operation (here, `resolveContext` itself, standing in for the
    // pipeline stage that would call it -- `apps/api` does not exist yet).
    await expectContextRequiredRejection(resolveContext(new Headers({ cookie: signedIn.cookie })));
  });

  /**
   * Task 3.4 (design D3; `specs/auth-and-rbac/spec.md`, "HTTP requests
   * resolve to a catalog context or fail exactly like a missing context"),
   * quoted in full:
   *
   * #### Scenario: A client-supplied onBehalfOf value is ignored
   * - GIVEN a valid session cookie or machine access token
   * - WHEN the caller additionally supplies an `onBehalfOf` value in the
   *   request body, path, query string, or a header
   * - THEN the resolved context's `actor.onBehalfOf` is not set from that
   *   value, and the operation is attributed to the resolved actor alone
   *
   * This exercises only the session-cookie half of the scenario's GIVEN
   * clause (a valid session cookie): the machine-access-token half is task
   * 5.4's own branch of `resolveContext`, which does not exist yet (see this
   * file's own module doc comment on scope).
   *
   * `resolveContext`'s own signature is `(headers: Headers) =>
   * Promise<ResolvedContext>` (`./context-resolver.ts`): it has no parameter
   * through which a request body, path, or query string could ever reach it
   * at all, so those three of the WHEN clause's four vectors are unreachable
   * by construction at this call boundary, exactly as `./context-resolver.ts`'s
   * own doc comment already argues ("this module never reads request body,
   * path, or query string at all"). The one vector `resolveContext` could
   * conceivably read is a header, so this test supplies the client-side
   * `onBehalfOf` value the same way `x-tayzu-risk` (design D4) is supplied --
   * as a plain request header, here named `x-tayzu-on-behalf-of` (no
   * canonical header name for this appears anywhere in the spec or design,
   * because D3 states plainly that this field is "not reachable over HTTP in
   * 002's scope" at all; any header name choice with the value ignored
   * satisfies the requirement).
   *
   * The THEN clause ("the resolved context's `actor.onBehalfOf` is not set
   * from that value, and the operation is attributed to the resolved actor
   * alone") is checked with `toEqual`, the same exact-shape check the first
   * scenario in this file uses: `ResolvedContext.actor` has no `onBehalfOf`
   * property in its resolved value at all, matching design D3's "is reused,
   * not redefined, but is not reachable over HTTP in 002's scope" -- there is
   * no `onBehalfOf`-shaped field to have been set from the header, and the
   * resolved `actor` is exactly `{ type: 'user', id: signUp.user.id }`, the
   * real signed-in user, never the header's attempted override.
   */
  it('A client-supplied onBehalfOf value is ignored', async () => {
    // GIVEN "a valid session cookie": task 18.1 (design D22) provisions this
    // through the admin-creation path (`./__fixtures__/admin-user.js`'s
    // `bootstrapTestTenant`), the same replacement the first scenario in
    // this file uses, so the session under test has an active organization.
    const tenant = await bootstrapTestTenant(auth, {
      name: TEST_USER_NAME,
      email: randomEmail(),
      password: TEST_PASSWORD,
      organizationName: 'OnBehalfOf Test Org',
      organizationSlug: randomSlug(),
      ip: randomIp(),
    });

    // WHEN: the caller additionally supplies an onBehalfOf value in a
    // header, alongside the otherwise-valid session cookie. A different,
    // unrelated user id (a random UUID, not any real user this suite has
    // created) stands in for the "different principal" a forged attribution
    // would name.
    const forgedOnBehalfOfUserId = randomUUID();
    const resolved = await resolveContext(
      new Headers({
        cookie: tenant.cookie,
        'x-tayzu-on-behalf-of': forgedOnBehalfOfUserId,
      }),
    );

    // THEN: the resolved context's actor carries no onBehalfOf value taken
    // from that header, and the operation is attributed to the resolved
    // actor (the real signed-in user) alone -- the identical shape the first
    // scenario in this file asserts for the same session, `onBehalfOf`
    // header or not.
    expect(resolved).toEqual({
      tenantId: tenant.organizationId,
      actor: { type: 'user', id: tenant.userId },
    });
    expect(tenant.token.length, 'sanity: sign-in produced a real session').toBeGreaterThan(0);
  });

  /**
   * Task 3.6 (design D19; `specs/auth-and-rbac/spec.md`, "Tenant-switch
   * membership is independently re-verified"), quoted in full:
   *
   * #### Scenario: Context resolution independently rejects a stale non-membership
   * - GIVEN a session whose `activeOrganizationId` names an organization the
   *   user is no longer a member of
   * - WHEN a catalog operation is called with that session
   * - THEN it fails exactly as `CATALOG_CONTEXT_REQUIRED`
   *
   * The requirement text above the scenario is explicit that this is a
   * *second*, independent check, not a re-derivation of Better Auth's own
   * `setActiveOrganization` membership check (task 3.5's own scenario,
   * `active-org.int.test.ts`): "`resolveContext()`'s session-cookie branch
   * MUST independently re-verify, via a membership-row lookup, that
   * `session.activeOrganizationId` names an organization the session's user
   * currently belongs to, using a cache no older than a few seconds. A
   * failed or unavailable re-verification MUST fail closed, with the same
   * status and body as `CATALOG_CONTEXT_REQUIRED`." This test's GIVEN clause
   * ("a membership row removed after the session was established", task
   * 3.6's own Verify clause) is exactly the case that check exists for: the
   * session row itself still carries the organization as its
   * `activeOrganizationId` (nothing here touches the session row, unlike
   * task 3.5's `setActiveOrganization` scenario), so only an independent
   * membership-row lookup -- not merely trusting the session's own column --
   * can catch it.
   *
   * ## Why this is expected to fail for the right reason right now
   *
   * `./context-resolver.ts`'s own module doc comment (task 3.1) says so
   * directly: "the independent membership re-check (task 3.6, design D19)
   * are later tasks' own red/green cycles, not implemented here." Its
   * `createContextResolver` resolves a session's `activeOrganizationId`
   * straight from the session row, with no membership-table lookup at all
   * (`./context-resolver.ts`, current source, confirmed by reading it before
   * writing this test) -- so this test is expected to fail as a plain
   * **assertion failure**: the promise below resolves successfully (the
   * stale organization id, the real signed-up user) instead of rejecting
   * with `CATALOG_CONTEXT_REQUIRED`. Not a missing export or a typo: every
   * import this file uses already exists and is exercised, unchanged, by the
   * three scenarios above in this same file.
   *
   * ## Why this test seeds and asserts the way it does
   *
   * Same "sign up, create org, sign in again" sequence this file's first
   * scenario ("Session cookie resolves a human context") already
   * establishes, so the session under test starts with a real active
   * organization the user is genuinely a member of -- the GIVEN sanity check
   * below confirms that, independent of whatever `resolveContext` itself
   * does with it, the same pattern every other scenario in this file
   * follows. `deleteMembership` (above) then removes the `auth.member` row
   * *after* that session already exists, leaving the session row's own
   * `active_organization_id` column untouched (unlike task 3.5's scenario,
   * which is about `setActiveOrganization` itself mutating that column) --
   * the precise "stale non-membership" this scenario names: a session that
   * still says it belongs to an organization its user no longer does.
   */
  it('Context resolution independently rejects a stale non-membership', async () => {
    // GIVEN, step 1: task 18.1 (design D22) provisions a user who is a
    // member of a real organization through the admin-creation path
    // (`./__fixtures__/admin-user.js`'s `bootstrapTestTenant`), the same
    // replacement this file's first scenario uses -- the membership row
    // already exists before `bootstrapTestTenant`'s own, single sign-in
    // call, so that session already carries it as its `activeOrganizationId`
    // (task 2.4's exactly-one-membership rule).
    const tenant = await bootstrapTestTenant(auth, {
      name: TEST_USER_NAME,
      email: randomEmail(),
      password: TEST_PASSWORD,
      organizationName: 'Stale Membership Test Org',
      organizationSlug: randomSlug(),
      ip: randomIp(),
    });

    // GIVEN sanity check: the session really is active on the created
    // organization before the membership row is removed, independent of
    // whatever `resolveContext` itself does with it.
    const sessionRow = await findSessionByToken(db, tenant.token);
    expect(
      sessionRow?.active_organization_id,
      "the signed-in session's active_organization_id is the created organization",
    ).toBe(tenant.organizationId);

    // GIVEN, step 2: "a session whose `activeOrganizationId` names an
    // organization the user is no longer a member of" -- the membership row
    // is removed *after* the session above was already established, leaving
    // the session row's own `active_organization_id` column unchanged.
    await deleteMembership(db, tenant.organizationId, tenant.userId);

    // WHEN "a catalog operation is called with that session" (here,
    // `resolveContext` itself, standing in for the pipeline stage that would
    // call it -- `apps/api` does not exist yet, the same substitution this
    // file's other scenarios already make).
    // THEN "it fails exactly as `CATALOG_CONTEXT_REQUIRED`".
    await expectContextRequiredRejection(resolveContext(new Headers({ cookie: tenant.cookie })));
  });

  /**
   * Task 5.4 (design D5, D21; `specs/auth-and-rbac/spec.md`, "HTTP requests
   * resolve to a catalog context or fail exactly like a missing context"),
   * quoted in full:
   *
   * #### Scenario: Expired machine access token is rejected
   * - WHEN a catalog operation is called with an access token issued more
   *   than 1 hour ago
   * - THEN it fails exactly as `CATALOG_CONTEXT_REQUIRED`
   *
   * The requirement text above the scenario is the source for "a valid
   * machine access token MUST resolve to `{ tenantId, actor: { type:
   * 'integration'|'agent', id } }` per the token's own claims" and "an
   * invalid or expired token MUST be rejected with the same status and body
   * as `CATALOG_CONTEXT_REQUIRED`" -- the same structural rejection shape
   * `expectContextRequiredRejection` (above) already asserts throughout this
   * file for the session-cookie branch's own rejection cases.
   *
   * ## Why this is expected to fail for the right reason right now
   *
   * `./context-resolver.ts`'s own module doc comment (task 3.1) says
   * "Machine access tokens (task 5.4) ... are later tasks' own red/green
   * cycles, not implemented here" -- confirmed by reading the current
   * source: `createContextResolver`'s returned function never reads an
   * `authorization` header at all, so a request carrying only one (no
   * `cookie` header) falls straight through to `api.getSession`, which
   * resolves `null` for a request with no session cookie -- the same
   * "Missing credential is rejected like a missing context" path this file's
   * second scenario already exercises. This scenario is therefore expected
   * to **pass already, but for the wrong reason**: `resolveContext` rejects
   * with `CATALOG_CONTEXT_REQUIRED` today regardless of whether the bearer
   * token is expired, fresh, malformed, or entirely absent, because it never
   * looks at the `authorization` header's contents at all yet -- there is no
   * expiry-specific behavior here yet to have failed. This scenario is
   * included anyway, per task 5.4's own Verify clause naming it explicitly,
   * and is meaningful only together with the next scenario below (a fresh,
   * valid access token, which genuinely fails today): together, the two
   * demonstrate that only an expired token should be rejected, once the
   * access-token branch exists, rather than every bearer token
   * indiscriminately as today's placeholder behavior happens to do. Flagged
   * explicitly here, and in this file's own report to the orchestrator, per
   * this assignment's own instructions ("If they already pass because a
   * library already behaves this way, say so clearly instead of forcing a
   * failure").
   */
  it('Expired machine access token is rejected', async () => {
    const admin = await bootstrapTestTenant(auth, {
      name: TEST_USER_NAME,
      email: randomEmail(),
      password: TEST_PASSWORD,
      organizationName: 'Expired Token Test Org',
      organizationSlug: randomSlug(),
      ip: randomIp(),
    });

    // GIVEN: "an access token issued more than 1 hour ago" -- built with the
    // exact claim shape `POST /v1/auth/token` (task 5.3, `./token-exchange.ts`)
    // mints for a real credential, but an `iat`/`exp` pair already an hour in
    // the past instead of an hour in the future (see `signExpiredMachineToken`'s
    // own doc comment for why this is built this way rather than waiting a
    // real hour or faking the system clock).
    const credential = await createMachineCredential(auth, {
      headers: new Headers({ cookie: admin.cookie }),
      organizationId: admin.organizationId,
      name: 'Expired token test credential',
      actorKind: 'integration',
    });
    const expiredToken = await signExpiredMachineToken(auth, credential);

    // WHEN "a catalog operation is called with an access token issued more
    // than 1 hour ago" (here, `resolveContext` itself, standing in for the
    // pipeline stage that would call it -- `apps/api` does not exist yet,
    // the same substitution this file's other scenarios already make).
    // THEN "it fails exactly as `CATALOG_CONTEXT_REQUIRED`".
    await expectContextRequiredRejection(
      resolveContext(new Headers({ authorization: `Bearer ${expiredToken}` })),
    );
  });

  /**
   * Task 5.4's own second Verify-named scenario: "a fresh-token success case
   * resolving `actor.type` from the credential's fixed kind." Not a scenario
   * `specs/auth-and-rbac/spec.md` names verbatim by its own title (unlike
   * every other scenario in this file); the requirement text it exercises is
   * the same one the scenario above quotes: "A valid machine access token
   * MUST resolve to `{ tenantId, actor: { type: 'integration'|'agent', id }
   * }` per the token's own claims."
   *
   * The credential here is created with `actorKind: 'agent'`, not
   * `'integration'` (the kind every other machine-credential test in this
   * package uses) -- specifically so this scenario's own "resolving
   * `actor.type` from the credential's fixed kind" clause is checked against
   * a kind `resolveContext` could not satisfy by having simply hardcoded
   * `'integration'` somewhere.
   *
   * ## Why this is expected to fail for the right reason right now
   *
   * The same reason the scenario above's own doc comment gives for why
   * `resolveContext` does not yet read an `authorization` header at all --
   * except this scenario's assertion runs the other way: it expects the
   * returned promise to **resolve** to `{ tenantId, actor: { type: 'agent',
   * id: credential.id } }`, and today it instead **rejects** with
   * `CATALOG_CONTEXT_REQUIRED` (the same "no session cookie" fallback path),
   * exactly as `resolveContext`'s own current source predicts -- a genuine
   * assertion failure demonstrating the missing behavior, not a typo or a
   * broken fixture: `createMachineCredential` and `exchangeMachineToken` are
   * both already-green production code (tasks 5.1 and 5.3), imported and
   * exercised unchanged by `machine-credentials.int.test.ts` and
   * `token-exchange.int.test.ts` respectively.
   *
   * ## A pre-existing gap this scenario's own success path may also surface
   *
   * `./token-exchange.ts`'s `exchangeMachineToken` signs its payload with no
   * `sub` claim and an empty-string `aud` claim (`ctx.context.options.
   * baseURL` is never configured anywhere in this package, so `signJWT`'s own
   * `defaultAud` falls back to `""`) -- the installed `better-auth@1.7.6`
   * `jwt` plugin's own `verifyJWT` (`dist/plugins/jwt/verify.mjs`) rejects
   * any payload lacking a truthy `sub` or `aud` unconditionally
   * (`if (!payload.sub || !payload.aud) return null;`), independent of
   * signature validity or expiry. If the green phase's access-token branch
   * calls that same `verifyJWT` (the natural "verify a `jwt`-plugin-signed
   * token" primitive, and the same one this file's sibling scenario above
   * relies on transitively rejecting an expired token), this scenario's own
   * fresh, real `exchangeMachineToken` output may still fail to verify for
   * this unrelated reason -- in which case `./token-exchange.ts` (task 5.3,
   * already committed) itself needs a small production fix (adding an
   * explicit `sub` claim, and a non-empty `aud`/`iss`) alongside task 5.4's
   * own new code, not a change to this test. Flagged explicitly here, and in
   * this file's own report to the orchestrator, per this assignment's own
   * instructions to report anything needing a non-test change.
   */
  it("A fresh machine access token resolves actor.type from the credential's fixed kind", async () => {
    const admin = await bootstrapTestTenant(auth, {
      name: TEST_USER_NAME,
      email: randomEmail(),
      password: TEST_PASSWORD,
      organizationName: 'Fresh Token Test Org',
      organizationSlug: randomSlug(),
      ip: randomIp(),
    });

    // GIVEN "an active `agent`-kind machine credential" (see this test's own
    // doc comment for why `agent`, not `integration`).
    const credential = await createMachineCredential(auth, {
      headers: new Headers({ cookie: admin.cookie }),
      organizationId: admin.organizationId,
      name: 'Fresh token test credential',
      actorKind: 'agent',
    });

    // WHEN "its client id and secret are posted to `POST /v1/auth/token`"
    // (task 5.3's own, already-green `exchangeMachineToken` -- the real
    // production exchange, not a hand-built token, unlike the expiry
    // scenario above, which needs an already-past `exp` no real exchange
    // call can produce without waiting a full hour).
    const exchanged = await exchangeMachineToken(auth, {
      clientId: credential.id,
      clientSecret: credential.secret,
    });

    // WHEN "a catalog operation is called" with that fresh access token
    // (here, `resolveContext` itself, the same substitution this file's
    // other scenarios already make).
    const resolved = await resolveContext(
      new Headers({ authorization: `Bearer ${exchanged.accessToken}` }),
    );

    // THEN: "A valid machine access token MUST resolve to `{ tenantId,
    // actor: { type: 'integration'|'agent', id } }` per the token's own
    // claims" -- `actor.type` is `'agent'`, the credential's own fixed kind
    // (task 5.4's own Verify-clause wording), `actor.id` is the credential's
    // own client id, and `tenantId` is the organization the credential
    // belongs to.
    expect(resolved).toEqual({
      tenantId: admin.organizationId,
      actor: { type: 'agent', id: credential.id },
    });
  });
});
