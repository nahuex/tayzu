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
import { randomInt } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
