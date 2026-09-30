/**
 * Integration test for task 23.12 (design Q40, D2, D13).
 *
 * Task 23.12: "`BETTER_AUTH_URL` is required (`https` outside test); Better Auth
 * is given `baseURL`, `trustedOrigins` (the allowed origins) and
 * `advanced.useSecureCookies: true`, and `toWebRequest` no longer hard-codes
 * `http://`. Verify: `production-cookies.int.test.ts` runs with Better Auth's
 * origin check on and covers a cookie-bearing POST from a disallowed origin
 * being rejected, one from an allowed origin passing, every session cookie
 * being `Secure`, and a missing or `http` `BETTER_AUTH_URL` failing startup."
 *
 * The task cites no spec scenario; the behavior comes from design Q40.
 *
 * ## Harness
 *
 * The app is built by `createAppFromEnv` (pools mocked as in
 * `bootstrap-wiring.int.test.ts`) and every request goes through Fastify
 * (`app.app.inject`) with a fresh random `x-forwarded-for`. Better Auth skips its
 * origin check when `NODE_ENV=test`, so "origin check on" is a production
 * behavior this test observes: the disallowed-origin rejection can only pass if
 * the instance explicitly turns the check on (`advanced.disableOriginCheck:
 * false`) whatever the environment.
 *
 * ## Production symbols expected
 *
 * - `loadConfig` (`./config.js`) requires `BETTER_AUTH_URL`, and requires it to
 *   be `https` unless the environment is a test one. The "outside test"
 *   signal is ASSUMED to be `NODE_ENV` (the passed env, and process env); the
 *   `http` case sets both to `production`. A startup error names the variable.
 * - `createAppFromEnv` / `createApp` forward it to `createAuth` as `baseURL`,
 *   with `trustedOrigins` = `ALLOWED_ORIGINS`, `advanced.useSecureCookies: true`
 *   and the origin check enabled.
 * - The `/api/auth/*` bridge builds the web `Request` URL from the configured
 *   base URL, not from a hard-coded `http://` plus the `Host` header.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { bootstrapTestTenant } from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
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

const ALLOWED_ORIGIN = 'https://app.tayzu.test';
const DISALLOWED_ORIGIN = 'https://evil.example';
const AUTH_URL = 'https://api.tayzu.test';
const TEST_PASSWORD = 'correct horse battery staple';

const ENV: Record<string, string> = {
  DATABASE_URL: 'postgres://tayzu_app:pw@db.invalid:5432/tayzu?sslmode=verify-full',
  AUTH_DATABASE_URL: 'postgres://tayzu_auth:pw@db.invalid:5432/tayzu?sslmode=verify-full',
  BETTER_AUTH_SECRET: TEST_SECRET,
  CERBOS_ADDRESS: 'localhost:3593',
  ALLOWED_ORIGINS: ALLOWED_ORIGIN,
  BETTER_AUTH_URL: AUTH_URL,
};

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

function setCookiesOf(response: { headers: Record<string, unknown> }): string[] {
  const raw = response.headers['set-cookie'];
  if (Array.isArray(raw)) {
    return raw.map(String);
  }
  return typeof raw === 'string' ? [raw] : [];
}

describe('production cookies and origin check (task 23.12, Q40, D2)', () => {
  let app: App;
  let email: string;

  beforeAll(async () => {
    const { appPool, authPool } = await harnessPools();
    state.pools.set('app', appPool);
    state.pools.set('auth', authPool);
    app = await createAppFromEnv(ENV);
    const suffix = randomUUID();
    email = `cookies-${suffix}@example.test`;
    await bootstrapTestTenant(app.auth, {
      name: 'Cookies User',
      email,
      password: TEST_PASSWORD,
      organizationName: `Cookies Org ${suffix}`,
      organizationSlug: `cookies-${suffix}`,
      ip: randomIp(),
      authBaseUrl: `${AUTH_URL}/api/auth`,
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    state.pools.clear();
  }, 60_000);

  function signIn() {
    return app.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': randomIp(),
      },
      payload: JSON.stringify({ email, password: TEST_PASSWORD }),
    });
  }

  async function newSessionCookie(): Promise<string> {
    const response = await signIn();
    expect(response.statusCode, 'precondition: the sign-in succeeds').toBe(200);
    return setCookiesOf(response)
      .map((raw) => raw.split(';')[0])
      .join('; ');
  }

  function signOut(cookie: string, origin: string) {
    return app.app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: {
        cookie,
        origin,
        'content-type': 'application/json',
        'x-forwarded-for': randomIp(),
      },
      payload: '{}',
    });
  }

  function useSession(cookie: string) {
    return app.app.inject({ method: 'GET', url: '/v1/blueprints', headers: { cookie } });
  }

  it('a cookie-bearing POST from a disallowed origin is rejected and does not run', async () => {
    const cookie = await newSessionCookie();

    const rejected = await signOut(cookie, DISALLOWED_ORIGIN);

    expect(rejected.statusCode).toBe(403);
    expect(
      (await useSession(cookie)).statusCode,
      'the session was not signed out by the rejected request',
    ).toBe(200);
  }, 60_000);

  it('a cookie-bearing POST from an allowed origin passes', async () => {
    const cookie = await newSessionCookie();

    const accepted = await signOut(cookie, ALLOWED_ORIGIN);

    expect(accepted.statusCode).toBe(200);
    expect((await useSession(cookie)).statusCode, 'the session is gone').toBe(401);
  }, 60_000);

  it('every session cookie is Secure', async () => {
    const response = await signIn();

    expect(response.statusCode).toBe(200);
    const cookies = setCookiesOf(response);
    expect(cookies.length, 'the sign-in sets at least one cookie').toBeGreaterThan(0);
    for (const cookie of cookies) {
      expect(cookie, 'each Set-Cookie carries the Secure attribute').toMatch(/;\s*Secure(;|$)/i);
    }
  }, 60_000);
});

describe('production cookies: BETTER_AUTH_URL validation at startup (task 23.12, Q40)', () => {
  beforeAll(async () => {
    const { appPool, authPool } = await harnessPools();
    state.pools.set('app', appPool);
    state.pools.set('auth', authPool);
  }, 60_000);

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(() => {
    state.pools.clear();
  });

  async function startupOutcome(env: Record<string, string>): Promise<string> {
    return createAppFromEnv(env).then(
      async (started) => {
        await started.close();
        return 'started';
      },
      (error: unknown) => (error instanceof Error ? error.message : 'non-error rejection'),
    );
  }

  it('a missing BETTER_AUTH_URL fails startup naming the variable', async () => {
    const withoutUrl = Object.fromEntries(
      Object.entries(ENV).filter(([name]) => name !== 'BETTER_AUTH_URL'),
    );
    vi.stubEnv('NODE_ENV', 'production');

    const outcome = await startupOutcome({ ...withoutUrl, NODE_ENV: 'production' });

    expect(outcome, 'startup fails instead of starting').not.toBe('started');
    expect(outcome).toContain('BETTER_AUTH_URL');
  }, 60_000);

  it('an http BETTER_AUTH_URL fails startup naming the variable outside test', async () => {
    vi.stubEnv('NODE_ENV', 'production');

    const outcome = await startupOutcome({
      ...ENV,
      BETTER_AUTH_URL: 'http://api.tayzu.test',
      NODE_ENV: 'production',
    });

    expect(outcome, 'startup fails instead of starting').not.toBe('started');
    expect(outcome).toContain('BETTER_AUTH_URL');
  }, 60_000);
});
