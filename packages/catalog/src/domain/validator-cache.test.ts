/**
 * Assumed API of `./validator-cache.js` (task 4.8):
 *
 * ```ts
 * export interface ValidatorCacheKey {
 *   tenantId: string;
 *   blueprintId: string;
 *   version: number;
 * }
 *
 * export interface ValidatorCacheOptions {
 *   maxEntries?: number; // default 500 (design D6)
 *   onHit?: (key: ValidatorCacheKey) => void;
 *   onMiss?: (key: ValidatorCacheKey) => void;
 * }
 *
 * export interface ValidatorCache<T> {
 *   getOrCompile(key: ValidatorCacheKey, compile: () => T): T;
 *   readonly size: number;
 * }
 *
 * function createValidatorCache<T>(options?: ValidatorCacheOptions): ValidatorCache<T>;
 * ```
 *
 * An in-process LRU cache of compiled entity validators, keyed by the
 * immutable triple `(tenantId, blueprintId, version)` (design D6: "Keys are
 * immutable, so there is no invalidation logic beyond the version bump").
 * `getOrCompile` looks the key up: on a hit, it calls `options.onHit(key)`
 * and returns the cached value without calling `compile`; on a miss, it
 * calls `compile()` exactly once, stores the result, calls
 * `options.onMiss(key)`, and returns it. A different `version` for the same
 * `(tenantId, blueprintId)` is a distinct key, hence always a miss the first
 * time it is looked up ("a version bump is a miss"). When the number of
 * distinct keys would exceed `maxEntries` (default 500), the least-recently
 * used entry (by `getOrCompile` access, hit or miss) is evicted first.
 */
import { describe, expect, it, vi } from 'vitest';
import { createValidatorCache, type ValidatorCacheKey } from './validator-cache.js';

function key(overrides: Partial<ValidatorCacheKey> = {}): ValidatorCacheKey {
  return { tenantId: 't1', blueprintId: 'service', version: 1, ...overrides };
}

describe('a second lookup with the same key is a hit', () => {
  it('calls compile only on the first lookup, and reports the hit/miss callbacks', () => {
    const onHit = vi.fn();
    const onMiss = vi.fn();
    const cache = createValidatorCache<string>({ onHit, onMiss });
    const compile = vi.fn(() => 'validator-v1');
    const k = key();

    const first = cache.getOrCompile(k, compile);
    const second = cache.getOrCompile(k, compile);

    expect(first).toBe('validator-v1');
    expect(second).toBe('validator-v1');
    expect(compile).toHaveBeenCalledTimes(1);
    expect(onMiss).toHaveBeenCalledTimes(1);
    expect(onMiss).toHaveBeenCalledWith(k);
    expect(onHit).toHaveBeenCalledTimes(1);
    expect(onHit).toHaveBeenCalledWith(k);
  });
});

describe('a version bump is a miss', () => {
  it('compiles again for a different version of the same blueprint', () => {
    const onMiss = vi.fn();
    const cache = createValidatorCache<string>({ onMiss });
    const compileV1 = vi.fn(() => 'validator-v1');
    const compileV2 = vi.fn(() => 'validator-v2');

    const v1 = cache.getOrCompile(key({ version: 1 }), compileV1);
    const v2 = cache.getOrCompile(key({ version: 2 }), compileV2);

    expect(v1).toBe('validator-v1');
    expect(v2).toBe('validator-v2');
    expect(compileV1).toHaveBeenCalledTimes(1);
    expect(compileV2).toHaveBeenCalledTimes(1);
    expect(onMiss).toHaveBeenCalledTimes(2);
  });

  it('treats a different tenantId or blueprintId as a distinct key too', () => {
    const cache = createValidatorCache<string>();

    cache.getOrCompile(key({ tenantId: 't1' }), () => 'a');
    const compileForT2 = vi.fn(() => 'b');
    const forT2 = cache.getOrCompile(key({ tenantId: 't2' }), compileForT2);

    expect(forT2).toBe('b');
    expect(compileForT2).toHaveBeenCalledTimes(1);
  });
});

describe('eviction happens at 500 entries (design D6, LRU 500)', () => {
  it('evicts the least-recently-used entry once the 501st distinct key is inserted', () => {
    const cache = createValidatorCache<string>();

    for (let index = 0; index < 500; index += 1) {
      cache.getOrCompile(key({ blueprintId: `bp-${String(index)}` }), () => `v-${String(index)}`);
    }
    expect(cache.size).toBe(500);

    // Insert one more distinct key without touching any existing one first:
    // the least-recently-used entry is the very first one inserted (bp-0).
    cache.getOrCompile(key({ blueprintId: 'bp-500' }), () => 'v-500');
    expect(cache.size).toBe(500);

    const recompileBp0 = vi.fn(() => 'v-0-recompiled');
    const result = cache.getOrCompile(key({ blueprintId: 'bp-0' }), recompileBp0);

    expect(result).toBe('v-0-recompiled');
    expect(recompileBp0).toHaveBeenCalledTimes(1);
  });

  it('does not evict an entry that was accessed more recently than the one evicted', () => {
    const cache = createValidatorCache<string>();

    for (let index = 0; index < 500; index += 1) {
      cache.getOrCompile(key({ blueprintId: `bp-${String(index)}` }), () => `v-${String(index)}`);
    }
    cache.getOrCompile(key({ blueprintId: 'bp-500' }), () => 'v-500');

    const stillCached = vi.fn(() => 'v-499-recompiled');
    const result = cache.getOrCompile(key({ blueprintId: 'bp-499' }), stillCached);

    expect(result).toBe('v-499');
    expect(stillCached).not.toHaveBeenCalled();
  });
});
