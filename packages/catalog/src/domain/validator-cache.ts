/**
 * In-process LRU cache of compiled entity validators (design D6: "an
 * in-process LRU (500 entries) keyed by `(tenantId, blueprintId, version)`.
 * Keys are immutable, so there is no invalidation logic beyond the version
 * bump."). Cache misses are reported through `onMiss`, so callers can emit
 * `catalog.schema.compile` (design D6).
 */
export interface ValidatorCacheKey {
  tenantId: string;
  blueprintId: string;
  version: number;
}

export interface ValidatorCacheOptions {
  /** Maximum number of distinct keys retained (default 500, design D6). */
  maxEntries?: number;
  onHit?: (key: ValidatorCacheKey) => void;
  onMiss?: (key: ValidatorCacheKey) => void;
}

export interface ValidatorCache<T> {
  /**
   * Returns the cached value for `key`, calling `options.onHit`; or calls
   * `compile()` exactly once, stores and returns its result, and calls
   * `options.onMiss`.
   */
  getOrCompile(key: ValidatorCacheKey, compile: () => T): T;
  readonly size: number;
}

const DEFAULT_MAX_ENTRIES = 500;

/** The immutable triple, joined with a separator that cannot appear in an identifier. */
function cacheKeyString(key: ValidatorCacheKey): string {
  return `${key.tenantId}\u0000${key.blueprintId}\u0000${String(key.version)}`;
}

/**
 * `entries`' iteration order is the LRU order: re-inserting a key on every
 * access (hit or miss) moves it to the most-recently-used end, so the first
 * key in iteration order is always the least-recently-used one.
 */
export function createValidatorCache<T>(options: ValidatorCacheOptions = {}): ValidatorCache<T> {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const entries = new Map<string, T>();

  return {
    getOrCompile(key: ValidatorCacheKey, compile: () => T): T {
      const cacheKey = cacheKeyString(key);

      if (entries.has(cacheKey)) {
        const cached = entries.get(cacheKey) as T;
        entries.delete(cacheKey);
        entries.set(cacheKey, cached);
        options.onHit?.(key);
        return cached;
      }

      const compiled = compile();
      entries.set(cacheKey, compiled);
      options.onMiss?.(key);

      if (entries.size > maxEntries) {
        const oldestKey = entries.keys().next().value;
        if (oldestKey !== undefined) entries.delete(oldestKey);
      }

      return compiled;
    },
    get size(): number {
      return entries.size;
    },
  };
}
