/**
 * Integration test for task 11.6 (design D13 "Security headers").
 *
 * Task 11.6: "`@fastify/helmet` registered with `contentSecurityPolicy: false`.
 * Verify: `headers.int.test.ts` asserts the expected security headers are
 * present on a response."
 *
 * Design D13: "`@fastify/helmet`, `contentSecurityPolicy: false` (this is a
 * JSON API; CSP is `003`'s concern)."
 *
 * The task names no spec scenario; the assertions below are the helmet
 * defaults that apply to a JSON API. HSTS is deliberately not asserted here:
 * task 11.12 extends this file for it.
 *
 * ## Production symbols expected
 *
 * - `createApp` (`./server.js`) registers `@fastify/helmet` with
 *   `contentSecurityPolicy: false`, globally (`/v1/*`, `/api/auth/*`,
 *   unknown routes and error responses alike).
 *
 * ## Why this fails right now
 *
 * No helmet is registered, so none of the headers are present: assertion
 * failures. The CSP-absent test is expected to pass already; it guards
 * against enabling helmet's default CSP.
 *
 * Every request uses a fresh random IP so the rate limiters never interfere.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bootstrapTestTenant } from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { freshMfaSessionCookie } from './__fixtures__/fresh-mfa.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createApp, type App } from './server.js';
import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

describe('apps/api security headers (task 11.6)', () => {
  let app: App;

  beforeAll(async () => {
    app = await createApp({
      ...(await harnessPools()),
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: ['https://app.tayzu.test'],
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
  }, 60_000);

  const targets = [
    { name: 'a /v1 response (unauthenticated, 401)', url: '/v1/blueprints' },
    { name: 'a Better Auth response', url: '/api/auth/get-session' },
    { name: 'an unknown route (404)', url: '/no-such-route' },
  ] as const;

  for (const target of targets) {
    describe(`on ${target.name}`, () => {
      async function get() {
        return app.app.inject({
          method: 'GET',
          url: target.url,
          headers: { 'x-forwarded-for': randomIp() },
        });
      }

      it('sends x-content-type-options: nosniff', async () => {
        expect((await get()).headers['x-content-type-options']).toBe('nosniff');
      });

      it('sends x-frame-options', async () => {
        expect((await get()).headers['x-frame-options']).toBe('SAMEORIGIN');
      });

      it('sends referrer-policy: no-referrer', async () => {
        expect((await get()).headers['referrer-policy']).toBe('no-referrer');
      });

      it('sends cross-origin-opener-policy and cross-origin-resource-policy: same-origin', async () => {
        const { headers } = await get();
        expect(headers['cross-origin-opener-policy']).toBe('same-origin');
        expect(headers['cross-origin-resource-policy']).toBe('same-origin');
      });

      it('sends x-dns-prefetch-control: off and x-permitted-cross-domain-policies: none', async () => {
        const { headers } = await get();
        expect(headers['x-dns-prefetch-control']).toBe('off');
        expect(headers['x-permitted-cross-domain-policies']).toBe('none');
      });

      it('does not send a content-security-policy (contentSecurityPolicy: false)', async () => {
        const { headers } = await get();
        expect(headers['content-security-policy']).toBeUndefined();
        expect(headers['content-security-policy-report-only']).toBeUndefined();
      });

      it('does not advertise the framework via x-powered-by', async () => {
        expect((await get()).headers['x-powered-by']).toBeUndefined();
      });

      // Task 11.12 (TLS/HSTS posture): HSTS with max-age >= 1 year and includeSubDomains.
      it('sends strict-transport-security with max-age of at least one year and includeSubDomains (task 11.12)', async () => {
        const hsts = (await get()).headers['strict-transport-security'];
        expect(typeof hsts).toBe('string');
        const directives = String(hsts)
          .split(';')
          .map((d) => d.trim().toLowerCase());
        const maxAge = directives.find((d) => d.startsWith('max-age='));
        expect(maxAge).toBeDefined();
        expect(Number(maxAge?.slice('max-age='.length))).toBeGreaterThanOrEqual(31_536_000);
        expect(directives).toContain('includesubdomains');
      });
    });
  }
});

/**
 * DAST finding "Storable and Cacheable Content [10049]" (design D13 HTTP
 * hardening, D16 DAST; OWASP ASVS V8.2.1): every response carries
 * `Cache-Control: no-store` unless the route handler set its own Cache-Control.
 *
 * ## Production behavior expected
 *
 * `createApp` adds a global default (for example an `onSend` hook, or helmet's
 * `noCache`-style option) that sets `cache-control: no-store` on any reply that
 * has no Cache-Control yet: Fastify's own 404, `/healthz`, `/v1/*` (success and
 * error) and `/api/auth/*`. A Cache-Control set by a handler (or copied from
 * Better Auth's response) is left untouched. Nothing is required here of
 * routes that set their own.
 */
describe('apps/api anti-caching default (ASVS V8.2.1, ZAP 10049)', () => {
  const ORIGIN = 'https://app.tayzu.test';
  const PASSWORD = 'correct horse battery staple';
  let app: App;

  beforeAll(async () => {
    app = await createApp({
      ...(await harnessPools()),
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ORIGIN],
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
  }, 60_000);

  it('sends cache-control: no-store on Fastify 404 for an unknown path', async () => {
    const response = await app.app.inject({
      method: 'GET',
      url: '/robots.txt',
      headers: { 'x-forwarded-for': randomIp() },
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('sends cache-control: no-store on GET /healthz', async () => {
    const response = await app.app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-forwarded-for': randomIp() },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('sends cache-control: no-store on an authenticated /v1 catalog response', async () => {
    const suffix = randomUUID();
    const tenant = await bootstrapTestTenant(app.auth, {
      name: 'Cache Header User',
      email: `cache-${suffix}@example.test`,
      password: PASSWORD,
      organizationName: `Cache Org ${suffix}`,
      organizationSlug: `cache-org-${suffix}`,
      ip: randomIp(),
    });
    // An org admin needs an enrolled factor to reach /v1 (Q43).
    const cookie = await freshMfaSessionCookie(app, {
      email: tenant.email,
      password: PASSWORD,
      enrollmentCookie: tenant.cookie,
      origin: ORIGIN,
    });
    const response = await app.app.inject({
      method: 'GET',
      url: '/v1/blueprints',
      headers: { cookie, origin: ORIGIN, 'x-forwarded-for': randomIp() },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
  }, 60_000);

  it('sends cache-control: no-store on a Better Auth route response', async () => {
    const response = await app.app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
      headers: { 'x-forwarded-for': randomIp() },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
  });
});
