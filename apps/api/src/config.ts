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
}

const MIN_SECRET_LENGTH = 32;

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is required.`);
  }
  return value;
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
  return { appDatabaseUrl, authDatabaseUrl, betterAuthSecret, cerbosAddress, allowedOrigins };
}
