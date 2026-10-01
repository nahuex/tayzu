/**
 * Integration test for task 5.5 (design D21, Migration Plan step 3): the
 * migration creating `machine_credential_revocation` (`credential_id`,
 * `revoked_at`, `tenant_id`), with the same `tenant_isolation` `pgPolicy` /
 * `FORCE ROW LEVEL SECURITY` treatment as every catalog table
 * (`packages/catalog/src/persistence/schema.ts`).
 *
 * Scope, matching the task's own Verify clause exactly ("asserts the table,
 * its policy, and the FORCE flag via pg_policy/information_schema"):
 *
 * - The table exists in the `public` schema with exactly the three columns
 *   design D21 names (`credential_id`, `revoked_at`, `tenant_id`), matching
 *   how `schema.int.test.ts` asserts an exact column set for a table whose
 *   design entry spells out the complete column list.
 * - `ENABLE ROW LEVEL SECURITY` is set (the Drizzle-generated half of the
 *   migration, matching every catalog table's own `tenant_isolation` policy
 *   pattern in `schema.ts`).
 * - A permissive `tenant_isolation` policy, `for: 'all'`, scoped to
 *   `tayzu_app`, whose `USING`/`WITH CHECK` clauses both compare `tenant_id`
 *   to the session-local `current_setting('app.tenant_id', true)` — the
 *   exact same pattern `schema.int.test.ts` asserts for every existing
 *   catalog table.
 * - `FORCE ROW LEVEL SECURITY` is enabled (`pg_class.relforcerowsecurity`),
 *   the hand-written custom-SQL half of the migration (task 6.2's own
 *   `roles.int.test.ts` asserts the identical flag, the same way, for every
 *   existing catalog table).
 *
 * Explicit grants to `tayzu_app` are part of the same hand-written migration
 * (design D21, this task's own description) but are not named in this task's
 * Verify clause, so they are not asserted here — the same split
 * `schema.int.test.ts` (task 6.1, RLS-enable/policy only) and
 * `roles.int.test.ts` (task 6.2, grants/FORCE) already use for every other
 * catalog table.
 *
 * Red-phase expectation: `packages/db/migrations/` ships no migration for
 * `machine_credential_revocation` yet, so every assertion below fails
 * because the table does not exist, not because of a bug in this test —
 * the identical "missing migration" red-phase shape `schema.int.test.ts` and
 * `roles.int.test.ts` document for their own tasks.
 *
 * Uses its own private scratch database, migrated from empty, following the
 * same pattern `schema.int.test.ts` and `roles.int.test.ts` already use (each
 * task gets its own copy of the scratch-database helper rather than sharing
 * one, per `roles.int.test.ts`'s own note).
 */
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { runMigrations } from '@tayzu/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TABLE = 'machine_credential_revocation';

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim() === '') {
    throw new Error(
      'DATABASE_URL is not set: the int project global setup should have stopped this run.',
    );
  }
  return url;
}

function connect(url: string) {
  return drizzle(url);
}

type Db = ReturnType<typeof connect>;

function scratchDatabaseUrl(name: string): string {
  const url = new URL(databaseUrl());
  url.pathname = `/${name}`;
  return url.href;
}

const SCRATCH_NAME_PATTERN = /^[a-z0-9_]+$/;

function scratchDatabaseName(): string {
  const name = `tayzu_revocation_schema_${randomUUID().replaceAll('-', '')}`;
  if (!SCRATCH_NAME_PATTERN.test(name)) {
    // Defensive: never interpolate a database name that is not restricted to
    // this safe character set into DDL text.
    throw new Error(`generated scratch database name is unsafe: ${name}`);
  }
  return name;
}

/**
 * A pool or client whose `.on('error', ...)` and `.end()` the teardown
 * helper below needs. `drizzle(url).$client` (a `pg.Pool`) satisfies this
 * structurally.
 */
interface EndableWithErrorEvent {
  on(event: 'error', listener: (error: unknown) => void): unknown;
  end(): Promise<void>;
}

/**
 * Ends a pool or client that is about to be torn down, and only then lets
 * the caller proceed to `drop database ... with (force)` — see
 * `schema.int.test.ts`'s identical helper for the root-cause explanation
 * (a late, teardown-only 57P01 error otherwise surfaces unhandled).
 */
async function endQuietly(closeable: EndableWithErrorEvent): Promise<void> {
  closeable.on('error', () => {
    // Expected here: see the note above. Teardown has already moved on by
    // the time this can fire, so there is nothing left to report it to.
  });
  await closeable.end();
}

interface ColumnSpec {
  readonly type: string;
  readonly nullable: boolean;
}

async function readColumns(db: Db, table: string): Promise<Map<string, ColumnSpec>> {
  const result = await db.execute<{ column: string; type: string; nullable: boolean }>(sql`
    select a.attname as column,
           format_type(a.atttypid, a.atttypmod) as type,
           not a.attnotnull as nullable
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = ${table}
       and a.attnum > 0
       and not a.attisdropped
     order by a.attnum
  `);
  return new Map(
    result.rows.map((row) => [row.column, { type: row.type, nullable: row.nullable }]),
  );
}

function expectColumns(
  actual: Map<string, ColumnSpec>,
  expected: Record<string, ColumnSpec>,
): void {
  expect(new Set(actual.keys()), 'exact column set').toEqual(new Set(Object.keys(expected)));
  for (const [column, spec] of Object.entries(expected)) {
    expect(actual.get(column), `column "${column}"`).toEqual(spec);
  }
}

async function readRowSecurityEnabled(db: Db, table: string): Promise<boolean | undefined> {
  const result = await db.execute<{ enabled: boolean }>(sql`
    select relrowsecurity as enabled
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = ${table}
  `);
  return result.rows[0]?.enabled;
}

async function readRowSecurityForced(db: Db, table: string): Promise<boolean | undefined> {
  const result = await db.execute<{ forced: boolean }>(sql`
    select relforcerowsecurity as forced
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = ${table}
  `);
  return result.rows[0]?.forced;
}

type PolicyRow = {
  readonly name: string;
  readonly cmd: string;
  readonly permissive: boolean;
  readonly roles: string[] | null;
  readonly using: string | null;
  readonly withCheck: string | null;
};

// Matches `tenant_id = current_setting('app.tenant_id', true)`, tolerating an
// optional table-qualifying prefix on the column and an optional `::text`
// cast on the setting-name literal — same tolerance `schema.int.test.ts`
// applies to every other catalog table's identical policy expression.
const TENANT_ISOLATION_EXPRESSION =
  /(?:\w+\.)?tenant_id\s*=\s*current_setting\('app\.tenant_id'(?:::text)?,\s*true\)/;

async function readTenantIsolationPolicy(db: Db, table: string): Promise<PolicyRow | undefined> {
  const result = await db.execute<PolicyRow>(sql`
    select
      pol.polname as name,
      pol.polcmd as cmd,
      pol.polpermissive as permissive,
      (
        select array_agg(r.rolname order by r.rolname)
          from pg_roles r
         where r.oid = any(pol.polroles)
      ) as roles,
      pg_get_expr(pol.polqual, pol.polrelid) as using,
      pg_get_expr(pol.polwithcheck, pol.polrelid) as "withCheck"
      from pg_policy pol
      join pg_class c on c.oid = pol.polrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = ${table}
       and pol.polname = 'tenant_isolation'
  `);
  return result.rows[0];
}

describe('machine_credential_revocation migration (task 5.5, design D21)', () => {
  let admin: Db;
  let scratchName: string;
  let db: Db;

  beforeAll(async () => {
    admin = connect(databaseUrl());

    const privilege = await admin.execute<{ allowed: boolean }>(sql`
      select rolcreatedb or rolsuper as allowed from pg_roles where rolname = current_user
    `);
    if (privilege.rows[0]?.allowed !== true) {
      throw new Error(
        'The DATABASE_URL role needs the CREATEDB privilege: this test creates, and then drops, a private scratch database.',
      );
    }

    scratchName = scratchDatabaseName();
    await admin.execute(`create database ${scratchName}`);

    db = connect(scratchDatabaseUrl(scratchName));
    await runMigrations(db.$client);
  }, 60_000);

  afterAll(async () => {
    await endQuietly(db.$client);
    await admin.execute(`drop database if exists ${scratchName} with (force)`);
    await endQuietly(admin.$client);
  }, 60_000);

  it('creates machine_credential_revocation in the public schema with exactly its D21 columns', async () => {
    const exists = await db.execute<{ name: string }>(sql`
      select table_name as name
        from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE' and table_name = ${TABLE}
    `);
    expect(exists.rows, `"${TABLE}" exists as a base table in the public schema`).toEqual([
      { name: TABLE },
    ]);

    const columns = await readColumns(db, TABLE);
    expectColumns(columns, {
      credential_id: { type: 'text', nullable: false },
      revoked_at: { type: 'timestamp with time zone', nullable: false },
      tenant_id: { type: 'text', nullable: false },
    });
  });

  it(`${TABLE} has ENABLE ROW LEVEL SECURITY set`, async () => {
    const enabled = await readRowSecurityEnabled(db, TABLE);
    expect(enabled, `${TABLE} has row level security enabled`).toBe(true);
  });

  it(`${TABLE} has a permissive tenant_isolation policy, for: "all", scoped to tayzu_app`, async () => {
    const policy = await readTenantIsolationPolicy(db, TABLE);
    expect(policy, `${TABLE} has a "tenant_isolation" policy`).toBeDefined();
    if (policy === undefined) {
      return;
    }

    expect(policy.permissive, `${TABLE}'s tenant_isolation policy is permissive`).toBe(true);
    expect(
      policy.cmd,
      `${TABLE}'s tenant_isolation policy applies to every command (for: 'all')`,
    ).toBe('*');
    expect(policy.roles, `${TABLE}'s tenant_isolation policy is scoped to tayzu_app`).toEqual([
      'tayzu_app',
    ]);

    expect(policy.using, `${TABLE}'s tenant_isolation USING clause is present`).not.toBeNull();
    expect(
      policy.using,
      `${TABLE}'s tenant_isolation USING clause compares tenant_id to current_setting('app.tenant_id', true)`,
    ).toMatch(TENANT_ISOLATION_EXPRESSION);

    expect(
      policy.withCheck,
      `${TABLE}'s tenant_isolation WITH CHECK clause is present`,
    ).not.toBeNull();
    expect(
      policy.withCheck,
      `${TABLE}'s tenant_isolation WITH CHECK clause compares tenant_id to current_setting('app.tenant_id', true)`,
    ).toMatch(TENANT_ISOLATION_EXPRESSION);
  });

  it(`${TABLE} has FORCE ROW LEVEL SECURITY enabled`, async () => {
    const forced = await readRowSecurityForced(db, TABLE);
    expect(forced, `${TABLE} has FORCE ROW LEVEL SECURITY enabled`).toBe(true);
  });
});
