/**
 * Assumed API of `./relation-values.js` (task 4.3):
 *
 * ```ts
 * export type RelationScope = 'spec' | 'status';
 *
 * export interface ValidateRelationValuesOptions {
 *   limits?: CatalogLimits; // ./limits.js
 *   path?: string;          // default `/${scope}/relations`
 * }
 *
 * function validateRelationValues(
 *   definitions: Record<string, RelationDefinition>, // ./relation-definition.js
 *   input: unknown,
 *   scope: RelationScope,
 *   options?: ValidateRelationValuesOptions,
 * ): Record<string, string | string[]>;
 * ```
 *
 * Validates the *shape* of a `spec.relations` or `status.relations` bag
 * against the blueprint's relation definitions (spec, "Entity relations and
 * referential integrity"; "Status is written only through the status
 * operation"). Referential *existence* of a target identifier is never
 * checked here - that needs the database (`CATALOG_REFERENCE_VIOLATION`,
 * checked by the service layer in task 8.2). `path` defaults to
 * `/${scope}/relations`; an issue for relation `<name>` is reported at
 * `${path}/<name>`.
 *
 * Rules:
 * - A key in `input` that is not present in `definitions` is rejected
 *   (undeclared relation key), `CATALOG_VALIDATION_FAILED`.
 * - `many: false`: the value MUST be a single string identifier. Any other
 *   shape (in particular an array) is "Wrong cardinality",
 *   `CATALOG_VALIDATION_FAILED`.
 * - `many: true`: the value MUST be an array of unique string identifiers,
 *   in the given order, of at most `limits.relation.maxManyTargets` (1000)
 *   entries. A non-array value is "Wrong cardinality"
 *   (`CATALOG_VALIDATION_FAILED`); a duplicate entry is
 *   `CATALOG_VALIDATION_FAILED`; more than `limits.relation.maxManyTargets`
 *   entries is `CATALOG_LIMIT_EXCEEDED` naming `relation.maxManyTargets`
 *   ("Too many relation targets").
 * - `required: true` (always single-valued) is enforced only when
 *   `scope === 'spec'`. A missing value throws `CATALOG_VALIDATION_FAILED`
 *   at `${path}/<name>` ("Missing required relation"). When
 *   `scope === 'status'`, a `required` relation MAY be omitted (spec:
 *   "except that `required` does not apply").
 * - A relation absent from `input` and not required for this scope is
 *   simply absent from the result.
 * - The result maps every given relation identifier to its validated value,
 *   unchanged (the string, or the array with its original order preserved).
 */
import { describe, expect, it } from 'vitest';
import { validateRelationValues } from './relation-values.js';
import { isCatalogError, type CatalogErrorCode } from './errors.js';
import { defaultCatalogLimits } from './limits.js';
import type { RelationDefinition } from './relation-definition.js';

function relation(overrides: Partial<RelationDefinition> = {}): RelationDefinition {
  return { title: { en: 'Owner' }, target: 'team', many: false, required: false, ...overrides };
}

function expectRejectedCode(run: () => unknown, code: CatalogErrorCode, issuePath?: string): void {
  try {
    run();
    expect.unreachable('validateRelationValues should have thrown');
  } catch (error) {
    expect(isCatalogError(error)).toBe(true);
    if (!isCatalogError(error)) throw error;
    expect(error.code).toBe(code);
    if (issuePath) {
      expect(error.issues?.some((issue) => issue.path === issuePath)).toBe(true);
    }
  }
}

describe('"Missing required relation"', () => {
  it('rejects a required spec relation that is missing, at /spec/relations/owner', () => {
    const definitions = { owner: relation({ required: true }) };

    expectRejectedCode(
      () => validateRelationValues(definitions, {}, 'spec'),
      'CATALOG_VALIDATION_FAILED',
      '/spec/relations/owner',
    );
  });

  it('required does not apply to status: a missing required-looking relation is accepted', () => {
    const definitions = { owner: relation({ required: true }) };

    expect(validateRelationValues(definitions, {}, 'status')).toEqual({});
  });
});

describe('"Wrong cardinality"', () => {
  it('rejects an array value for a many: false relation', () => {
    const definitions = { owner: relation({ many: false }) };

    expectRejectedCode(
      () => validateRelationValues(definitions, { owner: ['team-a', 'team-b'] }, 'spec'),
      'CATALOG_VALIDATION_FAILED',
    );
  });

  it('rejects a single string value for a many: true relation', () => {
    const definitions = { dependsOn: relation({ many: true, required: false, target: 'service' }) };

    expectRejectedCode(
      () => validateRelationValues(definitions, { dependsOn: 'ledger' }, 'spec'),
      'CATALOG_VALIDATION_FAILED',
    );
  });
});

describe('"Too many relation targets"', () => {
  const definitions = { dependsOn: relation({ many: true, required: false, target: 'service' }) };

  it('rejects 1001 targets with CATALOG_LIMIT_EXCEEDED naming relation.maxManyTargets', () => {
    expect(defaultCatalogLimits.relation.maxManyTargets).toBe(1000);
    const targets = Array.from({ length: 1001 }, (_, index) => `e${String(index)}`);

    try {
      validateRelationValues(definitions, { dependsOn: targets }, 'spec');
      expect.unreachable('validateRelationValues should have thrown');
    } catch (error) {
      expect(isCatalogError(error)).toBe(true);
      if (!isCatalogError(error)) throw error;
      expect(error.code).toBe('CATALOG_LIMIT_EXCEEDED');
      expect(error.details).toMatchObject({ limit: 'relation.maxManyTargets' });
    }
  });

  it('accepts exactly 1000 targets (boundary)', () => {
    const targets = Array.from({ length: 1000 }, (_, index) => `e${String(index)}`);

    expect(validateRelationValues(definitions, { dependsOn: targets }, 'spec')).toEqual({
      dependsOn: targets,
    });
  });
});

describe('duplicate targets within a many relation are rejected', () => {
  it('rejects a repeated target identifier', () => {
    const definitions = { dependsOn: relation({ many: true, required: false, target: 'service' }) };

    expectRejectedCode(
      () => validateRelationValues(definitions, { dependsOn: ['ledger', 'ledger'] }, 'spec'),
      'CATALOG_VALIDATION_FAILED',
    );
  });
});

describe('undeclared relation keys are rejected', () => {
  it("rejects a key absent from the blueprint's relation definitions", () => {
    const definitions = { owner: relation() };

    expectRejectedCode(
      () => validateRelationValues(definitions, { ghost: 'x' }, 'spec'),
      'CATALOG_VALIDATION_FAILED',
    );
  });
});

describe('well-formed relation values are accepted unchanged', () => {
  it('accepts a single-valued relation', () => {
    const definitions = { owner: relation({ many: false }) };

    expect(validateRelationValues(definitions, { owner: 'team-a' }, 'spec')).toEqual({
      owner: 'team-a',
    });
  });

  it('"Many relation keeps order": accepts a many relation and preserves the given order', () => {
    const definitions = { dependsOn: relation({ many: true, required: false, target: 'service' }) };

    expect(validateRelationValues(definitions, { dependsOn: ['ledger', 'auth'] }, 'spec')).toEqual({
      dependsOn: ['ledger', 'auth'],
    });
  });

  it('a relation absent from input and not required is simply absent from the result', () => {
    const definitions = { owner: relation({ required: false }) };

    expect(validateRelationValues(definitions, {}, 'spec')).toEqual({});
  });
});
