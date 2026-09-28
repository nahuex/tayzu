/**
 * Blueprint property definitions: a restricted JSON Schema subset (spec,
 * "Property types"; design D6, ADR-0008). `parsePropertyDefinition`
 * meta-validates one property definition and never performs network I/O: a
 * disallowed keyword such as `$ref` is rejected purely because it is not a
 * known keyword for the declared `type`, without ever being dereferenced.
 */
import { CatalogError } from './errors.js';
import { parseLocalizedText, type LocalizedText } from './localized-text.js';
import { parsePattern } from './pattern.js';
import { defaultCatalogLimits } from './limits.js';

export type StringFormat = 'date-time' | 'url' | 'email' | 'markdown' | 'yaml';

export interface StringPropertyDefinition {
  type: 'string';
  title: LocalizedText;
  format?: StringFormat;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  enum?: string[];
  default?: string;
}

export interface NumberPropertyDefinition {
  type: 'number' | 'integer';
  title: LocalizedText;
  minimum?: number;
  maximum?: number;
  enum?: number[];
  default?: number;
}

export interface BooleanPropertyDefinition {
  type: 'boolean';
  title: LocalizedText;
  default?: boolean;
}

export type ArrayItemDefinition =
  | Omit<StringPropertyDefinition, 'title'>
  | Omit<NumberPropertyDefinition, 'title'>
  | Omit<BooleanPropertyDefinition, 'title'>;

export interface ArrayPropertyDefinition {
  type: 'array';
  title: LocalizedText;
  items: ArrayItemDefinition;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
}

export interface ObjectPropertyDefinition {
  type: 'object';
  title: LocalizedText;
}

export type PropertyDefinition =
  | StringPropertyDefinition
  | NumberPropertyDefinition
  | BooleanPropertyDefinition
  | ArrayPropertyDefinition
  | ObjectPropertyDefinition;

const STRING_FORMATS: ReadonlySet<string> = new Set([
  'date-time',
  'url',
  'email',
  'markdown',
  'yaml',
]);

/** Keywords allowed on a top-level property definition, one set per `type`. */
const STRING_PROPERTY_KEYWORDS: ReadonlySet<string> = new Set([
  'type',
  'title',
  'format',
  'minLength',
  'maxLength',
  'pattern',
  'enum',
  'default',
]);
const NUMBER_PROPERTY_KEYWORDS: ReadonlySet<string> = new Set([
  'type',
  'title',
  'minimum',
  'maximum',
  'enum',
  'default',
]);
const BOOLEAN_PROPERTY_KEYWORDS: ReadonlySet<string> = new Set(['type', 'title', 'default']);
const ARRAY_PROPERTY_KEYWORDS: ReadonlySet<string> = new Set([
  'type',
  'title',
  'items',
  'minItems',
  'maxItems',
  'uniqueItems',
]);
const OBJECT_PROPERTY_KEYWORDS: ReadonlySet<string> = new Set(['type', 'title']);

/** The same keyword sets, minus `title`, for an array's `items` definition. */
const STRING_ITEM_KEYWORDS: ReadonlySet<string> = new Set([
  'type',
  'format',
  'minLength',
  'maxLength',
  'pattern',
  'enum',
  'default',
]);
const NUMBER_ITEM_KEYWORDS: ReadonlySet<string> = new Set([
  'type',
  'minimum',
  'maximum',
  'enum',
  'default',
]);
const BOOLEAN_ITEM_KEYWORDS: ReadonlySet<string> = new Set(['type', 'default']);

function propertyKeywordsForType(type: string): ReadonlySet<string> | undefined {
  switch (type) {
    case 'string':
      return STRING_PROPERTY_KEYWORDS;
    case 'number':
    case 'integer':
      return NUMBER_PROPERTY_KEYWORDS;
    case 'boolean':
      return BOOLEAN_PROPERTY_KEYWORDS;
    case 'array':
      return ARRAY_PROPERTY_KEYWORDS;
    case 'object':
      return OBJECT_PROPERTY_KEYWORDS;
    default:
      return undefined;
  }
}

function itemKeywordsForType(type: string): ReadonlySet<string> | undefined {
  switch (type) {
    case 'string':
      return STRING_ITEM_KEYWORDS;
    case 'number':
    case 'integer':
      return NUMBER_ITEM_KEYWORDS;
    case 'boolean':
      return BOOLEAN_ITEM_KEYWORDS;
    default:
      return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Fails closed with a single issue at `path` (the caller decides the field). */
function fail(path: string): never {
  const message = 'Property definition is invalid';
  throw new CatalogError('CATALOG_VALIDATION_FAILED', message, {
    issues: [{ path, message }],
  });
}

/** Any key of `value` outside `known` is an unrecognized keyword or construct. */
function rejectUnknownKeys(
  value: Record<string, unknown>,
  known: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!known.has(key)) fail(`${path}/${key}`);
  }
}

function parseNumberKeyword(value: unknown, path: string): number {
  if (typeof value !== 'number' || Number.isNaN(value)) fail(path);
  return value;
}

function parseBooleanKeyword(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path);
  return value;
}

function rejectIfTooManyEnumEntries(entries: readonly unknown[]): void {
  if (entries.length > defaultCatalogLimits.enum.maxEntries) {
    throw new CatalogError('CATALOG_LIMIT_EXCEEDED', 'Too many enum entries', {
      details: { limit: 'enum.maxEntries' },
    });
  }
}

/** Validates the `string`-specific keywords, shared by properties and array items. */
function parseStringKeywords(
  value: Record<string, unknown>,
  path: string,
): Omit<StringPropertyDefinition, 'type' | 'title'> {
  const result: Omit<StringPropertyDefinition, 'type' | 'title'> = {};

  if ('format' in value) {
    const format = value['format'];
    if (typeof format !== 'string' || !STRING_FORMATS.has(format)) fail(`${path}/format`);
    result.format = format as StringFormat;
  }
  if ('minLength' in value)
    result.minLength = parseNumberKeyword(value['minLength'], `${path}/minLength`);
  if ('maxLength' in value)
    result.maxLength = parseNumberKeyword(value['maxLength'], `${path}/maxLength`);
  if ('pattern' in value) result.pattern = parsePattern(value['pattern'], `${path}/pattern`);
  if ('enum' in value) {
    const rawEnum = value['enum'];
    if (!Array.isArray(rawEnum) || rawEnum.some((item) => typeof item !== 'string')) {
      fail(`${path}/enum`);
    }
    rejectIfTooManyEnumEntries(rawEnum);
    result.enum = rawEnum as string[];
  }
  if ('default' in value) {
    const rawDefault = value['default'];
    if (typeof rawDefault !== 'string') fail(`${path}/default`);
    result.default = rawDefault;
  }

  return result;
}

/** Validates the `number`/`integer`-specific keywords, shared by properties and array items. */
function parseNumberKeywords(
  value: Record<string, unknown>,
  path: string,
): Omit<NumberPropertyDefinition, 'type' | 'title'> {
  const result: Omit<NumberPropertyDefinition, 'type' | 'title'> = {};

  if ('minimum' in value) result.minimum = parseNumberKeyword(value['minimum'], `${path}/minimum`);
  if ('maximum' in value) result.maximum = parseNumberKeyword(value['maximum'], `${path}/maximum`);
  if ('enum' in value) {
    const rawEnum = value['enum'];
    if (!Array.isArray(rawEnum)) fail(`${path}/enum`);
    const parsedEnum = rawEnum.map((item, index) =>
      parseNumberKeyword(item, `${path}/enum/${String(index)}`),
    );
    rejectIfTooManyEnumEntries(parsedEnum);
    result.enum = parsedEnum;
  }
  if ('default' in value) result.default = parseNumberKeyword(value['default'], `${path}/default`);

  return result;
}

/** Validates the `boolean`-specific keywords, shared by properties and array items. */
function parseBooleanKeywords(
  value: Record<string, unknown>,
  path: string,
): Omit<BooleanPropertyDefinition, 'type' | 'title'> {
  const result: Omit<BooleanPropertyDefinition, 'type' | 'title'> = {};
  if ('default' in value) result.default = parseBooleanKeyword(value['default'], `${path}/default`);
  return result;
}

/** Validates an `array`'s `items` definition: a primitive type, never nested `object` or `array`. */
function parseArrayItemDefinition(value: unknown, path: string): ArrayItemDefinition {
  if (!isRecord(value)) fail(`${path}/type`);

  const rawType = value['type'];
  const knownKeys = typeof rawType === 'string' ? itemKeywordsForType(rawType) : undefined;
  if (typeof rawType !== 'string' || !knownKeys) fail(`${path}/type`);

  rejectUnknownKeys(value, knownKeys, path);

  if (rawType === 'string') return { type: 'string', ...parseStringKeywords(value, path) };
  if (rawType === 'boolean') return { type: 'boolean', ...parseBooleanKeywords(value, path) };
  return { type: rawType as 'number' | 'integer', ...parseNumberKeywords(value, path) };
}

/** Validates the `array`-specific keywords: `items` plus size and uniqueness. */
function parseArrayKeywords(
  value: Record<string, unknown>,
  path: string,
): Omit<ArrayPropertyDefinition, 'type' | 'title'> {
  if (!('items' in value)) fail(`${path}/items`);

  const result: Omit<ArrayPropertyDefinition, 'type' | 'title'> = {
    items: parseArrayItemDefinition(value['items'], `${path}/items`),
  };
  if ('minItems' in value)
    result.minItems = parseNumberKeyword(value['minItems'], `${path}/minItems`);
  if ('maxItems' in value)
    result.maxItems = parseNumberKeyword(value['maxItems'], `${path}/maxItems`);
  if ('uniqueItems' in value) {
    result.uniqueItems = parseBooleanKeyword(value['uniqueItems'], `${path}/uniqueItems`);
  }
  return result;
}

/**
 * Meta-validates one property definition (spec, "Property types"; design
 * D6). `path` is the JSON Pointer of the property itself, for example
 * `/schema/properties/docs`. Every schema is effectively `.strict()`: any
 * key that is not a known keyword for the declared `type` - including
 * `$ref`, `$id`, `$defs`, `if`/`then`/`else`, a nested object schema, or an
 * unknown `format` - is rejected at `${path}/<key>`, without ever being
 * dereferenced or otherwise interpreted.
 */
export function parsePropertyDefinition(value: unknown, path: string): PropertyDefinition {
  if (!isRecord(value)) fail(`${path}/type`);

  const rawType = value['type'];
  const knownKeys = typeof rawType === 'string' ? propertyKeywordsForType(rawType) : undefined;
  if (typeof rawType !== 'string' || !knownKeys) fail(`${path}/type`);

  rejectUnknownKeys(value, knownKeys, path);

  const title = parseLocalizedText(
    value['title'],
    `${path}/title`,
    defaultCatalogLimits.localizedText.title.maxLength,
  );

  switch (rawType) {
    case 'string':
      return { type: 'string', title, ...parseStringKeywords(value, path) };
    case 'number':
    case 'integer':
      return { type: rawType, title, ...parseNumberKeywords(value, path) };
    case 'boolean':
      return { type: 'boolean', title, ...parseBooleanKeywords(value, path) };
    case 'array':
      return { type: 'array', title, ...parseArrayKeywords(value, path) };
    default:
      return { type: 'object', title };
  }
}
