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
    IDENTITY_TOKEN_HMAC_SECRET: HMAC_SECRET,
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
      BETTER_AUTH_URL: 'https://api.tayzu.test',
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
      BETTER_AUTH_URL: 'https://api.tayzu.test',
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
  const CONNECTION_STRING =
    'endpoint=https://acs-test.communication.azure.com/;accesskey=c2VjcmV0LWtleQ==';
  const mail = (
    nodeEnv: string,
    overrides: Record<string, string | undefined> = {},
  ): Record<string, string | undefined> =>
    env({
      NODE_ENV: nodeEnv,
      BETTER_AUTH_URL: 'https://api.tayzu.test',
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
      expect(error.message).not.toContain('c2VjcmV0LWtleQ==');
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
      BETTER_AUTH_URL: 'https://api.tayzu.test',
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
      BETTER_AUTH_URL: 'https://api.tayzu.test',
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
