/**
 * `048` task 4.1 (design D4, Resolved decision Q9): the one parser of the versioned
 * authentication secrets, shared by `config.ts` and `scripts/script-config.ts`.
 *
 * ## Production symbols expected
 *
 * ```ts
 * // apps/api/src/auth-secrets.ts (does not exist yet)
 * export function parseAuthSecrets(
 *   value: string,
 *   variable: string,
 * ): readonly { version: number; value: string }[];
 * ```
 *
 * Format (D4): `<version>:<value>[,<version>:<value>...]`. A version is a decimal
 * integer from 0 to 2^31-1 with no sign and no leading zero (except `0`); the value is
 * everything after the first colon, trimmed, at least 32 characters, without a comma.
 * Versions are unique; the first entry is the current one; at least one entry is
 * required. An error names only the variable it was given, never a value.
 *
 * Spec (auth-and-rbac, "Authentication secrets are versioned and come only from the
 * host"), scenario "A malformed list is refused":
 *
 * - WHEN the list has a duplicated version, a negative or non-numeric version, an
 *   entry without a value, or a value under 32 characters
 * - THEN startup fails with a message that names only the variable and no value
 *
 * ## Why this fails right now
 *
 * `./auth-secrets.js` does not exist ("Cannot find module" is the only cause).
 */
import { describe, expect, it } from 'vitest';

// The module under test. Does not exist yet.
import { parseAuthSecrets } from './auth-secrets.js';

const VARIABLE = 'BETTER_AUTH_SECRETS';
/** Value markers: each is at least 32 characters and unique, so a leak is detectable. */
const VALUE_A = 'Qz7xK2mP9vL4nR8tW3yB6cF1hJ5dG0sAe';
const VALUE_B = 'Xw4Tq8Lp2Zr6Nv0Jm5Hk9Bc3Fy7Ds1GuQ';
const VALUE_C = 'Pk3Wz9Rm1Yt5Qx7Lv2Jn8Hb4Gc6Fd0SaZ';

function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (caught) {
    expect(caught).toBeInstanceOf(Error);
    return caught as Error;
  }
  throw new Error('expected the call to throw');
}

/**
 * The message names only `variable`: it contains it, it contains no other
 * environment-variable-like token, and it contains no part of a value of `raw` (every
 * 6-character fragment of each value is checked).
 */
function expectNamesOnly(message: string, variable: string, raw: string): void {
  expect(message).toContain(variable);
  const tokens = message.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) ?? [];
  for (const token of tokens) expect(token, `token ${token} in the message`).toBe(variable);
  for (const entry of raw.split(',')) {
    const colon = entry.indexOf(':');
    const value = (colon === -1 ? entry : entry.slice(colon + 1)).trim();
    for (let start = 0; start + 6 <= value.length; start += 1) {
      const fragment = value.slice(start, start + 6);
      expect(message, `fragment ${fragment} of a value`).not.toContain(fragment);
    }
  }
}

describe('parseAuthSecrets (048 task 4.1, design D4)', () => {
  describe('a well-formed list is parsed', () => {
    it('one entry is the current one', () => {
      expect(parseAuthSecrets(`1:${VALUE_A}`, VARIABLE)).toEqual([{ version: 1, value: VALUE_A }]);
    });

    it('the first entry is current: the list keeps the given order, not the version order', () => {
      expect(parseAuthSecrets(`2:${VALUE_A},1:${VALUE_B}`, VARIABLE)).toEqual([
        { version: 2, value: VALUE_A },
        { version: 1, value: VALUE_B },
      ]);
      expect(parseAuthSecrets(`1:${VALUE_A},2:${VALUE_B},7:${VALUE_C}`, VARIABLE)).toEqual([
        { version: 1, value: VALUE_A },
        { version: 2, value: VALUE_B },
        { version: 7, value: VALUE_C },
      ]);
    });

    it('version 0 and version 2^31-1 are accepted', () => {
      expect(parseAuthSecrets(`0:${VALUE_A}`, VARIABLE)).toEqual([{ version: 0, value: VALUE_A }]);
      expect(parseAuthSecrets(`2147483647:${VALUE_A}`, VARIABLE)).toEqual([
        { version: 2147483647, value: VALUE_A },
      ]);
    });

    it('a value containing a colon is kept whole (everything after the first colon)', () => {
      const withColons = `${VALUE_A}:${VALUE_B}:tail`;
      expect(parseAuthSecrets(`3:${withColons}`, VARIABLE)).toEqual([
        { version: 3, value: withColons },
      ]);
    });

    it('the value is trimmed', () => {
      expect(parseAuthSecrets(`1:  ${VALUE_A}\t ,2: ${VALUE_B} `, VARIABLE)).toEqual([
        { version: 1, value: VALUE_A },
        { version: 2, value: VALUE_B },
      ]);
    });

    it('a value of exactly 32 characters is accepted', () => {
      const exact = 'x'.repeat(32);
      expect(parseAuthSecrets(`1:${exact}`, VARIABLE)).toEqual([{ version: 1, value: exact }]);
    });

    it('every version is a number', () => {
      for (const entry of parseAuthSecrets(`10:${VALUE_A},0:${VALUE_B}`, VARIABLE)) {
        expect(typeof entry.version).toBe('number');
        expect(Number.isSafeInteger(entry.version)).toBe(true);
      }
    });
  });

  describe('scenario: A malformed list is refused', () => {
    const MALFORMED: readonly (readonly [string, string])[] = [
      ['a duplicated version', `1:${VALUE_A},1:${VALUE_B}`],
      ['a duplicated version, not adjacent', `2:${VALUE_A},1:${VALUE_B},2:${VALUE_C}`],
      ['a negative version', `-1:${VALUE_A}`],
      ['a signed version (+1)', `+1:${VALUE_A}`],
      ['a leading-zero version (01)', `01:${VALUE_A}`],
      ['a leading-zero version (00)', `00:${VALUE_A}`],
      ['a non-numeric version (abc)', `abc:${VALUE_A}`],
      ['a non-numeric version (v1)', `v1:${VALUE_A}`],
      ['a non-numeric version (1a)', `1a:${VALUE_A}`],
      ['a fractional version (1.0)', `1.0:${VALUE_A}`],
      ['an exponent version (1e3)', `1e3:${VALUE_A}`],
      ['a hexadecimal version (0x1)', `0x1:${VALUE_A}`],
      ['a version above 2^31-1', `2147483648:${VALUE_A}`],
      ['an empty version', `:${VALUE_A}`],
      ['an entry without a colon', VALUE_A],
      ['an entry without a value', '1:'],
      ['an entry whose value is blank', '1:   '],
      ['a later entry without a value', `1:${VALUE_A},2:`],
      ['a value under 32 characters', `1:${'s'.repeat(31)}`],
      ['a value under 32 characters once trimmed', `1:  ${'s'.repeat(31)}  `],
      ['a later value under 32 characters', `1:${VALUE_A},2:Mx4Vq9Tz2Kp`],
      ['an empty list', ''],
      ['a blank list', '   '],
      ['a list of commas only', ','],
      ['a list of blank entries', ' , , '],
    ];

    it.each(MALFORMED)('refuses %s, naming only the variable and no value', (_label, raw) => {
      const error = thrown(() => parseAuthSecrets(raw, VARIABLE));
      expectNamesOnly(error.message, VARIABLE, raw);
      // The convention of every configuration error: `<VARIABLE> is malformed (...)`.
      expect(error.message.startsWith(`${VARIABLE} is malformed`)).toBe(true);
    });

    it.each(MALFORMED)('names the variable it was given, not a fixed one (%s)', (_label, raw) => {
      const error = thrown(() => parseAuthSecrets(raw, 'OTHER_SECRETS'));
      expectNamesOnly(error.message, 'OTHER_SECRETS', raw);
      expect(error.message.startsWith('OTHER_SECRETS is malformed')).toBe(true);
      expect(error.message).not.toContain('BETTER_AUTH');
    });
  });
});
