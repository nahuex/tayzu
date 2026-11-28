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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isIPv6 } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

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
const HMAC_SECRET = 'config-hmac-test-only-secret-0123456789-abcdefgh';

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
    INVITATION_LINK_BASE_URL: 'https://app.tayzu.test',
    PASSWORD_RESET_LINK_BASE_URL: 'https://app.tayzu.test',
    IDENTITY_TOKEN_HMAC_SECRET: HMAC_SECRET,
    // 048 D2: the proxy trust is required outside test, so a valid production fixture sets it.
    TRUST_PROXY_HOPS: '1',
    TRUST_PROXY_CIDRS: '10.0.0.0/16',
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
      EMAIL_PROVIDER: 'none',
      // 048 D3: the origin of BETTER_AUTH_URL is one of ALLOWED_ORIGINS.
      BETTER_AUTH_URL: 'https://app.tayzu.test',
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

/**
 * Task 24.6 (design Q56, Q40): `ALLOWED_ORIGINS` lists only `https` origins
 * with no wildcard outside test. Production symbol: `loadConfig` in
 * `config.ts` throws an `Error` naming `ALLOWED_ORIGINS` and never echoing the
 * offending origin; in test, `http://localhost` stays accepted.
 */
describe('ALLOWED_ORIGINS must be https and wildcard-free outside test (task 24.6, Q56, Q40)', () => {
  const origins = (value: string, nodeEnv: string): Record<string, string | undefined> =>
    env({
      NODE_ENV: nodeEnv,
      EMAIL_PROVIDER: 'none',
      // 048 D3: BETTER_AUTH_URL's origin is one of the accepted ALLOWED_ORIGINS values below.
      BETTER_AUTH_URL: nodeEnv === 'test' ? 'http://localhost' : 'https://app.tayzu.test',
      ALLOWED_ORIGINS: value,
    });

  it('rejects an http origin outside test, naming the variable and not echoing the origin', () => {
    const origin = 'http://app.tayzu.invalid';
    const error = thrown(() => loadConfig(origins(origin, 'production')));
    expect(error.message).toContain('ALLOWED_ORIGINS');
    expect(error.message).not.toContain(origin);
  });

  it('rejects an http origin among valid https origins outside test', () => {
    const error = thrown(() =>
      loadConfig(origins('https://app.tayzu.test, http://other.tayzu.invalid', 'production')),
    );
    expect(error.message).toContain('ALLOWED_ORIGINS');
  });

  it('rejects a * wildcard outside test, naming the variable', () => {
    const error = thrown(() => loadConfig(origins('*', 'production')));
    expect(error.message).toContain('ALLOWED_ORIGINS');
  });

  it('rejects a * wildcard listed next to an https origin outside test', () => {
    const error = thrown(() => loadConfig(origins('https://app.tayzu.test,*', 'production')));
    expect(error.message).toContain('ALLOWED_ORIGINS');
  });

  it('accepts https origins outside test', () => {
    expect(
      loadConfig(origins('https://app.tayzu.test,https://admin.tayzu.test', 'production'))
        .allowedOrigins,
    ).toEqual(['https://app.tayzu.test', 'https://admin.tayzu.test']);
  });

  it('accepts http://localhost in test', () => {
    expect(loadConfig(origins('http://localhost', 'test')).allowedOrigins).toEqual([
      'http://localhost',
    ]);
  });
});

/**
 * `043` task 6.3 (design D5, Resolved decision Q32): `INVITATION_LINK_BASE_URL`
 * is `https` outside test and one of `ALLOWED_ORIGINS`. Production symbol:
 * `Config.invitationLinkBaseUrl?: string` (undefined only in test when unset);
 * `loadConfig` throws an `Error` naming the variable and never echoing the value.
 */
describe('INVITATION_LINK_BASE_URL (043 task 6.3, Q32)', () => {
  const NAME = 'INVITATION_LINK_BASE_URL';
  const link = (value: string | undefined, nodeEnv: string): Record<string, string | undefined> =>
    env({
      NODE_ENV: nodeEnv,
      EMAIL_PROVIDER: 'none',
      // 048 D3: the origin of BETTER_AUTH_URL is one of ALLOWED_ORIGINS.
      BETTER_AUTH_URL: 'https://app.tayzu.test',
      ALLOWED_ORIGINS: 'https://app.tayzu.test',
      [NAME]: value,
    });

  it('rejects an http value outside test, naming the variable and not echoing it', () => {
    const value = 'http://app.tayzu.test';
    const error = thrown(() => loadConfig(link(value, 'production')));
    expect(error.message).toContain(NAME);
    expect(error.message).not.toContain(value);
  });

  it('rejects a value outside ALLOWED_ORIGINS, naming the variable and not echoing it', () => {
    const value = 'https://elsewhere.tayzu.invalid';
    const error = thrown(() => loadConfig(link(value, 'production')));
    expect(error.message).toContain(NAME);
    expect(error.message).not.toContain(value);
  });

  it('rejects a missing value outside test', () => {
    const error = thrown(() => loadConfig(link(undefined, 'production')));
    expect(error.message).toContain(NAME);
  });

  it('rejects a malformed value outside test', () => {
    const error = thrown(() => loadConfig(link('not a url', 'production')));
    expect(error.message).toContain(NAME);
  });

  it('accepts an https value on ALLOWED_ORIGINS outside test', () => {
    const config = loadConfig(link('https://app.tayzu.test', 'production'));
    expect(config.invitationLinkBaseUrl).toBe('https://app.tayzu.test');
  });

  it('accepts an http value in test', () => {
    const config = loadConfig(link('http://localhost:3000', 'test'));
    expect(config.invitationLinkBaseUrl).toBe('http://localhost:3000');
  });

  it('is undefined in test when unset', () => {
    expect(loadConfig(link(undefined, 'test')).invitationLinkBaseUrl).toBeUndefined();
  });
});

/**
 * `044` task 4.1 (design D9 configuration table): `PASSWORD_RESET_LINK_BASE_URL`
 * is parsed like `INVITATION_LINK_BASE_URL`. Production symbol:
 * `Config.passwordResetLinkBaseUrl?: string` (`apps/api/src/config.ts`),
 * undefined only in test when unset; `loadConfig` throws an `Error` naming the
 * variable and never echoing the value.
 */
describe('PASSWORD_RESET_LINK_BASE_URL (044 task 4.1, D9)', () => {
  const NAME = 'PASSWORD_RESET_LINK_BASE_URL';
  const link = (value: string | undefined, nodeEnv: string): Record<string, string | undefined> =>
    env({
      NODE_ENV: nodeEnv,
      EMAIL_PROVIDER: 'none',
      // 048 D3: the origin of BETTER_AUTH_URL is one of ALLOWED_ORIGINS.
      BETTER_AUTH_URL: 'https://app.tayzu.test',
      ALLOWED_ORIGINS: 'https://app.tayzu.test',
      [NAME]: value,
    });

  describe('outside test it is required, https and one of ALLOWED_ORIGINS', () => {
    it('accepts an https value on ALLOWED_ORIGINS', () => {
      const config = loadConfig(link('https://app.tayzu.test', 'production'));
      expect(config.passwordResetLinkBaseUrl).toBe('https://app.tayzu.test');
    });

    it('rejects a missing value', () => {
      const error = thrown(() => loadConfig(link(undefined, 'production')));
      expect(error.message).toContain(NAME);
    });

    it('rejects an empty value', () => {
      const error = thrown(() => loadConfig(link('', 'production')));
      expect(error.message).toContain(NAME);
    });

    it('rejects a malformed value', () => {
      const error = thrown(() => loadConfig(link('not a url', 'production')));
      expect(error.message).toContain(NAME);
    });

    it('rejects an http value', () => {
      const error = thrown(() => loadConfig(link('http://app.tayzu.test', 'production')));
      expect(error.message).toContain(NAME);
    });

    it('rejects an https value outside ALLOWED_ORIGINS', () => {
      const error = thrown(() => loadConfig(link('https://elsewhere.tayzu.invalid', 'production')));
      expect(error.message).toContain(NAME);
    });
  });

  describe('under test it is optional and http or https', () => {
    it('is undefined when unset', () => {
      expect(loadConfig(link(undefined, 'test')).passwordResetLinkBaseUrl).toBeUndefined();
    });

    it('accepts an http value', () => {
      const config = loadConfig(link('http://localhost:3000', 'test'));
      expect(config.passwordResetLinkBaseUrl).toBe('http://localhost:3000');
    });

    it('accepts an https value', () => {
      const config = loadConfig(link('https://reset.tayzu.test', 'test'));
      expect(config.passwordResetLinkBaseUrl).toBe('https://reset.tayzu.test');
    });

    it('rejects a value that is neither http nor https', () => {
      const error = thrown(() => loadConfig(link('ftp://app.tayzu.test', 'test')));
      expect(error.message).toContain(NAME);
    });

    it('rejects a malformed value', () => {
      const error = thrown(() => loadConfig(link('not a url', 'test')));
      expect(error.message).toContain(NAME);
    });
  });

  describe('an error names the variable and never its value', () => {
    const rejected: readonly (readonly [string, string, string])[] = [
      ['an http value', 'http://secret-host.tayzu.test', 'production'],
      ['a value outside ALLOWED_ORIGINS', 'https://secret-host.tayzu.invalid', 'production'],
      ['a non-http scheme under test', 'ftp://secret-host.tayzu.test', 'test'],
    ];

    it.each(rejected)('%s', (_label, value, nodeEnv) => {
      const error = thrown(() => loadConfig(link(value, nodeEnv)));
      expect(error.message).toContain(NAME);
      expect(error.message).not.toContain(value);
      expect(error.message).not.toContain('secret-host');
    });
  });
});

/**
 * Task 24.12 (design Q39, Q52, D20): the password-check limiter of 24.2 is
 * enabled by default like the sign-in limiter, and its two variables only
 * tune it.
 *
 * Production symbol expected: `Config.preAuthPasswordCheckRateLimit:
 * { max: number; window: number }` (window in seconds, like
 * `preAuthSignInRateLimit`), built with `limitWithDefaults` from
 * `PRE_AUTH_PASSWORD_CHECK_RATE_LIMIT_MAX` and
 * `PRE_AUTH_PASSWORD_CHECK_RATE_LIMIT_WINDOW_SECONDS`. The design states no
 * numeric defaults, so only "a positive integer" is asserted.
 */
describe('pre-auth password-check limit from the environment (task 24.12, Q39, Q52)', () => {
  const MAX = 'PRE_AUTH_PASSWORD_CHECK_RATE_LIMIT_MAX';
  const WINDOW = 'PRE_AUTH_PASSWORD_CHECK_RATE_LIMIT_WINDOW_SECONDS';

  it('defaults to an enabled limit when neither variable is set', () => {
    const limit = (
      loadConfig(env()) as unknown as Partial<Record<string, { max?: unknown; window?: unknown }>>
    )['preAuthPasswordCheckRateLimit'];
    for (const value of [limit?.max, limit?.window]) {
      expect(Number.isSafeInteger(value) && (value as number) > 0, `value ${String(value)}`).toBe(
        true,
      );
    }
  });

  it('the environment only tunes the limit', () => {
    const config = loadConfig(env({ [MAX]: '4', [WINDOW]: '45' })) as unknown as Record<
      string,
      unknown
    >;
    expect(config['preAuthPasswordCheckRateLimit']).toEqual({ max: 4, window: 45 });
  });

  it.each(
    [MAX, WINDOW].flatMap((name) =>
      ['0', '-1', 'false', 'off', 'disabled', 'abc', '', '1.5'].map(
        (value) => [name, value] as const,
      ),
    ),
  )('%s=%j (disabled or malformed) fails startup naming the variable', (name, value) => {
    const error = thrown(() => loadConfig(env({ [name]: value })));
    expect(error.message).toContain(name);
  });
});

/**
 * `043` task 6.5 (design D5, Resolved decisions Q28, Q67, Q96, Q99): the email
 * provider is chosen by `EMAIL_PROVIDER` (`acs` or `none`). "Production" is
 * `NODE_ENV !== 'test'`.
 *
 * Production symbols expected on `Config` (`apps/api/src/config.ts`):
 * - `emailProvider?: 'acs' | 'none'` (undefined only under test when unset);
 * - `acsConnectionString?: string` (from `ACS_CONNECTION_STRING`);
 * - `emailRecipientDomainAllowlist: readonly string[]` (from
 *   `EMAIL_RECIPIENT_DOMAIN_ALLOWLIST`, a comma-separated list; `[]` when unset).
 * `acs` also reads `EMAIL_SENDER_ADDRESS` (6.4); no test here depends on how.
 * Errors name the variable and never echo its value.
 */
describe('email provider selection (043 task 6.5, Q28, Q67, Q96, Q99)', () => {
  const ACCESS_KEY = Buffer.from('acs-'.repeat(8)).toString('base64');
  const CONNECTION_STRING = `endpoint=https://acs-test.communication.azure.com/;accesskey=${ACCESS_KEY}`;
  const mail = (
    nodeEnv: string,
    overrides: Record<string, string | undefined> = {},
  ): Record<string, string | undefined> =>
    env({
      NODE_ENV: nodeEnv,
      // 048 D3: the origin of BETTER_AUTH_URL is one of ALLOWED_ORIGINS.
      BETTER_AUTH_URL: 'https://app.tayzu.test',
      EMAIL_SENDER_ADDRESS: 'DoNotReply@mail.tayzu.example',
      ...overrides,
    });
  const field = (config: Config, name: string): unknown =>
    (config as unknown as Record<string, unknown>)[name];

  it.each(['production', 'staging', 'development'])(
    'a deployed environment (NODE_ENV=%s) with no EMAIL_PROVIDER fails startup naming the variable',
    (nodeEnv) => {
      const error = thrown(() => loadConfig(mail(nodeEnv)));
      expect(error.message).toContain('EMAIL_PROVIDER');
    },
  );

  it.each(['', '   ', 'smtp', 'ACS', 'resend', 'true'])(
    'a deployed environment with EMAIL_PROVIDER=%j fails startup naming the variable',
    (value) => {
      const error = thrown(() => loadConfig(mail('production', { EMAIL_PROVIDER: value })));
      expect(error.message).toContain('EMAIL_PROVIDER');
    },
  );

  it('EMAIL_PROVIDER=none starts in a deployed environment', () => {
    const config = loadConfig(mail('production', { EMAIL_PROVIDER: 'none' }));
    expect(field(config, 'emailProvider')).toBe('none');
  });

  it('EMAIL_PROVIDER=acs starts in a deployed environment and reads the connection string', () => {
    const config = loadConfig(
      mail('production', { EMAIL_PROVIDER: 'acs', ACS_CONNECTION_STRING: CONNECTION_STRING }),
    );
    expect(field(config, 'emailProvider')).toBe('acs');
    expect(field(config, 'acsConnectionString')).toBe(CONNECTION_STRING);
  });

  it('EMAIL_PROVIDER=acs without ACS_CONNECTION_STRING fails startup naming the variable', () => {
    const error = thrown(() => loadConfig(mail('production', { EMAIL_PROVIDER: 'acs' })));
    expect(error.message).toContain('ACS_CONNECTION_STRING');
  });

  it('EMAIL_PROVIDER=acs with a blank ACS_CONNECTION_STRING fails startup naming the variable', () => {
    const error = thrown(() =>
      loadConfig(mail('production', { EMAIL_PROVIDER: 'acs', ACS_CONNECTION_STRING: '  ' })),
    );
    expect(error.message).toContain('ACS_CONNECTION_STRING');
  });

  it('no error message echoes the connection string', () => {
    const failing = [
      mail('test', { EMAIL_PROVIDER: 'acs', ACS_CONNECTION_STRING: CONNECTION_STRING }),
      mail('production', { EMAIL_PROVIDER: 'smtp', ACS_CONNECTION_STRING: CONNECTION_STRING }),
    ];
    for (const attempt of failing) {
      const error = thrown(() => loadConfig(attempt));
      expect(error.message).toMatch(/EMAIL_/);
      expect(error.message).not.toContain(CONNECTION_STRING);
      expect(error.message).not.toContain(ACCESS_KEY);
    }
  });

  it('a real provider under NODE_ENV=test without the allowlist fails startup naming it', () => {
    const error = thrown(() =>
      loadConfig(mail('test', { EMAIL_PROVIDER: 'acs', ACS_CONNECTION_STRING: CONNECTION_STRING })),
    );
    expect(error.message).toContain('EMAIL_RECIPIENT_DOMAIN_ALLOWLIST');
  });

  it('a real provider under NODE_ENV=test with an empty allowlist fails startup naming it', () => {
    const error = thrown(() =>
      loadConfig(
        mail('test', {
          EMAIL_PROVIDER: 'acs',
          ACS_CONNECTION_STRING: CONNECTION_STRING,
          EMAIL_RECIPIENT_DOMAIN_ALLOWLIST: ' , ',
        }),
      ),
    );
    expect(error.message).toContain('EMAIL_RECIPIENT_DOMAIN_ALLOWLIST');
  });

  it('a real provider under NODE_ENV=test with the allowlist starts and exposes the domains', () => {
    const config = loadConfig(
      mail('test', {
        EMAIL_PROVIDER: 'acs',
        ACS_CONNECTION_STRING: CONNECTION_STRING,
        EMAIL_RECIPIENT_DOMAIN_ALLOWLIST: 'example.com, tayzu.test',
      }),
    );
    expect(field(config, 'emailProvider')).toBe('acs');
    expect(field(config, 'emailRecipientDomainAllowlist')).toEqual(['example.com', 'tayzu.test']);
  });

  it('the allowlist is read in a deployed environment too (Q99), and is not mandatory there', () => {
    const withList = loadConfig(
      mail('production', {
        EMAIL_PROVIDER: 'acs',
        ACS_CONNECTION_STRING: CONNECTION_STRING,
        EMAIL_RECIPIENT_DOMAIN_ALLOWLIST: 'example.com',
      }),
    );
    const without = loadConfig(
      mail('production', { EMAIL_PROVIDER: 'acs', ACS_CONNECTION_STRING: CONNECTION_STRING }),
    );
    expect(field(withList, 'emailRecipientDomainAllowlist')).toEqual(['example.com']);
    expect(field(without, 'emailRecipientDomainAllowlist')).toEqual([]);
  });

  it('under NODE_ENV=test no EMAIL_PROVIDER is needed and none starts without an allowlist', () => {
    expect(field(loadConfig(mail('test')), 'emailProvider')).toBeUndefined();
    expect(field(loadConfig(mail('test', { EMAIL_PROVIDER: 'none' })), 'emailProvider')).toBe(
      'none',
    );
  });
});

/**
 * `043` task 6.5c (design D5, Resolved decision Q80): `EMAIL_DISABLED_TENANT_IDS` is
 * a comma-separated list of tenant ids, each checked against the catalog's tenant-id
 * pattern (`^[A-Za-z0-9_-]{1,64}$`) at startup.
 *
 * Production symbol expected on `Config` (`apps/api/src/config.ts`):
 * - `emailDisabledTenantIds: readonly string[]` (entries trimmed; `[]` when unset),
 *   read in every environment. A malformed entry throws an `Error` naming
 *   `EMAIL_DISABLED_TENANT_IDS` and never echoing the value.
 */
describe('EMAIL_DISABLED_TENANT_IDS (043 task 6.5c, Q80)', () => {
  const base = (
    nodeEnv: string,
    overrides: Record<string, string | undefined> = {},
  ): Record<string, string | undefined> =>
    env({
      NODE_ENV: nodeEnv,
      // 048 D3: the origin of BETTER_AUTH_URL is one of ALLOWED_ORIGINS.
      BETTER_AUTH_URL: 'https://app.tayzu.test',
      EMAIL_SENDER_ADDRESS: 'DoNotReply@mail.tayzu.example',
      EMAIL_PROVIDER: 'none',
      ...overrides,
    });
  const field = (config: Config, name: string): unknown =>
    (config as unknown as Record<string, unknown>)[name];

  it.each(['test', 'production'])('is empty when unset (NODE_ENV=%s)', (nodeEnv) => {
    expect(field(loadConfig(base(nodeEnv)), 'emailDisabledTenantIds')).toEqual([]);
  });

  it.each(['test', 'production'])(
    'a well-formed list starts and exposes the ids (NODE_ENV=%s)',
    (nodeEnv) => {
      const config = loadConfig(
        base(nodeEnv, { EMAIL_DISABLED_TENANT_IDS: 'demo-tenant, Demo_2 ,a' }),
      );
      expect(field(config, 'emailDisabledTenantIds')).toEqual(['demo-tenant', 'Demo_2', 'a']);
    },
  );

  it.each([
    ['a space inside an id', 'demo-tenant,bad tenant'],
    ['a slash', 'demo/tenant'],
    ['a dot', 'demo.tenant'],
    ['a 65-character id', 'a'.repeat(65)],
    ['a quote', "demo'tenant"],
    ['a non-ASCII letter', 'démo'],
  ])('a malformed tenant id (%s) fails startup naming the variable', (_label, value) => {
    for (const nodeEnv of ['test', 'production']) {
      const error = thrown(() => loadConfig(base(nodeEnv, { EMAIL_DISABLED_TENANT_IDS: value })));
      expect(error.message).toContain('EMAIL_DISABLED_TENANT_IDS');
      expect(error.message).not.toContain(value);
    }
  });

  it('a 64-character id is accepted', () => {
    const id = 'a'.repeat(64);
    const config = loadConfig(base('production', { EMAIL_DISABLED_TENANT_IDS: id }));
    expect(field(config, 'emailDisabledTenantIds')).toEqual([id]);
  });
});

/**
 * `043` task 6.7b (Resolved decision Q93): `IDENTITY_TOKEN_HMAC_SECRET` keys the
 * per-recipient caps. Required outside `NODE_ENV=test`, at least 32 bytes, never
 * echoed. Production symbol expected on `Config`: `identityTokenHmacSecret?: string`
 * (undefined only under test when unset).
 */
describe('IDENTITY_TOKEN_HMAC_SECRET (043 task 6.7b, Q93)', () => {
  const deployed = (
    overrides: Record<string, string | undefined> = {},
  ): Record<string, string | undefined> =>
    env({
      NODE_ENV: 'production',
      EMAIL_PROVIDER: 'none',
      // 048 D3: the origin of BETTER_AUTH_URL is one of ALLOWED_ORIGINS.
      BETTER_AUTH_URL: 'https://app.tayzu.test',
      ...overrides,
    });
  const field = (config: Config, name: string): unknown =>
    (config as unknown as Record<string, unknown>)[name];

  it('a deployed environment starts with a 32-byte secret and exposes it', () => {
    const exactly32 = 'k'.repeat(32);
    const config = loadConfig(deployed({ IDENTITY_TOKEN_HMAC_SECRET: exactly32 }));
    expect(field(config, 'identityTokenHmacSecret')).toBe(exactly32);
  });

  it.each([undefined, '', '   '])(
    'a deployed environment with the secret %j fails startup naming the variable',
    (value) => {
      const error = thrown(() => loadConfig(deployed({ IDENTITY_TOKEN_HMAC_SECRET: value })));
      expect(error.message).toContain('IDENTITY_TOKEN_HMAC_SECRET');
    },
  );

  it('a deployed environment with a secret under 32 bytes fails without echoing it', () => {
    const short = 'k'.repeat(31);
    const error = thrown(() => loadConfig(deployed({ IDENTITY_TOKEN_HMAC_SECRET: short })));
    expect(error.message).toContain('IDENTITY_TOKEN_HMAC_SECRET');
    expect(error.message).not.toContain(short);
  });

  it('the test configuration needs no secret', () => {
    const config = loadConfig(env({ NODE_ENV: 'test', IDENTITY_TOKEN_HMAC_SECRET: undefined }));
    expect(field(config, 'identityTokenHmacSecret')).toBeUndefined();
  });
});

/**
 * `043` task 6.9 (design D5, Resolved decisions Q15 and `002` Q39): a disabled or zero
 * invitation cap fails startup. Each cap is a max/window pair that follows the
 * `limitWithDefaults` positive-integer pattern: the defaults are enabled in code and the
 * environment only tunes them.
 *
 * Production symbols expected on `Config` (`apps/api/src/config.ts`):
 * - `invitationTenantCap: { max: number; windowSeconds: number }` (exists; 30 per hour),
 *   from `INVITATION_TENANT_RATE_LIMIT_MAX` and `INVITATION_TENANT_RATE_LIMIT_WINDOW_SECONDS`;
 * - `invitationRecipientCap: { max: number; windowSeconds: number }` (new; 3 per 24 hours),
 *   from `INVITATION_RECIPIENT_RATE_LIMIT_MAX` and
 *   `INVITATION_RECIPIENT_RATE_LIMIT_WINDOW_SECONDS`.
 * The global kill switch is a boolean, not a cap (6.8), and the notice cap is 6.12's case.
 */
describe('a disabled or zero invitation cap fails startup (043 task 6.9, Q15, 002 Q39)', () => {
  const CAPS = [
    {
      key: 'invitationTenantCap',
      max: 'INVITATION_TENANT_RATE_LIMIT_MAX',
      window: 'INVITATION_TENANT_RATE_LIMIT_WINDOW_SECONDS',
      defaults: { max: 30, windowSeconds: 3600 },
    },
    {
      key: 'invitationRecipientCap',
      max: 'INVITATION_RECIPIENT_RATE_LIMIT_MAX',
      window: 'INVITATION_RECIPIENT_RATE_LIMIT_WINDOW_SECONDS',
      defaults: { max: 3, windowSeconds: 86_400 },
    },
  ] as const;

  const read = (config: Config, key: string): unknown =>
    (config as unknown as Record<string, unknown>)[key];

  it.each(CAPS)('$key is enabled by default in code', ({ key, defaults }) => {
    expect(read(loadConfig(env()), key)).toEqual(defaults);
  });

  it.each(CAPS)('$key is only tuned by the environment', ({ key, max, window }) => {
    expect(read(loadConfig(env({ [max]: '7', [window]: '120' })), key)).toEqual({
      max: 7,
      windowSeconds: 120,
    });
  });

  it.each(
    CAPS.flatMap(({ max, window }) =>
      [max, window].flatMap((name) =>
        ['0', '-1', 'false', 'off', 'disabled', 'abc', '', '1.5'].map(
          (value) => [name, value] as const,
        ),
      ),
    ),
  )('%s=%j (disabled or zero) fails startup naming the variable', (name, value) => {
    const error = thrown(() => loadConfig(env({ [name]: value })));
    expect(error.message).toContain(name);
  });
});

/**
 * `043` task 6.12 (Resolved decision Q58): the per-tenant notice cap is a max/window pair
 * with its enabled default (60 per hour) in code; a zero or disabled value fails startup.
 *
 * Production symbols expected on `Config` (`apps/api/src/config.ts`):
 * - `noticeTenantCap: { max: number; windowSeconds: number }` (60 per hour), from
 *   `NOTICE_TENANT_RATE_LIMIT_MAX` and `NOTICE_TENANT_RATE_LIMIT_WINDOW_SECONDS`.
 */
describe('a zero notice cap fails startup (043 task 6.12, Q58, 002 Q39)', () => {
  const read = (config: Config): unknown =>
    (config as unknown as Record<string, unknown>)['noticeTenantCap'];

  it('noticeTenantCap is enabled by default in code', () => {
    expect(read(loadConfig(env()))).toEqual({ max: 60, windowSeconds: 3600 });
  });

  it('noticeTenantCap is only tuned by the environment', () => {
    expect(
      read(
        loadConfig(
          env({
            NOTICE_TENANT_RATE_LIMIT_MAX: '7',
            NOTICE_TENANT_RATE_LIMIT_WINDOW_SECONDS: '120',
          }),
        ),
      ),
    ).toEqual({ max: 7, windowSeconds: 120 });
  });

  it.each(
    ['NOTICE_TENANT_RATE_LIMIT_MAX', 'NOTICE_TENANT_RATE_LIMIT_WINDOW_SECONDS'].flatMap((name) =>
      ['0', '-1', 'false', 'off', 'disabled', 'abc', '', '1.5'].map(
        (value) => [name, value] as const,
      ),
    ),
  )('%s=%j (disabled or zero) fails startup naming the variable', (name, value) => {
    const error = thrown(() => loadConfig(env({ [name]: value })));
    expect(error.message).toContain(name);
  });
});

/**
 * `043` task 9.5 (Resolved decision Q44): the per-key rate limit of a machine credential is a
 * max/window pair with its enabled default (60 verifications per hour) in code; a zero or
 * disabled value fails startup.
 *
 * Production symbols expected on `Config` (`apps/api/src/config.ts`):
 * - `machineCredentialRateLimit: { max: number; windowSeconds: number }` (60 per 3600 s), from
 *   `MACHINE_CREDENTIAL_RATE_LIMIT_MAX` and `MACHINE_CREDENTIAL_RATE_LIMIT_WINDOW_SECONDS`,
 *   through `limitWithDefaults`.
 */
describe('a zero machine-credential rate limit fails startup (043 task 9.5, Q44, 002 Q39)', () => {
  const read = (config: Config): unknown =>
    (config as unknown as Record<string, unknown>)['machineCredentialRateLimit'];

  it('machineCredentialRateLimit is enabled by default in code: 60 per hour', () => {
    expect(read(loadConfig(env()))).toEqual({ max: 60, windowSeconds: 3600 });
  });

  it('machineCredentialRateLimit is only tuned by the environment', () => {
    expect(
      read(
        loadConfig(
          env({
            MACHINE_CREDENTIAL_RATE_LIMIT_MAX: '7',
            MACHINE_CREDENTIAL_RATE_LIMIT_WINDOW_SECONDS: '120',
          }),
        ),
      ),
    ).toEqual({ max: 7, windowSeconds: 120 });
  });

  it.each(
    ['MACHINE_CREDENTIAL_RATE_LIMIT_MAX', 'MACHINE_CREDENTIAL_RATE_LIMIT_WINDOW_SECONDS'].flatMap(
      (name) =>
        ['0', '-1', 'false', 'off', 'disabled', 'abc', '', '1.5'].map(
          (value) => [name, value] as const,
        ),
    ),
  )('%s=%j (disabled or zero) fails startup naming the variable', (name, value) => {
    const error = thrown(() => loadConfig(env({ [name]: value })));
    expect(error.message).toContain(name);
  });
});

/**
 * `043` task 9.5d (Resolved decision Q56): a tenant holds at most 200 non-revoked credentials,
 * a single cap parsed with `optionalPositiveInt`, its default in code; a zero or disabled value
 * fails startup.
 *
 * Production symbols expected on `Config` (`apps/api/src/config.ts`):
 * - `credentialCap: number` (200 by default), from `CREDENTIAL_CAP`.
 */
describe('a zero or disabled credential cap fails startup (043 task 9.5d, Q56, 002 Q39)', () => {
  const read = (config: Config): unknown =>
    (config as unknown as Record<string, unknown>)['credentialCap'];

  it('credentialCap is 200 by default in code', () => {
    expect(read(loadConfig(env()))).toBe(200);
  });

  it('credentialCap is only tuned by the environment', () => {
    expect(read(loadConfig(env({ CREDENTIAL_CAP: '25' })))).toBe(25);
  });

  it.each(['0', '-1', 'false', 'off', 'disabled', 'abc', '', '1.5'])(
    'CREDENTIAL_CAP=%j (disabled or zero) fails startup naming the variable',
    (value) => {
      const error = thrown(() => loadConfig(env({ CREDENTIAL_CAP: value })));
      expect(error.message).toContain('CREDENTIAL_CAP');
    },
  );
});

/**
 * `043` task 10.8 (Resolved decision Q56): a tenant holds at most 50 service accounts, a single
 * cap parsed with `optionalPositiveInt`, its default in code; a zero or disabled value fails
 * startup.
 *
 * Production symbols expected on `Config` (`apps/api/src/config.ts`):
 * - `serviceAccountCap: number` (50 by default), from `SERVICE_ACCOUNT_CAP`.
 */
describe('a zero or disabled service-account cap fails startup (043 task 10.8, Q56, 002 Q39)', () => {
  const read = (config: Config): unknown =>
    (config as unknown as Record<string, unknown>)['serviceAccountCap'];

  it('serviceAccountCap is 50 by default in code', () => {
    expect(read(loadConfig(env()))).toBe(50);
  });

  it('serviceAccountCap is only tuned by the environment', () => {
    expect(read(loadConfig(env({ SERVICE_ACCOUNT_CAP: '7' })))).toBe(7);
  });

  it.each(['0', '-1', 'false', 'off', 'disabled', 'abc', '', '1.5'])(
    'SERVICE_ACCOUNT_CAP=%j (disabled or zero) fails startup naming the variable',
    (value) => {
      const error = thrown(() => loadConfig(env({ SERVICE_ACCOUNT_CAP: value })));
      expect(error.message).toContain('SERVICE_ACCOUNT_CAP');
    },
  );
});

describe('MOUNT_IDENTITY_ROUTES parsing (task 14.3, design D15)', () => {
  it('is off when unset', () => {
    expect(loadConfig(env()).mountIdentityRoutes).toBe(false);
  });

  it('is on for the exact value true', () => {
    expect(loadConfig(env({ MOUNT_IDENTITY_ROUTES: 'true' })).mountIdentityRoutes).toBe(true);
  });

  it('is off for the exact value false', () => {
    expect(loadConfig(env({ MOUNT_IDENTITY_ROUTES: 'false' })).mountIdentityRoutes).toBe(false);
  });

  it.each(['1', 'yes', 'TRUE', 'True', 'on', '', '  '])(
    'MOUNT_IDENTITY_ROUTES=%j is malformed and fails startup naming the variable',
    (value) => {
      const error = thrown(() => loadConfig(env({ MOUNT_IDENTITY_ROUTES: value })));
      expect(error.message).toContain('MOUNT_IDENTITY_ROUTES');
    },
  );

  it('is wired through createAppFromEnv to the accept route: absent by default, registered when true', async () => {
    const local = {
      DATABASE_URL: 'postgres://tayzu_app:app-pw-s3cret@127.0.0.1:1/tayzu?sslmode=verify-full',
      AUTH_DATABASE_URL:
        'postgres://tayzu_auth:auth-pw-s3cret@127.0.0.1:1/tayzu?sslmode=verify-full',
      NODE_ENV: 'test',
    };
    const closed = await createAppFromEnv(env(local));
    const open = await createAppFromEnv(env({ ...local, MOUNT_IDENTITY_ROUTES: 'true' }));
    try {
      const accept = { method: 'POST', url: '/v1/auth/invitations/accept' } as const;
      expect(closed.app.hasRoute(accept)).toBe(false);
      expect(open.app.hasRoute(accept)).toBe(true);
    } finally {
      await closed.close();
      await open.close();
    }
  });
});

/**
 * `043` task 14.20 (Resolved decisions Q138 and Q140; `002` VCDM M13): the limiters of the
 * accept route and of the re-authorization callback take their defaults from `config.ts`,
 * each 10 per 60 seconds through `limitWithDefaults`.
 *
 * Production symbols expected on `Config` (`apps/api/src/config.ts`):
 * - `invitationAcceptRateLimit: { max: number; windowSeconds: number }`, from
 *   `INVITATION_ACCEPT_RATE_LIMIT_MAX` and `INVITATION_ACCEPT_RATE_LIMIT_WINDOW_SECONDS`;
 * - `reauthorizationCallbackRateLimit: { max: number; windowSeconds: number }`, from
 *   `REAUTHORIZATION_CALLBACK_RATE_LIMIT_MAX` and
 *   `REAUTHORIZATION_CALLBACK_RATE_LIMIT_WINDOW_SECONDS`.
 */
describe('accept and re-authorization callback limits (043 task 14.20, Q138, Q140)', () => {
  const LIMITS = [
    {
      key: 'invitationAcceptRateLimit',
      max: 'INVITATION_ACCEPT_RATE_LIMIT_MAX',
      window: 'INVITATION_ACCEPT_RATE_LIMIT_WINDOW_SECONDS',
    },
    {
      key: 'reauthorizationCallbackRateLimit',
      max: 'REAUTHORIZATION_CALLBACK_RATE_LIMIT_MAX',
      window: 'REAUTHORIZATION_CALLBACK_RATE_LIMIT_WINDOW_SECONDS',
    },
  ] as const;

  const read = (config: Config, key: string): unknown =>
    (config as unknown as Record<string, unknown>)[key];

  it.each(LIMITS)('$key defaults to 10 per 60 seconds', ({ key }) => {
    expect(read(loadConfig(env()), key)).toEqual({ max: 10, windowSeconds: 60 });
  });

  it.each(LIMITS)('$key is tuned by its two variables', ({ key, max, window }) => {
    expect(read(loadConfig(env({ [max]: '7', [window]: '120' })), key)).toEqual({
      max: 7,
      windowSeconds: 120,
    });
  });

  it.each(LIMITS)('$key tunes the maximum alone', ({ key, max }) => {
    expect(read(loadConfig(env({ [max]: '4' })), key)).toEqual({ max: 4, windowSeconds: 60 });
  });

  it.each(
    LIMITS.flatMap(({ max, window }) =>
      [max, window].flatMap((name) =>
        ['0', '-1', 'abc', '', '1.5', 'off'].map((value) => [name, value] as const),
      ),
    ),
  )('%s=%j (malformed) fails startup naming the variable', (name, value) => {
    const error = thrown(() => loadConfig(env({ [name]: value })));
    expect(error.message).toContain(name);
  });
});

/**
 * `044` task 4.2 (design D9, Q20, Q23, Q28): the reset limits, the recovery caps and the
 * minimum response time.
 *
 * Production symbols expected on `Config` (`apps/api/src/config.ts`), every limit shaped
 * `{ max: number; windowSeconds: number }`:
 * - `passwordResetRequestRateLimit` (`PASSWORD_RESET_REQUEST_RATE_LIMIT_MAX` / `_WINDOW_SECONDS`)
 * - `passwordResetConfirmRateLimit` (`PASSWORD_RESET_CONFIRM_RATE_LIMIT_*`)
 * - `passwordResetRecipientCap` (`PASSWORD_RESET_RECIPIENT_RATE_LIMIT_*`)
 * - `passwordResetIpCap` (`PASSWORD_RESET_IP_RATE_LIMIT_*`)
 * - `passwordResetGlobalCap` (`PASSWORD_RESET_GLOBAL_RATE_LIMIT_*`)
 * - `recoveryNoticeRecipientCap` (`RECOVERY_NOTICE_RECIPIENT_RATE_LIMIT_*`)
 * - `accountCreatedNoticeTenantCap` (`ACCOUNT_CREATED_NOTICE_TENANT_RATE_LIMIT_*`)
 * - `accountCreatedNoticeGlobalCap` (`ACCOUNT_CREATED_NOTICE_GLOBAL_RATE_LIMIT_*`)
 * - `passwordResetMinResponseMs: number` (`PASSWORD_RESET_MIN_RESPONSE_MS`)
 */
describe('reset limits, recovery caps and minimum response (044 task 4.2, D9)', () => {
  const LIMITS = [
    {
      key: 'passwordResetRequestRateLimit',
      prefix: 'PASSWORD_RESET_REQUEST',
      defaults: { max: 10, windowSeconds: 60 },
    },
    {
      key: 'passwordResetConfirmRateLimit',
      prefix: 'PASSWORD_RESET_CONFIRM',
      defaults: { max: 10, windowSeconds: 60 },
    },
    {
      key: 'passwordResetRecipientCap',
      prefix: 'PASSWORD_RESET_RECIPIENT',
      defaults: { max: 5, windowSeconds: 3600 },
    },
    {
      key: 'passwordResetIpCap',
      prefix: 'PASSWORD_RESET_IP',
      defaults: { max: 10, windowSeconds: 3600 },
    },
    {
      key: 'passwordResetGlobalCap',
      prefix: 'PASSWORD_RESET_GLOBAL',
      defaults: { max: 600, windowSeconds: 3600 },
    },
    {
      key: 'recoveryNoticeRecipientCap',
      prefix: 'RECOVERY_NOTICE_RECIPIENT',
      defaults: { max: 10, windowSeconds: 86_400 },
    },
    {
      key: 'accountCreatedNoticeTenantCap',
      prefix: 'ACCOUNT_CREATED_NOTICE_TENANT',
      defaults: { max: 20, windowSeconds: 86_400 },
    },
    {
      key: 'accountCreatedNoticeGlobalCap',
      prefix: 'ACCOUNT_CREATED_NOTICE_GLOBAL',
      defaults: { max: 1000, windowSeconds: 86_400 },
    },
  ] as const;

  const read = (config: Config, key: string): unknown =>
    (config as unknown as Record<string, unknown>)[key];

  describe('every default equals design D9', () => {
    it.each(LIMITS)('$key defaults to its D9 value', ({ key, defaults }) => {
      expect(read(loadConfig(env()), key)).toEqual(defaults);
    });

    it('PASSWORD_RESET_MIN_RESPONSE_MS defaults to 400', () => {
      expect(read(loadConfig(env()), 'passwordResetMinResponseMs')).toBe(400);
    });

    it.each(LIMITS)('$key is tuned by its two variables', ({ key, prefix }) => {
      const config = loadConfig(
        env({ [`${prefix}_RATE_LIMIT_MAX`]: '7', [`${prefix}_RATE_LIMIT_WINDOW_SECONDS`]: '120' }),
      );
      expect(read(config, key)).toEqual({ max: 7, windowSeconds: 120 });
    });
  });

  describe('a zero, negative or non-integer value fails startup', () => {
    it.each(
      LIMITS.flatMap(({ prefix }) =>
        ['MAX', 'WINDOW_SECONDS'].flatMap((suffix) =>
          ['0', '-1', 'abc', '', '1.5', 'off'].map(
            (value) => [`${prefix}_RATE_LIMIT_${suffix}`, value] as const,
          ),
        ),
      ),
    )('%s=%j fails startup naming the variable and not the value', (name, value) => {
      const error = thrown(() => loadConfig(env({ [name]: value })));
      expect(error.message).toContain(name);
      if (value !== '') {
        expect(error.message).not.toContain(value);
      }
    });
  });

  describe('PASSWORD_RESET_MIN_RESPONSE_MS outside 1..5000 fails startup', () => {
    it.each(['1', '400', '5000'])('%s is accepted', (value) => {
      const config = loadConfig(env({ PASSWORD_RESET_MIN_RESPONSE_MS: value }));
      expect(read(config, 'passwordResetMinResponseMs')).toBe(Number(value));
    });

    it.each(['0', '5001', '-1', '100000', 'abc', '', '1.5'])(
      '%j fails startup naming the variable',
      (value) => {
        const error = thrown(() => loadConfig(env({ PASSWORD_RESET_MIN_RESPONSE_MS: value })));
        expect(error.message).toContain('PASSWORD_RESET_MIN_RESPONSE_MS');
      },
    );
  });

  describe('scenario: A zero limit fails startup', () => {
    it('PASSWORD_RESET_REQUEST_RATE_LIMIT_MAX=0 fails startup', () => {
      const error = thrown(() => loadConfig(env({ PASSWORD_RESET_REQUEST_RATE_LIMIT_MAX: '0' })));
      expect(error.message).toContain('PASSWORD_RESET_REQUEST_RATE_LIMIT_MAX');
    });
  });
});

/**
 * Task 5.2 of `045-org-deletion-and-data-retention` (design D1 "Phase 1, request", Resolved
 * decision Q21): the deletion window is between 7 and 14 days, configurable, validated at
 * startup, 14 by default. The design names no variable; this test expects
 * `ORG_DELETION_WINDOW_DAYS` read into `orgDeletionWindowDays: number`.
 */
describe('the org-deletion window (045 task 5.2, D1, Q21)', () => {
  const read = (config: Config): unknown =>
    (config as unknown as Record<string, unknown>)['orgDeletionWindowDays'];

  it('defaults to 14 days', () => {
    expect(read(loadConfig(env()))).toBe(14);
  });

  it.each(['7', '10', '14'])('%s days is accepted', (value) => {
    expect(read(loadConfig(env({ ORG_DELETION_WINDOW_DAYS: value })))).toBe(Number(value));
  });

  it.each(['6', '15', '0', '-7', '1.5', 'abc', ''])(
    'ORG_DELETION_WINDOW_DAYS=%j fails startup naming the variable',
    (value) => {
      const error = thrown(() => loadConfig(env({ ORG_DELETION_WINDOW_DAYS: value })));
      expect(error.message).toContain('ORG_DELETION_WINDOW_DAYS');
    },
  );
});

/**
 * Task 4.1 of `003-catalog-ui-core` (design D9 "Setting", Resolved decision Q21): the
 * optional `WEB_DIST_DIR` is the absolute path of the Vite build. Unset, the API runs
 * alone. Set, startup fails unless it is an absolute path to a readable directory
 * containing `index.html`, and the error names the variable, never its value.
 *
 * Production symbol expected on `Config` (`apps/api/src/config.ts`), following the
 * optional-field convention of `betterAuthUrl` and `sso` (absent, not `undefined`, when
 * unset): `readonly webDistDir?: string`, read synchronously by `loadConfig`.
 *
 * Every rejected path carries the marker `web-dist-marker-q21`, so a message that echoes
 * the value, or any part of it, is caught.
 */
describe('WEB_DIST_DIR (003 task 4.1, D9, Q21)', () => {
  const MARKER = 'web-dist-marker-q21';
  const read = (config: Config): unknown =>
    (config as unknown as Record<string, unknown>)['webDistDir'];

  let scratch: string;
  let validBuild: string;
  let buildWithoutIndex: string;
  let buildWithIndexDirectory: string;
  let plainFile: string;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), `${MARKER}-`));
    validBuild = join(scratch, `${MARKER}-valid`);
    mkdirSync(validBuild);
    writeFileSync(join(validBuild, 'index.html'), '<!doctype html><title>t</title>');
    buildWithoutIndex = join(scratch, `${MARKER}-no-index`);
    mkdirSync(buildWithoutIndex);
    writeFileSync(join(buildWithoutIndex, 'theme-init.js'), '');
    buildWithIndexDirectory = join(scratch, `${MARKER}-index-is-a-directory`);
    mkdirSync(join(buildWithIndexDirectory, 'index.html'), { recursive: true });
    plainFile = join(scratch, `${MARKER}-a-file`);
    writeFileSync(plainFile, '<!doctype html>');
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  /** The startup error names `WEB_DIST_DIR` and holds neither the value nor its marker. */
  function expectRejected(value: string): void {
    const error = thrown(() => loadConfig(env({ WEB_DIST_DIR: value })));
    expect(error.message).toContain('WEB_DIST_DIR');
    expect(error.message).not.toContain(value);
    expect(error.message).not.toContain(MARKER);
  }

  it('unset: the config has no webDistDir', () => {
    const config = loadConfig(env());
    expect(Object.hasOwn(config, 'webDistDir')).toBe(false);
    expect(read(config)).toBeUndefined();
  });

  it('an absolute path to a readable directory containing index.html is accepted as is', () => {
    expect(read(loadConfig(env({ WEB_DIST_DIR: validBuild })))).toBe(validBuild);
  });

  it.each([`${MARKER}/dist`, `./${MARKER}/dist`, `../${MARKER}`])(
    'a relative path (%j) fails startup naming the variable, not the value',
    (value) => {
      expectRejected(value);
    },
  );

  it('an empty value is set and not absolute, so it fails startup naming the variable', () => {
    const error = thrown(() => loadConfig(env({ WEB_DIST_DIR: '' })));
    expect(error.message).toContain('WEB_DIST_DIR');
  });

  it('a directory that does not exist fails startup naming the variable, not the value', () => {
    expectRejected(join(scratch, `${MARKER}-missing`, 'dist'));
  });

  it('a directory without index.html fails startup naming the variable, not the value', () => {
    expectRejected(buildWithoutIndex);
  });

  it('a directory whose index.html is not a file fails startup naming the variable, not the value', () => {
    expectRejected(buildWithIndexDirectory);
  });

  it('a path to a file instead of a directory fails startup naming the variable, not the value', () => {
    expectRejected(plainFile);
  });
});

/**
 * `048` task 3.1 (design D2, Resolved decision Q6), scenario "Startup fails without the
 * proxy trust outside the test environment":
 *
 * - **WHEN** the platform starts with `NODE_ENV` other than `test` and without the hop
 *   count or the ranges, or with a malformed range
 * - **THEN** startup fails with a message that names only the variable
 *
 * Design D2: `TRUST_PROXY_HOPS` is an integer from 1 to 5; `TRUST_PROXY_CIDRS` is a
 * comma-separated list of IPv4 or IPv6 CIDR blocks, a bare address accepted as a `/32` or
 * `/128`. Outside `NODE_ENV=test` both are required; under test, both unset keeps the list
 * `['loopback', 'linklocal', 'uniquelocal']`, both set is honoured, and one set without the
 * other fails in every environment.
 *
 * ## Production symbol expected
 *
 * ```ts
 * // apps/api/src/config.ts
 * interface Config {
 *   // `{ hops, cidrs }` when both variables are set (the input of `createTrustProxy`,
 *   // design D2); the default list only under test when both are unset.
 *   readonly trustProxy:
 *     | { readonly hops: number; readonly cidrs: readonly string[] }
 *     | readonly ['loopback', 'linklocal', 'uniquelocal'];
 * }
 * ```
 *
 * A bare address may be kept as written or completed with `/32` or `/128`: the tests
 * compare the blocks after completing a bare address the same way.
 */
describe('TRUST_PROXY_HOPS and TRUST_PROXY_CIDRS (048 task 3.1, design D2, Q6)', () => {
  const HOPS = 'TRUST_PROXY_HOPS';
  const CIDRS = 'TRUST_PROXY_CIDRS';
  const EVERY_ENVIRONMENT = ['test', 'production'] as const;
  const OUTSIDE_TEST = ['production', 'staging', 'development'] as const;

  const proxy = (
    nodeEnv: string,
    overrides: Record<string, string | undefined> = {},
  ): Record<string, string | undefined> =>
    env({
      NODE_ENV: nodeEnv,
      EMAIL_PROVIDER: 'none',
      BETTER_AUTH_URL: 'https://app.tayzu.test',
      ALLOWED_ORIGINS: 'https://app.tayzu.test',
      ...overrides,
    });
  const trustOf = (config: Config): unknown =>
    (config as unknown as Record<string, unknown>)['trustProxy'];
  /** A block as `address/prefix`: a bare address completed as a `/32` or `/128`. */
  const block = (entry: string): string =>
    entry.includes('/') ? entry : `${entry}/${isIPv6(entry) ? '128' : '32'}`;
  function expectTrust(config: Config, hops: number, cidrs: readonly string[]): void {
    const trust = trustOf(config) as { hops?: unknown; cidrs?: unknown } | undefined;
    expect(trust, 'config.trustProxy is { hops, cidrs }').toBeTypeOf('object');
    expect(Object.keys(trust ?? {}).sort()).toEqual(['cidrs', 'hops']);
    expect(trust?.hops).toBe(hops);
    expect(Array.isArray(trust?.cidrs)).toBe(true);
    expect((trust?.cidrs as string[]).map(block)).toEqual(cidrs.map(block));
  }

  describe('hops from 1 to 5 are accepted in every environment', () => {
    it.each(
      EVERY_ENVIRONMENT.flatMap((nodeEnv) =>
        ['1', '2', '3', '4', '5'].map((hops) => [hops, nodeEnv] as const),
      ),
    )('TRUST_PROXY_HOPS=%s (NODE_ENV=%s)', (hops, nodeEnv) => {
      const config = loadConfig(proxy(nodeEnv, { [HOPS]: hops, [CIDRS]: '10.0.0.0/16' }));
      expectTrust(config, Number(hops), ['10.0.0.0/16']);
    });
  });

  describe('IPv4 and IPv6 blocks and bare addresses are accepted in every environment', () => {
    const accepted: readonly (readonly [string, string, readonly string[]])[] = [
      ['one IPv4 block', '10.0.0.0/16', ['10.0.0.0/16']],
      [
        'several IPv4 blocks',
        '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16',
        ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
      ],
      ['one IPv6 block', 'fd00::/8', ['fd00::/8']],
      [
        'IPv6 and IPv4 blocks together',
        '2001:db8::/32,10.0.0.0/16',
        ['2001:db8::/32', '10.0.0.0/16'],
      ],
      ['a bare IPv4 address', '10.0.4.2', ['10.0.4.2']],
      ['a bare IPv6 address', '::1', ['::1']],
      ['a bare address next to a block', '10.0.4.2,fd00::/8', ['10.0.4.2', 'fd00::/8']],
      ['the CI loopback list', '127.0.0.1/32,::1/128', ['127.0.0.1/32', '::1/128']],
    ];

    it.each(
      EVERY_ENVIRONMENT.flatMap((nodeEnv) =>
        accepted.map(([label, value, cidrs]) => [label, nodeEnv, value, cidrs] as const),
      ),
    )('%s (NODE_ENV=%s)', (_label, nodeEnv, value, cidrs) => {
      const config = loadConfig(proxy(nodeEnv, { [HOPS]: '1', [CIDRS]: value }));
      expectTrust(config, 1, cidrs);
    });
  });

  describe('zero, six, fractional and other malformed hops are refused in every environment', () => {
    it.each(
      EVERY_ENVIRONMENT.flatMap((nodeEnv) =>
        ['0', '6', '1.5', '2.5', '-1', '10', 'abc', 'one', '', '   '].map(
          (hops) => [hops, nodeEnv] as const,
        ),
      ),
    )('TRUST_PROXY_HOPS=%j fails startup naming the variable (NODE_ENV=%s)', (hops, nodeEnv) => {
      const error = thrown(() =>
        loadConfig(proxy(nodeEnv, { [HOPS]: hops, [CIDRS]: '10.0.0.0/16' })),
      );
      expect(error.message).toContain(HOPS);
      expect(error.message).not.toContain(CIDRS);
    });
  });

  describe('a malformed block is refused in every environment', () => {
    const malformed: readonly (readonly [string, string])[] = [
      ['an IPv4 prefix over 32', '10.0.0.0/33'],
      ['an IPv6 prefix over 128', '::1/129'],
      ['a negative prefix', '10.0.0.0/-1'],
      ['a non-numeric prefix', 'fe80::/abc'],
      ['an empty prefix', '10.0.0.0/'],
      ['two prefixes', '10.0.0.0/8/8'],
      ['an octet over 255', '10.0.0.256/8'],
      ['a three-octet address', '10.0.0/8'],
      ['a word', 'not-a-cidr'],
      ['a host name', 'localhost'],
      ['a malformed block after a valid one', '10.0.0.0/16,bogus'],
      ['an empty value', ''],
      ['a blank value', '   '],
      ['only separators', ' , '],
    ];

    it.each(
      EVERY_ENVIRONMENT.flatMap((nodeEnv) =>
        malformed.map(([label, value]) => [label, nodeEnv, value] as const),
      ),
    )('%s fails startup naming the variable (NODE_ENV=%s)', (_label, nodeEnv, value) => {
      const error = thrown(() => loadConfig(proxy(nodeEnv, { [HOPS]: '1', [CIDRS]: value })));
      expect(error.message).toContain(CIDRS);
      expect(error.message).not.toContain(HOPS);
    });
  });

  describe('one variable without the other is refused in every environment', () => {
    it.each(EVERY_ENVIRONMENT)(
      'TRUST_PROXY_HOPS without TRUST_PROXY_CIDRS fails naming TRUST_PROXY_CIDRS (NODE_ENV=%s)',
      (nodeEnv) => {
        const error = thrown(() => loadConfig(proxy(nodeEnv, { [HOPS]: '1', [CIDRS]: undefined })));
        expect(error.message).toContain(CIDRS);
      },
    );

    it.each(EVERY_ENVIRONMENT)(
      'TRUST_PROXY_CIDRS without TRUST_PROXY_HOPS fails naming TRUST_PROXY_HOPS (NODE_ENV=%s)',
      (nodeEnv) => {
        const error = thrown(() =>
          loadConfig(proxy(nodeEnv, { [HOPS]: undefined, [CIDRS]: '10.0.0.0/16' })),
        );
        expect(error.message).toContain(HOPS);
      },
    );
  });

  describe('scenario: Startup fails without the proxy trust outside the test environment', () => {
    it.each(OUTSIDE_TEST)(
      'both variables unset fail startup naming the variable (NODE_ENV=%s)',
      (nodeEnv) => {
        const error = thrown(() =>
          loadConfig(proxy(nodeEnv, { [HOPS]: undefined, [CIDRS]: undefined })),
        );
        expect(error.message).toMatch(/TRUST_PROXY_(HOPS|CIDRS)/);
      },
    );

    it.each(OUTSIDE_TEST)(
      'the hop count missing fails startup naming the variable (NODE_ENV=%s)',
      (nodeEnv) => {
        const error = thrown(() =>
          loadConfig(proxy(nodeEnv, { [HOPS]: undefined, [CIDRS]: '10.0.0.0/16' })),
        );
        expect(error.message).toContain(HOPS);
      },
    );

    it.each(OUTSIDE_TEST)(
      'the ranges missing fail startup naming the variable (NODE_ENV=%s)',
      (nodeEnv) => {
        const error = thrown(() => loadConfig(proxy(nodeEnv, { [HOPS]: '1', [CIDRS]: undefined })));
        expect(error.message).toContain(CIDRS);
      },
    );

    it.each(OUTSIDE_TEST)(
      'a malformed range fails startup naming the variable (NODE_ENV=%s)',
      (nodeEnv) => {
        const error = thrown(() =>
          loadConfig(proxy(nodeEnv, { [HOPS]: '1', [CIDRS]: '10.0.0.0/33' })),
        );
        expect(error.message).toContain(CIDRS);
      },
    );

    it('a valid production configuration starts with the configured trust', () => {
      const config = loadConfig(
        proxy('production', { [HOPS]: '2', [CIDRS]: '10.0.0.0/16,fd00::/8' }),
      );
      expectTrust(config, 2, ['10.0.0.0/16', 'fd00::/8']);
    });
  });

  describe('under NODE_ENV=test', () => {
    it('both unset default to the loopback, link-local and unique-local list', () => {
      const config = loadConfig(proxy('test', { [HOPS]: undefined, [CIDRS]: undefined }));
      expect(trustOf(config)).toEqual(['loopback', 'linklocal', 'uniquelocal']);
    });

    it('both set are honoured', () => {
      const config = loadConfig(
        proxy('test', { [HOPS]: '3', [CIDRS]: '10.0.0.0/16,2001:db8::/32' }),
      );
      expectTrust(config, 3, ['10.0.0.0/16', '2001:db8::/32']);
    });
  });

  describe('an error names only the variable, never a value', () => {
    const MARKER_RANGE = '198.51.100.77';
    const rejected: readonly (readonly [
      string,
      string,
      Record<string, string | undefined>,
      string,
    ])[] = [
      ['a fractional hop count', 'production', { [HOPS]: '4.75', [CIDRS]: '10.0.0.0/16' }, '4.75'],
      ['a large hop count', 'production', { [HOPS]: '777', [CIDRS]: '10.0.0.0/16' }, '777'],
      [
        'a word as hop count',
        'test',
        { [HOPS]: 'markerhops', [CIDRS]: '10.0.0.0/16' },
        'markerhops',
      ],
      [
        'an out-of-range prefix',
        'production',
        { [HOPS]: '1', [CIDRS]: `${MARKER_RANGE}/33` },
        MARKER_RANGE,
      ],
      ['a host name', 'test', { [HOPS]: '1', [CIDRS]: 'marker-host.invalid' }, 'marker-host'],
      [
        'a malformed block after a valid one',
        'production',
        { [HOPS]: '1', [CIDRS]: `${MARKER_RANGE}/24,marker-block` },
        'marker-block',
      ],
      [
        'the ranges alone',
        'test',
        { [HOPS]: undefined, [CIDRS]: `${MARKER_RANGE}/24` },
        MARKER_RANGE,
      ],
    ];

    it.each(rejected)('%s (NODE_ENV=%s)', (_label, nodeEnv, overrides, value) => {
      const error = thrown(() => loadConfig(proxy(nodeEnv, overrides)));
      expect(error.message).toMatch(/TRUST_PROXY_(HOPS|CIDRS)/);
      expect(error.message).not.toContain(value);
      expect(error.message).not.toContain(MARKER_RANGE);
      expect(error.message).not.toContain('10.0.0.0');
    });
  });
});

/**
 * `048` task 3.4 (design D3, Q18; auth-and-rbac scenario "An authentication base URL
 * outside the allowed origins is refused"): `loadConfig` compares
 * `new URL(BETTER_AUTH_URL).origin` with the parsed `ALLOWED_ORIGINS` whenever
 * `BETTER_AUTH_URL` is set, in every environment, test included, and throws an `Error`
 * naming both variables and no value (D3:
 * `'BETTER_AUTH_URL is malformed (its origin must be one of ALLOWED_ORIGINS).'`).
 *
 * ## Production symbols expected
 *
 * No new export: the check lives in `loadConfig` (`apps/api/src/config.ts`), and
 * `Config.betterAuthUrl` keeps the configured value.
 *
 * ## Why this fails right now
 *
 * `loadConfig` checks only the scheme of `BETTER_AUTH_URL`, so an unlisted origin starts
 * (assertion failure: "expected the call to throw").
 */
describe('BETTER_AUTH_URL origin is one of ALLOWED_ORIGINS (048 task 3.4, design D3, Q18)', () => {
  const NAME = 'BETTER_AUTH_URL';
  const ORIGINS = 'ALLOWED_ORIGINS';
  const LISTED = 'https://app.tayzu.test';
  const EVERY_ENVIRONMENT = ['test', 'production'] as const;
  const OUTSIDE_TEST = ['production', 'staging', 'development'] as const;

  const publicOrigin = (
    nodeEnv: string,
    betterAuthUrl: string | undefined,
    allowedOrigins: string = LISTED,
  ): Record<string, string | undefined> => {
    // The link base URLs stay on the first listed origin, so only BETTER_AUTH_URL is at fault.
    const linkBase = allowedOrigins.split(',')[0]?.trim() ?? LISTED;
    return env({
      NODE_ENV: nodeEnv,
      EMAIL_PROVIDER: 'none',
      BETTER_AUTH_URL: betterAuthUrl,
      ALLOWED_ORIGINS: allowedOrigins,
      INVITATION_LINK_BASE_URL: linkBase,
      PASSWORD_RESET_LINK_BASE_URL: linkBase,
    });
  };

  function expectRefused(env: Record<string, string | undefined>): Error {
    const error = thrown(() => loadConfig(env));
    expect(error.message).toContain(NAME);
    expect(error.message).toContain(ORIGINS);
    return error;
  }

  describe('scenario: An authentication base URL outside the allowed origins is refused', () => {
    const otherHost: readonly (readonly [string, string, string])[] = [
      ['another host', 'https://api.tayzu.test', LISTED],
      ['a subdomain of a listed host', 'https://auth.app.tayzu.test', LISTED],
      ['a listed host as a prefix of another host', 'https://app.tayzu.test.evil.invalid', LISTED],
      [
        'a host absent from a list of several',
        'https://api.tayzu.test',
        `${LISTED},https://admin.tayzu.test`,
      ],
    ];

    describe('a different host is refused in every environment', () => {
      it.each(
        EVERY_ENVIRONMENT.flatMap((nodeEnv) =>
          otherHost.map(([label, url, origins]) => [label, nodeEnv, url, origins] as const),
        ),
      )('%s (NODE_ENV=%s)', (_label, nodeEnv, url, origins) => {
        expectRefused(publicOrigin(nodeEnv, url, origins));
      });
    });

    const otherPort: readonly (readonly [string, string, string])[] = [
      ['a port on a listed origin without one', 'https://app.tayzu.test:8443', LISTED],
      ['no port on a listed origin with one', LISTED, `${LISTED}:8443,https://other.tayzu.test`],
      [
        'another port than the listed one',
        'https://app.tayzu.test:9443',
        `${LISTED}:8443,${LISTED}`,
      ],
    ];

    describe('a different port is refused in every environment', () => {
      it.each(
        EVERY_ENVIRONMENT.flatMap((nodeEnv) =>
          otherPort.map(([label, url, origins]) => [label, nodeEnv, url, origins] as const),
        ),
      )('%s (NODE_ENV=%s)', (_label, nodeEnv, url, origins) => {
        expectRefused(publicOrigin(nodeEnv, url, origins));
      });
    });

    describe('a different scheme is refused in every environment', () => {
      // Under test both schemes are accepted on their own, so only the origin check refuses.
      it('http BETTER_AUTH_URL with only the https origin listed (NODE_ENV=test)', () => {
        expectRefused(publicOrigin('test', 'http://app.tayzu.test', LISTED));
      });

      it('https BETTER_AUTH_URL with only the http origin listed (NODE_ENV=test)', () => {
        expectRefused(publicOrigin('test', LISTED, 'http://app.tayzu.test'));
      });

      // Outside test an http BETTER_AUTH_URL is already refused by the https rule (Q40).
      it.each(OUTSIDE_TEST)(
        'http BETTER_AUTH_URL with the https origin listed fails startup naming the variable (NODE_ENV=%s)',
        (nodeEnv) => {
          const error = thrown(() =>
            loadConfig(publicOrigin(nodeEnv, 'http://app.tayzu.test', LISTED)),
          );
          expect(error.message).toContain(NAME);
          expect(error.message).not.toContain('app.tayzu.test');
        },
      );
    });

    it.each(OUTSIDE_TEST)(
      'an unlisted origin fails startup in every deployed environment (NODE_ENV=%s)',
      (nodeEnv) => {
        expectRefused(publicOrigin(nodeEnv, 'https://api.tayzu.test', LISTED));
      },
    );
  });

  describe('a URL on an allowed origin is accepted', () => {
    const accepted: readonly (readonly [string, string, string])[] = [
      ['the bare origin', LISTED, LISTED],
      ['the origin with a trailing slash', `${LISTED}/`, LISTED],
      ['a path on the origin', `${LISTED}/api/auth`, LISTED],
      ['a nested path with a trailing slash', `${LISTED}/tayzu/api/`, LISTED],
      ['the explicit default port', 'https://app.tayzu.test:443/api', LISTED],
      ['a listed port', `${LISTED}:8443/api/auth`, `${LISTED}:8443`],
      [
        'the second listed origin',
        'https://api.tayzu.test/api/auth',
        `${LISTED}, https://api.tayzu.test`,
      ],
    ];

    it.each(
      EVERY_ENVIRONMENT.flatMap((nodeEnv) =>
        accepted.map(([label, url, origins]) => [label, nodeEnv, url, origins] as const),
      ),
    )('%s (NODE_ENV=%s)', (_label, nodeEnv, url, origins) => {
      const config = loadConfig(publicOrigin(nodeEnv, url, origins));
      expect(config.betterAuthUrl).toBe(url);
    });

    it('an http URL on an http origin is accepted under test', () => {
      const url = 'http://localhost:3000/api/auth';
      const config = loadConfig(publicOrigin('test', url, 'http://localhost:3000'));
      expect(config.betterAuthUrl).toBe(url);
    });

    it('an unset BETTER_AUTH_URL under test is not checked', () => {
      const config = loadConfig(publicOrigin('test', undefined, LISTED));
      expect(config.betterAuthUrl).toBeUndefined();
    });
  });

  describe('the error names both variables and no value', () => {
    const MARKER_URL = 'https://marker-auth.tayzu.invalid:8443/marker-path';
    const MARKER_ORIGIN = 'https://marker-allowed.tayzu.test';

    it.each(EVERY_ENVIRONMENT)('NODE_ENV=%s', (nodeEnv) => {
      const error = expectRefused(publicOrigin(nodeEnv, MARKER_URL, `${LISTED},${MARKER_ORIGIN}`));
      expect(error.message).not.toContain(MARKER_URL);
      expect(error.message).not.toContain('marker-auth');
      expect(error.message).not.toContain('8443');
      expect(error.message).not.toContain('marker-path');
      expect(error.message).not.toContain(MARKER_ORIGIN);
      expect(error.message).not.toContain('marker-allowed');
      expect(error.message).not.toContain('app.tayzu.test');
    });
  });
});
