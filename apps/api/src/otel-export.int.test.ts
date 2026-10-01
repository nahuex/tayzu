/**
 * Integration test for task 13.4 (openspec/changes/002-auth-and-rbac; design
 * D14, resolved decision Q31).
 *
 * Task 13.4: "Wire the OTel SDK and an OTLP exporter in `apps/api`, plus
 * `@opentelemetry/instrumentation-http`/`-pg` with
 * `enhancedDatabaseReporting: false`."
 *
 * Q31: the SDK is configured only through the standard `OTEL_EXPORTER_OTLP_*`
 * variables and started first in `main.ts`, only when `OTEL_EXPORTER_OTLP_ENDPOINT`
 * (or a per-signal variable) is set; instrumentation-http records no bodies or
 * headers. Test: a started SDK exports to an in-process OTLP receiver with no
 * bind value, cookie, token or secret in the exported data.
 *
 * These are task-level behaviours (Q31), not scenarios of spec.md.
 *
 * ## Production symbols expected
 *
 * - `apps/api/src/telemetry.ts` exports
 *   `startTelemetry(env: Readonly<Record<string, string | undefined>>):
 *   { shutdown(): Promise<void> } | undefined`. It returns `undefined` (and
 *   starts nothing) unless `OTEL_EXPORTER_OTLP_ENDPOINT` or a per-signal
 *   `OTEL_EXPORTER_OTLP_{TRACES,METRICS,LOGS}_ENDPOINT` is set. Otherwise it starts
 *   the NodeSDK with the three OTLP/HTTP exporters, `HttpInstrumentation` and
 *   `PgInstrumentation({ enhancedDatabaseReporting: false })`. `shutdown` flushes.
 * - `main.ts`'s `start(env)` calls `startTelemetry(env)` BEFORE `createAppFromEnv`,
 *   and `RunningServer.close()` shuts the SDK down (flushing pending data) after
 *   the listener and the pools are closed.
 *
 * The app is built through the production bootstrap (`start` -> `createAppFromEnv`)
 * with `@tayzu/db`'s `createPool` mocked to hand out the harness pools. The app
 * listens on 127.0.0.1 with an ephemeral port; the OTLP receiver is an in-process
 * HTTP server on 127.0.0.1, ephemeral port. OTLP/HTTP (JSON) bodies are collected
 * as raw text and searched for markers.
 *
 * ## Why this fails right now
 *
 * `./telemetry.js` does not exist / `start` starts no SDK, so the receiver gets
 * no export at all (assertion failure on "exports something").
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

describe('OTel SDK wiring in apps/api (task 13.4, Q31)', () => {
  beforeAll(async () => {
    const { appPool, authPool } = await harnessPools();
    state.pools.set('app', appPool);
    state.pools.set('auth', authPool);
  });

  afterAll(() => {
    state.pools.clear();
  });

  it('A started SDK exports to an in-process OTLP receiver with no bind value, cookie, token or secret', async () => {
    const receiver = await startReceiver();
    const marker = randomUUID();
    const bindEmail = `bind-${marker}@leak.test`;
    const bindPassword = `pw-${marker}`;
    const cookieValue = `cookie-${marker}`;
    const bearer = `token-${marker}`;
    const bodyMarker = `body-${marker}`;

    const running = await start(
      env({
        OTEL_EXPORTER_OTLP_ENDPOINT: receiver.endpoint,
        OTEL_BSP_SCHEDULE_DELAY: '100',
      }),
    );
    try {
      const base = `http://127.0.0.1:${String(running.port)}`;

      // Reaches Postgres (the sign-in looks the user up by the bound email).
      const signIn = await fetch(`${base}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': randomIp(),
          origin: ORIGIN,
          cookie: `session=${cookieValue}`,
          authorization: `Bearer ${bearer}`,
          'x-marker': bodyMarker,
        },
        body: JSON.stringify({ email: bindEmail, password: bindPassword, note: bodyMarker }),
      });
      expect(signIn.status).toBeGreaterThanOrEqual(400);
      await signIn.arrayBuffer();

      const health = await fetch(`${base}/healthz`, {
        headers: { cookie: `session=${cookieValue}`, authorization: `Bearer ${bearer}` },
      });
      expect(health.status).toBe(200);
      await health.arrayBuffer();
    } finally {
      await running.close();
    }
    await receiver.close();

    // Something was exported, including traces.
    expect(receiver.received.length).toBeGreaterThan(0);
    const spans = spansOf(receiver.received);
    expect(spans.length).toBeGreaterThan(0);

    // One exported trace spans an inbound HTTP request through to a Postgres span.
    const attr = (span: JsonSpan, key: string): unknown =>
      span.attributes?.find((a) => a.key === key)?.value;
    const serverTraceIds = new Set(
      spans
        .filter((s) => s.kind === 2 && attr(s, 'http.method') !== undefined)
        .map((s) => s.traceId),
    );
    const pgTraceIds = spans
      .filter((s) => attr(s, 'db.system') !== undefined || attr(s, 'db.system.name') !== undefined)
      .map((s) => s.traceId);
    expect(serverTraceIds.size).toBeGreaterThan(0);
    expect(pgTraceIds.some((id) => serverTraceIds.has(id))).toBe(true);

    // Nothing sensitive in ANY exported byte (traces, metrics, logs).
    const everything = receiver.received.map((r) => r.body).join('\n');
    for (const secret of [
      marker,
      bindEmail,
      bindPassword,
      cookieValue,
      bearer,
      bodyMarker,
      TEST_SECRET,
      'pw-app-marker',
      'pw-auth-marker',
    ]) {
      expect(everything).not.toContain(secret);
    }
    // No header is recorded at all by the http instrumentation.
    expect(everything).not.toMatch(/http\.(request|response)\.header/i);
    // No bind values recorded by pg (enhancedDatabaseReporting: false).
    expect(everything).not.toMatch(/db\.postgresql\.values|db\.query\.parameter/i);
  });

  it('starts no SDK and exports nothing when no OTLP endpoint is configured', async () => {
    const receiver = await startReceiver();
    const running = await start(env({ OTEL_EXPORTER_OTLP_ENDPOINT: undefined }));
    try {
      const health = await fetch(`http://127.0.0.1:${String(running.port)}/healthz`);
      expect(health.status).toBe(200);
      await health.arrayBuffer();
    } finally {
      await running.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    await receiver.close();
    expect(receiver.received).toHaveLength(0);

    const { startTelemetry } = await import('./telemetry.js');
    expect(startTelemetry(env({ OTEL_EXPORTER_OTLP_ENDPOINT: undefined }))).toBeUndefined();
  });
});
