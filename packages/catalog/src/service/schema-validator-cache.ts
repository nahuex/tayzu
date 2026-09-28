/**
 * Wires `domain/validator-cache.ts`'s pure LRU into the entity-validation and
 * blueprint-compatibility paths (task 4.8; design D6: "an in-process LRU (500
 * entries) keyed by `(tenantId, blueprintId, version)`. ... Cache misses emit
 * `catalog.schema.compile`"). The cache itself is pure and I/O-free
 * (`domain/`), so the telemetry this module adds around it -- the child span
 * on a miss, the compile-duration histogram, and the hit/miss counter --
 * lives here, in `service/`, instead.
 *
 * Two module-level cache instances, not one: a blueprint's `spec` and
 * `status` schemas compile to two different validators even at the same
 * `(tenantId, blueprintId, version)`, so they cannot share a single cache
 * keyed only by that triple.
 */
import { compileEntityValidator, type EntityPropertyValidator } from '../domain/entity-validator.js';
import type { ParsedPropertySchema } from '../domain/blueprint-definition.js';
import type { CatalogLimits } from '../domain/limits.js';
import { createValidatorCache, type ValidatorCacheKey } from '../domain/validator-cache.js';
import { schemaCacheLookupsCounter, schemaCompileDurationHistogram, tracer } from '../telemetry/instruments.js';

const BLUEPRINT_IDENTIFIER_ATTRIBUTE = 'tayzu.catalog.blueprint.identifier';
const BLUEPRINT_VERSION_ATTRIBUTE = 'tayzu.catalog.blueprint.version';
const CACHE_RESULT_ATTRIBUTE = 'tayzu.cache.result';

/** design.md, Metrics table: `tayzu.catalog.schema.cache.lookups`, `tayzu.cache.result` (`hit`|`miss`). */
function recordCacheLookup(result: 'hit' | 'miss'): void {
  schemaCacheLookupsCounter.add(1, { [CACHE_RESULT_ATTRIBUTE]: result });
}

const specValidatorCache = createValidatorCache<EntityPropertyValidator>({
  onHit: () => {
    recordCacheLookup('hit');
  },
  onMiss: () => {
    recordCacheLookup('miss');
  },
});
const statusValidatorCache = createValidatorCache<EntityPropertyValidator>({
  onHit: () => {
    recordCacheLookup('hit');
  },
  onMiss: () => {
    recordCacheLookup('miss');
  },
});

/** design.md, Spans table: `catalog.schema.compile` (child, on a cache miss only), plus `tayzu.catalog.schema.compile.duration`. */
function compileWithTelemetry(
  key: ValidatorCacheKey,
  schema: ParsedPropertySchema,
  limits: CatalogLimits,
): EntityPropertyValidator {
  return tracer.startActiveSpan('catalog.schema.compile', (span) => {
    span.setAttribute(BLUEPRINT_IDENTIFIER_ATTRIBUTE, key.blueprintId);
    span.setAttribute(BLUEPRINT_VERSION_ATTRIBUTE, key.version);
    const startedAtMillis = Date.now();
    try {
      return compileEntityValidator(schema, limits);
    } finally {
      schemaCompileDurationHistogram.record((Date.now() - startedAtMillis) / 1000);
      span.end();
    }
  });
}

/** The `schema` (spec) validator for `key`, compiled and cached (design D6). */
export function getCachedSpecValidator(
  key: ValidatorCacheKey,
  schema: ParsedPropertySchema,
  limits: CatalogLimits,
): EntityPropertyValidator {
  return specValidatorCache.getOrCompile(key, () => compileWithTelemetry(key, schema, limits));
}

/** The `statusSchema` validator for `key`, compiled and cached (design D6). */
export function getCachedStatusValidator(
  key: ValidatorCacheKey,
  schema: ParsedPropertySchema,
  limits: CatalogLimits,
): EntityPropertyValidator {
  return statusValidatorCache.getOrCompile(key, () => compileWithTelemetry(key, schema, limits));
}
