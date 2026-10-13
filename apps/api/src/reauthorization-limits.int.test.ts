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
import { randomInt } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startOidcStub, type OidcStub } from '../../../packages/auth/src/__fixtures__/oidc-stub.js';
import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { harnessPools } from './__fixtures__/pools.js';
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
