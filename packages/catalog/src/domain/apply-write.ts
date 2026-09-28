/**
 * Pure write semantics for an entity's `spec` (design D9: "a pure
 * `applyWrite(current, input, mode)` function"). Computes the next
 * `properties` and `relations` bags independently, never validating values
 * or checking relation cardinality: that is `./entity-validator.js` and
 * `./relation-values.js`. Never uses `Object.assign` or a `{}` spread
 * target (design D9): every surviving key is assigned one at a time onto a
 * null-prototype object.
 */
export type WriteMode = 'replace' | 'merge';

export interface EntitySpec {
  properties: Record<string, unknown>;
  relations: Record<string, unknown>;
}

export interface EntitySpecWriteInput {
  // `unknown` already includes `null`, the sentinel that removes a key.
  properties?: Record<string, unknown>;
  relations?: Record<string, unknown>;
}

/**
 * Computes one bag (`properties` or `relations`). `replace` ignores
 * `current` entirely; `merge` starts from a copy of it. Either way, a key
 * given as `null` in `input` is removed from the result.
 */
function applyBag(
  current: Record<string, unknown>,
  input: Record<string, unknown> | undefined,
  mode: WriteMode,
): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

  if (mode === 'merge') {
    for (const key of Object.keys(current)) {
      result[key] = current[key];
    }
  }

  for (const [key, value] of Object.entries(input ?? {})) {
    if (value === null) {
      Reflect.deleteProperty(result, key);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * `current` defaults to an empty spec (entity creation: both modes then
 * behave the same way).
 */
export function applyWrite(current: EntitySpec | undefined, input: EntitySpecWriteInput, mode: WriteMode): EntitySpec {
  const currentProperties = current?.properties ?? {};
  const currentRelations = current?.relations ?? {};

  return {
    properties: applyBag(currentProperties, input.properties, mode),
    relations: applyBag(currentRelations, input.relations, mode),
  };
}
