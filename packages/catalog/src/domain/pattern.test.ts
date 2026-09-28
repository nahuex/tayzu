/**
 * Assumed API of `./pattern.js` (task 3.3):
 *
 * ```ts
 * function parsePattern(value: unknown, path: string, maxLength?: number): string;
 * ```
 *
 * Validates a `pattern` keyword (spec, "Property types"; design D6).
 * `value` MUST be a string of at most `maxLength` characters (default
 * `defaultCatalogLimits.pattern.maxLength`, 512) and MUST compile as an
 * RE2-compatible (linear-time) regular expression through `re2js`
 * (`RE2JS.compile`). Patterns using backreferences (`\1`) or lookaround
 * (`(?=...)`, `(?!...)`, `(?<=...)`, `(?<!...)`) are not RE2-compatible and
 * are rejected as a compile failure, which covers catastrophic-backtracking
 * constructs such as `(a+)+\1` by construction (RE2 never backtracks).
 *
 * Any violation (wrong type, over length, or a compile failure) throws
 * `CatalogError('CATALOG_VALIDATION_FAILED', ..., { issues: [{ path,
 * message }] })`. `path` is the caller-supplied JSON Pointer of the
 * `pattern` field itself (for example `/schema/properties/docs/pattern`)
 * and is echoed back unchanged in the issue. On success `parsePattern`
 * returns the pattern string unchanged.
 */
import { describe, expect, it } from 'vitest';
import { parsePattern } from './pattern.js';
import { isCatalogError } from './errors.js';

const PATH = '/schema/properties/docs/pattern';

function expectRejected(pattern: string, maxLength?: number): void {
  try {
    parsePattern(pattern, PATH, maxLength);
    expect.unreachable('parsePattern should have thrown');
  } catch (error) {
    expect(isCatalogError(error)).toBe(true);
    if (!isCatalogError(error)) throw error;
    expect(error.code).toBe('CATALOG_VALIDATION_FAILED');
    expect(error.issues?.some((issue) => issue.path === PATH)).toBe(true);
  }
}

describe('parsePattern', () => {
  describe('"Catastrophic-backtracking pattern is rejected"', () => {
    it('rejects "(a+)+\\1" at the pattern JSON Pointer', () => {
      expectRejected('(a+)+\\1');
    });
  });

  describe('backreference rejection', () => {
    it('rejects a plain backreference "(a)\\1"', () => {
      expectRejected('(a)\\1');
    });
  });

  describe('lookaround rejection', () => {
    it('rejects a positive lookahead "(?=foo)bar"', () => {
      expectRejected('(?=foo)bar');
    });

    it('rejects a negative lookahead "(?!foo)bar"', () => {
      expectRejected('(?!foo)bar');
    });

    it('rejects a positive lookbehind "(?<=foo)bar"', () => {
      expectRejected('(?<=foo)bar');
    });

    it('rejects a negative lookbehind "(?<!foo)bar"', () => {
      expectRejected('(?<!foo)bar');
    });
  });

  describe('pattern length (at most 512 characters)', () => {
    it('rejects a 513-character pattern', () => {
      expectRejected('a'.repeat(513));
    });

    it('accepts a 512-character pattern (boundary)', () => {
      const pattern = 'a'.repeat(512);

      expect(parsePattern(pattern, PATH)).toBe(pattern);
    });

    it('honors a caller-supplied maxLength', () => {
      expectRejected('a'.repeat(11), 10);
    });
  });

  describe('a valid pattern is accepted', () => {
    it('returns the pattern string unchanged', () => {
      const pattern = '^[a-z0-9-]+$';

      expect(parsePattern(pattern, PATH)).toBe(pattern);
    });
  });

  it('rejects a non-string value', () => {
    expectRejected(42 as unknown as string);
  });
});
