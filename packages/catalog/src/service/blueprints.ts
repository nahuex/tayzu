/**
 * Blueprint operations (tasks 7.1-7.6; design D3-D5, D7, D9-D11; spec
 * "Blueprint definition", "Reserved system identifiers", "Relation
 * definitions", "Blueprint read and list", "Safe blueprint schema
 * evolution", "Blueprint deletion", "Tenant data isolation", "Actor
 * attribution and change events", "Timestamps are UTC").
 *
 * Every operation is declared through `defineCatalogOperation` (design D3,
 * `./pipeline.js`), so context validation, the tenant transaction, error
 * mapping and telemetry are the same for every operation and every actor
 * type. Relation *target existence* and blueprint *reference* checks need the
 * database and live here, never in `domain/blueprint-definition.js` (its own
 * doc comment: "Relation target existence is never checked here").
 */
import { trace } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { uuidv7 } from 'uuidv7';

import {
  checkCompatibility,
  type CompatibilityCheckResult,
  type CompatibilityEntitySnapshot,
  type CompileValidatorFn,
} from '../domain/compatibility.js';
import {
  parseBlueprintDefinition,
  type ParsedBlueprintDefinition,
  type ParsedPropertySchema,
} from '../domain/blueprint-definition.js';
import type { ActorType, CatalogContext, Principal } from '../domain/context.js';
import { CatalogError, isCatalogError } from '../domain/errors.js';
import { defaultCatalogLimits, type CatalogLimits } from '../domain/limits.js';
import type { LocalizedText } from '../domain/localized-text.js';
import { decodeCursor, encodeCursor } from '../domain/pagination.js';
import { assertReservedAccess, type ReservedOperationKind } from '../domain/reserved.js';
import type { RelationDefinition } from '../domain/relation-definition.js';
import type { ValidatorCacheKey } from '../domain/validator-cache.js';
import { appendChangeEvent } from '../persistence/change-events.js';
import {
  deleteBlueprintRow,
  deleteRelationDefinitionRows,
  findBlueprintIdByIdentifier,
  insertBlueprintRow,
  insertRelationDefinitionRow,
  selectBlueprintRow,
  selectBlueprintsPage,
  selectRelationDefinitions,
  streamBlueprintEntities,
  updateBlueprintRow,
  updateRelationDefinitionRow,
  type BlueprintRepositoryTx,
  type BlueprintRow,
  type RelationDefinitionById,
  type RelationDefinitionRow,
} from '../persistence/blueprints-repository.js';
import { FOREIGN_KEY_VIOLATION_SQLSTATE, UNIQUE_VIOLATION_SQLSTATE, pgErrorInfo } from '../persistence/db-errors.js';
import { blueprintMutationsCounter, logger, tracer } from '../telemetry/instruments.js';
import { defineCatalogOperation } from './pipeline.js';
import { getCachedSpecValidator, getCachedStatusValidator } from './schema-validator-cache.js';

export interface CreateBlueprintInput {
  readonly identifier: string;
  readonly title: Record<string, string>;
  readonly description?: Record<string, string>;
  readonly icon?: string;
  readonly schema: { readonly properties?: Record<string, unknown>; readonly required?: readonly string[] };
  readonly statusSchema?: { readonly properties?: Record<string, unknown>; readonly required?: readonly string[] };
  readonly relations?: Record<
    string,
    {
      readonly title: Record<string, string>;
      readonly target: string;
      readonly many?: boolean;
      readonly required?: boolean;
    }
  >;
}

export type UpdateBlueprintInput = CreateBlueprintInput & { readonly expectedVersion?: number };
export interface GetBlueprintInput {
  readonly identifier: string;
}
export interface DeleteBlueprintInput {
  readonly identifier: string;
}
export interface ListBlueprintsInput {
  readonly pageSize?: number;
  readonly cursor?: string;
}
export interface ListBlueprintsOutput {
  readonly items: readonly BlueprintOutput[];
  readonly cursor?: string;
}

/** `ParsedBlueprintDefinition` (`domain/blueprint-definition.js`) plus the server-managed fields. */
export interface BlueprintOutput {
  readonly identifier: string;
  readonly title: LocalizedText;
  readonly description?: LocalizedText;
  readonly icon?: string;
  readonly schema: ParsedPropertySchema;
  readonly statusSchema?: ParsedPropertySchema;
  readonly relations: Record<string, RelationDefinition>;
  readonly version: number;
  readonly createdAt: string;
  readonly createdBy: CatalogContext['actor'];
  readonly updatedAt: string;
  readonly updatedBy: CatalogContext['actor'];
}

export interface CreateBlueprintServiceOptions {
  readonly pool: Pool;
  readonly limits?: CatalogLimits;
}

export interface BlueprintService {
  readonly create: (rawContext: unknown, input: CreateBlueprintInput) => Promise<BlueprintOutput>;
  readonly get: (rawContext: unknown, input: GetBlueprintInput) => Promise<BlueprintOutput>;
  readonly list: (rawContext: unknown, input: ListBlueprintsInput) => Promise<ListBlueprintsOutput>;
  readonly update: (rawContext: unknown, input: UpdateBlueprintInput) => Promise<BlueprintOutput>;
  readonly delete: (rawContext: unknown, input: DeleteBlueprintInput) => Promise<void>;
}

/** Design Risks: "`statement_timeout` raised only for this operation (30 s)" (blueprint update's compatibility check). */
const COMPATIBILITY_CHECK_STATEMENT_TIMEOUT_MS = 30_000;

const BLUEPRINT_IDENTIFIER_ATTRIBUTE = 'tayzu.catalog.blueprint.identifier';

/** design.md, "Log events" table: the reserved-identifier WARN, emitted before `assertReservedAccess` throws. */
function denyIfReserved(ctx: CatalogContext, identifier: string, operation: ReservedOperationKind): void {
  try {
    assertReservedAccess(identifier, operation, ctx.actor);
  } catch (error) {
    if (isCatalogError(error) && error.code === 'CATALOG_RESERVED_IDENTIFIER') {
      logger.emit({
        eventName: 'catalog.security.reserved_identifier_denied',
        severityNumber: SeverityNumber.WARN,
        attributes: {
          'tayzu.tenant.id': ctx.tenantId,
          'tayzu.actor.type': ctx.actor.type,
          'tayzu.actor.id': ctx.actor.id,
          [BLUEPRINT_IDENTIFIER_ATTRIBUTE]: identifier,
        },
      });
    }
    throw error;
  }
}

/** design D9: `23505` on `catalog_blueprint_tenant_identifier_uq` -> `CATALOG_ALREADY_EXISTS`; anything else propagates unchanged. */
function throwMappedCreateError(error: unknown): never {
  const info = pgErrorInfo(error);
  if (info.code === UNIQUE_VIOLATION_SQLSTATE && info.constraint === 'catalog_blueprint_tenant_identifier_uq') {
    throw new CatalogError('CATALOG_ALREADY_EXISTS', 'Blueprint identifier already exists');
  }
  throw error;
}

/** design D9: `23503` on a known `RESTRICT` FK targeting this blueprint -> `CATALOG_REFERENCE_VIOLATION`; else unchanged. */
const DELETE_REFERENCE_VIOLATION_CONSTRAINTS: ReadonlySet<string> = new Set([
  'catalog_entity_blueprint_fk',
  'catalog_relation_definition_target_blueprint_fk',
]);

function throwMappedDeleteError(error: unknown): never {
  const info = pgErrorInfo(error);
  if (
    info.code === FOREIGN_KEY_VIOLATION_SQLSTATE &&
    info.constraint !== undefined &&
    DELETE_REFERENCE_VIOLATION_CONSTRAINTS.has(info.constraint)
  ) {
    throw new CatalogError('CATALOG_REFERENCE_VIOLATION', 'Blueprint is still referenced');
  }
  throw error;
}

/** Resolves every relation's `target` to its blueprint id in this tenant, or fails with `CATALOG_REFERENCE_VIOLATION`. */
async function resolveRelationTargets(
  tx: BlueprintRepositoryTx,
  tenantId: string,
  relations: Record<string, RelationDefinition>,
): Promise<Map<string, string>> {
  const targetIds = new Map<string, string>();
  for (const [name, relation] of Object.entries(relations)) {
    const targetId = await findBlueprintIdByIdentifier(tx, tenantId, relation.target);
    if (targetId === undefined) {
      throw new CatalogError('CATALOG_REFERENCE_VIOLATION', 'Relation target blueprint does not exist', {
        issues: [{ path: `/relations/${name}/target`, message: 'Relation target blueprint does not exist' }],
      });
    }
    targetIds.set(name, targetId);
  }
  return targetIds;
}

async function writeRelationDefinitions(
  tx: BlueprintRepositoryTx,
  tenantId: string,
  sourceBlueprintId: string,
  relations: Record<string, RelationDefinition>,
  targetIds: ReadonlyMap<string, string>,
): Promise<void> {
  for (const [name, relation] of Object.entries(relations)) {
    const targetBlueprintId = targetIds.get(name);
    if (targetBlueprintId === undefined) {
      throw new Error(`unreachable: relation target id for "${name}" was resolved earlier`);
    }
    await insertRelationDefinitionRow(tx, {
      id: uuidv7(),
      tenantId,
      sourceBlueprintId,
      identifier: name,
      title: relation.title,
      targetBlueprintId,
      many: relation.many,
      required: relation.required,
    });
  }
}

interface LoadedRelations {
  readonly relations: Record<string, RelationDefinition>;
  readonly byId: RelationDefinitionById;
}

/** `rows`, both as `RelationDefinition`s keyed by identifier and keyed by internal id (for edge assembly). */
function relationsFromRows(rows: readonly RelationDefinitionRow[]): LoadedRelations {
  const relations: Record<string, RelationDefinition> = {};
  const byId = new Map<string, { identifier: string; many: boolean }>();
  for (const row of rows) {
    relations[row.identifier] = {
      title: row.title as LocalizedText,
      target: row.target_identifier,
      many: row.many,
      required: row.required,
    };
    byId.set(row.id, { identifier: row.identifier, many: row.many });
  }
  return { relations, byId };
}

/** The relation rows of `blueprintId`, both as `RelationDefinition`s and keyed by internal id (for edge assembly). */
async function loadRelations(tx: BlueprintRepositoryTx, tenantId: string, blueprintId: string): Promise<LoadedRelations> {
  const rows = await selectRelationDefinitions(tx, tenantId, blueprintId);
  return relationsFromRows(rows);
}

/**
 * design D7, D9 ("replace its mutable fields"), and the regression this
 * fixes (`blueprints-update-edges.int.test.ts`'s module doc comment):
 * `catalog_entity_relation.relation_definition_id` is `ON DELETE RESTRICT`,
 * so a relation definition an entity still holds an edge for can never be
 * deleted-and-reinserted on every update. Instead, every relation the new
 * definition still names keeps its row (and therefore every edge's FK): its
 * `title`, `target_blueprint_id`, `many` and `required` are updated in
 * place. Only a relation the new definition no longer names is deleted --
 * which the compatibility check (`domain/compatibility.js`, run before this
 * is ever called) has already guaranteed is safe, because it rejects the
 * update while any entity still holds a value for a relation that would
 * become undeclared.
 */
async function persistRelationDefinitions(
  tx: BlueprintRepositoryTx,
  tenantId: string,
  sourceBlueprintId: string,
  relations: Record<string, RelationDefinition>,
  targetIds: ReadonlyMap<string, string>,
  previousRows: readonly RelationDefinitionRow[],
): Promise<void> {
  const previousByIdentifier = new Map(previousRows.map((row) => [row.identifier, row]));

  for (const [name, relation] of Object.entries(relations)) {
    const targetBlueprintId = targetIds.get(name);
    if (targetBlueprintId === undefined) {
      throw new Error(`unreachable: relation target id for "${name}" was resolved earlier`);
    }
    const previous = previousByIdentifier.get(name);
    if (previous) {
      await updateRelationDefinitionRow(tx, {
        tenantId,
        id: previous.id,
        title: relation.title,
        targetBlueprintId,
        many: relation.many,
        required: relation.required,
      });
    } else {
      await insertRelationDefinitionRow(tx, {
        id: uuidv7(),
        tenantId,
        sourceBlueprintId,
        identifier: name,
        title: relation.title,
        targetBlueprintId,
        many: relation.many,
        required: relation.required,
      });
    }
  }

  const removedIds = previousRows.filter((row) => !(row.identifier in relations)).map((row) => row.id);
  await deleteRelationDefinitionRows(tx, tenantId, removedIds);
}

function toParsedDefinition(row: BlueprintRow, relations: Record<string, RelationDefinition>): ParsedBlueprintDefinition {
  return {
    identifier: row.identifier,
    title: row.title as LocalizedText,
    description: (row.description as LocalizedText | null) ?? undefined,
    icon: row.icon ?? undefined,
    schema: row.schema as ParsedPropertySchema,
    statusSchema: (row.status_schema as ParsedPropertySchema | null) ?? undefined,
    relations,
  };
}

async function mapBlueprintRowToOutput(
  tx: BlueprintRepositoryTx,
  tenantId: string,
  row: BlueprintRow,
): Promise<BlueprintOutput> {
  const { relations } = await loadRelations(tx, tenantId, row.id);
  return buildBlueprintOutput(
    toParsedDefinition(row, relations),
    row.version,
    new Date(row.created_at),
    { type: row.created_by_type as ActorType, id: row.created_by_id },
    new Date(row.updated_at),
    { type: row.updated_by_type as ActorType, id: row.updated_by_id },
  );
}

function buildBlueprintOutput(
  definition: ParsedBlueprintDefinition,
  version: number,
  createdAt: Date,
  createdBy: Principal,
  updatedAt: Date,
  updatedBy: Principal,
): BlueprintOutput {
  return {
    identifier: definition.identifier,
    title: definition.title,
    description: definition.description,
    icon: definition.icon,
    schema: definition.schema,
    statusSchema: definition.statusSchema,
    relations: definition.relations,
    version,
    createdAt: createdAt.toISOString(),
    createdBy,
    updatedAt: updatedAt.toISOString(),
    updatedBy,
  };
}

function buildSnapshot(definition: ParsedBlueprintDefinition, version: number): Record<string, unknown> {
  return {
    identifier: definition.identifier,
    title: definition.title,
    description: definition.description,
    icon: definition.icon,
    schema: definition.schema,
    statusSchema: definition.statusSchema,
    relations: definition.relations,
    version,
  };
}

/**
 * Design D7's compatibility check, wrapped in the child span
 * `catalog.blueprint.compatibility_check` (design.md, Spans table):
 * `tayzu.catalog.blueprint.identifier` and
 * `tayzu.catalog.compatibility.entities_checked` (the number of entities
 * actually pulled from `entities`, whether the check exhausted them or
 * stopped early after 10 violations) always; `tayzu.catalog.compatibility.
 * violation.count` only when at least one violation was found.
 *
 * Compilation of the *proposed* definition's validators is routed through
 * `./schema-validator-cache.js` (task 4.8, design D6), keyed by
 * `(tenantId, blueprintId, newVersion)`: the exact key every entity write
 * against the blueprint will use once this update commits, so a compatible
 * update pre-warms the cache entry instead of compiling twice.
 */
async function runCompatibilityCheck(
  tenantId: string,
  newDefinition: ParsedBlueprintDefinition,
  newVersion: number,
  previousDefinition: ParsedBlueprintDefinition,
  entities: AsyncIterable<CompatibilityEntitySnapshot>,
  limits: CatalogLimits,
): Promise<CompatibilityCheckResult> {
  return tracer.startActiveSpan('catalog.blueprint.compatibility_check', async (span) => {
    try {
      let checked = 0;
      async function* counting(): AsyncGenerator<CompatibilityEntitySnapshot> {
        for await (const entity of entities) {
          checked += 1;
          yield entity;
        }
      }

      const key: ValidatorCacheKey = { tenantId, blueprintId: newDefinition.identifier, version: newVersion };
      const compileValidator: CompileValidatorFn = (schema, kind) =>
        kind === 'spec' ? getCachedSpecValidator(key, schema, limits) : getCachedStatusValidator(key, schema, limits);

      const result = await checkCompatibility(newDefinition, counting(), { previousDefinition, compileValidator });

      span.setAttribute(BLUEPRINT_IDENTIFIER_ATTRIBUTE, newDefinition.identifier);
      span.setAttribute('tayzu.catalog.compatibility.entities_checked', checked);
      if (result.violations.length > 0) {
        span.setAttribute('tayzu.catalog.compatibility.violation.count', result.violations.length);
      }

      return result;
    } finally {
      span.end();
    }
  });
}

export function createBlueprintService(options: CreateBlueprintServiceOptions): BlueprintService {
  const { pool } = options;
  const limits = options.limits ?? defaultCatalogLimits;

  const create = defineCatalogOperation<CreateBlueprintInput, BlueprintOutput>({
    name: 'blueprint.create',
    pool,
    handler: async ({ ctx, client, input }) => {
      const definition = parseBlueprintDefinition(input, limits);
      trace.getActiveSpan()?.setAttribute(BLUEPRINT_IDENTIFIER_ATTRIBUTE, definition.identifier);
      denyIfReserved(ctx, definition.identifier, 'blueprint_write');

      const tx = drizzle(client);
      const id = uuidv7();
      const now = new Date();
      // The blueprint row is inserted *before* relation targets are
      // resolved, so a self relation (spec "Self relation": `target` equal
      // to the blueprint's own identifier) finds its own just-inserted row
      // within this same transaction. A missing target still rolls the
      // whole transaction back (the pipeline's withTenantTransaction), so no
      // row survives when `resolveRelationTargets` rejects below.
      try {
        await insertBlueprintRow(tx, {
          id,
          tenantId: ctx.tenantId,
          identifier: definition.identifier,
          title: definition.title,
          description: definition.description,
          icon: definition.icon,
          schema: definition.schema,
          statusSchema: definition.statusSchema,
          version: 1,
          now,
          actor: ctx.actor,
        });
      } catch (error) {
        throwMappedCreateError(error);
      }

      const targetIds = await resolveRelationTargets(tx, ctx.tenantId, definition.relations);
      await writeRelationDefinitions(tx, ctx.tenantId, id, definition.relations, targetIds);

      const traceId = trace.getActiveSpan()?.spanContext().traceId;
      const changeEventSeq = await appendChangeEvent(tx, {
        tenantId: ctx.tenantId,
        actor: ctx.actor,
        action: 'created',
        resourceKind: 'blueprint',
        blueprintIdentifier: definition.identifier,
        resourceIdentifier: definition.identifier,
        version: 1,
        changedFields: ['identifier', 'title', 'description', 'icon', 'schema', 'statusSchema', 'relations'],
        snapshot: buildSnapshot(definition, 1),
        traceId,
      });

      blueprintMutationsCounter.add(1, {
        'tayzu.tenant.id': ctx.tenantId,
        'tayzu.catalog.mutation': 'created',
        'tayzu.actor.type': ctx.actor.type,
      });

      const output = buildBlueprintOutput(definition, 1, now, ctx.actor, now, ctx.actor);

      return {
        output,
        audit: {
          mutation: 'created',
          resourceKind: 'blueprint',
          blueprintIdentifier: definition.identifier,
          resourceIdentifier: definition.identifier,
          version: 1,
          changeEventSeq,
        },
      };
    },
  });

  const get = defineCatalogOperation<GetBlueprintInput, BlueprintOutput>({
    name: 'blueprint.get',
    pool,
    handler: async ({ ctx, client, input }) => {
      trace.getActiveSpan()?.setAttribute(BLUEPRINT_IDENTIFIER_ATTRIBUTE, input.identifier);
      const tx = drizzle(client);
      const row = await selectBlueprintRow(tx, ctx.tenantId, input.identifier);
      if (!row) throw new CatalogError('CATALOG_NOT_FOUND', 'Blueprint not found');

      const output = await mapBlueprintRowToOutput(tx, ctx.tenantId, row);
      return { output };
    },
  });

  const list = defineCatalogOperation<ListBlueprintsInput, ListBlueprintsOutput>({
    name: 'blueprint.list',
    pool,
    handler: async ({ ctx, client, input }) => {
      const pageSize = input.pageSize ?? limits.pagination.defaultPageSize;
      // design.md, Spans table: tayzu.catalog.page.size is a *required*
      // attribute of catalog.blueprint.list, not conditional -- it must be
      // set even when the requested page size itself is what triggers
      // CATALOG_LIMIT_EXCEEDED below.
      trace.getActiveSpan()?.setAttribute('tayzu.catalog.page.size', pageSize);
      if (pageSize > limits.pagination.maxPageSize) {
        throw new CatalogError('CATALOG_LIMIT_EXCEEDED', 'Page size exceeds the limit', {
          details: { limit: 'pagination.maxPageSize' },
        });
      }
      const afterIdentifier = input.cursor !== undefined ? decodeCursor(input.cursor) : undefined;

      const tx = drizzle(client);
      const rows = await selectBlueprintsPage(tx, ctx.tenantId, { limit: pageSize, afterIdentifier });
      const hasMore = rows.length > pageSize;
      const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
      const items = await Promise.all(pageRows.map((row) => mapBlueprintRowToOutput(tx, ctx.tenantId, row)));

      const lastItem = pageRows[pageRows.length - 1];
      const cursor = hasMore && lastItem ? encodeCursor(lastItem.identifier) : undefined;

      trace.getActiveSpan()?.setAttribute('tayzu.catalog.result.count', items.length);

      return { output: { items, cursor } };
    },
  });

  const update = defineCatalogOperation<UpdateBlueprintInput, BlueprintOutput>({
    name: 'blueprint.update',
    pool,
    statementTimeoutMs: COMPATIBILITY_CHECK_STATEMENT_TIMEOUT_MS,
    handler: async ({ ctx, client, input }) => {
      const definition = parseBlueprintDefinition(input, limits);
      trace.getActiveSpan()?.setAttribute(BLUEPRINT_IDENTIFIER_ATTRIBUTE, definition.identifier);
      denyIfReserved(ctx, definition.identifier, 'blueprint_write');

      const tx = drizzle(client);
      const row = await selectBlueprintRow(tx, ctx.tenantId, definition.identifier, { forUpdate: true });
      if (!row) throw new CatalogError('CATALOG_NOT_FOUND', 'Blueprint not found');

      if (input.expectedVersion !== undefined && input.expectedVersion !== row.version) {
        throw new CatalogError('CATALOG_VERSION_CONFLICT', 'Blueprint was updated by someone else');
      }

      const targetIds = await resolveRelationTargets(tx, ctx.tenantId, definition.relations);
      const previousRelationRows = await selectRelationDefinitions(tx, ctx.tenantId, row.id);
      const { relations: previousRelations, byId: previousRelationsById } = relationsFromRows(previousRelationRows);
      const previousDefinition = toParsedDefinition(row, previousRelations);

      const newVersion = row.version + 1;
      const entities = streamBlueprintEntities(tx, ctx.tenantId, row.id, previousRelationsById);
      const compatibility = await runCompatibilityCheck(
        ctx.tenantId,
        definition,
        newVersion,
        previousDefinition,
        entities,
        limits,
      );

      if (compatibility.violations.length > 0) {
        trace
          .getActiveSpan()
          ?.setAttribute('tayzu.catalog.compatibility.violation.count', compatibility.violations.length);
        throw new CatalogError(
          'CATALOG_SCHEMA_INCOMPATIBLE',
          'Blueprint update is incompatible with existing entities',
          { details: { violations: compatibility.violations } },
        );
      }

      const now = new Date();

      await updateBlueprintRow(tx, {
        tenantId: ctx.tenantId,
        id: row.id,
        title: definition.title,
        description: definition.description,
        icon: definition.icon,
        schema: definition.schema,
        statusSchema: definition.statusSchema,
        version: newVersion,
        now,
        actor: ctx.actor,
      });
      await persistRelationDefinitions(
        tx,
        ctx.tenantId,
        row.id,
        definition.relations,
        targetIds,
        previousRelationRows,
      );

      const traceId = trace.getActiveSpan()?.spanContext().traceId;
      const changeEventSeq = await appendChangeEvent(tx, {
        tenantId: ctx.tenantId,
        actor: ctx.actor,
        action: 'updated',
        resourceKind: 'blueprint',
        blueprintIdentifier: definition.identifier,
        resourceIdentifier: definition.identifier,
        version: newVersion,
        changedFields: ['title', 'description', 'icon', 'schema', 'statusSchema', 'relations'],
        snapshot: buildSnapshot(definition, newVersion),
        traceId,
      });

      blueprintMutationsCounter.add(1, {
        'tayzu.tenant.id': ctx.tenantId,
        'tayzu.catalog.mutation': 'updated',
        'tayzu.actor.type': ctx.actor.type,
      });

      const output = buildBlueprintOutput(
        definition,
        newVersion,
        new Date(row.created_at),
        { type: row.created_by_type as ActorType, id: row.created_by_id },
        now,
        ctx.actor,
      );

      return {
        output,
        audit: {
          mutation: 'updated',
          resourceKind: 'blueprint',
          blueprintIdentifier: definition.identifier,
          resourceIdentifier: definition.identifier,
          version: newVersion,
          changeEventSeq,
        },
      };
    },
  });

  const doDelete = defineCatalogOperation<DeleteBlueprintInput, undefined>({
    name: 'blueprint.delete',
    pool,
    handler: async ({ ctx, client, input }) => {
      trace.getActiveSpan()?.setAttribute(BLUEPRINT_IDENTIFIER_ATTRIBUTE, input.identifier);
      denyIfReserved(ctx, input.identifier, 'blueprint_write');

      const tx = drizzle(client);
      const row = await selectBlueprintRow(tx, ctx.tenantId, input.identifier);
      if (!row) throw new CatalogError('CATALOG_NOT_FOUND', 'Blueprint not found');

      const { relations } = await loadRelations(tx, ctx.tenantId, row.id);
      const snapshot = buildSnapshot(toParsedDefinition(row, relations), row.version);

      try {
        await deleteBlueprintRow(tx, ctx.tenantId, row.id);
      } catch (error) {
        throwMappedDeleteError(error);
      }

      const traceId = trace.getActiveSpan()?.spanContext().traceId;
      const changeEventSeq = await appendChangeEvent(tx, {
        tenantId: ctx.tenantId,
        actor: ctx.actor,
        action: 'deleted',
        resourceKind: 'blueprint',
        blueprintIdentifier: input.identifier,
        resourceIdentifier: input.identifier,
        version: row.version,
        changedFields: [],
        snapshot,
        traceId,
      });

      blueprintMutationsCounter.add(1, {
        'tayzu.tenant.id': ctx.tenantId,
        'tayzu.catalog.mutation': 'deleted',
        'tayzu.actor.type': ctx.actor.type,
      });

      return {
        output: undefined,
        audit: {
          mutation: 'deleted',
          resourceKind: 'blueprint',
          blueprintIdentifier: input.identifier,
          resourceIdentifier: input.identifier,
          version: row.version,
          changeEventSeq,
        },
      };
    },
  });

  return { create, get, list, update, delete: doDelete };
}
