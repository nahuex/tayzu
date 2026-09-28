/**
 * Entity property validation (spec, "Entity `spec` and `status`"; design D6,
 * ADR-0008). `compileEntityValidator` derives an Ajv (draft 2020-12) schema
 * from an already meta-validated `ParsedPropertySchema`, so Ajv never
 * compiles tenant JSON directly: `additionalProperties: false`, `required`
 * copied verbatim, one sub-schema per declared property. Patterns run
 * through the RE2 (`re2js`) regExp adapter, never a native backtracking
 * engine. `ajv-formats` runs in `fast` mode, restricted to `date-time`,
 * `email` and `uri` (exposed as `url`); a custom keyword additionally
 * restricts `url` values to the `http` and `https` schemes. Every string
 * property that declares a `format` also gets `maxLength:
 * limits.formattedString.maxLength` applied, so an over-cap value is
 * rejected as a length violation independently of the format itself.
 */
import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { RE2JS } from 're2js';
import { CatalogError, type CatalogErrorIssue } from './errors.js';
import type { ParsedPropertySchema } from './blueprint-definition.js';
import type {
  ArrayItemDefinition,
  BooleanPropertyDefinition,
  NumberPropertyDefinition,
  PropertyDefinition,
  StringPropertyDefinition,
} from './property-schema.js';
import { defaultCatalogLimits, type CatalogLimits } from './limits.js';

export interface EntityPropertyValidator {
  /**
   * Validates `properties` against the compiled schema and returns a fresh
   * object with every omitted property that declares a `default` filled in.
   * `path` is the JSON Pointer of the properties bag itself.
   */
  validate(properties: unknown, path?: string): Record<string, unknown>;
}

/** Structurally compatible with Ajv's `RegExpLike`, without importing it. */
interface RegExpLike {
  test: (value: string) => boolean;
  toString: () => string;
}

/**
 * RE2 (`re2js`) regExp adapter (design D6): `pattern` never runs a native,
 * backtracking regular expression against entity input. The `toString`
 * override is required: Ajv keys its pattern scope cache on it, and a plain
 * object would otherwise collide with every other compiled pattern.
 */
function re2RegExpEngine(pattern: string, flags: string): RegExpLike {
  const compiled = RE2JS.compile(pattern);
  return {
    test: (value: string) => compiled.matcher(value).find(),
    toString: () => `/${pattern}/${flags}`,
  };
}
re2RegExpEngine.code = 'catalogRe2RegExp';

/** Restricts a `url`-formatted value to the `http` and `https` schemes. */
function isHttpUrl(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.startsWith('http://') || lower.startsWith('https://');
}

function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    useDefaults: true,
    code: { regExp: re2RegExpEngine },
  });
  addFormats(ajv, { mode: 'fast', formats: ['date-time', 'email', 'uri'], keywords: false });
  ajv.addKeyword({
    keyword: 'httpUrl',
    type: 'string',
    schemaType: 'boolean',
    validate: (schemaValue: boolean, data: string): boolean => !schemaValue || isHttpUrl(data),
  });
  return ajv;
}

type StringKeywords = Omit<StringPropertyDefinition, 'title'>;
type NumberKeywords = Omit<NumberPropertyDefinition, 'title'>;
type BooleanKeywords = Omit<BooleanPropertyDefinition, 'title'>;

/** Derives the `string` sub-schema, including the formatted-string length cap (ADR-0008). */
function deriveStringSchema(
  definition: StringKeywords,
  limits: CatalogLimits,
): Record<string, unknown> {
  const schema: Record<string, unknown> = { type: 'string' };

  if (definition.minLength !== undefined) schema['minLength'] = definition.minLength;
  if (definition.pattern !== undefined) schema['pattern'] = definition.pattern;
  if (definition.enum !== undefined) schema['enum'] = definition.enum;
  if (definition.default !== undefined) schema['default'] = definition.default;

  let maxLength = definition.maxLength;
  if (definition.format !== undefined) {
    maxLength =
      maxLength === undefined
        ? limits.formattedString.maxLength
        : Math.min(maxLength, limits.formattedString.maxLength);

    if (definition.format === 'url') {
      schema['format'] = 'uri';
      schema['httpUrl'] = true;
    } else if (definition.format === 'date-time' || definition.format === 'email') {
      schema['format'] = definition.format;
    }
    // 'markdown' and 'yaml' are presentation hints, never parsed server-side
    // (ADR-0008): no format keyword, only the length cap above.
  }
  if (maxLength !== undefined) schema['maxLength'] = maxLength;

  return schema;
}

function deriveNumberSchema(definition: NumberKeywords): Record<string, unknown> {
  const schema: Record<string, unknown> = { type: definition.type };
  if (definition.minimum !== undefined) schema['minimum'] = definition.minimum;
  if (definition.maximum !== undefined) schema['maximum'] = definition.maximum;
  if (definition.enum !== undefined) schema['enum'] = definition.enum;
  if (definition.default !== undefined) schema['default'] = definition.default;
  return schema;
}

function deriveBooleanSchema(definition: BooleanKeywords): Record<string, unknown> {
  const schema: Record<string, unknown> = { type: 'boolean' };
  if (definition.default !== undefined) schema['default'] = definition.default;
  return schema;
}

/** An array's `items` are always a primitive type (ADR-0008): never `format`. */
function deriveArrayItemSchema(
  item: ArrayItemDefinition,
  limits: CatalogLimits,
): Record<string, unknown> {
  if (item.type === 'string') return deriveStringSchema(item, limits);
  if (item.type === 'boolean') return deriveBooleanSchema(item);
  return deriveNumberSchema(item);
}

function derivePropertySchema(
  definition: PropertyDefinition,
  limits: CatalogLimits,
): Record<string, unknown> {
  switch (definition.type) {
    case 'string':
      return deriveStringSchema(definition, limits);
    case 'number':
    case 'integer':
      return deriveNumberSchema(definition);
    case 'boolean':
      return deriveBooleanSchema(definition);
    case 'array': {
      const schema: Record<string, unknown> = {
        type: 'array',
        items: deriveArrayItemSchema(definition.items, limits),
      };
      if (definition.minItems !== undefined) schema['minItems'] = definition.minItems;
      if (definition.maxItems !== undefined) schema['maxItems'] = definition.maxItems;
      if (definition.uniqueItems !== undefined) schema['uniqueItems'] = definition.uniqueItems;
      return schema;
    }
    case 'object':
    default:
      // A free-form object, bounded by size and nesting depth elsewhere (ADR-0008).
      return { type: 'object' };
  }
}

function deriveSchema(
  schema: ParsedPropertySchema,
  limits: CatalogLimits,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [name, definition] of Object.entries(schema.properties)) {
    properties[name] = derivePropertySchema(definition, limits);
  }

  return {
    type: 'object',
    additionalProperties: false,
    required: schema.required,
    properties,
  };
}

/** A fresh, null-prototype shallow copy of a plain-object-shaped `value`. */
function cloneAsNullPrototype(value: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const key of Object.keys(value)) {
      result[key] = (value as Record<string, unknown>)[key];
    }
  }
  return result;
}

/**
 * Maps one Ajv error to a JSON-Pointer issue rooted at `basePath`. `required`
 * and `additionalProperties` errors carry the offending property name in
 * `params` rather than in `instancePath`.
 */
function issuePath(error: ErrorObject, basePath: string): string {
  const params = error.params as Record<string, unknown>;

  if (error.keyword === 'required') {
    const missing = params['missingProperty'];
    return `${basePath}/${typeof missing === 'string' ? missing : ''}`;
  }
  if (error.keyword === 'additionalProperties') {
    const extra = params['additionalProperty'];
    return `${basePath}/${typeof extra === 'string' ? extra : ''}`;
  }
  return `${basePath}${error.instancePath}`;
}

function issuesFromAjvErrors(
  errors: ErrorObject[] | null | undefined,
  basePath: string,
): CatalogErrorIssue[] {
  if (!errors) return [];
  return errors.map((error) => ({
    path: issuePath(error, basePath),
    message: error.message ?? 'Property is invalid',
  }));
}

/**
 * Derives an Ajv schema from `schema` (design D6) and returns a validator
 * that can be reused for both `spec.properties` (the default `path`) and a
 * `statusSchema` (task 8.4, with `path` set to `/status/properties`).
 */
export function compileEntityValidator(
  schema: ParsedPropertySchema,
  limits: CatalogLimits = defaultCatalogLimits,
): EntityPropertyValidator {
  const ajv = createAjv();
  const validateFn = ajv.compile(deriveSchema(schema, limits));

  return {
    validate(properties: unknown, path = '/spec/properties'): Record<string, unknown> {
      const data = cloneAsNullPrototype(properties);
      const valid = validateFn(data);
      if (!valid) {
        throw new CatalogError('CATALOG_VALIDATION_FAILED', 'Entity properties are invalid', {
          issues: issuesFromAjvErrors(validateFn.errors, path),
        });
      }
      return data;
    },
  };
}
