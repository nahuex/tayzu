/**
 * The purge job (`045` design D2): phase 2 of the org deletion, run as `tayzu_purge` once a
 * tenant's window has passed, in two idempotent steps (catalog rows, then Better Auth
 * rows). Filled in by the tasks of group 6; started by the `identity:purge` package script.
 */
import { emitIdentityEvent } from '@tayzu/auth';
import type { Pool, PoolClient } from 'pg';

import type { Telemetry } from '../src/telemetry.js';
import { runScript, type RunScriptOptions } from './run-script.js';

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

export interface PurgeAuthOptions {
  /**
   * Failure seam (design "Failure seams ... between a membership check and a delete"):
   * awaited for each user found with no membership outside due tenants, after that check
   * and before the user's own transaction begins, outside any transaction and holding no
   * lock. A throw interrupts the step before the marker is written.
   */
  readonly beforeUserDeleted?: (userId: string) => void | Promise<void>;
  /**
   * Step 1's `CatalogPurgeResult.entitiesRemoved`, carried into
   * `catalog.audit.org_deletion_completed`. Defaults to 0.
   */
  readonly entitiesRemoved?: number;
  /**
   * Ordering seam: awaited once, after `catalog.audit.org_deletion_completed` is emitted and
   * immediately before the organization row is deleted.
   */
  readonly beforeOrganizationDeleted?: () => void | Promise<void>;
}

/**
 * The user predicate of migration `0014`, written out for one user (`$1`): at least one
 * membership, and none in a tenant without a due pending marker. `auth.member` is fully
 * readable by `tayzu_purge` (`purge_read_all`), so a membership elsewhere is always seen.
 */
const USER_IS_LEAVING_SQL = `select exists (select 1 from auth.member mb where mb.user_id = $1)
   and not exists (
     select 1 from auth.member mb
      where mb.user_id = $1
        and not exists (
          select 1 from tenant_deletion_marker m
           where m.tenant_id = mb.organization_id
             and m.state = 'pending' and m.purge_after <= now()
        )
   ) as leaving`;

/**
 * The deletes of one leaving user (`$1`), in the order `0014`'s policies need: the
 * verification rows before the account and the user they join, the `step-up-verified:`
 * markers (keyed by session token) before the sessions, and the user last, while its
 * membership still exists so that the user predicate holds. Fixed literals only.
 */
const USER_DELETES: readonly string[] = [
  `delete from auth.verification
    where identifier in ('temp-password:' || $1, 'mfa-reenrol:' || $1)`,
  `delete from auth.verification
    where identifier in (select 'sso-link:' || a.id from auth.account a where a.user_id = $1)`,
  `delete from auth.verification
    where identifier in (
      select 'step-up-verified:' || s.token from auth.session s where s.user_id = $1
    )`,
  'delete from auth.session where user_id = $1',
  'delete from auth.account where user_id = $1',
  'delete from auth.two_factor where user_id = $1',
];

/**
 * The organization-keyed deletes after the users (`$1` is the tenant id): API keys, the
 * step-up markers and sessions still active in the tenant (those of users who stay), and
 * the members. Each commits on its own; a rerun finds the rest. The organization row is
 * deleted after them, once the completion event is emitted.
 */
const ORGANIZATION_DELETES: readonly string[] = [
  'delete from auth.apikey where reference_id = $1',
  `delete from auth.verification
    where identifier in (
      select 'step-up-verified:' || s.token from auth.session s
       where s.active_organization_id = $1
    )`,
  'delete from auth.session where active_organization_id = $1',
  'delete from auth.member where organization_id = $1',
];

/**
 * Runs `fn` in one transaction on a dedicated client: commits when it resolves `true`, rolls
 * back when it resolves `false` or throws (and rethrows).
 */
async function inTransaction(pool: Pool, fn: (tx: PoolClient) => Promise<boolean>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const commit = await fn(client);
    await client.query(commit ? 'commit' : 'rollback');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Deletes one leaving user in one transaction that first re-checks the user's memberships
 * (a membership committed since the candidate query is seen and keeps the user). If the
 * final user delete removes nothing, a membership appeared in between: the transaction is
 * rolled back, so the user keeps every row.
 */
async function purgeUser(pool: Pool, userId: string): Promise<void> {
  await inTransaction(pool, async (tx) => {
    const check = await tx.query<{ leaving: boolean }>(USER_IS_LEAVING_SQL, [userId]);
    if (check.rows[0]?.leaving !== true) {
      return true;
    }
    for (const sql of USER_DELETES) {
      await tx.query(sql, [userId]);
    }
    const deleted = await tx.query('delete from auth."user" where id = $1', [userId]);
    return deleted.rowCount === 1;
  });
}

/**
 * Purge step 2 (design D2, Resolved decisions Q150, Q161, Q163 and Q164): deletes the due
 * tenant's Better Auth rows under `0014`'s policies, then records `auth_purged_at = now()`
 * and `state = 'purged'` together. `password-reset:` rows are never touched (exempt, Q150).
 *
 * Order: the tenant's `invitation-accept:` and `invitation-shed:` rows, then its
 * invitations, before any user (a user's deletion cascades to the invitations it sent,
 * Q163); then each user with no membership outside due tenants, one transaction per user;
 * then the organization-keyed rows, the organization last; then the marker. Every auth
 * delete precedes the `purged` write, after which `0014` admits no auth row.
 *
 * A tenant already purged, or with no visible due pending marker, is a no-op. Fails closed,
 * deleting nothing, when step 1 is not recorded (`pool` must be a `tayzu_purge` pool).
 */
export async function purgeAuthStep(
  pool: Pool,
  tenantId: string,
  options: PurgeAuthOptions = {},
): Promise<void> {
  const marker = await pool.query<{ catalog_recorded: boolean }>(
    `select catalog_purged_at is not null as catalog_recorded
       from tenant_deletion_marker
      where tenant_id = $1 and state = 'pending' and purge_after <= now()`,
    [tenantId],
  );
  const [due] = marker.rows;
  if (due === undefined) {
    return;
  }
  if (!due.catalog_recorded) {
    throw new Error('purge step 2: step 1 is not recorded on the deletion marker');
  }

  await inTransaction(pool, async (tx) => {
    await tx.query(
      `delete from auth.verification
        where identifier in (
          select 'invitation-accept:' || i.id from auth.invitation i where i.organization_id = $1
          union all
          select 'invitation-shed:' || i.id from auth.invitation i where i.organization_id = $1
        )`,
      [tenantId],
    );
    await tx.query('delete from auth.invitation where organization_id = $1', [tenantId]);
    return true;
  });

  const leaving = await pool.query<{ user_id: string }>(
    `select distinct mb.user_id
       from auth.member mb
      where mb.organization_id = $1
        and not exists (
          select 1 from auth.member other
           where other.user_id = mb.user_id
             and not exists (
               select 1 from tenant_deletion_marker m
                where m.tenant_id = other.organization_id
                  and m.state = 'pending' and m.purge_after <= now()
             )
        )
      order by mb.user_id`,
    [tenantId],
  );
  for (const { user_id: userId } of leaving.rows) {
    await options.beforeUserDeleted?.(userId);
    await purgeUser(pool, userId);
  }

  for (const sql of ORGANIZATION_DELETES) {
    await pool.query(sql, [tenantId]);
  }

  // The durable record of the purge, emitted by the purge itself right before the
  // organization row goes (design D2), not from Better Auth's `afterDeleteOrganization`.
  emitIdentityEvent({
    name: 'catalog.audit.org_deletion_completed',
    severity: 'INFO',
    attributes: {
      'tayzu.tenant.id': tenantId,
      'tayzu.identity.org_deletion.entities_removed': options.entitiesRemoved ?? 0,
    },
  });
  await options.beforeOrganizationDeleted?.();
  await pool.query('delete from auth.organization where id = $1', [tenantId]);

  const recorded = await pool.query(
    `update tenant_deletion_marker
        set auth_purged_at = now(), state = 'purged'
      where tenant_id = $1 and state = 'pending' and catalog_purged_at is not null`,
    [tenantId],
  );
  if (recorded.rowCount !== 1) {
    throw new Error('purge step 2: the deletion marker could not be recorded');
  }
}

export interface RunPurgeOptions {
  /** A `tayzu_purge` pool. */
  readonly pool: Pool;
  /** The tenants this pass purges. */
  readonly tenantIds?: readonly string[];
  readonly env?: RunScriptOptions['env'];
  /** Forwarded to `runScript`. */
  readonly telemetry?: Telemetry;
  /** Forwarded to every `purgeCatalogStep` call of the pass. */
  readonly catalogOptions?: PurgeCatalogOptions;
  /**
   * Forwarded to every `purgeAuthStep` call of the pass; `runPurge` sets `entitiesRemoved`
   * from step 1's result itself.
   */
  readonly authOptions?: Omit<PurgeAuthOptions, 'entitiesRemoved'>;
}

type PurgeStep = 'catalog' | 'auth';

/**
 * Logs a failed purge step (design "Observability"): the tenant and the step only, with no
 * body and no error text, so that no tenant free text or SQL detail reaches the log.
 */
function emitStepFailed(tenantId: string, step: PurgeStep): void {
  emitIdentityEvent({
    name: 'catalog.security.org_deletion_failed',
    severity: 'WARN',
    attributes: {
      'tayzu.tenant.id': tenantId,
      'tayzu.identity.org_deletion.step': step,
    },
  });
}

/**
 * Purges one tenant: step 1, then step 2 with the entities step 1 removed (Resolved decision
 * Q169: 0 when step 1 was recorded by an earlier run). A failed step is logged and ends this
 * tenant's pass, so a failed step 1 never runs step 2; the next run resumes from the marker.
 */
async function purgeTenant(options: RunPurgeOptions, tenantId: string): Promise<void> {
  const { pool } = options;
  let entitiesRemoved: number;
  try {
    ({ entitiesRemoved } = await purgeCatalogStep(pool, tenantId, options.catalogOptions));
  } catch {
    emitStepFailed(tenantId, 'catalog');
    return;
  }
  try {
    await purgeAuthStep(pool, tenantId, { ...options.authOptions, entitiesRemoved });
  } catch {
    emitStepFailed(tenantId, 'auth');
  }
}

/**
 * One purge pass inside `runScript`, whose final flush exports the completion and failure
 * events before this resolves (`043` task 2.0, Resolved decision Q79). A failed tenant does
 * not stop the pass: it is logged and the pass continues with the next tenant, then resolves.
 * The job's exit status when a tenant failed is task 6.6's concern (the entry point).
 */
export async function runPurge(options: RunPurgeOptions): Promise<void> {
  const { tenantIds = [] } = options;
  await runScript(
    'purge-job',
    async () => {
      for (const tenantId of tenantIds) {
        await purgeTenant(options, tenantId);
      }
    },
    { env: options.env, telemetry: options.telemetry },
  );
}
