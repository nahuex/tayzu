/**
 * Integration test for task 3.1 of 003-catalog-ui-core (migration
 * `0015_catalog_entity_search`, Checkpoint 3; design D7, Resolved decision
 * Q41).
 *
 * Verify clause: the extension present, the four index definitions, the
 * trigram index used for `title % $1` and for `identifier ILIKE $1`
 * (`EXPLAIN` with sequential scans off), and the down script removing them.
 *
 * Index names are design D7's own:
 * - `catalog_entity_title_trgm_idx`: `USING gin (title gin_trgm_ops)`
 * - `catalog_entity_identifier_trgm_idx`: `USING gin (identifier gin_trgm_ops)`
 * - `catalog_entity_tenant_blueprint_title_idx`: btree
 *   `(tenant_id, blueprint_id, title, identifier)`
 * - `catalog_entity_tenant_blueprint_updated_idx`: btree
 *   `(tenant_id, blueprint_id, updated_at, identifier)`
 *
 * The definitions are read from `pg_indexes` joined to `pg_index`, and are
 * compared exactly: access method, key columns in order, operator classes,
 * collations (titles compare under the database default collation, D6), sort
 * options (the defaults: D7 spells no `DESC` and no `NULLS`), not unique, not
 * partial, no expression and no `INCLUDE` column.
 *
 * `pg_trgm` lives in schema `public` (D7: `WITH SCHEMA public`). The down
 * script `packages/db/migrations/down/0015_catalog_entity_search.down.sql`
 * drops the four indexes and then the extension (D7); it runs against its own
 * scratch database, never the shared one, and every other index of
 * `catalog_entity` survives it.
 *
 * The `EXPLAIN` runs as the scratch database's owner, the `DATABASE_URL` role,
 * which bypasses row-level security (superuser in CI, `BYPASSRLS` in the
 * sandbox): `catalog_entity` has `FORCE ROW LEVEL SECURITY` and its only
 * policy is for `tayzu_app`, so a role that does not bypass it would be
 * planned as a constant-false filter, not as a scan. That is checked up front.
 *
 * Uses private scratch databases migrated from empty (the pattern of
 * `tenant-deletion-migration.int.test.ts`, migration `0012`).
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { runMigrations } from '@tayzu/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DOWN_SCRIPT_PATH = fileURLToPath(
  new URL('../../../db/migrations/down/0015_catalog_entity_search.down.sql', import.meta.url),
);

const TITLE_TRGM_INDEX = 'catalog_entity_title_trgm_idx';
const IDENTIFIER_TRGM_INDEX = 'catalog_entity_identifier_trgm_idx';
const TITLE_SORT_INDEX = 'catalog_entity_tenant_blueprint_title_idx';
const UPDATED_SORT_INDEX = 'catalog_entity_tenant_blueprint_updated_idx';

const SEARCH_INDEXES = [
  TITLE_TRGM_INDEX,
  IDENTIFIER_TRGM_INDEX,
  TITLE_SORT_INDEX,
  UPDATED_SORT_INDEX,
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

function connect(url: string) {
  return drizzle(url);
}

type Db = ReturnType<typeof connect>;
type Pool = Db['$client'];
type Query = Pool['query'];

function scratchDatabaseUrl(name: string): string {
  const url = new URL(databaseUrl());
  url.pathname = `/${name}`;
  return url.href;
}

const SCRATCH_NAME_PATTERN = /^[a-z0-9_]+$/;

function scratchDatabaseName(): string {
  const name = `tayzu_entity_search_${randomUUID().replaceAll('-', '')}`;
  if (!SCRATCH_NAME_PATTERN.test(name)) {
    throw new Error(`generated scratch database name is unsafe: ${name}`);
  }
  return name;
}

interface EndableWithErrorEvent {
  on(event: 'error', listener: (error: unknown) => void): unknown;
  end(): Promise<void>;
}

async function endQuietly(closeable: EndableWithErrorEvent): Promise<void> {
  closeable.on('error', () => {
    // Expected during teardown: see revocation-schema.int.test.ts.
  });
  await closeable.end();
}

interface Scratch {
  readonly name: string;
  readonly db: Db;
}

async function assertAdminPrivileges(admin: Db): Promise<void> {
  const privilege = await admin.execute<{ createdb: boolean; bypassesRls: boolean }>(sql`
    select rolcreatedb or rolsuper as createdb,
           rolbypassrls or rolsuper as "bypassesRls"
      from pg_roles where rolname = current_user
  `);
  const row = privilege.rows[0];
  if (row?.createdb !== true) {
    throw new Error(
      'The DATABASE_URL role needs the CREATEDB privilege: this test creates, and then drops, private scratch databases.',
    );
  }
  if (!row.bypassesRls) {
    throw new Error(
      'The DATABASE_URL role must bypass row-level security (superuser or BYPASSRLS): the EXPLAIN checks plan a raw scan of catalog_entity.',
    );
  }
}

async function createMigratedScratch(admin: Db): Promise<Scratch> {
  const name = scratchDatabaseName();
  await admin.execute(`create database ${name}`);
  const db = connect(scratchDatabaseUrl(name));
  await runMigrations(db.$client);
  return { name, db };
}

async function dropScratch(admin: Db, scratch: Scratch | undefined): Promise<void> {
  if (scratch === undefined) {
    return;
  }
  await endQuietly(scratch.db.$client);
  await admin.execute(`drop database if exists ${scratch.name} with (force)`);
}

/** Runs `fn` inside one transaction that is always rolled back. */
async function inRolledBackTransaction<T>(
  pool: Pool,
  fn: (query: Query) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    return await fn(client.query.bind(client));
  } finally {
    await client.query('rollback');
    client.release();
  }
}

type IndexShape = {
  readonly method: string;
  readonly columns: readonly string[];
  readonly opclasses: readonly string[];
  readonly collations: readonly (string | null)[];
  readonly options: readonly number[];
  readonly unique: boolean;
  readonly partial: boolean;
  readonly hasExpressions: boolean;
  readonly includeColumns: number;
  readonly valid: boolean;
};

// A type literal (not an interface) so it satisfies `db.execute`'s
// `TRow extends Record<string, unknown>` constraint.
type IndexRow = {
  readonly name: string;
  readonly definition: string;
} & IndexShape;

/** Every index of `public.catalog_entity`, read from `pg_indexes` and `pg_index`. */
async function readEntityIndexes(db: Db): Promise<Map<string, IndexRow>> {
  const result = await db.execute<IndexRow>(sql`
    select i.indexname as name,
           i.indexdef as definition,
           am.amname as method,
           array(
             select a.attname::text
               from unnest(ix.indkey::int2[]) with ordinality as k(attnum, ord)
               join pg_attribute a on a.attrelid = ix.indrelid and a.attnum = k.attnum
              order by k.ord
           ) as columns,
           array(
             select oc.opcname::text
               from unnest(ix.indclass::oid[]) with ordinality as k(opc, ord)
               join pg_opclass oc on oc.oid = k.opc
              order by k.ord
           ) as opclasses,
           array(
             select co.collname::text
               from unnest(ix.indcollation::oid[]) with ordinality as k(coll, ord)
               left join pg_collation co on co.oid = k.coll
              order by k.ord
           ) as collations,
           array(
             select k.opt::int
               from unnest(ix.indoption::int2[]) with ordinality as k(opt, ord)
              order by k.ord
           ) as options,
           ix.indisunique as unique,
           ix.indpred is not null as partial,
           ix.indexprs is not null as "hasExpressions",
           (ix.indnatts - ix.indnkeyatts)::int as "includeColumns",
           ix.indisvalid as valid
      from pg_indexes i
      join pg_namespace n on n.nspname = i.schemaname
      join pg_class c on c.relname = i.indexname and c.relnamespace = n.oid
      join pg_index ix on ix.indexrelid = c.oid
      join pg_am am on am.oid = c.relam
     where i.schemaname = 'public'
       and i.tablename = 'catalog_entity'
     order by i.indexname
  `);
  return new Map(result.rows.map((row) => [row.name, row]));
}

function expectIndexShape(
  indexes: ReadonlyMap<string, IndexRow>,
  name: string,
  expected: Pick<IndexShape, 'method' | 'columns' | 'opclasses' | 'collations'>,
): void {
  const row = indexes.get(name);
  expect(
    row,
    `index ${name} exists on public.catalog_entity among: ${[...indexes.keys()].join(', ')}`,
  ).toBeDefined();
  if (row === undefined) {
    return;
  }
  const shape: IndexShape = {
    method: row.method,
    columns: row.columns,
    opclasses: row.opclasses,
    collations: row.collations,
    options: row.options,
    unique: row.unique,
    partial: row.partial,
    hasExpressions: row.hasExpressions,
    includeColumns: row.includeColumns,
    valid: row.valid,
  };
  expect(shape, `${name} definition (pg_indexes: ${row.definition})`).toEqual({
    ...expected,
    options: expected.columns.map(() => 0),
    unique: false,
    partial: false,
    hasExpressions: false,
    includeColumns: 0,
    valid: true,
  });
}

type PlanNode = {
  readonly 'Node Type'?: string;
  readonly 'Index Name'?: string;
  readonly Plans?: readonly PlanNode[];
};

function flattenPlan(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap((child) => flattenPlan(child))];
}

/**
 * `EXPLAIN (FORMAT JSON)` of `statement` with `values` as bind parameters,
 * with sequential scans disabled through `SET LOCAL` inside one transaction.
 */
async function explainWithoutSeqScan(
  pool: Pool,
  statement: string,
  values: readonly unknown[],
): Promise<PlanNode[]> {
  return inRolledBackTransaction(pool, async (query) => {
    await query('set local enable_seqscan = off');
    const result = await query<{ 'QUERY PLAN': readonly { Plan: PlanNode }[] }>(
      `explain (format json) ${statement}`,
      [...values],
    );
    const plan = result.rows[0]?.['QUERY PLAN'][0]?.Plan;
    expect(plan, 'EXPLAIN returned a plan').toBeDefined();
    return plan === undefined ? [] : flattenPlan(plan);
  });
}

function expectUsesIndex(nodes: readonly PlanNode[], indexName: string): void {
  const summary = nodes
    .map((node) => {
      const type = node['Node Type'] ?? '?';
      const index = node['Index Name'];
      return index === undefined ? type : `${type} on ${index}`;
    })
    .join(' > ');
  expect(
    nodes.some((node) => node['Index Name'] === indexName),
    `the plan uses ${indexName}: ${summary}`,
  ).toBe(true);
  expect(
    nodes.some((node) => node['Node Type'] === 'Seq Scan'),
    `the plan has no sequential scan: ${summary}`,
  ).toBe(false);
}

async function readTrgmExtension(db: Db): Promise<{ name: string; schema: string }[]> {
  const result = await db.execute<{ name: string; schema: string }>(sql`
    select e.extname::text as name, n.nspname::text as schema
      from pg_extension e
      join pg_namespace n on n.oid = e.extnamespace
     where e.extname = 'pg_trgm'
  `);
  return result.rows;
}

describe('catalog_entity search indexes (migration 0015_catalog_entity_search, task 3.1)', () => {
  let admin: Db;
  let scratch: Scratch | undefined;

  function db(): Db {
    if (scratch === undefined) {
      throw new Error('the scratch database was not created');
    }
    return scratch.db;
  }

  beforeAll(async () => {
    admin = connect(databaseUrl());
    await assertAdminPrivileges(admin);
    scratch = await createMigratedScratch(admin);
  }, 60_000);

  afterAll(async () => {
    await dropScratch(admin, scratch);
    await endQuietly(admin.$client);
  }, 60_000);

  it('the pg_trgm extension is present, in schema public', async () => {
    expect(await readTrgmExtension(db())).toEqual([{ name: 'pg_trgm', schema: 'public' }]);
  });

  describe('the four index definitions', () => {
    it(`${TITLE_TRGM_INDEX} is a GIN trigram index on catalog_entity (title)`, async () => {
      expectIndexShape(await readEntityIndexes(db()), TITLE_TRGM_INDEX, {
        method: 'gin',
        columns: ['title'],
        opclasses: ['gin_trgm_ops'],
        collations: ['default'],
      });
    });

    it(`${IDENTIFIER_TRGM_INDEX} is a GIN trigram index on catalog_entity (identifier)`, async () => {
      expectIndexShape(await readEntityIndexes(db()), IDENTIFIER_TRGM_INDEX, {
        method: 'gin',
        columns: ['identifier'],
        opclasses: ['gin_trgm_ops'],
        collations: ['default'],
      });
    });

    it(`${TITLE_SORT_INDEX} is a btree on catalog_entity (tenant_id, blueprint_id, title, identifier)`, async () => {
      expectIndexShape(await readEntityIndexes(db()), TITLE_SORT_INDEX, {
        method: 'btree',
        columns: ['tenant_id', 'blueprint_id', 'title', 'identifier'],
        opclasses: ['text_ops', 'uuid_ops', 'text_ops', 'text_ops'],
        collations: ['default', null, 'default', 'default'],
      });
    });

    it(`${UPDATED_SORT_INDEX} is a btree on catalog_entity (tenant_id, blueprint_id, updated_at, identifier)`, async () => {
      expectIndexShape(await readEntityIndexes(db()), UPDATED_SORT_INDEX, {
        method: 'btree',
        columns: ['tenant_id', 'blueprint_id', 'updated_at', 'identifier'],
        opclasses: ['text_ops', 'uuid_ops', 'timestamptz_ops', 'text_ops'],
        collations: ['default', null, null, 'default'],
      });
    });
  });

  describe('the trigram indexes are used with sequential scans off', () => {
    it(`title % $1 uses ${TITLE_TRGM_INDEX}`, async () => {
      const nodes = await explainWithoutSeqScan(
        db().$client,
        'select id from catalog_entity where title % $1::text',
        ['payments'],
      );
      expectUsesIndex(nodes, TITLE_TRGM_INDEX);
    });

    it(`identifier ILIKE $1 uses ${IDENTIFIER_TRGM_INDEX}`, async () => {
      const nodes = await explainWithoutSeqScan(
        db().$client,
        'select id from catalog_entity where identifier ilike $1::text',
        ['paym%'],
      );
      expectUsesIndex(nodes, IDENTIFIER_TRGM_INDEX);
    });
  });
});

describe('the down script of 0015_catalog_entity_search (task 3.1)', () => {
  let admin: Db;
  let scratch: Scratch | undefined;
  let before: ReadonlyMap<string, IndexRow> = new Map();
  let extensionBefore: { name: string; schema: string }[] = [];
  // Stays undefined unless the down script ran, so the extension check below
  // cannot pass without it.
  let extensionAfter: { name: string; schema: string }[] | undefined;

  beforeAll(async () => {
    admin = connect(databaseUrl());
    await assertAdminPrivileges(admin);
    // A scratch database of its own: the down script never runs against the
    // shared database, nor against the one the forward checks read.
    scratch = await createMigratedScratch(admin);
    before = await readEntityIndexes(scratch.db);
    extensionBefore = await readTrgmExtension(scratch.db);
  }, 60_000);

  afterAll(async () => {
    await dropScratch(admin, scratch);
    await endQuietly(admin.$client);
  }, 60_000);

  it('the migrated scratch database has the four indexes before the down script runs', () => {
    for (const name of SEARCH_INDEXES) {
      expect(before.has(name), `${name} exists before the down script`).toBe(true);
    }
  });

  it('removes the four indexes, and keeps every other index of catalog_entity', async () => {
    if (scratch === undefined) {
      throw new Error('the scratch database was not created');
    }
    const downScript = await readFile(DOWN_SCRIPT_PATH, 'utf8');
    await scratch.db.$client.query(downScript);

    const after = await readEntityIndexes(scratch.db);
    extensionAfter = await readTrgmExtension(scratch.db);

    for (const name of SEARCH_INDEXES) {
      expect(after.has(name), `${name} is gone after the down script`).toBe(false);
    }
    const searchIndexes: readonly string[] = SEARCH_INDEXES;
    expect([...after.keys()].sort()).toEqual(
      [...before.keys()].filter((name) => !searchIndexes.includes(name)).sort(),
    );
    expect(after.get('catalog_entity_tenant_blueprint_identifier_uq')).toBeDefined();
  });

  it('then drops the pg_trgm extension (design D7)', () => {
    expect(extensionBefore, 'pg_trgm is present before the down script').toEqual([
      { name: 'pg_trgm', schema: 'public' },
    ]);
    expect(extensionAfter, 'pg_trgm is gone after the down script').toEqual([]);
  });
});
