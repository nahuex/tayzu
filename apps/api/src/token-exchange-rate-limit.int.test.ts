/**
 * Integration test for task 11.13 (design D20, "Pre-authentication brute-force
 * protection").
 *
 * Scenario (specs/auth-and-rbac/spec.md, "Pre-authentication rate limiting
 * protects against credential stuffing"):
 *
 * "Machine token exchange is rate-limited independently of the authenticated
 * bucket"
 * - GIVEN a caller who has exceeded the configured attempt limit for
 *   `POST /v1/auth/token` keyed by their IP and client id
 * - WHEN they attempt another token exchange
 * - THEN it fails with `AUTH_RATE_LIMITED`, regardless of any
 *   authenticated-actor rate-limit bucket's state
 *
 * Design D20: "`POST /v1/auth/token` ... gets its own `@fastify/rate-limit`
 * bucket, keyed by IP and by the client id supplied in the request body --
 * separate from D13's authenticated-principal bucket, since a token-exchange
 * caller has no `tenantId`/`actor` yet to key on." "Every one of these
 * limiters returns `429` with a `Retry-After` header ... must not become a new
 * account-existence oracle."
 *
 * ## Production symbols expected
 *
 * - `CreateAppOptions.tokenExchangeRateLimit?: { max: number; timeWindowMs: number }`
 *   (`./server.js`): the budget for `POST /v1/auth/token`, supplied by the host.
 *   Bucket key = the caller's IP + the body's `clientId` (string). It never uses
 *   `resolveContext`'s tenant/actor and is independent of `rateLimit`. Over
 *   budget: HTTP 429, body `code: 'AUTH_RATE_LIMITED'` (same mapped-error shape
 *   as 11.8), and a positive-integer `Retry-After`. The response and its body
 *   must not echo the client id or the IP.
 * - The exchange body shape is `{ clientId: string; clientSecret: string }`
 *   (`ExchangeMachineTokenParams` in `@tayzu/auth`). Whether the route itself is
 *   already wired is not asserted: only "not 429" below the limit.
 *
 * ## Why this fails right now
 *
 * No token-exchange limiter exists, so the (max + 1)th attempt is served
 * normally (not 429). The "different client id / different IP" and "within
 * budget" assertions guard against a key that is too coarse and may already pass.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bootstrapTestTenant } from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { csrfHeaders } from './__fixtures__/csrf.js';
import { enrolledAdminSession } from './__fixtures__/fresh-mfa.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createApp, type App } from './server.js';
import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';

const TEST_PASSWORD = 'correct horse battery staple';
const ALLOWED_ORIGIN = 'https://app.tayzu.test';
const TOKEN_MAX = 3;
const AUTHENTICATED_MAX = 2;

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

describe('apps/api POST /v1/auth/token rate limit (task 11.13)', () => {
  let app: App;

  function exchange(clientId: string, ip: string) {
    return app.app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      headers: {
        'content-type': 'application/json',
        origin: ALLOWED_ORIGIN,
        'x-forwarded-for': ip,
        ...csrfHeaders('POST'),
      },
      payload: JSON.stringify({ clientId, clientSecret: `wrong-secret-${randomUUID()}` }),
    });
  }

  async function signInCookie(): Promise<string> {
    const suffix = randomUUID();
    const tenant = await bootstrapTestTenant(app.auth, {
      name: 'Token Rate Limit',
      email: `token-rate-limit-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Token Rate Limit Org ${suffix}`,
      organizationSlug: `token-rate-limit-org-${suffix}`,
      ip: randomIp(),
    });
    return (
      await enrolledAdminSession(app, tenant, { password: TEST_PASSWORD, origin: ALLOWED_ORIGIN })
    ).cookie;
  }

  beforeAll(async () => {
    app = await createApp({
      ...(await harnessPools()),
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ALLOWED_ORIGIN],
      rateLimit: { max: AUTHENTICATED_MAX, timeWindowMs: 60_000 },
      tokenExchangeRateLimit: { max: TOKEN_MAX, timeWindowMs: 60_000 },
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
  }, 60_000);

  it('Machine token exchange is rate-limited independently of the authenticated bucket', async () => {
    const ip = randomIp();
    const clientId = `client-${randomUUID()}`;

    // Within the budget: never rate-limited (the exchange itself fails or is unrouted).
    for (let i = 0; i < TOKEN_MAX; i += 1) {
      const response = await exchange(clientId, ip);
      expect(response.statusCode).not.toBe(429);
    }

    // Over the budget: 429 AUTH_RATE_LIMITED with Retry-After, and no echo of the key parts.
    const limited = await exchange(clientId, ip);
    expect(limited.statusCode).toBe(429);
    expect(limited.json<{ code?: unknown }>().code).toBe('AUTH_RATE_LIMITED');
    const retryAfter = Number(limited.headers['retry-after']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(limited.body).not.toContain(clientId);
    expect(limited.body).not.toContain(ip);

    // Still limited on the next attempt.
    expect((await exchange(clientId, ip)).statusCode).toBe(429);

    // Keyed by IP AND client id: another client id, or another IP, has a fresh bucket.
    expect((await exchange(`client-${randomUUID()}`, ip)).statusCode).not.toBe(429);
    expect((await exchange(clientId, randomIp())).statusCode).not.toBe(429);
  }, 120_000);

  it('An exhausted authenticated-principal bucket does not limit token exchange, and vice versa', async () => {
    const cookie = await signInCookie();
    const sharedIp = randomIp();

    // Exhaust the authenticated bucket (D13) for this principal.
    const probe = () =>
      app.app.inject({
        method: 'GET',
        url: `/v1/blueprints/token-rate-limit-probe-${randomUUID()}`,
        headers: { cookie, origin: ALLOWED_ORIGIN, 'x-forwarded-for': sharedIp },
      });
    for (let i = 0; i < AUTHENTICATED_MAX; i += 1) {
      expect((await probe()).statusCode).toBe(404);
    }
    expect((await probe()).statusCode).toBe(429);

    // A token exchange from the same IP is not affected by that bucket.
    const clientId = `client-${randomUUID()}`;
    for (let i = 0; i < TOKEN_MAX; i += 1) {
      expect((await exchange(clientId, sharedIp)).statusCode).not.toBe(429);
    }
    const limited = await exchange(clientId, sharedIp);
    expect(limited.statusCode).toBe(429);
    expect(limited.json<{ code?: unknown }>().code).toBe('AUTH_RATE_LIMITED');

    // A different, un-throttled principal's authenticated bucket is untouched by the exchange bucket.
    const freshCookie = await signInCookie();
    const fresh = await app.app.inject({
      method: 'GET',
      url: `/v1/blueprints/token-rate-limit-probe-${randomUUID()}`,
      headers: { cookie: freshCookie, origin: ALLOWED_ORIGIN, 'x-forwarded-for': sharedIp },
    });
    expect(fresh.statusCode).toBe(404);
  }, 120_000);
});
