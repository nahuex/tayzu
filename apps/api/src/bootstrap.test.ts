/**
 * Unit test for the task 11.1 fix-up (root CLAUDE.md TLS invariant; design D5,
 * D6): the production bootstrap builds its pools only through `@tayzu/db`'s
 * `createPool`, so `sslmode=verify-full` is enforced, and it connects Better
 * Auth with its own database URL (role `tayzu_auth`), not the runtime one.
 *
 * ## Production symbols expected
 *
 * ```ts
 * // apps/api/src/bootstrap.ts (does not exist yet)
 * export function createAppFromEnv(env: Readonly<Record<string, string | undefined>>): Promise<App>;
 * ```
 *
 * Reads `DATABASE_URL` (runtime role `tayzu_app`), `AUTH_DATABASE_URL` (role
 * `tayzu_auth`), `AUTH_SECRET`, `CERBOS_ADDRESS`, `ALLOWED_ORIGINS`
 * (comma-separated). It is what the process entry point (`main`/`start`) calls.
 * It builds both pools with `createPool` and injects them into `createApp`;
 * the returned `App.close()` also ends the pools it built.
 *
 * `createApp` (server.ts) changes to take `appPool` and `authPool` instead of
 * `databaseUrl`, and never ends pools it did not build.
 *
 * ## Why this fails right now
 *
 * `./bootstrap.js` does not exist ("Cannot find module" is the only cause).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// Wrap the real createPool so calls are observable but TLS checking is real.
vi.mock('@tayzu/db', async (importActual) => {
  const actual = await importActual<typeof import('@tayzu/db')>();
  return { ...actual, createPool: vi.fn(actual.createPool) };
});

import { createPool } from '@tayzu/db';

// The module under test. Does not exist yet.
import { createAppFromEnv } from './bootstrap.js';

const APP_URL = 'postgres://tayzu_app:app-pw-s3cret@db.invalid:5432/tayzu?sslmode=verify-full';
const AUTH_URL = 'postgres://tayzu_auth:auth-pw-s3cret@db.invalid:5432/tayzu?sslmode=verify-full';

function env(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    DATABASE_URL: APP_URL,
    AUTH_DATABASE_URL: AUTH_URL,
    AUTH_SECRET: 'bootstrap-unit-test-only-secret-0123456789-abcdefghij',
    CERBOS_ADDRESS: 'localhost:3593',
    ALLOWED_ORIGINS: 'https://app.tayzu.test',
    ...overrides,
  };
}

const NO_VERIFY_FULL = [
  ['no sslmode at all', 'postgres://u:pw-s3cret@db.invalid:5432/tayzu'],
  ['sslmode=require', 'postgres://u:pw-s3cret@db.invalid:5432/tayzu?sslmode=require'],
  ['sslmode=disable', 'postgres://u:pw-s3cret@db.invalid:5432/tayzu?sslmode=disable'],
  ['a local host without sslmode', 'postgres://u:pw-s3cret@localhost:5432/tayzu'],
] as const;

describe('production bootstrap TLS and roles (task 11.1 fix-up)', () => {
  afterEach(() => {
    vi.mocked(createPool).mockClear();
  });

  it.each(NO_VERIFY_FULL)(
    'refuses a DATABASE_URL with %s, naming sslmode=verify-full and never echoing the URL',
    async (_label, url) => {
      const error: unknown = await createAppFromEnv(env({ DATABASE_URL: url })).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain('sslmode=verify-full');
      expect(message).not.toContain('pw-s3cret');
    },
  );

  it.each(NO_VERIFY_FULL)(
    'refuses an AUTH_DATABASE_URL with %s even when DATABASE_URL is valid',
    async (_label, url) => {
      const error: unknown = await createAppFromEnv(env({ AUTH_DATABASE_URL: url })).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain('sslmode=verify-full');
      expect(message).not.toContain('pw-s3cret');
    },
  );

  it('refuses a missing AUTH_DATABASE_URL instead of falling back to DATABASE_URL', async () => {
    await expect(createAppFromEnv(env({ AUTH_DATABASE_URL: undefined }))).rejects.toThrow();
    expect(vi.mocked(createPool)).not.toHaveBeenCalledWith(APP_URL);
  });

  it('builds the app pool from DATABASE_URL and the auth pool from AUTH_DATABASE_URL, both through createPool, and closing ends both', async () => {
    const built = await createAppFromEnv(env());

    const calls = vi.mocked(createPool).mock.calls.map(([url]) => url);
    expect(calls).toContain(APP_URL);
    expect(calls).toContain(AUTH_URL);
    expect(calls).toHaveLength(2);

    const pools = vi
      .mocked(createPool)
      .mock.results.map((result) => result.value as { end(): Promise<void> });
    const ended = pools.map((pool) => vi.spyOn(pool, 'end'));
    await built.close();
    for (const spy of ended) {
      expect(spy).toHaveBeenCalled();
    }
  });
});
