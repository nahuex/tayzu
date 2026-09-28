/**
 * Assumed API of `./relation-definition.js` (task 3.5):
 *
 * ```ts
 * export interface RelationDefinition {
 *   title: LocalizedText;
 *   target: string;     // a blueprint identifier; existence is NOT checked here
 *   many: boolean;       // default false
 *   required: boolean;   // default false
 * }
 *
 * function parseRelationDefinition(value: unknown, path: string): RelationDefinition;
 * ```
 *
 * Validates the shape of one relation definition (spec, "Relation
 * definitions"). `path` is the JSON Pointer of the relation definition
 * itself (for example `/relations/owner`). `title` is a required localized
 * text (`./localized-text.js`, issues at `${path}/title/en`,
 * `${path}/title/<locale>`). `target` is validated only as a well-formed
 * blueprint identifier (`./identifiers.js`'s `parseBlueprintIdentifier`,
 * issue at `${path}/target`) - the pure parser never checks that the target
 * blueprint actually exists in the tenant, since that needs the database
 * (`CATALOG_REFERENCE_VIOLATION`, checked by the service layer in task 7.1).
 * `many` and `required` each default to `false` when omitted from the
 * input. A definition with both `many: true` and `required: true` throws
 * `CatalogError('CATALOG_VALIDATION_FAILED', ..., { issues: [{ path,
 * message }] })`.
 */
import { describe, expect, it } from 'vitest';
import { parseRelationDefinition } from './relation-definition.js';
import { isCatalogError } from './errors.js';

const PATH = '/relations/owner';
const TITLE = { en: 'Owner' };

function expectRejected(value: unknown, issuePath?: string): void {
  try {
    parseRelationDefinition(value, PATH);
    expect.unreachable('parseRelationDefinition should have thrown');
  } catch (error) {
    expect(isCatalogError(error)).toBe(true);
    if (!isCatalogError(error)) throw error;
    expect(error.code).toBe('CATALOG_VALIDATION_FAILED');
    if (issuePath) {
      expect(error.issues?.some((issue) => issue.path === issuePath)).toBe(true);
    }
  }
}

describe('parseRelationDefinition', () => {
  it('accepts a well-formed relation and applies both defaults (many: false, required: false)', () => {
    const parsed = parseRelationDefinition({ title: TITLE, target: 'team' }, PATH);

    expect(parsed).toEqual({ title: TITLE, target: 'team', many: false, required: false });
  });

  it('applies only the omitted default when the other field is given explicitly', () => {
    const parsed = parseRelationDefinition({ title: TITLE, target: 'team', required: true }, PATH);

    expect(parsed).toEqual({ title: TITLE, target: 'team', many: false, required: true });
  });

  it('accepts explicit many: true, required: false', () => {
    const parsed = parseRelationDefinition({ title: TITLE, target: 'team', many: true }, PATH);

    expect(parsed).toEqual({ title: TITLE, target: 'team', many: true, required: false });
  });

  it('accepts a target equal to the source blueprint itself (self relation shape)', () => {
    const parsed = parseRelationDefinition({ title: TITLE, target: 'service', many: true }, PATH);

    expect(parsed.target).toBe('service');
  });

  describe('"Required many relation is rejected"', () => {
    it('rejects many: true and required: true together', () => {
      expectRejected({ title: TITLE, target: 'team', many: true, required: true });
    });
  });

  it('rejects a missing title at "${path}/title/en"', () => {
    expectRejected({ target: 'team' }, `${PATH}/title/en`);
  });

  it('rejects a missing target at "${path}/target"', () => {
    expectRejected({ title: TITLE }, `${PATH}/target`);
  });

  it('rejects a malformed target identifier at "${path}/target"', () => {
    expectRejected({ title: TITLE, target: '1team' }, `${PATH}/target`);
  });
});
