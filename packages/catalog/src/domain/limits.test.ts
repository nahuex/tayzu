/**
 * Assumed API of `./limits.js` (task 2.5):
 *
 * ```ts
 * interface CatalogLimits {
 *   identifier: { pattern: RegExp };                          // blueprint/property/relation identifiers
 *   entityIdentifier: { pattern: RegExp };
 *   localizedText: { title: { maxLength: number }; description: { maxLength: number } };
 *   blueprint: { maxProperties: number; maxRelations: number; maxBytes: number };
 *   relation: { maxManyTargets: number };
 *   entity: { specMaxBytes: number; statusMaxBytes: number };
 *   pattern: { maxLength: number };
 *   pagination: { defaultPageSize: number; maxPageSize: number };
 *   enum: { maxEntries: number };
 *   object: { maxNestingDepth: number };
 *   icon: { maxLength: number };
 *   formattedString: { maxLength: number };
 *   statusSource: { pattern: RegExp };
 *   detach: { maxReferrers: number };
 *   cursor: { maxLength: number };
 * }
 *
 * const defaultCatalogLimits: CatalogLimits;
 *
 * function mergeCatalogLimits(overrides?: DeepPartial<CatalogLimits>): CatalogLimits;
 * ```
 *
 * `mergeCatalogLimits` deep-merges validated overrides onto
 * `defaultCatalogLimits`. Every numeric leaf MUST be a positive, finite
 * integer; any other value (for example a negative number) throws
 * `CatalogError('CATALOG_VALIDATION_FAILED', ..., { issues: [{ path,
 * message }] })`, with `path` being the JSON Pointer of the offending field
 * (for example `/blueprint/maxProperties`).
 *
 * Every numeric field below is taken verbatim from the spec Conventions
 * "Default limits" table. `identifier.pattern` and `entityIdentifier.pattern`
 * are the two identifier patterns from the same Conventions section;
 * `statusSource.pattern` reuses the blueprint identifier pattern ("Status
 * `source` label: blueprint identifier pattern").
 */
import { describe, expect, it } from 'vitest';
import { defaultCatalogLimits, mergeCatalogLimits } from './limits.js';
import { isCatalogError } from './errors.js';

const KIB = 1024;

describe('defaultCatalogLimits', () => {
  it('uses the blueprint/property/relation identifier pattern', () => {
    expect(defaultCatalogLimits.identifier.pattern.source).toBe('^[A-Za-z][A-Za-z0-9_-]{0,63}$');
  });

  it('uses the entity identifier pattern', () => {
    expect(defaultCatalogLimits.entityIdentifier.pattern.source).toBe(
      '^[A-Za-z0-9@_.:/=-]{1,256}$',
    );
  });

  it('sets the per-locale localized-text length limits (256 titles, 4096 descriptions)', () => {
    expect(defaultCatalogLimits.localizedText.title.maxLength).toBe(256);
    expect(defaultCatalogLimits.localizedText.description.maxLength).toBe(4096);
  });

  it('sets the blueprint property/relation counts and the blueprint size', () => {
    expect(defaultCatalogLimits.blueprint.maxProperties).toBe(200);
    expect(defaultCatalogLimits.blueprint.maxRelations).toBe(50);
    expect(defaultCatalogLimits.blueprint.maxBytes).toBe(256 * KIB);
  });

  it('sets the many-relation target limit', () => {
    expect(defaultCatalogLimits.relation.maxManyTargets).toBe(1000);
  });

  it('sets the entity spec/status size limit to 256 KiB', () => {
    expect(defaultCatalogLimits.entity.specMaxBytes).toBe(256 * KIB);
    expect(defaultCatalogLimits.entity.statusMaxBytes).toBe(256 * KIB);
  });

  it('sets the pattern keyword length limit to 512', () => {
    expect(defaultCatalogLimits.pattern.maxLength).toBe(512);
  });

  it('sets the list page size defaults (default 50, max 500)', () => {
    expect(defaultCatalogLimits.pagination.defaultPageSize).toBe(50);
    expect(defaultCatalogLimits.pagination.maxPageSize).toBe(500);
  });

  it('sets the enum entries limit to 500', () => {
    expect(defaultCatalogLimits.enum.maxEntries).toBe(500);
  });

  it('sets the object nesting depth limit to 16', () => {
    expect(defaultCatalogLimits.object.maxNestingDepth).toBe(16);
  });

  it('sets the icon length limit to 64', () => {
    expect(defaultCatalogLimits.icon.maxLength).toBe(64);
  });

  it('sets the formatted-string length limit to 2048', () => {
    expect(defaultCatalogLimits.formattedString.maxLength).toBe(2048);
  });

  it('reuses the blueprint identifier pattern for the status source label', () => {
    expect(defaultCatalogLimits.statusSource.pattern.source).toBe(
      defaultCatalogLimits.identifier.pattern.source,
    );
  });

  it('sets the detach-on-delete referrer limit to 1000', () => {
    expect(defaultCatalogLimits.detach.maxReferrers).toBe(1000);
  });

  it('sets the pagination cursor length limit to 512', () => {
    expect(defaultCatalogLimits.cursor.maxLength).toBe(512);
  });
});

describe('mergeCatalogLimits', () => {
  it('returns the defaults unchanged when no override is given', () => {
    expect(mergeCatalogLimits()).toEqual(defaultCatalogLimits);
  });

  it('applies a valid override while preserving every other default', () => {
    const merged = mergeCatalogLimits({ blueprint: { maxProperties: 300 } });

    expect(merged.blueprint.maxProperties).toBe(300);
    expect(merged.blueprint.maxRelations).toBe(defaultCatalogLimits.blueprint.maxRelations);
    expect(merged.entity).toEqual(defaultCatalogLimits.entity);
  });

  it('rejects a negative override value', () => {
    try {
      mergeCatalogLimits({ blueprint: { maxProperties: -1 } });
      expect.unreachable('mergeCatalogLimits should have thrown');
    } catch (error) {
      expect(isCatalogError(error)).toBe(true);
      if (!isCatalogError(error)) throw error;
      expect(error.code).toBe('CATALOG_VALIDATION_FAILED');
      expect(error.issues?.[0]).toMatchObject({ path: '/blueprint/maxProperties' });
    }
  });
});
