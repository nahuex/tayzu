/**
 * Drizzle table definitions for the catalog data model (design D4, task
 * 5.1). `@tayzu/db`'s `drizzle.config.ts` globs this file to generate the
 * first migration; this package never runs `drizzle-kit` itself and never
 * hand-writes migration SQL (design D1).
 *
 * Relations are stored only as edges in `catalogEntityRelation`, never also
 * inside `spec` or `status` JSON (design D4, ADR-0009). Every table that
 * scopes data by tenant carries `tenant_id`, and every foreign key is
 * composite with `tenant_id` so a cross-tenant edge is impossible even if a
 * service-layer bug slips through (defense in depth, SEC03).
 *
 * Constraint and index names are explicit and stable: `@tayzu/db` and
 * `@tayzu/catalog` map database errors by constraint name, never by
 * SQLSTATE alone (design D9). Single-column primary keys rely on
 * PostgreSQL's own `<table>_pkey` default, which task 5.1's Verify clause
 * names explicitly; composite primary keys, unique constraints, foreign
 * keys, checks and indexes all pass an explicit `name`.
 */
import { sql, type SQL } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  type PgPolicy,
  pgRole,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * The runtime CRUD role every catalog query runs as (design D6). Declared
 * `.existing()` so `drizzle-kit generate` never emits `CREATE ROLE`/`DROP
 * ROLE` for it: the role itself, its grants and `FORCE ROW LEVEL SECURITY`
 * are task 6.2's hand-written migration, not expressible through Drizzle's
 * table definitions. This declaration exists only so `tenantIsolationPolicy`
 * below has a typed `to` target.
 */
const tayzuApp = pgRole('tayzu_app').existing();

/**
 * Every catalog table's single RLS policy (design D6): permissive, `for:
 * 'all'`, scoped to `tayzu_app`, comparing `tenant_id` to the session-local
 * `app.tenant_id` setting that `withTenantTransaction` (`@tayzu/db`) sets on
 * every request. `USING` gates reads (and the pre-update read of a row);
 * `WITH CHECK` gates the row a write leaves behind — both must hold, so both
 * clauses repeat the same comparison. Declaring this alongside a table's
 * columns is what makes `drizzle-kit generate` also emit `ENABLE ROW LEVEL
 * SECURITY` for that table; `FORCE ROW LEVEL SECURITY` is not expressible
 * through Drizzle and ships as task 6.2's hand-written migration.
 */
function tenantIsolationPolicy(column: AnyPgColumn): PgPolicy {
  const tenantMatchesSession = sql`${column} = current_setting('app.tenant_id', true)`;
  return pgPolicy('tenant_isolation', {
    for: 'all',
    to: tayzuApp,
    using: tenantMatchesSession,
    withCheck: tenantMatchesSession,
  });
}

/**
 * Restricts `column` to the closed set of actor types (spec Conventions,
 * "Catalog context"; design D3, D4; mirrors `domain/context.ts`'s
 * `ACTOR_TYPES`). The list is written as literal SQL text rather than built
 * from an array: `sql` inlines a `Column` or another `SQL` fragment as
 * literal text, but turns a plain interpolated string into a bind
 * parameter, which a static migration file has no value to supply for.
 */
function actorTypeCheck(column: AnyPgColumn): SQL {
  return sql`${column} in ('user', 'agent', 'integration', 'system')`;
}

/** Blueprints: the schema of a kind of entity. */
export const catalogBlueprint = pgTable(
  'catalog_blueprint',
  {
    id: uuid('id').notNull().primaryKey(),
    tenantId: text('tenant_id').notNull(),
    identifier: text('identifier').notNull(),
    title: jsonb('title').notNull(),
    description: jsonb('description'),
    icon: text('icon'),
    schema: jsonb('schema').notNull(),
    statusSchema: jsonb('status_schema'),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    createdByType: text('created_by_type').notNull(),
    createdById: text('created_by_id').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    updatedByType: text('updated_by_type').notNull(),
    updatedById: text('updated_by_id').notNull(),
  },
  (t) => [
    unique('catalog_blueprint_tenant_identifier_uq').on(t.tenantId, t.identifier),
    // FK target for every composite (tenant_id, *_blueprint_id) reference below.
    unique('catalog_blueprint_tenant_id_uq').on(t.tenantId, t.id),
    check('catalog_blueprint_created_by_type_check', actorTypeCheck(t.createdByType)),
    check('catalog_blueprint_updated_by_type_check', actorTypeCheck(t.updatedByType)),
    tenantIsolationPolicy(t.tenantId),
  ],
);

/** Relation definitions: the declared, typed edges between two blueprints. */
export const catalogRelationDefinition = pgTable(
  'catalog_relation_definition',
  {
    id: uuid('id').notNull().primaryKey(),
    tenantId: text('tenant_id').notNull(),
    sourceBlueprintId: uuid('source_blueprint_id').notNull(),
    identifier: text('identifier').notNull(),
    title: jsonb('title').notNull(),
    targetBlueprintId: uuid('target_blueprint_id').notNull(),
    many: boolean('many').notNull(),
    required: boolean('required').notNull(),
  },
  (t) => [
    unique('catalog_relation_definition_tenant_source_identifier_uq').on(
      t.tenantId,
      t.sourceBlueprintId,
      t.identifier,
    ),
    // FK target for catalog_entity_relation's composite reference to this table.
    unique('catalog_relation_definition_tenant_id_uq').on(t.tenantId, t.id),
    foreignKey({
      name: 'catalog_relation_definition_source_blueprint_fk',
      columns: [t.tenantId, t.sourceBlueprintId],
      foreignColumns: [catalogBlueprint.tenantId, catalogBlueprint.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'catalog_relation_definition_target_blueprint_fk',
      columns: [t.tenantId, t.targetBlueprintId],
      foreignColumns: [catalogBlueprint.tenantId, catalogBlueprint.id],
    }).onDelete('restrict'),
    check(
      'catalog_relation_definition_many_required_check',
      sql`NOT (${t.many} AND ${t.required})`,
    ),
    tenantIsolationPolicy(t.tenantId),
  ],
);

/** Entities: instances of a blueprint, split into a `spec` and an observed `status`. */
export const catalogEntity = pgTable(
  'catalog_entity',
  {
    id: uuid('id').notNull().primaryKey(),
    tenantId: text('tenant_id').notNull(),
    blueprintId: uuid('blueprint_id').notNull(),
    identifier: text('identifier').notNull(),
    title: text('title').notNull(),
    icon: text('icon'),
    specProperties: jsonb('spec_properties').notNull(),
    statusProperties: jsonb('status_properties'),
    statusObservedGeneration: integer('status_observed_generation'),
    statusObservedAt: timestamp('status_observed_at', { withTimezone: true }),
    statusSource: text('status_source'),
    generation: integer('generation').notNull(),
    version: integer('version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    createdByType: text('created_by_type').notNull(),
    createdById: text('created_by_id').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    updatedByType: text('updated_by_type').notNull(),
    updatedById: text('updated_by_id').notNull(),
  },
  (t) => [
    unique('catalog_entity_tenant_blueprint_identifier_uq').on(
      t.tenantId,
      t.blueprintId,
      t.identifier,
    ),
    // FK target for catalog_entity_relation's composite references to this table.
    unique('catalog_entity_tenant_id_uq').on(t.tenantId, t.id),
    foreignKey({
      name: 'catalog_entity_blueprint_fk',
      columns: [t.tenantId, t.blueprintId],
      foreignColumns: [catalogBlueprint.tenantId, catalogBlueprint.id],
    }).onDelete('restrict'),
    check('catalog_entity_created_by_type_check', actorTypeCheck(t.createdByType)),
    check('catalog_entity_updated_by_type_check', actorTypeCheck(t.updatedByType)),
    tenantIsolationPolicy(t.tenantId),
  ],
);

/**
 * Relations stored as edges. `scope` distinguishes the desired (`spec`) edges
 * from the observed (`status`) edges reported by an integration; both reuse
 * the same relation definition (design D4, D9).
 */
export const catalogEntityRelation = pgTable(
  'catalog_entity_relation',
  {
    tenantId: text('tenant_id').notNull(),
    sourceEntityId: uuid('source_entity_id').notNull(),
    relationDefinitionId: uuid('relation_definition_id').notNull(),
    scope: text('scope').notNull(),
    targetEntityId: uuid('target_entity_id').notNull(),
    position: integer('position').notNull(),
  },
  (t) => [
    primaryKey({
      name: 'catalog_entity_relation_pkey',
      columns: [t.tenantId, t.sourceEntityId, t.relationDefinitionId, t.scope, t.targetEntityId],
    }),
    foreignKey({
      name: 'catalog_entity_relation_source_fk',
      columns: [t.tenantId, t.sourceEntityId],
      foreignColumns: [catalogEntity.tenantId, catalogEntity.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'catalog_entity_relation_target_fk',
      columns: [t.tenantId, t.targetEntityId],
      foreignColumns: [catalogEntity.tenantId, catalogEntity.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'catalog_entity_relation_definition_fk',
      columns: [t.tenantId, t.relationDefinitionId],
      foreignColumns: [catalogRelationDefinition.tenantId, catalogRelationDefinition.id],
    }).onDelete('restrict'),
    check('catalog_entity_relation_scope_check', sql`${t.scope} in ('spec', 'status')`),
    // Backward traversal ("what points at this entity?") without a table scan.
    index('catalog_entity_relation_tenant_target_idx').on(t.tenantId, t.targetEntityId),
    tenantIsolationPolicy(t.tenantId),
  ],
);

/**
 * The append-only change-event log (design D4, D9, R13). Each row stores a
 * `snapshot` of the resulting state, so the table doubles as a point-in-time
 * history without separate revision tables. The append-only trigger that
 * rejects `UPDATE`, `DELETE` and `TRUNCATE` is not expressible in Drizzle and
 * ships as a hand-written custom migration (0001).
 */
export const catalogChangeEvent = pgTable(
  'catalog_change_event',
  {
    tenantId: text('tenant_id').notNull(),
    seq: bigint('seq', { mode: 'bigint' }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    onBehalfOfType: text('on_behalf_of_type'),
    onBehalfOfId: text('on_behalf_of_id'),
    action: text('action').notNull(),
    resourceKind: text('resource_kind').notNull(),
    blueprintIdentifier: text('blueprint_identifier').notNull(),
    resourceIdentifier: text('resource_identifier').notNull(),
    version: integer('version').notNull(),
    changedFields: text('changed_fields').array().notNull(),
    snapshot: jsonb('snapshot').notNull(),
    traceId: text('trace_id'),
  },
  (t) => [
    primaryKey({ name: 'catalog_change_event_pkey', columns: [t.tenantId, t.seq] }),
    check('catalog_change_event_actor_type_check', actorTypeCheck(t.actorType)),
    check(
      'catalog_change_event_on_behalf_of_type_check',
      sql`${t.onBehalfOfType} is null or ${actorTypeCheck(t.onBehalfOfType)}`,
    ),
    // Both columns describe the delegate: either neither is set, or both are
    // (design D3, "on behalf of").
    check(
      'catalog_change_event_on_behalf_of_pair_check',
      sql`(${t.onBehalfOfType} is null and ${t.onBehalfOfId} is null)
          or (${t.onBehalfOfType} is not null and ${t.onBehalfOfId} is not null)`,
    ),
    check(
      'catalog_change_event_action_check',
      sql`${t.action} in ('created', 'updated', 'status_updated', 'deleted')`,
    ),
    check(
      'catalog_change_event_resource_kind_check',
      sql`${t.resourceKind} in ('blueprint', 'entity')`,
    ),
    // "The state of a resource at any past version can be read from its
    // events" (spec, "Change events record resulting values") as an index
    // lookup rather than a sequential scan.
    index('catalog_change_event_resource_history_idx').on(
      t.tenantId,
      t.blueprintIdentifier,
      t.resourceIdentifier,
      t.seq,
    ),
    tenantIsolationPolicy(t.tenantId),
  ],
);

/** Per-tenant gap-free counter that assigns `catalog_change_event.seq` (design D9). */
export const catalogTenantSequence = pgTable(
  'catalog_tenant_sequence',
  {
    tenantId: text('tenant_id').notNull().primaryKey(),
    lastSeq: bigint('last_seq', { mode: 'bigint' }).notNull(),
  },
  (t) => [tenantIsolationPolicy(t.tenantId)],
);
