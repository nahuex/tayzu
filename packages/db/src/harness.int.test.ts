import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client, escapeIdentifier, Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { getTestDatabase } from './harness.js';
import { runMigrations } from './index.js';

/**
 * Integration tests for the Postgres harness of `@tayzu/db` (task 1.5; design
 * D5 and D12). They run against the real PostgreSQL 16 database named by
 * `DATABASE_URL`, which the `int` project's global setup requires.
 *
 * Task 1.5: "`createPool(url)` and `runMigrations(pool)`", and "A test helper
 * `getTestDatabase()` that applies migrations once per run". D12: "Migrations
 * are applied once per run", and tests "run in parallel without truncation".
 *
 * What "applied" means. The Migration Plan fixes the migrations: drizzle-kit
 * generates them into `packages/db/migrations/`, with its journal in
 * `migrations/meta/_journal.json`. Drizzle's migrator records every applied
 * migration in its journal table (`drizzle.__drizzle_migrations` by default)
 * with `hash` = the SHA-256 of the migration's `.sql` file and `created_at` =
 * the journal entry's `when`. These tests require the database journal to
 * hold exactly the migrations the package ships, each once. The journal table
 * is found by shape (the one user table whose name contains "migration" and
 * that has `hash` and `created_at` columns), so a configured table or schema
 * name is fine. Task 1.5 ships no migration yet: an empty `entries` array is
 * valid, and then the journal must exist and be empty. From
 * `0000_catalog_core` on, the same assertions require it to be recorded.
 *
 * What "once per run" means. These tests do not fix where the migrations run:
 * `getTestDatabase()` may apply them itself (memoized in the test file), or
 * the `int` project's global setup may apply them before any file runs. Both
 * designs are observed the same way: a separate Vitest run of this package,
 * pointed at a fresh database, ends with that database migrated, and every
 * `getTestDatabase()` caller gets a pool on it. Runs overlap in any design:
 * Turborepo runs the packages' test tasks in parallel, and Vitest runs test
 * files in parallel, all against the same `DATABASE_URL`. So `runMigrations`
 * must be safe when several runners start at once on a fresh database.
 *
 * Scratch databases. The tests that need a fresh database create a private
 * one with a random name through the `DATABASE_URL` role, and drop it
 * afterwards. They never touch shared tables. The role therefore needs the
 * `CREATEDB` privilege (the user of the CI `postgres:16` service is a
 * superuser).
 */

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const THIS_FILE = 'src/harness.int.test.ts';

/** How many `runMigrations` calls start at once on each fresh database. */
const CONCURRENT_RUNNERS = 4;
/** How many fresh databases the concurrency test migrates. */
const CONCURRENCY_ROUNDS = 3;

/**
 * The suite that must pass in any run, whichever database `DATABASE_URL`
 * names. It runs in this run against the shared database, and again in a
 * separate Vitest run against a fresh scratch database (see below).
 */
const RUN_SUITE = 'getTestDatabase() on the DATABASE_URL database of the run';
const RUN_SUITE_TESTS = {
  concurrentCallers:
    'every concurrent caller waits for the migrations and gets a pool on the DATABASE_URL database',
  selectOne: 'runs select 1 through the pool it returns',
  journal:
    'the migration journal records exactly the migrations the package ships (an empty set is valid)',
} as const;

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim() === '') {
    throw new Error(
      'DATABASE_URL is not set: the int project global setup should have stopped this run.',
    );
  }
  return url;
}

/** The database and role that pg itself derives from a connection string. */
function expectedTarget(url: string): { database: string | undefined; role: string | undefined } {
  const client = new Client({ connectionString: url });
  return { database: client.database, role: client.user };
}

async function expectTargets(pool: Pool, url: string): Promise<void> {
  const { rows } = await pool.query<{ database: string; role: string }>(
    'select current_database() as database, current_user as role',
  );
  expect(rows).toEqual([expectedTarget(url)]);
}

interface AppliedMigration {
  readonly hash: string;
  readonly createdAt: string;
}

function sortMigrations(migrations: readonly AppliedMigration[]): AppliedMigration[] {
  return [...migrations].sort((a, b) =>
    `${a.createdAt} ${a.hash}`.localeCompare(`${b.createdAt} ${b.hash}`),
  );
}

/** The migrations the package ships, as drizzle records them once applied. */
async function readShippedMigrations(): Promise<AppliedMigration[]> {
  let journalText: string;
  try {
    journalText = await readFile(new URL('meta/_journal.json', MIGRATIONS_DIR), 'utf8');
  } catch (error) {
    throw new Error(
      'packages/db/migrations/meta/_journal.json is missing. The package ships its drizzle-kit migration journal there (Migration Plan); an empty "entries" array is valid until 0000_catalog_core lands.',
      { cause: error },
    );
  }
  const journal = JSON.parse(journalText) as { entries?: unknown };
  if (!Array.isArray(journal.entries)) {
    throw new Error('packages/db/migrations/meta/_journal.json has no "entries" array.');
  }

  const shipped: AppliedMigration[] = [];
  for (const entry of journal.entries as readonly { tag: string; when: number }[]) {
    const sql = await readFile(new URL(`${entry.tag}.sql`, MIGRATIONS_DIR), 'utf8');
    shipped.push({
      hash: createHash('sha256').update(sql).digest('hex'),
      createdAt: String(entry.when),
    });
  }
  return sortMigrations(shipped);
}

interface TableName {
  readonly schema: string;
  readonly table: string;
}

const USER_SCHEMAS = `
  table_schema not in ('pg_catalog', 'information_schema')
  and table_schema not like 'pg\\_%'
`;

/** User tables shaped like drizzle's migration journal. */
async function findJournalTables(pool: Pool): Promise<TableName[]> {
  const { rows } = await pool.query<TableName>(
    `select table_schema as schema, table_name as "table"
       from information_schema.tables
       join information_schema.columns using (table_schema, table_name)
      where table_type = 'BASE TABLE'
        and ${USER_SCHEMAS}
        and table_name ilike '%migration%'
      group by table_schema, table_name
     having bool_or(column_name = 'hash') and bool_or(column_name = 'created_at')
      order by 1, 2`,
  );
  return rows;
}

/** The rows of the database's migration journal. */
async function readAppliedMigrations(pool: Pool): Promise<AppliedMigration[]> {
  const journals = await findJournalTables(pool);
  expect(
    journals,
    'after migrations, the database has exactly one migration journal table (with hash and created_at)',
  ).toHaveLength(1);
  const [journal] = journals;
  if (journal === undefined) {
    return [];
  }

  const { rows } = await pool.query<AppliedMigration>(
    `select hash, created_at::text as "createdAt"
       from ${escapeIdentifier(journal.schema)}.${escapeIdentifier(journal.table)}`,
  );
  return sortMigrations(rows);
}

async function expectJournalMatchesShippedMigrations(pool: Pool): Promise<void> {
  const applied = await readAppliedMigrations(pool);

  expect(new Set(applied.map(({ hash }) => hash)).size, 'no migration recorded twice').toBe(
    applied.length,
  );
  expect(applied).toEqual(await readShippedMigrations());
}

interface SchemaState {
  readonly tables: readonly string[];
  readonly columns: readonly string[];
  readonly indexes: readonly string[];
}

/** The shape of every user schema: tables, columns and indexes. */
async function readSchemaState(pool: Pool): Promise<SchemaState> {
  const tables = await pool.query<{ name: string }>(
    `select table_schema || '.' || table_name as name
       from information_schema.tables
      where ${USER_SCHEMAS}
      order by 1`,
  );
  const columns = await pool.query<{ name: string }>(
    `select table_schema || '.' || table_name || '.' || column_name || ' ' || data_type as name
       from information_schema.columns
      where ${USER_SCHEMAS}
      order by 1`,
  );
  const indexes = await pool.query<{ name: string }>(
    `select indexdef as name
       from pg_indexes
      where schemaname not in ('pg_catalog', 'information_schema')
        and schemaname not like 'pg\\_%'
      order by 1`,
  );
  return {
    tables: tables.rows.map(({ name }) => name),
    columns: columns.rows.map(({ name }) => name),
    indexes: indexes.rows.map(({ name }) => name),
  };
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

/**
 * Ends a pool or client that is about to be torn down, with an 'error'
 * listener attached first. `dropScratchDatabase` below waits for a scratch
 * database's sessions to go away before dropping it, but that wait has a
 * deadline: if a caller's own pool has not quite finished closing by then
 * (a leak, or just an unlucky scheduling delay), the final `with (force)`
 * still has to terminate it, and that termination can report back to the
 * pool as SQLSTATE 57P01 ("terminating connection due to administrator
 * command") after this file has already stopped awaiting anything on it.
 * Without a listener, that stray event is an unhandled 'error' event
 * instead of something any assertion here could explain.
 */
async function endQuietly(closeable: {
  on(event: 'error', listener: (error: unknown) => void): unknown;
  end(): Promise<void>;
}): Promise<void> {
  closeable.on('error', () => {
    // Expected only during teardown; nothing left to report it to.
  });
  await closeable.end();
}

/**
 * Drops a scratch database once its connections are gone. `Pool#end()`
 * resolves before the server has closed the sessions, and terminating a
 * session that is still closing makes pg raise an uncaught error in this
 * process, so this waits for the sessions to go away first. Only a session
 * that is still open after the wait (a leak) is terminated.
 */
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
 * Creates a private, empty database, runs `action` with its connection
 * string, and drops the database afterwards.
 */
async function withScratchDatabase(action: (url: string) => Promise<void>): Promise<void> {
  const admin = new Client({ connectionString: databaseUrl() });
  await admin.connect();
  try {
    const privilege = await admin.query<{ allowed: boolean }>(
      'select rolcreatedb or rolsuper as allowed from pg_roles where rolname = current_user',
    );
    if (privilege.rows[0]?.allowed !== true) {
      throw new Error(
        'The DATABASE_URL role needs the CREATEDB privilege: these tests create, and then drop, private scratch databases.',
      );
    }

    const name = `tayzu_scratch_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`create database ${escapeIdentifier(name)}`);
    try {
      const url = scratchDatabaseUrl(name);
      const probe = new Pool({ connectionString: url });
      try {
        await expectTargets(probe, url);
        expect(await findJournalTables(probe), 'a fresh database has no migration journal').toEqual(
          [],
        );
      } finally {
        await endQuietly(probe);
      }

      await action(url);
    } finally {
      await dropScratchDatabase(admin, name);
    }
  } finally {
    await endQuietly(admin);
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Removes a connection string, and its password, from text that a test may print. */
function redact(text: string, url: string): string {
  const { password } = new URL(url);
  const redacted = text.replaceAll(url, '<DATABASE_URL>');
  return password === '' ? redacted : redacted.replaceAll(password, '<password>');
}

interface SeparateRun {
  readonly exitCode: number | null;
  readonly output: string;
  readonly results: readonly { readonly title: string; readonly status: string }[];
}

/**
 * Runs `RUN_SUITE` of this file in a separate Vitest run of this package (its
 * own `int` project, with its global setup), with `DATABASE_URL` set to
 * `url`. Only the tests of `RUN_SUITE` run there, so this never recurses.
 */
async function runSuiteInSeparateRun(url: string): Promise<SeparateRun> {
  const vitestManifestPath = createRequire(import.meta.url).resolve('vitest/package.json');
  const vitestManifest = JSON.parse(await readFile(vitestManifestPath, 'utf8')) as {
    bin: { vitest: string };
  };
  const vitestBin = join(dirname(vitestManifestPath), vitestManifest.bin.vitest);

  // The separate run gets this process's environment without the variables
  // that describe the current Vitest worker, and with the fresh database.
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('VITEST') && !key.startsWith('__VITEST')) {
      env[key] = value;
    }
  }
  env.DATABASE_URL = url;

  const reportDir = await mkdtemp(join(tmpdir(), 'tayzu-db-harness-'));
  const reportFile = join(reportDir, 'report.json');
  try {
    const child = spawn(
      process.execPath,
      [
        vitestBin,
        'run',
        '--project',
        '*int*',
        '--testNamePattern',
        escapeRegExp(RUN_SUITE),
        '--reporter=json',
        `--outputFile=${reportFile}`,
        THIS_FILE,
      ],
      { cwd: PACKAGE_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });

    let results: SeparateRun['results'] = [];
    try {
      const report = JSON.parse(await readFile(reportFile, 'utf8')) as {
        testResults: readonly {
          assertionResults: readonly {
            ancestorTitles: readonly string[];
            title: string;
            status: string;
          }[];
        }[];
      };
      results = report.testResults
        .flatMap(({ assertionResults }) => assertionResults)
        .filter(({ ancestorTitles }) => ancestorTitles.includes(RUN_SUITE))
        .map(({ title, status }) => ({ title, status }));
    } catch {
      output += '\n(The separate run wrote no JSON report.)';
    }
    return { exitCode, output: redact(output, url), results };
  } finally {
    await rm(reportDir, { recursive: true, force: true });
  }
}

describe(RUN_SUITE, () => {
  it(RUN_SUITE_TESTS.concurrentCallers, { timeout: 30_000 }, async () => {
    const url = databaseUrl();

    const databases = await Promise.all([getTestDatabase(), getTestDatabase(), getTestDatabase()]);

    for (const { pool } of databases) {
      expect(pool).toBeInstanceOf(Pool);
      await expectTargets(pool, url);
      await expectJournalMatchesShippedMigrations(pool);
    }
  });

  it(RUN_SUITE_TESTS.selectOne, async () => {
    const { pool } = await getTestDatabase();

    const result = await pool.query<{ one: number }>('select 1 as one');

    expect(result.rows).toEqual([{ one: 1 }]);
    await expectTargets(pool, databaseUrl());
  });

  it(RUN_SUITE_TESTS.journal, async () => {
    const { pool } = await getTestDatabase();

    await expectJournalMatchesShippedMigrations(pool);
  });
});

describe('runMigrations against a real PostgreSQL 16', () => {
  it(
    'applies exactly the shipped migrations to a fresh database when several runners start at once, as parallel test files and packages do, and a later run changes nothing',
    { timeout: 60_000 },
    async () => {
      for (let round = 0; round < CONCURRENCY_ROUNDS; round += 1) {
        await withScratchDatabase(async (url) => {
          const pools = Array.from(
            { length: CONCURRENT_RUNNERS },
            () => new Pool({ connectionString: url }),
          );
          const [first] = pools;
          if (first === undefined) {
            throw new Error('CONCURRENT_RUNNERS must be at least 1.');
          }
          try {
            const outcomes = await Promise.allSettled(pools.map((pool) => runMigrations(pool)));
            expect(
              outcomes.map((outcome) =>
                outcome.status === 'fulfilled'
                  ? 'fulfilled'
                  : `rejected: ${String(outcome.reason)}`,
              ),
            ).toEqual(pools.map(() => 'fulfilled'));
            await expectJournalMatchesShippedMigrations(first);
            const migrated = await readSchemaState(first);

            await Promise.all(pools.map((pool) => runMigrations(pool)));

            await expectJournalMatchesShippedMigrations(first);
            expect(await readSchemaState(first)).toEqual(migrated);
          } finally {
            await Promise.all(pools.map((pool) => endQuietly(pool)));
          }
        });
      }
    },
  );
});

describe('a separate test run against a fresh database', () => {
  it(
    'migrates the database its DATABASE_URL names, whether getTestDatabase() or the int global setup applies the migrations',
    { timeout: 120_000 },
    async () => {
      await withScratchDatabase(async (url) => {
        const run = await runSuiteInSeparateRun(url);

        expect(run.exitCode, run.output).toBe(0);
        expect(run.results, run.output).toEqual(
          Object.values(RUN_SUITE_TESTS).map((title) => ({ title, status: 'passed' })),
        );

        // The database was fresh, so the migrations were applied by that run,
        // to the database its DATABASE_URL names.
        const pool = new Pool({ connectionString: url });
        try {
          await expectJournalMatchesShippedMigrations(pool);
        } finally {
          await endQuietly(pool);
        }
      });
    },
  );
});
