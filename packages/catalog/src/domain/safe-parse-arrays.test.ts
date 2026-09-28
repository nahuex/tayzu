/**
 * Integration/unit test for a `/security-review` finding on task 11.3
 * (openspec/changes/001-catalog-core): `domain/safe-parse.ts`'s `walk`
 * enforces the nesting-depth limit (spec Conventions, "Default limits":
 * "Nesting depth of `object` values | 16"; design D8: limits are checked
 * before any expensive work) only for the plain-object branch --
 *
 * ```ts
 * if (Array.isArray(value)) {
 *   return value.map((item, index) => walk(item, `${path}/${String(index)}`, depth, maxDepth));
 * }
 * ```
 *
 * -- the array branch recurses at the *same* `depth` it was called with,
 * instead of `depth + 1`. A pure-array chain therefore never trips the
 * `depth >= maxDepth` check at all, no matter how deep it is, and a
 * sufficiently deep one (tens of thousands of levels, a few KB serialized)
 * blows the JavaScript call stack -- `RangeError: Maximum call stack size
 * exceeded` -- instead of failing cleanly with `CatalogError`
 * `CATALOG_LIMIT_EXCEEDED`, the same way an equally deep plain-object chain
 * already does (`safe-parse.test.ts`'s "rejects nesting depth 17"). This is
 * an uncaught-exception denial-of-service: any caller of `parseSafeInput`
 * (`service/entities.ts`'s `create`, `upsert` and `writeStatus`,
 * `service/blueprints.ts`'s `create` and `update`) crashes the request
 * instead of returning a normal `CATALOG_LIMIT_EXCEEDED` error for a
 * deeply-nested array inside an `object`-typed property or a blueprint
 * definition.
 *
 * Every array chain below is built with an iterative loop, never a
 * recursive helper: a recursive *builder* for a 50000-level chain would
 * itself overflow the stack before `parseSafeInput` is ever called.
 */
import { describe, expect, it } from 'vitest';
import { parseSafeInput } from './safe-parse.js';
import { isCatalogError, type CatalogErrorCode } from './errors.js';

/** Wraps `'leaf'` in `depth` nested one-element arrays, built with a loop (never recursion). */
function buildNestedArray(depth: number): unknown {
  let value: unknown = 'leaf';
  for (let i = 0; i < depth; i += 1) {
    value = [value];
  }
  return value;
}

type Level = 'array' | 'object';

/** Wraps `'leaf'` in `levels.length` nested levels (array or object, per entry), built with a loop. */
function buildMixedNested(levels: readonly Level[]): unknown {
  let value: unknown = 'leaf';
  for (const level of levels) {
    value = level === 'array' ? [value] : { child: value };
  }
  return value;
}

/** 8 array levels alternated with 8 object levels: 16 total, right at the default limit. */
const ALTERNATING_16_LEVELS: readonly Level[] = [
  'array', 'object', 'array', 'object', 'array', 'object', 'array', 'object',
  'array', 'object', 'array', 'object', 'array', 'object', 'array', 'object',
];

function expectRejectedWith(fn: () => unknown, code: CatalogErrorCode): void {
  try {
    fn();
    expect.unreachable('parseSafeInput should have thrown');
  } catch (error) {
    expect(isCatalogError(error)).toBe(true);
    if (!isCatalogError(error)) throw error;
    expect(error.code).toBe(code);
  }
}

describe('parseSafeInput: the nesting-depth limit applies to arrays (task 11.3 security-review finding)', () => {
  describe('pure-array nesting', () => {
    it('accepts nesting depth 16 (boundary)', () => {
      expect(() => parseSafeInput(buildNestedArray(16))).not.toThrow();
    });

    it('rejects nesting depth 17 with CATALOG_LIMIT_EXCEEDED naming the object-nesting-depth limit', () => {
      let caught: unknown;
      try {
        parseSafeInput(buildNestedArray(17));
        expect.unreachable('parseSafeInput should have thrown');
      } catch (error) {
        caught = error;
      }
      expect(isCatalogError(caught)).toBe(true);
      if (!isCatalogError(caught)) throw caught;
      expect(caught.code).toBe('CATALOG_LIMIT_EXCEEDED');
      expect(caught.details?.['limit']).toBe('object.maxNestingDepth');
    });

    it('honors a custom maxDepth option for arrays', () => {
      expectRejectedWith(
        () => parseSafeInput(buildNestedArray(3), { maxDepth: 2 }),
        'CATALOG_LIMIT_EXCEEDED',
      );
      expect(() => parseSafeInput(buildNestedArray(2), { maxDepth: 2 })).not.toThrow();
    });
  });

  describe('mixed object/array nesting counts every level', () => {
    it('accepts 16 alternating array/object levels (boundary)', () => {
      expect(() => parseSafeInput(buildMixedNested(ALTERNATING_16_LEVELS))).not.toThrow();
    });

    it('rejects 17 alternating array/object levels with CATALOG_LIMIT_EXCEEDED', () => {
      expectRejectedWith(
        () => parseSafeInput(buildMixedNested([...ALTERNATING_16_LEVELS, 'array'])),
        'CATALOG_LIMIT_EXCEEDED',
      );
    });

    it('rejects a plain object nested one level deep behind 20 array wrappers, because the array levels themselves count toward the limit', () => {
      // Only 1 plain-object level (well under the default limit of 16 on its
      // own), but wrapped in 20 array levels first: 21 levels total. Today
      // the array branch never advances `depth`, so this object is (wrongly)
      // walked at depth 0 and the write is accepted.
      const levels: Level[] = [...Array<Level>(20).fill('array'), 'object'];

      expectRejectedWith(() => parseSafeInput(buildMixedNested(levels)), 'CATALOG_LIMIT_EXCEEDED');
    });
  });

  describe('a very deep pure-array chain fails cleanly instead of overflowing the call stack', () => {
    it('rejects a 50000-level nested array chain with CATALOG_LIMIT_EXCEEDED, and never throws a RangeError', () => {
      const deeplyNestedArray = buildNestedArray(50_000);

      let caught: unknown;
      try {
        parseSafeInput(deeplyNestedArray);
        expect.unreachable('parseSafeInput should have thrown');
      } catch (error) {
        caught = error;
      }

      expect(caught).not.toBeInstanceOf(RangeError);
      expect(isCatalogError(caught)).toBe(true);
      if (!isCatalogError(caught)) throw caught;
      expect(caught.code).toBe('CATALOG_LIMIT_EXCEEDED');
      expect(caught.details?.['limit']).toBe('object.maxNestingDepth');
    });
  });
});
