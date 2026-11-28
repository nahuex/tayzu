/**
 * Integration test for task 6.10 of change `003-catalog-ui-core` (design D11 "Page rules",
 * D10 "One policy on every response" and "Other headers"; Resolved decisions Q28, Q58, Q59
 * and Q60).
 *
 * Task 6.10 (verbatim): "The page rules over HTTP (design D11): `/accept-invitation` and
 * `/reset-password` are served with `Referrer-Policy: no-referrer` and a CSP that allows
 * no other origin, and the served page references no other origin. Verify:
 * `web-page-rules.http.int.test.ts` covers both paths with and without a fragment (the
 * fragment never reaching the server), the headers, and the absence of any `http:` or
 * `https:` origin in the served HTML."
 *
 * Spec `specs/catalog-ui-core/spec.md`, "Page rules" (`043` Q32, `044` D14 and Q26): "a page
 * that receives a token in the URL fragment strips the fragment after reading it, is
 * served with `Referrer-Policy: no-referrer`, loads no third-party script and never
 * submits without a user action." Requirement "Every response carries a strict, self-only
 * Content Security Policy" (excerpt): "a Content Security Policy that allows scripts,
 * styles, images, fonts and connections from the app's own origin only [...]. Every
 * response MUST also carry `Referrer-Policy: no-referrer` [...]. The web app MUST load no
 * script, style, font or image from another origin." Requirement "The invitation and
 * password-reset pages follow the page rules" (excerpt): "The app MUST serve
 * `/accept-invitation` and `/reset-password` at the fixed paths the emailed links use".
 *
 * Design D11 "Page rules" (verbatim): "for the two link pages, tested over HTTP and in e2e:
 * `Referrer-Policy: no-referrer` (on every response, D10), no third-party request of any
 * kind (CSP and the e2e network check), the fragment gone from `location` before any
 * request is made, and no submit without a user action." The HTTP part is this file; the
 * `location` and submit parts are the page tests of tasks 6.8 and 6.9 and the e2e run.
 *
 * Design D10 (excerpt): the directive list `default-src 'self'; script-src 'self';
 * style-src 'self' 'nonce-<n>'; img-src 'self'; font-src 'self'; connect-src 'self';
 * media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; manifest-src
 * 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`, and
 * "`Referrer-Policy: no-referrer` (helmet's default, now asserted)". Change `048` design D9
 * adds two report directives, `report-uri /v1/csp-reports` and `report-to csp-endpoint`
 * (requirement "The policy MUST name the app's own same-origin violation report endpoint,
 * through both `report-uri` and `report-to`"): the path is resolved against the response's
 * own origin, so neither names another origin. Q60: helmet runs
 * before `002`'s Q74 request-target hook, so the 404 that hook answers carries the headers
 * too. `002` Q74: a target that is not origin-form, or whose path holds `%`, `//` or a
 * backslash, answers a bare 404 before the router.
 *
 * ## What is asserted, per build and per link page
 *
 * 1. Without a fragment: `200`, the app's `index.html` (`text/html; charset=utf-8`, equal
 *    to the build's file once the style nonce is put back to its placeholder), exactly one
 *    `Referrer-Policy: no-referrer`, and a CSP whose every fetch and navigation source is
 *    `'self'`, `'none'` or a nonce: no scheme, host, wildcard, `data:` or `blob:` source,
 *    and every directive of D10 present, with `default-src 'self'`. The two report
 *    directives of `048` D9 are the only other directives, each with exactly its one value:
 *    `report-uri /v1/csp-reports` and `report-to csp-endpoint`.
 * 2. With a fragment, through two real clients (`node:http` and `fetch`) given the emailed
 *    URL with `#reset=<id>&token=<t>` or `#invitation=<id>&token=<t>`: the request target
 *    the server received, recorded by an `onRequest` hook installed through
 *    `configureApp` ahead of every other hook, is exactly the bare path: no `#`, no
 *    identifier, no token. The answer is the one of case 1.
 * 3. A broken client that puts the fragment in the request line, as a raw `#` and as
 *    `%23`. The hook records the target, proving the token did reach the server; what
 *    the code guarantees is then asserted:
 *    - a raw `#` is not refused (the Q74 hook refuses only `%`, `//` and a backslash, and
 *      Node's parser keeps `#` in `request.url`): the fallback answers the app page
 *      (`isSpaPath` of the whole target is true), which never reflects the target;
 *    - `%23` is refused by the Q74 hook with its bare non-HTML 404.
 *    Both answers still carry `no-referrer` and the CSP. For the raw `#`, the identifier,
 *    the token and the target appear nowhere in the raw response (status line, headers or
 *    body). For `%23` the guarantee is the refusal only: the Q74 404 is Fastify's own
 *    not-found JSON, `Route GET:<target> not found`, which Q59 pins ("only its status and
 *    non-HTML body are pinned") and `spa-fallback.http.int.test.ts` asserts verbatim, so it
 *    echoes the target to the client that sent it, as `application/json` under `nosniff`.
 *    That echo is reported to the orchestrator, not asserted away.
 * 4. The served HTML holds no `http:` or `https:` anywhere, no `<base>` and no meta
 *    refresh, and every URL attribute (`src`, `href`, `action`, `formaction`, `poster`,
 *    `data`, `srcset`, `xlink:href`) is a root-relative path (`/x`, never `//host`) or a
 *    same-document `#id`.
 * 5. Every resource the served HTML references is answered `200` by this origin.
 *
 * ## The two builds
 *
 * - `fixture`: the committed `__fixtures__/web-dist/` (read only), the build shape every
 *   other HTTP test of the fallback uses.
 * - `built`: the real `apps/web`, built in `beforeAll` with Vite's own CLI (`vite build`
 *   into a fresh temporary directory, through `process.execPath` and the `vite` package
 *   `apps/web` resolves, so no global binary and no new dependency). A build takes about a
 *   second; the TypeScript check of `apps/web` stays `pnpm typecheck`'s job, so the
 *   `tsc -b` half of `apps/web`'s `build` script is not run. The child gets only `PATH`
 *   and `NODE_ENV=production`: no `DATABASE_URL` or other secret reaches it or its error
 *   text. This proves the page rules for the HTML the container really ships, which the
 *   fixture alone cannot.
 *
 * ## Harness
 *
 * Two apps over the same harness pools, both listening on `127.0.0.1` (a real client is
 * needed to show the fragment is never sent). Each request carries a fresh
 * `x-forwarded-for` (the fallback bucket never interferes) and a fresh probe header, which
 * keys the target the recording hook saw. Raw request lines go over a TCP socket, byte
 * for byte, as in `csp-nonce.http.int.test.ts` and `spa-fallback.http.int.test.ts`.
 *
 * ## Production symbols used
 *
 * `createApp` (`./server.js`) with `webDistDir` and `configureApp`, which already exist.
 * Task 6.10 names no new production symbol: D11 says `no-referrer` is set "on every
 * response, D10", which task 4.4 implemented, so these cases are expected to pass on
 * arrival. They pin the page rules for the two link pages so that a later change to the
 * global headers, the fallback or the build cannot break them silently.
 */
import { execFile } from 'node:child_process';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { createRequire } from 'node:module';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { harnessPools, type HarnessPools } from './__fixtures__/pools.js';
import { createApp, type App } from './server.js';

const execFileAsync = promisify(execFile);

const ORIGIN = 'https://app.tayzu.test';
const FIXTURE_WEB_DIST = fileURLToPath(new URL('./__fixtures__/web-dist/', import.meta.url));
const WEB_ROOT = fileURLToPath(new URL('../../web/', import.meta.url));
const NONCE_PLACEHOLDER = '__TAYZU_STYLE_NONCE__';
const HTML = /^text\/html; charset=utf-8$/i;
const PROBE_HEADER = 'x-tayzu-probe';

/** D10's directive list: every one must be present, so none falls back to a browser default. */
const D10_DIRECTIVES: readonly string[] = [
  'default-src',
  'script-src',
  'style-src',
  'img-src',
  'font-src',
  'connect-src',
  'media-src',
  'object-src',
  'frame-src',
  'worker-src',
  'manifest-src',
  'base-uri',
  'form-action',
  'frame-ancestors',
];

/**
 * `048` design D9's report directives, each with its one exact value: the same-origin path
 * of `POST /v1/csp-reports` and the `Reporting-Endpoints` name that maps to it. These are
 * the only directives whose values are not fetch or navigation sources.
 */
const D9_REPORT_DIRECTIVES: ReadonlyMap<string, readonly string[]> = new Map([
  ['report-uri', ['/v1/csp-reports']],
  ['report-to', ['csp-endpoint']],
]);

/** The only sources that allow no other origin: `'self'`, `'none'` and a nonce. */
const SAME_ORIGIN_SOURCE = /^(?:'self'|'none'|'nonce-[A-Za-z0-9+/]+={0,2}')$/;
/** Anything in a CSP header that would name or allow another origin. */
const OTHER_ORIGIN_IN_CSP = /https?:|wss?:|data:|blob:|filesystem:|\*/i;
/** Task 6.10: any `http:` or `https:` in the served HTML. */
const HTTP_SCHEME = /https?:/i;
/** Every HTML attribute whose value is a URL the browser may fetch or navigate to. */
const URL_ATTRIBUTE =
  /\s(src|href|action|formaction|poster|data|srcset|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;

interface LinkPage {
  readonly path: '/reset-password' | '/accept-invitation';
  /** The fragment keys of the emailed link (`044` D14, `043` Q32). */
  readonly idKey: 'reset' | 'invitation';
}

const LINK_PAGES: readonly LinkPage[] = [
  { path: '/reset-password', idKey: 'reset' },
  { path: '/accept-invitation', idKey: 'invitation' },
];

/** A fresh identifier and token, each a marker no response or recorded path may hold. */
interface LinkSecrets {
  readonly id: string;
  readonly token: string;
  readonly fragment: string;
}

function linkSecrets(page: LinkPage): LinkSecrets {
  const id = randomUUID();
  const token = randomBytes(32).toString('base64url');
  return { id, token, fragment: `${page.idKey}=${id}&token=${token}` };
}

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

/** Directive name (lower case) to its source list, in header order. */
function parseCsp(header: string): ReadonlyMap<string, readonly string[]> {
  const directives = new Map<string, readonly string[]>();
  for (const part of header.split(';')) {
    const [rawName, ...sources] = part
      .trim()
      .split(/\s+/)
      .filter((token) => token.length > 0);
    if (rawName !== undefined && !directives.has(rawName.toLowerCase())) {
      directives.set(rawName.toLowerCase(), sources);
    }
  }
  return directives;
}

/** The body with the style-nonce meta's `content` put back to the build's placeholder. */
function withPlaceholderNonce(body: string): string {
  return body.replace(
    /(<meta name="tayzu-style-nonce" content=")[^"]*(")/,
    `$1${NONCE_PLACEHOLDER}$2`,
  );
}

/** Every URL attribute value of an HTML document, `srcset` split into its URLs. */
function urlAttributeValues(html: string): string[] {
  const values: string[] = [];
  for (const match of html.matchAll(URL_ATTRIBUTE)) {
    const name = (match[1] ?? '').toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    if (name === 'srcset') {
      for (const candidate of value.split(',')) {
        const [url] = candidate.trim().split(/\s+/);
        if (url !== undefined && url.length > 0) {
          values.push(url);
        }
      }
    } else {
      values.push(value);
    }
  }
  return values;
}

/** The headers of one answer, read the same way whatever the client. */
interface Answer {
  readonly statusCode: number;
  readonly contentType: string | undefined;
  readonly referrerPolicy: readonly string[];
  readonly csp: readonly string[];
  readonly body: string;
  /** The full response as received, for the reflection checks (raw socket only). */
  readonly raw?: string;
}

function headerValues(value: string | string[] | number | undefined): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  return [String(value)];
}

/** A target recorded by the first `onRequest` hook, keyed by the request's probe header. */
interface Recorder {
  readonly targets: Map<string, string>;
  readonly install: (instance: FastifyInstance) => void;
}

function recorder(): Recorder {
  const targets = new Map<string, string>();
  return {
    targets,
    install: (instance: FastifyInstance): void => {
      // `configureApp` runs before any hook of `createApp`, so this hook sees every request,
      // including one the Q74 hook refuses. It records the request target exactly as Node
      // parsed it from the request line, and writes nothing.
      instance.addHook('onRequest', async (request) => {
        const probe = request.headers[PROBE_HEADER];
        if (typeof probe === 'string') {
          targets.set(probe, request.raw.url ?? '');
        }
      });
    },
  };
}

interface Served {
  readonly label: string;
  readonly app: App;
  readonly port: number;
  readonly recorded: Recorder;
  /** The build's own `index.html`, as on disk (with the nonce placeholder). */
  readonly indexHtml: string;
}

/** A real HTTP client (`node:http`) given an absolute URL, fragment included. */
function nodeHttpGet(url: string, probe: string): Promise<Answer> {
  return new Promise<Answer>((resolve, reject) => {
    const outgoing = httpRequest(
      new URL(url),
      { method: 'GET', headers: { 'x-forwarded-for': randomIp(), [PROBE_HEADER]: probe } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          const headers: IncomingHttpHeaders = response.headers;
          resolve({
            statusCode: response.statusCode ?? 0,
            contentType: headers['content-type'],
            referrerPolicy: headerValues(headers['referrer-policy']),
            csp: headerValues(headers['content-security-policy']),
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

/** A second real client (`fetch`, undici) given the same kind of URL. */
async function fetchGet(url: string, probe: string): Promise<Answer> {
  const response = await fetch(url, {
    headers: { 'x-forwarded-for': randomIp(), [PROBE_HEADER]: probe },
    redirect: 'manual',
  });
  // `Headers.get` joins repeated headers with ", ", so a duplicate fails the equality.
  const referrerPolicy = response.headers.get('referrer-policy');
  const csp = response.headers.get('content-security-policy');
  return {
    statusCode: response.status,
    contentType: response.headers.get('content-type') ?? undefined,
    referrerPolicy: referrerPolicy === null ? [] : [referrerPolicy],
    csp: csp === null ? [] : [csp],
    body: await response.text(),
  };
}

/** Sends one HTTP/1.1 request line byte for byte and reads until the server closes. */
function rawGet(port: number, target: string, probe: string): Promise<Answer> {
  return new Promise<Answer>((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    socket.on('connect', () => {
      socket.write(
        `GET ${target} HTTP/1.1\r\nhost: 127.0.0.1:${port.toString(10)}\r\n` +
          `x-forwarded-for: ${randomIp()}\r\n${PROBE_HEADER}: ${probe}\r\n` +
          `connection: close\r\n\r\n`,
      );
    });
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    socket.on('error', reject);
    socket.on('close', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const headEnd = raw.indexOf('\r\n\r\n');
      const head = headEnd === -1 ? raw : raw.slice(0, headEnd);
      const body = headEnd === -1 ? '' : raw.slice(headEnd + 4);
      const [statusLine = '', ...lines] = head.split('\r\n');
      const statusMatch = /^HTTP\/1\.1 (\d{3})/.exec(statusLine);
      if (statusMatch?.[1] === undefined) {
        reject(new Error('no HTTP status line in the response'));
        return;
      }
      const headers = new Map<string, string[]>();
      for (const line of lines) {
        const colon = line.indexOf(':');
        if (colon > 0) {
          const name = line.slice(0, colon).trim().toLowerCase();
          headers.set(name, [...(headers.get(name) ?? []), line.slice(colon + 1).trim()]);
        }
      }
      resolve({
        statusCode: Number(statusMatch[1]),
        contentType: headers.get('content-type')?.[0],
        referrerPolicy: headers.get('referrer-policy') ?? [],
        csp: headers.get('content-security-policy') ?? [],
        body,
        raw,
      });
    });
  });
}

/** Exactly one `Referrer-Policy: no-referrer` (D10, D11). */
function expectNoReferrer(answer: Answer, label: string): void {
  expect(answer.referrerPolicy, label).toEqual(['no-referrer']);
}

/**
 * Exactly one CSP, and it allows no other origin (D10, D11, task 6.10), with `048` D9's two
 * report directives at their exact values.
 */
function expectSelfOnlyCsp(answer: Answer, label: string): void {
  expect(answer.csp, label).toHaveLength(1);
  const header = answer.csp[0] ?? '';
  expect(header, label).not.toMatch(OTHER_ORIGIN_IN_CSP);
  const directives = parseCsp(header);
  for (const name of D10_DIRECTIVES) {
    expect(directives.has(name), `${label}: ${name}`).toBe(true);
  }
  expect(directives.get('default-src'), label).toEqual(["'self'"]);
  for (const [name, value] of D9_REPORT_DIRECTIVES) {
    expect(directives.get(name), `${label}: ${name}`).toEqual(value);
  }
  for (const [name, sources] of directives) {
    if (D9_REPORT_DIRECTIVES.has(name)) {
      continue;
    }
    for (const source of sources) {
      expect(source, `${label}: ${name}`).toMatch(SAME_ORIGIN_SOURCE);
    }
  }
}

/** Case 1: the app page with the page-rule headers. */
function expectLinkPage(answer: Answer, served: Served, label: string): void {
  expect(answer.statusCode, label).toBe(200);
  expect(answer.contentType, label).toMatch(HTML);
  expect(withPlaceholderNonce(answer.body), label).toBe(served.indexHtml);
  expectNoReferrer(answer, label);
  expectSelfOnlyCsp(answer, label);
}

/** Neither the identifier nor the token appears anywhere in the response. */
function expectNotReflected(answer: Answer, secrets: LinkSecrets, label: string): void {
  const whole = answer.raw ?? answer.body;
  expect(whole, label).not.toContain(secrets.token);
  expect(whole, label).not.toContain(secrets.id);
  expect(whole, label).not.toContain('token=');
}

let pools: HarnessPools;
let builtDir: string;
const servedBuilds: Served[] = [];

async function buildWebApp(outDir: string): Promise<void> {
  const requireFromWeb = createRequire(join(WEB_ROOT, 'package.json'));
  const viteCli = join(dirname(requireFromWeb.resolve('vite/package.json')), 'bin', 'vite.js');
  await execFileAsync(
    process.execPath,
    [viteCli, 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'error'],
    {
      cwd: WEB_ROOT,
      // Only what a build needs: no `DATABASE_URL` or other secret reaches the child.
      env: { PATH: process.env['PATH'] ?? '', NODE_ENV: 'production' },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}

async function serve(label: string, webDistDir: string): Promise<Served> {
  const recorded = recorder();
  const app = await createApp({
    ...pools,
    authSecret: TEST_SECRET,
    cerbosAddress: 'localhost:3593',
    allowedOrigins: [ORIGIN],
    webDistDir,
    configureApp: recorded.install,
  });
  await app.app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.app.server.address() as AddressInfo).port;
  const indexHtml = await readFile(join(webDistDir, 'index.html'), 'utf8');
  return { label, app, port, recorded, indexHtml };
}

beforeAll(async () => {
  pools = await harnessPools();
  builtDir = await mkdtemp(join(tmpdir(), 'tayzu-web-page-rules-'));
  await buildWebApp(builtDir);
  servedBuilds.push(await serve('fixture', FIXTURE_WEB_DIST));
  servedBuilds.push(await serve('built', builtDir));
}, 120_000);

afterAll(async () => {
  for (const served of servedBuilds) {
    await served.app.close();
  }
  await rm(builtDir, { recursive: true, force: true });
}, 60_000);

/** The served build of a label; the `describe` bodies run before `beforeAll` fills it. */
function build(label: string): Served {
  const served = servedBuilds.find((candidate) => candidate.label === label);
  if (served === undefined) {
    throw new Error(`the ${label} build is not being served`);
  }
  return served;
}

describe('the link pages over HTTP (003 task 6.10, design D11 page rules, D10)', () => {
  it('the real apps/web build is a build of index.html with its nonce placeholder', () => {
    const built = build('built');
    expect(built.indexHtml).toContain(`content="${NONCE_PLACEHOLDER}"`);
    expect(built.indexHtml).toMatch(/<script type="module"[^>]*\ssrc="\/assets\/[^"]+\.js"/);
    // A real build, not the source page: Vite replaced the source entry.
    expect(built.indexHtml).not.toContain('/src/main.tsx');
  });

  for (const label of ['fixture', 'built'] as const) {
    describe(`with the ${label} build`, () => {
      for (const page of LINK_PAGES) {
        describe(page.path, () => {
          it(`GET ${page.path} without a fragment: the app page, Referrer-Policy: no-referrer and a CSP that allows no other origin`, async () => {
            const served = build(label);
            const probe = randomUUID();
            const answer = await nodeHttpGet(
              `http://127.0.0.1:${served.port.toString(10)}${page.path}`,
              probe,
            );
            expect(served.recorded.targets.get(probe)).toBe(page.path);
            expectLinkPage(answer, served, `${label} ${page.path}`);
          });

          it(`GET ${page.path}#${page.idKey}=…&token=… through node:http: the fragment never reaches the server`, async () => {
            const served = build(label);
            const secrets = linkSecrets(page);
            const probe = randomUUID();
            const answer = await nodeHttpGet(
              `http://127.0.0.1:${served.port.toString(10)}${page.path}#${secrets.fragment}`,
              probe,
            );
            const received = served.recorded.targets.get(probe);
            expect(received).toBe(page.path);
            expect(received).not.toContain('#');
            expect(received).not.toContain(secrets.token);
            expect(received).not.toContain(secrets.id);
            expectLinkPage(answer, served, `${label} ${page.path} (node:http, fragment)`);
            expectNotReflected(answer, secrets, `${label} ${page.path} (node:http, fragment)`);
          });

          it(`GET ${page.path}#${page.idKey}=…&token=… through fetch: the fragment never reaches the server`, async () => {
            const served = build(label);
            const secrets = linkSecrets(page);
            const probe = randomUUID();
            const answer = await fetchGet(
              `http://127.0.0.1:${served.port.toString(10)}${page.path}#${secrets.fragment}`,
              probe,
            );
            const received = served.recorded.targets.get(probe);
            expect(received).toBe(page.path);
            expect(received).not.toContain('#');
            expect(received).not.toContain(secrets.token);
            expect(received).not.toContain(secrets.id);
            expectLinkPage(answer, served, `${label} ${page.path} (fetch, fragment)`);
            expectNotReflected(answer, secrets, `${label} ${page.path} (fetch, fragment)`);
          });

          it(`a client that sends the fragment raw (${page.path}#…) gets the app page, which never reflects it`, async () => {
            const served = build(label);
            const secrets = linkSecrets(page);
            const probe = randomUUID();
            const target = `${page.path}#${secrets.fragment}`;
            const answer = await rawGet(served.port, target, probe);
            // The precondition: this broken client really did put the token in the request line.
            expect(served.recorded.targets.get(probe)).toBe(target);
            // The Q74 hook refuses only `%`, `//` and a backslash, so the fallback answers the
            // app page for the whole target; the page is the build's file, never the target.
            expectLinkPage(answer, served, `${label} raw #`);
            expectNotReflected(answer, secrets, `${label} raw #`);
            expect(answer.raw).not.toContain(target);
          });

          it(`a client that sends the fragment encoded (${page.path}%23…) is refused by the Q74 hook, never with the app page`, async () => {
            const served = build(label);
            const secrets = linkSecrets(page);
            const probe = randomUUID();
            const target = `${page.path}%23${secrets.fragment}`;
            const answer = await rawGet(served.port, target, probe);
            expect(served.recorded.targets.get(probe)).toBe(target);
            // Refused: the Q74 404, never the app page. Its body is Fastify's own not-found
            // JSON (Q59 pins only its status and non-HTML body), which names the route, so it
            // is served as JSON under `nosniff` and is never rendered as a document.
            expect(answer.statusCode).toBe(404);
            expect(answer.contentType ?? '').toMatch(/^application\/json\b/i);
            expect(answer.body).not.toContain('tayzu-style-nonce');
            expect(answer.raw).toMatch(/\r\nx-content-type-options: nosniff\r\n/i);
            // Q60: the Q74 404 carries D10's headers too.
            expectNoReferrer(answer, `${label} raw %23`);
            expectSelfOnlyCsp(answer, `${label} raw %23`);
          });

          it(`the HTML served for ${page.path} holds no http: or https: origin and references only this origin`, async () => {
            const served = build(label);
            const answer = await fetchGet(
              `http://127.0.0.1:${served.port.toString(10)}${page.path}`,
              randomUUID(),
            );
            expect(answer.statusCode).toBe(200);
            expect(answer.contentType).toMatch(HTML);
            expect(answer.body).not.toMatch(HTTP_SCHEME);
            expect(answer.body).not.toMatch(/<base[\s>]/i);
            expect(answer.body).not.toMatch(/http-equiv\s*=\s*["']?refresh/i);

            const references = urlAttributeValues(answer.body);
            // Not vacuous: the page loads at least theme-init.js and the module entry.
            expect(references).toContain('/theme-init.js');
            expect(references.some((url) => /^\/assets\/[^/]+\.js$/.test(url))).toBe(true);
            for (const url of references) {
              // A root-relative path, or a same-document `#id`; never `//host` or a scheme.
              expect(url, url).toMatch(/^(?:\/(?!\/)|#)/);
              expect(url, url).not.toContain('\\');
            }
          });

          it(`every resource the HTML served for ${page.path} references is answered by this origin`, async () => {
            const served = build(label);
            const base = `http://127.0.0.1:${served.port.toString(10)}`;
            const page200 = await fetchGet(`${base}${page.path}`, randomUUID());
            const references = urlAttributeValues(page200.body);
            expect(references.length).toBeGreaterThan(0);
            for (const url of references.filter((reference) => !reference.startsWith('#'))) {
              const resource = await fetchGet(`${base}${url}`, randomUUID());
              expect(resource.statusCode, url).toBe(200);
              expect(resource.contentType ?? '', url).not.toMatch(/^text\/html/i);
            }
          });
        });
      }
    });
  }
});
