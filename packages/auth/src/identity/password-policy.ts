import { COMMON_PASSWORD_DENYLIST } from './common-passwords.js';

/**
 * The password policy (`043` design Q22, Q132): NFC normalization, length,
 * character classes, refused characters and the bundled denylist of
 * `common-passwords.ts`. Pure, no I/O.
 */

export const PASSWORD_MIN_LENGTH = 20;
export const PASSWORD_MAX_LENGTH = 128;

/** The failed rule; a refusal names only this, never the password. */
export type PasswordRule =
  'length' | 'uppercase' | 'lowercase' | 'digit' | 'symbol' | 'character' | 'denylist';

export type PasswordValidation = { ok: true; password: string } | { ok: false; rule: PasswordRule };

/** Control characters, format characters (bidi, zero-width) and unpaired surrogates. */
const HARMFUL = /[\p{Cc}\p{Cf}\p{Cs}]/u;

const DENYLIST: ReadonlySet<string> = new Set(COMMON_PASSWORD_DENYLIST);

/** Validates a password and returns it NFC-normalized, or the first failed rule. */
export function validatePassword(input: string): PasswordValidation {
  if (HARMFUL.test(input)) return { ok: false, rule: 'character' };
  const password = input.normalize('NFC');
  const length = Array.from(password).length;
  if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH) {
    return { ok: false, rule: 'length' };
  }
  if (!/\p{Lu}/u.test(password)) return { ok: false, rule: 'uppercase' };
  if (!/\p{Ll}/u.test(password)) return { ok: false, rule: 'lowercase' };
  if (!/\p{Nd}/u.test(password)) return { ok: false, rule: 'digit' };
  if (!/[^\p{L}\p{N}]/u.test(password)) return { ok: false, rule: 'symbol' };
  if (DENYLIST.has(password.toLowerCase())) return { ok: false, rule: 'denylist' };
  return { ok: true, password };
}
