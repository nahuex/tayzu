/**
 * Relation value shape validation (spec, "Entity relations and referential
 * integrity"; "Status is written only through the status operation"; design
 * D6, D9). Validates the *shape* of a `spec.relations` or `status.relations`
 * bag against the blueprint's relation definitions. Referential *existence*
 * of a target identifier is never checked here - that needs the database
 * (`CATALOG_REFERENCE_VIOLATION`, checked by the service layer in task 8.2).
 */
import { CatalogError, type CatalogErrorCode } from './errors.js';
import { defaultCatalogLimits, type CatalogLimits } from './limits.js';
import type { RelationDefinition } from './relation-definition.js';

export type RelationScope = 'spec' | 'status';

export interface ValidateRelationValuesOptions {
  limits?: CatalogLimits;
  path?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(
  code: CatalogErrorCode,
  path: string,
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new CatalogError(code, message, { issues: [{ path, message }], details });
}

/**
 * Validates `input` against `definitions` for the given `scope`. `required`
 * is enforced only for `scope: 'spec'` (a `status` relation may always be
 * omitted). `path` defaults to `/${scope}/relations`.
 */
export function validateRelationValues(
  definitions: Record<string, RelationDefinition>,
  input: unknown,
  scope: RelationScope,
  options: ValidateRelationValuesOptions = {},
): Record<string, string | string[]> {
  const limits = options.limits ?? defaultCatalogLimits;
  const basePath = options.path ?? `/${scope}/relations`;
  const raw = isRecord(input) ? input : {};

  for (const name of Object.keys(raw)) {
    if (!(name in definitions)) {
      fail(
        'CATALOG_VALIDATION_FAILED',
        `${basePath}/${name}`,
        'Relation is not declared on the blueprint',
      );
    }
  }

  const result: Record<string, string | string[]> = {};

  for (const [name, definition] of Object.entries(definitions)) {
    const path = `${basePath}/${name}`;
    const value = raw[name];

    if (value === undefined) {
      if (definition.required && scope === 'spec') {
        fail('CATALOG_VALIDATION_FAILED', path, 'Missing required relation');
      }
      continue;
    }

    if (definition.many) {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        fail(
          'CATALOG_VALIDATION_FAILED',
          path,
          'Wrong cardinality: expected an array of identifiers',
        );
      }
      const targets = value as string[];
      if (targets.length > limits.relation.maxManyTargets) {
        fail('CATALOG_LIMIT_EXCEEDED', path, 'Too many relation targets', {
          limit: 'relation.maxManyTargets',
        });
      }
      const seen = new Set<string>();
      for (const target of targets) {
        if (seen.has(target)) fail('CATALOG_VALIDATION_FAILED', path, 'Duplicate relation target');
        seen.add(target);
      }
      result[name] = targets.slice();
    } else {
      if (typeof value !== 'string') {
        fail('CATALOG_VALIDATION_FAILED', path, 'Wrong cardinality: expected a single identifier');
      }
      result[name] = value;
    }
  }

  return result;
}
