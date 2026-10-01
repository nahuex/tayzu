/**
 * Integration test for task 26.4 (openspec/changes/002-auth-and-rbac; design Q67):
 * HTTP telemetry drops `url.query` and the query part of `url.full`.
 *
 * Lives in its own file (not in `otel-export.int.test.ts`) because the OTel
 * NodeSDK and the http/pg instrumentations patch process-wide state: a second
 * `startTelemetry` in the same process exports no spans (observed: zero server
 * spans), so each file that starts the SDK needs its own worker process.
 *
 * ## Production symbols expected
 *
 * - `apps/api/src/telemetry.ts`'s `startTelemetry` configures `HttpInstrumentation`
 *   so that no exported attribute carries the query string: `url.query` is never
 *   set, and `url.full`, `http.url` and `http.target` (when present) carry no `?...`.
 *
 * ## Why this fails right now
 *
 * `HttpInstrumentation` records `url.query` (and the query inside `url.full`),
 * so the exported attribute keys contain `url.query`.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { harnessPools } from './__fixtures__/pools.js';
import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';

const state = vi.hoisted(() => ({ pools: new Map<string, unknown>() }));

vi.mock('@tayzu/db', async (importActual) => {
  const actual = await importActual<typeof import('@tayzu/db')>();
  return {
    ...actual,
    createPool: vi.fn((url: string) => {
      const role = url.includes('tayzu_auth') ? 'auth' : 'app';
      const real = state.pools.get(role) as object;
      return new Proxy(real, {
        get(target, prop) {
          if (prop === 'end') {
            return () => Promise.resolve();
          }
          const value: unknown = Reflect.get(target, prop, target);
          return typeof value === 'function'
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });
    }),
  };
});

import { start } from './main.js';

const APP_URL = 'postgres://tayzu_app:pw-app-marker@db.invalid:5432/tayzu?sslmode=verify-full';
const AUTH_URL = 'postgres://tayzu_auth:pw-auth-marker@db.invalid:5432/tayzu?sslmode=verify-full';
const ORIGIN = 'https://app.tayzu.test';

interface Received {
  readonly path: string;
  readonly body: string;
}

interface Receiver {
  readonly endpoint: string;
  readonly received: Received[];
  close(): Promise<void>;
}

async function startReceiver(): Promise<Receiver> {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        path: req.url ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${String(port)}`,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

function randomIp(): string {
  return `10.${String(randomInt(256))}.${String(randomInt(256))}.${String(randomInt(1, 255))}`;
}

function env(overrides: Record<string, string | undefined>): Record<string, string | undefined> {
  return {
    DATABASE_URL: APP_URL,
    AUTH_DATABASE_URL: AUTH_URL,
    BETTER_AUTH_SECRET: TEST_SECRET,
    CERBOS_ADDRESS: 'localhost:3593',
    ALLOWED_ORIGINS: ORIGIN,
    HOST: '127.0.0.1',
    PORT: '0',
    OTEL_SERVICE_NAME: 'tayzu-api-test',
    ...overrides,
  };
}

interface JsonSpan {
  traceId?: string;
  name?: string;
  kind?: number;
  attributes?: { key: string; value: Record<string, unknown> }[];
}

function spansOf(received: readonly Received[]): JsonSpan[] {
  const spans: JsonSpan[] = [];
  for (const item of received.filter((r) => r.path.endsWith('/v1/traces'))) {
    const parsed = JSON.parse(item.body) as {
      resourceSpans?: { scopeSpans?: { spans?: JsonSpan[] }[] }[];
    };
    for (const rs of parsed.resourceSpans ?? []) {
      for (const ss of rs.scopeSpans ?? []) spans.push(...(ss.spans ?? []));
    }
  }
  return spans;
}

describe('HTTP telemetry drops the URL query (task 26.4, design Q67)', () => {
  beforeAll(async () => {
    const { appPool, authPool } = await harnessPools();
    state.pools.set('app', appPool);
    state.pools.set('auth', authPool);
  });

  afterAll(() => {
    state.pools.clear();
  });

  it('A request with ?code=...&state=... exports no url.query and no query in url.full or any other attribute', async () => {
    const receiver = await startReceiver();
    const codeMarker = `code-${randomUUID()}`;
    const stateMarker = `state-${randomUUID()}`;
    const query = `code=${codeMarker}&state=${stateMarker}`;

    const running = await start(
      env({
        OTEL_EXPORTER_OTLP_ENDPOINT: receiver.endpoint,
        OTEL_BSP_SCHEDULE_DELAY: '100',
      }),
    );
    try {
      const base = `http://127.0.0.1:${String(running.port)}`;
      const callback = await fetch(`${base}/api/auth/callback/visma-connect?${query}`, {
        headers: { 'x-forwarded-for': randomIp() },
      });
      await callback.arrayBuffer();
      const health = await fetch(`${base}/healthz?${query}`);
      expect(health.status).toBe(200);
      await health.arrayBuffer();
    } finally {
      await running.close();
    }
    await receiver.close();

    const spans = spansOf(receiver.received);
    const serverSpans = spans.filter((s) => s.kind === 2);
    // The requests were traced (the guard below is not vacuous).
    expect(serverSpans.length).toBeGreaterThanOrEqual(2);

    const attributeKeys = spans.flatMap((s) => (s.attributes ?? []).map((a) => a.key));
    expect(attributeKeys).not.toContain('url.query');

    // The query part of url.full (and of any other URL-shaped attribute) is gone.
    for (const span of spans) {
      for (const { key, value } of span.attributes ?? []) {
        if (key === 'url.full' || key === 'http.url' || key === 'http.target') {
          expect(JSON.stringify(value)).not.toContain('?');
        }
      }
    }

    // Nothing carrying the query reaches any exported byte (traces, metrics, logs).
    const everything = receiver.received.map((r) => r.body).join('\n');
    for (const secret of [codeMarker, stateMarker, query]) {
      expect(everything).not.toContain(secret);
    }
  });
});
