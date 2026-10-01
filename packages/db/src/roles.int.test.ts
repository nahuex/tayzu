/**
 * Integration test for task 6.2 (design D6, Migration Plan step 2): the
 * hand-written custom SQL migration creating `CREATE ROLE tayzu_migrator`/
 * `tayzu_app` where not already infrastructure-provisioned, granting
 * `tayzu_app` its runtime privileges on every catalog table
 * (`packages/catalog/src/persistence/schema.ts`), revoking `UPDATE`,
 * `DELETE` and `TRUNCATE` on `catalog_change_event` specifically, and
 * `FORCE ROW LEVEL SECURITY` on every catalog table.
 *
 * Scope, matching the task's own Verify clause exactly ("asserts the exact
 * grants and the FORCE flag via information_schema/pg_catalog"):
 *
 * - Roles `tayzu_migrator` and `tayzu_app` exist (a grant test that named a
 *   role Postgres does not have would itself raise, not merely fail an
 *   assertion, so existence is checked first and separately, the same
 *   pattern `schema.int.test.ts` already uses for `tayzu_auth`).
 * - `tayzu_app` holds exactly `SELECT`/`INSERT`/`UPDATE`/`DELETE` on every
 *   catalog table except `catalog_change_event` (design D6's table: "nothing;
 *   SELECT/INSERT/UPDATE/DELETE on catalog tables only... SELECT/INSERT only
 *   on catalog_change_event") — never `TRUNCATE`, `REFERENCES` or `TRIGGER`.
 * - `tayzu_app` holds exactly `SELECT`/`INSERT` on `catalog_change_event`:
 *   `UPDATE`, `DELETE` and `TRUNCATE` are revoked (spec, "Tenant isolation is
 *   enforced by the database independent of application code": "MUST NOT
 *   hold UPDATE, DELETE, or TRUNCATE on catalog_change_event").
 * - Every catalog table has `FORCE ROW LEVEL SECURITY` enabled
 *   (`pg_class.relforcerowsecurity`), not only `ENABLE ROW LEVEL SECURITY`
 *   (task 6.1's own migration, 0006, already sets `ENABLE`; task 6.2 adds
 *   `FORCE` on top of it).
 *
 * Ownership (`MUST NOT own the tables it operates on`) and the
 * bypass-RLS/negative-control assertions belong to task 6.4's extended
 * `db-isolation.int.test.ts`, not here.
 *
 * Red-phase note: today, `pnpm --filter @tayzu/db exec vitest run
 * src/schema.int.test.ts` already fails while *applying* migration
 * `0006_catalog_tenant_isolation_rls.sql` to a fresh database, with Postgres
 * error 42704 "role \"tayzu_app\" does not exist" — 0006's `CREATE POLICY
 * ... TO "tayzu_app"` needs that role to exist already, and nothing before
 * it creates it. This file's `beforeAll` runs the exact same migration
 * sequence (`runMigrations` against a fresh scratch database), so it fails
 * for that identical reason: the migration this task adds (creating
 * `tayzu_migrator`/`tayzu_app` and granting `tayzu_app`) does not exist yet.
 * That is the missing behavior this task's red phase is expected to show,
 * not a broken test or fixture.
 *
 * Uses its own private scratch database (not the shared `DATABASE_URL`
 * database other integration tests in this run share), migrated from empty,
 * copying `schema.int.test.ts`'s scratch-database helper (that file is
 * shared with, and extended by, task 6.1's own cycle, so this task gets its
 * own file and its own copy of the helper rather than adding to it).
 */
import { randomUUID } from 'node:crypto';

import { Client, escapeIdentifier, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from './index.js';

/** Every catalog table `packages/catalog/src/persistence/schema.ts` defines. */
const CATALOG_TABLES = [
  'catalog_blueprint',
  'catalog_change_event',
  'catalog_entity',
  'catalog_entity_relation',
  'catalog_relation_definition',
  'catalog_tenant_sequence',
] as const;

const CHANGE_EVENT_TABLE = 'catalog_change_event';

const MIGRATOR_ROLE = 'tayzu_migrator';
const APP_ROLE = 'tayzu_app';

/** Every privilege `has_table_privilege` recognizes for an ordinary table. */
const ALL_TABLE_PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
] as const;

/** `tayzu_app`'s exact privileges on every catalog table except `catalog_change_event`. */
const CRUD_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const;

/** `tayzu_app`'s exact privileges on `catalog_change_event` (append-only). */
const APPEND_ONLY_PRIVILEGES = ['SELECT', 'INSERT'] as const;

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim() === '') {
    throw new Error(
      'DATABASE_URL is not set: the int project global setup should have stopped this run.',
    );
  }
  return url;
}

/** `DATABASE_URL` with its database replaced by `name`. */
function scratchDatabaseUrl(name: string): string {
  const url = new URL(databaseUrl());
  url.pathname = `/${name}`;
  url.searchParams.delete('database');
  url.searchParams.delete('dbname');
  url.hash = '';
  return url.href;
}

async function endQuietly(closeable: {
  on(event: 'error', listener: (error: unknown) => void): unknown;
  end(): Promise<void>;
}): Promise<void> {
  closeable.on('error', () => {
    // Expected only during teardown; nothing left to report it to.
  });
  await closeable.end();
}

async function dropScratchDatabase(admin: Client, name: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const { rows } = await admin.query<{ sessions: number }>(
      'select count(*)::int as sessions from pg_stat_activity where datname = $1',
      [name],
    );
    if (rows[0]?.sessions === 0 || Date.now() > deadline) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await admin.query(`drop database if exists ${escapeIdentifier(name)} with (force)`);
}

/**
 * Creates a private, empty scratch database, migrates it, hands back a pool
 * connected to it, and returns a cleanup function that closes the pool and
 * drops the database. The scratch database is created through the
 * `DATABASE_URL` role, which therefore needs the `CREATEDB` privilege (true
 * of the CI `postgres:16` service's superuser, same precondition
 * `harness.int.test.ts` and `schema.int.test.ts` document).
 */
async function createMigratedScratchDatabase(): Promise<{
  pool: Pool;
  cleanup: () => Promise<void>;
}> {
  const admin = new Client({ connectionString: databaseUrl() });
  await admin.connect();

  const privilege = await admin.query<{ allowed: boolean }>(
    'select rolcreatedb or rolsuper as allowed from pg_roles where rolname = current_user',
  );
  if (privilege.rows[0]?.allowed !== true) {
    await endQuietly(admin);
    throw new Error(
      'The DATABASE_URL role needs the CREATEDB privilege: this test creates, and then drops, a private scratch database.',
    );
  }

  const name = `tayzu_scratch_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`create database ${escapeIdentifier(name)}`);

  const url = scratchDatabaseUrl(name);
  const pool = new Pool({ connectionString: url });
  await runMigrations(pool);

  const cleanup = async (): Promise<void> => {
    await endQuietly(pool);
    await dropScratchDatabase(admin, name);
    await endQuietly(admin);
  };

  return { pool, cleanup };
}

/** The exact set of `ALL_TABLE_PRIVILEGES` that `role` holds on `table`. */
async function grantedPrivileges(pool: Pool, role: string, table: string): Promise<string[]> {
  const granted: string[] = [];
  for (const privilege of ALL_TABLE_PRIVILEGES) {
    const { rows } = await pool.query<{ granted: boolean }>(
      'select has_table_privilege($1, $2, $3) as granted',
      [role, table, privilege],
    );
    if (rows[0]?.granted === true) {
      granted.push(privilege);
    }
  }
  return granted.sort();
}

describe('Postgres roles and grants for catalog tables (task 6.2, design D6)', () => {
  let pool: Pool;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ pool, cleanup } = await createMigratedScratchDatabase());
  }, 60_000);

  afterAll(async () => {
    await cleanup();
  });

  it(`role \`${MIGRATOR_ROLE}\` exists`, async () => {
    const { rows } = await pool.query<{ rolname: string }>(
      'select rolname from pg_roles where rolname = $1',
      [MIGRATOR_ROLE],
    );

    expect(
      rows,
      `role "${MIGRATOR_ROLE}" is created by the hand-written custom SQL migration (design D6, Migration Plan step 2)`,
    ).toEqual([{ rolname: MIGRATOR_ROLE }]);
  });

  it(`role \`${APP_ROLE}\` exists`, async () => {
    const { rows } = await pool.query<{ rolname: string }>(
      'select rolname from pg_roles where rolname = $1',
      [APP_ROLE],
    );

    expect(
      rows,
      `role "${APP_ROLE}" is created by the hand-written custom SQL migration (design D6, Migration Plan step 2)`,
    ).toEqual([{ rolname: APP_ROLE }]);
  });

  it(`\`${APP_ROLE}\` has exactly SELECT, INSERT, UPDATE, DELETE on every catalog table except \`${CHANGE_EVENT_TABLE}\``, async () => {
    for (const table of CATALOG_TABLES) {
      if (table === CHANGE_EVENT_TABLE) {
        continue;
      }
      const granted = await grantedPrivileges(pool, APP_ROLE, table);
      expect(granted, `exact privileges of "${APP_ROLE}" on "${table}"`).toEqual(
        [...CRUD_PRIVILEGES].sort(),
      );
    }
  });

  it(`\`${APP_ROLE}\` has exactly SELECT, INSERT on \`${CHANGE_EVENT_TABLE}\` (UPDATE, DELETE, TRUNCATE revoked)`, async () => {
    const granted = await grantedPrivileges(pool, APP_ROLE, CHANGE_EVENT_TABLE);

    expect(granted, `exact privileges of "${APP_ROLE}" on "${CHANGE_EVENT_TABLE}"`).toEqual(
      [...APPEND_ONLY_PRIVILEGES].sort(),
    );
  });

  it('every catalog table has FORCE ROW LEVEL SECURITY enabled', async () => {
    for (const table of CATALOG_TABLES) {
      const { rows } = await pool.query<{ forced: boolean | null }>(
        `select relforcerowsecurity as forced
           from pg_class
          where relname = $1
            and relnamespace = 'public'::regnamespace`,
        [table],
      );

      expect(rows.length, `"${table}" exists in pg_class`).toBe(1);
      expect(rows[0]?.forced, `"${table}" has FORCE ROW LEVEL SECURITY enabled`).toBe(true);
    }
  });
});
