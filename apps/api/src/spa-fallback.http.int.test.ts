/**
 * Integration test for task 4.3 of change `003-catalog-ui-core` (design D9 "SPA fallback",
 * "Rate limit"; Q28; `specs/catalog-ui-core/spec.md`, Requirement "The web app is served
 * from the API's own origin").
 *
 * Task 4.3 Verify (excerpt): "`spa-fallback.http.int.test.ts` covers "An app path answers
 * the app", "A user page with an email in its path answers the app", "API and auth paths
 * are unchanged", "No build directory, no app", a `%`, `//` or backslash path still
 * refused by the Q74 hook, the bucket answering `429` past its limit, and `index.html`
 * read once (a change on disk after startup is not served)".
 *
 * Scenarios (verbatim):
 * - "An app path answers the app": GIVEN the API is started with a build directory, WHEN a
 *   browser requests `GET /catalog/service`, THEN it receives the app's `index.html` with
 *   `Cache-Control: no-store`.
 * - "A user page with an email in its path answers the app": GIVEN the API is started with
 *   a build directory, WHEN a browser requests `GET /catalog/_user/alice@example.com` and
 *   `GET /catalog/service/v1.2`, THEN each receives the app's `index.html`.
 * - "API and auth paths are unchanged": GIVEN the API is started with a build directory,
 *   WHEN a client requests `GET /v1/unknown`, `GET /api/auth/unlisted` and
 *   `POST /catalog/service`, THEN each answers exactly as it does without the build
 *   directory.
 * - "No build directory, no app": GIVEN the API is started without a build directory, WHEN
 *   a browser requests `GET /`, THEN it receives the same 404 as before this change.
 *
 * Design D9 (excerpt): "answers `index.html` (`text/html; charset=utf-8`,
 * `Cache-Control: no-store`), whatever the path holds [...]. `index.html` is read once at
 * startup and the style nonce of D10 is substituted in memory per response. Any other
 * method on such a path is the usual 404. The Q74 hook still runs first, so a path with
 * `%`, `//` or a backslash never reaches the fallback. [...] `@fastify/rate-limit` runs
 * with `global: false`, so the fallback opts in to its own in-memory bucket keyed by
 * `request.ip` (300 requests per minute per replica, never logged); hashed assets get no
 * in-process limit".
 *
 * ## The served body and task 4.5
 *
 * Task 4.5 substitutes a per-response nonce into the `tayzu-style-nonce` meta, so the body
 * will stop being byte-equal to the fixture. Each body is compared to the fixture
 * `index.html` after the `content` of that one meta is put back to the fixture's
 * placeholder (`withFixtureNonce`). The comparison is exact everywhere else, so it holds
 * before and after 4.5, and 4.5's own test (`csp-nonce.http.int.test.ts`) asserts the
 * substitution itself.
 *
 * ## Harness
 *
 * The fixture build is copied into a fresh temporary directory, and three apps start over
 * it: `web` (the default fallback bucket), `limited` (a fallback bucket of
 * `LIMIT` requests per minute) and `plain` (no build directory). Right after startup the
 * copy's `index.html` is overwritten with a different page carrying `CHANGED_MARKER`; no
 * response may ever carry it (read once). Requests go through `app.inject` with a fresh
 * `x-forwarded-for` (the harness peer is loopback, which `trustProxy` trusts), except the
 * Q74 targets, which go over a raw TCP socket to the listening `web` app, because
 * `app.inject` normalizes `//` and backslashes (the precedent is
 * `request-target.int.test.ts`).
 *
 * ## Production symbols expected (the red phase)
 *
 * - `createApp` (`./server.js`) with `webDistDir` registers the fallback as one `GET`
 *   route at `/*` (Fastify derives its `HEAD`). For a pathname where `isSpaPath`
 *   (`./spa-paths.js`) is true it answers the in-memory `index.html` with
 *   `Content-Type: text/html; charset=utf-8` and `Cache-Control: no-store`; otherwise it
 *   answers exactly what the server answers without a build (`reply.callNotFound()`,
 *   Fastify's own 404).
 * - `CreateAppOptions.spaFallbackRateLimit?: { readonly max: number; readonly
 *   timeWindowMs: number }`, the fallback's own `@fastify/rate-limit` bucket, keyed by
 *   `request.ip` only, default `{ max: 300, timeWindowMs: 60_000 }`. It applies only to a
 *   request the fallback answers with the app (an `isSpaPath` path): a non-app path that
 *   reaches `/*`, an asset, a root build file, `/healthz`, `/v1/*` and any other method
 *   never count against it and never answer its `429`. The key is never logged, never
 *   exported and never in a response. (Passed through a spread so this file type-checks
 *   before the option exists.)
 * - Without `webDistDir` nothing of this is registered.
 *
 * ## Why this fails right now
 *
 * No fallback route exists: every app path answers Fastify's 404, so the app-path
 * scenarios, the read-once check and the `429` fail on status. The "unchanged", "no build"
 * and Q74 cases already pass: they are guards the fallback must keep green.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Import order is load-bearing (design D1): the telemetry harness must register
// before anything that loads `@tayzu/auth`, so this import stays first.
import { registration, type TelemetryTestHarness } from './__fixtures__/link-telemetry.js';
import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { csrfHeaders } from './__fixtures__/csrf.js';
import { harnessPools, type HarnessPools } from './__fixtures__/pools.js';
import { createApp, type App } from './server.js';

const ORIGIN = 'https://app.tayzu.test';
const FIXTURE_DIR = fileURLToPath(new URL('./__fixtures__/web-dist/', import.meta.url));
const INDEX_MARKER = 'web-dist-index-html';
const CHANGED_MARKER = `changed-index-html-${randomUUID()}`;
const NONCE_PLACEHOLDER = '__TAYZU_STYLE_NONCE__';
const HTML = /^text\/html; charset=utf-8$/i;
const HASHED_JS = 'index-Fx7Wd1Aa.js';
const LIMIT = 3;
const DEFAULT_LIMIT = 300;

/** A fresh random IP per request, so no bucket ever interferes unless a test wants it. */
function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

/** The body with the style-nonce meta's `content` put back to the fixture placeholder. */
function withFixtureNonce(body: string): string {
  return body.replace(
    /(<meta name="tayzu-style-nonce" content=")[^"]*(")/,
    `$1${NONCE_PLACEHOLDER}$2`,
  );
}

/** Fastify's own 404 body for an unregistered route. */
function fastifyNotFound(method: string, path: string): unknown {
  return { message: `Route ${method}:${path} not found`, error: 'Not Found', statusCode: 404 };
}

interface RawResponse {
  readonly statusCode: number;
  readonly raw: string;
}

/** Sends one HTTP/1.1 request line byte for byte and reads until the server closes. */
function rawGet(port: number, target: string): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    socket.on('connect', () => {
      socket.write(
        `GET ${target} HTTP/1.1\r\nhost: 127.0.0.1:${port.toString(10)}\r\n` +
          `x-forwarded-for: ${randomIp()}\r\nconnection: close\r\n\r\n`,
      );
    });
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    socket.on('error', reject);
    socket.on('close', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const statusMatch = /^HTTP\/1\.1 (\d{3})/.exec(raw);
      if (statusMatch?.[1] === undefined) {
        reject(new Error('no HTTP status line in the response'));
        return;
      }
      resolve({ statusCode: Number(statusMatch[1]), raw });
    });
  });
}

type Method = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE';

interface Observed {
  readonly statusCode: number;
  readonly body: string;
  readonly contentType: unknown;
  readonly cacheControl: unknown;
}

async function call(app: App, method: Method, url: string, ip = randomIp()): Promise<Observed> {
  const response = await app.app.inject({
    method,
    url,
    headers: { origin: ORIGIN, 'x-forwarded-for': ip, ...csrfHeaders(method) },
  });
  return {
    statusCode: response.statusCode,
    body: response.body,
    contentType: response.headers['content-type'],
    cacheControl: response.headers['cache-control'],
  };
}

function telemetry(): TelemetryTestHarness {
  if (!('harness' in registration)) {
    throw new Error(`telemetry harness failed to register: ${String(registration.error)}`, {
      cause: registration.error,
    });
  }
  return registration.harness;
}

let pools: HarnessPools;
let workDir: string;
let webDistDir: string;
let fixtureIndex: string;
let web: App;
let limited: App;
let plain: App;
let port: number;

async function buildApp(withWeb: boolean, extra: object = {}): Promise<App> {
  return createApp({
    ...pools,
    authSecret: TEST_SECRET,
    cerbosAddress: 'localhost:3593',
    allowedOrigins: [ORIGIN],
    ...(withWeb ? { webDistDir } : {}),
    ...extra,
  });
}

beforeAll(async () => {
  pools = await harnessPools();
  fixtureIndex = await readFile(join(FIXTURE_DIR, 'index.html'), 'utf8');
  expect(fixtureIndex).toContain(INDEX_MARKER);
  expect(fixtureIndex).toContain(NONCE_PLACEHOLDER);
  workDir = await mkdtemp(join(tmpdir(), 'tayzu-spa-fallback-'));
  webDistDir = join(workDir, 'web-dist');
  await cp(FIXTURE_DIR, webDistDir, { recursive: true });

  web = await buildApp(true);
  limited = await buildApp(true, {
    ...{ spaFallbackRateLimit: { max: LIMIT, timeWindowMs: 60_000 } },
  });
  plain = await buildApp(false);
  await web.app.listen({ host: '127.0.0.1', port: 0 });
  port = (web.app.server.address() as AddressInfo).port;

  // After startup: `index.html` was read once, so this page must never be served.
  await writeFile(
    join(webDistDir, 'index.html'),
    `<!doctype html><html><head><meta name="tayzu-fixture" content="${CHANGED_MARKER}" />` +
      `</head><body></body></html>\n`,
  );
}, 60_000);

afterAll(async () => {
  await web.close();
  await limited.close();
  await plain.close();
  await rm(workDir, { recursive: true, force: true });
}, 60_000);

function expectAppPage(observed: Observed, label: string): void {
  expect(observed.statusCode, label).toBe(200);
  expect(observed.contentType, label).toMatch(HTML);
  expect(observed.cacheControl, label).toBe('no-store');
  expect(withFixtureNonce(observed.body), label).toBe(fixtureIndex);
  expect(observed.body, label).not.toContain(CHANGED_MARKER);
}

function expectAppHead(observed: Observed, label: string): void {
  expect(observed.statusCode, label).toBe(200);
  expect(observed.contentType, label).toMatch(HTML);
  expect(observed.cacheControl, label).toBe('no-store');
  expect(observed.body, label).toBe('');
}

describe('the SPA fallback with a build directory (task 4.3, design D9)', () => {
  it('An app path answers the app: GET /catalog/service receives index.html with no-store', async () => {
    expectAppPage(await call(web, 'GET', '/catalog/service'), 'GET /catalog/service');
  });

  it('An app path answers the app: GET and HEAD of / and /catalog/service/x', async () => {
    for (const path of ['/', '/catalog/service/x']) {
      expectAppPage(await call(web, 'GET', path), `GET ${path}`);
      expectAppHead(await call(web, 'HEAD', path), `HEAD ${path}`);
    }
  });

  it('A user page with an email in its path answers the app: /catalog/_user/alice@example.com and /catalog/service/v1.2', async () => {
    for (const path of ['/catalog/_user/alice@example.com', '/catalog/service/v1.2']) {
      expectAppPage(await call(web, 'GET', path), `GET ${path}`);
    }
  });

  it('other app paths answer the app too: no prefix or extension rule', async () => {
    for (const path of [
      '/accept-invitation',
      '/reset-password',
      '/apix',
      '/v1x',
      '/assetsx',
      '/catalog/',
      '/catalog/service/payments.api',
      '/catalog/service?sort=name&cursor=abc',
    ]) {
      expectAppPage(await call(web, 'GET', path), `GET ${path}`);
    }
  });

  it('index.html is read once: a change on disk after startup is not served', async () => {
    const onDisk = await readFile(join(webDistDir, 'index.html'), 'utf8');
    expect(onDisk).toContain(CHANGED_MARKER);

    const observed = await call(web, 'GET', '/catalog/service');

    expect(observed.statusCode).toBe(200);
    expect(observed.body).toContain(INDEX_MARKER);
    expect(observed.body).not.toContain(CHANGED_MARKER);
    expect(withFixtureNonce(observed.body)).toBe(fixtureIndex);
  });

  it('API and auth paths are unchanged: GET /v1/unknown, GET /api/auth/unlisted and POST /catalog/service answer exactly as without the build directory', async () => {
    const cases: readonly (readonly [Method, string])[] = [
      ['GET', '/v1/unknown'],
      ['GET', '/api/auth/unlisted'],
      ['POST', '/catalog/service'],
    ];
    for (const [method, path] of cases) {
      const withBuild = await call(web, method, path);
      const withoutBuild = await call(plain, method, path);

      expect(withBuild, `${method} ${path}`).toStrictEqual(withoutBuild);
      expect(withBuild.body, `${method} ${path}`).not.toContain(INDEX_MARKER);
    }
    expect((await call(web, 'GET', '/v1/unknown')).statusCode).toBe(401);
    const unlisted = await call(web, 'GET', '/api/auth/unlisted');
    expect(unlisted.statusCode).toBe(404);
    const post = await call(web, 'POST', '/catalog/service');
    expect(post.statusCode).toBe(404);
    expect(JSON.parse(post.body)).toStrictEqual(fastifyNotFound('POST', '/catalog/service'));
  });

  it('API and auth paths are unchanged: the paths the fallback excludes answer as without the build directory', async () => {
    const cases: readonly (readonly [Method, string])[] = [
      ['GET', '/v1'],
      ['GET', '/v1/'],
      ['HEAD', '/v1/unknown'],
      ['GET', '/api'],
      ['GET', '/api/'],
      ['GET', '/api/x'],
      ['GET', '/api/auth'],
      ['GET', '/assets'],
      ['GET', '/assets/'],
      ['GET', '/assets/x.js'],
      ['GET', '/healthz'],
    ];
    for (const [method, path] of cases) {
      const withBuild = await call(web, method, path);
      const withoutBuild = await call(plain, method, path);

      expect(withBuild, `${method} ${path}`).toStrictEqual(withoutBuild);
      expect(withBuild.body, `${method} ${path}`).not.toContain(INDEX_MARKER);
    }
  });

  it('any other method on an app path is the usual 404, as without the build directory', async () => {
    const cases: readonly (readonly [Method, string])[] = [
      ['POST', '/'],
      ['PUT', '/catalog/service'],
      ['DELETE', '/catalog/service/x'],
      ['POST', '/catalog/_user/alice@example.com'],
    ];
    for (const [method, path] of cases) {
      const withBuild = await call(web, method, path);
      const withoutBuild = await call(plain, method, path);

      expect(withBuild, `${method} ${path}`).toStrictEqual(withoutBuild);
      expect(withBuild.statusCode, `${method} ${path}`).toBe(404);
      expect(JSON.parse(withBuild.body), `${method} ${path}`).toStrictEqual(
        fastifyNotFound(method, path),
      );
    }
  });

  describe('a %, // or backslash path is still refused by the Q74 hook', () => {
    const targets: readonly string[] = [
      '/catalog/_user/a%40b.com',
      '/%63atalog/service',
      '//catalog/service',
      '/catalog//service',
      '/catalog\\service',
      '/\\catalog',
    ];

    it('an ordinary app path over the same raw socket answers the app', async () => {
      const response = await rawGet(port, '/catalog/service');

      expect(response.statusCode).toBe(200);
      expect(response.raw).toContain(INDEX_MARKER);
    });

    for (const target of targets) {
      it(`${target} answers 404 and never reaches the fallback`, async () => {
        const response = await rawGet(port, target);

        expect(response.statusCode).toBe(404);
        expect(response.raw).not.toContain(INDEX_MARKER);
        expect(response.raw).not.toMatch(/^content-type: text\/html/im);
      });
    }
  });
});

describe('the fallback IP bucket (task 4.3, design D9 "Rate limit")', () => {
  it('the bucket answers 429 past its limit, per client address', async () => {
    const ip = randomIp();
    for (let index = 0; index < LIMIT; index += 1) {
      expectAppPage(await call(limited, 'GET', '/catalog/service', ip), `request ${String(index)}`);
    }

    const over = await call(limited, 'GET', '/catalog/_user/alice@example.com', ip);

    expect(over.statusCode).toBe(429);
    expect(over.body).not.toContain(INDEX_MARKER);
    // Keyed by `request.ip`: another address still gets the app.
    expectAppPage(await call(limited, 'GET', '/catalog/service', randomIp()), 'another IP');
  });

  it('the bucket is the fallback own: past its limit, every other route answers as before', async () => {
    const ip = randomIp();
    for (let index = 0; index < LIMIT; index += 1) {
      expect((await call(limited, 'GET', '/', ip)).statusCode).toBe(200);
    }
    expect((await call(limited, 'GET', '/', ip)).statusCode).toBe(429);

    // Assets and root build files get no in-process limit.
    const asset = await call(limited, 'GET', `/assets/${HASHED_JS}`, ip);
    expect(asset.statusCode).toBe(200);
    expect((await call(limited, 'GET', '/theme-init.js', ip)).statusCode).toBe(200);
    expect((await call(limited, 'GET', '/favicon.svg', ip)).statusCode).toBe(200);
    expect((await call(limited, 'GET', '/healthz', ip)).statusCode).toBe(200);
    // A path the fallback does not answer with the app is not limited by its bucket.
    const cases: readonly (readonly [Method, string])[] = [
      ['GET', '/v1/unknown'],
      ['GET', '/v1'],
      ['GET', '/api/x'],
      ['GET', '/api/auth/unlisted'],
      ['GET', '/assets/x.js'],
      ['POST', '/catalog/service'],
    ];
    for (const [method, path] of cases) {
      const withBuild = await call(limited, method, path, ip);
      const withoutBuild = await call(plain, method, path, ip);

      expect(withBuild, `${method} ${path}`).toStrictEqual(withoutBuild);
    }
  });

  it('the default bucket is 300 requests per minute per address', async () => {
    const ip = randomIp();
    for (let index = 0; index < DEFAULT_LIMIT; index += 1) {
      const observed = await call(web, 'GET', '/catalog/service', ip);
      expect(observed.statusCode, `request ${String(index)}`).toBe(200);
    }

    expect((await call(web, 'GET', '/catalog/service', ip)).statusCode).toBe(429);
  }, 60_000);

  it('the bucket key is never logged, exported or answered', async () => {
    const harness = telemetry();
    await harness.reset();
    const ip = randomIp();
    for (let index = 0; index <= LIMIT; index += 1) {
      await call(limited, 'GET', '/catalog/service', ip);
    }
    const response = await limited.app.inject({
      method: 'GET',
      url: '/catalog/service',
      headers: { origin: ORIGIN, 'x-forwarded-for': ip },
    });
    expect(response.statusCode).toBe(429);
    expect(response.body).not.toContain(ip);
    expect(JSON.stringify(response.headers)).not.toContain(ip);

    await harness.forceFlush();
    const logs = harness.logExporter.getFinishedLogRecords().map((record) => ({
      eventName: record.eventName,
      body: record.body,
      attributes: record.attributes,
    }));
    const spans = harness.spanExporter.getFinishedSpans().map((span) => ({
      name: span.name,
      attributes: span.attributes,
      events: span.events.map((event) => ({ name: event.name, attributes: event.attributes })),
    }));
    expect(JSON.stringify(logs)).not.toContain(ip);
    expect(JSON.stringify(spans)).not.toContain(ip);
  });
});

describe('No build directory, no app (task 4.3, design D9)', () => {
  it('No build directory, no app: GET / receives the same 404 as before this change', async () => {
    const observed = await call(plain, 'GET', '/');

    expect(observed.statusCode).toBe(404);
    expect(JSON.parse(observed.body)).toStrictEqual(fastifyNotFound('GET', '/'));
    expect(observed.cacheControl).toBe('no-store');
    expect(observed.body).not.toContain(INDEX_MARKER);
  });

  it('every app path answers Fastify own 404 without a build directory', async () => {
    for (const path of [
      '/catalog/service',
      '/catalog/service/x',
      '/catalog/_user/alice@example.com',
      '/catalog/service/v1.2',
      '/accept-invitation',
    ]) {
      const observed = await call(plain, 'GET', path);

      expect(observed.statusCode, path).toBe(404);
      expect(JSON.parse(observed.body), path).toStrictEqual(fastifyNotFound('GET', path));
      expect(observed.cacheControl, path).toBe('no-store');

      const head = await call(plain, 'HEAD', path);
      expect(head.statusCode, `HEAD ${path}`).toBe(404);
      expect(head.contentType, `HEAD ${path}`).not.toMatch(/^text\/html/i);
    }
  });
});
