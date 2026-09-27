/**
 * Assumed API of `./safe-parse.js` (task 2.6):
 *
 * ```ts
 * function parseSafeInput(value: unknown, options?: { maxDepth?: number }): unknown;
 * ```
 *
 * `parseSafeInput` rebuilds every plain object in `value` (recursively,
 * including array elements and nested `object`-typed values) as a
 * null-prototype object (`Object.create(null)`), never through
 * `Object.assign` or spread onto `{}` (design D9). It rejects `__proto__`,
 * `constructor` and `prototype` as an own key at **every** depth  -
 * including locale keys (for example `title.__proto__`) and keys nested
 * inside `object`-typed values - with `CatalogError('CATALOG_VALIDATION_FAILED',
 * ..., { issues: [{ path, message }] })`, `path` being the JSON Pointer of the
 * offending key.
 *
 * It also enforces a nesting-depth limit (`options.maxDepth`, defaulting to
 * the spec Conventions default of 16 for "Nesting depth of object values").
 * Exceeding it throws `CatalogError('CATALOG_LIMIT_EXCEEDED', ..., { details:
 * { limit: 'object.maxNestingDepth' } })`.
 *
 * Test payloads that carry a literal `__proto__`/`constructor`/`prototype`
 * key are built with `JSON.parse`, which (unlike an object literal) creates a
 * genuine *own* data property of that name instead of setting the object's
 * prototype. This is how such a payload actually arrives from untrusted JSON
 * input (a request body), and it is the case the function must detect.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { parseSafeInput } from './safe-parse.js';
import { isCatalogError, type CatalogErrorCode } from './errors.js';

function buildNested(depth: number): unknown {
  let value: unknown = 'leaf';
  for (let i = 0; i < depth; i += 1) {
    value = { child: value };
  }
  return value;
}

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

afterEach(() => {
  // Defensive cleanup: if a buggy implementation under test really polluted
  // the global prototype, do not let it leak into other test files.
  delete (Object.prototype as Record<string, unknown>)['polluted'];
});

describe('parseSafeInput', () => {
  it('rebuilds a plain object as a null-prototype object', () => {
    const result = parseSafeInput({ a: 1, b: { c: 2 } });

    expect(Object.getPrototypeOf(result)).toBeNull();
    expect((result as Record<string, unknown>)['a']).toBe(1);
    const nested = (result as Record<string, unknown>)['b'];
    expect(Object.getPrototypeOf(nested)).toBeNull();
    expect((nested as Record<string, unknown>)['c']).toBe(2);
  });

  it('keeps arrays as arrays and rebuilds their object elements', () => {
    const result = parseSafeInput({ items: [{ a: 1 }, { b: 2 }] }) as Record<string, unknown>;

    expect(Array.isArray(result['items'])).toBe(true);
    const items = result['items'] as unknown[];
    expect(Object.getPrototypeOf(items[0])).toBeNull();
  });

  it('leaves primitives unchanged', () => {
    expect(parseSafeInput('hello')).toBe('hello');
    expect(parseSafeInput(42)).toBe(42);
    expect(parseSafeInput(null)).toBeNull();
    expect(parseSafeInput(true)).toBe(true);
  });

  describe('"Unsafe keys are rejected"', () => {
    it('rejects __proto__ used as a locale key inside a title', () => {
      const malicious = JSON.parse('{"en":"Service","__proto__":"evil"}') as unknown;

      expectRejectedWith(() => parseSafeInput({ title: malicious }), 'CATALOG_VALIDATION_FAILED');
    });

    it('rejects constructor used as a spec.properties key', () => {
      const malicious = JSON.parse('{"properties":{"constructor":"x"}}') as unknown;

      expectRejectedWith(() => parseSafeInput(malicious), 'CATALOG_VALIDATION_FAILED');
    });

    it('rejects a __proto__ key nested inside an object-typed value', () => {
      const malicious = JSON.parse(
        '{"objectProp":{"a":{"__proto__":{"polluted":true}}}}',
      ) as unknown;

      expectRejectedWith(() => parseSafeInput(malicious), 'CATALOG_VALIDATION_FAILED');
    });

    it('rejects a top-level prototype key', () => {
      const malicious = JSON.parse('{"prototype":"x"}') as unknown;

      expectRejectedWith(() => parseSafeInput(malicious), 'CATALOG_VALIDATION_FAILED');
    });
  });

  it('leaves Object.prototype untouched after parsing a malicious payload', () => {
    const malicious = JSON.parse('{"a":{"__proto__":{"polluted":true}}}') as unknown;

    expectRejectedWith(() => parseSafeInput(malicious), 'CATALOG_VALIDATION_FAILED');
    expect(Object.prototype).not.toHaveProperty('polluted');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('accepts nesting depth 16 (boundary)', () => {
    expect(() => parseSafeInput(buildNested(16))).not.toThrow();
  });

  it('rejects nesting depth 17', () => {
    expectRejectedWith(() => parseSafeInput(buildNested(17)), 'CATALOG_LIMIT_EXCEEDED');
  });

  it('honors a custom maxDepth option', () => {
    expectRejectedWith(
      () => parseSafeInput(buildNested(3), { maxDepth: 2 }),
      'CATALOG_LIMIT_EXCEEDED',
    );
    expect(() => parseSafeInput(buildNested(2), { maxDepth: 2 })).not.toThrow();
  });
});
