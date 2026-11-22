/**
 * Integration test for task 11.6 of `002` (design D13 "Security headers"), extended by
 * task 4.4 of `003-catalog-ui-core` (design D10, ADR-0026, Resolved decisions Q5, Q15,
 * Q25).
 *
 * Task 11.6 (`002`): "`@fastify/helmet` registered [...]. Verify: `headers.int.test.ts`
 * asserts the expected security headers are present on a response."
 *
 * Task 4.4 (`003`): "The CSP and security headers on every response, with or without
 * `WEB_DIST_DIR` (design D10): helmet with `contentSecurityPolicy.useDefaults: false`
 * and the exact directive list, `xFrameOptions: { action: 'deny' }`,
 * `Cross-Origin-Embedder-Policy: require-corp` and the `Permissions-Policy` without
 * `interest-cohort`, with `Referrer-Policy: no-referrer`, COOP and CORP asserted.
 * Verify: `headers.int.test.ts` covers "The app page carries the policy" (without the
 * nonce part) and "API responses carry the policy too" on an HTML page, a `/v1` JSON
 * answer, an `/api/auth` answer, an asset and a 404, with and without `WEB_DIST_DIR`,
 * and HSTS and `no-store` unchanged; its two assertions that this decision changes,
 * `X-Frame-Options: SAMEORIGIN` (lines 83-84) and the absence of a CSP (lines
 * 103-106), are rewritten in the red step, not loosened."
 *
 * Spec `specs/catalog-ui-core/spec.md`, requirement "Every response carries a strict,
 * self-only Content Security Policy":
 *
 * > #### Scenario: The app page carries the policy
 * >
 * > - **GIVEN** the API is started with a build directory
 * > - **WHEN** a browser requests `GET /`
 * > - **THEN** the response carries the exact policy and headers above, and its nonce
 * >   differs from that of a second request
 *
 * > #### Scenario: API responses carry the policy too
 * >
 * > - **WHEN** a client requests `GET /v1/blueprints` without a session
 * > - **THEN** the `401` response carries the same policy and headers
 *
 * The nonce clause ("its nonce differs from that of a second request") is task 4.5
 * (`csp-nonce.http.int.test.ts`). Here `style-src` must hold `'self'`, no
 * `'unsafe-inline'`, and nothing but `'self'` and at most a nonce source, so the
 * assertions hold both before and after task 4.5 adds the nonce.
 *
 * Design D10 "One policy on every response" (the exact directive list):
 *
 *   default-src 'self'; script-src 'self'; style-src 'self' 'nonce-<n>';
 *   img-src 'self'; font-src 'self'; connect-src 'self'; media-src 'none';
 *   object-src 'none'; frame-src 'none'; worker-src 'none'; manifest-src 'self';
 *   base-uri 'none'; form-action 'self'; frame-ancestors 'none'
 *
 * D10 "Other headers": `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`,
 * `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy:
 * same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, `X-Content-Type-Options:
 * nosniff`, `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(),
 * usb=()` (without `interest-cohort`). HSTS stays as `002` set it; `Cache-Control:
 * no-store` stays the default for everything but hashed assets.
 *
 * ## Harness
 *
 * Two apps: one without `webDistDir` (the API alone) and one with `webDistDir` set to
 * the committed fixture `__fixtures__/web-dist/` (read only; nothing is written to it).
 * Every response of both apps must carry the same header set: an HTML page (the
 * fallback, only with the build), a `/v1` JSON answer, an `/api/auth` answer, an asset
 * and a root build file (with the build) and a 404.
 *
 * ## Production symbols expected
 *
 * - `createApp` (`./server.js`) registers `@fastify/helmet` globally with
 *   `contentSecurityPolicy: { useDefaults: false, directives: <D10> }`,
 *   `xFrameOptions: { action: 'deny' }`, `crossOriginEmbedderPolicy: { policy:
 *   'require-corp' }`, HSTS unchanged, and sets the `Permissions-Policy` of D10 on every
 *   response, whether or not `webDistDir` is set.
 *
 * ## Why this fails right now (task 4.4 red)
 *
 * helmet runs with `contentSecurityPolicy: false` (no CSP header), the default
 * `X-Frame-Options: SAMEORIGIN`, no COEP and no `Permissions-Policy`: assertion
 * failures on every target of both apps. The other headers already pass; they are
 * guards the new configuration must keep green.
 *
 * Every request uses a fresh random IP so the rate limiters never interfere.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bootstrapTestTenant,
  testAppPool,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { freshMfaSessionCookie } from './__fixtures__/fresh-mfa.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createApp, type App } from './server.js';
import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

const FIXTURE_WEB_DIST = fileURLToPath(new URL('./__fixtures__/web-dist/', import.meta.url));

/**
 * D10's directive list, every directive but `style-src`, which is checked on its own
 * (`'self'` plus at most the nonce of task 4.5). Each value is the exact source list.
 */
const EXPECTED_CSP_DIRECTIVES: Readonly<Record<string, readonly string[]>> = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'img-src': ["'self'"],
  'font-src': ["'self'"],
  'connect-src': ["'self'"],
  'media-src': ["'none'"],
  'object-src': ["'none'"],
  'frame-src': ["'none'"],
  'worker-src': ["'none'"],
  'manifest-src': ["'self'"],
  'base-uri': ["'none'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
};

/** Every directive name D10 lists, and no other (no `upgrade-insecure-requests`). */
const EXPECTED_CSP_DIRECTIVE_NAMES: readonly string[] = [
  ...Object.keys(EXPECTED_CSP_DIRECTIVES),
  'style-src',
].sort();

/** A CSP nonce source, `'nonce-<base64>'`; its value is task 4.5's concern. */
const NONCE_SOURCE = /^'nonce-[A-Za-z0-9+/_-]+={0,2}'$/;

/** D10's `Permissions-Policy`, every feature disabled; `interest-cohort` is absent. */
const EXPECTED_PERMISSIONS_POLICY: readonly string[] = [
  'camera=()',
  'microphone=()',
  'geolocation=()',
  'payment=()',
  'usb=()',
].sort();

interface ParsedCsp {
  /** Directive name (lower case) to its source list, in header order. */
  readonly directives: ReadonlyMap<string, readonly string[]>;
  /** Directive names that appear more than once (a browser ignores the repeats). */
  readonly duplicates: readonly string[];
}

/** Parses one serialized CSP (`name src src; name src`) directive by directive. */
function parseCsp(header: string): ParsedCsp {
  const directives = new Map<string, readonly string[]>();
  const duplicates: string[] = [];
  for (const part of header.split(';')) {
    const tokens = part
      .trim()
      .split(/\s+/)
      .filter((token) => token.length > 0);
    const [rawName, ...sources] = tokens;
    if (rawName === undefined) {
      continue;
    }
    const name = rawName.toLowerCase();
    if (directives.has(name)) {
      duplicates.push(name);
      continue;
    }
    directives.set(name, sources);
  }
  return { directives, duplicates };
}

/** Reads a single-valued header as a string, failing the test on anything else. */
function singleHeader(value: string | string[] | number | undefined, name: string): string {
  if (typeof value !== 'string') {
    throw new Error(`expected exactly one ${name} header, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** The CSP with nonce sources removed, so two responses can be compared. */
function cspWithoutNonce(header: string): Record<string, readonly string[]> {
  const { directives } = parseCsp(header);
  const result: Record<string, readonly string[]> = {};
  for (const [name, sources] of directives) {
    result[name] = sources.filter((source) => !NONCE_SOURCE.test(source));
  }
  return result;
}

/** The headers of D10 that must be identical on every response of the server. */
const POLICY_HEADERS = [
  'x-content-type-options',
  'x-frame-options',
  'referrer-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'cross-origin-embedder-policy',
  'permissions-policy',
  'strict-transport-security',
] as const;

const NO_STORE = 'no-store';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const NO_CACHE = 'no-cache';

interface Target {
  readonly name: string;
  readonly url: string;
  /** The status the route already answers; a guard that the right route was reached. */
  readonly status: number;
  /** The Cache-Control the route already sends (unchanged by task 4.4). */
  readonly cacheControl: string;
}

interface Variant {
  readonly name: string;
  readonly webDistDir: string | undefined;
  readonly targets: readonly Target[];
}

const V1_TARGET: Target = {
  name: 'a /v1 JSON response (unauthenticated, 401)',
  url: '/v1/blueprints',
  status: 401,
  cacheControl: NO_STORE,
};
const AUTH_TARGET: Target = {
  name: 'a Better Auth response',
  url: '/api/auth/get-session',
  status: 200,
  cacheControl: NO_STORE,
};

const VARIANTS: readonly Variant[] = [
  {
    name: 'without webDistDir (the API alone)',
    webDistDir: undefined,
    targets: [
      V1_TARGET,
      AUTH_TARGET,
      {
        name: 'an unknown route (404)',
        url: '/no-such-route',
        status: 404,
        cacheControl: NO_STORE,
      },
    ],
  },
  {
    name: 'with webDistDir (the fixture build)',
    webDistDir: FIXTURE_WEB_DIST,
    targets: [
      { name: 'the app page GET / (HTML)', url: '/', status: 200, cacheControl: NO_STORE },
      {
        name: 'an app path answered by the fallback (HTML)',
        url: '/catalog/service/payments',
        status: 200,
        cacheControl: NO_STORE,
      },
      V1_TARGET,
      AUTH_TARGET,
      {
        name: 'a hashed asset',
        url: '/assets/index-Fx7Wd1Aa.js',
        status: 200,
        cacheControl: IMMUTABLE,
      },
      { name: 'a root build file', url: '/theme-init.js', status: 200, cacheControl: NO_CACHE },
      {
        name: 'a missing asset (404)',
        url: '/assets/index-Nope0000.js',
        status: 404,
        cacheControl: NO_STORE,
      },
    ],
  },
];

describe('apps/api security headers (002 task 11.6, 003 task 4.4)', () => {
  for (const variant of VARIANTS) {
    describe(variant.name, () => {
      let app: App;

      beforeAll(async () => {
        app = await createApp({
          ...(await harnessPools()),
          authSecret: TEST_SECRET,
          cerbosAddress: 'localhost:3593',
          allowedOrigins: ['https://app.tayzu.test'],
          ...(variant.webDistDir === undefined ? {} : { webDistDir: variant.webDistDir }),
        });
      }, 60_000);

      afterAll(async () => {
        await app.close();
      }, 60_000);

      async function get(url: string) {
        return app.app.inject({
          method: 'GET',
          url,
          headers: { 'x-forwarded-for': randomIp() },
        });
      }

      for (const target of variant.targets) {
        describe(`on ${target.name}`, () => {
          it(`answers ${target.status.toString(10)} with cache-control: ${target.cacheControl} (unchanged)`, async () => {
            const response = await get(target.url);
            expect(response.statusCode).toBe(target.status);
            expect(response.headers['cache-control']).toBe(target.cacheControl);
          });

          it('sends x-content-type-options: nosniff', async () => {
            expect((await get(target.url)).headers['x-content-type-options']).toBe('nosniff');
          });

          // 003 D10 rewrites 002's `SAMEORIGIN` (helmet's default) to `DENY`,
          // matching `frame-ancestors 'none'`.
          it('sends x-frame-options: DENY (003 D10)', async () => {
            expect((await get(target.url)).headers['x-frame-options']).toBe('DENY');
          });

          it('sends referrer-policy: no-referrer', async () => {
            expect((await get(target.url)).headers['referrer-policy']).toBe('no-referrer');
          });

          it('sends cross-origin-opener-policy and cross-origin-resource-policy: same-origin', async () => {
            const { headers } = await get(target.url);
            expect(headers['cross-origin-opener-policy']).toBe('same-origin');
            expect(headers['cross-origin-resource-policy']).toBe('same-origin');
          });

          it('sends cross-origin-embedder-policy: require-corp (003 D10)', async () => {
            expect((await get(target.url)).headers['cross-origin-embedder-policy']).toBe(
              'require-corp',
            );
          });

          it('sends the permissions-policy of D10, without interest-cohort (003 D10)', async () => {
            const header = singleHeader(
              (await get(target.url)).headers['permissions-policy'],
              'permissions-policy',
            );
            const entries = header
              .split(',')
              .map((entry) => entry.trim().replace(/\s+/g, ''))
              .filter((entry) => entry.length > 0);
            expect(header).not.toMatch(/interest-cohort/i);
            expect(new Set(entries).size).toBe(entries.length);
            expect([...entries].sort()).toEqual(EXPECTED_PERMISSIONS_POLICY);
          });

          it('sends x-dns-prefetch-control: off and x-permitted-cross-domain-policies: none', async () => {
            const { headers } = await get(target.url);
            expect(headers['x-dns-prefetch-control']).toBe('off');
            expect(headers['x-permitted-cross-domain-policies']).toBe('none');
          });

          // 003 D10 rewrites 002's "no CSP" (`contentSecurityPolicy: false`): the strict,
          // self-only policy is enforced on every response, never report-only.
          it('sends the D10 content-security-policy, enforced and not report-only (003 D10)', async () => {
            const { headers } = await get(target.url);
            expect(headers['content-security-policy-report-only']).toBeUndefined();
            const csp = parseCsp(
              singleHeader(headers['content-security-policy'], 'content-security-policy'),
            );
            expect(csp.duplicates).toEqual([]);
            expect([...csp.directives.keys()].sort()).toEqual(EXPECTED_CSP_DIRECTIVE_NAMES);
            for (const [name, sources] of Object.entries(EXPECTED_CSP_DIRECTIVES)) {
              expect({ [name]: csp.directives.get(name) }).toEqual({ [name]: sources });
            }
          });

          it("has script-src 'self' only: no 'unsafe-inline', no 'unsafe-eval', no nonce or hash (003 D10)", async () => {
            const csp = parseCsp(
              singleHeader(
                (await get(target.url)).headers['content-security-policy'],
                'content-security-policy',
              ),
            );
            const scriptSrc = csp.directives.get('script-src');
            expect(scriptSrc).toEqual(["'self'"]);
            expect(scriptSrc).not.toContain("'unsafe-inline'");
            expect(scriptSrc).not.toContain("'unsafe-eval'");
          });

          it("has style-src 'self' with no 'unsafe-inline' and nothing but at most a nonce (003 D10, Q15)", async () => {
            const csp = parseCsp(
              singleHeader(
                (await get(target.url)).headers['content-security-policy'],
                'content-security-policy',
              ),
            );
            const styleSrc = csp.directives.get('style-src');
            expect(styleSrc).toBeDefined();
            expect(styleSrc).toContain("'self'");
            expect(styleSrc).not.toContain("'unsafe-inline'");
            const others = (styleSrc ?? []).filter((source) => source !== "'self'");
            expect(others.length).toBeLessThanOrEqual(1);
            for (const source of others) {
              expect(source).toMatch(NONCE_SOURCE);
            }
          });

          it("has frame-ancestors 'none', object-src 'none', base-uri 'none' and form-action 'self' (Q25)", async () => {
            const csp = parseCsp(
              singleHeader(
                (await get(target.url)).headers['content-security-policy'],
                'content-security-policy',
              ),
            );
            expect(csp.directives.get('frame-ancestors')).toEqual(["'none'"]);
            expect(csp.directives.get('object-src')).toEqual(["'none'"]);
            expect(csp.directives.get('base-uri')).toEqual(["'none'"]);
            expect(csp.directives.get('form-action')).toEqual(["'self'"]);
          });

          it('does not advertise the framework via x-powered-by', async () => {
            expect((await get(target.url)).headers['x-powered-by']).toBeUndefined();
          });

          // Task 11.12 (TLS/HSTS posture): HSTS with max-age >= 1 year and includeSubDomains.
          it('sends strict-transport-security with max-age of at least one year and includeSubDomains (task 11.12)', async () => {
            const hsts = (await get(target.url)).headers['strict-transport-security'];
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
  }

  describe('the app page and an API response carry the same policy (003 D10)', () => {
    let webApp: App;
    let bareApp: App;

    beforeAll(async () => {
      const base = {
        ...(await harnessPools()),
        authSecret: TEST_SECRET,
        cerbosAddress: 'localhost:3593',
        allowedOrigins: ['https://app.tayzu.test'],
      };
      webApp = await createApp({ ...base, webDistDir: FIXTURE_WEB_DIST });
      bareApp = await createApp(base);
    }, 60_000);

    afterAll(async () => {
      await webApp.close();
      await bareApp.close();
    }, 60_000);

    async function get(app: App, url: string) {
      return app.app.inject({
        method: 'GET',
        url,
        headers: { 'x-forwarded-for': randomIp() },
      });
    }

    // Scenario "The app page carries the policy", without its nonce clause (task 4.5).
    it('The app page carries the policy (GET / with a build directory, nonce part in task 4.5)', async () => {
      const response = await get(webApp, '/');
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/^text\/html/);
      const csp = parseCsp(
        singleHeader(response.headers['content-security-policy'], 'content-security-policy'),
      );
      expect([...csp.directives.keys()].sort()).toEqual(EXPECTED_CSP_DIRECTIVE_NAMES);
      for (const [name, sources] of Object.entries(EXPECTED_CSP_DIRECTIVES)) {
        expect({ [name]: csp.directives.get(name) }).toEqual({ [name]: sources });
      }
      expect(response.headers['x-frame-options']).toBe('DENY');
      expect(response.headers['cross-origin-embedder-policy']).toBe('require-corp');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
    });

    // Scenario "API responses carry the policy too": the 401 of GET /v1/blueprints
    // without a session carries the same policy (nonce sources aside) and headers as
    // the app page, with and without the build directory.
    for (const [label, appOf] of [
      ['with webDistDir', () => webApp],
      ['without webDistDir', () => bareApp],
    ] as const) {
      it(`API responses carry the policy too (GET /v1/blueprints 401, ${label})`, async () => {
        const page = await get(webApp, '/');
        const api = await get(appOf(), '/v1/blueprints');
        expect(page.statusCode).toBe(200);
        expect(api.statusCode).toBe(401);
        const pageCsp = singleHeader(
          page.headers['content-security-policy'],
          'content-security-policy',
        );
        const apiCsp = singleHeader(
          api.headers['content-security-policy'],
          'content-security-policy',
        );
        expect(cspWithoutNonce(apiCsp)).toEqual(cspWithoutNonce(pageCsp));
        for (const name of POLICY_HEADERS) {
          expect({ [name]: api.headers[name] }).toEqual({ [name]: page.headers[name] });
          expect(api.headers[name]).toBeDefined();
        }
      });
    }
  });
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
      pool: testAppPool(),
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
