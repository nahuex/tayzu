/**
 * Task 14.1 (design D15): secrets come only from the environment (Key Vault
 * references resolved by Azure Container Apps into env vars; `.env` locally),
 * and the app refuses to start when a required secret is missing or malformed.
 * There is no spec scenario for this task; the Verify clause is the contract.
 *
 * ## Production symbols expected
 *
 * ```ts
 * // apps/api/src/config.ts (does not exist yet)
 * export function loadConfig(env: Readonly<Record<string, string | undefined>>): {
 *   readonly appDatabaseUrl: string; // DATABASE_URL (tayzu_app password inside)
 *   readonly authDatabaseUrl: string; // AUTH_DATABASE_URL (tayzu_auth)
 *   readonly betterAuthSecret: string; // BETTER_AUTH_SECRET, >= 32 chars
 *   readonly cerbosAddress: string;
 *   readonly allowedOrigins: readonly string[];
 * };
 * ```
 *
 * It throws an `Error` that names the offending variable and never contains
 * the value of any secret. `createAppFromEnv` (bootstrap.ts) calls it before
 * building any pool, and reads `BETTER_AUTH_SECRET` (today it reads the
 * legacy name `AUTH_SECRET`; bootstrap.test.ts's fixture must be updated by
 * the orchestrator when the implementer renames it).
 *
 * `docs/security/secrets.md` (new) documents the change procedure for every
 * secret, naming each variable.
 *
 * ## Why this fails right now
 *
 * `./config.js` and `docs/security/secrets.md` do not exist.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tayzu/db', async (importActual) => {
  const actual = await importActual<typeof import('@tayzu/db')>();
  return { ...actual, createPool: vi.fn(actual.createPool) };
});

import { createPool } from '@tayzu/db';

import { createAppFromEnv } from './bootstrap.js';
// The module under test. Does not exist yet.
import { loadConfig } from './config.js';

const APP_URL = 'postgres://tayzu_app:app-pw-s3cret@db.invalid:5432/tayzu?sslmode=verify-full';
const AUTH_URL = 'postgres://tayzu_auth:auth-pw-s3cret@db.invalid:5432/tayzu?sslmode=verify-full';
const SECRET = 'config-unit-test-only-secret-0123456789-abcdefghij';

function env(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    DATABASE_URL: APP_URL,
    AUTH_DATABASE_URL: AUTH_URL,
    BETTER_AUTH_SECRET: SECRET,
    // Legacy name kept so this fixture also works while bootstrap.ts still reads it.
    AUTH_SECRET: SECRET,
    CERBOS_ADDRESS: 'localhost:3593',
    ALLOWED_ORIGINS: 'https://app.tayzu.test',
    ...overrides,
  };
}

const REQUIRED_SECRETS = ['DATABASE_URL', 'AUTH_DATABASE_URL', 'BETTER_AUTH_SECRET'] as const;
const SECRET_VALUES = ['app-pw-s3cret', 'auth-pw-s3cret', SECRET];

function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (caught) {
    expect(caught).toBeInstanceOf(Error);
    return caught as Error;
  }
  throw new Error('expected the call to throw');
}

describe('secrets come only from the environment and fail fast (task 14.1, D15)', () => {
  afterEach(() => {
    vi.mocked(createPool).mockClear();
  });

  it('accepts a complete environment', () => {
    const config = loadConfig(env());
    expect(config.appDatabaseUrl).toBe(APP_URL);
    expect(config.authDatabaseUrl).toBe(AUTH_URL);
    expect(config.betterAuthSecret).toBe(SECRET);
  });

  it.each(REQUIRED_SECRETS)('refuses to start with %s missing, naming it', (name) => {
    const error = thrown(() => loadConfig(env({ [name]: undefined })));
    expect(error.message).toContain(name);
  });

  it.each(REQUIRED_SECRETS)('refuses to start with %s empty or blank, naming it', (name) => {
    for (const blank of ['', '   ']) {
      const error = thrown(() => loadConfig(env({ [name]: blank })));
      expect(error.message).toContain(name);
    }
  });

  it('refuses a malformed BETTER_AUTH_SECRET (too short) without echoing it', () => {
    const short = 'too-short-s3cret';
    const error = thrown(() => loadConfig(env({ BETTER_AUTH_SECRET: short })));
    expect(error.message).toContain('BETTER_AUTH_SECRET');
    expect(error.message).not.toContain(short);
  });

  it('never puts a secret value in any error message', () => {
    for (const name of REQUIRED_SECRETS) {
      const error = thrown(() => loadConfig(env({ CERBOS_ADDRESS: undefined, [name]: undefined })));
      for (const value of SECRET_VALUES) {
        expect(error.message).not.toContain(value);
      }
    }
  });

  it('createAppFromEnv refuses a missing BETTER_AUTH_SECRET before building any pool', async () => {
    const error: unknown = await createAppFromEnv(
      env({ BETTER_AUTH_SECRET: undefined, AUTH_SECRET: undefined }),
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('BETTER_AUTH_SECRET');
    expect(vi.mocked(createPool)).not.toHaveBeenCalled();
  });

  it('documents the change procedure for every secret in docs/security/secrets.md', async () => {
    const path = fileURLToPath(new URL('../../../docs/security/secrets.md', import.meta.url));
    const doc = await readFile(path, 'utf8');
    for (const name of [...REQUIRED_SECRETS, 'Key Vault']) {
      expect(doc).toContain(name);
    }
    expect(doc.toLowerCase()).toMatch(/procedure|rotat/);
  });
});
