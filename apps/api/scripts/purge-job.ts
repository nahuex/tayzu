/**
 * The purge job (`045` design D2): phase 2 of the org deletion, run as `tayzu_purge` once a
 * tenant's window has passed, in two idempotent steps (catalog rows, then Better Auth
 * rows). Filled in by the tasks of group 6; started by the `identity:purge` package script.
 */
import type { Pool } from 'pg';

/** The seven tenant tables step 1 empties (migration `0013` names them one by one). */
export type CatalogPurgeTable =
  | 'catalog_entity_relation'
  | 'catalog_entity'
  | 'catalog_relation_definition'
  | 'catalog_blueprint'
  | 'catalog_change_event'
  | 'catalog_tenant_sequence'
  | 'machine_credential_revocation';

export interface PurgeCatalogOptions {
  /**
   * Failure seam (design "Failure seams ... after step 1"): awaited after the tenant's rows
   * of `table` are deleted; a throw interrupts the step before `catalog_purged_at` is set.
   */
  readonly afterTableDeleted?: (table: CatalogPurgeTable) => void | Promise<void>;
}

export interface CatalogPurgeResult {
  /** `tayzu.identity.org_deletion.entities_removed`: the entities this run removed. */
  readonly entitiesRemoved: number;
}

/**
 * The deletes of step 1, in an order that respects the `RESTRICT` foreign keys: entity
 * relations reference entities and relation definitions, and entities and relation
 * definitions reference blueprints. The last three tables reference nothing. Every
 * statement is a fixed literal; `0013`'s policies limit it to a tenant with a due marker.
 */
const CATALOG_DELETES: readonly { readonly table: CatalogPurgeTable; readonly sql: string }[] = [
  {
    table: 'catalog_entity_relation',
    sql: 'delete from catalog_entity_relation where tenant_id = $1',
  },
  { table: 'catalog_entity', sql: 'delete from catalog_entity where tenant_id = $1' },
  {
    table: 'catalog_relation_definition',
    sql: 'delete from catalog_relation_definition where tenant_id = $1',
  },
  { table: 'catalog_blueprint', sql: 'delete from catalog_blueprint where tenant_id = $1' },
  { table: 'catalog_change_event', sql: 'delete from catalog_change_event where tenant_id = $1' },
  {
    table: 'catalog_tenant_sequence',
    sql: 'delete from catalog_tenant_sequence where tenant_id = $1',
  },
  {
    table: 'machine_credential_revocation',
    sql: 'delete from machine_credential_revocation where tenant_id = $1',
  },
];

/**
 * Purge step 1 (design D2, Resolved decisions Q158 and Q161): deletes the due tenant's
 * catalog rows, then records `catalog_purged_at = now()` on its pending marker, and nothing
 * else (`auth_purged_at` and `state = 'purged'` are step 2's).
 *
 * Each delete commits on its own, so an interrupted run keeps what it removed and leaves
 * `catalog_purged_at` null; the next run deletes the rest and records the step. Once the
 * step is recorded, a run is a no-op that keeps the first timestamp. Fails closed when the
 * tenant has no due pending marker (`pool` must be a `tayzu_purge` pool).
 */
export async function purgeCatalogStep(
  pool: Pool,
  tenantId: string,
  options: PurgeCatalogOptions = {},
): Promise<CatalogPurgeResult> {
  const marker = await pool.query<{ recorded: boolean }>(
    `select catalog_purged_at is not null as recorded
       from tenant_deletion_marker
      where tenant_id = $1 and state = 'pending' and purge_after <= now()`,
    [tenantId],
  );
  const [due] = marker.rows;
  if (due === undefined) {
    throw new Error('purge step 1: the tenant has no due deletion marker');
  }
  if (due.recorded) {
    return { entitiesRemoved: 0 };
  }

  let entitiesRemoved = 0;
  for (const { table, sql } of CATALOG_DELETES) {
    const deleted = await pool.query(sql, [tenantId]);
    if (table === 'catalog_entity') {
      entitiesRemoved = deleted.rowCount ?? 0;
    }
    await options.afterTableDeleted?.(table);
  }

  await pool.query(
    `update tenant_deletion_marker
        set catalog_purged_at = now()
      where tenant_id = $1 and state = 'pending' and catalog_purged_at is null`,
    [tenantId],
  );
  return { entitiesRemoved };
}
