/**
 * Whole blueprint definition meta-validation (spec, "Blueprint definition";
 * design D6, D8). `parseBlueprintDefinition` validates shape, cross-field
 * rules, and blueprint-level count limits. Relation *target existence* is
 * never checked here: that needs the database
 * (`CATALOG_REFERENCE_VIOLATION`, checked by the service layer in task 7.1).
 */
import { RE2JS } from 're2js';
import { CatalogError } from './errors.js';
import {
  parseBlueprintIdentifier,
  parsePropertyIdentifier,
  parseRelationIdentifier,
} from './identifiers.js';
import { parseLocalizedText, type LocalizedText } from './localized-text.js';
import { parsePropertyDefinition, type PropertyDefinition } from './property-schema.js';
import { parseRelationDefinition, type RelationDefinition } from './relation-definition.js';
import { defaultCatalogLimits, type CatalogLimits } from './limits.js';

export interface ParsedPropertySchema {
  properties: Record<string, PropertyDefinition>;
  required: string[];
}

export interface ParsedBlueprintDefinition {
  identifier: string;
  title: LocalizedText;
  description?: LocalizedText;
  icon?: string;
  schema: ParsedPropertySchema;
  statusSchema?: ParsedPropertySchema;
  relations: Record<string, RelationDefinition>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(path: string, message = 'Blueprint definition is invalid'): never {
  throw new CatalogError('CATALOG_VALIDATION_FAILED', message, {
    issues: [{ path, message }],
  });
}

function limitExceeded(limit: 'blueprint.maxProperties' | 'blueprint.maxRelations'): never {
  throw new CatalogError('CATALOG_LIMIT_EXCEEDED', 'Blueprint definition exceeds a count limit', {
    details: { limit },
  });
}

/** Raw property keys of a `schema`/`statusSchema` object, `{}` when the field is absent. */
function rawProperties(rawSchema: unknown): Record<string, unknown> {
  if (!isRecord(rawSchema)) return {};
  const properties = rawSchema['properties'];
  return isRecord(properties) ? properties : {};
}

/** Raw `required` array of a `schema`/`statusSchema` object, `[]` when the field is absent. */
function rawRequired(rawSchema: unknown): unknown[] {
  if (!isRecord(rawSchema)) return [];
  const required = rawSchema['required'];
  return Array.isArray(required) ? required : [];
}

function parsePropertySchema(rawSchema: unknown, path: string): ParsedPropertySchema {
  const propertiesRaw = rawProperties(rawSchema);
  const properties: Record<string, PropertyDefinition> = {};
  for (const name of Object.keys(propertiesRaw)) {
    const identifier = parsePropertyIdentifier(name, `${path}/properties/${name}`);
    properties[identifier] = parsePropertyDefinition(
      propertiesRaw[name],
      `${path}/properties/${name}`,
    );
  }

  const requiredRaw = rawRequired(rawSchema);
  const required = requiredRaw.map((entry, index) => {
    if (typeof entry !== 'string') fail(`${path}/required/${String(index)}`);
    return entry;
  });

  for (const [index, name] of required.entries()) {
    if (!(name in properties)) fail(`${path}/required/${String(index)}`);
  }

  for (const [name, definition] of Object.entries(properties)) {
    validateDefaultAgainstOwnDefinition(`${path}/properties/${name}`, definition);
  }

  return { properties, required };
}

/** The spec's "A `default` MUST itself be valid against its property definition". */
function validateDefaultAgainstOwnDefinition(path: string, definition: PropertyDefinition): void {
  if (definition.type === 'object' || definition.type === 'array') return;
  if (definition.default === undefined) return;

  if (definition.type === 'string') {
    const value = definition.default;
    if (definition.minLength !== undefined && value.length < definition.minLength)
      fail(`${path}/default`);
    if (definition.maxLength !== undefined && value.length > definition.maxLength)
      fail(`${path}/default`);
    if (
      definition.pattern !== undefined &&
      !RE2JS.compile(definition.pattern).matcher(value).find()
    ) {
      fail(`${path}/default`);
    }
    if (definition.enum !== undefined && !definition.enum.includes(value)) fail(`${path}/default`);
    return;
  }

  if (definition.type === 'number' || definition.type === 'integer') {
    const value = definition.default;
    if (definition.minimum !== undefined && value < definition.minimum) fail(`${path}/default`);
    if (definition.maximum !== undefined && value > definition.maximum) fail(`${path}/default`);
    if (definition.enum !== undefined && !definition.enum.includes(value)) fail(`${path}/default`);
  }
}

/**
 * Validates a whole blueprint input. `limits` defaults to
 * `defaultCatalogLimits`. `schema.required` / `statusSchema.required`
 * default to `[]`, and `relations` defaults to `{}`, when omitted.
 */
export function parseBlueprintDefinition(
  value: unknown,
  limits: CatalogLimits = defaultCatalogLimits,
): ParsedBlueprintDefinition {
  if (!isRecord(value)) fail('');

  const identifier = parseBlueprintIdentifier(value['identifier'], '/identifier');
  const title = parseLocalizedText(value['title'], '/title', limits.localizedText.title.maxLength);

  let description: LocalizedText | undefined;
  if (value['description'] !== undefined) {
    description = parseLocalizedText(
      value['description'],
      '/description',
      limits.localizedText.description.maxLength,
    );
  }

  let icon: string | undefined;
  if (value['icon'] !== undefined) {
    const rawIcon = value['icon'];
    if (typeof rawIcon !== 'string' || rawIcon.length > limits.icon.maxLength) fail('/icon');
    icon = rawIcon;
  }

  const rawRelations = isRecord(value['relations']) ? value['relations'] : {};

  // Count limits (design D8) run before the detailed parsing below.
  const totalPropertyCount =
    Object.keys(rawProperties(value['schema'])).length +
    Object.keys(rawProperties(value['statusSchema'])).length;
  if (totalPropertyCount > limits.blueprint.maxProperties) limitExceeded('blueprint.maxProperties');
  if (Object.keys(rawRelations).length > limits.blueprint.maxRelations) {
    limitExceeded('blueprint.maxRelations');
  }

  const schema = parsePropertySchema(value['schema'], '/schema');
  const statusSchema =
    value['statusSchema'] === undefined
      ? undefined
      : parsePropertySchema(value['statusSchema'], '/statusSchema');

  const propertyIdentifiers = new Set<string>(Object.keys(schema.properties));
  for (const name of Object.keys(statusSchema?.properties ?? {})) {
    if (propertyIdentifiers.has(name)) fail(`/statusSchema/properties/${name}`);
    propertyIdentifiers.add(name);
  }

  const relations: Record<string, RelationDefinition> = {};
  for (const name of Object.keys(rawRelations)) {
    const identifier = parseRelationIdentifier(name, `/relations/${name}`);
    if (propertyIdentifiers.has(identifier)) fail(`/relations/${name}`);
    relations[identifier] = parseRelationDefinition(rawRelations[name], `/relations/${name}`);
  }

  return { identifier, title, description, icon, schema, statusSchema, relations };
}
