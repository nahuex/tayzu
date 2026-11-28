/**
 * TLS policy for PostgreSQL connection strings (design D5).
 *
 * Outside the test harness, every connection needs `sslmode=verify-full`.
 * Only the test harness may skip TLS, and only for a database on the same
 * machine (`getTestDatabase`, `harness.ts`).
 *
 * The check reads the host and `sslmode` the same way pg itself resolves
 * them from the connection string: `pg-connection-string` is the parser
 * `pg`'s own `Client`/`Pool` use internally, so a repeated query parameter, a
 * percent-encoded parameter name and a `#fragment` are all resolved exactly
 * as the real connection would resolve them. Unlike pg's own
 * `ConnectionParameters`, this never falls back to `PGHOST` or `PGSSLMODE`:
 * the security decision comes from the URL alone, never from the process
 * environment (a URL with an empty host must not be treated as local just
 * because some ambient `PGHOST` happens to point at one).
 */
import { parse as parseConnectionString } from 'pg-connection-string';

/** Hostnames that name a database on the same machine. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

const REQUIRED_SSLMODE = 'verify-full';

/** The variable named in an error when the caller names none. */
const DEFAULT_VARIABLE = 'DATABASE_URL';

interface EffectiveConnection {
  readonly host: string;
  readonly sslmode: string | undefined;
}

/**
 * Errors name `variable`, the environment variable that held `url`, and never
 * the URL itself, its host or its user (048 design D1).
 */
function readEffectiveConnection(url: string, variable = DEFAULT_VARIABLE): EffectiveConnection {
  let parsed: ReturnType<typeof parseConnectionString>;
  try {
    parsed = parseConnectionString(url);
  } catch (error) {
    // pg-connection-string already redacts the input on its own parse errors.
    throw new Error(`${variable} is not a valid PostgreSQL connection string.`, { cause: error });
  }
  return {
    host: typeof parsed.host === 'string' ? parsed.host : '',
    sslmode: typeof parsed.sslmode === 'string' ? parsed.sslmode : undefined,
  };
}

function hasVerifiedTls(connection: EffectiveConnection): boolean {
  return connection.sslmode === REQUIRED_SSLMODE;
}

function isLocalHost(connection: EffectiveConnection): boolean {
  return LOCAL_HOSTS.has(connection.host);
}

function tlsRequirementMessage(variable: string): string {
  return `${variable} must set sslmode=verify-full: PostgreSQL connections require verified TLS (design D5).`;
}

/**
 * Outside the test harness, every connection needs verified TLS. `variable`
 * is the name of the environment variable that held `url`; the error names
 * it, and nothing else about the connection (048 design D1).
 */
export function assertVerifiedTls(url: string, variable = DEFAULT_VARIABLE): void {
  if (!hasVerifiedTls(readEffectiveConnection(url, variable))) {
    throw new Error(tlsRequirementMessage(variable));
  }
}

/**
 * Inside the test harness only, a local database may skip TLS. Any other
 * target still needs `sslmode=verify-full`.
 */
export function assertVerifiedTlsOrLocal(url: string): void {
  const connection = readEffectiveConnection(url);
  if (hasVerifiedTls(connection) || isLocalHost(connection)) {
    return;
  }
  throw new Error(
    `${tlsRequirementMessage(DEFAULT_VARIABLE)} Only a local database (${[...LOCAL_HOSTS].join(', ')}) may skip it, and only for the test harness.`,
  );
}
