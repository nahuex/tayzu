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
import './__fixtures__/registered-harness.js';
import { createAuth, type AuthInstance } from './auth.js';
// The module under test (task 3.1). Does not exist yet -- see this file's
// own module doc comment, "Why this is expected to fail for the right
// reason right now".
import { createContextResolver } from './context-resolver.js';
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
  return `resolver-${randomUUID()}@example.test`;
}

function randomSlug(): string {
  return `resolver-org-${randomUUID()}`;
}

/** A password long enough for Better Auth's default 8-character minimum. */
const TEST_PASSWORD = 'correct horse battery staple';
const TEST_SECRET = 'int-test-only-secret-not-used-for-anything-real-0123456789';
const TEST_USER_NAME = 'Context Resolver Test User';

const AUTH_BASE_URL = 'http://localhost:3000/api/auth';

/**
 * `./auth.ts`'s `AuthInstance.api` is typed `unknown`; `.handler` is Better
 * Auth's real, documented HTTP entry point (`dist/types/auth.d.mts`:
 * `handler: (request: Request) => Promise<Response>`), not otherwise exposed
 * on `AuthInstance` yet -- same cast `pre-auth-rate-limit.int.test.ts`'s own
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
 * creation only -- sign-up/sign-in go through `auth.handler` instead, see
 * this file's own module doc comment), typed locally the same way
 * `auth-flow.int.test.ts`'s own `AuthApiSurface` is.
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
 * `Set-Cookie` header(s) -- the same "name=value; name=value" shape a
 * browser would send back on the next request. `Headers.getSetCookie()`
 * (available on Node 22's `Headers`, verified in this environment) returns
 * every `Set-Cookie` header separately, never comma-joined, which
 * `Headers.get('set-cookie')` cannot be relied on for when more than one
 * cookie is set.
 */
function cookieHeaderFrom(response: Response): string {
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length === 0) {
    throw new Error('expected response to carry at least one Set-Cookie header');
  }
  return setCookies.map((raw) => raw.split(';')[0]).join('; ');
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

    // GIVEN "a signed-in user with an active organization": the sign-up
    // above leaves the user with zero memberships, so an organization is
    // created for them next (task 2.4's own already-green
    // exactly-one-membership rule needs that membership row to exist
    // *before* the session under test is created).
    const organization = await apiOf(auth).createOrganization({
      body: { name: 'Context Resolver Test Org', slug, userId: signUp.user.id },
    });

    // The sign-up session was created before the organization existed, so
    // it never got an active organization. Signing in again creates a
    // *second*, fresh session, after the membership row exists -- this is
    // the one whose cookie is read back below.
    const signInResponse = await postJson(
      handler,
      '/sign-in/email',
      { email, password: TEST_PASSWORD },
      randomIp(),
    );
    expect(signInResponse.status, 'sign-in succeeds').toBe(200);
    const signIn = (await signInResponse.json()) as SignInEmailResponseBody;
    const cookie = cookieHeaderFrom(signInResponse);

    // GIVEN sanity check: the session row this cookie names really does
    // carry the created organization as its active one, independent of
    // whatever `resolveContext` itself does with it.
    const sessionRow = await findSessionByToken(db, String(signIn.token));
    expect(
      sessionRow?.active_organization_id,
      "the signed-in session's active_organization_id is the created organization",
    ).toBe(organization.id);

    const resolved = await resolveContext(new Headers({ cookie }));

    // Requirement text: "A valid session cookie MUST resolve to
    // `{ tenantId: session.activeOrganizationId, actor: { type: 'user', id:
    // user.id } }`." Scenario THEN: "it runs with `actor.type` `user` and
    // `tenantId` equal to their active organization."
    expect(resolved).toEqual({
      tenantId: organization.id,
      actor: { type: 'user', id: signUp.user.id },
    });
  });

  it('Missing credential is rejected like a missing context', async () => {
    // WHEN: no session cookie and no Authorization header at all.
    await expectContextRequiredRejection(resolveContext(new Headers()));
  });

  it('Session without an active organization is rejected', async () => {
    const handler = handlerOf(auth);
    const email = randomEmail();

    // A signed-up user with zero memberships: task 2.4's own
    // exactly-one-membership rule leaves `activeOrganizationId` `null` on
    // this session (no organization is ever created for this user).
    const signUpResponse = await postJson(
      handler,
      '/sign-up/email',
      { name: TEST_USER_NAME, email, password: TEST_PASSWORD },
      randomIp(),
    );
    expect(signUpResponse.status, 'sign-up succeeds').toBe(200);
    const signUp = (await signUpResponse.json()) as SignUpEmailResponseBody;
    const cookie = cookieHeaderFrom(signUpResponse);

    // GIVEN sanity check: this session really has no active organization,
    // independent of whatever `resolveContext` itself does with it.
    const sessionRow = await findSessionByToken(db, String(signUp.token));
    expect(
      sessionRow?.active_organization_id,
      "a zero-membership user's session has no active organization",
    ).toBeNull();

    // WHEN: a signed-in user with no active organization calls a catalog
    // operation (here, `resolveContext` itself, standing in for the
    // pipeline stage that would call it -- `apps/api` does not exist yet).
    await expectContextRequiredRejection(resolveContext(new Headers({ cookie })));
  });
});
