/**
 * `CatalogLimits` (design D8): every spec default from the Conventions
 * "Default limits" table, in one object. `mergeCatalogLimits` deep-merges
 * validated deployment overrides onto the defaults. Limits are checked
 * before any expensive work (schema compilation or database writes).
 */
import { CatalogError } from './errors.js';

const KIB = 1024;

/** Blueprint, property and relation identifiers (spec Conventions). */
const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** Entity identifiers (spec Conventions). */
const ENTITY_IDENTIFIER_PATTERN = /^[A-Za-z0-9@_.:/=-]{1,256}$/;

export interface CatalogLimits {
  identifier: { pattern: RegExp };
  entityIdentifier: { pattern: RegExp };
  localizedText: { title: { maxLength: number }; description: { maxLength: number } };
  blueprint: { maxProperties: number; maxRelations: number; maxBytes: number };
  relation: { maxManyTargets: number };
  entity: { specMaxBytes: number; statusMaxBytes: number };
  pattern: { maxLength: number };
  pagination: { defaultPageSize: number; maxPageSize: number };
  enum: { maxEntries: number };
  object: { maxNestingDepth: number };
  icon: { maxLength: number };
  formattedString: { maxLength: number };
  statusSource: { pattern: RegExp };
  detach: { maxReferrers: number };
  cursor: { maxLength: number };
}

/** A deep-partial override tree, `RegExp` leaves left as-is (never recursed into). */
export type DeepPartialCatalogLimits = {
  [K in keyof CatalogLimits]?: CatalogLimits[K] extends { pattern: RegExp }
    ? CatalogLimits[K]
    : { [F in keyof CatalogLimits[K]]?: CatalogLimits[K][F] };
};

export const defaultCatalogLimits: CatalogLimits = {
  identifier: { pattern: IDENTIFIER_PATTERN },
  entityIdentifier: { pattern: ENTITY_IDENTIFIER_PATTERN },
  localizedText: { title: { maxLength: 256 }, description: { maxLength: 4096 } },
  blueprint: { maxProperties: 200, maxRelations: 50, maxBytes: 256 * KIB },
  relation: { maxManyTargets: 1000 },
  entity: { specMaxBytes: 256 * KIB, statusMaxBytes: 256 * KIB },
  pattern: { maxLength: 512 },
  pagination: { defaultPageSize: 50, maxPageSize: 500 },
  enum: { maxEntries: 500 },
  object: { maxNestingDepth: 16 },
  icon: { maxLength: 64 },
  formattedString: { maxLength: 2048 },
  statusSource: { pattern: IDENTIFIER_PATTERN },
  detach: { maxReferrers: 1000 },
  cursor: { maxLength: 512 },
};

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function invalidOverride(path: string): never {
  throw new CatalogError('CATALOG_VALIDATION_FAILED', 'Limit override is invalid', {
    issues: [{ path, message: 'Limit override must be a positive integer' }],
  });
}

/** Recursively merges `override` onto `base`, validating every numeric leaf. */
function mergeNode(base: unknown, override: unknown, path: string): unknown {
  if (override === undefined) return base;

  if (base instanceof RegExp) return base;

  if (typeof base === 'number') {
    if (!isPositiveInteger(override)) invalidOverride(path);
    return override;
  }

  if (typeof base === 'object' && base !== null && typeof override === 'object' && override !== null) {
    const merged: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const key of Object.keys(override)) {
      merged[key] = mergeNode(
        (base as Record<string, unknown>)[key],
        (override as Record<string, unknown>)[key],
        `${path}/${key}`,
      );
    }
    return merged;
  }

  return override;
}

/** Deep-merges validated `overrides` onto `defaultCatalogLimits`. */
export function mergeCatalogLimits(overrides?: DeepPartialCatalogLimits): CatalogLimits {
  if (!overrides) return defaultCatalogLimits;
  return mergeNode(defaultCatalogLimits, overrides, '') as CatalogLimits;
}
