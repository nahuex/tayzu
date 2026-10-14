/**
 * `043` task 2.0 (Resolved decision Q79): `runScript(name, fn, options?)` in
 * `apps/api/scripts/run-script.ts` starts telemetry the way `./telemetry.ts`
 * does, asserts the script's database role(s), runs the script and shuts the
 * SDK down (which flushes) in a `finally`.
 *
 * ## Production symbols expected
 *
 * ```ts
 * // apps/api/scripts/run-script.ts
 * export interface ScriptRoleCheck {
 *   readonly pool: Pick<Pool, 'query'>;       // asked `SELECT current_user`
 *   readonly roles: readonly string[];        // the roles the script declares
 * }
 * export interface RunScriptOptions {
 *   readonly env?: Readonly<Record<string, string | undefined>>; // default process.env
 *   readonly roles?: readonly ScriptRoleCheck[];
 * }
 * export function runScript<T>(
 *   name: string,
 *   fn: () => Promise<T> | T,
 *   options?: RunScriptOptions,
 * ): Promise<T>;
 * ```
 *
 * - Telemetry is started by calling `startTelemetry(env)` from
 *   `../src/telemetry.js` (a throw from it propagates and `fn` never runs).
 * - Each role check reads `current_user` from the row the pool returns
 *   (`rows[0].current_user`); a user outside `roles` rejects `runScript`
 *   BEFORE `fn` runs.
 * - `Telemetry.shutdown()` is awaited in a `finally` (success and failure)
 *   before `runScript` settles. `fn`'s error is rethrown unchanged.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registration } from './__fixtures__/link-telemetry.js';

vi.mock('./telemetry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./telemetry.js')>();
  return { ...actual, startTelemetry: vi.fn(actual.startTelemetry) };
});

const { emitAccountLinkEvent } = await import('@tayzu/auth');
const { startTelemetry } = await import('./telemetry.js');
const { runScript } = await import('../scripts/run-script.js');

const startTelemetryMock = vi.mocked(startTelemetry);
const here = dirname(fileURLToPath(import.meta.url));

function harness() {
  if (!('harness' in registration)) throw new Error('telemetry harness failed to register');
  return registration.harness;
}

function fakePool(user: string) {
  return {
    query: vi.fn(() => Promise.resolve({ rows: [{ current_user: user }] })),
  } as never;
}

beforeEach(async () => {
  await harness().reset();
  startTelemetryMock.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await harness().shutdown();
});

describe('runScript (Q79)', () => {
  it('an event emitted by a script is in an in-memory exporter after runScript returns', async () => {
    const telemetry = { shutdown: vi.fn(() => harness().forceFlush()) };
    startTelemetryMock.mockReturnValueOnce(telemetry);

    await runScript(
      'emit-test',
      () => {
        emitAccountLinkEvent('linked', 'admin', { actorId: 'actor-run-script' });
      },
      { env: { NODE_ENV: 'test' } },
    );

    expect(startTelemetryMock).toHaveBeenCalledTimes(1);
    expect(telemetry.shutdown).toHaveBeenCalledTimes(1);
    const events = harness()
      .logExporter.getFinishedLogRecords()
      .filter((record) => record.eventName === 'auth.security.account_linked');
    expect(events).toHaveLength(1);
  });

  it('shuts the SDK down (flush) when the script returns, before runScript settles', async () => {
    let finished = false;
    const telemetry = {
      shutdown: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 10));
        finished = true;
      }),
    };
    startTelemetryMock.mockReturnValueOnce(telemetry);

    await expect(runScript('ok', () => 42, { env: { NODE_ENV: 'test' } })).resolves.toBe(42);

    expect(finished).toBe(true);
  });

  it('the flush happens when the script throws, and the script error is rethrown', async () => {
    const telemetry = { shutdown: vi.fn(() => Promise.resolve()) };
    startTelemetryMock.mockReturnValueOnce(telemetry);
    const failure = new Error('script failed');

    await expect(
      runScript(
        'throws',
        () => {
          throw failure;
        },
        { env: { NODE_ENV: 'test' } },
      ),
    ).rejects.toBe(failure);

    expect(telemetry.shutdown).toHaveBeenCalledTimes(1);
  });

  it('telemetry is refused outside test unless TAYZU_TELEMETRY_DISABLED=true', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const fn = vi.fn();

    await expect(runScript('prod', fn, { env: { NODE_ENV: 'production' } })).rejects.toThrow(
      /TAYZU_TELEMETRY_DISABLED/,
    );
    expect(fn).not.toHaveBeenCalled();

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await runScript('prod-disabled', fn, {
      env: { NODE_ENV: 'production', TAYZU_TELEMETRY_DISABLED: 'true' },
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a script that runs as a role it did not declare is refused before it does any work', async () => {
    const fn = vi.fn();

    await expect(
      runScript('wrong-role', fn, {
        env: { NODE_ENV: 'test' },
        roles: [{ pool: fakePool('tayzu_migrator'), roles: ['tayzu_auth'] }],
      }),
    ).rejects.toThrow();

    expect(fn).not.toHaveBeenCalled();
  });

  it('refuses when any one of several pools runs as an undeclared role', async () => {
    const fn = vi.fn();

    await expect(
      runScript('one-bad-pool', fn, {
        env: { NODE_ENV: 'test' },
        roles: [
          { pool: fakePool('tayzu_auth'), roles: ['tayzu_auth'] },
          { pool: fakePool('postgres'), roles: ['tayzu_app'] },
        ],
      }),
    ).rejects.toThrow();

    expect(fn).not.toHaveBeenCalled();
  });

  it('runs the script when every pool runs as a declared role', async () => {
    const fn = vi.fn(() => 'done');

    await expect(
      runScript('right-roles', fn, {
        env: { NODE_ENV: 'test' },
        roles: [
          { pool: fakePool('tayzu_auth'), roles: ['tayzu_auth'] },
          { pool: fakePool('tayzu_app'), roles: ['tayzu_app', 'tayzu_auth'] },
        ],
      }),
    ).resolves.toBe('done');

    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('the scripts of 1.4 start through runScript', () => {
  it.each(['backfill-user-blueprint', 'reconcile-users', 'bootstrap-admin'])(
    'scripts/%s.ts imports ./run-script.js and calls runScript(',
    (name) => {
      const source = readFileSync(resolve(here, '../scripts', `${name}.ts`), 'utf8');

      expect(source).toMatch(/from\s+['"]\.\/run-script\.js['"]/);
      expect(source).toMatch(/\brunScript\s*\(/);
    },
  );
});
