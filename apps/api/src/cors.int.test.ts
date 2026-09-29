/**
 * Integration test for task 11.4 (design D13 "CORS").
 *
 * Task 11.4: "`CORSPlugin` with an explicit origin allowlist and
 * `credentials: true`. Verify: `cors.int.test.ts` covers an allowed origin
 * receiving CORS headers and a disallowed origin not receiving them."
 *
 * Design D13: "CORS: `CORSPlugin`, explicit origin allowlist,
 * `credentials: true` (required for Better Auth's cookie)."
 *
 * ## Production symbols expected
 *
 * - `createApp` (`./server.js`) applies CORS using its existing
 *   `allowedOrigins` option (the explicit allowlist, never `*`, never a
 *   reflected origin) with `credentials: true`, to `/v1/*` and preflights.
 *
 * ## Why this fails right now
 *
 * `createApp` accepts `allowedOrigins` but does not act on it, so an allowed
 * origin gets no `access-control-allow-origin` header: an assertion failure.
 * The disallowed-origin tests are expected to pass already (no CORS headers
 * are emitted at all); they guard against an over-permissive implementation.
 *
 * Requests need no session: CORS headers are independent of the outcome
 * (a 401 still carries them). Every request uses a fresh random IP.
 */
import { randomInt } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { harnessPools } from './__fixtures__/pools.js';
import { createApp, type App } from './server.js';

const TEST_SECRET = 'api-int-test-only-secret-not-used-for-anything-real-0123456789';
const ALLOWED_ORIGIN = 'https://app.tayzu.test';
const DISALLOWED_ORIGIN = 'https://evil.example.test';

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

describe('apps/api CORS (task 11.4)', () => {
  let app: App;

  beforeAll(async () => {
    app = await createApp({
      ...(await harnessPools()),
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ALLOWED_ORIGIN],
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
  }, 60_000);

  function simple(origin: string) {
    return app.app.inject({
      method: 'GET',
      url: '/v1/blueprints',
      headers: { origin, 'x-forwarded-for': randomIp() },
    });
  }

  function preflight(origin: string) {
    return app.app.inject({
      method: 'OPTIONS',
      url: '/v1/blueprints',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
        'x-forwarded-for': randomIp(),
      },
    });
  }

  describe('an allowed origin receives CORS headers', () => {
    it('echoes the exact allowed origin and allows credentials on a simple request', async () => {
      const response = await simple(ALLOWED_ORIGIN);
      expect(response.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
      expect(response.headers['access-control-allow-credentials']).toBe('true');
    });

    it('answers the preflight with the allowed origin, credentials and a 2xx status', async () => {
      const response = await preflight(ALLOWED_ORIGIN);
      expect(response.statusCode).toBeGreaterThanOrEqual(200);
      expect(response.statusCode).toBeLessThan(300);
      expect(response.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
      expect(response.headers['access-control-allow-credentials']).toBe('true');
      expect(response.headers['access-control-allow-methods']).toBeDefined();
    });
  });

  describe('a disallowed origin does not receive CORS headers', () => {
    it('gets no allow-origin or allow-credentials header on a simple request', async () => {
      const response = await simple(DISALLOWED_ORIGIN);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('gets no CORS headers on the preflight', async () => {
      const response = await preflight(DISALLOWED_ORIGIN);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
      expect(response.headers['access-control-allow-methods']).toBeUndefined();
    });

    it('never answers with a wildcard origin', async () => {
      const response = await simple(DISALLOWED_ORIGIN);
      expect(response.headers['access-control-allow-origin']).not.toBe('*');
    });
  });
});
