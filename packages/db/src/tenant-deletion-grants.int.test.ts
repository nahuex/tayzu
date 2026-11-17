/**
 * Integration test for task 2.2 of 045-org-deletion-and-data-retention
 * (migration `0013_tenant_deletion_grants`, Checkpoint 3): the catalog side
 * of the deletion access model (design D1, D2, D3, the Migration Plan, and
 * Resolved decisions Q35, Q48, Q82, Q158 and Q159).
 *
 * Every role acts through the harness's own pools (`harness.ts`):
 * `getTestDatabase()` runs as `tayzu_app`, `getPurgeTestDatabase()` as
 * `tayzu_purge` and `getDeletionAdminTestDatabase()` as
 * `tayzu_deletion_admin`. `getOwnerPool()` is the raw `DATABASE_URL` role,
 * which bypasses row-level security and inherits the table owner's
 * privileges: it seeds markers that only the database could write (a due
 * marker needs a `requested_at` in the past) and reads back what really
 * happened. "The table owner" is `tayzu_migrator` (`SET LOCAL ROLE` on an
 * owner connection, a fixed literal), which owns the seven tables and is
 * subject to `FORCE ROW LEVEL SECURITY`.
 *
 * `SET ROLE` is checked against the session user, and the four application
 * roles have no password in the test cluster, so an attempt "by" one of them
 * is asserted through `pg_has_role(<role>, 'tayzu_purge', 'SET')`, the exact
 * privilege a `SET ROLE` by that role needs in PostgreSQL 16, together with
 * the `pg_auth_members` rows the Verify clause names.
 *
 * A refusal "by the trigger or the policy" is an error with SQLSTATE 42501
 * (privilege or row-level security) or P0001 (the append-only trigger), or a
 * statement that touches no row; in every case the rows are read back through
 * the owner pool to prove that nothing changed. Every tenant id is random per
 * run, and nothing is truncated (tenant-per-test isolation).
 */
import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';

import {
  getDeletionAdminTestDatabase,
  getOwnerPool,
  getPurgeTestDatabase,
  getTestDatabase,
} from './harness.js';

const MARKER = 'tenant_deletion_marker';
const PURGE_ROLE = 'tayzu_purge';
const DELETION_ADMIN_ROLE = 'tayzu_deletion_admin';
const APP_ROLE = 'tayzu_app';
const MIGRATOR_ROLE = 'tayzu_migrator';

/** The four roles that must never reach `tayzu_purge` (design D1). */
const NON_PURGE_ROLES = ['tayzu_app', 'tayzu_auth', 'tayzu_migrator', 'tayzu_deletion_admin'];

/** The tenant's tables `tayzu_purge` deletes from, named one by one (task 2.2). */
const TENANT_TABLES = [
  'catalog_blueprint',
  'catalog_relation_definition',
  'catalog_entity',
  'catalog_entity_relation',
  'catalog_change_event',
  'catalog_tenant_sequence',
  'machine_credential_revocation',
] as const;

type TenantTable = (typeof TENANT_TABLES)[number];

/** A deletion order that respects the `RESTRICT` foreign keys. */
const DELETE_ORDER: readonly TenantTable[] = [
  'catalog_entity_relation',
  'catalog_entity',
  'catalog_relation_definition',
  'catalog_blueprint',
  'catalog_change_event',
  'catalog_tenant_sequence',
  'machine_credential_revocation',
];

/** Rows `seedTenantData` writes in each table. */
const SEEDED: Record<TenantTable, number> = {
  catalog_blueprint: 1,
  catalog_relation_definition: 1,
  catalog_entity: 2,
  catalog_entity_relation: 1,
  catalog_change_event: 2,
  catalog_tenant_sequence: 1,
  machine_credential_revocation: 2,
};

const ALL_TABLE_PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
] as const;

/** Fixed literal: never interpolated, never built from input. */
const SET_MIGRATOR_ROLE = 'SET LOCAL ROLE tayzu_migrator';

/** SQLSTATEs that count as a refusal: privilege or RLS (42501), the trigger (P0001). */
const REFUSAL_CODES = ['42501', 'P0001'];

function newTenantId(): string {
  return `tenant-${randomUUID()}`;
}

function newActorId(): string {
  return `actor-${randomUUID()}`;
}

async function appPool(): Promise<Pool> {
  return (await getTestDatabase()).pool;
}

async function purgePool(): Promise<Pool> {
  return (await getPurgeTestDatabase()).pool;
}

async function deletionAdminPool(): Promise<Pool> {
  return (await getDeletionAdminTestDatabase()).pool;
}

interface TransactionOptions {
  /** Sets `app.tenant_id` for the transaction (`set_config(..., true)`). */
  readonly tenantId?: string;
  /** Acts as the table owner, `tayzu_migrator`, for the transaction. */
  readonly asMigrator?: boolean;
}

/** Runs `fn` in one transaction; commits on success, rolls back and rethrows on error. */
async function transaction<T>(
  pool: Pool,
  options: TransactionOptions,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    try {
      if (options.asMigrator === true) {
        await client.query(SET_MIGRATOR_ROLE);
      }
      if (options.tenantId !== undefined) {
        await client.query("select set_config('app.tenant_id', $1, true)", [options.tenantId]);
      }
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  } finally {
    client.release();
  }
}

function sqlState(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

interface Outcome {
  /** SQLSTATE of the refusal, or `undefined` when the statement ran. */
  readonly code: string | undefined;
  readonly rowCount: number;
  readonly rows: Record<string, unknown>[];
}

/**
 * Runs one statement in its own transaction and reports its outcome. A
 * database error becomes `code`; any other error (a bug in this test) is
 * rethrown.
 */
async function attempt(
  pool: Pool,
  options: TransactionOptions,
  statement: string,
  params: unknown[] = [],
): Promise<Outcome> {
  try {
    return await transaction(pool, options, async (client) => {
      const result = await client.query<Record<string, unknown>>(statement, params);
      return { code: undefined, rowCount: result.rowCount ?? 0, rows: result.rows };
    });
  } catch (error) {
    const code = sqlState(error);
    if (code === undefined) {
      throw error;
    }
    return { code, rowCount: 0, rows: [] };
  }
}

/** Refused by a privilege, a policy or the trigger: a refusal SQLSTATE, or no row touched. */
function expectRefused(outcome: Outcome, label: string): void {
  if (outcome.code === undefined) {
    expect(outcome.rowCount, `${label}: touches no row`).toBe(0);
  } else {
    expect(REFUSAL_CODES, `${label}: refused with SQLSTATE ${outcome.code}`).toContain(
      outcome.code,
    );
  }
}

async function ownerCount(table: TenantTable, tenantId: string): Promise<number> {
  const owner = await getOwnerPool();
  // `table` is one of the fixed `TENANT_TABLES` literals.
  const { rows } = await owner.query<{ count: number }>(
    `select count(*)::int as count from ${table} where tenant_id = $1`,
    [tenantId],
  );
  return rows[0]?.count ?? -1;
}

async function expectSeededRowsIntact(tenantId: string, label: string): Promise<void> {
  for (const table of TENANT_TABLES) {
    expect(await ownerCount(table, tenantId), `${label}: ${table} rows intact`).toBe(SEEDED[table]);
  }
}

/** Writes rows in each of the seven tables for `tenantId`, as `tayzu_app` in its own tenant. */
async function seedTenantData(tenantId: string): Promise<void> {
  const blueprintId = randomUUID();
  const definitionId = randomUUID();
  const sourceEntityId = randomUUID();
  const targetEntityId = randomUUID();
  const actorId = newActorId();
  await transaction(await appPool(), { tenantId }, async (client) => {
    await client.query(
      `insert into catalog_blueprint
         (id, tenant_id, identifier, title, schema, version, created_at, created_by_type,
          created_by_id, updated_at, updated_by_type, updated_by_id)
       values ($1, $2, 'service', '"Service"'::jsonb, '{}'::jsonb, 1, now(), 'user', $3,
               now(), 'user', $3)`,
      [blueprintId, tenantId, actorId],
    );
    await client.query(
      `insert into catalog_relation_definition
         (id, tenant_id, source_blueprint_id, identifier, title, target_blueprint_id, many, required)
       values ($1, $2, $3, 'depends_on', '"Depends on"'::jsonb, $3, false, false)`,
      [definitionId, tenantId, blueprintId],
    );
    for (const [entityId, identifier] of [
      [sourceEntityId, 'source'],
      [targetEntityId, 'target'],
    ] as const) {
      await client.query(
        `insert into catalog_entity
           (id, tenant_id, blueprint_id, identifier, title, spec_properties, generation, version,
            created_at, created_by_type, created_by_id, updated_at, updated_by_type, updated_by_id)
         values ($1, $2, $3, $4, $4, '{}'::jsonb, 1, 1, now(), 'user', $5, now(), 'user', $5)`,
        [entityId, tenantId, blueprintId, identifier, actorId],
      );
    }
    await client.query(
      `insert into catalog_entity_relation
         (tenant_id, source_entity_id, relation_definition_id, scope, target_entity_id, position)
       values ($1, $2, $3, 'spec', $4, 0)`,
      [tenantId, sourceEntityId, definitionId, targetEntityId],
    );
    for (const seq of [1, 2]) {
      await client.query(
        `insert into catalog_change_event
           (tenant_id, seq, occurred_at, actor_type, actor_id, action, resource_kind,
            blueprint_identifier, resource_identifier, version, changed_fields, snapshot)
         values ($1, $2, now(), 'user', $3, 'created', 'entity', 'service', 'source', 1,
                 '{}'::text[], '{}'::jsonb)`,
        [tenantId, seq, actorId],
      );
    }
    await client.query('insert into catalog_tenant_sequence (tenant_id, last_seq) values ($1, 2)', [
      tenantId,
    ]);
    for (const credentialId of [randomUUID(), randomUUID()]) {
      await client.query(
        `insert into machine_credential_revocation (credential_id, revoked_at, tenant_id)
         values ($1, now(), $2)`,
        [credentialId, tenantId],
      );
    }
  });
}

type MarkerState = 'pending' | 'cancelled' | 'purged';

interface MarkerSeed {
  readonly state: MarkerState;
  /** `purge_after` one day in the past (due) or fourteen days ahead. */
  readonly due: boolean;
  readonly catalogPurged?: boolean;
  readonly authPurged?: boolean;
}

/**
 * Writes a marker through the owner pool, which alone can set `requested_at`
 * in the past. Always inside the `CHECK` window: `purge_after` is
 * `requested_at + 14 days`.
 */
async function seedMarker(tenantId: string, seed: MarkerSeed): Promise<void> {
  const owner = await getOwnerPool();
  await owner.query(
    `insert into tenant_deletion_marker
       (tenant_id, requested_at, purge_after, requested_by, state,
        catalog_purged_at, auth_purged_at, cancelled_at, cancelled_by)
     values ($1,
             now() - make_interval(days => $2::int),
             now() - make_interval(days => $2::int) + make_interval(days => 14),
             $3, $4::text,
             case when $5::boolean then now() - interval '1 hour' end,
             case when $6::boolean then now() - interval '1 hour' end,
             case when $4::text = 'cancelled' then now() - interval '1 hour' end,
             case when $4::text = 'cancelled' then $7::text end)`,
    [
      tenantId,
      seed.due ? 15 : 0,
      newActorId(),
      seed.state,
      seed.catalogPurged === true,
      seed.authPurged === true,
      `gh:${String(Math.floor(Math.random() * 1_000_000_000))}`,
    ],
  );
}

interface MarkerRow {
  readonly state: string;
  readonly cancelled_by: string | null;
  readonly cancelled: boolean;
  readonly catalog_purged: boolean;
  readonly auth_purged: boolean;
  readonly purge_after_kept: boolean;
}

/** Every marker of `tenantId`, read through the owner pool. */
async function ownerMarkers(tenantId: string): Promise<MarkerRow[]> {
  const owner = await getOwnerPool();
  const { rows } = await owner.query<MarkerRow>(
    `select state::text as state, cancelled_by,
            cancelled_at is not null as cancelled,
            catalog_purged_at is not null as catalog_purged,
            auth_purged_at is not null as auth_purged,
            purge_after = requested_at + make_interval(days => 14) as purge_after_kept
       from tenant_deletion_marker where tenant_id = $1 order by requested_at`,
    [tenantId],
  );
  return rows;
}

/** The request's own insert (task 5.2): three columns, `purge_after` from the transaction clock. */
const REQUEST_INSERT = `insert into tenant_deletion_marker (tenant_id, purge_after, requested_by)
  values ($1, now() + make_interval(days => 14), $2)`;

async function tablePrivileges(role: string, table: string): Promise<string[]> {
  const owner = await getOwnerPool();
  const granted: string[] = [];
  for (const privilege of ALL_TABLE_PRIVILEGES) {
    const { rows } = await owner.query<{ granted: boolean }>(
      'select has_table_privilege($1, $2, $3) as granted',
      [role, table, privilege],
    );
    if (rows[0]?.granted === true) {
      granted.push(privilege);
    }
  }
  return granted.sort();
}

/** The marker columns on which `role` holds the column-level `privilege`. */
async function markerColumnsWith(role: string, privilege: 'INSERT' | 'UPDATE'): Promise<string[]> {
  const owner = await getOwnerPool();
  const { rows } = await owner.query<{ column: string }>(
    `select a.attname as column
       from pg_attribute a
      where a.attrelid = 'public.tenant_deletion_marker'::regclass
        and a.attnum > 0 and not a.attisdropped
        and has_column_privilege($1, a.attrelid, a.attnum, $2)
      order by a.attname`,
    [role, privilege],
  );
  return rows.map((row) => row.column);
}

async function expectRoleExists(role: string): Promise<void> {
  const owner = await getOwnerPool();
  const { rows } = await owner.query<{ rolname: string }>(
    'select rolname from pg_roles where rolname = $1',
    [role],
  );
  expect(rows, `role "${role}" is created by migration 0013`).toEqual([{ rolname: role }]);
}

describe('tenant_deletion_marker for the request role, tayzu_app (migration 0013, task 2.2)', () => {
  it('the marker has ENABLE and FORCE ROW LEVEL SECURITY and a tenant_isolation policy TO tayzu_app (Q159)', async () => {
    const owner = await getOwnerPool();
    const { rows } = await owner.query<{ enabled: boolean; forced: boolean }>(
      `select relrowsecurity as enabled, relforcerowsecurity as forced
         from pg_class where oid = 'public.tenant_deletion_marker'::regclass`,
    );
    expect(rows).toEqual([{ enabled: true, forced: true }]);

    const policy = await owner.query<{ roles: string[]; using: string | null }>(
      `select array(select r.rolname::text from pg_roles r where r.oid = any(pol.polroles)
                     order by r.rolname) as roles,
              pg_get_expr(pol.polqual, pol.polrelid) as using
         from pg_policy pol
        where pol.polrelid = 'public.tenant_deletion_marker'::regclass
          and pol.polname = 'tenant_isolation'`,
    );
    expect(policy.rows.map((row) => row.roles)).toEqual([[APP_ROLE]]);
    expect(policy.rows[0]?.using).toMatch(
      /tenant_id\s*=\s*current_setting\('app\.tenant_id'(?:::text)?,\s*true\)/,
    );
  });

  it('tayzu_app holds SELECT and a column-level INSERT on tenant_id, purge_after and requested_by only, and no UPDATE or DELETE', async () => {
    expect(await tablePrivileges(APP_ROLE, MARKER), 'table-level privileges').toEqual(['SELECT']);
    expect(await markerColumnsWith(APP_ROLE, 'INSERT'), 'insertable columns').toEqual([
      'purge_after',
      'requested_by',
      'tenant_id',
    ]);
    expect(await markerColumnsWith(APP_ROLE, 'UPDATE'), 'updatable columns').toEqual([]);
  });

  it("tayzu_app can insert its own tenant's marker and read it back", async () => {
    const tenantId = newTenantId();
    const actorId = newActorId();
    const app = await appPool();

    const inserted = await attempt(app, { tenantId }, REQUEST_INSERT, [tenantId, actorId]);
    expect(inserted).toMatchObject({ code: undefined, rowCount: 1 });

    const read = await attempt(
      app,
      { tenantId },
      'select tenant_id, state::text as state, requested_by from tenant_deletion_marker where tenant_id = $1',
      [tenantId],
    );
    expect(read.rows).toEqual([{ tenant_id: tenantId, state: 'pending', requested_by: actorId }]);
  });

  it('tayzu_app cannot insert a marker for another tenant', async () => {
    const tenantId = newTenantId();
    const otherTenantId = newTenantId();
    const app = await appPool();

    const outcome = await attempt(app, { tenantId }, REQUEST_INSERT, [otherTenantId, newActorId()]);
    expect(outcome.code).toBe('42501');
    expect(await ownerMarkers(otherTenantId)).toEqual([]);
  });

  it("tayzu_app cannot update or delete its own tenant's marker", async () => {
    const tenantId = newTenantId();
    const app = await appPool();
    expect(
      await attempt(app, { tenantId }, REQUEST_INSERT, [tenantId, newActorId()]),
    ).toMatchObject({ code: undefined, rowCount: 1 });

    const updated = await attempt(
      app,
      { tenantId },
      `update tenant_deletion_marker set state = 'cancelled' where tenant_id = $1`,
      [tenantId],
    );
    expect(updated.code, 'UPDATE is not granted').toBe('42501');

    const deleted = await attempt(
      app,
      { tenantId },
      'delete from tenant_deletion_marker where tenant_id = $1',
      [tenantId],
    );
    expect(deleted.code, 'DELETE is not granted').toBe('42501');

    expect(await ownerMarkers(tenantId)).toMatchObject([{ state: 'pending', cancelled: false }]);
  });

  it("tayzu_app cannot read, update or delete another tenant's marker", async () => {
    const tenantId = newTenantId();
    const otherTenantId = newTenantId();
    await seedMarker(otherTenantId, { state: 'pending', due: false });
    const app = await appPool();

    const read = await attempt(
      app,
      { tenantId },
      'select tenant_id from tenant_deletion_marker where tenant_id = $1',
      [otherTenantId],
    );
    expect(read).toMatchObject({ code: undefined, rows: [] });

    const readWithoutContext = await attempt(
      app,
      {},
      'select tenant_id from tenant_deletion_marker where tenant_id = $1',
      [otherTenantId],
    );
    expect(readWithoutContext).toMatchObject({ code: undefined, rows: [] });

    const updated = await attempt(
      app,
      { tenantId },
      `update tenant_deletion_marker set state = 'cancelled' where tenant_id = $1`,
      [otherTenantId],
    );
    expectRefused(updated, 'update of another tenant’s marker');

    const deleted = await attempt(
      app,
      { tenantId },
      'delete from tenant_deletion_marker where tenant_id = $1',
      [otherTenantId],
    );
    expectRefused(deleted, 'delete of another tenant’s marker');

    expect(await ownerMarkers(otherTenantId)).toMatchObject([
      { state: 'pending', cancelled: false },
    ]);
  });

  describe('tayzu_app cannot back-date a marker: an insert naming a column outside the three is refused for lack of the column privilege', () => {
    // Each forbidden insert is otherwise valid (inside the CHECK window), so
    // the only reason left to refuse it is the missing column privilege.
    const cases = [
      {
        column: 'requested_at',
        statement: `insert into tenant_deletion_marker (tenant_id, requested_at, purge_after, requested_by)
          values ($1, now() - make_interval(days => 15), now() - make_interval(days => 1), $2)`,
      },
      {
        column: 'state',
        statement: `insert into tenant_deletion_marker (tenant_id, purge_after, requested_by, state)
          values ($1, now() + make_interval(days => 14), $2, 'purged')`,
      },
      {
        column: 'catalog_purged_at',
        statement: `insert into tenant_deletion_marker (tenant_id, purge_after, requested_by, catalog_purged_at)
          values ($1, now() + make_interval(days => 14), $2, now())`,
      },
      {
        column: 'auth_purged_at',
        statement: `insert into tenant_deletion_marker (tenant_id, purge_after, requested_by, auth_purged_at)
          values ($1, now() + make_interval(days => 14), $2, now())`,
      },
      {
        column: 'cancelled_at',
        statement: `insert into tenant_deletion_marker (tenant_id, purge_after, requested_by, cancelled_at)
          values ($1, now() + make_interval(days => 14), $2, now())`,
      },
      {
        column: 'cancelled_by',
        statement: `insert into tenant_deletion_marker (tenant_id, purge_after, requested_by, cancelled_by)
          values ($1, now() + make_interval(days => 14), $2, 'gh:1')`,
      },
    ] as const;

    it.each(cases)('an insert that names $column is refused (42501)', async ({ statement }) => {
      const tenantId = newTenantId();
      const app = await appPool();

      const refused = await attempt(app, { tenantId }, statement, [tenantId, newActorId()]);
      expect(refused.code, 'refused for lack of the column privilege').toBe('42501');
      expect(await ownerMarkers(tenantId)).toEqual([]);

      // The same request without that column is accepted, so the refusal is
      // the column's, not the table's.
      const accepted = await attempt(app, { tenantId }, REQUEST_INSERT, [tenantId, newActorId()]);
      expect(accepted).toMatchObject({ code: undefined, rowCount: 1 });
    });
  });
});

describe('tayzu_purge, the purge role (migration 0013, task 2.2)', () => {
  it('tayzu_purge exists, can log in, and has no superuser, BYPASSRLS, CREATEROLE or CREATEDB attribute', async () => {
    await expectRoleExists(PURGE_ROLE);
    const owner = await getOwnerPool();
    const { rows } = await owner.query(
      `select rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
         from pg_roles where rolname = $1`,
      [PURGE_ROLE],
    );
    expect(rows).toEqual([
      {
        rolcanlogin: true,
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
      },
    ]);
  });

  it('tayzu_purge has USAGE on schema public', async () => {
    await expectRoleExists(PURGE_ROLE);
    const owner = await getOwnerPool();
    const { rows } = await owner.query<{ usage: boolean }>(
      `select has_schema_privilege($1, 'public', 'USAGE') as usage`,
      [PURGE_ROLE],
    );
    expect(rows).toEqual([{ usage: true }]);
  });

  it('tayzu_purge holds exactly SELECT and DELETE on each of the seven tenant tables', async () => {
    await expectRoleExists(PURGE_ROLE);
    for (const table of TENANT_TABLES) {
      expect(await tablePrivileges(PURGE_ROLE, table), table).toEqual(['DELETE', 'SELECT']);
    }
  });

  it('tayzu_purge sees only due pending markers (the listing of due tenants)', async () => {
    const due = newTenantId();
    const dueResumed = newTenantId();
    const notYetDue = newTenantId();
    const cancelled = newTenantId();
    const purged = newTenantId();
    await seedMarker(due, { state: 'pending', due: true });
    await seedMarker(dueResumed, { state: 'pending', due: true, catalogPurged: true });
    await seedMarker(notYetDue, { state: 'pending', due: false });
    await seedMarker(cancelled, { state: 'cancelled', due: true });
    await seedMarker(purged, { state: 'purged', due: true, catalogPurged: true, authPurged: true });

    const purge = await purgePool();
    const listed = await purge.query<{ tenant_id: string }>(
      'select tenant_id from tenant_deletion_marker where tenant_id = any($1::text[])',
      [[due, dueResumed, notYetDue, cancelled, purged]],
    );
    expect(listed.rows.map((row) => row.tenant_id).sort()).toEqual([due, dueResumed].sort());

    // With no filter at all, every marker the role can see is a due pending one.
    const outside = await purge.query<{ count: number }>(
      `select count(*)::int as count from tenant_deletion_marker
        where not (state = 'pending' and purge_after <= now())`,
    );
    expect(outside.rows).toEqual([{ count: 0 }]);
  });

  it('tayzu_purge cannot read or delete the rows of a tenant without a due marker', async () => {
    const tenants = {
      'no marker': newTenantId(),
      'a pending marker not yet due': newTenantId(),
      'a cancelled marker': newTenantId(),
      'a purged marker': newTenantId(),
    };
    await seedMarker(tenants['a pending marker not yet due'], { state: 'pending', due: false });
    await seedMarker(tenants['a cancelled marker'], { state: 'cancelled', due: true });
    await seedMarker(tenants['a purged marker'], {
      state: 'purged',
      due: true,
      catalogPurged: true,
      authPurged: true,
    });
    for (const tenantId of Object.values(tenants)) {
      await seedTenantData(tenantId);
    }

    const purge = await purgePool();
    for (const [label, tenantId] of Object.entries(tenants)) {
      for (const table of DELETE_ORDER) {
        const read = await attempt(
          purge,
          {},
          `select count(*)::int as count from ${table} where tenant_id = $1`,
          [tenantId],
        );
        expect(read, `${label}: ${table} reads no row`).toMatchObject({
          code: undefined,
          rows: [{ count: 0 }],
        });

        const deleted = await attempt(purge, {}, `delete from ${table} where tenant_id = $1`, [
          tenantId,
        ]);
        expectRefused(deleted, `${label}: delete from ${table}`);
      }
      await expectSeededRowsIntact(tenantId, label);
    }
  });

  it("a due tenant's change events and revocation rows are read, counted and deleted by tayzu_purge", async () => {
    const due = newTenantId();
    const notDue = newTenantId();
    await seedMarker(due, { state: 'pending', due: true });
    await seedTenantData(due);
    await seedTenantData(notDue);

    const purge = await purgePool();
    const counted = await transaction(purge, {}, async (client) => {
      const events = await client.query<{ count: number }>(
        'select count(*)::int as count from catalog_change_event where tenant_id = $1',
        [due],
      );
      const revocations = await client.query<{ count: number }>(
        'select count(*)::int as count from machine_credential_revocation where tenant_id = $1',
        [due],
      );
      // Both tenants named: the policy, not the WHERE clause, keeps the
      // tenant without a due marker out.
      const deletedEvents = await client.query(
        'delete from catalog_change_event where tenant_id = any($1::text[])',
        [[due, notDue]],
      );
      const deletedRevocations = await client.query(
        'delete from machine_credential_revocation where tenant_id = any($1::text[])',
        [[due, notDue]],
      );
      return {
        events: events.rows[0]?.count,
        revocations: revocations.rows[0]?.count,
        deletedEvents: deletedEvents.rowCount,
        deletedRevocations: deletedRevocations.rowCount,
      };
    });

    expect(counted).toEqual({
      events: SEEDED.catalog_change_event,
      revocations: SEEDED.machine_credential_revocation,
      deletedEvents: SEEDED.catalog_change_event,
      deletedRevocations: SEEDED.machine_credential_revocation,
    });
    expect(await ownerCount('catalog_change_event', due)).toBe(0);
    expect(await ownerCount('machine_credential_revocation', due)).toBe(0);
    await expectSeededRowsIntact(notDue, 'tenant without a due marker');
  });

  it("tayzu_purge reads and deletes a due tenant's rows on each of the seven tables", async () => {
    const due = newTenantId();
    await seedMarker(due, { state: 'pending', due: true });
    await seedTenantData(due);

    const purge = await purgePool();
    const result = await transaction(purge, {}, async (client) => {
      const outcome: Record<string, { read: number | undefined; deleted: number | null }> = {};
      for (const table of DELETE_ORDER) {
        const read = await client.query<{ count: number }>(
          `select count(*)::int as count from ${table} where tenant_id = $1`,
          [due],
        );
        const deleted = await client.query(`delete from ${table} where tenant_id = $1`, [due]);
        outcome[table] = { read: read.rows[0]?.count, deleted: deleted.rowCount };
      }
      return outcome;
    });

    for (const table of TENANT_TABLES) {
      expect(result[table], table).toEqual({ read: SEEDED[table], deleted: SEEDED[table] });
      expect(await ownerCount(table, due), `${table} is empty for the due tenant`).toBe(0);
    }
  });

  it('a direct DELETE by tayzu_app, by the table owner and by tayzu_purge outside a due tenant is still refused by the trigger or the policy, on each of the seven tables', async () => {
    const due = newTenantId();
    const notDue = newTenantId();
    await seedMarker(due, { state: 'pending', due: true });
    await seedTenantData(due);
    await seedTenantData(notDue);

    const owner = await getOwnerPool();
    const ownership = await owner.query<{ relname: string; owner: string }>(
      `select c.relname::text as relname, pg_get_userbyid(c.relowner)::text as owner
         from pg_class c
        where c.relnamespace = 'public'::regnamespace and c.relname = any($1::text[])
        order by c.relname`,
      [[...TENANT_TABLES]],
    );
    expect(ownership.rows, 'tayzu_migrator owns the seven tables').toEqual(
      [...TENANT_TABLES].sort().map((relname) => ({ relname, owner: MIGRATOR_ROLE })),
    );

    const app = await appPool();
    const purge = await purgePool();
    for (const table of DELETE_ORDER) {
      const statement = `delete from ${table} where tenant_id = $1`;

      expectRefused(
        await attempt(app, { tenantId: newTenantId() }, statement, [due]),
        `tayzu_app (another tenant) on ${table}`,
      );
      expectRefused(
        await attempt(owner, { asMigrator: true }, statement, [due]),
        `the table owner on ${table}`,
      );
      expectRefused(
        await attempt(purge, {}, statement, [notDue]),
        `tayzu_purge outside a due tenant on ${table}`,
      );
    }

    // The append-only rows stay out of reach of tayzu_app in its own tenant
    // too, and the trigger refuses the owner's privileges even with row-level
    // security bypassed (the raw DATABASE_URL role).
    for (const table of ['catalog_change_event', 'machine_credential_revocation'] as const) {
      const statement = `delete from ${table} where tenant_id = $1`;
      const own = await attempt(app, { tenantId: due }, statement, [due]);
      expect(own.code, `tayzu_app in its own tenant on ${table}`).toBe('42501');
    }
    const bypassing = await attempt(
      owner,
      {},
      'delete from catalog_change_event where tenant_id = $1',
      [due],
    );
    expect(bypassing.code, 'the append-only trigger refuses the owner').toBe('P0001');

    await expectSeededRowsIntact(due, 'due tenant');
    await expectSeededRowsIntact(notDue, 'tenant without a due marker');
  });

  it('no role can SET ROLE tayzu_purge: tayzu_app, tayzu_auth, tayzu_migrator and tayzu_deletion_admin hold neither SET nor INHERIT on it', async () => {
    await expectRoleExists(PURGE_ROLE);
    await expectRoleExists(DELETION_ADMIN_ROLE);
    const owner = await getOwnerPool();
    for (const role of NON_PURGE_ROLES) {
      const { rows } = await owner.query<{ can_set: boolean; can_inherit: boolean }>(
        `select pg_has_role($1, $2, 'SET') as can_set, pg_has_role($1, $2, 'USAGE') as can_inherit`,
        [role, PURGE_ROLE],
      );
      expect(rows, `${role} cannot SET ROLE ${PURGE_ROLE}`).toEqual([
        { can_set: false, can_inherit: false },
      ]);
    }
  });

  it('every pg_auth_members row granting tayzu_purge to one of those four roles has set_option and inherit_option false', async () => {
    await expectRoleExists(PURGE_ROLE);
    const owner = await getOwnerPool();
    const { rows } = await owner.query<{
      member: string;
      set_option: boolean;
      inherit_option: boolean;
    }>(
      `select m.rolname::text as member, am.set_option, am.inherit_option
         from pg_auth_members am
         join pg_roles r on r.oid = am.roleid
         join pg_roles m on m.oid = am.member
        where r.rolname = $1 and m.rolname = any($2::text[])
        order by m.rolname`,
      [PURGE_ROLE, NON_PURGE_ROLES],
    );
    for (const row of rows) {
      expect(row, `membership of ${row.member}`).toEqual({
        member: row.member,
        set_option: false,
        inherit_option: false,
      });
    }
  });

  it('tayzu_purge owns no object', async () => {
    await expectRoleExists(PURGE_ROLE);
    const owner = await getOwnerPool();
    const { rows } = await owner.query<{ owned: number }>(
      `select (select count(*) from pg_shdepend
                where refclassid = 'pg_authid'::regclass
                  and refobjid = $1::regrole and deptype = 'o')::int
            + (select count(*) from pg_class where relowner = $1::regrole)::int
            + (select count(*) from pg_proc where proowner = $1::regrole)::int
            + (select count(*) from pg_namespace where nspowner = $1::regrole)::int
            + (select count(*) from pg_type where typowner = $1::regrole)::int as owned`,
      [PURGE_ROLE],
    );
    expect(rows).toEqual([{ owned: 0 }]);
  });

  it('tayzu_purge records the progress of a due marker and its purged state, and nothing else', async () => {
    await expectRoleExists(PURGE_ROLE);
    expect(await tablePrivileges(PURGE_ROLE, MARKER), 'table-level privileges').toEqual(['SELECT']);
    expect(await markerColumnsWith(PURGE_ROLE, 'UPDATE'), 'updatable columns').toEqual([
      'auth_purged_at',
      'catalog_purged_at',
      'state',
    ]);

    const due = newTenantId();
    const otherDue = newTenantId();
    const notYetDue = newTenantId();
    await seedMarker(due, { state: 'pending', due: true });
    await seedMarker(otherDue, { state: 'pending', due: true });
    await seedMarker(notYetDue, { state: 'pending', due: false });
    const purge = await purgePool();

    const step1 = await attempt(
      purge,
      {},
      'update tenant_deletion_marker set catalog_purged_at = now() where tenant_id = $1',
      [due],
    );
    expect(step1, 'step 1 recorded').toMatchObject({ code: undefined, rowCount: 1 });
    const step2 = await attempt(
      purge,
      {},
      `update tenant_deletion_marker set auth_purged_at = now(), state = 'purged' where tenant_id = $1`,
      [due],
    );
    expect(step2, 'step 2 and the purged state recorded').toMatchObject({
      code: undefined,
      rowCount: 1,
    });
    expect(await ownerMarkers(due)).toMatchObject([
      { state: 'purged', catalog_purged: true, auth_purged: true },
    ]);

    expectRefused(
      await attempt(
        purge,
        {},
        `update tenant_deletion_marker set state = 'cancelled' where tenant_id = $1`,
        [otherDue],
      ),
      'a state other than purged',
    );
    const movedDate = await attempt(
      purge,
      {},
      `update tenant_deletion_marker set purge_after = purge_after + interval '1 day' where tenant_id = $1`,
      [otherDue],
    );
    expect(movedDate.code, 'purge_after is not updatable').toBe('42501');
    expectRefused(
      await attempt(
        purge,
        {},
        'update tenant_deletion_marker set catalog_purged_at = now() where tenant_id = $1',
        [notYetDue],
      ),
      'a marker that is not due',
    );
    expect(await ownerMarkers(otherDue)).toMatchObject([
      { state: 'pending', catalog_purged: false, purge_after_kept: true },
    ]);
    expect(await ownerMarkers(notYetDue)).toMatchObject([
      { state: 'pending', catalog_purged: false },
    ]);
  });
});

describe('tayzu_deletion_admin, the reversal role (migration 0013, task 2.2, Q35)', () => {
  const tombstone = `update tenant_deletion_marker
       set state = 'cancelled', cancelled_at = now(), cancelled_by = $2
     where tenant_id = $1 and state = 'pending'
     returning tenant_id, state::text as state, cancelled_by`;

  it('tayzu_deletion_admin exists, can log in, has USAGE on public, and has no superuser, BYPASSRLS, CREATEROLE or CREATEDB attribute', async () => {
    await expectRoleExists(DELETION_ADMIN_ROLE);
    const owner = await getOwnerPool();
    const { rows } = await owner.query(
      `select rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb,
              has_schema_privilege(rolname, 'public', 'USAGE') as public_usage
         from pg_roles where rolname = $1`,
      [DELETION_ADMIN_ROLE],
    );
    expect(rows).toEqual([
      {
        rolcanlogin: true,
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
        public_usage: true,
      },
    ]);
  });

  it('tayzu_deletion_admin can tombstone a pending marker with no purge step and a future date (UPDATE ... WHERE ... RETURNING)', async () => {
    const tenantId = newTenantId();
    const operatorId = 'gh:4242';
    await seedMarker(tenantId, { state: 'pending', due: false });
    const admin = await deletionAdminPool();

    const outcome = await attempt(admin, {}, tombstone, [tenantId, operatorId]);
    expect(outcome).toMatchObject({
      code: undefined,
      rowCount: 1,
      rows: [{ tenant_id: tenantId, state: 'cancelled', cancelled_by: operatorId }],
    });
    expect(await ownerMarkers(tenantId)).toMatchObject([
      { state: 'cancelled', cancelled: true, cancelled_by: operatorId, purge_after_kept: true },
    ]);
  });

  it.each([
    { step: 'catalog_purged_at', seed: { catalogPurged: true } },
    { step: 'auth_purged_at', seed: { authPurged: true } },
  ])(
    'tayzu_deletion_admin cannot tombstone a marker once a purge step ($step) is recorded',
    async ({ seed }) => {
      const tenantId = newTenantId();
      await seedMarker(tenantId, { state: 'pending', due: false, ...seed });
      const admin = await deletionAdminPool();

      expectRefused(await attempt(admin, {}, tombstone, [tenantId, 'gh:4242']), 'tombstone');
      expect(await ownerMarkers(tenantId)).toMatchObject([
        { state: 'pending', cancelled: false, cancelled_by: null },
      ]);
    },
  );

  it('tayzu_deletion_admin cannot tombstone a marker whose purge date has passed', async () => {
    const tenantId = newTenantId();
    await seedMarker(tenantId, { state: 'pending', due: true });
    const admin = await deletionAdminPool();

    expectRefused(await attempt(admin, {}, tombstone, [tenantId, 'gh:4242']), 'tombstone');
    expect(await ownerMarkers(tenantId)).toMatchObject([
      { state: 'pending', cancelled: false, cancelled_by: null },
    ]);
  });

  it('tayzu_deletion_admin reads no marker other than a pending one with no recorded step and a future date', async () => {
    const eligible = newTenantId();
    const stepOne = newTenantId();
    const stepTwo = newTenantId();
    const pastDue = newTenantId();
    const cancelled = newTenantId();
    const purged = newTenantId();
    await seedMarker(eligible, { state: 'pending', due: false });
    await seedMarker(stepOne, { state: 'pending', due: false, catalogPurged: true });
    await seedMarker(stepTwo, { state: 'pending', due: false, authPurged: true });
    await seedMarker(pastDue, { state: 'pending', due: true });
    await seedMarker(cancelled, { state: 'cancelled', due: false });
    await seedMarker(purged, { state: 'purged', due: true, catalogPurged: true, authPurged: true });
    const admin = await deletionAdminPool();

    const read = await admin.query<{ tenant_id: string }>(
      'select tenant_id from tenant_deletion_marker where tenant_id = any($1::text[])',
      [[eligible, stepOne, stepTwo, pastDue, cancelled, purged]],
    );
    expect(read.rows).toEqual([{ tenant_id: eligible }]);

    const outside = await admin.query<{ count: number }>(
      `select count(*)::int as count from tenant_deletion_marker
        where not (state = 'pending' and catalog_purged_at is null and auth_purged_at is null
                   and purge_after > now())`,
    );
    expect(outside.rows).toEqual([{ count: 0 }]);
  });

  it('tayzu_deletion_admin can change only state, cancelled_at and cancelled_by, only to a tombstone, and cannot insert or delete a marker', async () => {
    await expectRoleExists(DELETION_ADMIN_ROLE);
    expect(await tablePrivileges(DELETION_ADMIN_ROLE, MARKER), 'table-level privileges').toEqual([
      'SELECT',
    ]);
    expect(await markerColumnsWith(DELETION_ADMIN_ROLE, 'UPDATE'), 'updatable columns').toEqual([
      'cancelled_at',
      'cancelled_by',
      'state',
    ]);
    expect(await markerColumnsWith(DELETION_ADMIN_ROLE, 'INSERT'), 'insertable columns').toEqual(
      [],
    );

    const tenantId = newTenantId();
    await seedMarker(tenantId, { state: 'pending', due: false });
    const admin = await deletionAdminPool();

    expectRefused(
      await attempt(
        admin,
        {},
        `update tenant_deletion_marker set state = 'purged' where tenant_id = $1`,
        [tenantId],
      ),
      'a state other than cancelled',
    );
    const movedDate = await attempt(
      admin,
      {},
      `update tenant_deletion_marker set purge_after = purge_after + interval '1 day' where tenant_id = $1`,
      [tenantId],
    );
    expect(movedDate.code, 'purge_after is not updatable').toBe('42501');
    const deleted = await attempt(
      admin,
      {},
      'delete from tenant_deletion_marker where tenant_id = $1',
      [tenantId],
    );
    expect(deleted.code, 'DELETE is not granted').toBe('42501');
    expect(await ownerMarkers(tenantId)).toMatchObject([
      { state: 'pending', cancelled: false, purge_after_kept: true },
    ]);
  });

  it('tayzu_deletion_admin cannot read or delete tenant data', async () => {
    const due = newTenantId();
    await seedMarker(due, { state: 'pending', due: true });
    await seedTenantData(due);
    const admin = await deletionAdminPool();

    for (const table of DELETE_ORDER) {
      expect(await tablePrivileges(DELETION_ADMIN_ROLE, table), table).toEqual([]);
      const read = await attempt(admin, {}, `select count(*)::int as count from ${table}`);
      expect(read.code, `select from ${table}`).toBe('42501');
      const deleted = await attempt(admin, {}, `delete from ${table} where tenant_id = $1`, [due]);
      expect(deleted.code, `delete from ${table}`).toBe('42501');
    }
    await expectSeededRowsIntact(due, 'due tenant');
  });

  it('tayzu_deletion_admin has no USAGE on the auth schema', async () => {
    await expectRoleExists(DELETION_ADMIN_ROLE);
    const owner = await getOwnerPool();
    const { rows } = await owner.query<{ usage: boolean }>(
      `select has_schema_privilege($1, 'auth', 'USAGE') as usage`,
      [DELETION_ADMIN_ROLE],
    );
    expect(rows).toEqual([{ usage: false }]);
  });
});

describe('functions of migration 0013 (task 2.2, Q48)', () => {
  it('the migration creates no SECURITY DEFINER function', async () => {
    await expectRoleExists(PURGE_ROLE);
    await expectRoleExists(DELETION_ADMIN_ROLE);
    const owner = await getOwnerPool();
    const { rows } = await owner.query<{ name: string }>(
      `select n.nspname || '.' || p.proname as name
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where p.prosecdef
          and n.nspname not in ('pg_catalog', 'information_schema')
          and n.nspname not like 'pg\\_%'`,
    );
    expect(rows).toEqual([]);
  });
});
