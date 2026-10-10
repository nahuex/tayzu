/**
 * Startup configuration (task 14.1, design D15). Everything comes from the
 * environment (Key Vault references resolved by Azure Container Apps into env
 * vars; `.env` locally). A missing or malformed value throws an error that
 * names the variable and never contains a value.
 */
type Env = Readonly<Record<string, string | undefined>>;

export interface Config {
  readonly appDatabaseUrl: string;
  readonly authDatabaseUrl: string;
  readonly betterAuthSecret: string;
  readonly cerbosAddress: string;
  readonly allowedOrigins: readonly string[];
  /** Public base URL of the API (Q40): `https` outside test; undefined only in test. */
  readonly betterAuthUrl?: string;
  /** Origin of invitation links (Q32): `https` and in `allowedOrigins` outside test; undefined only in test. */
  readonly invitationLinkBaseUrl?: string;
  /** Visma Connect SSO (D23); undefined when none of its variables is set. */
  readonly sso?: {
    readonly discoveryUrl: string;
    readonly clientId: string;
    readonly clientSecret: string;
  };
  /** Pre-auth sign-in limit (D20); window in seconds. Enabled by default (Q39). */
  readonly preAuthSignInRateLimit: { readonly max: number; readonly window: number };
  /** Pre-auth password-check limit (Q52); window in seconds. Enabled by default (Q39). */
  readonly preAuthPasswordCheckRateLimit: { readonly max: number; readonly window: number };
  /** Per-principal `/v1/*` limit (D13). */
  readonly rateLimit: RateLimit;
  /** `POST /v1/auth/token` limit (D20). */
  readonly tokenExchangeRateLimit: RateLimit;
  /** Maximum request body in bytes (D13). */
  readonly bodyLimit: number;
  /** Back-channel logout budget per source IP per minute (D26, Q32). */
  readonly backchannelLogoutRateLimitPerMinute: number;
  /** Explicit opt-out of telemetry (Q41); only the exact `true` enables it. */
  readonly telemetryDisabled: boolean;
}

interface RateLimit {
  readonly max: number;
  readonly timeWindowMs: number;
}

const DEFAULT_BACKCHANNEL_LOGOUT_RATE_LIMIT_PER_MINUTE = 600;

// Enabled defaults (Q39); the environment only tunes them.
const DEFAULT_SIGN_IN_LIMIT = { max: 10, windowSeconds: 60 };
const DEFAULT_PASSWORD_CHECK_LIMIT = { max: 10, windowSeconds: 60 };
const DEFAULT_PER_PRINCIPAL_LIMIT = { max: 600, windowSeconds: 60 };
const DEFAULT_TOKEN_EXCHANGE_LIMIT = { max: 30, windowSeconds: 60 };
const DEFAULT_BODY_LIMIT_BYTES = 1_048_576;

const MIN_SECRET_LENGTH = 32;

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is required.`);
  }
  return value;
}

/** A variable that, when set (even empty), must be a positive integer. */
function optionalPositiveInt(env: Env, name: string): number | undefined {
  const value = env[name];
  if (value === undefined) {
    return undefined;
  }
  if (!/^[1-9]\d*$/.test(value.trim())) {
    throw new Error(`${name} is malformed (a positive integer is required).`);
  }
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} is malformed (a positive integer is required).`);
  }
  return parsed;
}

/** A max/window pair; each variable only tunes its enabled default (Q39). */
function limitWithDefaults(
  env: Env,
  maxName: string,
  windowName: string,
  defaults: { max: number; windowSeconds: number },
): { max: number; windowSeconds: number } {
  return {
    max: optionalPositiveInt(env, maxName) ?? defaults.max,
    windowSeconds: optionalPositiveInt(env, windowName) ?? defaults.windowSeconds,
  };
}

const SSO_VARIABLES = [
  'VISMA_CONNECT_DISCOVERY_URL',
  'VISMA_CONNECT_CLIENT_ID',
  'VISMA_CONNECT_CLIENT_SECRET',
] as const;

/** `VISMA_CONNECT_DISCOVERY_URL` (Q48, D23): `https` outside test; the value is never echoed. */
function loadDiscoveryUrl(env: Env): string {
  const isTest = (env['NODE_ENV'] ?? process.env['NODE_ENV']) === 'test';
  const value = required(env, 'VISMA_CONNECT_DISCOVERY_URL');
  let protocol: string;
  try {
    protocol = new URL(value.trim()).protocol;
  } catch {
    throw new Error('VISMA_CONNECT_DISCOVERY_URL is malformed (an absolute URL is required).');
  }
  if (protocol !== 'https:' && !(isTest && protocol === 'http:')) {
    throw new Error('VISMA_CONNECT_DISCOVERY_URL is malformed (https is required).');
  }
  return value;
}

function loadSso(env: Env): Config['sso'] {
  const present = SSO_VARIABLES.filter((name) => env[name] !== undefined);
  if (present.length === 0) {
    return undefined;
  }
  return {
    discoveryUrl: loadDiscoveryUrl(env),
    clientId: required(env, SSO_VARIABLES[1]),
    clientSecret: required(env, SSO_VARIABLES[2]),
  };
}

/** `BETTER_AUTH_URL` (Q40): required outside test, and then it must be `https`. */
function loadBetterAuthUrl(env: Env): string | undefined {
  const isTest = (env['NODE_ENV'] ?? process.env['NODE_ENV']) === 'test';
  if (isTest && env['BETTER_AUTH_URL'] === undefined) {
    return undefined;
  }
  const value = required(env, 'BETTER_AUTH_URL').trim();
  let protocol: string;
  try {
    protocol = new URL(value).protocol;
  } catch {
    throw new Error('BETTER_AUTH_URL is malformed (an absolute URL is required).');
  }
  if (protocol !== 'https:' && !(isTest && protocol === 'http:')) {
    throw new Error('BETTER_AUTH_URL is malformed (https is required).');
  }
  return value;
}

/** `INVITATION_LINK_BASE_URL` (Q32): outside test it is required, `https` and one of `ALLOWED_ORIGINS`. */
function loadInvitationLinkBaseUrl(
  env: Env,
  allowedOrigins: readonly string[],
): string | undefined {
  const isTest = (env['NODE_ENV'] ?? process.env['NODE_ENV']) === 'test';
  if (isTest && env['INVITATION_LINK_BASE_URL'] === undefined) {
    return undefined;
  }
  const value = required(env, 'INVITATION_LINK_BASE_URL').trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('INVITATION_LINK_BASE_URL is malformed (an absolute URL is required).');
  }
  if (isTest) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('INVITATION_LINK_BASE_URL is malformed (https is required).');
    }
    return value;
  }
  if (url.protocol !== 'https:') {
    throw new Error('INVITATION_LINK_BASE_URL is malformed (https is required).');
  }
  if (!allowedOrigins.includes(url.origin)) {
    throw new Error('INVITATION_LINK_BASE_URL is malformed (it must be one of ALLOWED_ORIGINS).');
  }
  return value;
}

/** `ALLOWED_ORIGINS` (Q56, Q40): `https` and wildcard-free outside test; origins are never echoed. */
function validateAllowedOrigins(env: Env, origins: readonly string[]): void {
  const isTest = (env['NODE_ENV'] ?? process.env['NODE_ENV']) === 'test';
  if (isTest) {
    return;
  }
  for (const origin of origins) {
    let protocol: string | undefined;
    try {
      protocol = origin.includes('*') ? undefined : new URL(origin).protocol;
    } catch {
      protocol = undefined;
    }
    if (protocol !== 'https:') {
      throw new Error('ALLOWED_ORIGINS is malformed (https origins without wildcards only).');
    }
  }
}

/** `TAYZU_TELEMETRY_DISABLED`: unset or `false` is off, `true` is on, anything else fails. */
function loadTelemetryDisabled(env: Env): boolean {
  const value = env['TAYZU_TELEMETRY_DISABLED'];
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error('TAYZU_TELEMETRY_DISABLED is malformed (true or false is required).');
}

export function loadConfig(env: Env): Config {
  const appDatabaseUrl = required(env, 'DATABASE_URL');
  const authDatabaseUrl = required(env, 'AUTH_DATABASE_URL');
  const betterAuthSecret = required(env, 'BETTER_AUTH_SECRET');
  if (betterAuthSecret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `BETTER_AUTH_SECRET is malformed (at least ${String(MIN_SECRET_LENGTH)} characters).`,
    );
  }
  const cerbosAddress = required(env, 'CERBOS_ADDRESS');
  const allowedOrigins = required(env, 'ALLOWED_ORIGINS')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');
  validateAllowedOrigins(env, allowedOrigins);
  const betterAuthUrl = loadBetterAuthUrl(env);
  const invitationLinkBaseUrl = loadInvitationLinkBaseUrl(env, allowedOrigins);
  const sso = loadSso(env);
  const signIn = limitWithDefaults(
    env,
    'PRE_AUTH_SIGN_IN_RATE_LIMIT_MAX',
    'PRE_AUTH_SIGN_IN_RATE_LIMIT_WINDOW_SECONDS',
    DEFAULT_SIGN_IN_LIMIT,
  );
  const passwordCheck = limitWithDefaults(
    env,
    'PRE_AUTH_PASSWORD_CHECK_RATE_LIMIT_MAX',
    'PRE_AUTH_PASSWORD_CHECK_RATE_LIMIT_WINDOW_SECONDS',
    DEFAULT_PASSWORD_CHECK_LIMIT,
  );
  const perPrincipal = limitWithDefaults(
    env,
    'RATE_LIMIT_MAX',
    'RATE_LIMIT_WINDOW_SECONDS',
    DEFAULT_PER_PRINCIPAL_LIMIT,
  );
  const exchange = limitWithDefaults(
    env,
    'TOKEN_EXCHANGE_RATE_LIMIT_MAX',
    'TOKEN_EXCHANGE_RATE_LIMIT_WINDOW_SECONDS',
    DEFAULT_TOKEN_EXCHANGE_LIMIT,
  );
  const bodyLimit = optionalPositiveInt(env, 'BODY_LIMIT_BYTES') ?? DEFAULT_BODY_LIMIT_BYTES;
  const backchannelLogoutRateLimitPerMinute =
    optionalPositiveInt(env, 'BACKCHANNEL_LOGOUT_RATE_LIMIT_PER_MINUTE') ??
    DEFAULT_BACKCHANNEL_LOGOUT_RATE_LIMIT_PER_MINUTE;
  return {
    appDatabaseUrl,
    authDatabaseUrl,
    betterAuthSecret,
    cerbosAddress,
    allowedOrigins,
    ...(betterAuthUrl === undefined ? {} : { betterAuthUrl }),
    ...(invitationLinkBaseUrl === undefined ? {} : { invitationLinkBaseUrl }),
    backchannelLogoutRateLimitPerMinute,
    ...(sso === undefined ? {} : { sso }),
    preAuthSignInRateLimit: { max: signIn.max, window: signIn.windowSeconds },
    preAuthPasswordCheckRateLimit: { max: passwordCheck.max, window: passwordCheck.windowSeconds },
    rateLimit: { max: perPrincipal.max, timeWindowMs: perPrincipal.windowSeconds * 1000 },
    tokenExchangeRateLimit: { max: exchange.max, timeWindowMs: exchange.windowSeconds * 1000 },
    bodyLimit,
    telemetryDisabled: loadTelemetryDisabled(env),
  };
}
