/**
 * Assumed API of `./identifiers.js` (task 2.3):
 *
 * ```ts
 * function parseBlueprintIdentifier(value: unknown, path: string): string;
 * function parsePropertyIdentifier(value: unknown, path: string): string;
 * function parseRelationIdentifier(value: unknown, path: string): string;
 * function parseEntityIdentifier(value: unknown, path: string): string;
 * ```
 *
 * All four throw `CatalogError('CATALOG_VALIDATION_FAILED', ..., { issues:
 * [{ path, message }] })` on failure, and return the identifier unchanged on
 * success. `path` is the JSON Pointer the caller wants attributed to the
 * failing value (for example `/identifier` for a blueprint create).
 *
 * `parseBlueprintIdentifier`, `parsePropertyIdentifier` and
 * `parseRelationIdentifier` share the spec Conventions identifier pattern
 * `^[A-Za-z][A-Za-z0-9_-]{0,63}$` (max 64 characters, must start with a
 * letter). Because that pattern requires a leading letter, `__proto__`
 * already fails it (it starts with `_`).
 *
 * `parseEntityIdentifier` uses the entity identifier pattern
 * `^[A-Za-z0-9@_.:/=-]{1,256}$` (max 256 characters), plus the extra
 * Conventions rule: no `.` or `..` path segment, and no leading, trailing or
 * repeated `/`. Because that pattern *does* allow a leading `_`, an entity
 * identifier of exactly `__proto__` is explicitly rejected as an unsafe key
 * (spec Conventions "Unsafe keys"), not merely by the character-class regex.
 */
import { describe, expect, it } from 'vitest';
import {
  parseBlueprintIdentifier,
  parseEntityIdentifier,
  parsePropertyIdentifier,
  parseRelationIdentifier,
} from './identifiers.js';
import { isCatalogError } from './errors.js';

function expectRejected(fn: () => unknown, path: string): void {
  try {
    fn();
    expect.unreachable('parser should have thrown');
  } catch (error) {
    expect(isCatalogError(error)).toBe(true);
    if (!isCatalogError(error)) throw error;
    expect(error.code).toBe('CATALOG_VALIDATION_FAILED');
    expect(error.issues).toBeDefined();
    expect(error.issues?.[0]).toMatchObject({ path });
  }
}

describe('parseBlueprintIdentifier', () => {
  it('"Invalid identifier": rejects a leading digit', () => {
    expectRejected(() => parseBlueprintIdentifier('1service', '/identifier'), '/identifier');
  });

  it('"Invalid identifier": rejects a space', () => {
    expectRejected(() => parseBlueprintIdentifier('service name', '/identifier'), '/identifier');
  });

  it('rejects __proto__', () => {
    expectRejected(() => parseBlueprintIdentifier('__proto__', '/identifier'), '/identifier');
  });

  it('accepts a 64-character identifier (boundary)', () => {
    const identifier = 'a' + 'b'.repeat(63);

    expect(parseBlueprintIdentifier(identifier, '/identifier')).toBe(identifier);
  });

  it('rejects a 65-character identifier (boundary)', () => {
    const identifier = 'a' + 'b'.repeat(64);

    expectRejected(() => parseBlueprintIdentifier(identifier, '/identifier'), '/identifier');
  });

  it('accepts a valid identifier', () => {
    expect(parseBlueprintIdentifier('service', '/identifier')).toBe('service');
  });
});

describe('parsePropertyIdentifier', () => {
  it('accepts a valid identifier', () => {
    expect(parsePropertyIdentifier('language', '/schema/properties/language')).toBe('language');
  });

  it('rejects a leading digit', () => {
    expectRejected(
      () => parsePropertyIdentifier('1language', '/schema/properties/1language'),
      '/schema/properties/1language',
    );
  });
});

describe('parseRelationIdentifier', () => {
  it('accepts a valid identifier', () => {
    expect(parseRelationIdentifier('owner', '/relations/owner')).toBe('owner');
  });

  it('rejects a space', () => {
    expectRejected(
      () => parseRelationIdentifier('depends on', '/relations/depends on'),
      '/relations/depends on',
    );
  });
});

describe('parseEntityIdentifier', () => {
  it('accepts org/repo', () => {
    expect(parseEntityIdentifier('org/repo', '/identifier')).toBe('org/repo');
  });

  it('accepts a 256-character identifier (boundary)', () => {
    const identifier = 'a'.repeat(256);

    expect(parseEntityIdentifier(identifier, '/identifier')).toBe(identifier);
  });

  it('rejects a 257-character identifier (boundary)', () => {
    const identifier = 'a'.repeat(257);

    expectRejected(() => parseEntityIdentifier(identifier, '/identifier'), '/identifier');
  });

  it('rejects a `..` path segment (a/../b)', () => {
    expectRejected(() => parseEntityIdentifier('a/../b', '/identifier'), '/identifier');
  });

  it('rejects a leading `.` segment (./a)', () => {
    expectRejected(() => parseEntityIdentifier('./a', '/identifier'), '/identifier');
  });

  it('rejects a leading slash (/a)', () => {
    expectRejected(() => parseEntityIdentifier('/a', '/identifier'), '/identifier');
  });

  it('rejects a trailing slash (a/)', () => {
    expectRejected(() => parseEntityIdentifier('a/', '/identifier'), '/identifier');
  });

  it('rejects a repeated slash (a//b)', () => {
    expectRejected(() => parseEntityIdentifier('a//b', '/identifier'), '/identifier');
  });

  it('rejects __proto__ as an unsafe key, even though the character class would otherwise allow it', () => {
    expectRejected(() => parseEntityIdentifier('__proto__', '/identifier'), '/identifier');
  });
});
