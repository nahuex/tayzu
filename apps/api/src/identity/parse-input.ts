/**
 * The shared input parser of the identity router (task 5.3d; design D10
 * "Input contract"). It takes the `inputStructure: 'detailed'` shape
 * `{ params, query, body }` and rebuilds it as null-prototype objects,
 * rejecting forbidden keys at every depth, undeclared sections and fields,
 * and over-length values before anything else is done with them. Errors
 * carry a fixed message: no offending key or value is ever echoed.
 */

export interface StringField {
  readonly kind: 'string';
  /** Checked before anything else is done with the value. */
  readonly maxLength: number;
  /** Defaults to 1. */
  readonly minLength?: number;
  readonly pattern?: RegExp;
  /** Defaults to false (required). */
  readonly optional?: boolean;
}

/** An opaque object: its keys are screened at every depth, its shape is not declared. */
export interface ObjectField {
  readonly kind: 'object';
  readonly optional?: boolean;
}

export type InputField = StringField | ObjectField;

export interface InputSchema {
  readonly params?: Readonly<Record<string, InputField>>;
  readonly query?: Readonly<Record<string, InputField>>;
  readonly body?: Readonly<Record<string, InputField>>;
}

export interface ParsedIdentityInput {
  readonly params: Record<string, unknown>;
  readonly query: Record<string, unknown>;
  readonly body: Record<string, unknown>;
}

class IdentityInputError extends Error {
  readonly code = 'CATALOG_VALIDATION_FAILED' as const;

  constructor() {
    super('The request input is invalid');
    this.name = 'IdentityInputError';
  }
}

const SECTIONS = ['params', 'query', 'body'] as const;
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Copies a value into null-prototype objects, rejecting forbidden keys at every depth. */
function cloneScreened(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneScreened);
  if (!isPlainRecord(value)) return value;
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) throw new IdentityInputError();
    out[key] = cloneScreened(value[key]);
  }
  return out;
}

function parseString(field: StringField, value: unknown): string {
  if (typeof value !== 'string') throw new IdentityInputError();
  if (value.length > field.maxLength) throw new IdentityInputError();
  if (value.length < (field.minLength ?? 1)) throw new IdentityInputError();
  if (field.pattern !== undefined && !field.pattern.test(value)) throw new IdentityInputError();
  return value;
}

function parseSection(
  fields: Readonly<Record<string, InputField>>,
  raw: unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  if (raw !== undefined && !isPlainRecord(raw)) throw new IdentityInputError();
  const section = raw ?? {};
  for (const key of Object.keys(section)) {
    if (FORBIDDEN_KEYS.has(key)) throw new IdentityInputError();
    if (!Object.hasOwn(fields, key)) throw new IdentityInputError();
  }
  for (const key of Object.keys(fields)) {
    const field = fields[key];
    if (field === undefined) continue;
    const value = Object.hasOwn(section, key) ? section[key] : undefined;
    if (value === undefined) {
      if (field.optional !== true) throw new IdentityInputError();
      continue;
    }
    if (field.kind === 'string') {
      out[key] = parseString(field, value);
    } else {
      if (!isPlainRecord(value)) throw new IdentityInputError();
      out[key] = cloneScreened(value);
    }
  }
  return out;
}

export function parseIdentityInput(schema: InputSchema, raw: unknown): ParsedIdentityInput {
  if (!isPlainRecord(raw)) throw new IdentityInputError();
  for (const key of Object.keys(raw)) {
    if (!(SECTIONS as readonly string[]).includes(key)) throw new IdentityInputError();
  }
  const empty: Readonly<Record<string, InputField>> = {};
  return {
    params: parseSection(schema.params ?? empty, raw['params']),
    query: parseSection(schema.query ?? empty, raw['query']),
    body: parseSection(schema.body ?? empty, raw['body']),
  };
}
