/**
 * Shared test helpers for the entity-operation integration tests owned by
 * this batch (tasks 8.6-8.10, openspec/changes/001-catalog-core):
 * `entities-delete.int.test.ts`, `entity-related.int.test.ts`,
 * `isolation-entities.int.test.ts`, `concurrency.int.test.ts` and
 * `actor-parity.int.test.ts`. Not a test file itself (no assertions run at
 * import time), only connection, seeding, locking and change-event
 * inspection helpers that are specific to this batch and are not already
 * covered by `./blueprint-test-helpers.js` (which every file in this batch
 * also imports directly for `databaseUrl`, `connect`, `endQuietly`,
 * `randomTenantId`, `randomSuffix`, `expectCatalogErrorCode`, `blueprintRowId`
 * and `selectChangeEvents`).
 *
 * Prefixed `entity-b-` (rather than `entity-a-`) per the task instructions,
 * so this file never collides with whatever fixture file the concurrent
 * batch working on tasks 8.1-8.5 adds for `entities.int.test.ts`,
 * `entity-relations.int.test.ts`, `entities-upsert.int.test.ts` and
 * `entity-status.int.test.ts`.
 */
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import type { TestDb } from './blueprint-test-helpers.js';

/**
 * The internal `catalog_entity.id` (uuid) of `identifier` within
 * `blueprintId`, needed to seed rows in tables that reference an entity by
 * uuid (`catalog_entity_relation`) rather than its public identifier. Mirrors
 * `blueprint-test-helpers.js`'s `blueprintRowId` for the entity table.
 */
export async function entityRowId(
  db: TestDb,
  tenantId: string,
  blueprintId: string,
  identifier: string,
): Promise<string> {
  const result = await db.execute<{ id: string }>(sql`
    select id from catalog_entity
    where tenant_id = ${tenantId} and blueprint_id = ${blueprintId} and identifier = ${identifier}
  `);
  const row = result.rows[0];
  if (!row) {
    throw new Error(`no catalog_entity row for tenant ${tenantId}, blueprint ${blueprintId}, identifier ${identifier}`);
  }
  return row.id;
}

/**
 * The internal `catalog_relation_definition.id` (uuid) of `identifier` on
 * `sourceBlueprintId`, needed to seed `catalog_entity_relation` edges
 * directly (`./entities.js`'s relation-writing operations are the module
 * under test, so this batch never seeds edges through it for setup that must
 * exist independently of it, for example the 1000-referrer limit fixture
 * below).
 */
export async function relationDefinitionRowId(
  db: TestDb,
  tenantId: string,
  sourceBlueprintId: string,
  identifier: string,
): Promise<string> {
  const result = await db.execute<{ id: string }>(sql`
    select id from catalog_relation_definition
    where tenant_id = ${tenantId} and source_blueprint_id = ${sourceBlueprintId} and identifier = ${identifier}
  `);
  const row = result.rows[0];
  if (!row) {
    throw new Error(
      `no catalog_relation_definition row for tenant ${tenantId}, source blueprint ${sourceBlueprintId}, identifier ${identifier}`,
    );
  }
  return row.id;
}

/**
 * Bulk-seeds `count` referrer entities of `refBlueprintId`, each holding one
 * `scope: 'spec'` edge through `relationDefinitionId` to `targetEntityId`
 * (spec "Entity read, list and delete": the 1000-referrer detach limit,
 * `CatalogLimits.detach.maxReferrers`). A single bulk `INSERT ... SELECT
 * FROM unnest(...)` per table (two round trips total, not `2 * count`) is
 * required to seed the 1001 rows the limit test needs in reasonable time;
 * `./entities.js`'s own `create` (task 8.1, a full validate-then-write
 * round trip per call) is not used for this fixture, exactly like
 * `blueprint-test-helpers.js`'s `seedEntity` bypasses it for the same
 * reason. Every seeded entity gets an empty `spec_properties` (`{}`): this
 * fixture only exists to exercise the delete-time referrer count, never
 * entity validation.
 */
export async function seedManyReferrers(
  db: TestDb,
  tenantId: string,
  refBlueprintId: string,
  relationDefinitionId: string,
  targetEntityId: string,
  count: number,
): Promise<void> {
  const ids = Array.from({ length: count }, () => randomUUID());
  const identifiers = ids.map((_, index) => `referrer-${String(index)}`);
  const idsParam = sql.param(ids);
  const identifiersParam = sql.param(identifiers);

  await db.execute(sql`
    insert into catalog_entity
      (id, tenant_id, blueprint_id, identifier, title, spec_properties, generation, version,
       created_at, created_by_type, created_by_id, updated_at, updated_by_type, updated_by_id)
    select t.id, ${tenantId}, ${refBlueprintId}, t.identifier, t.identifier, '{}'::jsonb, 1, 1,
           now(), 'system', 'sys', now(), 'system', 'sys'
    from unnest(${idsParam}::uuid[], ${identifiersParam}::text[]) as t(id, identifier)
  `);

  await db.execute(sql`
    insert into catalog_entity_relation
      (tenant_id, source_entity_id, relation_definition_id, scope, target_entity_id, position)
    select ${tenantId}, t.id, ${relationDefinitionId}, 'spec', ${targetEntityId}, 0
    from unnest(${idsParam}::uuid[]) as t(id)
  `);
}

// A type literal (not an interface), for the same `db.execute`'s
// `TRow extends Record<string, unknown>` reason as every other raw-row type
// in this package's fixtures (see `blueprint-test-helpers.ts`'s own note).
export type ChangeEventActorRow = {
  readonly seq: string;
  readonly action: string;
  readonly resource_kind: string;
  readonly version: number;
  readonly actor_type: string;
  readonly actor_id: string;
  readonly on_behalf_of_type: string | null;
  readonly on_behalf_of_id: string | null;
  readonly snapshot: unknown;
};

/**
 * Every `catalog_change_event` row for one resource, ordered by `seq`, with
 * the actor and delegation columns `./blueprint-test-helpers.js`'s own
 * `selectChangeEvents` does not project (spec "Actor attribution and change
 * events": attribution and the `onBehalfOf` principal are recorded on the
 * event itself, not only on the mutated resource).
 */
export async function selectChangeEventActors(
  db: TestDb,
  tenantId: string,
  resourceIdentifier: string,
): Promise<ChangeEventActorRow[]> {
  const result = await db.execute<ChangeEventActorRow>(sql`
    select seq::text as seq, action, resource_kind, version, actor_type, actor_id,
           on_behalf_of_type, on_behalf_of_id, snapshot
    from catalog_change_event
    where tenant_id = ${tenantId} and resource_identifier = ${resourceIdentifier}
    order by seq
  `);
  return result.rows;
}

/**
 * The count of every `catalog_change_event` row for `tenantId`, across every
 * resource. Used to assert "Failed mutation appends nothing" (spec "Actor
 * attribution and change events"): the tenant's change-event sequence is
 * unchanged, not just the one resource's event list.
 */
export async function countChangeEventsForTenant(db: TestDb, tenantId: string): Promise<number> {
  const result = await db.execute<{ count: string }>(sql`
    select count(*)::text as count from catalog_change_event where tenant_id = ${tenantId}
  `);
  return Number(result.rows[0]?.count ?? '0');
}

/**
 * `catalog_blueprint`'s physical row location (`page`, `tuple`, from its
 * `ctid` system column) at the moment this is called. Task 8.9's barrier
 * needs a way to count *this specific row's* lock waiters in `pg_locks`
 * without matching any other test file's unrelated `catalog_blueprint` lock
 * activity, which a bare `relation = 'catalog_blueprint'::regclass` filter
 * would not exclude when integration test files run concurrently against the
 * shared `DATABASE_URL` database (design D12). `ctid` is stable across the
 * locking phase this barrier controls: neither `entities.js`'s `FOR SHARE`
 * read nor `blueprints.ts`'s `FOR UPDATE` read rewrites the row, only the
 * later `UPDATE` inside `blueprints.update` would, and that only runs after
 * the barrier has already released the row.
 */
export interface BlueprintRowLocation {
  readonly page: number;
  readonly tuple: number;
}

export async function blueprintRowLocation(
  db: TestDb,
  tenantId: string,
  identifier: string,
): Promise<BlueprintRowLocation> {
  const result = await db.execute<{ ctid: string }>(sql`
    select ctid::text as ctid from catalog_blueprint where tenant_id = ${tenantId} and identifier = ${identifier}
  `);
  const raw = result.rows[0]?.ctid;
  if (raw === undefined) {
    throw new Error(`no catalog_blueprint row for tenant ${tenantId}, identifier ${identifier}`);
  }
  const match = /^\((\d+),(\d+)\)$/.exec(raw);
  if (!match?.[1] || !match[2]) {
    throw new Error(`unexpected ctid format: ${raw}`);
  }
  return { page: Number(match[1]), tuple: Number(match[2]) };
}

/**
 * The number of backends currently contending for the row-level lock on the
 * specific `catalog_blueprint` row at `location` (task 8.9's barrier):
 * blocked behind this test's own controller connection's `FOR UPDATE`/`FOR
 * SHARE` hold, in queue order.
 *
 * Counts every `pg_locks` row of `locktype = 'tuple'` at that exact
 * `(page, tuple)`, **granted or not**. On PostgreSQL 16, `heap_lock_tuple`
 * (`heapam.c`) makes every backend that finds the tuple already locked by
 * another in-progress transaction acquire this same per-tuple heavyweight
 * lock *before* it waits on the specific blocking transaction id: the first
 * such backend gets it granted immediately (an uncontended, empty queue) and
 * only then waits, ungranted, on a `transactionid` lock keyed by the
 * blocker's xid -- not on this tuple lock -- so it would never be counted by
 * a `granted = false` filter on `locktype = 'tuple'` alone, exactly the
 * defect a fixed number of waiters (as low as one) must not miss. Every
 * later backend queues, ungranted, on this very same tuple lock instead, so
 * counting *every* row at this `(page, tuple)` regardless of `granted` -- not
 * just the ungranted ones -- gives the exact number of contending backends.
 * Verified empirically against a live PostgreSQL 16 instance with one, two
 * and three concurrent waiters.
 */
export async function countBlueprintRowWaiters(db: TestDb, location: BlueprintRowLocation): Promise<number> {
  const result = await db.execute<{ count: string }>(sql`
    select count(*)::text as count
    from pg_locks
    where locktype = 'tuple'
      and relation = 'catalog_blueprint'::regclass
      and page = ${location.page}
      and tuple = ${location.tuple}
  `);
  return Number(result.rows[0]?.count ?? '0');
}

/**
 * Polls `countBlueprintRowWaiters` until it reaches `expectedCount`, the
 * deterministic half of task 8.9's barrier: rather than an arbitrary sleep,
 * the test only proceeds once it has *observed* the exact number of backends
 * blocked on the contested row, so the lock-acquisition order the test
 * constructs (which connection queued first) is never left to chance.
 */
export async function waitForBlueprintRowWaiters(
  db: TestDb,
  location: BlueprintRowLocation,
  expectedCount: number,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const count = await countBlueprintRowWaiters(db, location);
    if (count >= expectedCount) return;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out after ${String(timeoutMs)}ms waiting for ${String(expectedCount)} waiter(s) on the catalog_blueprint row at page ${String(location.page)}, tuple ${String(location.tuple)}; saw ${String(count)}.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * A lock this test's controller connection holds on the `catalog_blueprint`
 * row of `identifier`, acquired with an explicit `mode` (`'update'` for
 * `FOR UPDATE`, `'share'` for `FOR SHARE`) on a dedicated `PoolClient` kept
 * open across the whole hold (a plain `db.execute` per statement would use a
 * fresh pooled connection each time and could never hold a lock across
 * calls). `release()` commits the controller's transaction (a no-op read,
 * nothing to roll back) and returns the client to the pool.
 */
export interface HeldBlueprintRowLock {
  release(): Promise<void>;
}

export async function acquireBlueprintRowLock(
  pool: TestDb['$client'],
  tenantId: string,
  identifier: string,
  mode: 'update' | 'share',
): Promise<HeldBlueprintRowLock> {
  const client = await pool.connect();
  await client.query('BEGIN');
  const lockClause = mode === 'update' ? 'for update' : 'for share';
  await client.query(`select id from catalog_blueprint where tenant_id = $1 and identifier = $2 ${lockClause}`, [
    tenantId,
    identifier,
  ]);
  return {
    async release(): Promise<void> {
      await client.query('COMMIT');
      client.release();
    },
  };
}
