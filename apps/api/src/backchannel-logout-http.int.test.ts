/**
 * Integration test for task 23.7 (openspec/changes/002-auth-and-rbac; design
 * Resolved decision Q35 and D26; `specs/auth-and-rbac/spec.md`, requirement
 * "Back-channel logout from Visma Connect revokes the matching sessions").
 *
 * Scenario covered (verbatim from the spec):
 *
 * - "A valid logout token revokes the matching session": GIVEN an active Tayzu
 *   session established through Visma Connect, WHEN a valid back-channel logout
 *   token naming that session's Visma Connect session id is received, THEN that
 *   session fails exactly as `CATALOG_CONTEXT_REQUIRED` on its next use.
 *
 * Task 23.7: the session is created by the REAL SSO sign-in of 23.6 (no
 * `update auth.session set sso_sid`), through Fastify on the app built by the
 * production bootstrap (`createAppFromEnv`), with SSO pointed at the task-19.1
 * local OIDC stub. A same-user local session must stay valid.
 *
 * ## Production symbols expected
 *
 * - The Visma sign-in stores the ID token `sid` in `auth.session.sso_sid`
 *   (task 23.5), the callback works over Fastify (task 23.6), and the SSO
 *   session resolves a catalog context (`GET /v1/blueprints` answers 200).
 * - `POST /v1/auth/visma-connect/backchannel-logout` (task 22.x) revokes that
 *   session. If the whole scenario already passes, the earlier tasks already
 *   deliver 23.7 and no production change is needed.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { bootstrapTestTenant } from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { startOidcStub, type OidcStub } from '../../../packages/auth/src/__fixtures__/oidc-stub.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { enrollTotp, signInWithTotp } from './__fixtures__/fresh-mfa.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createAppFromEnv } from './bootstrap.js';
import type { App } from './server.js';

const poolState = vi.hoisted(() => ({ pools: new Map<string, unknown>() }));

// `createPool` hands out the harness pools (production URLs need
// `sslmode=verify-full`); `end` is a no-op so the shared pools survive.
vi.mock('@tayzu/db', async (importActual) => {
  const actual = await importActual<typeof import('@tayzu/db')>();
  return {
    ...actual,
    createPool: vi.fn((url: string) => {
      const real = poolState.pools.get(url.includes('tayzu_auth') ? 'auth' : 'app') as object;
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

const ORIGIN = 'http://localhost:3000';
const PROVIDER_ID = 'visma-connect';
const ROUTE = '/v1/auth/visma-connect/backchannel-logout';
const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

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

describe('back-channel logout over HTTP after a real SSO sign-in (task 23.7, design Q35, D26)', () => {
  let app: App;
  let stub: OidcStub;
  let pools: Awaited<ReturnType<typeof harnessPools>>;

  beforeAll(async () => {
    pools = await harnessPools();
    poolState.pools.set('app', pools.appPool);
    poolState.pools.set('auth', pools.authPool);
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
    poolState.pools.clear();
  }, 60_000);

  function post(url: string, headers: Record<string, string>, payload: string) {
    return app.app.inject({
      method: 'POST',
      url,
      headers: {
        'x-forwarded-for': randomIp(),
        origin: ORIGIN,
        host: 'localhost:3000',
        ...headers,
      },
      payload,
    });
  }

  /** Runs the whole SSO round trip through Fastify; returns the final response. */
  async function ssoSignIn(): Promise<Awaited<ReturnType<typeof post>>> {
    const initiated = await post(
      '/api/auth/sign-in/social',
      { 'content-type': 'application/json' },
      JSON.stringify({ provider: PROVIDER_ID, callbackURL: '/' }),
    );
    expect(initiated.statusCode, initiated.body).toBe(200);
    const { url } = initiated.json<{ url: string }>();
    const page = await (await fetch(url, { redirect: 'manual' })).text();
    const inputs = Object.fromEntries(
      [...page.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [
        m[1] ?? '',
        m[2] ?? '',
      ]),
    );
    const code = inputs['code'];
    const state = inputs['state'];
    if (code === undefined || state === undefined) {
      throw new Error('the OIDC stub did not return code and state');
    }
    const params = new URLSearchParams({
      code,
      state,
      ...(inputs['iss'] === undefined ? {} : { iss: inputs['iss'] }),
    });
    const cookie = cookieFrom(initiated.headers['set-cookie']);
    const posted = await post(
      `/api/auth/callback/${PROVIDER_ID}`,
      {
        'content-type': 'application/x-www-form-urlencoded',
        ...(cookie === '' ? {} : { cookie }),
      },
      params.toString(),
    );
    const location = posted.headers.location;
    if (
      posted.statusCode >= 300 &&
      posted.statusCode < 400 &&
      typeof location === 'string' &&
      new URL(location, ORIGIN).pathname.endsWith(`/callback/${PROVIDER_ID}`)
    ) {
      const target = new URL(location, ORIGIN);
      return app.app.inject({
        method: 'GET',
        url: `${target.pathname}${target.search}`,
        headers: {
          'x-forwarded-for': randomIp(),
          host: 'localhost:3000',
          ...(cookie === '' ? {} : { cookie }),
        },
      });
    }
    return posted;
  }

  function useSession(cookie: string) {
    return app.app.inject({
      method: 'GET',
      url: '/v1/blueprints',
      headers: { cookie, 'x-forwarded-for': randomIp() },
    });
  }

  function logoutClaims(sid: string): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000);
    return {
      iss: stub.issuer,
      aud: stub.clientId,
      sub: `bcl-http-sub-${randomUUID()}`,
      sid,
      iat: now,
      exp: now + 300,
      jti: randomUUID(),
      events: { [LOGOUT_EVENT]: {} },
    };
  }

  it('A valid logout token revokes the matching session: the cookie of the real SSO sign-in fails as CATALOG_CONTEXT_REQUIRED while a same-user local session stays valid', async () => {
    const suffix = randomUUID();
    const email = `bcl-http-${suffix}@example.test`;
    const tenant = await bootstrapTestTenant(app.auth, {
      name: 'Backchannel Http Person',
      email,
      password: TEST_PASSWORD,
      organizationName: `Backchannel Http Org ${suffix}`,
      organizationSlug: `bcl-http-${suffix}`,
      ip: randomIp(),
    });
    // Q43: an unenrolled admin/owner is limited to MFA enrollment on /v1, so enroll TOTP first.
    const totpSecret = await enrollTotp(app, {
      password: TEST_PASSWORD,
      enrollmentCookie: tenant.cookie,
    });
    const sub = `bcl-http-link-${suffix}`;
    await pools.authPool.query(
      `insert into auth.account (id, account_id, provider_id, user_id, created_at, updated_at)
       values ($1, $2, $3, $4, now(), now())`,
      [randomUUID(), sub, PROVIDER_ID, tenant.userId],
    );
    const sid = `sid-${randomUUID()}`;
    stub.setSubject({ sub, email: `other-${suffix}@example.test`, name: 'Linked', sid });

    // GIVEN an active session established through Visma Connect (real sign-in).
    const signedIn = await ssoSignIn();
    expect(signedIn.statusCode, signedIn.body).toBeLessThan(400);
    const ssoCookie = cookieFrom(signedIn.headers['set-cookie']);
    expect(ssoCookie, 'a session cookie is issued').toContain('session_token');
    const stored = await pools.authPool.query<{ n: string }>(
      'select count(*)::text as n from auth.session where user_id = $1 and sso_sid = $2',
      [tenant.userId, sid],
    );
    expect(Number(stored.rows[0]?.n ?? 0), 'the SSO session carries the token sid').toBe(1);

    // AND a same-user local session.
    const localCookie = await signInWithTotp(app, {
      email,
      password: TEST_PASSWORD,
      secret: totpSecret,
      origin: ORIGIN,
    });
    const localSessions = await pools.authPool.query<{ n: string }>(
      'select count(*)::text as n from auth.session where user_id = $1 and sso_sid is null',
      [tenant.userId],
    );
    expect(
      Number(localSessions.rows[0]?.n ?? 0),
      'the local session belongs to the same user',
    ).toBeGreaterThan(0);

    expect((await useSession(ssoCookie)).statusCode, 'the SSO session works before').toBe(200);
    expect((await useSession(localCookie)).statusCode, 'the local session works before').toBe(200);

    // WHEN a valid back-channel logout token naming that sid is received.
    const response = await app.app.inject({
      method: 'POST',
      url: ROUTE,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-for': randomIp(),
      },
      payload: new URLSearchParams({
        logout_token: stub.signJwt(logoutClaims(sid), { typ: 'logout+jwt' }),
      }).toString(),
    });
    expect(response.statusCode).toBe(200);

    // THEN the SSO session fails exactly as CATALOG_CONTEXT_REQUIRED.
    const revoked = await useSession(ssoCookie);
    expect(revoked.statusCode).toBe(401);
    expect(revoked.json<{ code: string }>().code).toBe('CATALOG_CONTEXT_REQUIRED');
    expect((await useSession(localCookie)).statusCode, 'the local session stays valid').toBe(200);
  }, 60_000);
});
