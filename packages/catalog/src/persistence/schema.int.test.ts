/**
 * Integration test for task 5.1 (design D4, D9, D12; Migration Plan). It
 * applies `packages/db/migrations/` to a fresh, private scratch database and
 * asserts, through `pg_catalog`/`information_schema`, that the six tables of
 * design D4 exist with the columns, keys, foreign keys (and their `ON DELETE`
 * actions), check constraints, the backward-traversal index, and the
 * append-only trigger the design describes.
 *
 * Red phase: `packages/db/migrations/` currently ships no migration (an empty
 * `meta/_journal.json`), so every assertion below fails because the tables do
 * not exist yet, not because of a bug in this test.
 *
 * ## Why this test connects the way it does
 *
 * `@tayzu/db`'s public entry point (`createPool`) always requires
 * `sslmode=verify-full` (design D5), and its test-only harness
 * (`getTestDatabase`, `src/harness.ts`) is deliberately **not** part of the
 * package's `exports` map, so another package cannot import it. This test
 * therefore builds its own local (non-TLS) connections with
 * `drizzle-orm/node-postgres`'s `drizzle(url)` overload, which creates its own
 * `pg.Pool` internally (exposed as `db.$client`) without this package ever
 * importing `pg` directly (`@tayzu/catalog` does not depend on `pg`; `pg` is
 * resolved from `@tayzu/db`'s own `node_modules`, exactly like
 * `drizzle-orm/node-postgres` itself resolves it). `db.$client` is then passed
 * to `runMigrations` from `@tayzu/db`, which is the one function this task's
 * Verify clause names.
 *
 * The scratch database is created and dropped through the `DATABASE_URL`
 * role, which has `CREATEDB` (see `packages/db/src/harness.int.test.ts`,
 * which does the same for `@tayzu/db`'s own tests). Its name is generated
 * from `randomUUID()` and restricted to `[a-z0-9_]`, so it never needs
 * identifier escaping.
 *
 * ## Stable names the implementer MUST use exactly (design D9: errors are
 * mapped by constraint name)
 *
 * Primary keys:
 * - `catalog_blueprint_pkey` (`id`)
 * - `catalog_relation_definition_pkey` (`id`)
 * - `catalog_entity_pkey` (`id`)
 * - `catalog_entity_relation_pkey`
 *   (`tenant_id, source_entity_id, relation_definition_id, scope, target_entity_id`)
 * - `catalog_change_event_pkey` (`tenant_id, seq`)
 * - `catalog_tenant_sequence_pkey` (`tenant_id`)
 *
 * Unique constraints:
 * - `catalog_blueprint_tenant_identifier_uq` (`tenant_id, identifier`)
 * - `catalog_blueprint_tenant_id_uq` (`tenant_id, id`) — FK target
 * - `catalog_relation_definition_tenant_source_identifier_uq`
 *   (`tenant_id, source_blueprint_id, identifier`)
 * - `catalog_relation_definition_tenant_id_uq` (`tenant_id, id`) — FK target;
 *   design D4 does not spell this one out for `catalog_relation_definition`,
 *   but it is implied: `catalog_entity_relation`'s composite FK to
 *   `(tenant_id, relation_definition_id)` needs a matching unique constraint
 *   to reference, exactly like the same pattern on `catalog_blueprint` and
 *   `catalog_entity`.
 * - `catalog_entity_tenant_blueprint_identifier_uq`
 *   (`tenant_id, blueprint_id, identifier`)
 * - `catalog_entity_tenant_id_uq` (`tenant_id, id`) — FK target
 *
 * Foreign keys (all composite with `tenant_id`, per design D4):
 * - `catalog_relation_definition_source_blueprint_fk`
 *   (`tenant_id, source_blueprint_id`) → `catalog_blueprint(tenant_id, id)`,
 *   `ON DELETE CASCADE`
 * - `catalog_relation_definition_target_blueprint_fk`
 *   (`tenant_id, target_blueprint_id`) → `catalog_blueprint(tenant_id, id)`,
 *   `ON DELETE RESTRICT`
 * - `catalog_entity_blueprint_fk` (`tenant_id, blueprint_id`) →
 *   `catalog_blueprint(tenant_id, id)`, `ON DELETE RESTRICT`
 * - `catalog_entity_relation_source_fk` (`tenant_id, source_entity_id`) →
 *   `catalog_entity(tenant_id, id)`, `ON DELETE CASCADE`
 * - `catalog_entity_relation_target_fk` (`tenant_id, target_entity_id`) →
 *   `catalog_entity(tenant_id, id)`, `ON DELETE RESTRICT`
 * - `catalog_entity_relation_definition_fk`
 *   (`tenant_id, relation_definition_id`) →
 *   `catalog_relation_definition(tenant_id, id)`, `ON DELETE RESTRICT`
 *
 * Check constraints:
 * - `catalog_relation_definition_many_required_check`:
 *   `CHECK (NOT (many AND required))`
 * - `catalog_entity_relation_scope_check`: `CHECK (scope IN ('spec', 'status'))`
 *
 * Index:
 * - `catalog_entity_relation_tenant_target_idx` on
 *   `catalog_entity_relation (tenant_id, target_entity_id)` (backward
 *   traversal, design D4)
 *
 * Trigger:
 * - `catalog_change_event_append_only` (design D4's own name), tested
 *   behaviorally: a raw `UPDATE`, `DELETE` and `TRUNCATE` on
 *   `catalog_change_event` must all raise.
 *
 * ## Column naming
 *
 * Column names and types below follow design D4 literally for
 * `catalog_relation_definition`, `catalog_entity_relation`,
 * `catalog_change_event` and `catalog_tenant_sequence`, whose column lists
 * D4 spells out completely (so this test asserts the exact column set for
 * those four tables). For `catalog_blueprint` and `catalog_entity`, D4 uses
 * the shorthand "`created_at/by_type/by_id`" and "`updated_*`" for
 * attribution columns; this test asserts only that those named columns exist
 * (`created_at`, `created_by_type`, `created_by_id`, `updated_at`,
 * `updated_by_type`, `updated_by_id`), and does not forbid extra columns
 * (for example ones later attribution work may add to record `onBehalfOf`
 * on a blueprint or entity row), since D4 does not spell those out.
 */
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { runMigrations } from '@tayzu/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
  const name = `tayzu_catalog_schema_${randomUUID().replaceAll('-', '')}`;
  if (!SCRATCH_NAME_PATTERN.test(name)) {
    // Defensive: never interpolate a database name that is not restricted to
    // this safe character set into DDL text.
    throw new Error(`generated scratch database name is unsafe: ${name}`);
  }
  return name;
}

/**
 * A pool or client whose `.on('error', ...)` and `.end()` the teardown
 * helper below needs. Both `drizzle(url).$client` (a `pg.Pool`) and a raw
 * `pg.Client`/`pg.Pool` satisfy this structurally.
 */
interface EndableWithErrorEvent {
  on(event: 'error', listener: (error: unknown) => void): unknown;
  end(): Promise<void>;
}

/**
 * Ends a pool or client that is about to be torn down, and only then lets
 * the caller proceed to `drop database ... with (force)`.
 *
 * Root cause this guards against: `Pool#end()`/`Client#end()` resolve once
 * every client has been told to end, but the server side of that connection
 * can still be in the process of closing when the promise settles. If
 * `drop database ... with (force)` runs in that window, Postgres terminates
 * the still-closing connection with SQLSTATE 57P01 ("terminating connection
 * due to administrator command"). That termination arrives asynchronously,
 * on a client object whose own `.end()` promise has already resolved and is
 * no longer awaited by anything, so without a listener it surfaces as an
 * unhandled 'error' event instead of being attributable to any assertion.
 * Attaching `.on('error', ...)` before `.end()` gives that late,
 * teardown-only event a place to land instead of crashing the process.
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
  { exact }: { exact: boolean },
): void {
  if (exact) {
    expect(new Set(actual.keys()), 'exact column set').toEqual(new Set(Object.keys(expected)));
  }
  for (const [column, spec] of Object.entries(expected)) {
    expect(actual.get(column), `column "${column}"`).toEqual(spec);
  }
}

// A type literal (not an interface) so it satisfies `db.execute`'s
// `TRow extends Record<string, unknown>` constraint (TypeScript's implicit
// index signature applies to object type literals, not interfaces).
type ConstraintRow = {
  readonly name: string;
  readonly type: 'p' | 'u' | 'f' | 'c';
  readonly definition: string;
  readonly deleteRule: string | null;
  readonly columns: string[] | null;
  readonly referencedTable: string | null;
  readonly referencedColumns: string[] | null;
};

async function readConstraints(db: Db, table: string): Promise<ConstraintRow[]> {
  const result = await db.execute<ConstraintRow>(sql`
    select
      con.conname as name,
      con.contype as type,
      pg_get_constraintdef(con.oid) as definition,
      case con.confdeltype
        when 'c' then 'CASCADE'
        when 'r' then 'RESTRICT'
        when 'n' then 'SET NULL'
        when 'd' then 'SET DEFAULT'
        when 'a' then 'NO ACTION'
        else null
      end as "deleteRule",
      (
        select array_agg(a.attname order by k.ord)
          from unnest(con.conkey) with ordinality as k(attnum, ord)
          join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
      ) as columns,
      cf.relname as "referencedTable",
      (
        select array_agg(a.attname order by k.ord)
          from unnest(con.confkey) with ordinality as k(attnum, ord)
          join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum
      ) as "referencedColumns"
      from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_class cf on cf.oid = con.confrelid
     where n.nspname = 'public' and c.relname = ${table}
     order by con.conname
  `);
  return result.rows;
}

interface ExpectedConstraint {
  readonly name: string;
  readonly type: 'p' | 'u' | 'f' | 'c';
  readonly columns?: readonly string[];
  readonly referencedTable?: string;
  readonly referencedColumns?: readonly string[];
  readonly deleteRule?: string;
}

function expectConstraint(rows: readonly ConstraintRow[], expected: ExpectedConstraint): void {
  const row = rows.find((candidate) => candidate.name === expected.name);
  expect(row, `constraint "${expected.name}" exists`).toBeDefined();
  if (row === undefined) {
    return;
  }
  expect(row.type, `"${expected.name}" is the expected constraint type`).toBe(expected.type);
  if (expected.columns !== undefined) {
    expect(row.columns, `"${expected.name}" columns`).toEqual([...expected.columns]);
  }
  if (expected.referencedTable !== undefined) {
    expect(row.referencedTable, `"${expected.name}" referenced table`).toBe(
      expected.referencedTable,
    );
  }
  if (expected.referencedColumns !== undefined) {
    expect(row.referencedColumns, `"${expected.name}" referenced columns`).toEqual([
      ...expected.referencedColumns,
    ]);
  }
  if (expected.deleteRule !== undefined) {
    expect(row.deleteRule, `"${expected.name}" ON DELETE action`).toBe(expected.deleteRule);
  }
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

async function readIndexDefs(db: Db, table: string): Promise<string[]> {
  const result = await db.execute<{ definition: string }>(sql`
    select indexdef as definition
      from pg_indexes
     where schemaname = 'public' and tablename = ${table}
     order by indexname
  `);
  return result.rows.map((row) => normalize(row.definition));
}

/**
 * Task 6.1 (design D6, Migration Plan step 2's Drizzle-generated half): every
 * catalog table listed in `schema.ts` gets `ENABLE ROW LEVEL SECURITY` plus a
 * single `tenant_isolation` policy, `for: 'all'`, scoped to `tayzu_app`, whose
 * `USING`/`WITH CHECK` clauses both compare `tenant_id` against
 * `current_setting('app.tenant_id', true)`. `FORCE ROW LEVEL SECURITY` and the
 * table grants themselves are task 6.2's hand-written migration and are
 * asserted there, not here.
 */
const CATALOG_TABLES = [
  'catalog_blueprint',
  'catalog_change_event',
  'catalog_entity',
  'catalog_entity_relation',
  'catalog_relation_definition',
  'catalog_tenant_sequence',
] as const;

// Matches `tenant_id = current_setting('app.tenant_id', true)`, tolerating an
// optional table-qualifying prefix on the column and an optional `::text`
// cast on the setting-name literal, both of which are formatting choices
// `pg_get_expr`/the SQL generator may make without changing the meaning of
// design D6's literal expression.
const TENANT_ISOLATION_EXPRESSION =
  /(?:\w+\.)?tenant_id\s*=\s*current_setting\('app\.tenant_id'(?:::text)?,\s*true\)/;

async function readRowSecurityEnabled(db: Db, table: string): Promise<boolean | undefined> {
  const result = await db.execute<{ enabled: boolean }>(sql`
    select relrowsecurity as enabled
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = ${table}
  `);
  return result.rows[0]?.enabled;
}

type PolicyRow = {
  readonly name: string;
  readonly cmd: string;
  readonly permissive: boolean;
  readonly roles: string[] | null;
  readonly using: string | null;
  readonly withCheck: string | null;
};

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

describe('0000_catalog_core migration (design D4)', () => {
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

  it('creates exactly the six catalog tables in the public schema', async () => {
    const result = await db.execute<{ name: string }>(sql`
      select table_name as name
        from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE'
       order by table_name
    `);

    expect(result.rows.map((row) => row.name)).toEqual([
      'catalog_blueprint',
      'catalog_change_event',
      'catalog_entity',
      'catalog_entity_relation',
      'catalog_relation_definition',
      'catalog_tenant_sequence',
    ]);
  });

  it('catalog_blueprint has its D4 columns, primary key and unique constraints', async () => {
    const columns = await readColumns(db, 'catalog_blueprint');
    expectColumns(
      columns,
      {
        id: { type: 'uuid', nullable: false },
        tenant_id: { type: 'text', nullable: false },
        identifier: { type: 'text', nullable: false },
        title: { type: 'jsonb', nullable: false },
        description: { type: 'jsonb', nullable: true },
        icon: { type: 'text', nullable: true },
        schema: { type: 'jsonb', nullable: false },
        status_schema: { type: 'jsonb', nullable: true },
        version: { type: 'integer', nullable: false },
        created_at: { type: 'timestamp with time zone', nullable: false },
        created_by_type: { type: 'text', nullable: false },
        created_by_id: { type: 'text', nullable: false },
        updated_at: { type: 'timestamp with time zone', nullable: false },
        updated_by_type: { type: 'text', nullable: false },
        updated_by_id: { type: 'text', nullable: false },
      },
      { exact: false },
    );

    const constraints = await readConstraints(db, 'catalog_blueprint');
    expectConstraint(constraints, { name: 'catalog_blueprint_pkey', type: 'p', columns: ['id'] });
    expectConstraint(constraints, {
      name: 'catalog_blueprint_tenant_identifier_uq',
      type: 'u',
      columns: ['tenant_id', 'identifier'],
    });
    expectConstraint(constraints, {
      name: 'catalog_blueprint_tenant_id_uq',
      type: 'u',
      columns: ['tenant_id', 'id'],
    });
  });

  it('catalog_relation_definition has its D4 columns, keys, FKs with ON DELETE actions and the many/required check', async () => {
    const columns = await readColumns(db, 'catalog_relation_definition');
    expectColumns(
      columns,
      {
        id: { type: 'uuid', nullable: false },
        tenant_id: { type: 'text', nullable: false },
        source_blueprint_id: { type: 'uuid', nullable: false },
        identifier: { type: 'text', nullable: false },
        title: { type: 'jsonb', nullable: false },
        target_blueprint_id: { type: 'uuid', nullable: false },
        many: { type: 'boolean', nullable: false },
        required: { type: 'boolean', nullable: false },
      },
      { exact: true },
    );

    const constraints = await readConstraints(db, 'catalog_relation_definition');
    expectConstraint(constraints, {
      name: 'catalog_relation_definition_pkey',
      type: 'p',
      columns: ['id'],
    });
    expectConstraint(constraints, {
      name: 'catalog_relation_definition_tenant_source_identifier_uq',
      type: 'u',
      columns: ['tenant_id', 'source_blueprint_id', 'identifier'],
    });
    expectConstraint(constraints, {
      name: 'catalog_relation_definition_tenant_id_uq',
      type: 'u',
      columns: ['tenant_id', 'id'],
    });
    expectConstraint(constraints, {
      name: 'catalog_relation_definition_source_blueprint_fk',
      type: 'f',
      columns: ['tenant_id', 'source_blueprint_id'],
      referencedTable: 'catalog_blueprint',
      referencedColumns: ['tenant_id', 'id'],
      deleteRule: 'CASCADE',
    });
    expectConstraint(constraints, {
      name: 'catalog_relation_definition_target_blueprint_fk',
      type: 'f',
      columns: ['tenant_id', 'target_blueprint_id'],
      referencedTable: 'catalog_blueprint',
      referencedColumns: ['tenant_id', 'id'],
      deleteRule: 'RESTRICT',
    });

    const check = constraints.find(
      (row) => row.name === 'catalog_relation_definition_many_required_check',
    );
    expect(check, 'the many/required check constraint exists').toBeDefined();
    expect(check?.type).toBe('c');
    expect(normalize(check?.definition ?? '')).toMatch(/NOT\s*\(\s*many\s+AND\s+required\s*\)/i);
  });

  it('catalog_entity has its D4 columns, keys and FK to catalog_blueprint', async () => {
    const columns = await readColumns(db, 'catalog_entity');
    expectColumns(
      columns,
      {
        id: { type: 'uuid', nullable: false },
        tenant_id: { type: 'text', nullable: false },
        blueprint_id: { type: 'uuid', nullable: false },
        identifier: { type: 'text', nullable: false },
        title: { type: 'text', nullable: false },
        icon: { type: 'text', nullable: true },
        spec_properties: { type: 'jsonb', nullable: false },
        status_properties: { type: 'jsonb', nullable: true },
        status_observed_generation: { type: 'integer', nullable: true },
        status_observed_at: { type: 'timestamp with time zone', nullable: true },
        status_source: { type: 'text', nullable: true },
        generation: { type: 'integer', nullable: false },
        version: { type: 'integer', nullable: false },
        created_at: { type: 'timestamp with time zone', nullable: false },
        created_by_type: { type: 'text', nullable: false },
        created_by_id: { type: 'text', nullable: false },
        updated_at: { type: 'timestamp with time zone', nullable: false },
        updated_by_type: { type: 'text', nullable: false },
        updated_by_id: { type: 'text', nullable: false },
      },
      { exact: false },
    );

    const constraints = await readConstraints(db, 'catalog_entity');
    expectConstraint(constraints, { name: 'catalog_entity_pkey', type: 'p', columns: ['id'] });
    expectConstraint(constraints, {
      name: 'catalog_entity_tenant_blueprint_identifier_uq',
      type: 'u',
      columns: ['tenant_id', 'blueprint_id', 'identifier'],
    });
    expectConstraint(constraints, {
      name: 'catalog_entity_tenant_id_uq',
      type: 'u',
      columns: ['tenant_id', 'id'],
    });
    expectConstraint(constraints, {
      name: 'catalog_entity_blueprint_fk',
      type: 'f',
      columns: ['tenant_id', 'blueprint_id'],
      referencedTable: 'catalog_blueprint',
      referencedColumns: ['tenant_id', 'id'],
      deleteRule: 'RESTRICT',
    });
  });

  it('catalog_entity_relation has its D4 columns, composite primary key, scope check, FKs with ON DELETE actions and the backward-traversal index', async () => {
    const columns = await readColumns(db, 'catalog_entity_relation');
    expectColumns(
      columns,
      {
        tenant_id: { type: 'text', nullable: false },
        source_entity_id: { type: 'uuid', nullable: false },
        relation_definition_id: { type: 'uuid', nullable: false },
        scope: { type: 'text', nullable: false },
        target_entity_id: { type: 'uuid', nullable: false },
        position: { type: 'integer', nullable: false },
      },
      { exact: true },
    );

    const constraints = await readConstraints(db, 'catalog_entity_relation');
    expectConstraint(constraints, {
      name: 'catalog_entity_relation_pkey',
      type: 'p',
      columns: [
        'tenant_id',
        'source_entity_id',
        'relation_definition_id',
        'scope',
        'target_entity_id',
      ],
    });
    expectConstraint(constraints, {
      name: 'catalog_entity_relation_source_fk',
      type: 'f',
      columns: ['tenant_id', 'source_entity_id'],
      referencedTable: 'catalog_entity',
      referencedColumns: ['tenant_id', 'id'],
      deleteRule: 'CASCADE',
    });
    expectConstraint(constraints, {
      name: 'catalog_entity_relation_target_fk',
      type: 'f',
      columns: ['tenant_id', 'target_entity_id'],
      referencedTable: 'catalog_entity',
      referencedColumns: ['tenant_id', 'id'],
      deleteRule: 'RESTRICT',
    });
    expectConstraint(constraints, {
      name: 'catalog_entity_relation_definition_fk',
      type: 'f',
      columns: ['tenant_id', 'relation_definition_id'],
      referencedTable: 'catalog_relation_definition',
      referencedColumns: ['tenant_id', 'id'],
      deleteRule: 'RESTRICT',
    });

    const check = constraints.find((row) => row.name === 'catalog_entity_relation_scope_check');
    expect(check, 'the scope check constraint exists').toBeDefined();
    expect(check?.type).toBe('c');
    const definition = normalize(check?.definition ?? '');
    expect(definition).toMatch(/scope/i);
    expect(definition).toMatch(/'spec'/);
    expect(definition).toMatch(/'status'/);

    const indexDefs = await readIndexDefs(db, 'catalog_entity_relation');
    expect(
      indexDefs.some((definition) => /\(tenant_id,\s*target_entity_id\)/i.test(definition)),
      `an index on (tenant_id, target_entity_id) exists among: ${indexDefs.join(' | ')}`,
    ).toBe(true);
    const namedIndex = await db.execute<{ name: string }>(sql`
      select indexname as name
        from pg_indexes
       where schemaname = 'public'
         and tablename = 'catalog_entity_relation'
         and indexname = 'catalog_entity_relation_tenant_target_idx'
    `);
    expect(
      namedIndex.rows.length,
      'the backward-traversal index is named catalog_entity_relation_tenant_target_idx',
    ).toBe(1);
  });

  it('catalog_change_event has exactly its D4 columns and primary key', async () => {
    const columns = await readColumns(db, 'catalog_change_event');
    expectColumns(
      columns,
      {
        tenant_id: { type: 'text', nullable: false },
        seq: { type: 'bigint', nullable: false },
        occurred_at: { type: 'timestamp with time zone', nullable: false },
        actor_type: { type: 'text', nullable: false },
        actor_id: { type: 'text', nullable: false },
        on_behalf_of_type: { type: 'text', nullable: true },
        on_behalf_of_id: { type: 'text', nullable: true },
        action: { type: 'text', nullable: false },
        resource_kind: { type: 'text', nullable: false },
        blueprint_identifier: { type: 'text', nullable: false },
        resource_identifier: { type: 'text', nullable: false },
        version: { type: 'integer', nullable: false },
        changed_fields: { type: 'text[]', nullable: false },
        snapshot: { type: 'jsonb', nullable: false },
        trace_id: { type: 'text', nullable: true },
      },
      { exact: true },
    );

    const constraints = await readConstraints(db, 'catalog_change_event');
    expectConstraint(constraints, {
      name: 'catalog_change_event_pkey',
      type: 'p',
      columns: ['tenant_id', 'seq'],
    });
  });

  it('catalog_tenant_sequence has exactly its D4 columns and primary key', async () => {
    const columns = await readColumns(db, 'catalog_tenant_sequence');
    expectColumns(
      columns,
      {
        tenant_id: { type: 'text', nullable: false },
        last_seq: { type: 'bigint', nullable: false },
      },
      { exact: true },
    );

    const constraints = await readConstraints(db, 'catalog_tenant_sequence');
    expectConstraint(constraints, {
      name: 'catalog_tenant_sequence_pkey',
      type: 'p',
      columns: ['tenant_id'],
    });
  });

  it('rejects a raw UPDATE, DELETE and TRUNCATE on catalog_change_event (append-only trigger)', async () => {
    const tenantId = `t${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    await db.execute(sql`
      insert into catalog_change_event
        (tenant_id, seq, occurred_at, actor_type, actor_id, action, resource_kind,
         blueprint_identifier, resource_identifier, version, changed_fields, snapshot)
      values
        (${tenantId}, 1, now(), 'system', 'sys', 'created', 'entity', 'bp', 'e1', 1, ARRAY[]::text[], '{}'::jsonb)
    `);

    await expect(
      db.execute(
        sql`update catalog_change_event set version = 2 where tenant_id = ${tenantId} and seq = 1`,
      ),
    ).rejects.toThrow();

    await expect(
      db.execute(sql`delete from catalog_change_event where tenant_id = ${tenantId} and seq = 1`),
    ).rejects.toThrow();

    await expect(db.execute(sql`truncate catalog_change_event`)).rejects.toThrow();
  });

  describe('tenant_isolation RLS policy (design D6, task 6.1)', () => {
    it.each(CATALOG_TABLES)('%s has ENABLE ROW LEVEL SECURITY set', async (table) => {
      const enabled = await readRowSecurityEnabled(db, table);
      expect(enabled, `${table} has row level security enabled`).toBe(true);
    });

    it.each(CATALOG_TABLES)(
      '%s has a permissive tenant_isolation policy, for: "all", scoped to tayzu_app',
      async (table) => {
        const policy = await readTenantIsolationPolicy(db, table);
        expect(policy, `${table} has a "tenant_isolation" policy`).toBeDefined();
        if (policy === undefined) {
          return;
        }

        expect(policy.permissive, `${table}'s tenant_isolation policy is permissive`).toBe(true);
        expect(
          policy.cmd,
          `${table}'s tenant_isolation policy applies to every command (for: 'all')`,
        ).toBe('*');
        expect(policy.roles, `${table}'s tenant_isolation policy is scoped to tayzu_app`).toEqual([
          'tayzu_app',
        ]);

        expect(policy.using, `${table}'s tenant_isolation USING clause is present`).not.toBeNull();
        expect(
          policy.using,
          `${table}'s tenant_isolation USING clause compares tenant_id to current_setting('app.tenant_id', true)`,
        ).toMatch(TENANT_ISOLATION_EXPRESSION);

        expect(
          policy.withCheck,
          `${table}'s tenant_isolation WITH CHECK clause is present`,
        ).not.toBeNull();
        expect(
          policy.withCheck,
          `${table}'s tenant_isolation WITH CHECK clause compares tenant_id to current_setting('app.tenant_id', true)`,
        ).toMatch(TENANT_ISOLATION_EXPRESSION);
      },
    );
  });
});
