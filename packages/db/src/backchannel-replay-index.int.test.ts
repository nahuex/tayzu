/**
 * Integration test for task 7.4 of 048-production-hardening (migration
 * `0016_backchannel_logout_replay_uq`, Checkpoint 3; design D8, Resolved
 * decision Q14).
 *
 * Task 7.4 Verify clause: "`packages/db/src/backchannel-replay-index.int.test.ts`
 * covers the index and its exact predicate, a second `backchannel-logout:` row
 * with the same identifier refused, two rows of another family with one
 * identifier still accepted, the index build failing (and deleting nothing)
 * over pre-existing duplicates, and the down script removing it".
 *
 * D8: "A partial unique index declared on the `verification` table [...]
 * `CREATE UNIQUE INDEX "verification_backchannel_logout_uq" ON "auth"."verification"
 * USING btree ("identifier") WHERE starts_with("identifier", 'backchannel-logout:');`.
 * No dedupe statement precedes it: if duplicate back-channel rows exist, the
 * index build fails with a unique violation and the migration's transaction
 * aborts, loudly, deleting nothing. A global unique index is not safe: other
 * identifier families of `auth.verification` may repeat [...]. The down script
 * drops the index. The index needs no grant."
 *
 * D8 also names the replay insert the index serves:
 * `insert into auth.verification (id, identifier, value, expires_at) values
 * ($1, $2, 'processed', to_timestamp($3)) on conflict (identifier) where
 * starts_with(identifier, 'backchannel-logout:') do nothing`; it is checked
 * here only for the index being its arbiter (task 7.5 owns the handler).
 *
 * Databases:
 * - The shared, migrated test database (the harness) for the index definition
 *   and the row-level checks. Rows are written as `tayzu_auth`, the role the
 *   back-channel handler uses, with random identifiers, and deleted afterwards
 *   by id; nothing is truncated.
 * - A private scratch database migrated through `0015` only (the shipped
 *   migrations folder copied to a temporary directory with its journal cut at
 *   idx 15, applied by drizzle's migrator, so the migration journal is real),
 *   seeded with duplicate `backchannel-logout:` rows, then given `0016`.
 * - A private scratch database migrated in full for the down script, which
 *   never runs against the shared database.
 *
 * Postgres deparses the predicate with an explicit `::text` cast on the
 * literal: `starts_with(identifier, 'backchannel-logout:'::text)`.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { escapeIdentifier, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getAuthTestDatabase, getOwnerPool, getTestDatabase } from './harness.js';
import { runMigrations } from './index.js';

const INDEX_NAME = 'verification_backchannel_logout_uq';
const EXISTING_IDENTIFIER_INDEX = 'verification_identifier_idx';
const MIGRATION_TAG = '0016_backchannel_logout_replay_uq';
const PREVIOUS_MIGRATION_IDX = 15;

const EXPECTED_PREDICATE = "starts_with(identifier, 'backchannel-logout:'::text)";
const EXPECTED_INDEXDEF = `CREATE UNIQUE INDEX ${INDEX_NAME} ON auth.verification USING btree (identifier) WHERE ${EXPECTED_PREDICATE}`;

const UNIQUE_VIOLATION = '23505';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
const MIGRATION_PATH = join(MIGRATIONS_DIR, `${MIGRATION_TAG}.sql`);
const DOWN_SCRIPT_PATH = join(MIGRATIONS_DIR, 'down', `${MIGRATION_TAG}.down.sql`);
const JOURNAL_PATH = join(MIGRATIONS_DIR, 'meta', '_journal.json');

/** D8's replay insert, verbatim except for a fixed expiry instead of `to_timestamp($3)`. */
const REPLAY_INSERT = `insert into auth.verification (id, identifier, value, expires_at)
  values ($1, $2, 'processed', now() + interval '1 hour')
  on conflict (identifier) where starts_with(identifier, 'backchannel-logout:') do nothing`;

const PLAIN_INSERT = `insert into auth.verification (id, identifier, value, expires_at)
  values ($1, $2, 'processed', now() + interval '1 hour')`;

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim() === '') {
    throw new Error(
      'DATABASE_URL is not set: the int project global setup should have stopped this run.',
    );
  }
  return url;
}

function scratchDatabaseUrl(name: string): string {
  const url = new URL(databaseUrl());
  url.pathname = `/${name}`;
  url.searchParams.delete('database');
  url.searchParams.delete('dbname');
  url.hash = '';
  return url.href;
}

function scratchDatabaseName(): string {
  return `tayzu_bcl_replay_${randomUUID().replaceAll('-', '')}`;
}

function randomToken(): string {
  return randomBytes(16).toString('hex');
}

/** A `backchannel-logout:<clientId>:<jti>` identifier, the shape `server.ts` writes. */
function backchannelIdentifier(): string {
  return `backchannel-logout:${randomToken()}:${randomToken()}`;
}

interface EndableWithErrorEvent {
  on(event: 'error', listener: (error: unknown) => void): unknown;
  end(): Promise<void>;
}

async function endQuietly(closeable: EndableWithErrorEvent): Promise<void> {
  closeable.on('error', () => {
    // Expected only during teardown.
  });
  await closeable.end();
}

interface DatabaseError {
  readonly code: string;
  readonly constraint: string | undefined;
}

/** The Postgres error in `error` or its `cause` chain (drizzle wraps query errors). */
function databaseError(error: unknown): DatabaseError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && typeof current === 'object' && current !== null; depth += 1) {
    if ('code' in current && typeof current.code === 'string') {
      const constraint =
        'constraint' in current && typeof current.constraint === 'string'
          ? current.constraint
          : undefined;
      return { code: current.code, constraint };
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

/** Awaits `promise`, expecting a Postgres error, and returns it. */
async function databaseRejectionOf(
  promise: Promise<unknown>,
  label: string,
): Promise<DatabaseError> {
  let rejected = false;
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    rejected = true;
    caught = error;
  }
  expect(rejected, `${label}: must reject`).toBe(true);
  const found = databaseError(caught);
  expect(found, `${label}: rejects with a database error`).toBeDefined();
  return found ?? { code: '', constraint: undefined };
}

type IndexRow = {
  readonly name: string;
  readonly definition: string;
  readonly predicate: string | null;
  readonly method: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
  readonly valid: boolean;
  readonly hasExpressions: boolean;
  readonly includeColumns: number;
};

/** Every index of `auth.verification`, from `pg_indexes` joined to `pg_index`. */
async function readVerificationIndexes(pool: Pool): Promise<Map<string, IndexRow>> {
  const { rows } = await pool.query<IndexRow>(`
    select i.indexname as name,
           i.indexdef as definition,
           pg_get_expr(ix.indpred, ix.indrelid) as predicate,
           am.amname as method,
           array(
             select a.attname::text
               from unnest(ix.indkey::int2[]) with ordinality as k(attnum, ord)
               join pg_attribute a on a.attrelid = ix.indrelid and a.attnum = k.attnum
              order by k.ord
           ) as columns,
           ix.indisunique as unique,
           ix.indisvalid as valid,
           ix.indexprs is not null as "hasExpressions",
           (ix.indnatts - ix.indnkeyatts)::int as "includeColumns"
      from pg_indexes i
      join pg_namespace n on n.nspname = i.schemaname
      join pg_class c on c.relname = i.indexname and c.relnamespace = n.oid
      join pg_index ix on ix.indexrelid = c.oid
      join pg_am am on am.oid = c.relam
     where i.schemaname = 'auth'
       and i.tablename = 'verification'
     order by i.indexname
  `);
  return new Map(rows.map((row) => [row.name, row]));
}

function indexNames(indexes: ReadonlyMap<string, IndexRow>): string {
  return [...indexes.keys()].join(', ');
}

async function expectReplayIndexPresent(pool: Pool): Promise<void> {
  const indexes = await readVerificationIndexes(pool);
  expect(
    indexes.has(INDEX_NAME),
    `precondition: ${INDEX_NAME} exists on auth.verification among: ${indexNames(indexes)}`,
  ).toBe(true);
}

async function idsWithIdentifier(pool: Pool, identifier: string): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    'select id from auth.verification where identifier = $1 order by id',
    [identifier],
  );
  return rows.map(({ id }) => id);
}

async function journalCount(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ count: number }>(
    'select count(*)::int as count from drizzle.__drizzle_migrations',
  );
  return rows[0]?.count ?? -1;
}

interface JournalEntry {
  readonly idx: number;
  readonly tag: string;
  readonly when: number;
}

async function readJournalEntries(): Promise<JournalEntry[]> {
  const journal = JSON.parse(await readFile(JOURNAL_PATH, 'utf8')) as {
    entries: JournalEntry[];
  };
  return journal.entries;
}

/** The statements of a drizzle migration file, split as drizzle's migrator splits them. */
function migrationStatements(text: string): string[] {
  return text
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '');
}

interface Scratch {
  readonly name: string;
  readonly pool: Pool;
}

async function assertCreateDb(admin: Pool): Promise<void> {
  const { rows } = await admin.query<{ allowed: boolean }>(
    'select rolcreatedb or rolsuper as allowed from pg_roles where rolname = current_user',
  );
  if (rows[0]?.allowed !== true) {
    throw new Error(
      'The DATABASE_URL role needs the CREATEDB privilege: this test creates, and then drops, private scratch databases.',
    );
  }
}

async function createScratch(admin: Pool): Promise<Scratch> {
  const name = scratchDatabaseName();
  await admin.query(`create database ${escapeIdentifier(name)}`);
  return { name, pool: new Pool({ connectionString: scratchDatabaseUrl(name), max: 2 }) };
}

async function dropScratch(admin: Pool, scratch: Scratch | undefined): Promise<void> {
  if (scratch === undefined) {
    return;
  }
  await endQuietly(scratch.pool);
  await admin.query(`drop database if exists ${escapeIdentifier(scratch.name)} with (force)`);
}

/**
 * Applies the shipped migrations up to and including idx `lastIdx` through
 * drizzle's migrator, from a temporary copy of the migrations folder whose
 * journal stops there, so the scratch database's migration journal is the
 * one `runMigrations` reads afterwards.
 */
async function migrateThrough(pool: Pool, lastIdx: number): Promise<void> {
  const folder = await mkdtemp(join(tmpdir(), 'tayzu-migrations-'));
  try {
    await cp(MIGRATIONS_DIR, folder, { recursive: true });
    const journalPath = join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
      entries: JournalEntry[];
    };
    journal.entries = journal.entries.filter((entry) => entry.idx <= lastIdx);
    await writeFile(journalPath, JSON.stringify(journal, null, 2));
    await migrate(drizzle(pool), { migrationsFolder: folder });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

describe(`the migration file ${MIGRATION_TAG} (task 7.4, design D8)`, () => {
  it('is the journal entry right after 0015_catalog_entity_search', async () => {
    const entries = await readJournalEntries();
    const previous = entries.find((entry) => entry.idx === PREVIOUS_MIGRATION_IDX);
    const entry = entries.find((candidate) => candidate.tag === MIGRATION_TAG);
    expect(previous?.tag).toBe('0015_catalog_entity_search');
    expect(entry, `${MIGRATION_TAG} is in meta/_journal.json`).toBeDefined();
    expect(entry?.idx).toBe(PREVIOUS_MIGRATION_IDX + 1);
    expect((entry?.when ?? 0) > (previous?.when ?? Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('creates the partial unique index and has no dedupe statement before it', async () => {
    const statements = migrationStatements(await readFile(MIGRATION_PATH, 'utf8'));
    expect(statements).toHaveLength(1);
    const [statement] = statements;
    expect(statement).toMatch(/^CREATE UNIQUE INDEX "verification_backchannel_logout_uq"/);
    for (const candidate of statements) {
      expect(candidate, 'no statement deletes, updates or truncates rows').not.toMatch(
        /^\s*(delete|update|truncate|insert|merge)\b/i,
      );
    }
  });
});

describe(`${INDEX_NAME} on the migrated database (task 7.4, design D8)`, () => {
  let owner: Pool;
  let auth: Pool;
  const writtenIds: string[] = [];

  async function insertAsAuth(statement: string, identifier: string) {
    const id = randomUUID();
    writtenIds.push(id);
    return auth.query(statement, [id, identifier]);
  }

  beforeAll(async () => {
    // Migrates the shared database once (the harness).
    await getTestDatabase();
    owner = await getOwnerPool();
    auth = (await getAuthTestDatabase()).pool;
  }, 60_000);

  afterAll(async () => {
    if (writtenIds.length > 0) {
      await owner.query('delete from auth.verification where id = any($1::text[])', [writtenIds]);
    }
  });

  it('exists with its exact predicate, as a valid unique btree on (identifier)', async () => {
    const indexes = await readVerificationIndexes(owner);
    const row = indexes.get(INDEX_NAME);
    expect(
      row,
      `${INDEX_NAME} exists on auth.verification among: ${indexNames(indexes)}`,
    ).toBeDefined();
    expect(row?.definition).toBe(EXPECTED_INDEXDEF);
    expect(row?.predicate).toBe(EXPECTED_PREDICATE);
    expect({
      method: row?.method,
      columns: row?.columns,
      unique: row?.unique,
      valid: row?.valid,
      hasExpressions: row?.hasExpressions,
      includeColumns: row?.includeColumns,
    }).toEqual({
      method: 'btree',
      columns: ['identifier'],
      unique: true,
      valid: true,
      hasExpressions: false,
      includeColumns: 0,
    });
  });

  it('keeps verification_identifier_idx, the non-unique index every family uses', async () => {
    const row = (await readVerificationIndexes(owner)).get(EXISTING_IDENTIFIER_INDEX);
    expect(row?.unique).toBe(false);
    expect(row?.predicate).toBeNull();
    expect(row?.columns).toEqual(['identifier']);
  });

  it('a second backchannel-logout: row with the same identifier is refused (unique_violation)', async () => {
    await expectReplayIndexPresent(owner);
    const identifier = backchannelIdentifier();

    // GIVEN a recorded back-channel logout token.
    const first = await insertAsAuth(PLAIN_INSERT, identifier);
    expect(first.rowCount).toBe(1);

    // WHEN a second row with the same identifier is inserted.
    const error = await databaseRejectionOf(
      insertAsAuth(PLAIN_INSERT, identifier),
      'the second backchannel-logout: insert',
    );

    // THEN it is refused by the replay index.
    expect(error.code).toBe(UNIQUE_VIOLATION);
    expect(error.constraint).toBe(INDEX_NAME);

    // AND only the first row exists.
    expect(await idsWithIdentifier(owner, identifier)).toHaveLength(1);
  });

  it("D8's replay insert uses the index as its arbiter: the second delivery inserts no row", async () => {
    await expectReplayIndexPresent(owner);
    const identifier = backchannelIdentifier();

    const first = await insertAsAuth(REPLAY_INSERT, identifier);
    expect(first.rowCount).toBe(1);

    const second = await insertAsAuth(REPLAY_INSERT, identifier);
    expect(second.rowCount).toBe(0);

    expect(await idsWithIdentifier(owner, identifier)).toHaveLength(1);
  });

  it('two rows of another family (sso-reauth-state:) with one identifier are still accepted', async () => {
    await expectReplayIndexPresent(owner);
    const identifier = `sso-reauth-state:${randomToken()}`;

    const first = await insertAsAuth(PLAIN_INSERT, identifier);
    const second = await insertAsAuth(PLAIN_INSERT, identifier);

    expect(first.rowCount).toBe(1);
    expect(second.rowCount).toBe(1);
    expect(await idsWithIdentifier(owner, identifier)).toHaveLength(2);
  });

  it('two rows whose identifier only contains backchannel-logout: (not as a prefix) are still accepted', async () => {
    await expectReplayIndexPresent(owner);
    const identifier = `step-up-verified:backchannel-logout:${randomToken()}`;

    const first = await insertAsAuth(PLAIN_INSERT, identifier);
    const second = await insertAsAuth(PLAIN_INSERT, identifier);

    expect(first.rowCount).toBe(1);
    expect(second.rowCount).toBe(1);
    expect(await idsWithIdentifier(owner, identifier)).toHaveLength(2);
  });
});

describe(`${MIGRATION_TAG} over pre-existing duplicate backchannel-logout: rows (task 7.4, design D8)`, () => {
  let admin: Pool;
  let scratch: Scratch | undefined;
  const identifier = backchannelIdentifier();
  const duplicateIds = [randomUUID(), randomUUID()].sort();
  const otherIdentifier = `sso-reauth-state:${randomToken()}`;
  const otherIds = [randomUUID(), randomUUID()].sort();
  let journalBefore = -1;

  function pool(): Pool {
    if (scratch === undefined) {
      throw new Error('the scratch database was not created');
    }
    return scratch.pool;
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl(), max: 1 });
    await assertCreateDb(admin);
    scratch = await createScratch(admin);

    // GIVEN a database migrated through 0015 only ...
    await migrateThrough(scratch.pool, PREVIOUS_MIGRATION_IDX);
    journalBefore = await journalCount(scratch.pool);

    // ... AND two back-channel rows with one identifier (and two of another family).
    for (const id of duplicateIds) {
      await scratch.pool.query(PLAIN_INSERT, [id, identifier]);
    }
    for (const id of otherIds) {
      await scratch.pool.query(PLAIN_INSERT, [id, otherIdentifier]);
    }
  }, 120_000);

  afterAll(async () => {
    await dropScratch(admin, scratch);
    await endQuietly(admin);
  }, 60_000);

  it('the scratch database is at 0015, without the index, holding both duplicates', async () => {
    expect(journalBefore).toBe(PREVIOUS_MIGRATION_IDX + 1);
    expect((await readVerificationIndexes(pool())).has(INDEX_NAME)).toBe(false);
    expect(await idsWithIdentifier(pool(), identifier)).toEqual(duplicateIds);
  });

  it('runMigrations fails with a unique violation on the index, records nothing and deletes nothing', async () => {
    // WHEN the pending migration (0016) is applied through the migration runner.
    const error = await databaseRejectionOf(
      runMigrations(pool()),
      'runMigrations over duplicate backchannel-logout: rows',
    );

    // THEN the index build fails loudly with a unique violation.
    expect(error.code).toBe(UNIQUE_VIOLATION);
    expect(error.constraint).toBe(INDEX_NAME);

    // AND the migration's transaction aborted: no journal row, no index.
    expect(await journalCount(pool())).toBe(journalBefore);
    expect((await readVerificationIndexes(pool())).has(INDEX_NAME)).toBe(false);

    // AND nothing was deleted.
    expect(await idsWithIdentifier(pool(), identifier)).toEqual(duplicateIds);
    expect(await idsWithIdentifier(pool(), otherIdentifier)).toEqual(otherIds);
  });

  it("applying 0016's SQL file in one transaction fails the same way and deletes nothing", async () => {
    const statements = migrationStatements(await readFile(MIGRATION_PATH, 'utf8'));
    expect(statements.length).toBeGreaterThan(0);

    const client = await pool().connect();
    const applyInOneTransaction = async (): Promise<void> => {
      await client.query('begin');
      try {
        for (const statement of statements) {
          await client.query(statement);
        }
      } finally {
        await client.query('rollback');
      }
    };
    const error = await databaseRejectionOf(
      applyInOneTransaction().finally(() => {
        client.release();
      }),
      "0016's SQL over duplicate backchannel-logout: rows",
    );

    expect(error.code).toBe(UNIQUE_VIOLATION);
    expect(error.constraint).toBe(INDEX_NAME);
    expect((await readVerificationIndexes(pool())).has(INDEX_NAME)).toBe(false);
    expect(await idsWithIdentifier(pool(), identifier)).toEqual(duplicateIds);
    expect(await idsWithIdentifier(pool(), otherIdentifier)).toEqual(otherIds);
  });
});

describe(`the down script of ${MIGRATION_TAG} (task 7.4, design D8)`, () => {
  let admin: Pool;
  let scratch: Scratch | undefined;
  let before: ReadonlyMap<string, IndexRow> = new Map();

  function pool(): Pool {
    if (scratch === undefined) {
      throw new Error('the scratch database was not created');
    }
    return scratch.pool;
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl(), max: 1 });
    await assertCreateDb(admin);
    // A scratch database of its own: the down script never runs against the
    // shared database.
    scratch = await createScratch(admin);
    await runMigrations(scratch.pool);
    before = await readVerificationIndexes(scratch.pool);
  }, 120_000);

  afterAll(async () => {
    await dropScratch(admin, scratch);
    await endQuietly(admin);
  }, 60_000);

  it('the fully migrated scratch database has the index before the down script runs', () => {
    expect(before.has(INDEX_NAME), `${INDEX_NAME} among: ${indexNames(before)}`).toBe(true);
  });

  it('removes the index, keeps every other index of auth.verification, and duplicates are accepted again', async () => {
    const downScript = await readFile(DOWN_SCRIPT_PATH, 'utf8');
    await pool().query(downScript);

    const after = await readVerificationIndexes(pool());
    expect(after.has(INDEX_NAME), `${INDEX_NAME} is gone after the down script`).toBe(false);
    expect([...after.keys()].sort()).toEqual(
      [...before.keys()].filter((name) => name !== INDEX_NAME).sort(),
    );
    expect(after.get(EXISTING_IDENTIFIER_INDEX)).toBeDefined();

    const identifier = backchannelIdentifier();
    await pool().query(PLAIN_INSERT, [randomUUID(), identifier]);
    await pool().query(PLAIN_INSERT, [randomUUID(), identifier]);
    expect(await idsWithIdentifier(pool(), identifier)).toHaveLength(2);
  });
});
