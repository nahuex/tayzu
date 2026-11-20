/**
 * Integration test for task 4.2 of change `003-catalog-ui-core` (design D9 "Assets";
 * `specs/catalog-ui-core/spec.md`, Requirement "The web app is served from the API's own
 * origin").
 *
 * Task 4.2: "The asset route (design D9): `@fastify/static` on `<WEB_DIST_DIR>/assets/`
 * at `/assets/` with `wildcard: false`, `dotfiles: 'deny'`, `index: false`,
 * `Cache-Control: public, max-age=31536000, immutable`, and the root build files
 * (`theme-init.js`, the favicon) from the build root with `no-cache`. Verify:
 * `web-static.http.int.test.ts`, against a fixture build in
 * `apps/api/src/__fixtures__/web-dist/`, covers a hashed asset with its type and its
 * `immutable` header not replaced by the `onSend` `no-store` hook, a root build file
 * with `no-cache`, a missing asset as a 404, and "A traversal attempt reaches no file"."
 *
 * Scenario (verbatim):
 * - "A traversal attempt reaches no file": GIVEN the API is started with a build
 *   directory, WHEN a client requests `/assets/../index.html`, `/assets/%2e%2e/secret` or
 *   `/assets/.env`, THEN each answers a 404 and no file outside the asset list is read.
 *
 * Requirement (excerpt): "The asset route MUST NOT read the file system with a
 * client-supplied path, and the immutable cache header of an asset MUST NOT be replaced
 * by the default `no-store`. [...] When no build directory is configured the server MUST
 * register no app route and answer every route as before".
 *
 * Design D9 (excerpt): "`wildcard: false` (the file list is read once at startup, one
 * route per file, so a request never reaches the file system with a client path),
 * `dotfiles: 'deny'`, `index: false`, no directory listing [...]; the `onSend`
 * `no-store` hook only fills a missing header, and a test proves it does not replace
 * `immutable`. A missing asset is Fastify's own 404. The root build files, an explicit
 * list (`theme-init.js` and the favicon), are served from the build root with
 * `no-cache`."
 *
 * ## Harness
 *
 * The fixture build (`__fixtures__/web-dist/`) is copied into a fresh temporary
 * directory, and files that must never be served are planted around it: a `secret` and
 * a `package.json` next to the build (outside it), an unlisted `secret` in the build
 * root, and `assets/.env` (a dotfile; `.env*` is git-ignored, so it cannot live in the
 * committed fixture). Each file carries a unique marker; no response may contain the
 * marker of a file it must not serve. A file added to `assets/` after startup proves the
 * file list is read once (`wildcard: false`).
 *
 * Two apps: one with `webDistDir` set to the copy, one without. Ordinary requests go
 * through `app.inject`. The traversal targets go over a raw TCP socket to the listening
 * app, because `app.inject` and `fetch` normalize `..`, `%2e%2e` and backslashes before
 * the server sees them (the precedent is `request-target.int.test.ts`).
 *
 * ## Production symbols expected (the red phase)
 *
 * - `createApp` (`./server.js`), with `webDistDir` set, registers `@fastify/static` over
 *   `<webDistDir>/assets/` at prefix `/assets/` with `wildcard: false`,
 *   `dotfiles: 'deny'`, `index: false`, no listing, and
 *   `Cache-Control: public, max-age=31536000, immutable`, a header the global `onSend`
 *   hook leaves in place because it is already set.
 * - The root build files `theme-init.js` and `favicon.svg` are served at `/<name>` from
 *   `<webDistDir>/` with `Cache-Control: no-cache`. No other root file is served by
 *   this route.
 * - Without `webDistDir`, none of this is registered: `/assets/*`, `/theme-init.js` and
 *   `/favicon.svg` answer Fastify's own 404, as today.
 *
 * ## Why this fails right now
 *
 * No asset or root-file route exists, so the hashed asset, the root build files and the
 * immutable / no-cache headers fail on status and header assertions. The 404 cases
 * (missing asset, traversal, `index: false`, no build directory) already pass: they are
 * guards the new route must keep green.
 */
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { harnessPools, type HarnessPools } from './__fixtures__/pools.js';
import { createApp, type App } from './server.js';

const ORIGIN = 'https://app.tayzu.test';
const FIXTURE_DIR = fileURLToPath(new URL('./__fixtures__/web-dist/', import.meta.url));

const IMMUTABLE = 'public, max-age=31536000, immutable';

const HASHED_JS = 'index-Fx7Wd1Aa.js';
const HASHED_CSS = 'index-Fx7Wd2Bb.css';
const LATE_ASSET = 'late-Zq8Rt4Kp.js';
const MISSING_ASSET = 'index-Nope0000.js';

/** Markers already in the committed fixture files. */
const FIXTURE_MARKERS = {
  indexHtml: 'web-dist-index-html',
  hashedJs: 'web-dist-index-js',
  hashedCss: 'web-dist-index-css',
  themeInit: 'web-dist-theme-init-js',
  favicon: 'web-dist-favicon-svg',
} as const;

/** Markers of the files planted at runtime; none of them may ever be served. */
const PLANTED = {
  outsideSecret: `outside-secret-${randomUUID()}`,
  outsidePackageJson: `outside-package-json-${randomUUID()}`,
  rootSecret: `root-secret-${randomUUID()}`,
  dotEnv: `dotfile-env-${randomUUID()}`,
  lateAsset: `late-asset-${randomUUID()}`,
} as const;

/** Every marker of a file that a traversal target must not reach. */
const NEVER_VIA_TRAVERSAL: readonly string[] = [
  FIXTURE_MARKERS.indexHtml,
  FIXTURE_MARKERS.themeInit,
  FIXTURE_MARKERS.favicon,
  PLANTED.outsideSecret,
  PLANTED.outsidePackageJson,
  PLANTED.rootSecret,
  PLANTED.dotEnv,
];

interface RawResponse {
  readonly statusCode: number;
  /** The whole response as received: status line, headers and body. */
  readonly raw: string;
}

/** Sends one HTTP/1.1 request line byte for byte and reads until the server closes. */
function rawGet(port: number, target: string): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    socket.on('connect', () => {
      socket.write(
        `GET ${target} HTTP/1.1\r\nhost: 127.0.0.1:${port.toString(10)}\r\nconnection: close\r\n\r\n`,
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

/** Fastify's own 404 body for an unregistered `GET` route. */
function fastifyNotFound(path: string): unknown {
  return { message: `Route GET:${path} not found`, error: 'Not Found', statusCode: 404 };
}

let pools: HarnessPools;
let workDir: string;
let webDistDir: string;

async function plantBuild(): Promise<void> {
  workDir = await mkdtemp(join(tmpdir(), 'tayzu-web-static-'));
  webDistDir = join(workDir, 'web-dist');
  await cp(FIXTURE_DIR, webDistDir, { recursive: true });
  await writeFile(join(workDir, 'secret'), `${PLANTED.outsideSecret}\n`);
  await writeFile(
    join(workDir, 'package.json'),
    `${JSON.stringify({ name: PLANTED.outsidePackageJson })}\n`,
  );
  await writeFile(join(webDistDir, 'secret'), `${PLANTED.rootSecret}\n`);
  await writeFile(join(webDistDir, 'assets', '.env'), `TOKEN=${PLANTED.dotEnv}\n`);
}

async function buildApp(withWeb: boolean): Promise<App> {
  return createApp({
    ...pools,
    authSecret: TEST_SECRET,
    cerbosAddress: 'localhost:3593',
    allowedOrigins: [ORIGIN],
    ...(withWeb ? { webDistDir } : {}),
  });
}

async function fixtureFile(...segments: string[]): Promise<string> {
  return readFile(join(FIXTURE_DIR, ...segments), 'utf8');
}

beforeAll(async () => {
  pools = await harnessPools();
  await plantBuild();
}, 60_000);

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
}, 60_000);

describe('apps/api web build static serving (task 4.2, design D9)', () => {
  let app: App;
  let port: number;

  beforeAll(async () => {
    app = await buildApp(true);
    await app.app.listen({ host: '127.0.0.1', port: 0 });
    port = (app.app.server.address() as AddressInfo).port;
    // Added after startup: with `wildcard: false` the file list is already fixed.
    await writeFile(join(webDistDir, 'assets', LATE_ASSET), `void '${PLANTED.lateAsset}';\n`);
  }, 60_000);

  afterAll(async () => {
    await app.close();
  }, 60_000);

  describe('hashed assets under /assets/', () => {
    it('a hashed JavaScript asset is served with its type and the immutable cache header', async () => {
      const response = await app.app.inject({ method: 'GET', url: `/assets/${HASHED_JS}` });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/^(text|application)\/javascript(;|$)/i);
      expect(response.headers['cache-control']).toBe(IMMUTABLE);
      expect(response.body).toBe(await fixtureFile('assets', HASHED_JS));
      expect(response.body).toContain(FIXTURE_MARKERS.hashedJs);
    });

    it('a hashed CSS asset is served with its type and the immutable cache header', async () => {
      const response = await app.app.inject({ method: 'GET', url: `/assets/${HASHED_CSS}` });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/^text\/css(;|$)/i);
      expect(response.headers['cache-control']).toBe(IMMUTABLE);
      expect(response.body).toBe(await fixtureFile('assets', HASHED_CSS));
    });

    it('the onSend no-store hook does not replace the immutable header of an asset', async () => {
      const response = await app.app.inject({ method: 'GET', url: `/assets/${HASHED_JS}` });

      expect(response.statusCode).toBe(200);
      // Exactly the asset's header: neither `no-store` nor a second value appended.
      expect(response.headers['cache-control']).toBe(IMMUTABLE);
      expect(response.headers['cache-control']).not.toContain('no-store');
    });

    it('a missing asset answers Fastify own 404, with no-store', async () => {
      const response = await app.app.inject({ method: 'GET', url: `/assets/${MISSING_ASSET}` });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toStrictEqual(fastifyNotFound(`/assets/${MISSING_ASSET}`));
      expect(response.headers['cache-control']).toBe('no-store');
    });

    it('index: false: /assets/ and /assets serve no index and no listing', async () => {
      for (const url of ['/assets/', '/assets']) {
        const response = await app.app.inject({ method: 'GET', url });

        expect(response.statusCode, url).toBe(404);
        expect(response.body, url).not.toContain(HASHED_JS);
        expect(response.body, url).not.toContain(HASHED_CSS);
        expect(response.body, url).not.toContain(FIXTURE_MARKERS.indexHtml);
        expect(response.headers['cache-control'], url).not.toBe(IMMUTABLE);
      }
    });
  });

  describe('root build files', () => {
    it('theme-init.js is served from the build root with no-cache', async () => {
      const response = await app.app.inject({ method: 'GET', url: '/theme-init.js' });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/^(text|application)\/javascript(;|$)/i);
      expect(response.headers['cache-control']).toBe('no-cache');
      expect(response.body).toBe(await fixtureFile('theme-init.js'));
    });

    it('the favicon is served from the build root with no-cache', async () => {
      const response = await app.app.inject({ method: 'GET', url: '/favicon.svg' });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/^image\/svg\+xml(;|$)/i);
      expect(response.headers['cache-control']).toBe('no-cache');
      expect(response.body).toBe(await fixtureFile('favicon.svg'));
    });

    it('an unlisted file in the build root is not served by the root-file route', async () => {
      const response = await app.app.inject({ method: 'GET', url: '/secret' });

      expect(response.body).not.toContain(PLANTED.rootSecret);
    });
  });

  describe('A traversal attempt reaches no file', () => {
    // The scenario's three targets first, then the variants task 4.2 names: an encoded
    // slash, other `%2e%2e` forms, a double slash and backslashes. Each goes over a raw
    // socket so the server sees it exactly as written.
    const targets: readonly string[] = [
      '/assets/../index.html',
      '/assets/%2e%2e/secret',
      '/assets/.env',
      '/assets/../secret',
      '/assets/../../secret',
      '/assets/../../package.json',
      '/assets/..%2f..%2fpackage.json',
      '/assets/%2e%2e/index.html',
      '/assets/%2E%2E/%2e%2e/package.json',
      '/assets/%2e%2e%2f%2e%2e%2fsecret',
      '/assets//../index.html',
      '/assets/..\\index.html',
      '/assets\\..\\index.html',
      '/assets/..\\..\\package.json',
    ];

    for (const target of targets) {
      it(`${target} answers 404 and serves no file`, async () => {
        const response = await rawGet(port, target);

        expect(response.statusCode).toBe(404);
        for (const marker of NEVER_VIA_TRAVERSAL) {
          expect(response.raw, marker).not.toContain(marker);
        }
      });
    }

    it('a file added to /assets/ after startup is not served (the asset list is read once)', async () => {
      const response = await app.app.inject({ method: 'GET', url: `/assets/${LATE_ASSET}` });

      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain(PLANTED.lateAsset);
    });
  });
});

describe('apps/api without a build directory (task 4.2, design D9)', () => {
  let app: App;

  beforeAll(async () => {
    app = await buildApp(false);
  }, 60_000);

  afterAll(async () => {
    await app.close();
  }, 60_000);

  it('no asset or root build file is served: each answers Fastify own 404, as today', async () => {
    for (const url of [
      '/assets/x.js',
      `/assets/${HASHED_JS}`,
      `/assets/${HASHED_CSS}`,
      '/theme-init.js',
      '/favicon.svg',
    ]) {
      const response = await app.app.inject({ method: 'GET', url });

      expect(response.statusCode, url).toBe(404);
      expect(response.json(), url).toStrictEqual(fastifyNotFound(url));
      expect(response.headers['cache-control'], url).toBe('no-store');
    }
  });
});
