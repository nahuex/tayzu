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
