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
import { loadConfig, type Config } from './config.js';

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

  /**
   * Task 22.4 fix-up (design Q32): the back-channel logout budget per source IP
   * per minute. Production symbol: `Config.backchannelLogoutRateLimitPerMinute`.
   */
  it('BACKCHANNEL_LOGOUT_RATE_LIMIT_PER_MINUTE defaults to 600 when unset (Q32)', () => {
    expect(loadConfig(env()).backchannelLogoutRateLimitPerMinute).toBe(600);
  });

  it('BACKCHANNEL_LOGOUT_RATE_LIMIT_PER_MINUTE is read as a positive integer (Q32)', () => {
    expect(
      loadConfig(env({ BACKCHANNEL_LOGOUT_RATE_LIMIT_PER_MINUTE: '42' }))
        .backchannelLogoutRateLimitPerMinute,
    ).toBe(42);
  });

  it.each(['0', '-1', 'abc', '1.5', '', '   ', '1e3'])(
    'BACKCHANNEL_LOGOUT_RATE_LIMIT_PER_MINUTE=%j fails fast naming the variable (Q32)',
    (value) => {
      const error = thrown(() =>
        loadConfig(env({ BACKCHANNEL_LOGOUT_RATE_LIMIT_PER_MINUTE: value })),
      );
      expect(error.message).toContain('BACKCHANNEL_LOGOUT_RATE_LIMIT_PER_MINUTE');
    },
  );

  /**
   * Task 23.11 (design Q39, D20, D13): limiters and body limit are on by default.
   * Production symbols: `Config.preAuthSignInRateLimit`, `Config.rateLimit`,
   * `Config.tokenExchangeRateLimit`, `Config.bodyLimit` become always defined
   * (enabled defaults in `loadConfig`). The design gives no numeric values, so
   * the tests assert only "defined and a positive integer".
   */
  it('a minimal production environment still has every limiter and the body limit active (Q39)', () => {
    const config: Partial<Config> = loadConfig(env());
    const numbers = [
      config.preAuthSignInRateLimit?.max,
      config.preAuthSignInRateLimit?.window,
      config.rateLimit?.max,
      config.rateLimit?.timeWindowMs,
      config.tokenExchangeRateLimit?.max,
      config.tokenExchangeRateLimit?.timeWindowMs,
      config.bodyLimit,
    ];
    for (const value of numbers) {
      expect(Number.isSafeInteger(value) && (value ?? 0) > 0, `value ${String(value)}`).toBe(true);
    }
  });

  it('the environment only tunes the limits (Q39)', () => {
    const config = loadConfig(
      env({
        PRE_AUTH_SIGN_IN_RATE_LIMIT_MAX: '7',
        PRE_AUTH_SIGN_IN_RATE_LIMIT_WINDOW_SECONDS: '30',
        RATE_LIMIT_MAX: '8',
        RATE_LIMIT_WINDOW_SECONDS: '20',
        TOKEN_EXCHANGE_RATE_LIMIT_MAX: '9',
        TOKEN_EXCHANGE_RATE_LIMIT_WINDOW_SECONDS: '10',
        BODY_LIMIT_BYTES: '2048',
      }),
    );
    expect(config.preAuthSignInRateLimit).toEqual({ max: 7, window: 30 });
    expect(config.rateLimit).toEqual({ max: 8, timeWindowMs: 20_000 });
    expect(config.tokenExchangeRateLimit).toEqual({ max: 9, timeWindowMs: 10_000 });
    expect(config.bodyLimit).toBe(2048);
  });

  const LIMIT_VARIABLES = [
    'PRE_AUTH_SIGN_IN_RATE_LIMIT_MAX',
    'PRE_AUTH_SIGN_IN_RATE_LIMIT_WINDOW_SECONDS',
    'RATE_LIMIT_MAX',
    'RATE_LIMIT_WINDOW_SECONDS',
    'TOKEN_EXCHANGE_RATE_LIMIT_MAX',
    'TOKEN_EXCHANGE_RATE_LIMIT_WINDOW_SECONDS',
    'BODY_LIMIT_BYTES',
  ] as const;

  it.each(
    LIMIT_VARIABLES.flatMap((name) =>
      ['0', '-1', 'false', 'off', 'disabled', 'abc', ''].map((value) => [name, value] as const),
    ),
  )('%s=%j (disabled or non-positive) fails startup naming the variable (Q39)', (name, value) => {
    const error = thrown(() => loadConfig(env({ [name]: value })));
    expect(error.message).toContain(name);
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

describe('TAYZU_TELEMETRY_DISABLED parsing (task 23.13, Q41)', () => {
  it('is false when unset', () => {
    expect(loadConfig(env()).telemetryDisabled).toBe(false);
  });

  it('is true only for the exact value true', () => {
    expect(loadConfig(env({ TAYZU_TELEMETRY_DISABLED: 'true' })).telemetryDisabled).toBe(true);
  });

  it('is false for the exact value false', () => {
    expect(loadConfig(env({ TAYZU_TELEMETRY_DISABLED: 'false' })).telemetryDisabled).toBe(false);
  });

  it.each(['1', 'yes', 'TRUE', 'True', 'on', '', '  '])(
    'TAYZU_TELEMETRY_DISABLED=%j is malformed and fails startup naming the variable',
    (value) => {
      const error = thrown(() => loadConfig(env({ TAYZU_TELEMETRY_DISABLED: value })));
      expect(error.message).toContain('TAYZU_TELEMETRY_DISABLED');
    },
  );
});

describe('VISMA_CONNECT_DISCOVERY_URL must be https outside test (task 23.18, Q48, D23)', () => {
  const sso = (url: string, nodeEnv: string): Record<string, string | undefined> =>
    env({
      NODE_ENV: nodeEnv,
      BETTER_AUTH_URL: 'https://api.tayzu.test',
      VISMA_CONNECT_DISCOVERY_URL: url,
      VISMA_CONNECT_CLIENT_ID: 'client-id',
      VISMA_CONNECT_CLIENT_SECRET: 'client-secret-value',
    });

  it('rejects an http discovery URL outside test, naming the variable and not echoing the URL', () => {
    const url = 'http://connect.example.invalid/.well-known/openid-configuration';
    const error = thrown(() => loadConfig(sso(url, 'production')));
    expect(error.message).toContain('VISMA_CONNECT_DISCOVERY_URL');
    expect(error.message).not.toContain(url);
  });

  it('rejects an http loopback discovery URL outside test', () => {
    const error = thrown(() =>
      loadConfig(sso('http://127.0.0.1:4010/.well-known/openid-configuration', 'production')),
    );
    expect(error.message).toContain('VISMA_CONNECT_DISCOVERY_URL');
  });

  it('accepts an https discovery URL outside test', () => {
    const url = 'https://connect.example.invalid/.well-known/openid-configuration';
    expect(loadConfig(sso(url, 'production')).sso?.discoveryUrl).toBe(url);
  });

  it("accepts the test stub's http loopback discovery URL in test", () => {
    const url = 'http://127.0.0.1:4010/.well-known/openid-configuration';
    expect(loadConfig(sso(url, 'test')).sso?.discoveryUrl).toBe(url);
  });
});
