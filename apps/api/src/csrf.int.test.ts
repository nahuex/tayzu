/**
 * Integration test for task 11.5 (design D13 "CSRF").
 *
 * Task 11.5: "`SimpleCsrfProtectionHandlerPlugin` on every mutating route.
 * Verify: `csrf.int.test.ts` covers a mutating request missing the required
 * header being rejected, and one carrying it succeeding."
 *
 * Design D13: "CSRF: `SimpleCsrfProtectionHandlerPlugin` (custom-header check)
 * on every mutating route, defense-in-depth alongside the session cookie's
 * `SameSite=Lax`."
 *
 * ## Production symbols expected
 *
 * - `createApp` (`./server.js`) registers oRPC's
 *   `SimpleCsrfProtectionHandlerPlugin` (`@orpc/server/plugins`) on its
 *   `OpenAPIHandler` with the plugin's default header (`x-csrf-token: orpc`).
 *   The plugin protects every procedure, so read-only routes must be excluded
 *   (`exclude`) so that only mutating methods (POST/PUT/PATCH/DELETE) need it.
 *
 * ## Why this fails right now
 *
 * No CSRF plugin is registered, so the mutating request without the header
 * succeeds (200) instead of being rejected with 403: an assertion failure.
 * The "carrying the header succeeds" and "GET needs no header" tests are
 * expected to pass already; they guard against an over-strict implementation.
 *
 * The rejection assertion checks only status 403 (the code is left to the
 * implementation) and that the operation did not run. Requests are
 * authenticated (session cookie) because `resolveContext` runs first; every
 * request uses a fresh random IP.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bootstrapTestTenant,
  type BootstrappedTenant,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { CSRF_HEADERS } from './__fixtures__/csrf.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createApp, type App } from './server.js';

const TEST_SECRET = 'api-int-test-only-secret-not-used-for-anything-real-0123456789';
const TEST_PASSWORD = 'correct horse battery staple';
const ALLOWED_ORIGIN = 'https://app.tayzu.test';
const CSRF_HEADER = CSRF_HEADERS;

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

const emptySchema = { properties: {}, required: [] };

describe('apps/api CSRF protection (task 11.5)', () => {
  let app: App;
  let cookie: string;

  async function provisionTenant(): Promise<BootstrappedTenant> {
    const suffix = randomUUID();
    return bootstrapTestTenant(app.auth, {
      name: 'CSRF User',
      email: `csrf-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Csrf Org ${suffix}`,
      organizationSlug: `csrf-org-${suffix}`,
      ip: randomIp(),
    });
  }

  async function signIn(email: string): Promise<string> {
    const response = await app.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': randomIp(),
        origin: ALLOWED_ORIGIN,
      },
      payload: JSON.stringify({ email, password: TEST_PASSWORD }),
    });
    expect(response.statusCode).toBe(200);
    const setCookie = response.headers['set-cookie'];
    const cookies = Array.isArray(setCookie)
      ? setCookie
      : setCookie === undefined
        ? []
        : [setCookie];
    return cookies.map((raw) => raw.split(';')[0]).join('; ');
  }

  function send(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    extraHeaders: Record<string, string>,
    body?: unknown,
  ) {
    return app.app.inject({
      method,
      url,
      headers: {
        cookie,
        origin: ALLOWED_ORIGIN,
        'x-forwarded-for': randomIp(),
        ...extraHeaders,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  }

  beforeAll(async () => {
    app = await createApp({
      ...(await harnessPools()),
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ALLOWED_ORIGIN],
    });
    const tenant = await provisionTenant();
    cookie = await signIn(tenant.email);
  }, 60_000);

  afterAll(async () => {
    await app.close();
  }, 60_000);

  describe('a mutating request missing the required header is rejected', () => {
    it('rejects POST without the CSRF header with 403 and does not run the operation', async () => {
      const rejected = await send(
        'POST',
        '/v1/blueprints',
        {},
        {
          identifier: 'no-header',
          title: { en: 'No header' },
          schema: emptySchema,
        },
      );
      expect(rejected.statusCode).toBe(403);

      // The operation must not have run: the blueprint does not exist.
      const lookup = await send('GET', '/v1/blueprints/no-header', {});
      expect(lookup.statusCode).toBe(404);
    }, 60_000);

    it('rejects a wrong header value with 403', async () => {
      const response = await send(
        'POST',
        '/v1/blueprints',
        { 'x-csrf-token': 'not-orpc' },
        {
          identifier: 'wrong-value',
          title: { en: 'Wrong value' },
          schema: emptySchema,
        },
      );
      expect(response.statusCode).toBe(403);
    }, 60_000);

    it('rejects PUT without the CSRF header with 403', async () => {
      const created = await send('POST', '/v1/blueprints', CSRF_HEADER, {
        identifier: 'put-target',
        title: { en: 'Put target' },
        schema: emptySchema,
      });
      expect(created.statusCode).toBe(200);
      const response = await send(
        'PUT',
        '/v1/blueprints/put-target',
        {},
        {
          title: { en: 'Changed' },
          schema: emptySchema,
          expectedVersion: 1,
        },
      );
      expect(response.statusCode).toBe(403);
    }, 60_000);

    it('rejects DELETE without the CSRF header with 403', async () => {
      const created = await send('POST', '/v1/blueprints', CSRF_HEADER, {
        identifier: 'delete-target',
        title: { en: 'Delete target' },
        schema: emptySchema,
      });
      expect(created.statusCode).toBe(200);
      const response = await send('DELETE', '/v1/blueprints/delete-target', {});
      expect(response.statusCode).toBe(403);
      const still = await send('GET', '/v1/blueprints/delete-target', {});
      expect(still.statusCode).toBe(200);
    }, 60_000);
  });

  describe('a mutating request carrying the header succeeds', () => {
    it('accepts POST with the CSRF header and creates the blueprint', async () => {
      const response = await send('POST', '/v1/blueprints', CSRF_HEADER, {
        identifier: 'with-header',
        title: { en: 'With header' },
        schema: emptySchema,
      });
      expect(response.statusCode).toBe(200);
      const lookup = await send('GET', '/v1/blueprints/with-header', {});
      expect(lookup.statusCode).toBe(200);
    }, 60_000);
  });

  describe('read-only requests are not subject to the check', () => {
    it('accepts GET without the CSRF header', async () => {
      const response = await send('GET', '/v1/blueprints', {});
      expect(response.statusCode).toBe(200);
    }, 60_000);
  });
});
