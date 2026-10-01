/**
 * Blueprint persistence (design D4, D7, D9; tasks 7.1-7.6). Every function
 * takes the drizzle handle wrapping the current tenant transaction's
 * `PoolClient` (`drizzle(client)`, design D5), and every query filters by
 * `tenant_id` explicitly, even though the row's own primary key already
 * pins it to one row. Parameterized SQL only (`sql` tag bind parameters);
 * `sql.raw` is never used.
 */
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { CompatibilityEntitySnapshot } from '../domain/compatibility.js';
import type { Principal } from '../domain/context.js';
import type { LocalizedText } from '../domain/localized-text.js';

/**
 * `drizzle(client)`'s database handle (design D5: the pipeline wraps the
 * current tenant transaction's `PoolClient` this way before calling a
 * handler). `NodePgDatabase` alone (without the `{ $client }` intersection
 * `drizzle()`'s return type also carries) is enough: every query here only
 * ever calls `.execute`, and it is a supertype of `drizzle(client)`'s actual
 * return type regardless of which `TClient` (`Pool` or `PoolClient`) drizzle
 * infers, unlike `ReturnType<typeof drizzle>` itself, which resolves to
 * `TClient`'s *default* (`Pool`) and so rejects a `PoolClient`-backed handle.
 */
export type BlueprintRepositoryTx = NodePgDatabase;

/**
 * One `catalog_blueprint` row, as read back. `jsonb` columns are already
 * parsed by `pg`'s default type parsers; timestamps are not: drizzle-orm's
 * node-postgres driver disables `pg`'s own `timestamptz` parser on every
 * query issued through `db.execute` (so that its typed query builder can
 * apply its own column mapping instead), so a raw `sql`-tag query like every
 * one here gets back the driver's raw text representation instead of a `Date`
 * (for example `"2024-01-15 10:30:00.123456+00"`). Callers must
 * `new Date(row.created_at)` before use.
 */
export type BlueprintRow = {
  readonly id: string;
  readonly identifier: string;
  readonly title: unknown;
  readonly description: unknown;
  readonly icon: string | null;
  readonly schema: unknown;
  readonly status_schema: unknown;
  readonly version: number;
  readonly created_at: string;
  readonly created_by_type: string;
  readonly created_by_id: string;
  readonly updated_at: string;
  readonly updated_by_type: string;
  readonly updated_by_id: string;
};

const BLUEPRINT_COLUMNS = sql`id, identifier, title, description, icon, schema, status_schema, version,
       created_at, created_by_type, created_by_id, updated_at, updated_by_type, updated_by_id`;

/**
 * The `catalog_blueprint` row of `identifier` in `tenantId`, or `undefined`
 * when it does not exist. `forShare` is used by every entity write
 * (design D7: "Entity writes lock their blueprint row FOR SHARE"), so a
 * concurrent `blueprints.update`'s own `FOR UPDATE` can never interleave with
 * it and commit an entity against a stale schema.
 */
export async function selectBlueprintRow(
  tx: BlueprintRepositoryTx,
  tenantId: string,
  identifier: string,
  options: { readonly forUpdate?: boolean; readonly forShare?: boolean } = {},
): Promise<BlueprintRow | undefined> {
  const lockClause =
    options.forUpdate === true
      ? sql` for update`
      : options.forShare === true
        ? sql` for share`
        : sql``;
  const result = await tx.execute<BlueprintRow>(sql`
    select ${BLUEPRINT_COLUMNS}
    from catalog_blueprint
    where tenant_id = ${tenantId} and identifier = ${identifier}${lockClause}
  `);
  return result.rows[0];
}

export interface BlueprintsPageOptions {
  /** Fetches one row beyond `limit`, so the caller can tell whether a next page exists. */
  readonly limit: number;
  readonly afterIdentifier?: string;
}

/** Up to `options.limit + 1` `catalog_blueprint` rows, ordered by `identifier` ascending (design D10). */
export async function selectBlueprintsPage(
  tx: BlueprintRepositoryTx,
  tenantId: string,
  options: BlueprintsPageOptions,
): Promise<BlueprintRow[]> {
  const cursorClause =
    options.afterIdentifier !== undefined
      ? sql`and identifier > ${options.afterIdentifier}`
      : sql``;
  const result = await tx.execute<BlueprintRow>(sql`
    select ${BLUEPRINT_COLUMNS}
    from catalog_blueprint
    where tenant_id = ${tenantId} ${cursorClause}
    order by identifier
    limit ${options.limit + 1}
  `);
  return result.rows;
}

/** The internal `catalog_blueprint.id` of `identifier` in `tenantId`, or `undefined` when it does not exist. */
export async function findBlueprintIdByIdentifier(
  tx: BlueprintRepositoryTx,
  tenantId: string,
  identifier: string,
): Promise<string | undefined> {
  const result = await tx.execute<{ id: string }>(sql`
    select id from catalog_blueprint where tenant_id = ${tenantId} and identifier = ${identifier}
  `);
  return result.rows[0]?.id;
}

export interface InsertBlueprintRowParams {
  readonly id: string;
  readonly tenantId: string;
  readonly identifier: string;
  readonly title: LocalizedText;
  readonly description?: LocalizedText;
  readonly icon?: string;
  readonly schema: unknown;
  readonly statusSchema?: unknown;
  readonly version: number;
  readonly now: Date;
  readonly actor: Principal;
}

/** Inserts one `catalog_blueprint` row. May reject with a unique-violation on `catalog_blueprint_tenant_identifier_uq`. */
export async function insertBlueprintRow(
  tx: BlueprintRepositoryTx,
  row: InsertBlueprintRowParams,
): Promise<void> {
  await tx.execute(sql`
    insert into catalog_blueprint
      (id, tenant_id, identifier, title, description, icon, schema, status_schema, version,
       created_at, created_by_type, created_by_id, updated_at, updated_by_type, updated_by_id)
    values
      (${row.id}, ${row.tenantId}, ${row.identifier}, ${JSON.stringify(row.title)}::jsonb,
       ${row.description === undefined ? null : JSON.stringify(row.description)}::jsonb,
       ${row.icon ?? null}, ${JSON.stringify(row.schema)}::jsonb,
       ${row.statusSchema === undefined ? null : JSON.stringify(row.statusSchema)}::jsonb,
       ${row.version}, ${row.now}, ${row.actor.type}, ${row.actor.id}, ${row.now}, ${row.actor.type}, ${row.actor.id})
  `);
}

export interface UpdateBlueprintRowParams {
  readonly tenantId: string;
  readonly id: string;
  readonly title: LocalizedText;
  readonly description?: LocalizedText;
  readonly icon?: string;
  readonly schema: unknown;
  readonly statusSchema?: unknown;
  readonly version: number;
  readonly now: Date;
  readonly actor: Principal;
}

/** Replaces a blueprint's mutable fields (design D7: "replace its mutable fields ... and increment version"). */
export async function updateBlueprintRow(
  tx: BlueprintRepositoryTx,
  row: UpdateBlueprintRowParams,
): Promise<void> {
  await tx.execute(sql`
    update catalog_blueprint set
      title = ${JSON.stringify(row.title)}::jsonb,
      description = ${row.description === undefined ? null : JSON.stringify(row.description)}::jsonb,
      icon = ${row.icon ?? null},
      schema = ${JSON.stringify(row.schema)}::jsonb,
      status_schema = ${row.statusSchema === undefined ? null : JSON.stringify(row.statusSchema)}::jsonb,
      version = ${row.version},
      updated_at = ${row.now},
      updated_by_type = ${row.actor.type},
      updated_by_id = ${row.actor.id}
    where tenant_id = ${row.tenantId} and id = ${row.id}
  `);
}

/**
 * Deletes the `catalog_blueprint` row. May reject with a foreign-key
 * violation on `catalog_entity_blueprint_fk` (the blueprint still has
 * entities) or `catalog_relation_definition_target_blueprint_fk` (another
 * blueprint's relation still targets it) -- both `RESTRICT` (design D4, D9;
 * spec "Blueprint deletion"). Its own relation definitions (as source) are
 * removed by `catalog_relation_definition_source_blueprint_fk`'s `CASCADE`.
 */
export async function deleteBlueprintRow(
  tx: BlueprintRepositoryTx,
  tenantId: string,
  id: string,
): Promise<void> {
  await tx.execute(sql`delete from catalog_blueprint where tenant_id = ${tenantId} and id = ${id}`);
}

/** Identifiers of the entities of `blueprintId` (ordered, at most `limit`), used to name delete-blocking referrers. */
export async function selectBlueprintEntityIdentifiers(
  tx: BlueprintRepositoryTx,
  tenantId: string,
  blueprintId: string,
  limit: number,
): Promise<string[]> {
  const result = await tx.execute<{ identifier: string }>(sql`
    select identifier from catalog_entity
    where tenant_id = ${tenantId} and blueprint_id = ${blueprintId}
    order by identifier
    limit ${limit}
  `);
  return result.rows.map((row) => row.identifier);
}

/** One `catalog_relation_definition` row, joined with its target blueprint's identifier. */
export type RelationDefinitionRow = {
  readonly id: string;
  readonly identifier: string;
  readonly title: unknown;
  readonly many: boolean;
  readonly required: boolean;
  readonly target_identifier: string;
};

/** Every relation definition whose `source_blueprint_id` is `sourceBlueprintId`, ordered by identifier. */
export async function selectRelationDefinitions(
  tx: BlueprintRepositoryTx,
  tenantId: string,
  sourceBlueprintId: string,
): Promise<RelationDefinitionRow[]> {
  const result = await tx.execute<RelationDefinitionRow>(sql`
    select rd.id, rd.identifier, rd.title, rd.many, rd.required, tb.identifier as target_identifier
    from catalog_relation_definition rd
    join catalog_blueprint tb on tb.tenant_id = rd.tenant_id and tb.id = rd.target_blueprint_id
    where rd.tenant_id = ${tenantId} and rd.source_blueprint_id = ${sourceBlueprintId}
    order by rd.identifier
  `);
  return result.rows;
}

export interface InsertRelationDefinitionRowParams {
  readonly id: string;
  readonly tenantId: string;
  readonly sourceBlueprintId: string;
  readonly identifier: string;
  readonly title: LocalizedText;
  readonly targetBlueprintId: string;
  readonly many: boolean;
  readonly required: boolean;
}

export async function insertRelationDefinitionRow(
  tx: BlueprintRepositoryTx,
  row: InsertRelationDefinitionRowParams,
): Promise<void> {
  await tx.execute(sql`
    insert into catalog_relation_definition
      (id, tenant_id, source_blueprint_id, identifier, title, target_blueprint_id, many, required)
    values
      (${row.id}, ${row.tenantId}, ${row.sourceBlueprintId}, ${row.identifier}, ${JSON.stringify(row.title)}::jsonb,
       ${row.targetBlueprintId}, ${row.many}, ${row.required})
  `);
}

export interface UpdateRelationDefinitionRowParams {
  readonly tenantId: string;
  readonly id: string;
  readonly title: LocalizedText;
  readonly targetBlueprintId: string;
  readonly many: boolean;
  readonly required: boolean;
}

/**
 * Updates `title`, `target_blueprint_id`, `many` and `required` in place,
 * keeping the row's own `id` (design D7, D9's "replace its mutable fields"):
 * `catalog_entity_relation.relation_definition_id` is `ON DELETE RESTRICT`,
 * so a relation an entity still holds an edge for must never be deleted and
 * reinserted with a fresh id on every blueprint update.
 */
export async function updateRelationDefinitionRow(
  tx: BlueprintRepositoryTx,
  row: UpdateRelationDefinitionRowParams,
): Promise<void> {
  await tx.execute(sql`
    update catalog_relation_definition set
      title = ${JSON.stringify(row.title)}::jsonb,
      target_blueprint_id = ${row.targetBlueprintId},
      many = ${row.many},
      required = ${row.required}
    where tenant_id = ${row.tenantId} and id = ${row.id}
  `);
}

/**
 * Deletes exactly the given relation-definition rows by id -- only the ones
 * an update actually removes, and only after the compatibility check
 * (design D7) has already confirmed no entity holds a spec or status value
 * for them, so no `catalog_entity_relation` edge's `RESTRICT` FK blocks the
 * delete.
 */
export async function deleteRelationDefinitionRows(
  tx: BlueprintRepositoryTx,
  tenantId: string,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  const idParams = sql.param([...ids]);
  await tx.execute(sql`
    delete from catalog_relation_definition
    where tenant_id = ${tenantId} and id = any(${idParams}::uuid[])
  `);
}

type RawEntityRow = {
  readonly id: string;
  readonly identifier: string;
  readonly spec_properties: unknown;
  readonly status_properties: unknown;
};

async function selectEntityBatch(
  tx: BlueprintRepositoryTx,
  tenantId: string,
  blueprintId: string,
  afterId: string | undefined,
  batchSize: number,
): Promise<RawEntityRow[]> {
  const cursorClause = afterId !== undefined ? sql`and id > ${afterId}` : sql``;
  const result = await tx.execute<RawEntityRow>(sql`
    select id, identifier, spec_properties, status_properties
    from catalog_entity
    where tenant_id = ${tenantId} and blueprint_id = ${blueprintId} ${cursorClause}
    order by id
    limit ${batchSize}
  `);
  return result.rows;
}

type RawEdgeRow = {
  readonly source_entity_id: string;
  readonly relation_definition_id: string;
  readonly scope: string;
  readonly position: number;
  readonly target_identifier: string;
};

async function selectRelationEdgesForEntities(
  tx: BlueprintRepositoryTx,
  tenantId: string,
  entityIds: readonly string[],
): Promise<RawEdgeRow[]> {
  if (entityIds.length === 0) return [];
  const ids = sql.param([...entityIds]);
  const result = await tx.execute<RawEdgeRow>(sql`
    select cer.source_entity_id, cer.relation_definition_id, cer.scope, cer.position,
           te.identifier as target_identifier
    from catalog_entity_relation cer
    join catalog_entity te on te.tenant_id = cer.tenant_id and te.id = cer.target_entity_id
    where cer.tenant_id = ${tenantId} and cer.source_entity_id = any(${ids}::uuid[])
    order by cer.source_entity_id, cer.relation_definition_id, cer.scope, cer.position
  `);
  return result.rows;
}

/** A relation definition's identifier and cardinality, keyed by its internal `id` (uuid). */
export type RelationDefinitionById = ReadonlyMap<
  string,
  { readonly identifier: string; readonly many: boolean }
>;

function assembleRelationBag(
  edges: readonly RawEdgeRow[],
  scope: 'spec' | 'status',
  relationDefsById: RelationDefinitionById,
): Record<string, unknown> {
  const bag: Record<string, unknown> = {};
  for (const edge of edges) {
    if (edge.scope !== scope) continue;
    const definition = relationDefsById.get(edge.relation_definition_id);
    if (!definition) continue;

    if (definition.many) {
      const existing = bag[definition.identifier];
      const list = Array.isArray(existing) ? (existing as string[]) : [];
      list.push(edge.target_identifier);
      bag[definition.identifier] = list;
    } else {
      bag[definition.identifier] = edge.target_identifier;
    }
  }
  return bag;
}

/**
 * Streams every entity of `blueprintId` in batches of `batchSize` (default
 * 500, design D7), with its spec and status relations assembled from
 * `catalog_entity_relation` edges keyed by `relationDefsById`. Used by
 * `blueprints.update`'s compatibility check (`domain/compatibility.js`).
 */
export async function* streamBlueprintEntities(
  tx: BlueprintRepositoryTx,
  tenantId: string,
  blueprintId: string,
  relationDefsById: RelationDefinitionById,
  batchSize = 500,
): AsyncGenerator<CompatibilityEntitySnapshot> {
  let afterId: string | undefined;

  for (;;) {
    const rows = await selectEntityBatch(tx, tenantId, blueprintId, afterId, batchSize);
    if (rows.length === 0) return;

    const edges = await selectRelationEdgesForEntities(
      tx,
      tenantId,
      rows.map((row) => row.id),
    );
    const edgesByEntity = new Map<string, RawEdgeRow[]>();
    for (const edge of edges) {
      const list = edgesByEntity.get(edge.source_entity_id) ?? [];
      list.push(edge);
      edgesByEntity.set(edge.source_entity_id, list);
    }

    for (const row of rows) {
      const entityEdges = edgesByEntity.get(row.id) ?? [];
      const hasStatus = row.status_properties !== null;
      yield {
        identifier: row.identifier,
        spec: {
          properties: row.spec_properties as Record<string, unknown>,
          relations: assembleRelationBag(entityEdges, 'spec', relationDefsById),
        },
        status: hasStatus
          ? {
              properties: row.status_properties as Record<string, unknown>,
              relations: assembleRelationBag(entityEdges, 'status', relationDefsById),
            }
          : null,
      };
    }

    if (rows.length < batchSize) return;
    const lastRow = rows[rows.length - 1];
    afterId = lastRow?.id;
  }
}
