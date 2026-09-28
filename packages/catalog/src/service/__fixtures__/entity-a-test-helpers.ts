/**
 * Shared test helpers for the entity-operation integration tests owned by
 * this batch (tasks 8.1-8.5, openspec/changes/001-catalog-core):
 * `entities.int.test.ts`, `entity-relations.int.test.ts`,
 * `entities-upsert.int.test.ts` and `entity-status.int.test.ts`. Not a test
 * file itself (no assertions run at import time), only connection, input-
 * builder and seeding helpers that are specific to this batch and are not
 * already covered by `./blueprint-test-helpers.js` (which every file in this
 * batch also imports directly for `databaseUrl`, `connect`, `endQuietly`,
 * `randomTenantId`, `expectCatalogErrorCode`, `blueprintRowId` and
 * `selectChangeEvents` -- `selectChangeEvents` filters by
 * `resource_identifier` only, so it already works for entity resources
 * exactly as it does for blueprints).
 *
 * Prefixed `entity-a-` (rather than `entity-b-`) per the task instructions,
 * so this file never collides with whatever fixture file the concurrent
 * batch working on tasks 8.6-8.10 adds for `entities-delete.int.test.ts`,
 * `entity-related.int.test.ts`, `isolation-entities.int.test.ts`,
 * `concurrency.int.test.ts` and `actor-parity.int.test.ts`.
 */
import { sql } from 'drizzle-orm';

import type { CatalogContext } from '../../domain/context.js';
import type { CreateBlueprintInput } from '../blueprints.js';
// `./entities.js` does not exist yet (red phase): this type-only import is
// expected to fail `tsc --noEmit` for exactly that reason, the same way
// every test file's own `import { createEntityService, ... } from
// './entities.js'` does.
import type { CreateEntityInput, UpsertEntityInput } from '../entities.js';
import type { TestDb } from './blueprint-test-helpers.js';

export const DEFAULT_ACTOR: CatalogContext['actor'] = { type: 'user', id: 'user-1' };

export function ctx(tenantId: string, actor: CatalogContext['actor'] = DEFAULT_ACTOR): CatalogContext {
  return { tenantId, actor };
}

/**
 * A minimal, valid blueprint create/update input (same shape
 * `blueprints.int.test.ts` builds locally), with `overrides` shallow-merged
 * on top. Entities need a real blueprint to attach to, created through the
 * real blueprint service (task instructions: "create blueprints through the
 * real blueprint service in test setup"), never through raw SQL.
 */
export function blueprintInput(
  identifier: string,
  overrides: Partial<CreateBlueprintInput> = {},
): CreateBlueprintInput {
  return {
    identifier,
    title: { en: identifier },
    schema: { properties: {}, required: [] },
    ...overrides,
  };
}

/**
 * A minimal, valid entity create/upsert input for `blueprint`/`identifier`,
 * with `overrides` shallow-merged on top. Overloaded on `overrides`'s shape:
 * a plain `Partial<CreateEntityInput>` (no `mode`) returns a
 * `CreateEntityInput`, for `entities.create`; adding `mode` (and optionally
 * `expectedVersion`) resolves the second overload and returns an
 * `UpsertEntityInput`, for `entities.upsert`. Every call site passes a
 * literal `overrides` object, so the excess-property check on `mode` (which
 * `CreateEntityInput` does not declare) is exactly what selects the right
 * overload.
 */
export function entityInput(
  blueprint: string,
  identifier: string,
  overrides?: Partial<CreateEntityInput>,
): CreateEntityInput;
export function entityInput(
  blueprint: string,
  identifier: string,
  overrides: Partial<UpsertEntityInput>,
): UpsertEntityInput;
export function entityInput(
  blueprint: string,
  identifier: string,
  overrides: Record<string, unknown> = {},
): CreateEntityInput | UpsertEntityInput {
  return {
    blueprint,
    identifier,
    title: identifier,
    spec: { properties: {}, relations: {} },
    ...overrides,
  };
}

/**
 * Reads the tenant's current `catalog_tenant_sequence.last_seq` (`0` when the
 * tenant has never mutated anything yet, so the row does not exist) and
 * returns the *next* seq `appendChangeEvent`'s own
 * `INSERT ... ON CONFLICT (tenant_id) DO UPDATE ... RETURNING last_seq`
 * (`persistence/change-events.ts`) would assign. The counter is per-tenant,
 * not per-resource-kind: a blueprint created in test setup through the real
 * `createBlueprintService` already appends its own change event and consumes
 * a seq for the tenant, so callers of `seedChangeEventSeqCollision` must
 * target *this* value, not a hardcoded `1`, to make the collision land on the
 * mutation actually under test rather than on unrelated setup.
 */
export async function nextTenantSeq(db: TestDb, tenantId: string): Promise<number> {
  const result = await db.execute(sql`
    select last_seq from catalog_tenant_sequence where tenant_id = ${tenantId}
  `);
  const lastSeq = result.rows[0]?.['last_seq'];
  if (lastSeq === undefined) {
    return 1;
  }
  if (typeof lastSeq !== 'string') {
    throw new Error('catalog_tenant_sequence.last_seq must be read back as a string (bigint).');
  }
  return Number(BigInt(lastSeq) + 1n);
}

/**
 * Seeds one `catalog_change_event` row directly at `(tenantId, seq)`,
 * bypassing every service (a bare `INSERT`, which the append-only trigger
 * never blocks -- only `UPDATE`, `DELETE` and `TRUNCATE` are rejected).
 *
 * Used to force a genuine, deterministic, single-connection "unknown
 * constraint" database error through a real `entities.create`/`upsert`/
 * `writeStatus` call, with no concurrency needed (task 8.1's "checks that ...
 * an unknown constraint maps to INTERNAL"). Callers must pass `seq` as
 * `nextTenantSeq(db, tenantId)`'s result, computed *after* every setup step
 * that mutates the tenant (for example, creating the blueprint the entity
 * attaches to) has already run, so this pre-seeded row collides with the
 * change event the operation under test is about to append, on
 * `catalog_change_event_pkey (tenant_id, seq)` -- a genuine `23505` unique
 * violation on a constraint `entities.ts`'s own create/upsert/status
 * error-mapping never names (design D9's known set is the entity-identifier
 * uniqueness constraint and the relation/blueprint/relation-definition FKs,
 * never the change-event log's own primary key), so the pipeline's generic
 * "anything else -> INTERNAL" step (`service/pipeline.ts`, design D3 step 5)
 * is what actually reports it.
 */
export async function seedChangeEventSeqCollision(db: TestDb, tenantId: string, seq: number): Promise<void> {
  const changedFields = sql.param([]);
  await db.execute(sql`
    insert into catalog_change_event
      (tenant_id, seq, occurred_at, actor_type, actor_id, action, resource_kind,
       blueprint_identifier, resource_identifier, version, changed_fields, snapshot)
    values
      (${tenantId}, ${seq}, now(), 'system', 'sys', 'created', 'entity',
       'seq-collision-placeholder', 'seq-collision-placeholder', 1, ${changedFields}::text[], '{}'::jsonb)
  `);
}
