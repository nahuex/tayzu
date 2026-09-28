/**
 * Assumed API of `./entity-limits.js` (task 4.6). Named `entity-limits.js`
 * (rather than `limits.js`, taken by task 2.5's `CatalogLimits`):
 *
 * ```ts
 * function assertEntitySpecSize(spec: unknown, limits?: CatalogLimits): void;
 * function assertEntityStatusSize(status: unknown, limits?: CatalogLimits): void;
 *
 * function compileWithSizeGuard<T>(
 *   value: unknown,
 *   scope: 'spec' | 'status',
 *   compile: () => T,
 *   limits?: CatalogLimits,
 * ): T;
 * ```
 *
 * Enforces the "Serialized `spec` or `status` of one entity" byte limit
 * (spec Conventions, 256 KiB; spec "Limits protect the catalog": "Limits
 * MUST be checked before any expensive work"; design D8: byte size is the
 * very first check, run before counts, schema compilation, or the
 * database).
 *
 * `assertEntitySpecSize` / `assertEntityStatusSize` measure
 * `Buffer.byteLength(JSON.stringify(value))` and throw
 * `CatalogError('CATALOG_LIMIT_EXCEEDED', ..., { details: { limit:
 * 'entity.spec.maxBytes' | 'entity.status.maxBytes' } })` when it exceeds
 * `limits.entity.specMaxBytes` / `limits.entity.statusMaxBytes` ("Oversized
 * spec is rejected", naming `entity.spec.maxBytes`). They do nothing (no
 * return value) when the value is within the limit.
 *
 * `compileWithSizeGuard` composes the size check for `scope` with a
 * caller-supplied `compile` callback that stands in for schema compilation
 * (design D8's "Schema compilation" step, later than size checks). It
 * throws the same `CATALOG_LIMIT_EXCEEDED` error *before ever calling*
 * `compile` when the size limit is exceeded, and otherwise calls `compile`
 * exactly once and returns its result unchanged. This lets a test spy on
 * `compile` and prove the compiler is never invoked for oversized input.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  assertEntitySpecSize,
  assertEntityStatusSize,
  compileWithSizeGuard,
} from './entity-limits.js';
import { isCatalogError } from './errors.js';
import { defaultCatalogLimits } from './limits.js';

const KIB = 1024;

function oversizedSpec(): { properties: { blob: string } } {
  // Comfortably over the 256 KiB default (`entity.specMaxBytes`).
  return { properties: { blob: 'a'.repeat(300 * KIB) } };
}

function smallSpec(): { properties: { language: string } } {
  return { properties: { language: 'go' } };
}

describe('"Oversized spec is rejected"', () => {
  it('rejects a serialized spec over 256 KiB with CATALOG_LIMIT_EXCEEDED naming entity.spec.maxBytes', () => {
    expect(defaultCatalogLimits.entity.specMaxBytes).toBe(256 * KIB);

    try {
      assertEntitySpecSize(oversizedSpec());
      expect.unreachable('assertEntitySpecSize should have thrown');
    } catch (error) {
      expect(isCatalogError(error)).toBe(true);
      if (!isCatalogError(error)) throw error;
      expect(error.code).toBe('CATALOG_LIMIT_EXCEEDED');
      expect(error.details).toMatchObject({ limit: 'entity.spec.maxBytes' });
    }
  });

  it('does not throw for a spec within the limit', () => {
    expect(() => assertEntitySpecSize(smallSpec())).not.toThrow();
  });

  it('rejects an oversized status with CATALOG_LIMIT_EXCEEDED naming entity.status.maxBytes', () => {
    expect(defaultCatalogLimits.entity.statusMaxBytes).toBe(256 * KIB);

    try {
      assertEntityStatusSize({ properties: { blob: 'a'.repeat(300 * KIB) } });
      expect.unreachable('assertEntityStatusSize should have thrown');
    } catch (error) {
      expect(isCatalogError(error)).toBe(true);
      if (!isCatalogError(error)) throw error;
      expect(error.code).toBe('CATALOG_LIMIT_EXCEEDED');
      expect(error.details).toMatchObject({ limit: 'entity.status.maxBytes' });
    }
  });
});

describe('size limits are evaluated before validation or compilation', () => {
  it('never calls the compiler for an oversized spec, and still throws CATALOG_LIMIT_EXCEEDED', () => {
    const compile = vi.fn(() => 'compiled-validator');

    try {
      compileWithSizeGuard(oversizedSpec(), 'spec', compile);
      expect.unreachable('compileWithSizeGuard should have thrown');
    } catch (error) {
      expect(isCatalogError(error)).toBe(true);
      if (!isCatalogError(error)) throw error;
      expect(error.code).toBe('CATALOG_LIMIT_EXCEEDED');
      expect(error.details).toMatchObject({ limit: 'entity.spec.maxBytes' });
    }

    expect(compile).not.toHaveBeenCalled();
  });

  it('calls the compiler exactly once and returns its result for an in-limit spec', () => {
    const compile = vi.fn(() => 'compiled-validator');

    const result = compileWithSizeGuard(smallSpec(), 'spec', compile);

    expect(result).toBe('compiled-validator');
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it('applies the status limit (and naming) when scope is "status"', () => {
    const compile = vi.fn(() => 'compiled-validator');

    try {
      compileWithSizeGuard({ properties: { blob: 'a'.repeat(300 * KIB) } }, 'status', compile);
      expect.unreachable('compileWithSizeGuard should have thrown');
    } catch (error) {
      expect(isCatalogError(error)).toBe(true);
      if (!isCatalogError(error)) throw error;
      expect(error.details).toMatchObject({ limit: 'entity.status.maxBytes' });
    }

    expect(compile).not.toHaveBeenCalled();
  });
});
