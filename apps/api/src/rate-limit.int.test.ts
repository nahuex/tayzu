/**
 * Integration test for task 11.8 (design D13 "Rate limiting").
 *
 * Task 11.8: "`@fastify/rate-limit`, keyed by `${tenantId}:${actorType}:${actorId}`,
 * never logged or exported as a telemetry attribute. Verify: `rate-limit.int.test.ts`
 * covers one principal's requests being rate-limited (`AUTH_RATE_LIMITED`, 429)
 * while a different principal's bucket is unaffected."
 *
 * Design D13: "`@fastify/rate-limit@^11.2.0` ..., keyed by
 * `${tenantId}:${actor.type}:${actor.id}` -- never exported to telemetry as an
 * attribute, only used as an internal bucket key."
 *
 * ## Production symbols expected
 *
 * - `CreateAppOptions.rateLimit?: { max: number; timeWindowMs: number }`
 *   (`./server.js`): the per-principal budget for authenticated `/v1/*`
 *   traffic, supplied by the host (env read in bootstrap, never here). The
 *   bucket key is `${tenantId}:${actor.type}:${actor.id}` taken from
 *   `resolveContext`'s result (never from IP, body, path or query). Once a
 *   principal exceeds `max` requests inside the window, further requests get
 *   HTTP 429, body `code: 'AUTH_RATE_LIMITED'` (same mapped-error body shape
 *   as any other error, via `toOrpcError`), and a `Retry-After` header.
 *   Other principals' buckets are unaffected.
 *
 * ## Why this fails right now
 *
 * No rate limiter is registered, so the (max + 1)th request from one
 * principal is served normally (404 for the missing blueprint), not 429. The
 * "different principal" and "within budget" assertions are expected to pass
 * already; they guard against a limiter keyed too coarsely (for example by
 * IP: every request here shares the same source IP on purpose).
 */
import { randomInt, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bootstrapTestTenant,
  type BootstrappedTenant,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { csrfHeaders } from './__fixtures__/csrf.js';
import { enrolledAdminSession } from './__fixtures__/fresh-mfa.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createApp, type App } from './server.js';
import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';

const TEST_PASSWORD = 'correct horse battery staple';
const ALLOWED_ORIGIN = 'https://app.tayzu.test';
const MAX_REQUESTS = 5;
const SHARED_CLIENT_IP = '10.77.77.77';

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

describe('apps/api per-principal rate limit (task 11.8)', () => {
  let app: App;

  async function provision(label: string): Promise<{ tenant: BootstrappedTenant; cookie: string }> {
    const suffix = randomUUID();
    const tenant = await bootstrapTestTenant(app.auth, {
      name: `Rate Limit ${label}`,
      email: `rate-limit-${label}-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Rate Limit Org ${suffix}`,
      organizationSlug: `rate-limit-org-${suffix}`,
      ip: randomIp(),
    });
    const enrolled = await enrolledAdminSession(app, tenant, {
      password: TEST_PASSWORD,
      origin: ALLOWED_ORIGIN,
    });
    return { tenant, cookie: enrolled.cookie };
  }

  // Every request shares one source IP: only the principal may key the bucket.
  function lookup(cookie: string) {
    return app.app.inject({
      method: 'GET',
      url: `/v1/blueprints/rate-limit-probe-${randomUUID()}`,
      headers: { cookie, origin: ALLOWED_ORIGIN, 'x-forwarded-for': SHARED_CLIENT_IP },
    });
  }

  beforeAll(async () => {
    app = await createApp({
      ...(await harnessPools()),
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ALLOWED_ORIGIN],
      rateLimit: { max: MAX_REQUESTS, timeWindowMs: 60_000 },
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
  }, 60_000);

  it('One principal is rate-limited with AUTH_RATE_LIMITED while a different principal is unaffected', async () => {
    const principalA = await provision('a');
    const principalB = await provision('b');

    // Within the budget: served normally (the blueprint does not exist).
    for (let i = 0; i < MAX_REQUESTS; i += 1) {
      const response = await lookup(principalA.cookie);
      expect(response.statusCode).toBe(404);
    }

    // Over the budget: 429 AUTH_RATE_LIMITED with Retry-After.
    const limited = await lookup(principalA.cookie);
    expect(limited.statusCode).toBe(429);
    expect(limited.json<{ code?: unknown }>().code).toBe('AUTH_RATE_LIMITED');
    const retryAfter = Number(limited.headers['retry-after']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);

    // The bucket key never reaches the response.
    expect(limited.body).not.toContain(principalA.tenant.organizationId);
    expect(limited.body).not.toContain(principalA.tenant.userId);

    // Still limited on the next request from the same principal.
    const again = await lookup(principalA.cookie);
    expect(again.statusCode).toBe(429);

    // A different principal (another tenant), same IP, has a fresh bucket.
    const other = await lookup(principalB.cookie);
    expect(other.statusCode).toBe(404);
  }, 120_000);
});

/**
 * Task 24.8 (design Q56, D20): the token-exchange limit is keyed by client IP
 * only, so a caller cannot get a fresh bucket by changing `clientId`.
 *
 * Spec (auth-and-rbac, "Pre-authentication rate limiting"): `POST /v1/auth/token`
 * is rate-limited per caller IP; exceeding it fails with `AUTH_RATE_LIMITED`
 * and a `Retry-After` header.
 *
 * ## Production symbols expected
 *
 * - `CreateAppOptions.tokenExchangeRateLimit` (already exists): the bucket key
 *   for `POST /v1/auth/token` in `./server.ts` must be the caller's IP alone,
 *   no longer IP + `clientId`.
 *
 * ## Why this fails right now
 *
 * The key includes a hash of `clientId`, so every request with a different
 * `clientId` gets a fresh bucket and the (max + 1)th attempt is not 429.
 */
describe('apps/api token-exchange rate limit keyed by IP only (task 24.8)', () => {
  const TOKEN_MAX = 3;
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

  beforeAll(async () => {
    app = await createApp({
      ...(await harnessPools()),
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ALLOWED_ORIGIN],
      tokenExchangeRateLimit: { max: TOKEN_MAX, timeWindowMs: 60_000 },
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
  }, 60_000);

  it('Requests from one IP with a different clientId each time are rate-limited', async () => {
    const ip = randomIp();

    // Within the budget: never rate-limited, each with a distinct clientId.
    for (let i = 0; i < TOKEN_MAX; i += 1) {
      const response = await exchange(`client-${randomUUID()}`, ip);
      expect(response.statusCode).not.toBe(429);
    }

    // Over the budget, with yet another clientId: 429 AUTH_RATE_LIMITED + Retry-After.
    const freshClientId = `client-${randomUUID()}`;
    const limited = await exchange(freshClientId, ip);
    expect(limited.statusCode).toBe(429);
    expect(limited.json<{ code?: unknown }>().code).toBe('AUTH_RATE_LIMITED');
    const retryAfter = Number(limited.headers['retry-after']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(limited.body).not.toContain(freshClientId);
    expect(limited.body).not.toContain(ip);

    // Still limited for yet another clientId.
    expect((await exchange(`client-${randomUUID()}`, ip)).statusCode).toBe(429);

    // A different IP has its own bucket.
    expect((await exchange(`client-${randomUUID()}`, randomIp())).statusCode).not.toBe(429);
  }, 120_000);
});
