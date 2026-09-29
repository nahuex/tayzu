/**
 * Integration test for task 11.14 (resolved decision Q30, design D13).
 *
 * Task 11.14: "`apps/api/src/main.ts` and a `start` script: builds the app
 * with `createAppFromEnv`, listens on `HOST`/`PORT` from the environment, and
 * on `SIGTERM`/`SIGINT` closes the listener and then every pool. Verify:
 * `main.int.test.ts` covers 'The process listens on the configured port and
 * answers the health route' and 'SIGTERM closes the listener and the database
 * pools', plus a missing `PORT` failing fast."
 *
 * These are task-level behaviours (Q30), not scenarios of spec.md.
 *
 * ## Production symbols expected (apps/api/src/main.ts)
 *
 * ```ts
 * export interface RunningServer {
 *   readonly host: string;
 *   readonly port: number;        // the bound port (PORT=0 asks the OS for one)
 *   close(): Promise<void>;       // closes the listener, then every pool
 * }
 * export function start(env: Readonly<Record<string, string | undefined>>): Promise<RunningServer>;
 * ```
 *
 * `start` builds the app with `createAppFromEnv(env)`, listens on
 * `env.HOST`/`env.PORT`, and registers `SIGTERM` and `SIGINT` handlers that
 * run the same graceful close. It never calls `process.exit` itself in
 * `start`/the handlers (the process ends when its handles drain). A module-level
 * guard runs `start(process.env)` only when the file is the process entry
 * point, so importing `main.ts` has no side effect. A missing, empty or
 * non-numeric `PORT` makes `start` reject with an error naming `PORT`, before
 * any pool is built.
 *
 * The health route is `GET /healthz` (Q33): unauthenticated, answers only
 * `200 {"status":"ok"}`. Better Auth's `/api/auth/ok` stays blocked (404, D18).
 *
 * The test mocks `@tayzu/db`'s `createPool` (production URLs need
 * `sslmode=verify-full`) to hand out the harness pools behind spies on `end`.
 * The listener binds `127.0.0.1` on an ephemeral port only.
 *
 * ## Why this fails right now
 *
 * `main.ts` exists, but `createApp` does not yet mount `GET /healthz` (Q33), so the
 * health test gets 404 instead of 200. The other tests already pass because
 * `main.ts` implements them.
 */
import { connect } from 'node:net';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { harnessPools } from './__fixtures__/pools.js';

const state = vi.hoisted(() => ({
  pools: new Map<string, unknown>(),
  endCalls: [] as { role: string; listenerRefused: boolean }[],
  currentPort: 0,
}));

function portRefused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      resolve(true);
    });
  });
}

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
            return async () => {
              state.endCalls.push({
                role,
                listenerRefused: await portRefused(state.currentPort),
              });
            };
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

import { start, type RunningServer } from './main.js';

const APP_URL = 'postgres://tayzu_app:pw@db.invalid:5432/tayzu?sslmode=verify-full';
const AUTH_URL = 'postgres://tayzu_auth:pw@db.invalid:5432/tayzu?sslmode=verify-full';

function env(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    DATABASE_URL: APP_URL,
    AUTH_DATABASE_URL: AUTH_URL,
    BETTER_AUTH_SECRET: 'main-int-test-only-secret-0123456789-abcdefghijklmnop',
    CERBOS_ADDRESS: 'localhost:3593',
    ALLOWED_ORIGINS: 'https://app.tayzu.test',
    HOST: '127.0.0.1',
    PORT: '0',
    ...overrides,
  };
}

describe('process entry point (task 11.14, Q30)', () => {
  let running: RunningServer | undefined;

  beforeAll(async () => {
    const { appPool, authPool } = await harnessPools();
    state.pools.set('app', appPool);
    state.pools.set('auth', authPool);
  });

  beforeEach(() => {
    state.endCalls.length = 0;
  });

  afterEach(async () => {
    const current = running;
    running = undefined;
    await current?.close().catch(() => undefined);
  });

  afterAll(() => {
    state.pools.clear();
  });

  it('The process listens on the configured port and answers GET /healthz (Q33)', async () => {
    running = await start(env());
    state.currentPort = running.port;

    expect(running.host).toBe('127.0.0.1');
    expect(running.port).toBeGreaterThan(0);

    const base = `http://127.0.0.1:${String(running.port)}`;
    const response = await fetch(`${base}/healthz`);
    expect(response.status).toBe(200);
    // Exactly this body: no version, no dependency check, no internal detail (Q33).
    expect(await response.json()).toStrictEqual({ status: 'ok' });

    // Better Auth's own health route stays blocked by the allowlist (D18).
    const blocked = await fetch(`${base}/api/auth/ok`);
    expect(blocked.status).toBe(404);
  });

  it.each(['SIGTERM', 'SIGINT'] as const)(
    'SIGTERM closes the listener and the database pools (%s)',
    async (signal) => {
      running = await start(env());
      state.currentPort = running.port;
      const { port } = running;
      expect(await portRefused(port)).toBe(false);

      process.emit(signal);

      await vi.waitFor(() => {
        expect(state.endCalls.map((call) => call.role).sort()).toEqual(['app', 'auth']);
      });
      // The listener was already closed when each pool was ended (listener first, then pools).
      for (const call of state.endCalls) {
        expect(call.listenerRefused).toBe(true);
      }
      expect(await portRefused(port)).toBe(true);
    },
  );

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not a number', 'abc'],
  ] as const)(
    'a %s PORT fails fast, naming PORT, before any pool is built',
    async (_label, port) => {
      const { createPool } = await import('@tayzu/db');
      vi.mocked(createPool).mockClear();

      const error: unknown = await start(env({ PORT: port })).then(
        (server) => {
          running = server;
          return undefined;
        },
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('PORT');
      expect(vi.mocked(createPool)).not.toHaveBeenCalled();
    },
  );
});
