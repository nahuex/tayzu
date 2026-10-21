/**
 * Task 14.1 of openspec/changes/044-password-reset-and-account-recovery (design D17).
 *
 * Scenario "The probe covers the three routes" (spec `password-reset-and-account-recovery`):
 * WHEN the DAST script runs against the sandbox, THEN the probe sends malformed, oversized,
 * prototype-polluting and replayed requests to the accept route and both reset routes and
 * reports no finding. Plus the case "the probe fails when a route reflects its input", and one
 * case per other failure D17 lists (5xx, stack trace, missing `no-store`, known/unknown
 * difference).
 *
 * This file lives in `apps/api/src` only because the Vitest projects glob `src/**`.
 *
 * ## Harness
 *
 * A small in-process Fastify app (never a listener) that behaves like the three public routes
 * should: strict body shape, `415` for a wrong content type, `403` without the CSRF header or
 * with a foreign `Origin`, `413` for an oversized body, `Cache-Control: no-store`, and the
 * uniform `200 { accepted: true }` for the request route. `fetch` is a bridge to `app.inject`.
 * Switches make one route misbehave at a time.
 *
 * ## Production symbols expected
 *
 * ```ts
 * // scripts/ci/dast-probe.ts (does not exist yet)
 * export type ProbeFindingKind =
 *   | 'server_error' | 'stack_trace' | 'reflected_input'
 *   | 'missing_no_store' | 'known_unknown_difference';
 * export interface ProbeFinding { kind: ProbeFindingKind; path: string }  // never a body
 * export interface ProbeResponse { path: string; status: number }
 * export interface ProbeOptions {
 *   baseUrl: string;       // origin of the app, no trailing slash
 *   origin: string;        // the allowed browser Origin sent on well-formed requests
 *   knownEmail: string;    // an address with an eligible account (the request route)
 *   fetch?: typeof fetch;  // defaults to global fetch
 * }
 * export interface ProbeResult { findings: ProbeFinding[]; responses: ProbeResponse[] }
 * export function runDastProbe(options: ProbeOptions): Promise<ProbeResult>;
 * ```
 *
 * Routes: `/v1/auth/invitations/accept`, `/v1/auth/password-reset/request`,
 * `/v1/auth/password-reset/confirm`, all `POST`. `responses` lists every answer received.
 */
import { randomUUID } from 'node:crypto';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { runDastProbe, type ProbeResult } from '../../../scripts/ci/dast-probe.js';

const ORIGIN = 'https://app.tayzu.test';
const ACCEPT = '/v1/auth/invitations/accept';
const REQUEST = '/v1/auth/password-reset/request';
const CONFIRM = '/v1/auth/password-reset/confirm';
const ROUTES = [ACCEPT, REQUEST, CONFIRM] as const;
const RESET_ROUTES: readonly string[] = [REQUEST, CONFIRM];

interface Misbehavior {
  reflect?: boolean;
  serverError?: boolean;
  stackTrace?: boolean;
  omitNoStoreOn?: string;
  differForKnown?: boolean;
}

interface Seen {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  raw: string;
}

const SHAPES: Record<string, readonly string[]> = {
  [ACCEPT]: ['invitationId', 'token', 'password'],
  [REQUEST]: ['email'],
  [CONFIRM]: ['id', 'token', 'newPassword'],
};

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function buildApp(knownEmail: string, misbehavior: Misbehavior, seen: Seen[]): FastifyInstance {
  const app = Fastify({ bodyLimit: 20 * 1024 * 1024 });
  apps.push(app);
  const rawByRequest = new WeakMap<object, string>();
  const rejection = (statusCode: number, code: string): Error =>
    Object.assign(new Error(code), { statusCode, code });
  const echoes = (raw: string): Record<string, unknown> => ({
    ...(misbehavior.reflect === true ? { message: raw.slice(0, 2000) } : {}),
    ...(misbehavior.stackTrace === true ? { stack: 'Error: x\n    at f (/app/x.js:1:1)' } : {}),
  });
  const pathOf = (url: string): string => url.split('?')[0] ?? url;
  // Every body is recorded as text whatever its content type, before any rejection.
  const record = (request: { url: string; headers: Seen['headers'] }, raw: string): void => {
    rawByRequest.set(request, raw);
    seen.push({ path: pathOf(request.url), headers: request.headers, raw });
  };
  // Drops the built-in `application/json` and `text/plain` parsers, which would answer first.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'string' }, (request, body, done) => {
    record(request, body as string);
    done(null, body);
  });
  // Replaces Fastify's built-in JSON parser (which would reject before the handler and leave
  // `raw` empty): records the text, then applies the same protections: malformed JSON and
  // `__proto__`/`constructor`/`prototype` keys at any depth answer 400.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const raw = body as string;
    record(request, raw);
    if (raw.length > 100_000) {
      done(rejection(413, 'CATALOG_VALIDATION_FAILED'));
      return;
    }
    try {
      const parsed: unknown = JSON.parse(raw, (key, value: unknown) => {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
          throw new Error('forbidden key');
        }
        return value;
      });
      done(null, parsed);
    } catch {
      if (misbehavior.serverError === true) done(rejection(500, 'INTERNAL'));
      else done(rejection(400, 'CATALOG_VALIDATION_FAILED'));
    }
  });
  app.setErrorHandler((error: { statusCode?: number; code?: string }, request, reply) => {
    const status = error.statusCode ?? 500;
    const code = error.code ?? 'INTERNAL';
    return reply.status(status).send({ code, ...echoes(rawByRequest.get(request) ?? '') });
  });
  // Like the production app: `Cache-Control: no-store` on every response that sets none.
  app.addHook('onSend', (request, reply, payload, done) => {
    if (!reply.hasHeader('cache-control') && misbehavior.omitNoStoreOn !== pathOf(request.url)) {
      void reply.header('cache-control', 'no-store');
    }
    done(null, payload);
  });
  for (const path of ROUTES) {
    app.post(path, (request, reply) => {
      const raw = rawByRequest.get(request) ?? '';
      void reply.header('content-type', 'application/json');
      const fail = (status: number, code: string): unknown =>
        reply.status(status).send({ code, ...echoes(raw) });
      const origin = request.headers.origin;
      if (origin !== undefined && origin !== ORIGIN) return fail(403, 'AUTH_FORBIDDEN');
      if (request.headers['x-csrf-token'] === undefined) return fail(403, 'AUTH_FORBIDDEN');
      if (!(request.headers['content-type'] ?? '').startsWith('application/json')) {
        return fail(415, 'CATALOG_VALIDATION_FAILED');
      }
      if (raw.length > 100_000) return fail(413, 'CATALOG_VALIDATION_FAILED');
      const parsed: unknown = request.body;
      const keys =
        typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? Object.keys(parsed)
          : [];
      const shape = SHAPES[path] ?? [];
      const ok =
        keys.length === shape.length &&
        shape.every((key) => keys.includes(key)) &&
        Object.values(parsed as Record<string, unknown>).every((v) => typeof v === 'string');
      if (!ok) return fail(400, 'CATALOG_VALIDATION_FAILED');
      if (path === REQUEST) {
        const email = (parsed as Record<string, string>)['email'];
        if (misbehavior.differForKnown === true && email === knownEmail) {
          void reply.header('x-extra', '1');
        }
        return reply.status(200).send({ accepted: true });
      }
      return fail(404, 'CATALOG_NOT_FOUND');
    });
  }
  return app;
}

function bridge(app: FastifyInstance): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const response = await app.inject({
      method: (init?.method ?? 'GET') as 'POST',
      url: url.pathname,
      headers,
      ...(typeof init?.body === 'string' ? { payload: init.body } : {}),
    });
    const outHeaders = new Headers();
    for (const [key, value] of Object.entries(response.headers)) {
      if (value === undefined) continue;
      outHeaders.set(key, Array.isArray(value) ? value.join(', ') : String(value));
    }
    return new Response(response.body, { status: response.statusCode, headers: outHeaders });
  };
}

async function probe(
  misbehavior: Misbehavior,
): Promise<{ result: ProbeResult; seen: Seen[]; knownEmail: string }> {
  const knownEmail = `known-${randomUUID()}@example.com`;
  const seen: Seen[] = [];
  const app = buildApp(knownEmail, misbehavior, seen);
  await app.ready();
  const result = await runDastProbe({
    baseUrl: 'http://app.test',
    origin: ORIGIN,
    knownEmail,
    fetch: bridge(app),
  });
  return { result, seen, knownEmail };
}

function isJson(raw: string): boolean {
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

describe('The DAST probe (task 14.1, design D17)', () => {
  it('The probe covers the three routes: it reports no finding against a well-behaved app', async () => {
    const { result } = await probe({});

    expect(result.findings).toEqual([]);
  });

  it.each(ROUTES)(
    'The probe covers the three routes: %s receives malformed, oversized, polluting, replayed and unsafe-context requests',
    async (path) => {
      const { result, seen } = await probe({});
      const mine = seen.filter((entry) => entry.path === path);
      const jsonTyped = (e: Seen): boolean =>
        (e.headers['content-type'] ?? '').toString().startsWith('application/json');

      expect(result.responses.some((r) => r.path === path)).toBe(true);
      expect(mine.some((e) => jsonTyped(e) && !isJson(e.raw))).toBe(true);
      expect(mine.some((e) => e.raw.length > 1_048_576)).toBe(true);
      expect(mine.some((e) => e.raw.includes('"__proto__"'))).toBe(true);
      expect(mine.some((e) => e.raw.includes('"constructor"'))).toBe(true);
      expect(mine.some((e) => !jsonTyped(e))).toBe(true);
      expect(mine.some((e) => e.headers['x-csrf-token'] === undefined)).toBe(true);
      expect(mine.some((e) => e.headers.origin !== undefined && e.headers.origin !== ORIGIN)).toBe(
        true,
      );
    },
  );

  it.each([ACCEPT, CONFIRM])('%s receives the same token body twice (a replay)', async (path) => {
    const { seen } = await probe({});
    const bodies = seen.filter((e) => e.path === path && isJson(e.raw)).map((e) => e.raw);

    expect(bodies.some((body, index) => bodies.indexOf(body) !== index)).toBe(true);
  });

  it('the request route gets a known and an unknown address, and a burst past the limiter', async () => {
    const { seen, knownEmail } = await probe({});
    const mine = seen.filter((e) => e.path === REQUEST);

    expect(mine.some((e) => e.raw.includes(knownEmail))).toBe(true);
    expect(
      mine.some(
        (e) => isJson(e.raw) && !e.raw.includes(knownEmail) && /"email"\s*:\s*"[^"]+@/.test(e.raw),
      ),
    ).toBe(true);
    expect(mine.length).toBeGreaterThanOrEqual(20);
  });

  it('the probe fails when a route reflects its input', async () => {
    const { result } = await probe({ reflect: true });

    expect(result.findings.map((f) => f.kind)).toContain('reflected_input');
  });

  it('the probe fails on a 5xx', async () => {
    const { result } = await probe({ serverError: true });

    expect(result.findings.map((f) => f.kind)).toContain('server_error');
  });

  it('the probe fails on a stack trace in a body', async () => {
    const { result } = await probe({ stackTrace: true });

    expect(result.findings.map((f) => f.kind)).toContain('stack_trace');
  });

  it.each(RESET_ROUTES)(
    'the probe fails when %s answers without Cache-Control: no-store',
    async (path) => {
      const { result } = await probe({ omitNoStoreOn: path });

      expect(result.findings).toContainEqual({ kind: 'missing_no_store', path });
    },
  );

  it('the probe fails when the request route answers differently for a known address', async () => {
    const { result } = await probe({ differForKnown: true });

    expect(result.findings).toContainEqual({ kind: 'known_unknown_difference', path: REQUEST });
  });

  it('a finding never carries a body or a sent value', async () => {
    const { result } = await probe({ reflect: true, stackTrace: true });

    for (const finding of result.findings) {
      expect(Object.keys(finding).sort()).toEqual(['kind', 'path']);
    }
  });
});
