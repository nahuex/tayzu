/**
 * Task 5.3d of openspec/changes/043-identity-lifecycle-and-org-admin (spec
 * requirement "Identity procedures parse untrusted input strictly"; design D10
 * "Input contract").
 *
 * Verify clause: "`parse-input.test.ts` covers each rejection at depth 1 and at
 * depth 3, an undeclared field, an over-length value being refused before any
 * lookup spy is called, and a clean body being parsed."
 *
 * Scenario "Hostile or oversized input is rejected before any work": a
 * `__proto__`, `constructor` or `prototype` key at any depth, an undeclared
 * field, or a value over its length limit fails with
 * `CATALOG_VALIDATION_FAILED` before any lookup.
 *
 * Depth convention: the parser receives the `inputStructure: 'detailed'` shape
 * `{ params, query, body }`. Depth 1 is a key directly inside a section (for
 * example `body.__proto__`); depth 3 is two objects further down
 * (`body.meta.a.__proto__`).
 *
 * ## Production symbols expected
 *
 * ```ts
 * // apps/api/src/identity/parse-input.ts
 * export interface StringField {
 *   readonly kind: 'string';
 *   readonly maxLength: number;      // checked before anything else is done with the value
 *   readonly minLength?: number;     // default 1
 *   readonly pattern?: RegExp;
 *   readonly optional?: boolean;     // default false (required)
 * }
 * export interface ObjectField {      // an opaque object: its keys are screened, its shape is not declared
 *   readonly kind: 'object';
 *   readonly optional?: boolean;
 * }
 * export type InputField = StringField | ObjectField;
 * export interface InputSchema {
 *   readonly params?: Readonly<Record<string, InputField>>;
 *   readonly query?: Readonly<Record<string, InputField>>;
 *   readonly body?: Readonly<Record<string, InputField>>;
 * }
 * export function parseIdentityInput(schema: InputSchema, raw: unknown): ParsedIdentityInput;
 * // returns { params, query, body }, each a null-prototype object (a missing
 * // section is an empty null-prototype object); throws an error whose `code`
 * // is 'CATALOG_VALIDATION_FAILED' (nothing else leaks into the message).
 * ```
 */
import { describe, expect, it, vi } from 'vitest';

import { parseIdentityInput } from './parse-input.js';
import type { InputSchema } from './parse-input.js';

const schema: InputSchema = {
  params: { user: { kind: 'string', maxLength: 64 } },
  query: { cursor: { kind: 'string', maxLength: 128, optional: true } },
  body: {
    email: { kind: 'string', maxLength: 254 },
    name: { kind: 'string', maxLength: 32 },
    meta: { kind: 'object', optional: true },
  },
};

function validRaw(): Record<string, Record<string, unknown>> {
  return {
    params: { user: 'u-1' },
    query: {},
    body: { email: 'a@example.com', name: 'Ada' },
  };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

/** Runs the parser and then, only if it returned, the lookup the procedure would do. */
function parseThenLookup(raw: unknown, lookup: () => void): void {
  parseIdentityInput(schema, raw);
  lookup();
}

describe('parseIdentityInput', () => {
  describe('a clean body is parsed', () => {
    it('returns the declared values', () => {
      const parsed = parseIdentityInput(schema, validRaw());
      expect(parsed.params['user']).toBe('u-1');
      expect(parsed.body['email']).toBe('a@example.com');
      expect(parsed.body['name']).toBe('Ada');
    });

    it('returns null-prototype objects for params, query and body', () => {
      const parsed = parseIdentityInput(schema, validRaw());
      expect(Object.getPrototypeOf(parsed.params)).toBeNull();
      expect(Object.getPrototypeOf(parsed.query)).toBeNull();
      expect(Object.getPrototypeOf(parsed.body)).toBeNull();
    });

    it('rebuilds nested objects of an object field as null-prototype objects', () => {
      const raw = validRaw();
      raw['body'] = { ...raw['body'], meta: { a: { b: 'x' } } };
      const parsed = parseIdentityInput(schema, raw);
      const meta = parsed.body['meta'] as Record<string, unknown>;
      expect(Object.getPrototypeOf(meta)).toBeNull();
      expect(Object.getPrototypeOf(meta['a'])).toBeNull();
    });

    it('accepts a missing optional field and a missing optional section', () => {
      const parsed = parseIdentityInput(schema, {
        params: { user: 'u-1' },
        body: validRaw()['body'],
      });
      expect(Object.getPrototypeOf(parsed.query)).toBeNull();
      expect(Object.keys(parsed.query)).toHaveLength(0);
    });
  });

  describe.each(['__proto__', 'constructor', 'prototype'])('the key %s', (key) => {
    it('is rejected at depth 1 of the body', () => {
      const raw = JSON.parse(
        `{"params":{"user":"u-1"},"query":{},"body":{"email":"a@example.com","name":"Ada","${key}":"x"}}`,
      ) as unknown;
      expect(codeOf(() => parseIdentityInput(schema, raw))).toBe('CATALOG_VALIDATION_FAILED');
    });

    it('is rejected at depth 1 of the params', () => {
      const raw = JSON.parse(
        `{"params":{"user":"u-1","${key}":"x"},"query":{},"body":{"email":"a@example.com","name":"Ada"}}`,
      ) as unknown;
      expect(codeOf(() => parseIdentityInput(schema, raw))).toBe('CATALOG_VALIDATION_FAILED');
    });

    it('is rejected at depth 1 of the query', () => {
      const raw = JSON.parse(
        `{"params":{"user":"u-1"},"query":{"${key}":"x"},"body":{"email":"a@example.com","name":"Ada"}}`,
      ) as unknown;
      expect(codeOf(() => parseIdentityInput(schema, raw))).toBe('CATALOG_VALIDATION_FAILED');
    });

    it('is rejected at depth 3 of the body, inside a declared object field', () => {
      const raw = JSON.parse(
        `{"params":{"user":"u-1"},"query":{},"body":{"email":"a@example.com","name":"Ada","meta":{"a":{"${key}":{"b":1}}}}}`,
      ) as unknown;
      expect(codeOf(() => parseIdentityInput(schema, raw))).toBe('CATALOG_VALIDATION_FAILED');
    });

    it('is rejected at depth 3 even when the nested object is otherwise clean', () => {
      const raw = JSON.parse(
        `{"params":{"user":"u-1"},"query":{},"body":{"email":"a@example.com","name":"Ada","meta":{"a":{"b":{"${key}":null}}}}}`,
      ) as unknown;
      expect(codeOf(() => parseIdentityInput(schema, raw))).toBe('CATALOG_VALIDATION_FAILED');
    });

    it('never calls the lookup', () => {
      const lookup = vi.fn();
      const raw = JSON.parse(
        `{"params":{"user":"u-1"},"query":{},"body":{"email":"a@example.com","name":"Ada","${key}":"x"}}`,
      ) as unknown;
      expect(() => {
        parseThenLookup(raw, lookup);
      }).toThrow();
      expect(lookup).not.toHaveBeenCalled();
    });
  });

  describe('an undeclared field', () => {
    it('is rejected in the body', () => {
      const raw = validRaw();
      raw['body'] = { ...raw['body'], role: 'admin' };
      expect(codeOf(() => parseIdentityInput(schema, raw))).toBe('CATALOG_VALIDATION_FAILED');
    });

    it('is rejected in the params', () => {
      const raw = validRaw();
      raw['params'] = { ...raw['params'], other: 'x' };
      expect(codeOf(() => parseIdentityInput(schema, raw))).toBe('CATALOG_VALIDATION_FAILED');
    });

    it('is rejected in the query', () => {
      const raw = validRaw();
      raw['query'] = { extra: 'x' };
      expect(codeOf(() => parseIdentityInput(schema, raw))).toBe('CATALOG_VALIDATION_FAILED');
    });

    it('is rejected as an undeclared section', () => {
      const raw = { ...validRaw(), headers: { a: 'b' } };
      expect(codeOf(() => parseIdentityInput(schema, raw))).toBe('CATALOG_VALIDATION_FAILED');
    });

    it('is rejected in a section the schema does not declare at all', () => {
      const raw = validRaw();
      expect(
        codeOf(() =>
          parseIdentityInput({ params: { user: { kind: 'string', maxLength: 64 } } }, raw),
        ),
      ).toBe('CATALOG_VALIDATION_FAILED');
    });

    it('never calls the lookup', () => {
      const lookup = vi.fn();
      const raw = validRaw();
      raw['body'] = { ...raw['body'], role: 'admin' };
      expect(() => {
        parseThenLookup(raw, lookup);
      }).toThrow();
      expect(lookup).not.toHaveBeenCalled();
    });
  });

  describe('an over-length value', () => {
    it('is rejected in the body', () => {
      const raw = validRaw();
      raw['body'] = { ...raw['body'], name: 'x'.repeat(33) };
      expect(codeOf(() => parseIdentityInput(schema, raw))).toBe('CATALOG_VALIDATION_FAILED');
    });

    it('is rejected in the path parameter', () => {
      const raw = validRaw();
      raw['params'] = { user: 'u'.repeat(65) };
      expect(codeOf(() => parseIdentityInput(schema, raw))).toBe('CATALOG_VALIDATION_FAILED');
    });

    it('is accepted at exactly the limit', () => {
      const raw = validRaw();
      raw['body'] = { ...raw['body'], name: 'x'.repeat(32) };
      expect(() => parseIdentityInput(schema, raw)).not.toThrow();
    });

    it('is refused before any lookup spy is called', () => {
      const lookup = vi.fn();
      const raw = validRaw();
      raw['params'] = { user: 'u'.repeat(10_000) };
      expect(() => {
        parseThenLookup(raw, lookup);
      }).toThrow();
      expect(lookup).not.toHaveBeenCalled();
    });

    it('does not run the pattern on a value over its length limit', () => {
      const test = vi.fn(() => true);
      const pattern = { test } as unknown as RegExp;
      const raw = validRaw();
      raw['params'] = { user: 'u'.repeat(10_000) };
      const guarded: InputSchema = {
        ...schema,
        params: { user: { kind: 'string', maxLength: 64, pattern } },
      };
      expect(codeOf(() => parseIdentityInput(guarded, raw))).toBe('CATALOG_VALIDATION_FAILED');
      expect(test).not.toHaveBeenCalled();
    });
  });

  describe('other malformed input', () => {
    it.each([
      ['a non-object input', 'text'],
      ['a null input', null],
      ['an array input', []],
    ])('rejects %s', (_label, raw) => {
      expect(codeOf(() => parseIdentityInput(schema, raw))).toBe('CATALOG_VALIDATION_FAILED');
    });

    it('rejects a missing required field', () => {
      const raw = validRaw();
      raw['body'] = { email: 'a@example.com' };
      expect(codeOf(() => parseIdentityInput(schema, raw))).toBe('CATALOG_VALIDATION_FAILED');
    });

    it('rejects a value of the wrong type', () => {
      const raw = validRaw();
      raw['body'] = { ...raw['body'], name: 42 };
      expect(codeOf(() => parseIdentityInput(schema, raw))).toBe('CATALOG_VALIDATION_FAILED');
    });

    it('rejects a value that does not match its pattern', () => {
      const patterned: InputSchema = {
        ...schema,
        params: { user: { kind: 'string', maxLength: 64, pattern: /^[a-z0-9-]+$/ } },
      };
      const raw = validRaw();
      raw['params'] = { user: 'NOT VALID!' };
      expect(codeOf(() => parseIdentityInput(patterned, raw))).toBe('CATALOG_VALIDATION_FAILED');
    });

    it('does not echo the offending value in the error message', () => {
      const raw = validRaw();
      raw['body'] = { ...raw['body'], name: 'secret-'.repeat(10) };
      let message = '';
      try {
        parseIdentityInput(schema, raw);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toContain('secret-');
    });
  });
});
