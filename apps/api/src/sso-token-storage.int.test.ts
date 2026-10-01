/**
 * Integration test for task 23.19 (openspec/changes/002-auth-and-rbac; design
 * Resolved decision Q48 and D23; `specs/auth-and-rbac/spec.md`, requirement
 * "Visma Connect SSO sign-in").
 *
 * Task 23.19: "`account.encryptOAuthTokens: true`, so Visma access and ID
 * tokens are encrypted at rest in `auth.account`. Verify: a real SSO sign-in
 * leaving no plaintext token in `auth.account`, and the tokens still decrypting
 * for the step-up flow."
 *
 * This is a hardening task with no new spec scenario. The behavior is pinned
 * to the requirement's existing scenario: "Sign-in with a linked Visma Connect
 * account succeeds" (the sign-in must keep working once tokens are encrypted).
 *
 * ## Harness
 *
 * The app is built by the production bootstrap, `createAppFromEnv(env)`, with
 * `VISMA_CONNECT_*` pointing at the task-19.1 local OIDC stub, and every request
 * goes through Fastify (`app.app.inject`) with a fresh random `x-forwarded-for`.
 * `@tayzu/db`'s `createPool` is mocked to hand out the harness pools, as in
 * `step-up-sso-http.int.test.ts`. The stub's authorization endpoint and its
 * `/userinfo` endpoint (which accepts only the plaintext access token it
 * issued) are reached with `fetch`.
 *
 * ## Production symbols expected (the red phase)
 *
 * - `packages/auth/src/auth.ts`: Better Auth option `account: {
 *   encryptOAuthTokens: true }`. No new exported symbol, no migration.
 * - Consumers that read the tokens from the `account` row through the raw
 *   adapter (`ssoSidForSignIn`, which parses the ID token's `sid`) must decrypt
 *   first, so `auth.session.sso_sid` is still populated after sign-in.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { bootstrapTestTenant } from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { startOidcStub, type OidcStub } from '../../../packages/auth/src/__fixtures__/oidc-stub.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
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
const PROVIDER_ID = 'visma-connect';

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

describe('Visma Connect tokens are encrypted at rest (task 23.19, design Q48 and D23)', () => {
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
    const oauthState = inputs['state'];
    if (code === undefined || oauthState === undefined) {
      throw new Error('the OIDC stub did not return code and state');
    }
    const params = new URLSearchParams({
      code,
      state: oauthState,
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

  async function userinfoStatus(token: string): Promise<number> {
    const response = await fetch(`${stub.issuer}/userinfo`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return response.status;
  }

  it('A real SSO sign-in leaves no plaintext Visma token in auth.account, and the tokens still decrypt for the step-up flow', async () => {
    const tenant = await bootstrapTestTenant(app.auth, {
      name: 'Token Storage Person',
      email: `sso-token-storage-${randomUUID()}@example.test`,
      password: TEST_PASSWORD,
      organizationName: 'Token Storage Org',
      organizationSlug: `sso-token-storage-${randomUUID()}`,
      ip: randomIp(),
    });
    const sub = `sso-token-storage-sub-${randomUUID()}`;
    const sid = `sid-${randomUUID()}`;
    await authPool.query(
      `insert into auth.account (id, account_id, provider_id, user_id, created_at, updated_at)
       values ($1, $2, $3, $4, now(), now())`,
      [randomUUID(), sub, PROVIDER_ID, tenant.userId],
    );
    stub.setSubject({
      sub,
      email: `other-${randomUUID()}@example.test`,
      name: 'Token Storage Person',
      sid,
    });

    // WHEN the person signs in through Visma Connect.
    const response = await ssoSignIn();
    expect(response.statusCode, response.body).toBeLessThan(400);
    const sessionCookie = cookieFrom(response.headers['set-cookie']);
    expect(sessionCookie, 'precondition: a session cookie is issued').toContain('session_token');

    // THEN the tokens are stored, but not in plaintext.
    const stored = await authPool.query<{
      id: string;
      access_token: string | null;
      id_token: string | null;
    }>(
      'select id, access_token, id_token from auth.account where account_id = $1 and provider_id = $2',
      [sub, PROVIDER_ID],
    );
    const row = stored.rows[0];
    const accountRowId = row?.id ?? '';
    expect(accountRowId, 'the auth.account row exists').not.toBe('');
    expect(row?.access_token, 'an access token is stored').toBeTruthy();
    expect(row?.id_token, 'an ID token is stored').toBeTruthy();
    const storedAccess = row?.access_token ?? '';
    const storedId = row?.id_token ?? '';

    expect(storedId.split('.').length, 'the stored ID token is not a JWT').not.toBe(3);
    expect(storedId, 'the stored ID token does not carry the claims').not.toContain(sub);
    expect(
      Buffer.from(storedId, 'base64url').toString('utf8'),
      'the stored ID token is not base64url claims',
    ).not.toContain(sub);
    expect(storedAccess, 'the stored access token is not the stub-issued hex token').not.toMatch(
      /^[0-9a-f]{48}$/,
    );
    expect(
      await userinfoStatus(storedAccess),
      'the stored access token is not usable at the provider',
    ).toBe(401);

    // AND the tokens still decrypt for the flows that read them.
    const decrypted = await (
      app.auth.api as {
        getAccessToken(args: {
          body: { accountId: string };
          headers: Headers;
        }): Promise<{ accessToken?: string }>;
      }
    ).getAccessToken({
      body: { accountId: accountRowId },
      headers: new Headers({ cookie: sessionCookie }),
    });
    expect(decrypted.accessToken, 'the access token decrypts').toBeTruthy();
    expect(decrypted.accessToken).not.toBe(storedAccess);
    expect(
      await userinfoStatus(decrypted.accessToken ?? ''),
      'the decrypted access token is the one the provider issued',
    ).toBe(200);

    // The ID token's `sid` is still read (decrypted) at sign-in: it marks the
    // session as established through Visma Connect, which step-up (D25) needs.
    const sessions = await authPool.query<{ sso_sid: string | null }>(
      'select sso_sid from auth.session where user_id = $1 and sso_sid is not null',
      [tenant.userId],
    );
    expect(sessions.rows.map((r) => r.sso_sid)).toContain(sid);
  }, 60_000);
});
