/**
 * Untrusted input in the browser (task 5.4, design D15).
 *
 * "Every response, search param and fragment value is parsed with Zod into
 * null-prototype objects; keys `__proto__`, `constructor` and `prototype` are rejected
 * at every depth, and lengths are checked before parsing further." The server-side
 * equivalent is `packages/catalog/src/domain/safe-parse.ts`.
 *
 * Assumed API of `./untrusted.js`:
 *
 * ```ts
 * import type { z } from 'zod';
 *
 * export type UntrustedFailure = 'too_long' | 'malformed' | 'unsafe_key' | 'invalid';
 *
 * // Never throws.
 * export type UntrustedResult<T> =
 *   | { readonly ok: true; readonly value: T }
 *   | { readonly ok: false; readonly reason: UntrustedFailure };
 *
 * export interface ParseUntrustedOptions<T> {
 *   // Maximum `text.length` (UTF-16 code units), checked before anything else.
 *   readonly maxLength: number;
 *   // Optional Zod schema, run only after the length check, `JSON.parse` and the
 *   // unsafe-key walk; its output is rebuilt into null-prototype objects too.
 *   readonly schema?: z.ZodType<T>;
 * }
 *
 * // In order: `text.length > maxLength` is `too_long` (JSON.parse is not called);
 * // text that is not JSON is `malformed`; an own key `__proto__`, `constructor` or
 * // `prototype` in any object at any depth (arrays included) is `unsafe_key`; a value
 * // the schema refuses is `invalid`. On success every object at every level has a
 * // null prototype and arrays stay arrays.
 * export function parseUntrustedJson<T = unknown>(
 *   text: string,
 *   options: ParseUntrustedOptions<T>,
 * ): UntrustedResult<T>;
 * ```
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { parseUntrustedJson } from './untrusted.js';

const LIMIT = { maxLength: 10_000 } as const;

const UNSAFE_KEYS = ['__proto__', 'constructor', 'prototype'] as const;

afterEach(() => {
  vi.restoreAllMocks();
});

/** Collects every non-array object reachable from `value`, the root included. */
function objectsIn(value: unknown): object[] {
  if (Array.isArray(value)) return value.flatMap((item: unknown) => objectsIn(item));
  if (typeof value !== 'object' || value === null) return [];
  return [value, ...Object.values(value).flatMap((nested: unknown) => objectsIn(nested))];
}

function valueOf<T>(result: { ok: true; value: T } | { ok: false }): T {
  if (!result.ok) throw new Error('expected an ok result');
  return result.value;
}

describe('parseUntrustedJson: unsafe keys', () => {
  it.each(UNSAFE_KEYS)('rejects %s as a key at depth 0', (key) => {
    expect(parseUntrustedJson(`{"a":1,"${key}":{"polluted":true}}`, LIMIT)).toEqual({
      ok: false,
      reason: 'unsafe_key',
    });
  });

  it.each(UNSAFE_KEYS)('rejects %s as a key at depth 1', (key) => {
    expect(parseUntrustedJson(`{"a":{"b":1,"${key}":{"polluted":true}}}`, LIMIT)).toEqual({
      ok: false,
      reason: 'unsafe_key',
    });
  });

  it.each(UNSAFE_KEYS)('rejects %s as a key deep inside arrays', (key) => {
    expect(
      parseUntrustedJson(`{"a":[1,{"b":[[{"c":{"${key}":{"polluted":true}}}]]}]}`, LIMIT),
    ).toEqual({ ok: false, reason: 'unsafe_key' });
  });

  it.each(UNSAFE_KEYS)('rejects %s as a key inside a top-level array', (key) => {
    expect(parseUntrustedJson(`[[{"ok":1}],[{"${key}":0}]]`, LIMIT)).toEqual({
      ok: false,
      reason: 'unsafe_key',
    });
  });

  it('rejects an unsafe key written with JSON escapes', () => {
    // `_` is `_`: the key is `__proto__` once parsed.
    expect(parseUntrustedJson('{"\\u005f_proto__":{"polluted":true}}', LIMIT)).toEqual({
      ok: false,
      reason: 'unsafe_key',
    });
  });

  it('rejects an unsafe key even when the schema would strip it', () => {
    const schema = z.object({ a: z.number() });
    for (const key of UNSAFE_KEYS) {
      expect(
        parseUntrustedJson(`{"a":1,"${key}":{"polluted":true}}`, { ...LIMIT, schema }),
      ).toEqual({ ok: false, reason: 'unsafe_key' });
      expect(
        parseUntrustedJson(`{"a":1,"b":{"${key}":{"polluted":true}}}`, {
          ...LIMIT,
          schema: z.object({ a: z.number(), b: z.object({}) }),
        }),
      ).toEqual({ ok: false, reason: 'unsafe_key' });
    }
  });

  it('does not run the schema when an unsafe key is present', () => {
    const check = vi.fn(() => true);
    const schema = z.unknown().refine(check);
    expect(parseUntrustedJson('{"a":[{"constructor":1}]}', { ...LIMIT, schema })).toEqual({
      ok: false,
      reason: 'unsafe_key',
    });
    expect(check).not.toHaveBeenCalled();
  });

  it('never touches Object.prototype', () => {
    parseUntrustedJson('{"__proto__":{"polluted":true}}', LIMIT);
    parseUntrustedJson('{"a":{"constructor":{"prototype":{"polluted":true}}}}', LIMIT);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('allows keys that only look like the unsafe ones, at every depth', () => {
    const lookalikes = [
      '__proto__x',
      'x__proto__',
      '_proto_',
      '__proto',
      '__PROTO__',
      'Constructor',
      'constructors',
      'Prototype',
      'prototypes',
      'proto',
    ];
    for (const key of lookalikes) {
      const text = `{"${key}":1,"nested":{"${key}":2},"list":[{"${key}":3}]}`;
      const result = parseUntrustedJson(text, LIMIT);
      expect(result.ok, key).toBe(true);
      const value = valueOf(result) as Record<string, unknown>;
      expect(Object.keys(value)).toEqual([key, 'nested', 'list']);
      expect(value[key]).toBe(1);
      expect((value.nested as Record<string, unknown>)[key]).toBe(2);
      expect(((value.list as unknown[])[0] as Record<string, unknown>)[key]).toBe(3);
    }
  });

  it('allows the unsafe words as values', () => {
    const text = '{"a":"__proto__","b":["constructor","prototype"],"c":{"d":"__proto__"}}';
    const result = parseUntrustedJson(text, LIMIT);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(valueOf(result))).toBe(text);
  });
});

describe('parseUntrustedJson: null-prototype results', () => {
  it('returns null-prototype objects at every level, arrays included', () => {
    const result = parseUntrustedJson(
      '{"a":{"b":[{"c":{"d":{}}},[{"e":1}]]},"f":[[{}]],"g":"text","h":null}',
      LIMIT,
    );
    const value = valueOf(result);
    const objects = objectsIn(value);
    expect(objects).toHaveLength(7);
    for (const object of objects) {
      expect(Object.getPrototypeOf(object)).toBeNull();
    }

    const root = value as Record<string, unknown>;
    expect(Array.isArray((root.a as Record<string, unknown>).b)).toBe(true);
    expect(Array.isArray(root.f)).toBe(true);
    expect(root.g).toBe('text');
    expect(root.h).toBeNull();
    expect('toString' in root).toBe(false);
    expect('hasOwnProperty' in root).toBe(false);
  });

  it('keeps every value of the parsed text', () => {
    const text = '{"s":"x","n":-1.5,"t":true,"z":null,"l":[1,"2",{"k":[false]}],"o":{"p":{}}}';
    const value = valueOf(parseUntrustedJson(text, LIMIT));
    expect(JSON.stringify(value)).toBe(text);
  });

  it('returns null-prototype objects at every level after the schema', () => {
    const schema = z.object({
      a: z.object({ b: z.array(z.object({ c: z.string() })) }),
      d: z.record(z.string(), z.object({ e: z.number() })),
    });
    const result = parseUntrustedJson(
      '{"a":{"b":[{"c":"x"},{"c":"y"}]},"d":{"k":{"e":1}},"dropped":{"q":1}}',
      { ...LIMIT, schema },
    );
    const value = valueOf(result);
    expect(JSON.parse(JSON.stringify(value))).toEqual({
      a: { b: [{ c: 'x' }, { c: 'y' }] },
      d: { k: { e: 1 } },
    });
    const objects = objectsIn(value);
    expect(objects).toHaveLength(6);
    for (const object of objects) {
      expect(Object.getPrototypeOf(object)).toBeNull();
    }
  });

  it('returns JSON primitives as they are', () => {
    expect(parseUntrustedJson('42', LIMIT)).toEqual({ ok: true, value: 42 });
    expect(parseUntrustedJson('"x"', LIMIT)).toEqual({ ok: true, value: 'x' });
    expect(parseUntrustedJson('null', LIMIT)).toEqual({ ok: true, value: null });
    expect(parseUntrustedJson('false', LIMIT)).toEqual({ ok: true, value: false });
  });
});

describe('parseUntrustedJson: failures never throw', () => {
  it.each(['', '{', '{"a":}', "{'a':1}", 'undefined', '{"a":1}x'])(
    'maps the malformed text %j to malformed',
    (text) => {
      expect(parseUntrustedJson(text, LIMIT)).toEqual({ ok: false, reason: 'malformed' });
    },
  );

  it('maps a value the schema refuses to invalid', () => {
    const schema = z.object({ a: z.number() });
    expect(parseUntrustedJson('{"a":"1"}', { ...LIMIT, schema })).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(parseUntrustedJson('[]', { ...LIMIT, schema })).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });
});

describe('parseUntrustedJson: the length check comes first', () => {
  it('accepts a text of exactly the maximum length', () => {
    const text = `{"a":"${'x'.repeat(20)}"}`;
    expect(parseUntrustedJson(text, { maxLength: text.length }).ok).toBe(true);
  });

  it('rejects a text one unit over the maximum length', () => {
    const text = `{"a":"${'x'.repeat(20)}"}`;
    expect(parseUntrustedJson(text, { maxLength: text.length - 1 })).toEqual({
      ok: false,
      reason: 'too_long',
    });
  });

  it('does not call JSON.parse for a text over the limit', () => {
    const parse = vi.spyOn(JSON, 'parse');
    const text = `[${'{"a":[1,2,3]},'.repeat(50_000)}{}]`;
    expect(parseUntrustedJson(text, { maxLength: 1_000 })).toEqual({
      ok: false,
      reason: 'too_long',
    });
    expect(parse).not.toHaveBeenCalled();

    // Control: the same spy sees the parse of a text within the limit.
    expect(parseUntrustedJson('{"a":1}', { maxLength: 1_000 }).ok).toBe(true);
    expect(parse).toHaveBeenCalled();
  });

  it('reports too_long, not malformed or unsafe_key, for a long hostile text', () => {
    const padding = 'x'.repeat(2_000);
    expect(parseUntrustedJson(`{"a":"${padding}"`, { maxLength: 1_000 })).toEqual({
      ok: false,
      reason: 'too_long',
    });
    expect(
      parseUntrustedJson(`{"__proto__":{"polluted":true},"a":"${padding}"}`, { maxLength: 1_000 }),
    ).toEqual({ ok: false, reason: 'too_long' });
  });

  it('does not run the schema for a text over the limit', () => {
    const check = vi.fn(() => true);
    const schema = z.unknown().refine(check);
    expect(parseUntrustedJson(`"${'x'.repeat(100)}"`, { maxLength: 10, schema })).toEqual({
      ok: false,
      reason: 'too_long',
    });
    expect(check).not.toHaveBeenCalled();
  });
});
