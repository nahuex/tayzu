/**
 * Integration test for task 23.8 (openspec/changes/002-auth-and-rbac; design
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
 * - The callback route (any path the `redirect_uri` names; the test follows it,
 *   as a `GET` with the query or as a `form_post` `POST`) exchanges the code,
 *   validates the returned ID token's `auth_time`, `acr`, `amr` and `sid`
 *   server-side, and records the result so that the caller's next request with
 *   the same session cookie reaches the guard as `reauthorization`. A
 *   successful callback answers below 400. What a failed callback answers is
 *   left open: the tests only observe the retried `DELETE`.
 * - No Cerbos policy change and no migration.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { enrollTotp, signInWithTotp } from './__fixtures__/fresh-mfa.js';
import { bootstrapTestTenant } from '../../../packages/auth/src/__fixtures__/admin-user.js';
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
      DATABASE_URL: 'postgres://tayzu_app:pw@db.invalid:5432/tayzu?sslmode=verify-full',
      AUTH_DATABASE_URL: 'postgres://tayzu_auth:pw@db.invalid:5432/tayzu?sslmode=verify-full',
      BETTER_AUTH_SECRET: TEST_SECRET,
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
   * browser lands on the app's callback route (query redirect or `form_post`).
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
    const page = await approval.text();
    const action = /<form method="post" action="([^"]+)"/.exec(page)?.[1];
    if (action === undefined) {
      throw new Error('the OIDC stub returned neither a redirect nor a form_post page');
    }
    const params = new URLSearchParams(
      Object.fromEntries(
        [...page.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [
          m[1] ?? '',
          m[2] ?? '',
        ]),
      ),
    );
    const target = new URL(action, ORIGIN);
    return app.app.inject({
      method: 'POST',
      url: `${target.pathname}${target.search}`,
      headers: { ...headers(), 'content-type': 'application/x-www-form-urlencoded' },
      payload: params.toString(),
    });
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
});
