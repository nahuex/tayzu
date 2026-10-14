/**
 * Configuration loader of the maintenance scripts (`043` task 2.0b, design D9,
 * Resolved decisions Q114 and Q116). `loadConfig` (`../src/config.ts`) is the
 * app's loader and requires every variable of the running API; a script holds
 * one role, or no `BETTER_AUTH_SECRET`, so it reads only the variables it
 * declares here. A missing or malformed variable throws an error that names
 * the variable and never contains a value.
 */
type Env = Readonly<Record<string, string | undefined>>;

export type ScriptVariable =
  | 'DATABASE_URL'
  | 'AUTH_DATABASE_URL'
  | 'BETTER_AUTH_SECRET'
  | 'CERBOS_ADDRESS'
  | 'TAYZU_OPERATOR_ID';

/**
 * The variables each script declares. The backfill and the reconcile hold
 * `tayzu_app` and `tayzu_auth` and neither holds `BETTER_AUTH_SECRET` (Q114);
 * both reach their own Cerbos sidecar. The reconcile and the bootstrap CLI
 * also take the operator's opaque id (Q116). The bootstrap CLI builds Better
 * Auth, so it alone declares the secret.
 */
export const SCRIPT_VARIABLES = {
  'backfill-user-blueprint': ['DATABASE_URL', 'AUTH_DATABASE_URL', 'CERBOS_ADDRESS'],
  'reconcile-users': ['DATABASE_URL', 'AUTH_DATABASE_URL', 'CERBOS_ADDRESS', 'TAYZU_OPERATOR_ID'],
  'bootstrap-admin': [
    'DATABASE_URL',
    'AUTH_DATABASE_URL',
    'BETTER_AUTH_SECRET',
    'CERBOS_ADDRESS',
    'TAYZU_OPERATOR_ID',
  ],
} as const satisfies Record<string, readonly ScriptVariable[]>;

export type ScriptName = keyof typeof SCRIPT_VARIABLES;

const MIN_SECRET_LENGTH = 32;
/** The catalog's id pattern (design D9): never an email. */
const OPERATOR_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

function required(env: Env, name: ScriptVariable): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function read(env: Env, name: ScriptVariable): string {
  const value = required(env, name);
  if (name === 'BETTER_AUTH_SECRET' && value.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `BETTER_AUTH_SECRET is malformed (at least ${String(MIN_SECRET_LENGTH)} characters).`,
    );
  }
  if (name === 'TAYZU_OPERATOR_ID' && !OPERATOR_ID_PATTERN.test(value)) {
    throw new Error('TAYZU_OPERATOR_ID is malformed (1 to 128 of A-Z a-z 0-9 _ . : -).');
  }
  return value;
}

/** Reads exactly the variables `script` declares and no other. */
export function loadScriptConfig<S extends ScriptName>(
  script: S,
  env: Env,
): Readonly<Record<(typeof SCRIPT_VARIABLES)[S][number], string>> {
  const config: Partial<Record<ScriptVariable, string>> = {};
  for (const name of SCRIPT_VARIABLES[script]) {
    config[name] = read(env, name);
  }
  return config as Record<(typeof SCRIPT_VARIABLES)[S][number], string>;
}
