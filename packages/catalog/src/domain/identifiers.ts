/**
 * Identifier parsers shared by blueprints, properties, relations and
 * entities (spec Conventions, "Default limits"). Every parser returns the
 * identifier unchanged on success and throws `CATALOG_VALIDATION_FAILED`
 * with a JSON-Pointer issue on failure.
 */
import { CatalogError } from './errors.js';

/** Property and relation identifiers: max 64 chars, leading letter. */
const NAME_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * Blueprint identifiers: the same shape as `NAME_IDENTIFIER_PATTERN`, plus a
 * single optional leading `_` (spec, "Reserved system identifiers": "Blueprint
 * identifiers starting with `_` are reserved for platform-defined blueprints,
 * such as the future `_workflow`"). A second leading `_` (`__proto__`) still
 * fails: the character after the optional `_` must be a letter.
 */
const BLUEPRINT_IDENTIFIER_PATTERN = /^_?[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** Entity identifiers: max 256 chars, path-like character class. */
export const ENTITY_IDENTIFIER_PATTERN = /^[A-Za-z0-9@_.:/=-]{1,256}$/;

/** Rejected in every key position of catalog input (spec Conventions, "Unsafe keys"). */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function invalidIdentifier(path: string): never {
  throw new CatalogError('CATALOG_VALIDATION_FAILED', 'Identifier is invalid', {
    issues: [{ path, message: 'Identifier is invalid' }],
  });
}

function parseNameIdentifier(value: unknown, path: string): string {
  if (typeof value !== 'string' || !NAME_IDENTIFIER_PATTERN.test(value)) {
    invalidIdentifier(path);
  }
  return value;
}

export function parseBlueprintIdentifier(value: unknown, path: string): string {
  if (typeof value !== 'string' || !BLUEPRINT_IDENTIFIER_PATTERN.test(value)) {
    invalidIdentifier(path);
  }
  return value;
}

export function parsePropertyIdentifier(value: unknown, path: string): string {
  return parseNameIdentifier(value, path);
}

export function parseRelationIdentifier(value: unknown, path: string): string {
  return parseNameIdentifier(value, path);
}

/**
 * Entity identifiers additionally forbid `.`/`..` path segments and any
 * leading, trailing or repeated `/`, and are explicitly rejected when they
 * equal an unsafe key, since the character class alone would otherwise
 * allow `__proto__`.
 */
export function parseEntityIdentifier(value: unknown, path: string): string {
  if (typeof value !== 'string' || !ENTITY_IDENTIFIER_PATTERN.test(value)) {
    invalidIdentifier(path);
  }
  if (UNSAFE_KEYS.has(value)) {
    invalidIdentifier(path);
  }

  const segments = value.split('/');
  const hasUnsafeSegment = segments.some(
    (segment) => segment === '' || segment === '.' || segment === '..',
  );
  if (hasUnsafeSegment) {
    invalidIdentifier(path);
  }

  return value;
}
