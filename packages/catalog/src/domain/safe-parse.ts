/**
 * Safe input parsing (design D9): rebuild every plain object in untrusted
 * input as a null-prototype object, reject `__proto__`, `constructor` and
 * `prototype` as an own key at every depth, and enforce the object-nesting
 * depth limit before any further validation runs.
 */
import { CatalogError } from './errors.js';
import { defaultCatalogLimits } from './limits.js';

export interface ParseSafeInputOptions {
  maxDepth?: number;
}

/** Rejected in every key position of catalog input (spec Conventions, "Unsafe keys"). */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnsafeKey(path: string): never {
  throw new CatalogError('CATALOG_VALIDATION_FAILED', 'Input contains an unsafe key', {
    issues: [{ path, message: 'Input contains an unsafe key' }],
  });
}

function rejectDepthExceeded(): never {
  throw new CatalogError('CATALOG_LIMIT_EXCEEDED', 'Object nesting depth exceeded', {
    details: { limit: 'object.maxNestingDepth' },
  });
}

function walk(value: unknown, path: string, depth: number, maxDepth: number): unknown {
  if (Array.isArray(value)) {
    if (depth >= maxDepth) rejectDepthExceeded();
    return value.map((item, index) => walk(item, `${path}/${String(index)}`, depth + 1, maxDepth));
  }

  if (!isPlainObject(value)) return value;

  if (depth >= maxDepth) rejectDepthExceeded();

  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (UNSAFE_KEYS.has(key)) rejectUnsafeKey(`${path}/${key}`);
    result[key] = walk(value[key], `${path}/${key}`, depth + 1, maxDepth);
  }
  return result;
}

/**
 * Rebuilds `value` as null-prototype objects, recursively, including array
 * elements and keys nested inside `object`-typed values. `options.maxDepth`
 * defaults to the spec's default object-nesting-depth limit.
 */
export function parseSafeInput(value: unknown, options?: ParseSafeInputOptions): unknown {
  const maxDepth = options?.maxDepth ?? defaultCatalogLimits.object.maxNestingDepth;
  return walk(value, '', 0, maxDepth);
}
