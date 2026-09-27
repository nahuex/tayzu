/**
 * Assumed API of `./property-schema.js` (tasks 3.1, 3.2):
 *
 * ```ts
 * export interface StringPropertyDefinition {
 *   type: 'string';
 *   title: LocalizedText;
 *   format?: 'date-time' | 'url' | 'email' | 'markdown' | 'yaml';
 *   minLength?: number;
 *   maxLength?: number;
 *   pattern?: string;
 *   enum?: string[];
 *   default?: string;
 * }
 * export interface NumberPropertyDefinition {
 *   type: 'number' | 'integer';
 *   title: LocalizedText;
 *   minimum?: number;
 *   maximum?: number;
 *   enum?: number[];
 *   default?: number;
 * }
 * export interface BooleanPropertyDefinition {
 *   type: 'boolean';
 *   title: LocalizedText;
 *   default?: boolean;
 * }
 * export interface ArrayItemDefinition {
 *   type: 'string' | 'number' | 'integer' | 'boolean';
 *   // the same type-specific keywords as above, minus `title`
 * }
 * export interface ArrayPropertyDefinition {
 *   type: 'array';
 *   title: LocalizedText;
 *   items: ArrayItemDefinition;
 *   minItems?: number;
 *   maxItems?: number;
 *   uniqueItems?: boolean;
 * }
 * export interface ObjectPropertyDefinition {
 *   type: 'object';
 *   title: LocalizedText;
 * }
 * export type PropertyDefinition =
 *   | StringPropertyDefinition
 *   | NumberPropertyDefinition
 *   | BooleanPropertyDefinition
 *   | ArrayPropertyDefinition
 *   | ObjectPropertyDefinition;
 *
 * function parsePropertyDefinition(value: unknown, path: string): PropertyDefinition;
 * ```
 *
 * A strict Zod discriminated union on `type` (design D6): every property
 * definition requires a localized `title` and exactly one of the five
 * allowed `type`s, with only the type-specific keywords the spec's
 * "Property types" requirement lists. `path` is the JSON Pointer of the
 * property itself (for example `/schema/properties/docs`); `title` issues
 * are reported at `${path}/title/en` / `${path}/title/<locale>`
 * (`./localized-text.js`). Because every schema is `.strict()`, any other
 * key - including `$ref`, `$id`, `$defs`, `if`/`then`/`else`, a nested
 * object schema (`properties` on an `object`-typed definition), an unknown
 * `format`, or a keyword not listed for that `type` - is rejected as an
 * unrecognized key, reported at `${path}/<key>` (for example `${path}/$ref`,
 * `${path}/format`), with `CatalogError('CATALOG_VALIDATION_FAILED', ...,
 * { issues: [{ path, message }] })`. The `pattern` keyword is delegated to
 * `./pattern.js`'s `parsePattern`, called with `${path}/pattern`.
 * `parsePropertyDefinition` never performs network I/O: it never
 * dereferences `$ref` or any other URL, even when one is rejected.
 */
import { describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import { parsePropertyDefinition } from './property-schema.js';
import { isCatalogError } from './errors.js';

const PATH = '/schema/properties/docs';
const TITLE = { en: 'Title' };

function expectRejected(value: unknown, issuePath?: string): void {
  try {
    parsePropertyDefinition(value, PATH);
    expect.unreachable('parsePropertyDefinition should have thrown');
  } catch (error) {
    expect(isCatalogError(error)).toBe(true);
    if (!isCatalogError(error)) throw error;
    expect(error.code).toBe('CATALOG_VALIDATION_FAILED');
    if (issuePath) {
      expect(error.issues?.some((issue) => issue.path === issuePath)).toBe(true);
    }
  }
}

describe('"Supported property types are accepted"', () => {
  it.each([
    ['string with format url', { type: 'string', title: TITLE, format: 'url' }],
    ['string with format date-time', { type: 'string', title: TITLE, format: 'date-time' }],
    ['string with format email', { type: 'string', title: TITLE, format: 'email' }],
    ['string with format markdown', { type: 'string', title: TITLE, format: 'markdown' }],
    ['string with format yaml', { type: 'string', title: TITLE, format: 'yaml' }],
    ['string with pattern/enum/lengths', { type: 'string', title: TITLE, minLength: 1, maxLength: 10, pattern: '^[a-z]+$', enum: ['a', 'b'], default: 'a' }],
    ['integer with minimum', { type: 'integer', title: TITLE, minimum: 0 }],
    ['number with minimum/maximum/default', { type: 'number', title: TITLE, minimum: 0, maximum: 1, default: 0.5 }],
    ['boolean with default', { type: 'boolean', title: TITLE, default: true }],
    ['array of strings', { type: 'array', title: TITLE, items: { type: 'string' } }],
    ['array of integers with min/max/uniqueItems', { type: 'array', title: TITLE, items: { type: 'integer' }, minItems: 1, maxItems: 5, uniqueItems: true }],
    ['object', { type: 'object', title: TITLE }],
  ])('%s is accepted', (_name, definition) => {
    const parsed = parsePropertyDefinition(definition, PATH);

    expect(parsed.type).toBe((definition as { type: string }).type);
  });
});

describe('a missing title is rejected', () => {
  it('reports the issue at "${path}/title/en"', () => {
    expectRejected({ type: 'string' }, `${PATH}/title/en`);
  });
});

describe('"Remote reference is rejected"', () => {
  it('rejects a property definition containing "$ref" and makes no network call', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const httpSpy = vi.spyOn(http, 'request');
    const httpsSpy = vi.spyOn(https, 'request');

    try {
      expectRejected(
        { type: 'string', title: TITLE, $ref: 'https://example.com/schema.json' },
        `${PATH}/$ref`,
      );

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(httpSpy).not.toHaveBeenCalled();
      expect(httpsSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      httpSpy.mockRestore();
      httpsSpy.mockRestore();
    }
  });
});

describe('other disallowed JSON Schema constructs are rejected with a JSON-Pointer path', () => {
  it('rejects "$id"', () => {
    expectRejected({ type: 'string', title: TITLE, $id: 'https://example.com/x' }, `${PATH}/$id`);
  });

  it('rejects "$defs"', () => {
    expectRejected({ type: 'string', title: TITLE, $defs: {} }, `${PATH}/$defs`);
  });

  it('rejects "if"/"then"/"else"', () => {
    expectRejected(
      { type: 'string', title: TITLE, if: { const: 'a' }, then: {}, else: {} },
      `${PATH}/if`,
    );
  });

  it('rejects a nested object schema ("properties" on an object-typed definition)', () => {
    expectRejected(
      { type: 'object', title: TITLE, properties: { nested: { type: 'string' } } },
      `${PATH}/properties`,
    );
  });

  it('rejects an unknown "format"', () => {
    expectRejected({ type: 'string', title: TITLE, format: 'html' }, `${PATH}/format`);
  });

  it('rejects a keyword not allowed for the declared type (pattern on an integer)', () => {
    expectRejected({ type: 'integer', title: TITLE, pattern: '^[0-9]+$' }, `${PATH}/pattern`);
  });

  it('rejects an unknown "type"', () => {
    expectRejected({ type: 'null', title: TITLE }, `${PATH}/type`);
  });

  it('rejects a nested object type as an array item', () => {
    expectRejected(
      { type: 'array', title: TITLE, items: { type: 'object' } },
      `${PATH}/items/type`,
    );
  });
});
