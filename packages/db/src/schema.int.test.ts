/**
 * Integration tests for the migrated database *shape*: Postgres schemas,
 * roles and grants (task 2.2, design D2/D6, Migration Plan step 1).
 *
 * This file is shared with task 6.1's later cycle, which extends it with
 * `pg_policy`/RLS assertions for catalog tables (design D6, Migration Plan
 * step 2). This first cycle (2.2) only covers:
 *
 * - Every Better Auth table (organization, admin, two-factor, jwt and
 *   apiKey plugins, as registered in `packages/auth/src/auth.ts`, task 2.1)
 *   lives under Postgres schema `auth`, none in `public` or anywhere else.
 * - Role `tayzu_auth` exists.
 * - `tayzu_auth` has full CRUD (`SELECT`/`INSERT`/`UPDATE`/`DELETE`) on every
 *   one of those `auth`-schema tables.
 * - `tayzu_auth` has zero privileges on every `catalog_*` relation (design
 *   D6: "nothing; full CRUD on `auth`-schema tables only, no grants on any
 *   `catalog_*` table").
 *
 * The Better Auth table names below are the actual physical table names
 * `@better-auth/drizzle-adapter@1.7.6` generates for the plugin set
 * `packages/auth/src/auth.ts` registers (`organization`, `admin`,
 * `twoFactor`, `jwt`, `apiKey`), verified against that package's installed
 * source (`generateDrizzleSchema`'s `convertToSnakeCase(modelName,
 * camelCase)`, where `camelCase` is the drizzle-adapter config's own
 * `camelCase` option): `packages/auth/src/auth.ts` never sets `camelCase`,
 * so it defaults to falsy and every generated model name is converted to
 * snake_case, matching this project's existing snake_case convention
 * (`packages/db/migrations/0000_catalog_core.sql`). `getAuthTables` (from
 * `@better-auth/core/db`, called with the same plugin list) was used to
 * confirm the exact model-name set the plugins above produce: `user`,
 * `session`, `account`, `verification`, `organization`, `member`,
 * `invitation`, `twoFactor`, `jwks`, `apikey` — `twoFactor` is the only name
 * `convertToSnakeCase` changes, to `two_factor`. This does not depend on the
 * `rateLimit` plugin option (design D20, task 2.5's own migration
 * extension), which `packages/auth/src/auth.ts` does not configure yet.
 *
 * Uses a fresh, private scratch database (not the shared `DATABASE_URL`
 * database every other integration test in this run shares), migrated from
 * empty, so this test observes exactly what the shipped migrations create —
 * the same scratch-database pattern `harness.int.test.ts` already
 * establishes for this package.
 */
import { randomUUID } from 'node:crypto';

import { Client, escapeIdentifier, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from './index.js';

/**
 * The physical table names `@better-auth/drizzle-adapter` generates, in
 * schema `auth`, for the plugin set `packages/auth/src/auth.ts` registers.
 * See the file-level comment for how this list was verified.
 */
const AUTH_TABLE_NAMES = [
  'user',
  'session',
  'account',
  'verification',
  'organization',
  'member',
  'invitation',
  'two_factor',
  'jwks',
  'apikey',
] as const;

const AUTH_SCHEMA = 'auth';
const AUTH_ROLE = 'tayzu_auth';

const CRUD_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const;

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
 * `harness.int.test.ts` documents).
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

describe('the migrated database shape (task 2.2, design D2/D6)', () => {
  let pool: Pool;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ pool, cleanup } = await createMigratedScratchDatabase());
  }, 60_000);

  afterAll(async () => {
    await cleanup();
  });

  it('every Better Auth table lives under schema `auth`, none in `public` or elsewhere', async () => {
    const { rows } = await pool.query<{ schema: string; table: string }>(
      `select table_schema as schema, table_name as table
         from information_schema.tables
        where table_name = any($1)
        order by table_schema, table_name`,
      [AUTH_TABLE_NAMES],
    );

    const tablesBySchema = new Map<string, string[]>();
    for (const { schema, table } of rows) {
      const tables = tablesBySchema.get(schema) ?? [];
      tables.push(table);
      tablesBySchema.set(schema, tables);
    }

    expect(
      [...(tablesBySchema.get(AUTH_SCHEMA) ?? [])].sort(),
      `schema "${AUTH_SCHEMA}" holds every Better Auth table the organization/admin/two-factor/jwt/apiKey plugins register (packages/auth/src/auth.ts)`,
    ).toEqual([...AUTH_TABLE_NAMES].sort());

    for (const [schema, tables] of tablesBySchema) {
      if (schema === AUTH_SCHEMA) {
        continue;
      }
      expect(
        tables,
        `no Better Auth table lives outside schema "${AUTH_SCHEMA}" (found in "${schema}")`,
      ).toEqual([]);
    }
  });

  it('role `tayzu_auth` exists', async () => {
    const { rows } = await pool.query<{ rolname: string }>(
      'select rolname from pg_roles where rolname = $1',
      [AUTH_ROLE],
    );

    expect(
      rows,
      `role "${AUTH_ROLE}" is created by the hand-written custom SQL migration (design D6, Migration Plan step 1)`,
    ).toEqual([{ rolname: AUTH_ROLE }]);
  });

  it('`tayzu_auth` has full CRUD on every Better Auth table', async () => {
    for (const table of AUTH_TABLE_NAMES) {
      for (const privilege of CRUD_PRIVILEGES) {
        const qualified = `${AUTH_SCHEMA}.${table}`;
        const { rows } = await pool.query<{ granted: boolean }>(
          'select has_table_privilege($1, $2, $3) as granted',
          [AUTH_ROLE, qualified, privilege],
        );
        expect(rows[0]?.granted, `"${AUTH_ROLE}" has ${privilege} on "${qualified}"`).toBe(true);
      }
    }
  });

  it('`tayzu_auth` has zero privileges on every `catalog_*` relation', async () => {
    const { rows: catalogTables } = await pool.query<{ table: string }>(
      `select table_name as table
         from information_schema.tables
        where table_schema = 'public'
          and table_name like 'catalog\\_%' escape '\\'
        order by table_name`,
    );

    expect(
      catalogTables.length,
      'catalog tables exist (shipped by 001-catalog-core) to check tayzu_auth has no privilege on',
    ).toBeGreaterThan(0);

    for (const { table } of catalogTables) {
      for (const privilege of ALL_TABLE_PRIVILEGES) {
        const { rows } = await pool.query<{ granted: boolean }>(
          'select has_table_privilege($1, $2, $3) as granted',
          [AUTH_ROLE, table, privilege],
        );
        expect(rows[0]?.granted, `"${AUTH_ROLE}" has no ${privilege} grant on "${table}"`).toBe(
          false,
        );
      }
    }
  });
});
