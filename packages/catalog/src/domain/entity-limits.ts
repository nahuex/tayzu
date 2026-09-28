/**
 * Entity `spec`/`status` size limits (spec Conventions: "Serialized `spec`
 * or `status` of one entity", 256 KiB; spec "Limits protect the catalog":
 * "Limits MUST be checked before any expensive work"; design D8: byte size
 * is the very first check, run before counts, schema compilation, or the
 * database).
 */
import { CatalogError } from './errors.js';
import { defaultCatalogLimits, type CatalogLimits } from './limits.js';

type EntitySizeLimitName = 'entity.spec.maxBytes' | 'entity.status.maxBytes';

function assertSize(value: unknown, maxBytes: number, limit: EntitySizeLimitName): void {
  const size = Buffer.byteLength(JSON.stringify(value));
  if (size > maxBytes) {
    throw new CatalogError('CATALOG_LIMIT_EXCEEDED', 'Entity value exceeds the size limit', {
      details: { limit },
    });
  }
}

/** Rejects a `spec` whose serialized size exceeds `limits.entity.specMaxBytes`. */
export function assertEntitySpecSize(spec: unknown, limits: CatalogLimits = defaultCatalogLimits): void {
  assertSize(spec, limits.entity.specMaxBytes, 'entity.spec.maxBytes');
}

/** Rejects a `status` whose serialized size exceeds `limits.entity.statusMaxBytes`. */
export function assertEntityStatusSize(status: unknown, limits: CatalogLimits = defaultCatalogLimits): void {
  assertSize(status, limits.entity.statusMaxBytes, 'entity.status.maxBytes');
}

/**
 * Enforces the size limit for `scope` before calling `compile` (design D8's
 * "Schema compilation" step, later than size checks). Throws before ever
 * calling `compile` when the size limit is exceeded; otherwise calls
 * `compile` exactly once and returns its result unchanged.
 */
export function compileWithSizeGuard<T>(
  value: unknown,
  scope: 'spec' | 'status',
  compile: () => T,
  limits: CatalogLimits = defaultCatalogLimits,
): T {
  if (scope === 'spec') assertEntitySpecSize(value, limits);
  else assertEntityStatusSize(value, limits);
  return compile();
}
