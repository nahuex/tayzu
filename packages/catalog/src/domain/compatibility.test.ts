/**
 * Assumed API of `./compatibility.js` (task 4.7):
 *
 * ```ts
 * export interface CompatibilityEntitySnapshot {
 *   identifier: string;
 *   spec: { properties: Record<string, unknown>; relations: Record<string, unknown> };
 *   status: { properties: Record<string, unknown>; relations: Record<string, unknown> } | null;
 * }
 *
 * export interface CompatibilityViolation {
 *   entityIdentifier: string;
 *   issues: CatalogErrorIssue[]; // ./errors.js, JSON-Pointer paths
 * }
 *
 * export interface CompatibilityCheckResult {
 *   compatible: boolean;
 *   violations: CompatibilityViolation[]; // at most `maxViolations` (default 10)
 * }
 *
 * export interface CheckCompatibilityOptions {
 *   previousDefinition?: ParsedBlueprintDefinition; // ./blueprint-definition.js
 *   maxViolations?: number; // default 10
 * }
 *
 * function checkCompatibility(
 *   newDefinition: ParsedBlueprintDefinition,
 *   entities: AsyncIterable<CompatibilityEntitySnapshot>,
 *   options?: CheckCompatibilityOptions,
 * ): Promise<CompatibilityCheckResult>;
 * ```
 *
 * The pure half of "Safe blueprint schema evolution" (spec; design D7:
 * "Validate each entity against the proposed definition, and stop after 10
 * violations"). For each entity pulled from `entities`, in order:
 * 1. `entity.spec.properties` is validated against `newDefinition.schema`
 *    (`./entity-validator.js`'s `compileEntityValidator`, path
 *    `/spec/properties`); `entity.status?.properties` against
 *    `newDefinition.statusSchema` (path `/status/properties`) when
 *    `entity.status` is not `null`.
 * 2. `entity.spec.relations` is validated against `newDefinition.relations`
 *    with scope `'spec'` (`./relation-values.js`'s `validateRelationValues`,
 *    so `required` applies); `entity.status?.relations` with scope
 *    `'status'` (so `required` does not apply), when `entity.status` is not
 *    `null`.
 * 3. When `options.previousDefinition` is given, every relation present in
 *    both definitions whose `target` differs is a violation for this entity
 *    if the entity has any spec or status value for that relation ("Changing
 *    an existing relation's `target` MUST be rejected ... while any entity
 *    has a spec or status value for that relation"). This is the pure half
 *    of the rule: it never re-checks that either target blueprint exists.
 *
 * Any failure for an entity is collected as one `CompatibilityViolation`
 * (`entityIdentifier` plus every issue found for it), and iteration
 * continues with the next entity - it never throws for an incompatible
 * entity. Once `violations.length` reaches `options.maxViolations` (default
 * 10), the function stops pulling further entities from `entities` and
 * returns immediately. `result.compatible` is `violations.length === 0`.
 */
import { describe, expect, it } from 'vitest';
import { checkCompatibility } from './compatibility.js';
import { parseBlueprintDefinition } from './blueprint-definition.js';

interface CompatibilityEntitySnapshot {
  identifier: string;
  spec: { properties: Record<string, unknown>; relations: Record<string, unknown> };
  status: { properties: Record<string, unknown>; relations: Record<string, unknown> } | null;
}

interface CompatibilityViolation {
  entityIdentifier: string;
  issues: { path: string; message: string }[];
}

/** Typed accessor so `result.violations` (from the not-yet-existing module) never becomes `any`. */
function violationIdentifiers(violations: readonly CompatibilityViolation[]): string[] {
  return violations.map((violation) => violation.entityIdentifier);
}

function hasIssueAt(violation: CompatibilityViolation | undefined, path: string): boolean {
  return violation?.issues.some((issue) => issue.path === path) ?? false;
}

function entity(
  identifier: string,
  properties: Record<string, unknown> = {},
  relations: Record<string, unknown> = {},
  status: CompatibilityEntitySnapshot['status'] = null,
): CompatibilityEntitySnapshot {
  return { identifier, spec: { properties, relations }, status };
}

async function* toAsyncIterable<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

/** An async iterable that records how many items were actually pulled, to prove early exit. */
function countingAsyncIterable<T>(
  items: readonly T[],
  counter: { pulls: number },
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      let index = 0;
      return {
        next(): Promise<IteratorResult<T>> {
          if (index >= items.length) {
            return Promise.resolve({ done: true, value: undefined });
          }
          counter.pulls += 1;
          const value = items[index] as T;
          index += 1;
          return Promise.resolve({ done: false, value });
        },
      };
    },
  };
}

function blueprintWith(overrides: Record<string, unknown> = {}) {
  return parseBlueprintDefinition({
    identifier: 'service',
    title: { en: 'Service' },
    schema: {
      properties: { language: { type: 'string', title: { en: 'Language' } } },
      required: ['language'],
    },
    ...overrides,
  });
}

describe('"Adding an optional property is compatible"', () => {
  it('reports no violations when the new optional property has no values', async () => {
    const newDefinition = blueprintWith({
      schema: {
        properties: {
          language: { type: 'string', title: { en: 'Language' } },
          tier: { type: 'string', title: { en: 'Tier' } },
        },
        required: ['language'],
      },
    });
    const entities = [1, 2, 3, 4, 5].map((n) => entity(`svc-${String(n)}`, { language: 'go' }));

    const result = await checkCompatibility(newDefinition, toAsyncIterable(entities));

    expect(result.compatible).toBe(true);
    expect(result.violations).toEqual([]);
  });
});

describe('"Adding a required property without values is incompatible"', () => {
  it('lists every entity missing the newly required property', async () => {
    const newDefinition = blueprintWith({
      schema: {
        properties: {
          language: { type: 'string', title: { en: 'Language' } },
          tier: { type: 'string', title: { en: 'Tier' } },
        },
        required: ['language', 'tier'],
      },
    });
    const entities = [entity('svc-1', { language: 'go' }), entity('svc-2', { language: 'rust' })];

    const result = await checkCompatibility(newDefinition, toAsyncIterable(entities));

    expect(result.compatible).toBe(false);
    expect(violationIdentifiers(result.violations).sort()).toEqual(['svc-1', 'svc-2']);
    for (const violation of result.violations as CompatibilityViolation[]) {
      expect(hasIssueAt(violation, '/spec/properties/tier')).toBe(true);
    }
  });
});

describe('"Removing a property that has values is incompatible"', () => {
  it('lists the entity that still has a value for the removed property', async () => {
    const newDefinition = blueprintWith({
      schema: { properties: {}, required: [] }, // "language" removed
    });
    const entities = [entity('payments', { language: 'go' })];

    const result = await checkCompatibility(newDefinition, toAsyncIterable(entities));

    expect(result.compatible).toBe(false);
    expect(violationIdentifiers(result.violations)).toContain('payments');
    expect(
      hasIssueAt((result.violations as CompatibilityViolation[])[0], '/spec/properties/language'),
    ).toBe(true);
  });
});

describe('"Stale expected version" is out of scope for the pure checker', () => {
  it('checkCompatibility never inspects a version field (it is service-layer concern, task 7.4)', async () => {
    const newDefinition = blueprintWith();
    const entities = [entity('svc-1', { language: 'go' })];

    const result = await checkCompatibility(newDefinition, toAsyncIterable(entities));

    expect(result.compatible).toBe(true);
  });
});

describe('early exit after 10 violations', () => {
  it('stops pulling entities once 10 violations are found, out of 15 bad entities', async () => {
    const newDefinition = blueprintWith({
      schema: {
        properties: { language: { type: 'string', title: { en: 'Language' } } },
        required: ['language'],
      },
    });
    // Every entity is missing the required "language" property.
    const badEntities = Array.from({ length: 15 }, (_, index) => entity(`svc-${String(index)}`));
    const counter = { pulls: 0 };

    const result = await checkCompatibility(
      newDefinition,
      countingAsyncIterable(badEntities, counter),
    );

    expect(result.violations).toHaveLength(10);
    expect(result.compatible).toBe(false);
    expect(counter.pulls).toBe(10);
  });
});

describe('status properties are checked against the proposed statusSchema', () => {
  it('flags an entity whose status property is no longer declared', async () => {
    const newDefinition = blueprintWith({ statusSchema: { properties: {}, required: [] } });
    const entities = [
      entity(
        'payments',
        { language: 'go' },
        {},
        { properties: { lastDeployAt: '2026-09-01T10:00:00Z' }, relations: {} },
      ),
    ];

    const result = await checkCompatibility(newDefinition, toAsyncIterable(entities));

    expect(result.compatible).toBe(false);
    expect(violationIdentifiers(result.violations)).toContain('payments');
    expect(
      hasIssueAt(
        (result.violations as CompatibilityViolation[])[0],
        '/status/properties/lastDeployAt',
      ),
    ).toBe(true);
  });

  it('does not flag an entity with no status when statusSchema changes incompatibly', async () => {
    const newDefinition = blueprintWith({ statusSchema: { properties: {}, required: [] } });
    const entities = [entity('sandbox', { language: 'go' }, {}, null)];

    const result = await checkCompatibility(newDefinition, toAsyncIterable(entities));

    expect(result.compatible).toBe(true);
  });
});

describe('relation requiredness and cardinality are checked (spec relations only for "required")', () => {
  it('flags an entity missing a value for a newly required relation', async () => {
    const newDefinition = blueprintWith({
      relations: { owner: { title: { en: 'Owner' }, target: 'team', many: false, required: true } },
    });
    const entities = [entity('payments', { language: 'go' })];

    const result = await checkCompatibility(newDefinition, toAsyncIterable(entities));

    expect(result.compatible).toBe(false);
    expect(
      hasIssueAt((result.violations as CompatibilityViolation[])[0], '/spec/relations/owner'),
    ).toBe(true);
  });

  it('does not require a status value for a required relation (required does not apply to status)', async () => {
    const newDefinition = blueprintWith({
      relations: { owner: { title: { en: 'Owner' }, target: 'team', many: false, required: true } },
    });
    const entities = [
      entity(
        'payments',
        { language: 'go' },
        { owner: 'team-a' },
        { properties: {}, relations: {} },
      ),
    ];

    const result = await checkCompatibility(newDefinition, toAsyncIterable(entities));

    expect(result.compatible).toBe(true);
  });
});

describe('relation target change while an entity holds a value is incompatible (pure half)', () => {
  it('flags an entity with a spec value for a relation whose target changed', async () => {
    const previousDefinition = blueprintWith({
      relations: {
        owner: { title: { en: 'Owner' }, target: 'team', many: false, required: false },
      },
    });
    const newDefinition = blueprintWith({
      relations: {
        owner: { title: { en: 'Owner' }, target: 'department', many: false, required: false },
      },
    });
    const entities = [entity('payments', { language: 'go' }, { owner: 'team-a' })];

    const result = await checkCompatibility(newDefinition, toAsyncIterable(entities), {
      previousDefinition,
    });

    expect(result.compatible).toBe(false);
    expect(violationIdentifiers(result.violations)).toContain('payments');
  });

  it('does not flag an entity with no value for a relation whose target changed', async () => {
    const previousDefinition = blueprintWith({
      relations: {
        owner: { title: { en: 'Owner' }, target: 'team', many: false, required: false },
      },
    });
    const newDefinition = blueprintWith({
      relations: {
        owner: { title: { en: 'Owner' }, target: 'department', many: false, required: false },
      },
    });
    const entities = [entity('sandbox', { language: 'go' })];

    const result = await checkCompatibility(newDefinition, toAsyncIterable(entities), {
      previousDefinition,
    });

    expect(result.compatible).toBe(true);
  });

  it('does not flag anything when no previousDefinition is given', async () => {
    const newDefinition = blueprintWith({
      relations: {
        owner: { title: { en: 'Owner' }, target: 'department', many: false, required: false },
      },
    });
    const entities = [entity('payments', { language: 'go' }, { owner: 'team-a' })];

    const result = await checkCompatibility(newDefinition, toAsyncIterable(entities));

    expect(result.compatible).toBe(true);
  });
});
