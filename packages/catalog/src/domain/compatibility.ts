/**
 * The pure half of "Safe blueprint schema evolution" (spec; design D7:
 * "Validate each entity against the proposed definition, and stop after 10
 * violations"). Never throws for an incompatible entity: any failure is
 * collected as one `CompatibilityViolation`, and iteration continues with
 * the next entity.
 */
import { compileEntityValidator, type EntityPropertyValidator } from './entity-validator.js';
import { validateRelationValues } from './relation-values.js';
import { isCatalogError, type CatalogErrorIssue } from './errors.js';
import type { ParsedBlueprintDefinition, ParsedPropertySchema } from './blueprint-definition.js';

/**
 * How a proposed schema is compiled into a validator. Defaults to a direct,
 * uncached `compileEntityValidator` call, so every existing caller (this
 * module's own tests) is unaffected. The service layer overrides this
 * (`service/blueprints.ts`) to route compilation through
 * `service/schema-validator-cache.js` (task 4.8, design D6), so a
 * `blueprints.update`'s compatibility check reuses -- and, on a miss,
 * pre-warms -- the same validator-cache entry entity writes at the new
 * version will hit next.
 */
export type CompileValidatorFn = (schema: ParsedPropertySchema, kind: 'spec' | 'status') => EntityPropertyValidator;

export interface CompatibilityEntitySnapshot {
  identifier: string;
  spec: { properties: Record<string, unknown>; relations: Record<string, unknown> };
  status: { properties: Record<string, unknown>; relations: Record<string, unknown> } | null;
}

export interface CompatibilityViolation {
  entityIdentifier: string;
  issues: CatalogErrorIssue[];
}

export interface CompatibilityCheckResult {
  compatible: boolean;
  violations: CompatibilityViolation[];
}

export interface CheckCompatibilityOptions {
  previousDefinition?: ParsedBlueprintDefinition;
  /** Stop after this many violations (default 10, design D7). */
  maxViolations?: number;
  /** See `CompileValidatorFn`. Defaults to an uncached `compileEntityValidator`. */
  compileValidator?: CompileValidatorFn;
}

const DEFAULT_MAX_VIOLATIONS = 10;

/** Runs `check`, folding a `CatalogError`'s issues into `issues` instead of throwing. */
function collectIssues(issues: CatalogErrorIssue[], check: () => void): void {
  try {
    check();
  } catch (error) {
    if (!isCatalogError(error)) throw error;
    issues.push(...(error.issues ?? []));
  }
}

/** Relations present in both definitions whose `target` changed (design D7's relation-target rule). */
function changedRelationTargets(
  newDefinition: ParsedBlueprintDefinition,
  previousDefinition: ParsedBlueprintDefinition | undefined,
): ReadonlySet<string> {
  const changed = new Set<string>();
  if (!previousDefinition) return changed;

  for (const [name, definition] of Object.entries(newDefinition.relations)) {
    const previous = previousDefinition.relations[name];
    if (previous && previous.target !== definition.target) changed.add(name);
  }
  return changed;
}

function entityIssues(
  entity: CompatibilityEntitySnapshot,
  newDefinition: ParsedBlueprintDefinition,
  specValidator: EntityPropertyValidator,
  statusValidator: EntityPropertyValidator | undefined,
  changedTargets: ReadonlySet<string>,
): CatalogErrorIssue[] {
  const issues: CatalogErrorIssue[] = [];

  collectIssues(issues, () => {
    specValidator.validate(entity.spec.properties, '/spec/properties');
  });
  collectIssues(issues, () => {
    validateRelationValues(newDefinition.relations, entity.spec.relations, 'spec');
  });

  if (entity.status !== null) {
    const status = entity.status;
    if (statusValidator) {
      collectIssues(issues, () => {
        statusValidator.validate(status.properties, '/status/properties');
      });
    }
    collectIssues(issues, () => {
      validateRelationValues(newDefinition.relations, status.relations, 'status');
    });
  }

  for (const name of changedTargets) {
    const hasSpecValue = entity.spec.relations[name] !== undefined;
    const hasStatusValue = entity.status?.relations[name] !== undefined;
    if (hasSpecValue || hasStatusValue) {
      issues.push({
        path: `/spec/relations/${name}`,
        message: "Changing this relation's target is incompatible with entities holding a value for it",
      });
    }
  }

  return issues;
}

/**
 * Validates every entity pulled from `entities` against `newDefinition`, in
 * order, stopping once `options.maxViolations` (default 10) violations have
 * been found - it then stops pulling further entities.
 */
export async function checkCompatibility(
  newDefinition: ParsedBlueprintDefinition,
  entities: AsyncIterable<CompatibilityEntitySnapshot>,
  options: CheckCompatibilityOptions = {},
): Promise<CompatibilityCheckResult> {
  const maxViolations = options.maxViolations ?? DEFAULT_MAX_VIOLATIONS;
  const changedTargets = changedRelationTargets(newDefinition, options.previousDefinition);
  const compileValidator: CompileValidatorFn = options.compileValidator ?? ((schema) => compileEntityValidator(schema));
  const specValidator = compileValidator(newDefinition.schema, 'spec');
  const statusValidator = newDefinition.statusSchema
    ? compileValidator(newDefinition.statusSchema, 'status')
    : undefined;

  const violations: CompatibilityViolation[] = [];

  for await (const entity of entities) {
    const issues = entityIssues(entity, newDefinition, specValidator, statusValidator, changedTargets);
    if (issues.length > 0) {
      violations.push({ entityIdentifier: entity.identifier, issues });
      if (violations.length >= maxViolations) break;
    }
  }

  return { compatible: violations.length === 0, violations };
}
