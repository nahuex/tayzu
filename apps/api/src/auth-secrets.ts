/**
 * The versioned authentication secrets (`048` design D4, Resolved decision Q9). The one
 * parser of `BETTER_AUTH_SECRETS`, shared by `config.ts` and `scripts/script-config.ts`.
 *
 * Format: `<version>:<value>[,<version>:<value>...]`. A version is a decimal integer from 0
 * to 2^31-1 with no sign and no leading zero (except `0`); the value is everything after the
 * first colon, trimmed, at least 32 characters, without a comma. Versions are unique, the
 * first entry is the current one, and at least one entry is required. An error names only
 * the variable it was given, never a value.
 */

/** One entry of the list: Better Auth's `secrets` option takes the same shape. */
export interface AuthSecret {
  readonly version: number;
  readonly value: string;
}

const MIN_SECRET_LENGTH = 32;
const MAX_VERSION = 2 ** 31 - 1;
/** No sign, no leading zero (except `0`), no fraction, exponent or hexadecimal form. */
const VERSION_PATTERN = /^(?:0|[1-9][0-9]{0,9})$/;

function malformed(variable: string, reason: string): Error {
  return new Error(`${variable} is malformed (${reason}).`);
}

/** Parses `value` in the list's given order; throws naming only `variable`. */
export function parseAuthSecrets(value: string, variable: string): readonly AuthSecret[] {
  const secrets: AuthSecret[] = [];
  const versions = new Set<number>();
  for (const rawEntry of value.split(',')) {
    const entry = rawEntry.trim();
    const colon = entry.indexOf(':');
    if (colon === -1) {
      throw malformed(variable, 'comma-separated <version>:<value> entries are required');
    }
    const versionText = entry.slice(0, colon);
    const secret = entry.slice(colon + 1).trim();
    const version = Number(versionText);
    if (!VERSION_PATTERN.test(versionText) || version > MAX_VERSION) {
      throw malformed(
        variable,
        `a version is an integer from 0 to ${String(MAX_VERSION)} with no sign or leading zero`,
      );
    }
    if (versions.has(version)) {
      throw malformed(variable, 'every version must be unique');
    }
    if (secret.length < MIN_SECRET_LENGTH) {
      throw malformed(
        variable,
        `every value must have at least ${String(MIN_SECRET_LENGTH)} characters`,
      );
    }
    versions.add(version);
    secrets.push({ version, value: secret });
  }
  return secrets;
}

/** The value of the current (first) entry; fails closed on an empty list. */
export function currentAuthSecret(secrets: readonly AuthSecret[], variable: string): string {
  const current = secrets[0];
  if (current === undefined) {
    throw new Error(`${variable} is required.`);
  }
  return current.value;
}
