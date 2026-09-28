/**
 * Entity persistence (design D4, D7, D9; tasks 8.1-8.10). Every function
 * takes the drizzle handle wrapping the current tenant transaction's
 * `PoolClient` (`drizzle(client)`, design D5), and every query filters by
 * `tenant_id` explicitly. Parameterized SQL only (`sql` tag bind parameters);
 * `sql.raw` is never used. Mirrors `blueprints-repository.ts`'s own
 * conventions and naming.
 */
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { Principal } from '../domain/context.js';

/** Same rationale as `BlueprintRepositoryTx` (`blueprints-repository.ts`). */
export type EntityRepositoryTx = NodePgDatabase;

/**
 * One `catalog_entity` row, as read back. Timestamps are the driver's raw
 * text representation (see `blueprints-repository.ts`'s `BlueprintRow` doc
 * comment for why); callers must `new Date(row.created_at)` before use.
 */
export type EntityRow = {
  readonly id: string;
  readonly blueprint_id: string;
  readonly identifier: string;
  readonly title: string;
  readonly icon: string | null;
  readonly spec_properties: unknown;
  readonly status_properties: unknown;
  readonly status_observed_generation: number | null;
  readonly status_observed_at: string | null;
  readonly status_source: string | null;
  readonly generation: number;
  readonly version: number;
  readonly created_at: string;
  readonly created_by_type: string;
  readonly created_by_id: string;
  readonly updated_at: string;
  readonly updated_by_type: string;
  readonly updated_by_id: string;
};

const ENTITY_COLUMNS = sql`id, blueprint_id, identifier, title, icon, spec_properties, status_properties,
       status_observed_generation, status_observed_at, status_source, generation, version,
       created_at, created_by_type, created_by_id, updated_at, updated_by_type, updated_by_id`;

/** The `catalog_entity` row of `identifier` within `blueprintId`, or `undefined` when it does not exist. */
export async function selectEntityRow(
  tx: EntityRepositoryTx,
  tenantId: string,
  blueprintId: string,
  identifier: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<EntityRow | undefined> {
  const lockClause = options.forUpdate === true ? sql` for update` : sql``;
  const result = await tx.execute<EntityRow>(sql`
    select ${ENTITY_COLUMNS}
    from catalog_entity
    where tenant_id = ${tenantId} and blueprint_id = ${blueprintId} and identifier = ${identifier}${lockClause}
  `);
  return result.rows[0];
}

/** The `catalog_entity` row of internal `id`, or `undefined` when it does not exist. Used to rebuild a referrer after a detach. */
export async function selectEntityRowById(
  tx: EntityRepositoryTx,
  tenantId: string,
  id: string,
): Promise<EntityRow | undefined> {
  const result = await tx.execute<EntityRow>(sql`
    select ${ENTITY_COLUMNS} from catalog_entity where tenant_id = ${tenantId} and id = ${id}
  `);
  return result.rows[0];
}

export interface EntitiesPageOptions {
  /** Fetches one row beyond `limit`, so the caller can tell whether a next page exists. */
  readonly limit: number;
  readonly afterIdentifier?: string;
}

/** Up to `options.limit + 1` `catalog_entity` rows of `blueprintId`, ordered by `identifier` ascending (design D10). */
export async function selectEntitiesPage(
  tx: EntityRepositoryTx,
  tenantId: string,
  blueprintId: string,
  options: EntitiesPageOptions,
): Promise<EntityRow[]> {
  const cursorClause =
    options.afterIdentifier !== undefined
      ? sql`and identifier > ${options.afterIdentifier}`
      : sql``;
  const result = await tx.execute<EntityRow>(sql`
    select ${ENTITY_COLUMNS}
    from catalog_entity
    where tenant_id = ${tenantId} and blueprint_id = ${blueprintId} ${cursorClause}
    order by identifier
    limit ${options.limit + 1}
  `);
  return result.rows;
}

/** A batched lookup of `catalog_entity.id` by `identifier`, scoped to one blueprint and tenant (relation-target resolution). */
export async function findEntityIdsByIdentifiers(
  tx: EntityRepositoryTx,
  tenantId: string,
  blueprintId: string,
  identifiers: readonly string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (identifiers.length === 0) return map;

  const ids = sql.param([...identifiers]);
  const result = await tx.execute<{ identifier: string; id: string }>(sql`
    select identifier, id from catalog_entity
    where tenant_id = ${tenantId} and blueprint_id = ${blueprintId} and identifier = any(${ids}::text[])
  `);
  for (const row of result.rows) map.set(row.identifier, row.id);
  return map;
}

export interface InsertEntityRowParams {
  readonly id: string;
  readonly tenantId: string;
  readonly blueprintId: string;
  readonly identifier: string;
  readonly title: string;
  readonly icon?: string;
  readonly specProperties: unknown;
  readonly generation: number;
  readonly version: number;
  readonly now: Date;
  readonly actor: Principal;
}

/** Inserts one `catalog_entity` row. May reject with a unique violation on `catalog_entity_tenant_blueprint_identifier_uq`. */
export async function insertEntityRow(
  tx: EntityRepositoryTx,
  row: InsertEntityRowParams,
): Promise<void> {
  await tx.execute(sql`
    insert into catalog_entity
      (id, tenant_id, blueprint_id, identifier, title, icon, spec_properties, generation, version,
       created_at, created_by_type, created_by_id, updated_at, updated_by_type, updated_by_id)
    values
      (${row.id}, ${row.tenantId}, ${row.blueprintId}, ${row.identifier}, ${row.title}, ${row.icon ?? null},
       ${JSON.stringify(row.specProperties)}::jsonb, ${row.generation}, ${row.version},
       ${row.now}, ${row.actor.type}, ${row.actor.id}, ${row.now}, ${row.actor.type}, ${row.actor.id})
  `);
}

export interface UpdateEntitySpecRowParams {
  readonly tenantId: string;
  readonly id: string;
  readonly title: string;
  readonly icon?: string;
  readonly specProperties: unknown;
  readonly generation: number;
  readonly version: number;
  readonly now: Date;
  readonly actor: Principal;
}

/** Replaces an entity's `spec`-side mutable fields. `status_*` columns are never touched (design D9). */
export async function updateEntitySpecRow(
  tx: EntityRepositoryTx,
  row: UpdateEntitySpecRowParams,
): Promise<void> {
  await tx.execute(sql`
    update catalog_entity set
      title = ${row.title},
      icon = ${row.icon ?? null},
      spec_properties = ${JSON.stringify(row.specProperties)}::jsonb,
      generation = ${row.generation},
      version = ${row.version},
      updated_at = ${row.now},
      updated_by_type = ${row.actor.type},
      updated_by_id = ${row.actor.id}
    where tenant_id = ${row.tenantId} and id = ${row.id}
  `);
}

export interface UpdateEntityStatusRowParams {
  readonly tenantId: string;
  readonly id: string;
  readonly statusProperties: unknown;
  readonly statusObservedGeneration: number;
  readonly statusObservedAt: Date;
  readonly statusSource: string;
  readonly version: number;
  readonly now: Date;
  readonly actor: Principal;
}

/** Replaces the observed snapshot. `spec_properties` and `generation` are never touched (design D9). */
export async function updateEntityStatusRow(
  tx: EntityRepositoryTx,
  row: UpdateEntityStatusRowParams,
): Promise<void> {
  await tx.execute(sql`
    update catalog_entity set
      status_properties = ${JSON.stringify(row.statusProperties)}::jsonb,
      status_observed_generation = ${row.statusObservedGeneration},
      status_observed_at = ${row.statusObservedAt},
      status_source = ${row.statusSource},
      version = ${row.version},
      updated_at = ${row.now},
      updated_by_type = ${row.actor.type},
      updated_by_id = ${row.actor.id}
    where tenant_id = ${row.tenantId} and id = ${row.id}
  `);
}

export interface BumpEntityVersionRowParams {
  readonly tenantId: string;
  readonly id: string;
  readonly version: number;
  /** Present only when `generation` also changes (a spec-relation detach; never a status-only bump). */
  readonly generation?: number;
  readonly now: Date;
  readonly actor: Principal;
}

/** Bumps `version` (and, optionally, `generation`) of a referrer affected by another entity's delete. */
export async function bumpEntityVersionRow(
  tx: EntityRepositoryTx,
  row: BumpEntityVersionRowParams,
): Promise<void> {
  const generationClause =
    row.generation !== undefined ? sql`generation = ${row.generation},` : sql``;
  await tx.execute(sql`
    update catalog_entity set
      ${generationClause}
      version = ${row.version},
      updated_at = ${row.now},
      updated_by_type = ${row.actor.type},
      updated_by_id = ${row.actor.id}
    where tenant_id = ${row.tenantId} and id = ${row.id}
  `);
}

/** Deletes the `catalog_entity` row. Callers must have already removed every edge that still targets it. */
export async function deleteEntityRow(
  tx: EntityRepositoryTx,
  tenantId: string,
  id: string,
): Promise<void> {
  await tx.execute(sql`delete from catalog_entity where tenant_id = ${tenantId} and id = ${id}`);
}

/** A blueprint's own `identifier`, given its internal `id` (the reverse of `findBlueprintIdByIdentifier`). Used to attribute a referrer's change event to its own blueprint during a detach. */
export async function selectBlueprintIdentifierById(
  tx: EntityRepositoryTx,
  tenantId: string,
  blueprintId: string,
): Promise<string | undefined> {
  const result = await tx.execute<{ identifier: string }>(sql`
    select identifier from catalog_blueprint where tenant_id = ${tenantId} and id = ${blueprintId}
  `);
  return result.rows[0]?.identifier;
}

/** One `catalog_relation_definition` row of a source blueprint, joined with its target blueprint's identifier and internal id. */
export type EntityRelationDefinitionRow = {
  readonly id: string;
  readonly identifier: string;
  readonly title: unknown;
  readonly many: boolean;
  readonly required: boolean;
  readonly target_blueprint_id: string;
  readonly target_identifier: string;
};

/** Every relation definition of `sourceBlueprintId`, ordered by identifier. */
export async function selectRelationDefinitionsForSource(
  tx: EntityRepositoryTx,
  tenantId: string,
  sourceBlueprintId: string,
): Promise<EntityRelationDefinitionRow[]> {
  const result = await tx.execute<EntityRelationDefinitionRow>(sql`
    select rd.id, rd.identifier, rd.title, rd.many, rd.required, rd.target_blueprint_id, tb.identifier as target_identifier
    from catalog_relation_definition rd
    join catalog_blueprint tb on tb.tenant_id = rd.tenant_id and tb.id = rd.target_blueprint_id
    where rd.tenant_id = ${tenantId} and rd.source_blueprint_id = ${sourceBlueprintId}
    order by rd.identifier
  `);
  return result.rows;
}

export interface EntityRelationEdgeInput {
  readonly relationDefinitionId: string;
  readonly targetEntityId: string;
  readonly position: number;
}

/** Inserts one `scope` edge per `edges` entry from `sourceEntityId`. */
export async function insertEntityRelationEdges(
  tx: EntityRepositoryTx,
  tenantId: string,
  sourceEntityId: string,
  scope: 'spec' | 'status',
  edges: readonly EntityRelationEdgeInput[],
): Promise<void> {
  for (const edge of edges) {
    await tx.execute(sql`
      insert into catalog_entity_relation
        (tenant_id, source_entity_id, relation_definition_id, scope, target_entity_id, position)
      values
        (${tenantId}, ${sourceEntityId}, ${edge.relationDefinitionId}, ${scope}, ${edge.targetEntityId}, ${edge.position})
    `);
  }
}

/** Removes every `scope` edge whose `source_entity_id` is `sourceEntityId` (design D9's "delete + insert"). */
export async function deleteEntityRelationEdgesForSource(
  tx: EntityRepositoryTx,
  tenantId: string,
  sourceEntityId: string,
  scope: 'spec' | 'status',
): Promise<void> {
  await tx.execute(sql`
    delete from catalog_entity_relation
    where tenant_id = ${tenantId} and source_entity_id = ${sourceEntityId} and scope = ${scope}
  `);
}

/** Removes every `scope` edge whose `target_entity_id` is `targetEntityId` (delete's own detach/status-cleanup step). */
export async function deleteEntityRelationEdgesForTarget(
  tx: EntityRepositoryTx,
  tenantId: string,
  targetEntityId: string,
  scope: 'spec' | 'status',
): Promise<void> {
  await tx.execute(sql`
    delete from catalog_entity_relation
    where tenant_id = ${tenantId} and target_entity_id = ${targetEntityId} and scope = ${scope}
  `);
}

/** One outgoing edge of a source entity, joined with its target's identifier (for read-back assembly). */
export type EntityEdgeRow = {
  readonly relation_definition_id: string;
  readonly scope: string;
  readonly position: number;
  readonly target_identifier: string;
};

/** Every outgoing edge (both scopes) of `sourceEntityId`, ordered for deterministic `many`-relation assembly. */
export async function selectRelationEdgesForEntity(
  tx: EntityRepositoryTx,
  tenantId: string,
  sourceEntityId: string,
): Promise<EntityEdgeRow[]> {
  const result = await tx.execute<EntityEdgeRow>(sql`
    select cer.relation_definition_id, cer.scope, cer.position, te.identifier as target_identifier
    from catalog_entity_relation cer
    join catalog_entity te on te.tenant_id = cer.tenant_id and te.id = cer.target_entity_id
    where cer.tenant_id = ${tenantId} and cer.source_entity_id = ${sourceEntityId}
    order by cer.relation_definition_id, cer.scope, cer.position
  `);
  return result.rows;
}

/** A relation definition's identifier and cardinality, keyed by its internal `id` (uuid). Mirrors `blueprints-repository.ts`'s own type. */
export type EntityRelationDefinitionById = ReadonlyMap<
  string,
  { readonly identifier: string; readonly many: boolean }
>;

/** Assembles one scope's relation bag (`{ [relation]: identifier | identifier[] }`) from a source entity's edges. */
export function assembleEntityRelationBag(
  edges: readonly EntityEdgeRow[],
  scope: 'spec' | 'status',
  byId: EntityRelationDefinitionById,
): Record<string, string | string[]> {
  const bag: Record<string, string | string[]> = {};
  for (const edge of edges) {
    if (edge.scope !== scope) continue;
    const definition = byId.get(edge.relation_definition_id);
    if (!definition) continue;

    if (definition.many) {
      const existing = bag[definition.identifier];
      const list = Array.isArray(existing) ? existing : [];
      list.push(edge.target_identifier);
      bag[definition.identifier] = list;
    } else {
      bag[definition.identifier] = edge.target_identifier;
    }
  }
  return bag;
}

/** One `spec`-scope referrer of a target entity (delete's default rejection and `detachReferences` checks). */
export type SpecReferrerRow = {
  readonly source_entity_id: string;
  readonly source_identifier: string;
  readonly source_blueprint_id: string;
  readonly relation_definition_id: string;
  readonly required: boolean;
};

/** Every `spec`-scope edge targeting `targetEntityId`, ordered by the referrer's identifier. */
export async function selectSpecReferrers(
  tx: EntityRepositoryTx,
  tenantId: string,
  targetEntityId: string,
): Promise<SpecReferrerRow[]> {
  const result = await tx.execute<SpecReferrerRow>(sql`
    select cer.source_entity_id, se.identifier as source_identifier, se.blueprint_id as source_blueprint_id,
           cer.relation_definition_id, rd.required
    from catalog_entity_relation cer
    join catalog_entity se on se.tenant_id = cer.tenant_id and se.id = cer.source_entity_id
    join catalog_relation_definition rd on rd.tenant_id = cer.tenant_id and rd.id = cer.relation_definition_id
    where cer.tenant_id = ${tenantId} and cer.scope = 'spec' and cer.target_entity_id = ${targetEntityId}
    order by se.identifier
  `);
  return result.rows;
}

/** The distinct source entities of every `status`-scope edge targeting `targetEntityId` (delete's always-removed step). */
export async function selectDistinctStatusReferrerIds(
  tx: EntityRepositoryTx,
  tenantId: string,
  targetEntityId: string,
): Promise<string[]> {
  const result = await tx.execute<{ source_entity_id: string }>(sql`
    select distinct cer.source_entity_id
    from catalog_entity_relation cer
    where cer.tenant_id = ${tenantId} and cer.scope = 'status' and cer.target_entity_id = ${targetEntityId}
  `);
  return result.rows.map((row) => row.source_entity_id);
}

/** One forward-traversal result row (`listRelated`, direction `'forward'`): the root's own outgoing edges. */
export type ForwardRelatedRow = {
  readonly relation_identifier: string;
  readonly scope: string;
  readonly target_blueprint_identifier: string;
  readonly target_identifier: string;
  readonly target_title: string;
};

export interface RelatedPageOptions {
  readonly scope?: 'spec' | 'status';
  readonly limit: number;
  readonly after?: { readonly relation: string; readonly identifier: string };
}

/** Up to `options.limit + 1` forward edges of `sourceEntityId`, ordered by `(relation, target identifier)` (design D10). */
export async function selectForwardRelatedPage(
  tx: EntityRepositoryTx,
  tenantId: string,
  sourceEntityId: string,
  options: RelatedPageOptions,
): Promise<ForwardRelatedRow[]> {
  const scopeClause = options.scope !== undefined ? sql`and cer.scope = ${options.scope}` : sql``;
  const cursorClause =
    options.after !== undefined
      ? sql`and (rd.identifier, te.identifier) > (${options.after.relation}, ${options.after.identifier})`
      : sql``;
  const result = await tx.execute<ForwardRelatedRow>(sql`
    select rd.identifier as relation_identifier, cer.scope, tb.identifier as target_blueprint_identifier,
           te.identifier as target_identifier, te.title as target_title
    from catalog_entity_relation cer
    join catalog_relation_definition rd on rd.tenant_id = cer.tenant_id and rd.id = cer.relation_definition_id
    join catalog_entity te on te.tenant_id = cer.tenant_id and te.id = cer.target_entity_id
    join catalog_blueprint tb on tb.tenant_id = te.tenant_id and tb.id = te.blueprint_id
    where cer.tenant_id = ${tenantId} and cer.source_entity_id = ${sourceEntityId} ${scopeClause} ${cursorClause}
    order by rd.identifier, te.identifier
    limit ${options.limit + 1}
  `);
  return result.rows;
}

/** One backward-traversal result row (`listRelated`, direction `'backward'`): the referrers pointing at the root. */
export type BackwardRelatedRow = {
  readonly relation_identifier: string;
  readonly scope: string;
  readonly source_blueprint_identifier: string;
  readonly source_identifier: string;
  readonly source_title: string;
};

/** Up to `options.limit + 1` backward edges targeting `targetEntityId`, ordered by `(relation, source identifier)`. */
export async function selectBackwardRelatedPage(
  tx: EntityRepositoryTx,
  tenantId: string,
  targetEntityId: string,
  options: RelatedPageOptions,
): Promise<BackwardRelatedRow[]> {
  const scopeClause = options.scope !== undefined ? sql`and cer.scope = ${options.scope}` : sql``;
  const cursorClause =
    options.after !== undefined
      ? sql`and (rd.identifier, se.identifier) > (${options.after.relation}, ${options.after.identifier})`
      : sql``;
  const result = await tx.execute<BackwardRelatedRow>(sql`
    select rd.identifier as relation_identifier, cer.scope, sb.identifier as source_blueprint_identifier,
           se.identifier as source_identifier, se.title as source_title
    from catalog_entity_relation cer
    join catalog_relation_definition rd on rd.tenant_id = cer.tenant_id and rd.id = cer.relation_definition_id
    join catalog_entity se on se.tenant_id = cer.tenant_id and se.id = cer.source_entity_id
    join catalog_blueprint sb on sb.tenant_id = se.tenant_id and sb.id = se.blueprint_id
    where cer.tenant_id = ${tenantId} and cer.target_entity_id = ${targetEntityId} ${scopeClause} ${cursorClause}
    order by rd.identifier, se.identifier
    limit ${options.limit + 1}
  `);
  return result.rows;
}
