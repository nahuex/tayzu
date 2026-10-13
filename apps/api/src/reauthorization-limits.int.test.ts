/**
 * Integration test for task 13.9 of change 043 (`specs/identity-lifecycle-and-org-admin`,
 * requirement "The hand-offs from the authentication baseline hold", scenario "The
 * re-authorization callback is limited"; `002` VCDM M13).
 *
 * Scenario (verbatim):
 * - "The re-authorization callback is limited": WHEN a caller exceeds the callback's
 *   limit, THEN further requests are refused before any database access.
 *
 * ## Harness
 *
 * `createApp` over the harness pools, with SSO pointed at the local OIDC stub so the
 * callback route is mounted. The auth pool is wrapped in a spy that records the text of
 * every query, so "no database access" is observed as "no query that touches
 * `auth.verification`" (the table the callback's single-use `delete` hits) after the
 * limit is hit. Every request goes through `app.app.inject` with a `x-forwarded-for`
 * fresh per test; the limiter is keyed by the caller's IP, so one IP is reused within a
 * test to exceed the limit.
 *
 * ## Production symbols expected (the red phase)
 *
 * - `CreateAppOptions` (`apps/api/src/server.ts`) gains the optional
 *   `reauthorizationCallbackRateLimit: { max: number; window: number }` (window in
 *   seconds, like `preAuthRateLimit`). When set, the callback route (GET and POST of
 *   `/v1/auth/visma-connect/reauthorize/callback`) consumes a bucket of the DB-backed
 *   store (scope `reauthorization_callback`, kind `ip`) before `reauthorization.complete`.
 * - A refused request answers `429`, body code `AUTH_RATE_LIMITED`, with a `retry-after`
 *   header.
 * - `RateLimitScope` gains `reauthorization_callback`.
 */
import { randomInt, randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  bootstrapTestTenant,
  testAppPool,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { startOidcStub, type OidcStub } from '../../../packages/auth/src/__fixtures__/oidc-stub.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { enrollTotp, signInWithTotp } from './__fixtures__/fresh-mfa.js';
import { csrfHeaders } from './__fixtures__/csrf.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createAppFromEnv } from './bootstrap.js';
import { createApp, type App } from './server.js';

const ORIGIN = 'https://app.tayzu.test';
const CALLBACK_PATH = '/v1/auth/visma-connect/reauthorize/callback';
const MAX = 3;

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

/** Records the SQL text of every query the wrapped pool runs. */
function spyOnQueries(pool: Pool, log: string[]): Pool {
  return new Proxy(pool, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (prop === 'query') {
        return (...args: unknown[]) => {
          const first = args[0];
          log.push(
            typeof first === 'string'
              ? first
              : typeof first === 'object' && first !== null && 'text' in first
                ? String(first.text)
                : '',
          );
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

describe('The re-authorization callback is limited (task 13.9, VCDM M13)', () => {
  let app: App;
  let stub: OidcStub;
  const queries: string[] = [];

  beforeAll(async () => {
    const pools = await harnessPools();
    stub = await startOidcStub();
    app = await createApp({
      appPool: pools.appPool,
      authPool: spyOnQueries(pools.authPool, queries),
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ORIGIN],
      sso: {
        discoveryUrl: stub.discoveryUrl,
        clientId: stub.clientId,
        clientSecret: stub.clientSecret,
      },
      reauthorizationCallbackRateLimit: { max: MAX, window: 60 },
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await stub.close();
  }, 60_000);

  function callback(ip: string, method: 'GET' | 'POST') {
    const state = `unknown-state-${randomInt(1, 1_000_000_000).toString(10)}`;
    return method === 'GET'
      ? app.app.inject({
          method: 'GET',
          url: `${CALLBACK_PATH}?code=c&state=${state}`,
          headers: { 'x-forwarded-for': ip, origin: ORIGIN },
        })
      : app.app.inject({
          method: 'POST',
          url: CALLBACK_PATH,
          headers: {
            'x-forwarded-for': ip,
            origin: ORIGIN,
            'content-type': 'application/x-www-form-urlencoded',
          },
          payload: `code=c&state=${state}`,
        });
  }

  function verificationQueries(): number {
    return queries.filter((text) => text.includes('auth.verification')).length;
  }

  it.each(['GET', 'POST'] as const)(
    'A caller exceeding the callback limit is refused before any database access (%s)',
    async (method) => {
      const ip = randomIp();

      // Within the limit the callback runs: it reaches the database (the single-use delete).
      const before = verificationQueries();
      for (let i = 0; i < MAX; i += 1) {
        const response = await callback(ip, method);
        expect(response.statusCode, response.body).toBe(400);
      }
      expect(
        verificationQueries(),
        'precondition: allowed hits do query auth.verification',
      ).toBeGreaterThanOrEqual(before + MAX);

      // WHEN the caller exceeds the limit, THEN further requests are refused ...
      const afterLimit = verificationQueries();
      for (let i = 0; i < 3; i += 1) {
        const refused = await callback(ip, method);
        expect(refused.statusCode, refused.body).toBe(429);
        expect(refused.json<{ code?: unknown }>().code).toBe('AUTH_RATE_LIMITED');
        expect(refused.headers['retry-after']).toMatch(/^\d+$/);
      }

      // ... before any database access to the verification table.
      expect(verificationQueries()).toBe(afterLimit);
    },
    60_000,
  );

  it('The limit is per caller: another IP is not refused', async () => {
    const exhausted = randomIp();
    for (let i = 0; i < MAX + 1; i += 1) {
      await callback(exhausted, 'GET');
    }
    const other = await callback(randomIp(), 'GET');
    expect(other.statusCode, other.body).toBe(400);
  }, 60_000);
});

/**
 * Task 13.9b of change 043 (requirement "The hand-offs from the authentication baseline
 * hold": "`reauthorization.start` MUST be bounded per session"; `002` VCDM M13).
 *
 * ## Production symbols expected (the red phase)
 *
 * - `CreateAppOptions` (`apps/api/src/server.ts`) gains the optional
 *   `reauthorizationMaxPendingPerSession: number`, passed to `createReauthorization`
 *   (`apps/api/src/reauthorization.ts`) as the same-named option. `start` inserts a
 *   `sso-reauth-state:` row into `auth.verification` only while the session has fewer than
 *   that many unexpired state rows bound to it; beyond it no row is inserted. What a
 *   blocked attempt answers is left open: only the row count is asserted.
 */
describe('reauthorization.start is bounded per session (task 13.9b, VCDM M13)', () => {
  const MAX_PENDING = 3;
  let app: App;
  let stub: OidcStub;
  let authPool: Awaited<ReturnType<typeof harnessPools>>['authPool'];

  beforeAll(async () => {
    const pools = await harnessPools();
    authPool = pools.authPool;
    stub = await startOidcStub();
    app = await createApp({
      appPool: pools.appPool,
      authPool: pools.authPool,
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ORIGIN],
      sso: {
        discoveryUrl: stub.discoveryUrl,
        clientId: stub.clientId,
        clientSecret: stub.clientSecret,
      },
      reauthorizationMaxPendingPerSession: MAX_PENDING,
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await stub.close();
  }, 60_000);

  async function ssoSessionUser(): Promise<{ cookie: string; userId: string }> {
    const tenant = await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: 'Reauth Bound User',
      email: `reauth-bound-${randomUUID()}@example.test`,
      password: TEST_PASSWORD,
      organizationName: 'Reauth Bound Org',
      organizationSlug: `reauth-bound-${randomUUID()}`,
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
    return { cookie, userId: tenant.userId };
  }

  /** A high-risk call that step-up refuses, which makes the interceptor call `start`. */
  function blockedAttempt(cookie: string) {
    return app.app.inject({
      method: 'DELETE',
      url: `/v1/blueprints/no-such-${randomUUID().slice(0, 8)}`,
      headers: {
        cookie,
        origin: ORIGIN,
        'x-forwarded-for': randomIp(),
        ...csrfHeaders('DELETE'),
      },
    });
  }

  async function pendingStates(userId: string): Promise<number> {
    const result = await authPool.query<{ count: string }>(
      `select count(*)::text as count from auth.verification v
       where v.identifier like 'sso-reauth-state:%'
         and exists (
           select 1 from auth.session s
           where s.user_id = $1 and position(s.token in v.value) > 0
         )`,
      [userId],
    );
    return Number(result.rows[0]?.count);
  }

  it('Repeated blocked attempts of one session insert at most the configured number of rows', async () => {
    const { cookie, userId } = await ssoSessionUser();

    for (let i = 0; i < MAX_PENDING; i += 1) {
      const response = await blockedAttempt(cookie);
      const data = response.json<{ data?: { reauthorizationUrl?: unknown } }>().data;
      expect(response.statusCode, response.body).toBe(403);
      expect(typeof data?.reauthorizationUrl, 'precondition: start ran').toBe('string');
    }
    expect(await pendingStates(userId)).toBe(MAX_PENDING);

    for (let i = 0; i < MAX_PENDING * 3; i += 1) {
      await blockedAttempt(cookie);
    }
    expect(await pendingStates(userId)).toBeLessThanOrEqual(MAX_PENDING);
  }, 120_000);

  it('The bound is per session: another session still starts a re-authorization', async () => {
    const exhausted = await ssoSessionUser();
    for (let i = 0; i < MAX_PENDING + 2; i += 1) {
      await blockedAttempt(exhausted.cookie);
    }
    const other = await ssoSessionUser();
    const response = await blockedAttempt(other.cookie);
    const data = response.json<{ data?: { reauthorizationUrl?: unknown } }>().data;
    expect(typeof data?.reauthorizationUrl).toBe('string');
    expect(await pendingStates(other.userId)).toBe(1);
  }, 120_000);
});

/**
 * Task 14.20 of change 043 (Resolved decisions Q138 and Q140; `002` VCDM M13): an app
 * built through `createAppFromEnv` with SSO configured and no limit variable limits the
 * callback by default, 10 per 60 seconds per IP.
 *
 * ## Harness
 *
 * `@tayzu/db`'s `createPool` is mocked to hand out the harness pools (the production URLs
 * need `sslmode=verify-full`) only while `defaultState.pools` is filled; the other tests of
 * this file never fill it, so they see the real `createPool`. The auth pool is wrapped in
 * the query spy of the first describe.
 *
 * ## Production symbols expected (the red phase)
 *
 * - `createAppFromEnv` (`apps/api/src/bootstrap.ts`) passes
 *   `config.reauthorizationCallbackRateLimit` (`config.ts`, 10 per 60 seconds, 14.20) to
 *   `createApp` as `reauthorizationCallbackRateLimit`; `createApp` applies the same default
 *   when the option is omitted.
 */
const defaultState = vi.hoisted(() => ({ pools: new Map<string, unknown>() }));

vi.mock('@tayzu/db', async (importActual) => {
  const actual = await importActual<typeof import('@tayzu/db')>();
  return {
    ...actual,
    createPool: vi.fn((url: string, ...rest: unknown[]) => {
      const real = defaultState.pools.get(url.includes('tayzu_auth') ? 'auth' : 'app');
      if (real === undefined) {
        return (actual.createPool as (...args: unknown[]) => unknown)(url, ...rest);
      }
      return new Proxy(real as object, {
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

describe('The callback is limited by default on createAppFromEnv (task 14.20, Q140)', () => {
  const DEFAULT_MAX = 10;
  let app: App;
  let stub: OidcStub;
  const queries: string[] = [];

  beforeAll(async () => {
    const pools = await harnessPools();
    stub = await startOidcStub();
    defaultState.pools.set('app', pools.appPool);
    defaultState.pools.set('auth', spyOnQueries(pools.authPool, queries));
    app = await createAppFromEnv({
      DATABASE_URL: 'postgres://tayzu_app:pw@127.0.0.1:1/tayzu?sslmode=verify-full',
      AUTH_DATABASE_URL: 'postgres://tayzu_auth:pw@127.0.0.1:1/tayzu?sslmode=verify-full',
      BETTER_AUTH_SECRET: TEST_SECRET,
      CERBOS_ADDRESS: 'localhost:3593',
      ALLOWED_ORIGINS: ORIGIN,
      INVITATION_LINK_BASE_URL: ORIGIN,
      IDENTITY_TOKEN_HMAC_SECRET: 'limits-hmac-test-only-secret-0123456789-abcdef',
      VISMA_CONNECT_DISCOVERY_URL: stub.discoveryUrl,
      VISMA_CONNECT_CLIENT_ID: stub.clientId,
      VISMA_CONNECT_CLIENT_SECRET: stub.clientSecret,
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await stub.close();
    defaultState.pools.clear();
  }, 60_000);

  function callback(ip: string) {
    return app.app.inject({
      method: 'GET',
      url: `${CALLBACK_PATH}?code=c&state=unknown-state-${randomUUID()}`,
      headers: { 'x-forwarded-for': ip, origin: ORIGIN },
    });
  }

  function verificationQueries(): number {
    return queries.filter((text) => text.includes('auth.verification')).length;
  }

  it('answers AUTH_RATE_LIMITED with Retry-After past the default from one IP, with no database access', async () => {
    const ip = randomIp();
    for (let i = 0; i < DEFAULT_MAX; i += 1) {
      const response = await callback(ip);
      expect(response.statusCode, response.body).toBe(400);
    }

    const afterLimit = verificationQueries();
    for (let i = 0; i < 3; i += 1) {
      const refused = await callback(ip);
      expect(refused.statusCode, refused.body).toBe(429);
      expect(refused.json<{ code?: unknown }>().code).toBe('AUTH_RATE_LIMITED');
      expect(refused.headers['retry-after']).toMatch(/^\d+$/);
    }
    expect(verificationQueries()).toBe(afterLimit);
  }, 60_000);
});
