/**
 * Configuration loader of the maintenance scripts (`043` task 2.0b, design D9,
 * Resolved decisions Q114 and Q116). `loadConfig` (`../src/config.ts`) is the
 * app's loader and requires every variable of the running API; a script holds
 * one role, or no `BETTER_AUTH_SECRETS`, so it reads only the variables it
 * declares here. A missing or malformed variable throws an error that names
 * the variable and never contains a value.
 */
import { parseAuthSecrets } from '../src/auth-secrets.js';

type Env = Readonly<Record<string, string | undefined>>;

export type ScriptVariable =
  | 'DATABASE_URL'
  | 'AUTH_DATABASE_URL'
  | 'PURGE_DATABASE_URL'
  | 'REVERSAL_DATABASE_URL'
  | 'BETTER_AUTH_SECRETS'
  | 'CERBOS_ADDRESS'
  | 'TAYZU_OPERATOR_ID'
  | 'EMAIL_PROVIDER'
  | 'EMAIL_SENDER_ADDRESS'
  | 'EMAIL_RECIPIENT_DOMAIN_ALLOWLIST'
  | 'ACS_CONNECTION_STRING'
  | 'EMAIL_DISABLED_TENANT_IDS'
  | 'INVITATION_EMAIL_KILL_SWITCH';

/**
 * The variables each script declares. The backfill and the reconcile hold
 * `tayzu_app` and `tayzu_auth` and neither holds `BETTER_AUTH_SECRETS` (Q114);
 * both reach their own Cerbos sidecar. The reconcile and the bootstrap CLI
 * also take the operator's opaque id (Q116). The bootstrap CLI builds Better
 * Auth, so it alone declares the secret. The break-glass `recover-admin-mfa`
 * CLI (`044` task 11.1) holds `tayzu_auth` only and no signing key; it
 * declares the email variables of its notice (see `OPTIONAL_VARIABLES`).
 * `045` task 1.3 (design D2 and D3): the purge job holds one database secret,
 * `tayzu_purge` (`PURGE_DATABASE_URL`), and the reversal holds
 * `tayzu_deletion_admin` (`REVERSAL_DATABASE_URL`) and the operator's opaque
 * id; no other script reads either URL. Like every database URL here, neither
 * is ever printed, and `createPool` (`@tayzu/db`) refuses one without
 * `sslmode=verify-full` before connecting.
 */
export const SCRIPT_VARIABLES = {
  'backfill-user-blueprint': ['DATABASE_URL', 'AUTH_DATABASE_URL', 'CERBOS_ADDRESS'],
  'reconcile-users': ['DATABASE_URL', 'AUTH_DATABASE_URL', 'CERBOS_ADDRESS', 'TAYZU_OPERATOR_ID'],
  'bootstrap-admin': [
    'DATABASE_URL',
    'AUTH_DATABASE_URL',
    'BETTER_AUTH_SECRETS',
    'CERBOS_ADDRESS',
    'TAYZU_OPERATOR_ID',
  ],
  'recover-admin-mfa': [
    'AUTH_DATABASE_URL',
    'TAYZU_OPERATOR_ID',
    'EMAIL_PROVIDER',
    'EMAIL_SENDER_ADDRESS',
    'EMAIL_RECIPIENT_DOMAIN_ALLOWLIST',
    'ACS_CONNECTION_STRING',
    'EMAIL_DISABLED_TENANT_IDS',
    'INVITATION_EMAIL_KILL_SWITCH',
  ],
  'purge-job': ['PURGE_DATABASE_URL'],
  'cancel-org-deletion': ['REVERSAL_DATABASE_URL', 'TAYZU_OPERATOR_ID'],
} as const satisfies Record<string, readonly ScriptVariable[]>;

export type ScriptName = keyof typeof SCRIPT_VARIABLES;

/**
 * Variables a script may leave unset. The two kill switches are always
 * optional; the ACS pair is required only for `EMAIL_PROVIDER=acs` and the
 * recipient allowlist for any real provider (design D12, Q14).
 */
const OPTIONAL_VARIABLES: Partial<Record<ScriptName, ReadonlySet<ScriptVariable>>> = {
  'recover-admin-mfa': new Set<ScriptVariable>([
    'EMAIL_SENDER_ADDRESS',
    'EMAIL_RECIPIENT_DOMAIN_ALLOWLIST',
    'ACS_CONNECTION_STRING',
    'EMAIL_DISABLED_TENANT_IDS',
    'INVITATION_EMAIL_KILL_SWITCH',
  ]),
};

const REAL_PROVIDER_REQUIRED: readonly ScriptVariable[] = ['EMAIL_RECIPIENT_DOMAIN_ALLOWLIST'];
const ACS_REQUIRED: readonly ScriptVariable[] = ['ACS_CONNECTION_STRING', 'EMAIL_SENDER_ADDRESS'];

type OptionalOf<S extends ScriptName> = S extends 'recover-admin-mfa'
  ? | 'EMAIL_SENDER_ADDRESS'
    | 'EMAIL_RECIPIENT_DOMAIN_ALLOWLIST'
    | 'ACS_CONNECTION_STRING'
    | 'EMAIL_DISABLED_TENANT_IDS'
    | 'INVITATION_EMAIL_KILL_SWITCH'
  : never;

type ScriptConfig<S extends ScriptName> = Readonly<
  Record<Exclude<(typeof SCRIPT_VARIABLES)[S][number], OptionalOf<S>>, string> &
    Partial<Record<OptionalOf<S>, string>>
>;

/** The catalog's id pattern (design D9): never an email. */
export const OPERATOR_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

/** An error whose message is a fixed text: a CLI entry point may print it as it is. */
export class FixedMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FixedMessageError';
  }
}

function required(env: Env, name: ScriptVariable): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new FixedMessageError(`${name} is required.`);
  }
  return value;
}

function read(env: Env, name: ScriptVariable): string {
  const value = required(env, name);
  if (name === 'BETTER_AUTH_SECRETS') {
    // The shared parser of 048 D4; its message names only the variable.
    try {
      parseAuthSecrets(value, name);
    } catch (error) {
      throw new FixedMessageError(error instanceof Error ? error.message : `${name} is malformed.`);
    }
  }
  if (name === 'TAYZU_OPERATOR_ID' && !OPERATOR_ID_PATTERN.test(value)) {
    throw new FixedMessageError(
      'TAYZU_OPERATOR_ID is malformed (1 to 128 of A-Z a-z 0-9 _ . : -).',
    );
  }
  return value;
}

/** Reads a variable that may be unset; a blank value counts as unset. */
function optional(env: Env, name: ScriptVariable): string | undefined {
  const value = env[name];
  return value === undefined || value.trim() === '' ? undefined : value;
}

/** Reads exactly the variables `script` declares and no other. */
export function loadScriptConfig<S extends ScriptName>(script: S, env: Env): ScriptConfig<S> {
  const optionals = OPTIONAL_VARIABLES[script] ?? new Set<ScriptVariable>();
  const config: Partial<Record<ScriptVariable, string>> = {};
  for (const name of SCRIPT_VARIABLES[script]) {
    if (!optionals.has(name)) {
      config[name] = read(env, name);
    }
  }
  if (script === 'recover-admin-mfa') {
    const provider = config.EMAIL_PROVIDER;
    if (provider !== 'acs' && provider !== 'none') {
      throw new FixedMessageError('EMAIL_PROVIDER is malformed (acs or none).');
    }
    const conditional = provider === 'acs' ? [...ACS_REQUIRED, ...REAL_PROVIDER_REQUIRED] : [];
    for (const name of conditional) {
      required(env, name);
    }
  }
  for (const name of optionals) {
    const value = optional(env, name);
    if (value !== undefined) {
      config[name] = value;
    }
  }
  return config as ScriptConfig<S>;
}
