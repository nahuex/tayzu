/**
 * Untrusted input in the browser (design D15, Q65).
 *
 * Every response, search param and fragment value that the app parses goes
 * through `parseUntrustedJson`: the length is checked before any parsing,
 * `__proto__`, `constructor` and `prototype` are refused as keys at every
 * depth, an optional Zod schema runs last, and the result is rebuilt into
 * null-prototype objects. Nothing here throws. The server-side equivalent is
 * `packages/catalog/src/domain/safe-parse.ts`.
 */
import type { z } from 'zod';

export type UntrustedFailure = 'too_long' | 'malformed' | 'unsafe_key' | 'invalid';

export type UntrustedResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: UntrustedFailure };

export interface ParseUntrustedOptions<T> {
  /** Maximum `text.length` (UTF-16 code units), checked before anything else. */
  readonly maxLength: number;
  /** Runs after the length check, `JSON.parse` and the unsafe-key walk. */
  readonly schema?: z.ZodType<T>;
}

const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

type Container = unknown[] | Record<string, unknown>;

/** An array, or an object whose prototype is `Object.prototype` or `null`. */
function isContainer(value: unknown): value is Container {
  if (typeof value !== 'object' || value === null) return false;
  if (Array.isArray(value)) return true;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * True when an own key of any object reachable from `value` is unsafe.
 * Iterative, so a deeply nested text cannot overflow the stack.
 */
function hasUnsafeKey(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!isContainer(current)) continue;
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    for (const key of Object.keys(current)) {
      if (UNSAFE_KEYS.has(key)) return true;
      pending.push(current[key]);
    }
  }
  return false;
}

/** An empty container of the same kind as `value`, or `value` itself. */
function emptyCopyOf(value: unknown): unknown {
  if (!isContainer(value)) return value;
  return Array.isArray(value) ? [] : (Object.create(null) as Record<string, unknown>);
}

/**
 * Copies `value` so that every plain object at every level has a null
 * prototype; arrays stay arrays and other values are kept as they are.
 * Iterative, like `hasUnsafeKey`.
 */
export function toNullPrototype<T>(value: T): T {
  const root = emptyCopyOf(value);
  const pending: [Container, Container][] = [];
  if (isContainer(value)) pending.push([value, root as Container]);
  for (let pair = pending.pop(); pair !== undefined; pair = pending.pop()) {
    const [source, target] = pair;
    const keys = Array.isArray(source) ? source.keys() : Object.keys(source);
    for (const key of keys) {
      const nested: unknown = (source as Record<string | number, unknown>)[key];
      const copy = emptyCopyOf(nested);
      (target as Record<string | number, unknown>)[key] = copy;
      if (isContainer(nested)) pending.push([nested, copy as Container]);
    }
  }
  return root as T;
}

/** Parses untrusted JSON text; see the module comment for the order of checks. */
export function parseUntrustedJson<T = unknown>(
  text: string,
  options: ParseUntrustedOptions<T>,
): UntrustedResult<T> {
  if (text.length > options.maxLength) return { ok: false, reason: 'too_long' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (hasUnsafeKey(parsed)) return { ok: false, reason: 'unsafe_key' };

  if (options.schema === undefined) return { ok: true, value: toNullPrototype(parsed as T) };
  try {
    const result = options.schema.safeParse(parsed);
    return result.success
      ? { ok: true, value: toNullPrototype(result.data) }
      : { ok: false, reason: 'invalid' };
  } catch {
    // An async refinement or a throwing check: the value is not accepted.
    return { ok: false, reason: 'invalid' };
  }
}
