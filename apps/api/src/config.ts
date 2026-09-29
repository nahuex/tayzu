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
  /** Visma Connect SSO (D23); undefined when none of its variables is set. */
  readonly sso?: {
    readonly discoveryUrl: string;
    readonly clientId: string;
    readonly clientSecret: string;
  };
  /** Better Auth's pre-auth sign-in limit (D20); window in seconds. */
  readonly preAuthSignInRateLimit?: { readonly max: number; readonly window: number };
  /** Per-principal `/v1/*` limit (D13). */
  readonly rateLimit?: RateLimit;
  /** `POST /v1/auth/token` limit (D20). */
  readonly tokenExchangeRateLimit?: RateLimit;
  /** Maximum request body in bytes (D13). */
  readonly bodyLimit?: number;
  /** Back-channel logout budget per source IP per minute (D26, Q32). */
  readonly backchannelLogoutRateLimitPerMinute: number;
}

interface RateLimit {
  readonly max: number;
  readonly timeWindowMs: number;
}

const DEFAULT_BACKCHANNEL_LOGOUT_RATE_LIMIT_PER_MINUTE = 600;

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

/** A max/window pair: both variables or neither. */
function optionalLimit(
  env: Env,
  maxName: string,
  windowName: string,
): { max: number; windowSeconds: number } | undefined {
  const max = optionalPositiveInt(env, maxName);
  const windowSeconds = optionalPositiveInt(env, windowName);
  if (max === undefined && windowSeconds === undefined) {
    return undefined;
  }
  if (max === undefined) {
    throw new Error(`${maxName} is required when ${windowName} is set.`);
  }
  if (windowSeconds === undefined) {
    throw new Error(`${windowName} is required when ${maxName} is set.`);
  }
  return { max, windowSeconds };
}

const SSO_VARIABLES = [
  'VISMA_CONNECT_DISCOVERY_URL',
  'VISMA_CONNECT_CLIENT_ID',
  'VISMA_CONNECT_CLIENT_SECRET',
] as const;

function loadSso(env: Env): Config['sso'] {
  const present = SSO_VARIABLES.filter((name) => env[name] !== undefined);
  if (present.length === 0) {
    return undefined;
  }
  return {
    discoveryUrl: required(env, SSO_VARIABLES[0]),
    clientId: required(env, SSO_VARIABLES[1]),
    clientSecret: required(env, SSO_VARIABLES[2]),
  };
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
  const sso = loadSso(env);
  const signIn = optionalLimit(
    env,
    'PRE_AUTH_SIGN_IN_RATE_LIMIT_MAX',
    'PRE_AUTH_SIGN_IN_RATE_LIMIT_WINDOW_SECONDS',
  );
  const perPrincipal = optionalLimit(env, 'RATE_LIMIT_MAX', 'RATE_LIMIT_WINDOW_SECONDS');
  const exchange = optionalLimit(
    env,
    'TOKEN_EXCHANGE_RATE_LIMIT_MAX',
    'TOKEN_EXCHANGE_RATE_LIMIT_WINDOW_SECONDS',
  );
  const bodyLimit = optionalPositiveInt(env, 'BODY_LIMIT_BYTES');
  const backchannelLogoutRateLimitPerMinute =
    optionalPositiveInt(env, 'BACKCHANNEL_LOGOUT_RATE_LIMIT_PER_MINUTE') ??
    DEFAULT_BACKCHANNEL_LOGOUT_RATE_LIMIT_PER_MINUTE;
  return {
    appDatabaseUrl,
    authDatabaseUrl,
    betterAuthSecret,
    cerbosAddress,
    allowedOrigins,
    backchannelLogoutRateLimitPerMinute,
    ...(sso === undefined ? {} : { sso }),
    ...(signIn === undefined
      ? {}
      : { preAuthSignInRateLimit: { max: signIn.max, window: signIn.windowSeconds } }),
    ...(perPrincipal === undefined
      ? {}
      : { rateLimit: { max: perPrincipal.max, timeWindowMs: perPrincipal.windowSeconds * 1000 } }),
    ...(exchange === undefined
      ? {}
      : {
          tokenExchangeRateLimit: {
            max: exchange.max,
            timeWindowMs: exchange.windowSeconds * 1000,
          },
        }),
    ...(bodyLimit === undefined ? {} : { bodyLimit }),
  };
}
