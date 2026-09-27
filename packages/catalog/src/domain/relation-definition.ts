/**
 * Relation definitions (spec, "Relation definitions"; design D6). Validates
 * shape only: the pure parser never checks that `target` actually exists in
 * the tenant, since that needs the database (`CATALOG_REFERENCE_VIOLATION`,
 * checked by the service layer in task 7.1).
 */
import { CatalogError } from './errors.js';
import { parseBlueprintIdentifier } from './identifiers.js';
import { parseLocalizedText, type LocalizedText } from './localized-text.js';
import { defaultCatalogLimits } from './limits.js';

export interface RelationDefinition {
  title: LocalizedText;
  target: string;
  many: boolean;
  required: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(path: string): never {
  const message = 'Relation definition is invalid';
  throw new CatalogError('CATALOG_VALIDATION_FAILED', message, {
    issues: [{ path, message }],
  });
}

function parseBooleanFlag(value: unknown, path: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') fail(path);
  return value;
}

/**
 * Validates one relation definition. `path` is the JSON Pointer of the
 * definition itself, for example `/relations/owner`. `many` and `required`
 * each default to `false` when omitted.
 */
export function parseRelationDefinition(value: unknown, path: string): RelationDefinition {
  if (!isRecord(value)) fail(path);

  const title = parseLocalizedText(
    value['title'],
    `${path}/title`,
    defaultCatalogLimits.localizedText.title.maxLength,
  );
  const target = parseBlueprintIdentifier(value['target'], `${path}/target`);
  const many = parseBooleanFlag(value['many'], `${path}/many`);
  const required = parseBooleanFlag(value['required'], `${path}/required`);

  if (many && required) fail(path);

  return { title, target, many, required };
}
