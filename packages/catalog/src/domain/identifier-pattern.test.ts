/**
 * Task 7.9b (043, Resolved decision Q60): `ENTITY_IDENTIFIER_PATTERN` has one
 * source of truth (`identifiers.ts`), `limits.ts` reuses it and the package
 * index exports it unchanged.
 */
import { describe, expect, it } from 'vitest';
import * as catalog from '../index.js';
import { ENTITY_IDENTIFIER_PATTERN as sourcePattern } from './identifiers.js';
import { defaultCatalogLimits } from './limits.js';

const UNCHANGED_SOURCE = '^[A-Za-z0-9@_.:/=-]{1,256}$';

function exportedPattern(): RegExp {
  const value = (catalog as Record<string, unknown>)['ENTITY_IDENTIFIER_PATTERN'];
  expect(value).toBeInstanceOf(RegExp);
  return value as RegExp;
}

describe('ENTITY_IDENTIFIER_PATTERN export (Q60)', () => {
  it('is exported by the package index unchanged', () => {
    const pattern = exportedPattern();
    expect(pattern.source).toBe(UNCHANGED_SOURCE);
    expect(pattern.flags).toBe('');
  });

  it('is exported by identifiers.ts, the source of truth, unchanged', () => {
    expect(sourcePattern.source).toBe(UNCHANGED_SOURCE);
    expect(sourcePattern.flags).toBe('');
  });

  it('the index export is the very constant of identifiers.ts', () => {
    expect(exportedPattern()).toBe(sourcePattern);
  });

  it('limits.ts and identifiers.ts use the same constant', () => {
    expect(defaultCatalogLimits.entityIdentifier.pattern).toBe(sourcePattern);
  });

  describe.each([
    ['an email', 'alice@example.com', true],
    ['an svc- identifier', 'svc-ci-runner', true],
    ['a value with /', 'team/service', true],
    ['a value of exactly 256 characters', 'a'.repeat(256), true],
    ['an over-length value (257 characters)', 'a'.repeat(257), false],
    ['an empty value', '', false],
    ['a value with a space', 'alice smith', false],
    ['a value with +', 'a+b@example.com', false],
    ['a value with a newline', 'alice\n', false],
  ])('%s', (_label, value, accepted) => {
    it(`${accepted ? 'accepts' : 'rejects'} it through the exported pattern`, () => {
      expect(exportedPattern().test(value)).toBe(accepted);
    });
  });
});
