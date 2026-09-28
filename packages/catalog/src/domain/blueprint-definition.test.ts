/**
 * Assumed API of `./blueprint-definition.js` (tasks 3.4, 3.7):
 *
 * ```ts
 * export interface ParsedPropertySchema {
 *   properties: Record<string, PropertyDefinition>; // ./property-schema.js
 *   required: string[];
 * }
 *
 * export interface ParsedBlueprintDefinition {
 *   identifier: string;
 *   title: LocalizedText;
 *   description?: LocalizedText;
 *   icon?: string;
 *   schema: ParsedPropertySchema;
 *   statusSchema?: ParsedPropertySchema;
 *   relations: Record<string, RelationDefinition>; // ./relation-definition.js
 * }
 *
 * function parseBlueprintDefinition(
 *   value: unknown,
 *   limits?: CatalogLimits,
 * ): ParsedBlueprintDefinition;
 * ```
 *
 * Validates a whole blueprint input (spec, "Blueprint definition"; design
 * D6). `limits` defaults to `defaultCatalogLimits` (`./limits.js`).
 * `schema.required` / `statusSchema.required` default to `[]`, and
 * `relations` defaults to `{}`, when omitted from the input.
 *
 * Field-level parsing and JSON-Pointer paths:
 * - `identifier`: `./identifiers.js`'s `parseBlueprintIdentifier`, issue at
 *   `/identifier`.
 * - `title` (required) / `description` (optional): `./localized-text.js`'s
 *   `parseLocalizedText`, issues at `/title/<locale>` / `/description/<locale>`
 *   (for example `/title/en`, `/title/xx`).
 * - `icon` (optional): a string of at most `limits.icon.maxLength`
 *   characters, issue at `/icon`.
 * - `schema.properties.<name>` / `statusSchema.properties.<name>`:
 *   `./property-schema.js`'s `parsePropertyDefinition`, called with path
 *   `/schema/properties/<name>` / `/statusSchema/properties/<name>`.
 * - `relations.<name>`: `./relation-definition.js`'s
 *   `parseRelationDefinition`, called with path `/relations/<name>`.
 *
 * Cross-field rules (`CatalogError('CATALOG_VALIDATION_FAILED', ...,
 * { issues: [...] })`):
 * - Every name in `schema.required` (`statusSchema.required`) MUST name a
 *   property declared in that same schema. The first undeclared name is
 *   reported at `/schema/required/<index>` (`/statusSchema/required/<index>`).
 * - A property `default` MUST be valid against its own definition (for
 *   example an integer `default` below its own `minimum`).
 * - Property identifiers MUST be unique across `schema.properties` and
 *   `statusSchema.properties` of the same blueprint.
 * - `relations` keys MUST NOT collide with a property identifier declared in
 *   `schema.properties` or `statusSchema.properties`.
 *
 * Count limits (design D8), throwing `CatalogError('CATALOG_LIMIT_EXCEEDED',
 * ..., { details: { limit: 'blueprint.maxProperties' | 'blueprint.maxRelations' } })`:
 * - The combined number of properties in `schema.properties` and
 *   `statusSchema.properties` MUST NOT exceed `limits.blueprint.maxProperties`.
 * - The number of `relations` entries MUST NOT exceed
 *   `limits.blueprint.maxRelations`.
 *
 * Relation *target existence* is never checked here: that needs the
 * database and is `CATALOG_REFERENCE_VIOLATION`, checked by the service
 * layer in task 7.1. This parser only validates shape.
 */
import { describe, expect, it } from 'vitest';
import { parseBlueprintDefinition } from './blueprint-definition.js';
import { isCatalogError, type CatalogErrorCode } from './errors.js';
import { defaultCatalogLimits } from './limits.js';

function property(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'string', title: { en: 'Property' }, ...overrides };
}

function manyProperties(count: number, prefix = 'p'): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (let index = 0; index < count; index += 1) {
    properties[`${prefix}${String(index)}`] = property();
  }
  return properties;
}

function manyRelations(count: number): Record<string, unknown> {
  const relations: Record<string, unknown> = {};
  for (let index = 0; index < count; index += 1) {
    relations[`r${String(index)}`] = { title: { en: 'Relation' }, target: 'service' };
  }
  return relations;
}

function validBlueprint(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    identifier: 'service',
    title: { en: 'Service', es: 'Servicio' },
    schema: {
      properties: { language: property({ title: { en: 'Language' } }) },
      required: [],
    },
    relations: {},
    ...overrides,
  };
}

function expectRejectedCode(value: unknown, code: CatalogErrorCode, issuePath?: string): void {
  try {
    parseBlueprintDefinition(value);
    expect.unreachable('parseBlueprintDefinition should have thrown');
  } catch (error) {
    expect(isCatalogError(error)).toBe(true);
    if (!isCatalogError(error)) throw error;
    expect(error.code).toBe(code);
    if (issuePath) {
      expect(error.issues?.some((issue) => issue.path === issuePath)).toBe(true);
    }
  }
}

function expectValidationRejected(value: unknown, issuePath?: string): void {
  expectRejectedCode(value, 'CATALOG_VALIDATION_FAILED', issuePath);
}

describe('"Create a blueprint with localized title"', () => {
  it('accepts a well-formed blueprint definition with a localized title and a string property', () => {
    const parsed = parseBlueprintDefinition(validBlueprint());

    expect(parsed.identifier).toBe('service');
    expect(parsed.title).toEqual({ en: 'Service', es: 'Servicio' });
    expect(parsed.schema.properties['language']).toMatchObject({ type: 'string' });
    expect(parsed.relations).toEqual({});
  });
});

describe('"Missing English title is rejected"', () => {
  it('reports the issue at "/title/en"', () => {
    expectValidationRejected(validBlueprint({ title: { es: 'Servicio' } }), '/title/en');
  });
});

describe('"Unsupported locale is rejected"', () => {
  it('reports the issue at "/title/xx"', () => {
    expectValidationRejected(validBlueprint({ title: { en: 'Service', xx: '?' } }), '/title/xx');
  });
});

describe('"Invalid identifier"', () => {
  it.each(['1service', 'service name'])('rejects "%s" at "/identifier"', (identifier) => {
    expectValidationRejected(validBlueprint({ identifier }), '/identifier');
  });
});

describe('"Invalid default is rejected"', () => {
  it('rejects an integer default below its own minimum', () => {
    const blueprint = validBlueprint({
      schema: {
        properties: {
          tier: { type: 'integer', title: { en: 'Tier' }, minimum: 1, default: 0 },
        },
        required: [],
      },
    });

    expectValidationRejected(blueprint);
  });
});

describe('"Required names an undeclared property"', () => {
  it('reports the issue at "/schema/required/0"', () => {
    const blueprint = validBlueprint({
      schema: {
        properties: { language: property({ title: { en: 'Language' } }) },
        required: ['owner'],
      },
    });

    expectValidationRejected(blueprint, '/schema/required/0');
  });
});

describe('identifier collision cases', () => {
  it('rejects a property identifier that collides between schema and statusSchema', () => {
    const blueprint = validBlueprint({
      schema: { properties: { tier: property() }, required: [] },
      statusSchema: { properties: { tier: property() }, required: [] },
    });

    expectValidationRejected(blueprint);
  });

  it('rejects a relation identifier that collides with a schema property identifier', () => {
    const blueprint = validBlueprint({
      schema: { properties: { owner: property() }, required: [] },
      relations: { owner: { title: { en: 'Owner' }, target: 'team' } },
    });

    expectValidationRejected(blueprint);
  });

  it('rejects a relation identifier that collides with a statusSchema property identifier', () => {
    const blueprint = validBlueprint({
      statusSchema: { properties: { owner: property() }, required: [] },
      relations: { owner: { title: { en: 'Owner' }, target: 'team' } },
    });

    expectValidationRejected(blueprint);
  });
});

describe('blueprint-level count limits (task 3.7)', () => {
  it('accepts 200 properties combined across schema and statusSchema', () => {
    expect(defaultCatalogLimits.blueprint.maxProperties).toBe(200);

    const blueprint = validBlueprint({
      schema: { properties: manyProperties(199, 'sp'), required: [] },
      statusSchema: { properties: manyProperties(1, 'stp'), required: [] },
    });

    expect(() => parseBlueprintDefinition(blueprint)).not.toThrow();
  });

  it('rejects 201 properties combined across schema and statusSchema with CATALOG_LIMIT_EXCEEDED', () => {
    const blueprint = validBlueprint({
      schema: { properties: manyProperties(200, 'sp'), required: [] },
      statusSchema: { properties: manyProperties(1, 'stp'), required: [] },
    });

    try {
      parseBlueprintDefinition(blueprint);
      expect.unreachable('parseBlueprintDefinition should have thrown');
    } catch (error) {
      expect(isCatalogError(error)).toBe(true);
      if (!isCatalogError(error)) throw error;
      expect(error.code).toBe('CATALOG_LIMIT_EXCEEDED');
      expect(error.details).toMatchObject({ limit: 'blueprint.maxProperties' });
    }
  });

  it('accepts 50 relations', () => {
    expect(defaultCatalogLimits.blueprint.maxRelations).toBe(50);

    const blueprint = validBlueprint({ relations: manyRelations(50) });

    expect(() => parseBlueprintDefinition(blueprint)).not.toThrow();
  });

  it('rejects 51 relations with CATALOG_LIMIT_EXCEEDED', () => {
    const blueprint = validBlueprint({ relations: manyRelations(51) });

    try {
      parseBlueprintDefinition(blueprint);
      expect.unreachable('parseBlueprintDefinition should have thrown');
    } catch (error) {
      expect(isCatalogError(error)).toBe(true);
      if (!isCatalogError(error)) throw error;
      expect(error.code).toBe('CATALOG_LIMIT_EXCEEDED');
      expect(error.details).toMatchObject({ limit: 'blueprint.maxRelations' });
    }
  });
});
