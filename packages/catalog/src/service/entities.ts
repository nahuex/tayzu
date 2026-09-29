/**
 * Entity operations (tasks 8.1-8.10; design D3-D5, D7, D9-D11; spec "Entity
 * shape with spec and status", "Entity create and upsert semantics", "Status
 * is written only through the status operation", "Entity relations and
 * referential integrity", "Related entities traversal", "Entity read, list
 * and delete", "Reserved system identifiers", "Tenant data isolation",
 * "Actor attribution and change events").
 *
 * Every operation is declared through `defineCatalogOperation` (design D3,
 * `./pipeline.js`), so context validation, the tenant transaction, error
 * mapping and telemetry are the same for every operation and every actor
 * type, exactly like `./blueprints.ts`. Every entity write additionally locks
 * its target blueprint row `FOR SHARE` (design D7), so it can never interleave
 * with a concurrent `blueprints.update`'s own `FOR UPDATE` and commit against
 * a stale schema.
 */
import { trace } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { uuidv7 } from 'uuidv7';

import { applyWrite } from '../domain/apply-write.js';
import type { ParsedPropertySchema } from '../domain/blueprint-definition.js';
import { areCanonicallyEqual } from '../domain/canonical.js';
import type { ActorType, CatalogContext, Principal } from '../domain/context.js';
import { assertEntitySpecSize, assertEntityStatusSize } from '../domain/entity-limits.js';
import { CatalogError, isCatalogError } from '../domain/errors.js';
import { parseEntityIdentifier } from '../domain/identifiers.js';
import { defaultCatalogLimits, type CatalogLimits } from '../domain/limits.js';
import { assertCursorLength, decodeCursor, encodeCursor } from '../domain/pagination.js';
import { assertReservedAccess, type ReservedOperationKind } from '../domain/reserved.js';
import { parseSafeInput } from '../domain/safe-parse.js';
import { validateRelationValues } from '../domain/relation-values.js';
import type { RelationDefinition } from '../domain/relation-definition.js';
import type { ValidatorCacheKey } from '../domain/validator-cache.js';
import { appendChangeEvent } from '../persistence/change-events.js';
import {
  findBlueprintIdByIdentifier,
  selectBlueprintRow,
} from '../persistence/blueprints-repository.js';
import {
  FOREIGN_KEY_VIOLATION_SQLSTATE,
  UNIQUE_VIOLATION_SQLSTATE,
  pgErrorInfo,
} from '../persistence/db-errors.js';
import {
  assembleEntityRelationBag,
  bumpEntityVersionRow,
  deleteEntityRelationEdgesForSource,
  deleteEntityRelationEdgesForTarget,
  deleteEntityRow,
  findEntityIdsByIdentifiers,
  insertEntityRelationEdges,
  insertEntityRow,
  selectBackwardRelatedPage,
  selectBlueprintIdentifierById,
  selectDistinctStatusReferrerIds,
  selectEntitiesPage,
  selectEntityRow,
  selectEntityRowById,
  selectForwardRelatedPage,
  selectRelationDefinitionsForSource,
  selectRelationEdgesForEntity,
  selectSpecReferrers,
  updateEntitySpecRow,
  updateEntityStatusRow,
  type EntityRelationDefinitionById,
  type EntityRelationEdgeInput,
  type EntityRepositoryTx,
  type EntityRow,
} from '../persistence/entities-repository.js';
import type { LocalizedText } from '../domain/localized-text.js';
import { entityMutationsCounter, logger, tracer } from '../telemetry/instruments.js';
import { RESOURCE_KINDS, type CerbosClient } from '@tayzu/authz';
import { defineCatalogOperation, inputString } from './pipeline.js';
import { getCachedSpecValidator, getCachedStatusValidator } from './schema-validator-cache.js';

export interface EntitySpecWriteInput {
  readonly properties?: Record<string, unknown>;
  readonly relations?: Record<string, unknown>;
}

export interface CreateEntityInput {
  readonly blueprint: string;
  readonly identifier: string;
  readonly title: string;
  readonly icon?: string;
  readonly spec?: EntitySpecWriteInput;
}

export type UpsertEntityMode = 'replace' | 'merge';
export type UpsertEntityInput = CreateEntityInput & {
  readonly mode: UpsertEntityMode;
  readonly expectedVersion?: number;
};

export type UpsertOutcome = 'created' | 'updated' | 'unchanged';
export type UpsertEntityOutput = EntityOutput & { readonly outcome: UpsertOutcome };

export interface WriteEntityStatusInput {
  readonly blueprint: string;
  readonly identifier: string;
  readonly properties?: Record<string, unknown>;
  readonly relations?: Record<string, unknown>;
  readonly observedGeneration: number;
  readonly source: string;
}

export interface GetEntityInput {
  readonly blueprint: string;
  readonly identifier: string;
}
export interface DeleteEntityInput {
  readonly blueprint: string;
  readonly identifier: string;
  readonly detachReferences?: boolean;
}
export interface ListEntitiesInput {
  readonly blueprint: string;
  readonly pageSize?: number;
  readonly cursor?: string;
}
export interface ListEntitiesOutput {
  readonly items: readonly EntityOutput[];
  readonly cursor?: string;
}

export type RelatedDirection = 'forward' | 'backward';
export type RelatedScopeFilter = 'spec' | 'status' | 'both';
export interface ListRelatedInput {
  readonly blueprint: string;
  readonly identifier: string;
  readonly direction: RelatedDirection;
  readonly scope?: RelatedScopeFilter;
  readonly pageSize?: number;
  readonly cursor?: string;
}
export interface RelatedEntitySummary {
  readonly blueprint: string;
  readonly identifier: string;
  readonly title: string;
}
export interface RelatedEntityItem {
  readonly relation: string;
  readonly scope: 'spec' | 'status';
  /** Forward: the traversal root's own blueprint. Backward: the referrer's (source) blueprint. */
  readonly sourceBlueprint: string;
  /** Forward: the relation's target. Backward: the referrer itself. */
  readonly entity: RelatedEntitySummary;
}
export interface ListRelatedOutput {
  readonly items: readonly RelatedEntityItem[];
  readonly cursor?: string;
}

export interface EntityStatusOutput {
  readonly properties: Record<string, unknown>;
  readonly relations: Record<string, string | string[]>;
  readonly observedGeneration: number;
  readonly observedAt: string;
  readonly source: string;
}

export interface EntityOutput {
  readonly blueprint: string;
  readonly identifier: string;
  readonly title: string;
  readonly icon?: string;
  readonly spec: {
    readonly properties: Record<string, unknown>;
    readonly relations: Record<string, string | string[]>;
  };
  readonly status: EntityStatusOutput | null;
  readonly generation: number;
  readonly version: number;
  readonly createdAt: string;
  readonly createdBy: CatalogContext['actor'];
  readonly updatedAt: string;
  readonly updatedBy: CatalogContext['actor'];
}

export interface CreateEntityServiceOptions {
  readonly pool: Pool;
  /** The Cerbos client every operation authorizes through (design Q27). */
  readonly authz: CerbosClient;
  readonly limits?: CatalogLimits;
}

export interface EntityService {
  readonly create: (rawContext: unknown, input: CreateEntityInput) => Promise<EntityOutput>;
  readonly upsert: (rawContext: unknown, input: UpsertEntityInput) => Promise<UpsertEntityOutput>;
  readonly writeStatus: (
    rawContext: unknown,
    input: WriteEntityStatusInput,
  ) => Promise<EntityOutput>;
  readonly get: (rawContext: unknown, input: GetEntityInput) => Promise<EntityOutput>;
  readonly list: (rawContext: unknown, input: ListEntitiesInput) => Promise<ListEntitiesOutput>;
  readonly delete: (rawContext: unknown, input: DeleteEntityInput) => Promise<void>;
  readonly listRelated: (
    rawContext: unknown,
    input: ListRelatedInput,
  ) => Promise<ListRelatedOutput>;
}

const BLUEPRINT_IDENTIFIER_ATTRIBUTE = 'tayzu.catalog.blueprint.identifier';
const ENTITY_IDENTIFIER_ATTRIBUTE = 'tayzu.catalog.entity.identifier';

/** design.md, "Log events" table: the reserved-identifier WARN, emitted before `assertReservedAccess` throws (mirrors `blueprints.ts`'s own `denyIfReserved`). */
function denyIfReserved(
  ctx: CatalogContext,
  blueprintIdentifier: string,
  operation: ReservedOperationKind,
): void {
  try {
    assertReservedAccess(blueprintIdentifier, operation, ctx.actor);
  } catch (error) {
    if (isCatalogError(error) && error.code === 'CATALOG_RESERVED_IDENTIFIER') {
      logger.emit({
        eventName: 'catalog.security.reserved_identifier_denied',
        severityNumber: SeverityNumber.WARN,
        attributes: {
          'tayzu.tenant.id': ctx.tenantId,
          'tayzu.actor.type': ctx.actor.type,
          'tayzu.actor.id': ctx.actor.id,
          [BLUEPRINT_IDENTIFIER_ATTRIBUTE]: blueprintIdentifier,
        },
      });
    }
    throw error;
  }
}

/**
 * design D9, spec Conventions "Unsafe keys are rejected": the service
 * boundary guard for every entity write. Rebuilds `rawInput` as
 * null-prototype objects and rejects `__proto__`/`constructor`/`prototype`
 * at every depth, before limits, `applyWrite` or Ajv ever see it.
 */
function parseSafeEntityInput(rawInput: unknown, limits: CatalogLimits): unknown {
  return parseSafeInput(rawInput, { maxDepth: limits.object.maxNestingDepth });
}

/** Spec "Entity shape with spec and status": a plain string of 1-256 characters. */
function parseEntityTitle(value: string, path: string): string {
  if (value.length < 1 || value.length > 256) {
    throw new CatalogError('CATALOG_VALIDATION_FAILED', 'Entity title is invalid', {
      issues: [{ path, message: 'Entity title is invalid' }],
    });
  }
  return value;
}

function parseEntityIcon(value: string | undefined, limits: CatalogLimits): string | undefined {
  if (value === undefined) return undefined;
  if (value.length > limits.icon.maxLength) {
    throw new CatalogError('CATALOG_VALIDATION_FAILED', 'Entity icon is too long', {
      issues: [{ path: '/icon', message: 'Entity icon is too long' }],
    });
  }
  return value;
}

/** Spec "Status is written only through the status operation": `source` matches the property/relation identifier pattern. */
function parseStatusSource(value: string, limits: CatalogLimits): string {
  if (!limits.statusSource.pattern.test(value)) {
    throw new CatalogError('CATALOG_VALIDATION_FAILED', 'Status source is invalid', {
      issues: [{ path: '/source', message: 'Status source is invalid' }],
    });
  }
  return value;
}

/** design D9: `23505` on the entity identifier uniqueness constraint -> `CATALOG_ALREADY_EXISTS`; known edge/blueprint/relation-definition FKs -> `CATALOG_REFERENCE_VIOLATION`; anything else propagates unchanged. */
const ENTITY_REFERENCE_VIOLATION_CONSTRAINTS: ReadonlySet<string> = new Set([
  'catalog_entity_relation_target_fk',
  'catalog_entity_blueprint_fk',
  'catalog_entity_relation_relation_definition_fk',
]);

function throwMappedEntityWriteError(error: unknown): never {
  const info = pgErrorInfo(error);
  if (
    info.code === UNIQUE_VIOLATION_SQLSTATE &&
    info.constraint === 'catalog_entity_tenant_blueprint_identifier_uq'
  ) {
    throw new CatalogError('CATALOG_ALREADY_EXISTS', 'Entity identifier already exists');
  }
  if (
    info.code === FOREIGN_KEY_VIOLATION_SQLSTATE &&
    info.constraint !== undefined &&
    ENTITY_REFERENCE_VIOLATION_CONSTRAINTS.has(info.constraint)
  ) {
    throw new CatalogError('CATALOG_REFERENCE_VIOLATION', 'Entity reference is invalid');
  }
  throw error;
}

/** A source blueprint's relation definitions, indexed the ways entity writes and reads need them. */
interface LoadedRelationDefinitions {
  /** For `domain/relation-values.js`'s shape/cardinality validation (`target` is the target blueprint's identifier). */
  readonly definitions: Record<string, RelationDefinition>;
  /** For assembling an entity's own relation bag back from its edges. */
  readonly byId: EntityRelationDefinitionById;
  readonly targetBlueprintIdByName: ReadonlyMap<string, string>;
  readonly relationDefinitionIdByName: ReadonlyMap<string, string>;
}

async function loadEntityRelationDefinitions(
  tx: EntityRepositoryTx,
  tenantId: string,
  blueprintId: string,
): Promise<LoadedRelationDefinitions> {
  const rows = await selectRelationDefinitionsForSource(tx, tenantId, blueprintId);
  const definitions: Record<string, RelationDefinition> = {};
  const byId = new Map<string, { identifier: string; many: boolean }>();
  const targetBlueprintIdByName = new Map<string, string>();
  const relationDefinitionIdByName = new Map<string, string>();

  for (const row of rows) {
    definitions[row.identifier] = {
      title: row.title as LocalizedText,
      target: row.target_identifier,
      many: row.many,
      required: row.required,
    };
    byId.set(row.id, { identifier: row.identifier, many: row.many });
    targetBlueprintIdByName.set(row.identifier, row.target_blueprint_id);
    relationDefinitionIdByName.set(row.identifier, row.id);
  }

  return { definitions, byId, targetBlueprintIdByName, relationDefinitionIdByName };
}

async function loadEntityRelationBags(
  tx: EntityRepositoryTx,
  tenantId: string,
  entityId: string,
  relationDefs: LoadedRelationDefinitions,
): Promise<{ spec: Record<string, string | string[]>; status: Record<string, string | string[]> }> {
  const edges = await selectRelationEdgesForEntity(tx, tenantId, entityId);
  return {
    spec: assembleEntityRelationBag(edges, 'spec', relationDefs.byId),
    status: assembleEntityRelationBag(edges, 'status', relationDefs.byId),
  };
}

/** Identifies the compiled validator this write needs (design D6: `(tenantId, blueprintId, version)`, one instance per schema role). */
interface ValidatedSchemaRef {
  readonly tenantId: string;
  readonly blueprintIdentifier: string;
  readonly blueprintVersion: number;
  readonly scope: 'spec' | 'status';
}

/**
 * design.md, Spans table: `catalog.entity.validate`, `tayzu.catalog.validation.issue.count`
 * conditional on failure. The compiled validator itself comes from
 * `./schema-validator-cache.js` (task 4.8's LRU, design D6), keyed by
 * `(tenantId, blueprintId, version)`: a cache hit skips Ajv compilation
 * entirely, and a miss emits its own child `catalog.schema.compile` span.
 */
function runEntityValidation(
  schema: ParsedPropertySchema,
  properties: unknown,
  path: string,
  limits: CatalogLimits,
  ref: ValidatedSchemaRef,
): Record<string, unknown> {
  return tracer.startActiveSpan('catalog.entity.validate', (span) => {
    span.setAttribute(BLUEPRINT_IDENTIFIER_ATTRIBUTE, ref.blueprintIdentifier);
    try {
      const key: ValidatorCacheKey = {
        tenantId: ref.tenantId,
        blueprintId: ref.blueprintIdentifier,
        version: ref.blueprintVersion,
      };
      const validator =
        ref.scope === 'spec'
          ? getCachedSpecValidator(key, schema, limits)
          : getCachedStatusValidator(key, schema, limits);
      return validator.validate(properties, path);
    } catch (error) {
      if (isCatalogError(error) && error.issues) {
        span.setAttribute('tayzu.catalog.validation.issue.count', error.issues.length);
      }
      throw error;
    } finally {
      span.end();
    }
  });
}

interface ResolvedRelationTargets {
  readonly resolved: Map<string, string[]>;
  readonly totalTargets: number;
}

/**
 * Skips `resolveEntityRelationTargets` (and its child span) entirely when the
 * source blueprint declares no relations at all: there is nothing to
 * resolve, and every entity write otherwise calls this on every create,
 * upsert and status write, which would emit a `catalog.relations.resolve`
 * span with `target.count: 0` even for a blueprint with no relations.
 */
async function resolveRelationsIfDeclared(
  tx: EntityRepositoryTx,
  tenantId: string,
  relationDefs: LoadedRelationDefinitions,
  relationValues: Record<string, string | string[]>,
  scope: 'spec' | 'status',
): Promise<ResolvedRelationTargets> {
  if (Object.keys(relationDefs.definitions).length === 0) {
    return { resolved: new Map(), totalTargets: 0 };
  }
  return resolveEntityRelationTargets(tx, tenantId, relationDefs, relationValues, scope);
}

/**
 * design.md, Spans table: `catalog.relations.resolve`. Resolves every
 * `relationValues` target to an existing entity of the relation's declared
 * target blueprint, in the same tenant (spec "Entity relations and
 * referential integrity", "Tenant data isolation"). Throws
 * `CATALOG_REFERENCE_VIOLATION` naming the first relation with a missing
 * target, before any row is written.
 */
async function resolveEntityRelationTargets(
  tx: EntityRepositoryTx,
  tenantId: string,
  relationDefs: LoadedRelationDefinitions,
  relationValues: Record<string, string | string[]>,
  scope: 'spec' | 'status',
): Promise<ResolvedRelationTargets> {
  return tracer.startActiveSpan('catalog.relations.resolve', async (span) => {
    try {
      const resolved = new Map<string, string[]>();
      let totalTargets = 0;
      let totalMissing = 0;
      let firstMissingRelation: string | undefined;
      let firstMissingIdentifiers: string[] = [];

      for (const [name, value] of Object.entries(relationValues)) {
        const targetBlueprintId = relationDefs.targetBlueprintIdByName.get(name);
        if (targetBlueprintId === undefined) {
          throw new Error(`unreachable: relation target blueprint id for "${name}" was not loaded`);
        }
        const identifiers = Array.isArray(value) ? value : [value];
        totalTargets += identifiers.length;
        if (identifiers.length === 0) {
          resolved.set(name, []);
          continue;
        }

        const idsByIdentifier = await findEntityIdsByIdentifiers(
          tx,
          tenantId,
          targetBlueprintId,
          identifiers,
        );
        const targetIds: string[] = [];
        const missing: string[] = [];
        for (const identifier of identifiers) {
          const entityId = idsByIdentifier.get(identifier);
          if (entityId === undefined) missing.push(identifier);
          else targetIds.push(entityId);
        }

        if (missing.length > 0) {
          totalMissing += missing.length;
          if (firstMissingRelation === undefined) {
            firstMissingRelation = name;
            firstMissingIdentifiers = missing;
          }
        } else {
          resolved.set(name, targetIds);
        }
      }

      span.setAttribute('tayzu.catalog.relation.target.count', totalTargets);
      if (totalMissing > 0) span.setAttribute('tayzu.catalog.relation.missing.count', totalMissing);

      if (firstMissingRelation !== undefined) {
        throw new CatalogError('CATALOG_REFERENCE_VIOLATION', 'Relation target does not exist', {
          issues: [
            {
              path: `/${scope}/relations/${firstMissingRelation}`,
              message: 'Relation target does not exist',
            },
          ],
          details: { relation: firstMissingRelation, missing: firstMissingIdentifiers },
        });
      }

      return { resolved, totalTargets };
    } finally {
      span.end();
    }
  });
}

async function writeRelationEdges(
  tx: EntityRepositoryTx,
  tenantId: string,
  sourceEntityId: string,
  scope: 'spec' | 'status',
  relationDefs: LoadedRelationDefinitions,
  resolved: ReadonlyMap<string, string[]>,
): Promise<void> {
  const edges: EntityRelationEdgeInput[] = [];
  for (const [name, targetIds] of resolved) {
    const relationDefinitionId = relationDefs.relationDefinitionIdByName.get(name);
    if (relationDefinitionId === undefined) {
      throw new Error(`unreachable: relation definition id for "${name}" was not loaded`);
    }
    targetIds.forEach((targetEntityId, index) => {
      edges.push({ relationDefinitionId, targetEntityId, position: index });
    });
  }
  if (edges.length > 0) {
    await insertEntityRelationEdges(tx, tenantId, sourceEntityId, scope, edges);
  }
}

function buildStatusOutput(
  row: EntityRow,
  statusRelations: Record<string, string | string[]>,
): EntityStatusOutput | null {
  if (row.status_properties === null) return null;
  return {
    properties: row.status_properties as Record<string, unknown>,
    relations: statusRelations,
    observedGeneration: row.status_observed_generation as number,
    observedAt: new Date(row.status_observed_at as string).toISOString(),
    source: row.status_source as string,
  };
}

function buildEntityOutput(
  blueprintIdentifier: string,
  row: EntityRow,
  relationBags: {
    spec: Record<string, string | string[]>;
    status: Record<string, string | string[]>;
  },
): EntityOutput {
  return {
    blueprint: blueprintIdentifier,
    identifier: row.identifier,
    title: row.title,
    icon: row.icon ?? undefined,
    spec: {
      properties: row.spec_properties as Record<string, unknown>,
      relations: relationBags.spec,
    },
    status: buildStatusOutput(row, relationBags.status),
    generation: row.generation,
    version: row.version,
    createdAt: new Date(row.created_at).toISOString(),
    createdBy: { type: row.created_by_type as ActorType, id: row.created_by_id },
    updatedAt: new Date(row.updated_at).toISOString(),
    updatedBy: { type: row.updated_by_type as ActorType, id: row.updated_by_id },
  };
}

interface FreshEntityOutputParams {
  readonly blueprintIdentifier: string;
  readonly identifier: string;
  readonly title: string;
  readonly icon?: string;
  readonly specProperties: Record<string, unknown>;
  readonly specRelations: Record<string, string | string[]>;
  readonly generation: number;
  readonly version: number;
  readonly now: Date;
  readonly actor: Principal;
}

/** Builds the output of a just-inserted row, without a database round trip. */
function buildFreshEntityOutput(params: FreshEntityOutputParams): EntityOutput {
  return {
    blueprint: params.blueprintIdentifier,
    identifier: params.identifier,
    title: params.title,
    icon: params.icon,
    spec: { properties: params.specProperties, relations: params.specRelations },
    status: null,
    generation: params.generation,
    version: params.version,
    createdAt: params.now.toISOString(),
    createdBy: params.actor,
    updatedAt: params.now.toISOString(),
    updatedBy: params.actor,
  };
}

/** Spec "Actor attribution and change events": `{ title, icon, spec, status }`, the last state for a delete. */
function buildEntitySnapshot(output: EntityOutput): Record<string, unknown> {
  return { title: output.title, icon: output.icon, spec: output.spec, status: output.status };
}

function emitEntityMutation(
  tenantId: string,
  blueprintIdentifier: string,
  mutation: string,
  actorType: ActorType,
): void {
  entityMutationsCounter.add(1, {
    'tayzu.tenant.id': tenantId,
    'tayzu.catalog.blueprint.identifier': blueprintIdentifier,
    'tayzu.catalog.mutation': mutation,
    'tayzu.actor.type': actorType,
  });
}

/** A two-field opaque cursor for `listRelated`'s `(relation, identifier)` keyset (design D10). */
interface RelatedCursorKey {
  readonly relation: string;
  readonly identifier: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidRelatedCursor(): never {
  throw new CatalogError('CATALOG_VALIDATION_FAILED', 'Pagination cursor is invalid', {
    issues: [{ path: '/cursor', message: 'Pagination cursor is invalid' }],
  });
}

function encodeRelatedCursor(key: RelatedCursorKey): string {
  return Buffer.from(JSON.stringify({ r: key.relation, i: key.identifier }), 'utf8').toString(
    'base64url',
  );
}

function decodeRelatedCursor(cursor: string): RelatedCursorKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    invalidRelatedCursor();
  }
  if (!isRecord(parsed) || typeof parsed['r'] !== 'string' || typeof parsed['i'] !== 'string') {
    invalidRelatedCursor();
  }
  return { relation: parsed['r'], identifier: parsed['i'] };
}

/** Caches a delete's per-blueprint relation definitions and identifier, since referrers may span several blueprints. */
interface ReferrerCache {
  readonly relationDefsByBlueprintId: Map<string, LoadedRelationDefinitions>;
  readonly identifierByBlueprintId: Map<string, string>;
}

async function relationDefsFor(
  tx: EntityRepositoryTx,
  tenantId: string,
  blueprintId: string,
  cache: ReferrerCache,
): Promise<LoadedRelationDefinitions> {
  const cached = cache.relationDefsByBlueprintId.get(blueprintId);
  if (cached) return cached;
  const loaded = await loadEntityRelationDefinitions(tx, tenantId, blueprintId);
  cache.relationDefsByBlueprintId.set(blueprintId, loaded);
  return loaded;
}

async function blueprintIdentifierFor(
  tx: EntityRepositoryTx,
  tenantId: string,
  blueprintId: string,
  cache: ReferrerCache,
): Promise<string> {
  const cached = cache.identifierByBlueprintId.get(blueprintId);
  if (cached !== undefined) return cached;
  const found = await selectBlueprintIdentifierById(tx, tenantId, blueprintId);
  if (found === undefined) {
    throw new Error(`unreachable: blueprint ${blueprintId} vanished mid-transaction`);
  }
  cache.identifierByBlueprintId.set(blueprintId, found);
  return found;
}

interface BumpReferrerOptions {
  readonly bumpGeneration: boolean;
  readonly action: 'updated' | 'status_updated';
}

/** Rebuilds and bumps one referrer affected by another entity's delete, appending its own change event (design D9, spec "Detach on delete records every affected entity"). */
async function bumpReferrerAndAppendEvent(
  tx: EntityRepositoryTx,
  ctx: CatalogContext,
  referrerId: string,
  cache: ReferrerCache,
  options: BumpReferrerOptions,
): Promise<void> {
  const referrerRow = await selectEntityRowById(tx, ctx.tenantId, referrerId);
  if (!referrerRow) return; // defensive: the referrer exists within this same transaction

  const relationDefs = await relationDefsFor(tx, ctx.tenantId, referrerRow.blueprint_id, cache);
  const blueprintIdentifier = await blueprintIdentifierFor(
    tx,
    ctx.tenantId,
    referrerRow.blueprint_id,
    cache,
  );
  const bags = await loadEntityRelationBags(tx, ctx.tenantId, referrerId, relationDefs);

  const now = new Date();
  const newVersion = referrerRow.version + 1;
  const newGeneration = options.bumpGeneration
    ? referrerRow.generation + 1
    : referrerRow.generation;

  await bumpEntityVersionRow(tx, {
    tenantId: ctx.tenantId,
    id: referrerId,
    version: newVersion,
    generation: options.bumpGeneration ? newGeneration : undefined,
    now,
    actor: ctx.actor,
  });

  const output = buildEntityOutput(
    blueprintIdentifier,
    { ...referrerRow, generation: newGeneration, version: newVersion },
    bags,
  );

  await appendChangeEvent(tx, {
    tenantId: ctx.tenantId,
    actor: ctx.actor,
    action: options.action,
    resourceKind: 'entity',
    blueprintIdentifier,
    resourceIdentifier: referrerRow.identifier,
    version: newVersion,
    changedFields: options.action === 'updated' ? ['spec'] : ['status'],
    snapshot: buildEntitySnapshot(output),
    traceId: trace.getActiveSpan()?.spanContext().traceId,
  });

  emitEntityMutation(
    ctx.tenantId,
    blueprintIdentifier,
    options.action === 'updated' ? 'updated' : 'status_updated',
    ctx.actor.type,
  );
}

export function createEntityService(options: CreateEntityServiceOptions): EntityService {
  const { pool, authz } = options;
  const limits = options.limits ?? defaultCatalogLimits;

  const create = defineCatalogOperation<CreateEntityInput, EntityOutput>({
    name: 'entity.create',
    pool,
    authz,
    authorization: ({ input }) => ({
      kind: RESOURCE_KINDS.catalogEntity,
      action: 'create',
      resourceId: inputString(input, 'identifier'),
      attributes: { blueprintId: inputString(input, 'blueprint') },
    }),
    handler: async ({ ctx, client, input: rawInput }) => {
      const input = parseSafeEntityInput(rawInput, limits) as CreateEntityInput;
      const tx = drizzle(client);
      trace.getActiveSpan()?.setAttribute(BLUEPRINT_IDENTIFIER_ATTRIBUTE, input.blueprint);
      const identifier = parseEntityIdentifier(input.identifier, '/identifier');
      trace.getActiveSpan()?.setAttribute(ENTITY_IDENTIFIER_ATTRIBUTE, identifier);
      denyIfReserved(ctx, input.blueprint, 'entity_write');

      const blueprintRow = await selectBlueprintRow(tx, ctx.tenantId, input.blueprint, {
        forShare: true,
      });
      if (!blueprintRow) throw new CatalogError('CATALOG_NOT_FOUND', 'Blueprint not found');

      const relationDefs = await loadEntityRelationDefinitions(tx, ctx.tenantId, blueprintRow.id);

      const title = parseEntityTitle(input.title, '/title');
      const icon = parseEntityIcon(input.icon, limits);

      const nextSpec = applyWrite(
        undefined,
        { properties: input.spec?.properties, relations: input.spec?.relations },
        'replace',
      );
      assertEntitySpecSize(nextSpec, limits);

      const schema = blueprintRow.schema as ParsedPropertySchema;
      const validatedProperties = runEntityValidation(
        schema,
        nextSpec.properties,
        '/spec/properties',
        limits,
        {
          tenantId: ctx.tenantId,
          blueprintIdentifier: input.blueprint,
          blueprintVersion: blueprintRow.version,
          scope: 'spec',
        },
      );
      const relationValues = validateRelationValues(
        relationDefs.definitions,
        nextSpec.relations,
        'spec',
        { limits },
      );
      const { resolved, totalTargets } = await resolveRelationsIfDeclared(
        tx,
        ctx.tenantId,
        relationDefs,
        relationValues,
        'spec',
      );
      if (totalTargets > 0) {
        trace.getActiveSpan()?.setAttribute('tayzu.catalog.relation.target.count', totalTargets);
      }

      const id = uuidv7();
      const now = new Date();

      try {
        await insertEntityRow(tx, {
          id,
          tenantId: ctx.tenantId,
          blueprintId: blueprintRow.id,
          identifier,
          title,
          icon,
          specProperties: validatedProperties,
          generation: 1,
          version: 1,
          now,
          actor: ctx.actor,
        });
      } catch (error) {
        throwMappedEntityWriteError(error);
      }

      await writeRelationEdges(tx, ctx.tenantId, id, 'spec', relationDefs, resolved);

      const output = buildFreshEntityOutput({
        blueprintIdentifier: input.blueprint,
        identifier,
        title,
        icon,
        specProperties: validatedProperties,
        specRelations: relationValues,
        generation: 1,
        version: 1,
        now,
        actor: ctx.actor,
      });

      const traceId = trace.getActiveSpan()?.spanContext().traceId;
      const changeEventSeq = await appendChangeEvent(tx, {
        tenantId: ctx.tenantId,
        actor: ctx.actor,
        action: 'created',
        resourceKind: 'entity',
        blueprintIdentifier: input.blueprint,
        resourceIdentifier: identifier,
        version: 1,
        changedFields: ['title', 'icon', 'spec'],
        snapshot: buildEntitySnapshot(output),
        traceId,
      });

      emitEntityMutation(ctx.tenantId, input.blueprint, 'created', ctx.actor.type);

      return {
        output,
        audit: {
          mutation: 'created',
          resourceKind: 'entity',
          blueprintIdentifier: input.blueprint,
          resourceIdentifier: identifier,
          version: 1,
          changeEventSeq,
        },
      };
    },
  });

  const upsert = defineCatalogOperation<UpsertEntityInput, UpsertEntityOutput>({
    name: 'entity.upsert',
    pool,
    authz,
    authorization: ({ input }) => ({
      kind: RESOURCE_KINDS.catalogEntity,
      action: 'update',
      resourceId: inputString(input, 'identifier'),
      attributes: { blueprintId: inputString(input, 'blueprint') },
    }),
    handler: async ({ ctx, client, input: rawInput }) => {
      const input = parseSafeEntityInput(rawInput, limits) as UpsertEntityInput;
      const tx = drizzle(client);
      trace.getActiveSpan()?.setAttribute(BLUEPRINT_IDENTIFIER_ATTRIBUTE, input.blueprint);
      const identifier = parseEntityIdentifier(input.identifier, '/identifier');
      trace.getActiveSpan()?.setAttribute(ENTITY_IDENTIFIER_ATTRIBUTE, identifier);
      trace.getActiveSpan()?.setAttribute('tayzu.catalog.upsert.mode', input.mode);
      denyIfReserved(ctx, input.blueprint, 'entity_write');

      const blueprintRow = await selectBlueprintRow(tx, ctx.tenantId, input.blueprint, {
        forShare: true,
      });
      if (!blueprintRow) throw new CatalogError('CATALOG_NOT_FOUND', 'Blueprint not found');

      const relationDefs = await loadEntityRelationDefinitions(tx, ctx.tenantId, blueprintRow.id);
      const currentRow = await selectEntityRow(tx, ctx.tenantId, blueprintRow.id, identifier, {
        forUpdate: true,
      });

      if (
        currentRow &&
        input.expectedVersion !== undefined &&
        input.expectedVersion !== currentRow.version
      ) {
        throw new CatalogError('CATALOG_VERSION_CONFLICT', 'Entity was updated by someone else');
      }

      const title = parseEntityTitle(input.title, '/title');
      const icon = parseEntityIcon(input.icon, limits);

      let currentSpecRelations: Record<string, string | string[]> = {};
      let currentStatusRelations: Record<string, string | string[]> = {};
      if (currentRow) {
        const bags = await loadEntityRelationBags(tx, ctx.tenantId, currentRow.id, relationDefs);
        currentSpecRelations = bags.spec;
        currentStatusRelations = bags.status;
      }

      const currentSpec = currentRow
        ? {
            properties: currentRow.spec_properties as Record<string, unknown>,
            relations: currentSpecRelations,
          }
        : undefined;
      const nextSpec = applyWrite(
        currentSpec,
        { properties: input.spec?.properties, relations: input.spec?.relations },
        input.mode,
      );
      assertEntitySpecSize(nextSpec, limits);

      const schema = blueprintRow.schema as ParsedPropertySchema;
      const validatedProperties = runEntityValidation(
        schema,
        nextSpec.properties,
        '/spec/properties',
        limits,
        {
          tenantId: ctx.tenantId,
          blueprintIdentifier: input.blueprint,
          blueprintVersion: blueprintRow.version,
          scope: 'spec',
        },
      );
      const relationValues = validateRelationValues(
        relationDefs.definitions,
        nextSpec.relations,
        'spec',
        { limits },
      );
      const { resolved, totalTargets } = await resolveRelationsIfDeclared(
        tx,
        ctx.tenantId,
        relationDefs,
        relationValues,
        'spec',
      );
      if (totalTargets > 0) {
        trace.getActiveSpan()?.setAttribute('tayzu.catalog.relation.target.count', totalTargets);
      }

      const now = new Date();

      if (currentRow) {
        const propertiesUnchanged = areCanonicallyEqual(
          validatedProperties,
          currentRow.spec_properties,
        );
        const relationsUnchanged = areCanonicallyEqual(relationValues, currentSpecRelations);
        const titleIconUnchanged =
          title === currentRow.title && (icon ?? null) === (currentRow.icon ?? null);

        if (propertiesUnchanged && relationsUnchanged && titleIconUnchanged) {
          const output: UpsertEntityOutput = {
            ...buildEntityOutput(input.blueprint, currentRow, {
              spec: currentSpecRelations,
              status: currentStatusRelations,
            }),
            outcome: 'unchanged',
          };
          // design.md, Spans table: tayzu.catalog.mutation's conditional
          // attribute records 'unchanged' too, exactly like 'created' and
          // 'updated' below -- an idempotent upsert is not a mutation (no
          // counter increment, no change event), but it is still one of the
          // attribute's three enumerated values.
          trace.getActiveSpan()?.setAttribute('tayzu.catalog.mutation', 'unchanged');
          return { output };
        }

        const specUnchanged = propertiesUnchanged && relationsUnchanged;
        const generation = specUnchanged ? currentRow.generation : currentRow.generation + 1;
        const version = currentRow.version + 1;

        await updateEntitySpecRow(tx, {
          tenantId: ctx.tenantId,
          id: currentRow.id,
          title,
          icon,
          specProperties: validatedProperties,
          generation,
          version,
          now,
          actor: ctx.actor,
        });

        if (!relationsUnchanged) {
          await deleteEntityRelationEdgesForSource(tx, ctx.tenantId, currentRow.id, 'spec');
          await writeRelationEdges(tx, ctx.tenantId, currentRow.id, 'spec', relationDefs, resolved);
        }

        const output: UpsertEntityOutput = {
          blueprint: input.blueprint,
          identifier,
          title,
          icon,
          spec: { properties: validatedProperties, relations: relationValues },
          status: buildStatusOutput(currentRow, currentStatusRelations),
          generation,
          version,
          createdAt: new Date(currentRow.created_at).toISOString(),
          createdBy: {
            type: currentRow.created_by_type as ActorType,
            id: currentRow.created_by_id,
          },
          updatedAt: now.toISOString(),
          updatedBy: ctx.actor,
          outcome: 'updated',
        };

        const traceId = trace.getActiveSpan()?.spanContext().traceId;
        const changeEventSeq = await appendChangeEvent(tx, {
          tenantId: ctx.tenantId,
          actor: ctx.actor,
          action: 'updated',
          resourceKind: 'entity',
          blueprintIdentifier: input.blueprint,
          resourceIdentifier: identifier,
          version,
          changedFields: ['title', 'icon', 'spec'],
          snapshot: buildEntitySnapshot(output),
          traceId,
        });

        emitEntityMutation(ctx.tenantId, input.blueprint, 'updated', ctx.actor.type);
        trace.getActiveSpan()?.setAttribute('tayzu.catalog.mutation', 'updated');

        return {
          output,
          audit: {
            mutation: 'updated',
            resourceKind: 'entity',
            blueprintIdentifier: input.blueprint,
            resourceIdentifier: identifier,
            version,
            changeEventSeq,
          },
        };
      }

      // No current row: behaves like `create`.
      const id = uuidv7();
      try {
        await insertEntityRow(tx, {
          id,
          tenantId: ctx.tenantId,
          blueprintId: blueprintRow.id,
          identifier,
          title,
          icon,
          specProperties: validatedProperties,
          generation: 1,
          version: 1,
          now,
          actor: ctx.actor,
        });
      } catch (error) {
        throwMappedEntityWriteError(error);
      }

      await writeRelationEdges(tx, ctx.tenantId, id, 'spec', relationDefs, resolved);

      const output: UpsertEntityOutput = {
        ...buildFreshEntityOutput({
          blueprintIdentifier: input.blueprint,
          identifier,
          title,
          icon,
          specProperties: validatedProperties,
          specRelations: relationValues,
          generation: 1,
          version: 1,
          now,
          actor: ctx.actor,
        }),
        outcome: 'created',
      };

      const traceId = trace.getActiveSpan()?.spanContext().traceId;
      const changeEventSeq = await appendChangeEvent(tx, {
        tenantId: ctx.tenantId,
        actor: ctx.actor,
        action: 'created',
        resourceKind: 'entity',
        blueprintIdentifier: input.blueprint,
        resourceIdentifier: identifier,
        version: 1,
        changedFields: ['title', 'icon', 'spec'],
        snapshot: buildEntitySnapshot(output),
        traceId,
      });

      emitEntityMutation(ctx.tenantId, input.blueprint, 'created', ctx.actor.type);
      trace.getActiveSpan()?.setAttribute('tayzu.catalog.mutation', 'created');

      return {
        output,
        audit: {
          mutation: 'created',
          resourceKind: 'entity',
          blueprintIdentifier: input.blueprint,
          resourceIdentifier: identifier,
          version: 1,
          changeEventSeq,
        },
      };
    },
  });

  const writeStatus = defineCatalogOperation<WriteEntityStatusInput, EntityOutput>({
    name: 'entity.status.write',
    pool,
    authz,
    authorization: ({ input }) => ({
      kind: RESOURCE_KINDS.catalogEntity,
      action: 'update',
      resourceId: inputString(input, 'identifier'),
      attributes: { blueprintId: inputString(input, 'blueprint') },
    }),
    handler: async ({ ctx, client, input: rawInput }) => {
      const input = parseSafeEntityInput(rawInput, limits) as WriteEntityStatusInput;
      const tx = drizzle(client);
      trace.getActiveSpan()?.setAttribute(BLUEPRINT_IDENTIFIER_ATTRIBUTE, input.blueprint);
      const identifier = parseEntityIdentifier(input.identifier, '/identifier');
      trace.getActiveSpan()?.setAttribute(ENTITY_IDENTIFIER_ATTRIBUTE, identifier);
      const source = parseStatusSource(input.source, limits);
      trace.getActiveSpan()?.setAttribute('tayzu.catalog.status.source', source);
      denyIfReserved(ctx, input.blueprint, 'entity_write');

      const blueprintRow = await selectBlueprintRow(tx, ctx.tenantId, input.blueprint, {
        forShare: true,
      });
      if (!blueprintRow) throw new CatalogError('CATALOG_NOT_FOUND', 'Blueprint not found');

      const relationDefs = await loadEntityRelationDefinitions(tx, ctx.tenantId, blueprintRow.id);
      const currentRow = await selectEntityRow(tx, ctx.tenantId, blueprintRow.id, identifier, {
        forUpdate: true,
      });
      if (!currentRow) throw new CatalogError('CATALOG_NOT_FOUND', 'Entity not found');

      if (input.observedGeneration > currentRow.generation) {
        throw new CatalogError(
          'CATALOG_VALIDATION_FAILED',
          'Observed generation is from the future',
          {
            issues: [
              { path: '/observedGeneration', message: 'Observed generation is from the future' },
            ],
          },
        );
      }

      const rawStatusProperties = input.properties ?? {};
      assertEntityStatusSize(
        { properties: rawStatusProperties, relations: input.relations ?? {} },
        limits,
      );

      const statusSchema = blueprintRow.status_schema as ParsedPropertySchema | null;
      if (statusSchema === null && Object.keys(rawStatusProperties).length > 0) {
        throw new CatalogError('CATALOG_VALIDATION_FAILED', 'Blueprint has no statusSchema', {
          issues: [{ path: '/status/properties', message: 'Blueprint has no statusSchema' }],
        });
      }
      const validatedStatusProperties: Record<string, unknown> =
        statusSchema === null
          ? {}
          : runEntityValidation(statusSchema, rawStatusProperties, '/status/properties', limits, {
              tenantId: ctx.tenantId,
              blueprintIdentifier: input.blueprint,
              blueprintVersion: blueprintRow.version,
              scope: 'status',
            });

      const statusRelationValues = validateRelationValues(
        relationDefs.definitions,
        input.relations ?? {},
        'status',
        {
          limits,
        },
      );
      const { resolved, totalTargets } = await resolveRelationsIfDeclared(
        tx,
        ctx.tenantId,
        relationDefs,
        statusRelationValues,
        'status',
      );
      if (totalTargets > 0) {
        trace.getActiveSpan()?.setAttribute('tayzu.catalog.relation.target.count', totalTargets);
      }

      const now = new Date();
      const version = currentRow.version + 1;

      await updateEntityStatusRow(tx, {
        tenantId: ctx.tenantId,
        id: currentRow.id,
        statusProperties: validatedStatusProperties,
        statusObservedGeneration: input.observedGeneration,
        statusObservedAt: now,
        statusSource: source,
        version,
        now,
        actor: ctx.actor,
      });

      await deleteEntityRelationEdgesForSource(tx, ctx.tenantId, currentRow.id, 'status');
      await writeRelationEdges(tx, ctx.tenantId, currentRow.id, 'status', relationDefs, resolved);

      const specBags = await loadEntityRelationBags(tx, ctx.tenantId, currentRow.id, relationDefs);

      const output: EntityOutput = {
        blueprint: input.blueprint,
        identifier,
        title: currentRow.title,
        icon: currentRow.icon ?? undefined,
        spec: {
          properties: currentRow.spec_properties as Record<string, unknown>,
          relations: specBags.spec,
        },
        status: {
          properties: validatedStatusProperties,
          relations: statusRelationValues,
          observedGeneration: input.observedGeneration,
          observedAt: now.toISOString(),
          source,
        },
        generation: currentRow.generation,
        version,
        createdAt: new Date(currentRow.created_at).toISOString(),
        createdBy: { type: currentRow.created_by_type as ActorType, id: currentRow.created_by_id },
        updatedAt: now.toISOString(),
        updatedBy: ctx.actor,
      };

      const traceId = trace.getActiveSpan()?.spanContext().traceId;
      const changeEventSeq = await appendChangeEvent(tx, {
        tenantId: ctx.tenantId,
        actor: ctx.actor,
        action: 'status_updated',
        resourceKind: 'entity',
        blueprintIdentifier: input.blueprint,
        resourceIdentifier: identifier,
        version,
        changedFields: ['status'],
        snapshot: buildEntitySnapshot(output),
        traceId,
      });

      emitEntityMutation(ctx.tenantId, input.blueprint, 'status_updated', ctx.actor.type);

      return {
        output,
        audit: {
          mutation: 'status_updated',
          resourceKind: 'entity',
          blueprintIdentifier: input.blueprint,
          resourceIdentifier: identifier,
          version,
          changeEventSeq,
        },
      };
    },
  });

  const get = defineCatalogOperation<GetEntityInput, EntityOutput>({
    name: 'entity.get',
    pool,
    authz,
    authorization: ({ input }) => ({
      kind: RESOURCE_KINDS.catalogEntity,
      action: 'view',
      resourceId: inputString(input, 'identifier'),
      attributes: { blueprintId: inputString(input, 'blueprint') },
    }),
    handler: async ({ ctx, client, input }) => {
      trace.getActiveSpan()?.setAttribute(BLUEPRINT_IDENTIFIER_ATTRIBUTE, input.blueprint);
      trace.getActiveSpan()?.setAttribute(ENTITY_IDENTIFIER_ATTRIBUTE, input.identifier);
      const tx = drizzle(client);

      const blueprintId = await findBlueprintIdByIdentifier(tx, ctx.tenantId, input.blueprint);
      if (blueprintId === undefined)
        throw new CatalogError('CATALOG_NOT_FOUND', 'Entity not found');

      const row = await selectEntityRow(tx, ctx.tenantId, blueprintId, input.identifier);
      if (!row) throw new CatalogError('CATALOG_NOT_FOUND', 'Entity not found');

      const relationDefs = await loadEntityRelationDefinitions(tx, ctx.tenantId, blueprintId);
      const bags = await loadEntityRelationBags(tx, ctx.tenantId, row.id, relationDefs);

      return { output: buildEntityOutput(input.blueprint, row, bags) };
    },
  });

  const list = defineCatalogOperation<ListEntitiesInput, ListEntitiesOutput>({
    name: 'entity.list',
    pool,
    authz,
    authorization: ({ input }) => ({
      kind: RESOURCE_KINDS.catalogEntity,
      action: 'list',
      resourceId: '_',
      attributes: { blueprintId: inputString(input, 'blueprint') },
    }),
    handler: async ({ ctx, client, input }) => {
      trace.getActiveSpan()?.setAttribute(BLUEPRINT_IDENTIFIER_ATTRIBUTE, input.blueprint);

      const pageSize = input.pageSize ?? limits.pagination.defaultPageSize;
      // design.md, Spans table: tayzu.catalog.page.size is a *required*
      // attribute of catalog.entity.list, not conditional -- set it before
      // the CATALOG_LIMIT_EXCEEDED check below can throw.
      trace.getActiveSpan()?.setAttribute('tayzu.catalog.page.size', pageSize);
      if (pageSize > limits.pagination.maxPageSize) {
        throw new CatalogError('CATALOG_LIMIT_EXCEEDED', 'Page size exceeds the limit', {
          details: { limit: 'pagination.maxPageSize' },
        });
      }
      if (input.cursor !== undefined) assertCursorLength(input.cursor, limits);
      const afterIdentifier = input.cursor !== undefined ? decodeCursor(input.cursor) : undefined;

      const tx = drizzle(client);
      const blueprintId = await findBlueprintIdByIdentifier(tx, ctx.tenantId, input.blueprint);
      if (blueprintId === undefined)
        throw new CatalogError('CATALOG_NOT_FOUND', 'Blueprint not found');

      const relationDefs = await loadEntityRelationDefinitions(tx, ctx.tenantId, blueprintId);
      const rows = await selectEntitiesPage(tx, ctx.tenantId, blueprintId, {
        limit: pageSize,
        afterIdentifier,
      });
      const hasMore = rows.length > pageSize;
      const pageRows = hasMore ? rows.slice(0, pageSize) : rows;

      const items = await Promise.all(
        pageRows.map(async (row) => {
          const bags = await loadEntityRelationBags(tx, ctx.tenantId, row.id, relationDefs);
          return buildEntityOutput(input.blueprint, row, bags);
        }),
      );

      const lastItem = pageRows[pageRows.length - 1];
      const cursor = hasMore && lastItem ? encodeCursor(lastItem.identifier) : undefined;

      trace.getActiveSpan()?.setAttribute('tayzu.catalog.result.count', items.length);

      return { output: { items, cursor } };
    },
  });

  const doDelete = defineCatalogOperation<DeleteEntityInput, undefined>({
    name: 'entity.delete',
    pool,
    authz,
    authorization: ({ input }) => ({
      kind: RESOURCE_KINDS.catalogEntity,
      action: 'delete',
      resourceId: inputString(input, 'identifier'),
      attributes: { blueprintId: inputString(input, 'blueprint') },
    }),
    handler: async ({ ctx, client, input }) => {
      const tx = drizzle(client);
      trace.getActiveSpan()?.setAttribute(BLUEPRINT_IDENTIFIER_ATTRIBUTE, input.blueprint);
      trace.getActiveSpan()?.setAttribute(ENTITY_IDENTIFIER_ATTRIBUTE, input.identifier);
      const detachReferences = input.detachReferences ?? false;
      trace.getActiveSpan()?.setAttribute('tayzu.catalog.detach_references', detachReferences);
      denyIfReserved(ctx, input.blueprint, 'entity_write');

      const blueprintRow = await selectBlueprintRow(tx, ctx.tenantId, input.blueprint, {
        forShare: true,
      });
      if (!blueprintRow) throw new CatalogError('CATALOG_NOT_FOUND', 'Blueprint not found');

      const row = await selectEntityRow(tx, ctx.tenantId, blueprintRow.id, input.identifier, {
        forUpdate: true,
      });
      if (!row) throw new CatalogError('CATALOG_NOT_FOUND', 'Entity not found');

      const relationDefs = await loadEntityRelationDefinitions(tx, ctx.tenantId, blueprintRow.id);
      const ownBags = await loadEntityRelationBags(tx, ctx.tenantId, row.id, relationDefs);
      const snapshot = buildEntitySnapshot(buildEntityOutput(input.blueprint, row, ownBags));

      const cache: ReferrerCache = {
        relationDefsByBlueprintId: new Map([[blueprintRow.id, relationDefs]]),
        identifierByBlueprintId: new Map([[blueprintRow.id, input.blueprint]]),
      };

      const specReferrers = await selectSpecReferrers(tx, ctx.tenantId, row.id);

      if (!detachReferences) {
        if (specReferrers.length > 0) {
          const referrers = [
            ...new Set(specReferrers.map((referrer) => referrer.source_identifier)),
          ].slice(0, 10);
          throw new CatalogError('CATALOG_REFERENCE_VIOLATION', 'Entity is still referenced', {
            details: { referrers },
          });
        }
      } else {
        if (specReferrers.some((referrer) => referrer.required)) {
          throw new CatalogError(
            'CATALOG_REFERENCE_VIOLATION',
            'A required relation blocks detach',
          );
        }

        const distinctReferrerIds = [
          ...new Set(specReferrers.map((referrer) => referrer.source_entity_id)),
        ];
        if (distinctReferrerIds.length > limits.detach.maxReferrers) {
          throw new CatalogError('CATALOG_LIMIT_EXCEEDED', 'Too many referrers to detach', {
            details: { limit: 'detach.maxReferrers' },
          });
        }

        if (distinctReferrerIds.length > 0) {
          await deleteEntityRelationEdgesForTarget(tx, ctx.tenantId, row.id, 'spec');
          for (const referrerId of distinctReferrerIds) {
            await bumpReferrerAndAppendEvent(tx, ctx, referrerId, cache, {
              bumpGeneration: true,
              action: 'updated',
            });
          }
          trace
            .getActiveSpan()
            ?.setAttribute('tayzu.catalog.detached.count', distinctReferrerIds.length);
        }
      }

      // Observed (status) references never block a delete: always removed (spec "Entity read, list and delete").
      const statusReferrerIds = await selectDistinctStatusReferrerIds(tx, ctx.tenantId, row.id);
      if (statusReferrerIds.length > 0) {
        await deleteEntityRelationEdgesForTarget(tx, ctx.tenantId, row.id, 'status');
        for (const referrerId of statusReferrerIds) {
          await bumpReferrerAndAppendEvent(tx, ctx, referrerId, cache, {
            bumpGeneration: false,
            action: 'status_updated',
          });
        }
      }

      try {
        await deleteEntityRow(tx, ctx.tenantId, row.id);
      } catch (error) {
        throwMappedEntityWriteError(error);
      }

      const traceId = trace.getActiveSpan()?.spanContext().traceId;
      const changeEventSeq = await appendChangeEvent(tx, {
        tenantId: ctx.tenantId,
        actor: ctx.actor,
        action: 'deleted',
        resourceKind: 'entity',
        blueprintIdentifier: input.blueprint,
        resourceIdentifier: input.identifier,
        version: row.version,
        changedFields: [],
        snapshot,
        traceId,
      });

      emitEntityMutation(ctx.tenantId, input.blueprint, 'deleted', ctx.actor.type);

      return {
        output: undefined,
        audit: {
          mutation: 'deleted',
          resourceKind: 'entity',
          blueprintIdentifier: input.blueprint,
          resourceIdentifier: input.identifier,
          version: row.version,
          changeEventSeq,
        },
      };
    },
  });

  const listRelated = defineCatalogOperation<ListRelatedInput, ListRelatedOutput>({
    name: 'entity.related.list',
    pool,
    authz,
    authorization: ({ input }) => ({
      kind: RESOURCE_KINDS.catalogEntity,
      action: 'view',
      resourceId: inputString(input, 'identifier'),
      attributes: { blueprintId: inputString(input, 'blueprint') },
    }),
    handler: async ({ ctx, client, input }) => {
      trace.getActiveSpan()?.setAttribute(BLUEPRINT_IDENTIFIER_ATTRIBUTE, input.blueprint);
      trace.getActiveSpan()?.setAttribute(ENTITY_IDENTIFIER_ATTRIBUTE, input.identifier);
      trace.getActiveSpan()?.setAttribute('tayzu.catalog.related.direction', input.direction);
      const scopeFilter = input.scope ?? 'both';
      trace.getActiveSpan()?.setAttribute('tayzu.catalog.related.scope', scopeFilter);

      const pageSize = input.pageSize ?? limits.pagination.defaultPageSize;
      if (pageSize > limits.pagination.maxPageSize) {
        throw new CatalogError('CATALOG_LIMIT_EXCEEDED', 'Page size exceeds the limit', {
          details: { limit: 'pagination.maxPageSize' },
        });
      }
      if (input.cursor !== undefined) assertCursorLength(input.cursor, limits);
      const after = input.cursor !== undefined ? decodeRelatedCursor(input.cursor) : undefined;
      const dbScope = scopeFilter === 'both' ? undefined : scopeFilter;

      const tx = drizzle(client);
      const blueprintId = await findBlueprintIdByIdentifier(tx, ctx.tenantId, input.blueprint);
      if (blueprintId === undefined)
        throw new CatalogError('CATALOG_NOT_FOUND', 'Entity not found');
      const entityRow = await selectEntityRow(tx, ctx.tenantId, blueprintId, input.identifier);
      if (!entityRow) throw new CatalogError('CATALOG_NOT_FOUND', 'Entity not found');

      let items: RelatedEntityItem[];
      let lastKey: RelatedCursorKey | undefined;

      if (input.direction === 'forward') {
        const rows = await selectForwardRelatedPage(tx, ctx.tenantId, entityRow.id, {
          scope: dbScope,
          limit: pageSize,
          after,
        });
        const hasMore = rows.length > pageSize;
        const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
        items = pageRows.map((row) => ({
          relation: row.relation_identifier,
          scope: row.scope as 'spec' | 'status',
          sourceBlueprint: input.blueprint,
          entity: {
            blueprint: row.target_blueprint_identifier,
            identifier: row.target_identifier,
            title: row.target_title,
          },
        }));
        const last = pageRows[pageRows.length - 1];
        lastKey =
          hasMore && last
            ? { relation: last.relation_identifier, identifier: last.target_identifier }
            : undefined;
      } else {
        const rows = await selectBackwardRelatedPage(tx, ctx.tenantId, entityRow.id, {
          scope: dbScope,
          limit: pageSize,
          after,
        });
        const hasMore = rows.length > pageSize;
        const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
        items = pageRows.map((row) => ({
          relation: row.relation_identifier,
          scope: row.scope as 'spec' | 'status',
          sourceBlueprint: row.source_blueprint_identifier,
          entity: {
            blueprint: row.source_blueprint_identifier,
            identifier: row.source_identifier,
            title: row.source_title,
          },
        }));
        const last = pageRows[pageRows.length - 1];
        lastKey =
          hasMore && last
            ? { relation: last.relation_identifier, identifier: last.source_identifier }
            : undefined;
      }

      trace.getActiveSpan()?.setAttribute('tayzu.catalog.result.count', items.length);

      return { output: { items, cursor: lastKey ? encodeRelatedCursor(lastKey) : undefined } };
    },
  });

  return { create, upsert, writeStatus, get, list, delete: doDelete, listRelated };
}
