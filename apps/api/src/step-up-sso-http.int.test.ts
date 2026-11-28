/**
 * Integration test for task 23.8 (openspec/changes/archive/2026-10-15-002-auth-and-rbac; design
 * Resolved decision Q36 and D25; `specs/auth-and-rbac/spec.md`, requirement
 * "Step-up authentication for high-risk operations").
 *
 * Task 23.8: "SSO step-up can be satisfied over HTTP: the step-up interceptor
 * starts the Visma re-authorization and a re-auth callback route validates
 * `auth_time`, `acr` and `amr` server-side per D25 and hands the result to the
 * guard as `reauthorization`."
 *
 * Scenarios covered (verbatim from the spec):
 * - "A fresh Visma Connect re-authorization with an MFA method satisfies
 *   step-up": GIVEN a user whose session was established through Visma Connect,
 *   re-authorizing with an MFA method within the freshness threshold, WHEN they
 *   call `blueprints.delete`, THEN the deletion proceeds.
 * - "A Visma Connect re-authorization without a qualifying MFA claim does not
 *   satisfy step-up": GIVEN a user whose session was established through Visma
 *   Connect, completing a re-authorization whose returned claims do not include
 *   a qualifying MFA method or authentication context level, WHEN they call
 *   `blueprints.delete`, THEN it fails with `AUTH_STEP_UP_REQUIRED` and the
 *   blueprint is not deleted.
 *
 * ## Harness
 *
 * The app is built by the production bootstrap, `createAppFromEnv(env)`, with
 * the `VISMA_CONNECT_*` variables pointing at the task-19.1 local OIDC stub
 * (the real Visma Connect is never called). `@tayzu/db`'s `createPool` is
 * mocked to hand out the harness pools, as in `bootstrap-wiring.int.test.ts`.
 * Every request goes through Fastify (`app.app.inject`) with a fresh random
 * `x-forwarded-for`; only the stub's authorization endpoint (the identity
 * provider) is reached with `fetch`. The user is an org owner (Cerbos allows
 * `blueprints.delete`); Cerbos runs at `localhost:3593`. The session is a local
 * sign-in whose `auth.session.sso_sid` is set, which is what marks it as
 * "established through Visma Connect" (D25).
 *
 * ## Production symbols expected (the red phase)
 *
 * The design fixes the checks (D25) but not the route contract, so this file
 * assumes the following; only the helper `startReauthorization` /
 * `completeReauthorization` below would change if the implementation differs:
 *
 * - The step-up interceptor in `server.ts`, for a `user` session with `ssoSid`
 *   set and no valid re-authorization, answers `403` with body code
 *   `AUTH_STEP_UP_REQUIRED` and `data.reauthorizationUrl`: the Visma Connect
 *   authorization URL, carrying `max_age=300`, `prompt=login` and
 *   `acr_values=urn:idp:vismaconnect:mfa` (D25), with a `redirect_uri` that
 *   points at the app's re-auth callback route.
 * - The callback route (any path the `redirect_uri` names; the test follows it
 *   as a `GET` with the query; 048 task 6.5 removed the `form_post` `POST`) exchanges the code,
 *   validates the returned ID token's `auth_time`, `acr`, `amr` and `sid`
 *   server-side, and records the result so that the caller's next request with
 *   the same session cookie reaches the guard as `reauthorization`. A
 *   successful callback answers below 400. What a failed callback answers is
 *   left open: the tests only observe the retried `DELETE`.
 * - No Cerbos policy change and no migration.
 */
// Load-bearing import order (design D1): the telemetry harness registers before anything that
// loads `@tayzu/auth` creates its logger (048 task 6.3 reads `auth.security.reauthorization_failed`).
import { registration, type TelemetryTestHarness } from './__fixtures__/link-telemetry.js';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { enrollTotp, signInWithTotp } from './__fixtures__/fresh-mfa.js';
import {
  bootstrapTestTenant,
  testAppPool,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { startOidcStub, type OidcStub } from '../../../packages/auth/src/__fixtures__/oidc-stub.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { csrfHeaders } from './__fixtures__/csrf.js';
import { harnessPools } from './__fixtures__/pools.js';

const state = vi.hoisted(() => ({ pools: new Map<string, unknown>() }));

vi.mock('@tayzu/db', async (importActual) => {
  const actual = await importActual<typeof import('@tayzu/db')>();
  return {
    ...actual,
    createPool: vi.fn((url: string) => {
      const role = url.includes('tayzu_auth') ? 'auth' : 'app';
      const real = state.pools.get(role) as object;
      return new Proxy(real, {
        get(target, prop) {
          if (prop === 'end') {
            return () => Promise.resolve();
          }
          const value: unknown = Reflect.get(target, prop, target);
          return typeof value === 'function'
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });
    }),
  };
});

import { createAppFromEnv } from './bootstrap.js';
import type { App } from './server.js';

const ORIGIN = 'https://app.tayzu.test';

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

function cookieFrom(setCookie: string | string[] | number | undefined): string {
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : typeof setCookie === 'string'
      ? [setCookie]
      : [];
  return cookies.map((raw) => raw.split(';')[0]).join('; ');
}

function mergeCookies(...parts: readonly string[]): string {
  return parts.filter((part) => part !== '').join('; ');
}

describe('SSO step-up satisfied over HTTP (task 23.8, design Q36 and D25)', () => {
  let app: App;
  let stub: OidcStub;
  let authPool: Awaited<ReturnType<typeof harnessPools>>['authPool'];

  beforeAll(async () => {
    const pools = await harnessPools();
    authPool = pools.authPool;
    state.pools.set('app', pools.appPool);
    state.pools.set('auth', pools.authPool);
    stub = await startOidcStub();
    app = await createAppFromEnv({
      DATABASE_URL: 'postgres://tayzu_app:pw@127.0.0.1:1/tayzu?sslmode=verify-full',
      AUTH_DATABASE_URL: 'postgres://tayzu_auth:pw@127.0.0.1:1/tayzu?sslmode=verify-full',
      BETTER_AUTH_SECRETS: `1:${TEST_SECRET}`,
      CERBOS_ADDRESS: 'localhost:3593',
      ALLOWED_ORIGINS: ORIGIN,
      VISMA_CONNECT_DISCOVERY_URL: stub.discoveryUrl,
      VISMA_CONNECT_CLIENT_ID: stub.clientId,
      VISMA_CONNECT_CLIENT_SECRET: stub.clientSecret,
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await stub.close();
    state.pools.clear();
  }, 60_000);

  /** An org owner whose current session was established through Visma Connect (`sso_sid` set). */
  async function ssoSessionUser(): Promise<{ cookie: string; sid: string }> {
    const tenant = await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: 'Sso Http Step-Up User',
      email: `sso-step-up-http-${randomUUID()}@example.test`,
      password: TEST_PASSWORD,
      organizationName: 'Sso Http Step-Up Org',
      organizationSlug: `sso-step-up-http-${randomUUID()}`,
      ip: randomIp(),
    });
    // Q43: an unenrolled admin/owner is limited to MFA enrollment on /v1, so enroll TOTP.
    // Enrolling revokes the bootstrap session; the session that follows is marked as the SSO one
    // below, so step-up is still decided by its MFA claim.
    const totpSecret = await enrollTotp(app, {
      password: TEST_PASSWORD,
      enrollmentCookie: tenant.cookie,
    });
    const cookie = await signInWithTotp(app, {
      email: tenant.email,
      password: TEST_PASSWORD,
      secret: totpSecret,
      origin: ORIGIN,
    });
    const sid = `sid-${randomUUID()}`;
    await authPool.query('update auth.session set sso_sid = $1 where user_id = $2', [
      sid,
      tenant.userId,
    ]);
    return { cookie, sid };
  }

  async function createBlueprint(cookie: string): Promise<string> {
    const identifier = `sso-risk-${randomUUID().slice(0, 8)}`;
    const created = await app.app.inject({
      method: 'POST',
      url: '/v1/blueprints',
      headers: {
        cookie,
        'content-type': 'application/json',
        origin: ORIGIN,
        ...csrfHeaders('POST'),
      },
      payload: JSON.stringify({
        identifier,
        title: { en: 'Risky' },
        schema: { properties: {}, required: [] },
      }),
    });
    expect(created.statusCode, 'precondition: the blueprint is created').toBe(200);
    return identifier;
  }

  function deleteBlueprint(cookie: string, identifier: string) {
    return app.app.inject({
      method: 'DELETE',
      url: `/v1/blueprints/${identifier}`,
      headers: {
        cookie,
        origin: ORIGIN,
        'x-forwarded-for': randomIp(),
        ...csrfHeaders('DELETE'),
      },
    });
  }

  function getBlueprint(cookie: string, identifier: string) {
    return app.app.inject({
      method: 'GET',
      url: `/v1/blueprints/${identifier}`,
      headers: { cookie, 'x-forwarded-for': randomIp() },
    });
  }

  /**
   * The step-up interceptor starts the Visma Connect re-authorization: the
   * first `DELETE` is refused and hands out the authorization URL. Returns the
   * URL and any cookie the response set (for example an OAuth state cookie).
   */
  async function startReauthorization(
    cookie: string,
    identifier: string,
  ): Promise<{ url: URL; extraCookie: string }> {
    const refused = await deleteBlueprint(cookie, identifier);
    expect(refused.statusCode, refused.body).toBe(403);
    const body = refused.json<{ code?: unknown; data?: { reauthorizationUrl?: unknown } }>();
    expect(body.code).toBe('AUTH_STEP_UP_REQUIRED');
    const raw = body.data?.reauthorizationUrl;
    if (typeof raw !== 'string') {
      throw new Error('the step-up refusal must carry data.reauthorizationUrl');
    }
    const url = new URL(raw);
    expect(url.origin, 'the URL points at the (stub) Visma Connect').toBe(stub.issuer);
    expect(url.searchParams.get('max_age'), 'D25 max_age').toBe('300');
    expect(url.searchParams.get('prompt'), 'D25 prompt').toBe('login');
    expect(url.searchParams.get('acr_values'), 'D25 acr_values').toBe('urn:idp:vismaconnect:mfa');
    return { url, extraCookie: cookieFrom(refused.headers['set-cookie']) };
  }

  /**
   * The person completes the re-authorization at the identity provider, and the
   * browser lands on the app's callback route by a query redirect (048 D6).
   */
  async function completeReauthorization(
    started: { url: URL; extraCookie: string },
    cookie: string,
  ): Promise<Awaited<ReturnType<typeof app.app.inject>>> {
    const approval = await fetch(started.url, { redirect: 'manual' });
    const callbackCookie = mergeCookies(cookie, started.extraCookie);
    const headers = (): Record<string, string> => ({
      'x-forwarded-for': randomIp(),
      host: 'localhost:3000',
      origin: ORIGIN,
      cookie: callbackCookie,
    });
    const location = approval.headers.get('location');
    if (approval.status >= 300 && approval.status < 400 && location !== null) {
      const target = new URL(location, ORIGIN);
      return app.app.inject({
        method: 'GET',
        url: `${target.pathname}${target.search}`,
        headers: headers(),
      });
    }
    // 048 task 6.5 (design D6): `response_mode=query`; the `form_post` `POST` callback is gone.
    throw new Error('the OIDC stub must redirect back by query (response_mode=query)');
  }

  it('A fresh Visma Connect re-authorization with an MFA method satisfies step-up: the deletion proceeds', async () => {
    const user = await ssoSessionUser();
    const identifier = await createBlueprint(user.cookie);
    const now = Math.floor(Date.now() / 1000);
    stub.setSubject({
      sub: `sso-step-up-sub-${randomUUID()}`,
      sid: user.sid,
      claims: { auth_time: now - 10, acr: 3, amr: ['pwd', 'otp'] },
    });

    // WHEN the step-up interceptor starts the re-authorization and the person completes it.
    const started = await startReauthorization(user.cookie, identifier);
    const callback = await completeReauthorization(started, user.cookie);
    expect(callback.statusCode, callback.body).toBeLessThan(400);

    // THEN the retried blueprints.delete proceeds.
    const response = await deleteBlueprint(user.cookie, identifier);
    expect(response.statusCode, response.body).toBeLessThan(300);
    expect((await getBlueprint(user.cookie, identifier)).statusCode).toBe(404);
  }, 60_000);

  it('A Visma Connect re-authorization without a qualifying MFA claim does not satisfy step-up: AUTH_STEP_UP_REQUIRED and the blueprint is not deleted', async () => {
    const user = await ssoSessionUser();
    const identifier = await createBlueprint(user.cookie);
    const now = Math.floor(Date.now() / 1000);
    // Fresh, but the returned claims carry only a password method and LoA 2.
    stub.setSubject({
      sub: `sso-step-up-sub-${randomUUID()}`,
      sid: user.sid,
      claims: { auth_time: now, acr: 2, amr: ['pwd'] },
    });

    const started = await startReauthorization(user.cookie, identifier);
    await completeReauthorization(started, user.cookie);

    // THEN the retried blueprints.delete still fails and nothing was deleted.
    const response = await deleteBlueprint(user.cookie, identifier);
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json<{ code?: unknown }>().code).toBe('AUTH_STEP_UP_REQUIRED');
    expect((await getBlueprint(user.cookie, identifier)).statusCode).toBe(200);
  }, 60_000);

  /**
   * 048 task 6.2 (design D6, Q7; `specs/auth-and-rbac/spec.md` of the change):
   *
   * Scenario "The re-authorization request is bound to the browser":
   * - **WHEN** a Visma Connect session starts a re-authorization
   * - **THEN** the authorization URL carries a single-use `state`, a `nonce` of at least 256 bits
   *   that no other start returned, and `response_mode=query`
   *
   * D6: `start` draws `randomBytes(32).toString('base64url')` (43 base64url characters) and
   * stores `{"token":...,"verifier":...,"nonce":...}` in the `sso-reauth-state:<state>` row, the
   * token first, because the pending-per-session bound matches the row's prefix.
   */
  it('The re-authorization request is bound to the browser: a fresh 256-bit nonce per start, response_mode=query, and the nonce stored in the binding after the token', async () => {
    const DEFAULT_MAX_PENDING = 5;
    const user = await ssoSessionUser();
    // The step-up interceptor runs before the operation, so the blueprint need not exist.
    const identifier = `no-such-${randomUUID().slice(0, 8)}`;

    const states: string[] = [];
    const nonces: string[] = [];
    const tokens = new Set<string>();
    for (let i = 0; i < DEFAULT_MAX_PENDING; i += 1) {
      // WHEN a Visma Connect session starts a re-authorization
      const { url } = await startReauthorization(user.cookie, identifier);

      // THEN the URL carries a state, a 256-bit nonce and response_mode=query
      const urlState = url.searchParams.get('state');
      const nonce = url.searchParams.get('nonce');
      expect(urlState ?? '', 'the URL carries a state').toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(nonce ?? '', 'the URL carries a 256-bit base64url nonce').toMatch(
        /^[A-Za-z0-9_-]{43}$/,
      );
      expect(url.searchParams.getAll('response_mode'), 'response_mode=query').toEqual(['query']);
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(nonce, 'the nonce is not the state').not.toBe(urlState);

      // AND the binding stored for the state keeps the token first and includes the nonce
      const stored = await authPool.query<{ value: string }>(
        'select value from auth.verification where identifier = $1 and expires_at > now()',
        [`sso-reauth-state:${urlState ?? ''}`],
      );
      expect(stored.rows, 'one state row per start').toHaveLength(1);
      const raw = stored.rows[0]?.value ?? '';
      const binding = JSON.parse(raw) as Record<string, unknown>;
      expect(Object.keys(binding)[0], 'the token stays the first key').toBe('token');
      expect(typeof binding['token']).toBe('string');
      expect(raw.startsWith(`{"token":${JSON.stringify(binding['token'])},`)).toBe(true);
      expect(typeof binding['verifier']).toBe('string');
      expect(binding['nonce'], 'the binding holds the nonce the URL sent').toBe(nonce);

      states.push(urlState ?? '');
      nonces.push(nonce ?? '');
      tokens.add(binding['token'] as string);
    }

    // AND no other start returned the same nonce (nor the same state)
    expect(new Set(nonces).size, 'a fresh nonce per start').toBe(DEFAULT_MAX_PENDING);
    expect(new Set(states).size, 'a fresh state per start').toBe(DEFAULT_MAX_PENDING);
    expect(tokens.size, 'every start is bound to the same session').toBe(1);

    // AND the pending-per-session bound (043 task 13.9b) still holds with the nonce in the value
    for (let i = 0; i < 2; i += 1) {
      await deleteBlueprint(user.cookie, identifier);
    }
    const [token] = [...tokens];
    const pending = await authPool.query<{ count: string }>(
      `select count(*)::text as count from auth.verification
       where identifier like 'sso-reauth-state:%' and expires_at > now()
         and position($1 in value) = 1`,
      [`{"token":${JSON.stringify(token)},`],
    );
    expect(Number(pending.rows[0]?.count), 'still bounded per session').toBe(DEFAULT_MAX_PENDING);
  }, 60_000);
});

/**
 * Task 25.5 (design Q64, Q36): the SSO step-up re-authorization callback URL is
 * built from `BETTER_AUTH_URL` when it is set, and from the first allowed origin
 * only in test (when `BETTER_AUTH_URL` is unset). The task cites no spec
 * scenario; the behavior comes from design Q64 and Q36.
 *
 * ## Production symbols expected
 *
 * - `createApp` / `createAppFromEnv` build the `redirectUri` handed to
 *   `createReauthorization` (`server.ts`) from `BETTER_AUTH_URL` (the host's
 *   configured public base URL) plus the re-auth callback path, instead of from
 *   `allowedOrigins[0]`. `allowedOrigins[0]` remains the fallback when
 *   `BETTER_AUTH_URL` is unset (test only). No new export is needed.
 */
describe('SSO step-up callback URL base (task 25.5, design Q64 and Q36)', () => {
  const API_URL = 'https://api.tayzu.test';
  const CALLBACK_PATH = '/v1/auth/visma-connect/reauthorize/callback';

  let stub: OidcStub;
  let closers: (() => Promise<void>)[] = [];
  let authPool: Awaited<ReturnType<typeof harnessPools>>['authPool'];

  beforeAll(async () => {
    const pools = await harnessPools();
    authPool = pools.authPool;
    state.pools.set('app', pools.appPool);
    state.pools.set('auth', pools.authPool);
    stub = await startOidcStub();
  }, 60_000);

  afterAll(async () => {
    for (const close of closers) {
      await close();
    }
    closers = [];
    await stub.close();
    state.pools.clear();
  }, 60_000);

  async function buildApp(extra: Record<string, string>): Promise<App> {
    const built = await createAppFromEnv({
      DATABASE_URL: 'postgres://tayzu_app:pw@127.0.0.1:1/tayzu?sslmode=verify-full',
      AUTH_DATABASE_URL: 'postgres://tayzu_auth:pw@127.0.0.1:1/tayzu?sslmode=verify-full',
      BETTER_AUTH_SECRETS: `1:${TEST_SECRET}`,
      CERBOS_ADDRESS: 'localhost:3593',
      ALLOWED_ORIGINS: ORIGIN,
      VISMA_CONNECT_DISCOVERY_URL: stub.discoveryUrl,
      VISMA_CONNECT_CLIENT_ID: stub.clientId,
      VISMA_CONNECT_CLIENT_SECRET: stub.clientSecret,
      ...extra,
    });
    closers.push(() => built.close());
    return built;
  }

  /** The `redirect_uri` the step-up refusal sends to Visma Connect for an SSO-session owner. */
  async function redirectUriSentToVisma(app: App): Promise<string | null> {
    const tenant = await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: 'Sso Callback Base User',
      email: `sso-callback-base-${randomUUID()}@example.test`,
      password: TEST_PASSWORD,
      organizationName: 'Sso Callback Base Org',
      organizationSlug: `sso-callback-base-${randomUUID()}`,
      ip: randomIp(),
    });
    const totpSecret = await enrollTotp(app, {
      password: TEST_PASSWORD,
      enrollmentCookie: tenant.cookie,
    });
    const cookie = await signInWithTotp(app, {
      email: tenant.email,
      password: TEST_PASSWORD,
      secret: totpSecret,
      origin: ORIGIN,
    });
    await authPool.query('update auth.session set sso_sid = $1 where user_id = $2', [
      `sid-${randomUUID()}`,
      tenant.userId,
    ]);
    // The step-up interceptor runs before the operation, so the blueprint need not exist.
    const refused = await app.app.inject({
      method: 'DELETE',
      url: `/v1/blueprints/cb-base-${randomUUID().slice(0, 8)}`,
      headers: {
        cookie,
        origin: ORIGIN,
        'x-forwarded-for': randomIp(),
        ...csrfHeaders('DELETE'),
      },
    });
    expect(refused.statusCode, refused.body).toBe(403);
    const body = refused.json<{ code?: unknown; data?: { reauthorizationUrl?: unknown } }>();
    expect(body.code).toBe('AUTH_STEP_UP_REQUIRED');
    const raw = body.data?.reauthorizationUrl;
    return typeof raw === 'string' ? (new URL(raw).searchParams.get('redirect_uri') ?? null) : null;
  }

  it('the redirect_uri sent to Visma Connect is under BETTER_AUTH_URL when it differs from the allowed origin', async () => {
    // 048 D3: BETTER_AUTH_URL's origin is listed, after the first allowed origin it differs from.
    const app = await buildApp({
      BETTER_AUTH_URL: API_URL,
      ALLOWED_ORIGINS: `${ORIGIN},${API_URL}`,
    });

    const redirectUri = await redirectUriSentToVisma(app);

    expect(redirectUri, 'the authorization URL carries a redirect_uri').not.toBeNull();
    const parsed = new URL(redirectUri ?? '');
    expect(parsed.origin, 'built on BETTER_AUTH_URL, not on the allowed origin').toBe(API_URL);
    expect(parsed.pathname).toBe(CALLBACK_PATH);
  }, 60_000);

  it('the redirect_uri falls back to the first allowed origin only when BETTER_AUTH_URL is unset (test)', async () => {
    const app = await buildApp({});

    const redirectUri = await redirectUriSentToVisma(app);

    expect(redirectUri, 'the authorization URL carries a redirect_uri').not.toBeNull();
    const parsed = new URL(redirectUri ?? '');
    expect(parsed.origin).toBe(ORIGIN);
    expect(parsed.pathname).toBe(CALLBACK_PATH);
  }, 60_000);
});

/**
 * 048 task 6.3 (design D6, Resolved decision Q7; `specs/auth-and-rbac/spec.md` of the change,
 * requirement "Step-up authentication for high-risk operations").
 *
 * Scenario "A callback in another browser stores nothing" (verbatim):
 * - **GIVEN** a re-authorization started by session `A`
 * - **WHEN** its callback arrives with no session cookie, or with the cookie of session `B`
 * - **THEN** no result is stored for either session, the failure is logged with the reason
 *   `session_mismatch`, and the answer is the same as for any failed callback
 *
 * D6, the order inside `complete`: (2) the single-use consume of the state row, then (3) the
 * session token of the request's cookie compared with the bound token; no cookie or a different
 * session is `session_mismatch` (WARN, the same 303 to `STEP_UP_FAILED_LOCATION`, or `400`
 * without the web app). "Consuming the state before the cookie check is deliberate: ... a state
 * is never usable twice", so a replay of the same callback with `A`'s cookie fails as
 * `invalid_state`. Task 6.3 adds: the matching cookie still completes.
 *
 * ## Harness
 *
 * Two apps from `createAppFromEnv` over the harness pools and the local OIDC stub: one with
 * `WEB_DIST_DIR` set to the committed fixture `__fixtures__/web-dist/` (read only), one without.
 * Session `B` is a second org owner whose session was also established through Visma Connect, so
 * its cookie is a valid SSO session cookie, only not the bound one. The stub's subject carries
 * qualifying, fresh claims and `A`'s `sid`, so a result stored for `A` would satisfy the guard:
 * "stores nothing" is observed both in `auth.verification` and through `A`'s next high-risk call.
 * Log records come from the registered telemetry harness, counted before each callback (the
 * tests of a file run in sequence).
 *
 * ## Production symbols expected (the red phase)
 *
 * - `complete` (`apps/api/src/reauthorization.ts`) receives the callback's headers and reads the
 *   session cookie with `ssoSession(headers)`; the callback route in `server.ts` passes them.
 * - `auth.security.reauthorization_failed` carries `tayzu.auth.reauthorization.reason`
 *   `session_mismatch` (declared by task 6.1).
 */
describe('A callback in another browser stores nothing (048 task 6.3, design D6, Q7)', () => {
  const CALLBACK_PATH = '/v1/auth/visma-connect/reauthorize/callback';
  const COMPLETE = '/step-up/complete';
  const FAILED = '/step-up/complete?result=failed';
  const REAUTH_FAILED = 'auth.security.reauthorization_failed';
  const REASON = 'tayzu.auth.reauthorization.reason';
  const RESULT_PREFIX = 'sso-reauth-result:';
  const SEVERITY_WARN = 13;
  const FIXTURE_WEB_DIST = fileURLToPath(new URL('./__fixtures__/web-dist/', import.meta.url));

  type Injected = Awaited<ReturnType<App['app']['inject']>>;
  type Variant = 'web' | 'api';

  const VARIANTS: readonly { readonly variant: Variant; readonly label: string }[] = [
    { variant: 'web', label: 'with the web app (WEB_DIST_DIR set): 303 to the failure location' },
    { variant: 'api', label: 'without the web app: 400' },
  ];

  let harness: TelemetryTestHarness;
  let stub: OidcStub;
  let authPool: Awaited<ReturnType<typeof harnessPools>>['authPool'];
  const apps = new Map<Variant, App>();

  beforeAll(async () => {
    if ('error' in registration) {
      throw new Error(
        `the telemetry test harness failed to register: ${String(registration.error)}`,
        { cause: registration.error },
      );
    }
    harness = registration.harness;
    const pools = await harnessPools();
    authPool = pools.authPool;
    state.pools.set('app', pools.appPool);
    state.pools.set('auth', pools.authPool);
    stub = await startOidcStub();
    const env = {
      DATABASE_URL: 'postgres://tayzu_app:pw@127.0.0.1:1/tayzu?sslmode=verify-full',
      AUTH_DATABASE_URL: 'postgres://tayzu_auth:pw@127.0.0.1:1/tayzu?sslmode=verify-full',
      BETTER_AUTH_SECRETS: `1:${TEST_SECRET}`,
      CERBOS_ADDRESS: 'localhost:3593',
      ALLOWED_ORIGINS: ORIGIN,
      VISMA_CONNECT_DISCOVERY_URL: stub.discoveryUrl,
      VISMA_CONNECT_CLIENT_ID: stub.clientId,
      VISMA_CONNECT_CLIENT_SECRET: stub.clientSecret,
    };
    apps.set('web', await createAppFromEnv({ ...env, WEB_DIST_DIR: FIXTURE_WEB_DIST }));
    apps.set('api', await createAppFromEnv(env));
  }, 60_000);

  afterAll(async () => {
    for (const app of apps.values()) {
      await app.close();
    }
    apps.clear();
    await stub.close();
    state.pools.clear();
  }, 60_000);

  function appFor(variant: Variant): App {
    const app = apps.get(variant);
    if (app === undefined) {
      throw new Error(`the ${variant} app was not built`);
    }
    return app;
  }

  interface SsoUser {
    readonly cookie: string;
    readonly sid: string;
    readonly userId: string;
  }

  /** An org owner whose current session was established through Visma Connect (`sso_sid` set). */
  async function ssoSessionUser(app: App): Promise<SsoUser> {
    const tenant = await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: 'Sso Callback Binding User',
      email: `sso-callback-binding-${randomUUID()}@example.test`,
      password: TEST_PASSWORD,
      organizationName: 'Sso Callback Binding Org',
      organizationSlug: `sso-callback-binding-${randomUUID()}`,
      ip: randomIp(),
    });
    const totpSecret = await enrollTotp(app, {
      password: TEST_PASSWORD,
      enrollmentCookie: tenant.cookie,
    });
    const cookie = await signInWithTotp(app, {
      email: tenant.email,
      password: TEST_PASSWORD,
      secret: totpSecret,
      origin: ORIGIN,
    });
    const sid = `sid-${randomUUID()}`;
    await authPool.query('update auth.session set sso_sid = $1 where user_id = $2', [
      sid,
      tenant.userId,
    ]);
    return { cookie, sid, userId: tenant.userId };
  }

  /** Qualifying, fresh claims for `user`'s `sid`: a result stored for that session satisfies step-up. */
  function qualifyingSubject(user: SsoUser): void {
    stub.setSubject({
      sub: `sso-callback-binding-sub-${randomUUID()}`,
      sid: user.sid,
      claims: { auth_time: Math.floor(Date.now() / 1000) - 10, acr: 3, amr: ['pwd', 'otp'] },
    });
  }

  function highRiskCall(app: App, cookie: string, identifier: string): Promise<Injected> {
    return app.app.inject({
      method: 'DELETE',
      url: `/v1/blueprints/${identifier}`,
      headers: {
        cookie,
        origin: ORIGIN,
        'x-forwarded-for': randomIp(),
        ...csrfHeaders('DELETE'),
      },
    });
  }

  /** Session `A` starts a re-authorization; the step-up interceptor runs before the operation. */
  async function start(app: App, cookie: string): Promise<URL> {
    const refused = await highRiskCall(app, cookie, `no-such-${randomUUID().slice(0, 8)}`);
    expect(refused.statusCode, refused.body).toBe(403);
    const body = refused.json<{ code?: unknown; data?: { reauthorizationUrl?: unknown } }>();
    expect(body.code).toBe('AUTH_STEP_UP_REQUIRED');
    const raw = body.data?.reauthorizationUrl;
    if (typeof raw !== 'string') {
      throw new Error('the step-up refusal must carry data.reauthorizationUrl');
    }
    return new URL(raw);
  }

  /** The stub approves the request and redirects the browser to the callback (`response_mode=query`). */
  async function approve(url: URL): Promise<string> {
    const approval = await fetch(url, { redirect: 'manual' });
    const location = approval.headers.get('location');
    expect(approval.status, 'the stub answers response_mode=query with a redirect').toBe(302);
    const target = new URL(location ?? '', ORIGIN);
    expect(target.pathname).toBe(CALLBACK_PATH);
    expect(target.searchParams.get('code'), 'the redirect carries a code').not.toBeNull();
    expect(target.searchParams.get('state'), 'the redirect carries the state').toBe(
      url.searchParams.get('state'),
    );
    return `${target.pathname}${target.search}`;
  }

  /** The browser lands on the callback, with `cookie` when it holds one. */
  function callback(app: App, path: string, cookie: string | undefined): Promise<Injected> {
    return app.app.inject({
      method: 'GET',
      url: path,
      headers: {
        'x-forwarded-for': randomIp(),
        host: 'localhost:3000',
        ...(cookie === undefined ? {} : { cookie }),
      },
    });
  }

  /** The answer of a failed callback: the 303 to the failure location, or the `400` without the web app. */
  function expectFailedAnswer(variant: Variant, response: Injected): void {
    if (variant === 'web') {
      expect(response.statusCode, response.body).toBe(303);
      expect(response.headers.location).toBe(FAILED);
    } else {
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toEqual({ defined: false, code: 'BAD_REQUEST', status: 400 });
    }
  }

  async function failureRecordCount(): Promise<number> {
    await harness.forceFlush();
    return [...harness.logExporter.getFinishedLogRecords()].filter(
      (record) => record.eventName === REAUTH_FAILED,
    ).length;
  }

  async function failureRecordsSince(before: number) {
    await harness.forceFlush();
    return [...harness.logExporter.getFinishedLogRecords()]
      .filter((record) => record.eventName === REAUTH_FAILED)
      .slice(before);
  }

  /** Exactly one `reauthorization_failed` record since `before`, WARN, carrying only `reason`. */
  async function expectOneFailure(before: number, reason: string): Promise<void> {
    const records = await failureRecordsSince(before);
    expect(
      records.map((record) => record.attributes[REASON]),
      `one "${REAUTH_FAILED}" record with reason ${reason}`,
    ).toEqual([reason]);
    for (const record of records) {
      expect(record.instrumentationScope.name).toBe('@tayzu/auth');
      expect(record.severityNumber, `${REAUTH_FAILED} is WARN`).toBe(SEVERITY_WARN);
      expect(Object.keys(record.attributes), 'only the reason, no tenant').toEqual([REASON]);
    }
  }

  /** `sso-reauth-result:` rows stored for any session of the given users. */
  async function resultRows(userIds: readonly string[]): Promise<number> {
    const found = await authPool.query<{ count: string }>(
      `select count(*)::text as count from auth.verification v
       join auth.session s on v.identifier = $1 || s.token
       where s.user_id = any($2)`,
      [RESULT_PREFIX, userIds],
    );
    return Number(found.rows[0]?.count);
  }

  /** The state row of the started re-authorization, still unconsumed. */
  async function stateRows(url: URL): Promise<number> {
    const found = await authPool.query<{ count: string }>(
      `select count(*)::text as count from auth.verification
       where identifier = $1 and expires_at > now()`,
      [`sso-reauth-state:${url.searchParams.get('state') ?? ''}`],
    );
    return Number(found.rows[0]?.count);
  }

  /**
   * The mismatched callback stores nothing, logs `session_mismatch`, answers like any failed
   * callback and consumes the state: the replay with `A`'s own cookie fails as `invalid_state`.
   */
  async function expectMismatchStoresNothing(
    variant: Variant,
    sessionA: SsoUser,
    callbackCookie: string | undefined,
    otherUserIds: readonly string[],
  ): Promise<void> {
    const app = appFor(variant);
    qualifyingSubject(sessionA);

    // GIVEN a re-authorization started by session A
    const started = await start(app, sessionA.cookie);
    const path = await approve(started);
    expect(await stateRows(started), 'precondition: the state is pending').toBe(1);

    // WHEN its callback arrives with no session cookie, or with the cookie of session B
    const before = await failureRecordCount();
    const response = await callback(app, path, callbackCookie);

    // THEN the answer is the same as for any failed callback
    expectFailedAnswer(variant, response);
    // AND the failure is logged with the reason session_mismatch
    await expectOneFailure(before, 'session_mismatch');
    // AND no result is stored for either session
    expect(
      await resultRows([sessionA.userId, ...otherUserIds]),
      'no sso-reauth-result row for A or B',
    ).toBe(0);
    // AND the state is consumed (D6: the consume runs before the cookie check)
    expect(await stateRows(started), 'the state row is consumed').toBe(0);

    // AND a replay of the same callback with A's own cookie fails as invalid_state
    const beforeReplay = await failureRecordCount();
    const replay = await callback(app, path, sessionA.cookie);
    expectFailedAnswer(variant, replay);
    await expectOneFailure(beforeReplay, 'invalid_state');
    expect(await resultRows([sessionA.userId, ...otherUserIds]), 'still nothing stored').toBe(0);

    // AND A's next high-risk call still requires step-up
    const next = await highRiskCall(app, sessionA.cookie, `no-such-${randomUUID().slice(0, 8)}`);
    expect(next.statusCode, next.body).toBe(403);
    expect(next.json<{ code?: unknown }>().code).toBe('AUTH_STEP_UP_REQUIRED');
  }

  for (const { variant, label } of VARIANTS) {
    it(`A callback in another browser stores nothing: no session cookie, ${label}; the state is consumed`, async () => {
      const app = appFor(variant);
      const sessionA = await ssoSessionUser(app);

      await expectMismatchStoresNothing(variant, sessionA, undefined, []);
    }, 60_000);

    it(`A callback in another browser stores nothing: the cookie of session B, ${label}; the state is consumed`, async () => {
      const app = appFor(variant);
      const sessionA = await ssoSessionUser(app);
      const sessionB = await ssoSessionUser(app);

      await expectMismatchStoresNothing(variant, sessionA, sessionB.cookie, [sessionB.userId]);
    }, 60_000);

    it(`A callback in another browser stores nothing: the matching cookie still completes, ${variant === 'web' ? 'with the web app (303 to the completion location)' : 'without the web app (200)'}`, async () => {
      const app = appFor(variant);
      const sessionA = await ssoSessionUser(app);
      qualifyingSubject(sessionA);

      const started = await start(app, sessionA.cookie);
      const path = await approve(started);
      const before = await failureRecordCount();
      const response = await callback(app, path, sessionA.cookie);

      if (variant === 'web') {
        expect(response.statusCode, response.body).toBe(303);
        expect(response.headers.location).toBe(COMPLETE);
      } else {
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toEqual({});
      }
      expect(await failureRecordsSince(before), 'no reauthorization_failed record').toEqual([]);
      expect(await resultRows([sessionA.userId]), 'the result is stored for session A').toBe(1);
      expect(await stateRows(started), 'the state row is consumed').toBe(0);

      // The next high-risk call is no longer refused for step-up (the blueprint does not exist).
      const next = await highRiskCall(app, sessionA.cookie, `no-such-${randomUUID().slice(0, 8)}`);
      expect(next.statusCode, next.body).toBe(404);
    }, 60_000);
  }

  /**
   * 048 task 6.4 (design D6, Resolved decisions Q7 and Q22; `specs/auth-and-rbac/spec.md` of the
   * change, requirement "Step-up authentication for high-risk operations").
   *
   * Scenario "A token with another nonce stores nothing" (verbatim):
   * - **GIVEN** a re-authorization started by a session that holds its cookie at the callback
   * - **WHEN** the returned ID token's `nonce` differs from the one the start sent
   * - **THEN** no result is stored and the next high-risk call still fails with
   *   `AUTH_STEP_UP_REQUIRED`
   *
   * D6, step (6) of `complete`: after the code exchange, `verifyReauthorizationIdToken(idToken,
   * { discoveryUrl, clientId, nonce })` checks that the token's `nonce` equals the bound value; a
   * failure is `exchange_failed` (Q22) and stores nothing. The stub's subject carries qualifying,
   * fresh claims and the session's `sid`, so only the `nonce` is wrong: a stored result would
   * satisfy the guard. The stub's `setNonceOverride` makes the authorization issue another
   * `nonce`; it is reset after every test.
   */
  describe('A token with another nonce stores nothing (048 task 6.4, design D6, Q22)', () => {
    for (const { variant, label } of VARIANTS) {
      it(`A token with another nonce stores nothing: ${label}; exchange_failed is logged and the next blueprints.delete still fails with AUTH_STEP_UP_REQUIRED`, async () => {
        const app = appFor(variant);
        // GIVEN a re-authorization started by a session that holds its cookie at the callback
        const session = await ssoSessionUser(app);
        qualifyingSubject(session);
        const started = await start(app, session.cookie);
        const sentNonce = started.searchParams.get('nonce');
        expect(sentNonce ?? '', 'precondition: the start sent a nonce').toMatch(
          /^[A-Za-z0-9_-]{43}$/,
        );

        // WHEN the returned ID token's nonce differs from the one the start sent
        const otherNonce = randomBytes(32).toString('base64url');
        expect(otherNonce, 'precondition: another nonce').not.toBe(sentNonce);
        stub.setNonceOverride(otherNonce);
        let response: Injected;
        let before: number;
        try {
          const path = await approve(started);
          before = await failureRecordCount();
          response = await callback(app, path, session.cookie);
        } finally {
          stub.setNonceOverride(null);
        }

        // THEN no result is stored
        expect(await resultRows([session.userId]), 'no sso-reauth-result row').toBe(0);
        // AND the failure is logged with the reason exchange_failed (Q22), answered like any
        // failed callback
        await expectOneFailure(before, 'exchange_failed');
        expectFailedAnswer(variant, response);

        // AND the next high-risk call still fails with AUTH_STEP_UP_REQUIRED
        const next = await highRiskCall(app, session.cookie, `no-such-${randomUUID().slice(0, 8)}`);
        expect(next.statusCode, next.body).toBe(403);
        expect(next.json<{ code?: unknown }>().code).toBe('AUTH_STEP_UP_REQUIRED');
      }, 60_000);
    }
  });
});
