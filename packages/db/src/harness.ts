/**
 * Test-only Postgres harness (task 1.5; design D5 and D12). Not part of the
 * package's public entry point (`package.json` `exports`): only the test
 * harness may connect to a local database without TLS, so production code
 * must reach `@tayzu/db` only through `./index.ts`, which does not re-export
 * this module.
 */
import { Pool } from 'pg';

import { assertVerifiedTlsOrLocal } from './connection-security.js';
import { runMigrations } from './index.js';

const MISSING_DATABASE_URL_MESSAGE = [
  'DATABASE_URL is not set: the test harness needs a real PostgreSQL 16 database.',
  'Export a connection string before running it, for example:',
  '  export DATABASE_URL=postgres://<user>:<password>@localhost:5432/tayzu_test',
  'To run only the unit tests instead, use `pnpm test:unit`. See CLAUDE.md, "Running tests".',
].join('\n');

export interface TestDatabase {
  readonly pool: Pool;
}

/** Memoized across concurrent callers within the same process (module instance). */
let testDatabase: Promise<TestDatabase> | undefined;

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim() === '') {
    throw new Error(MISSING_DATABASE_URL_MESSAGE);
  }
  return url;
}

async function initializeTestDatabase(): Promise<TestDatabase> {
  const url = requireDatabaseUrl();
  assertVerifiedTlsOrLocal(url);
  const pool = new Pool({ connectionString: url });
  await runMigrations(pool);
  return { pool };
}

/**
 * Returns a pool on the database named by `DATABASE_URL`, migrated once per
 * process: concurrent callers share the same initialization, so migrations
 * run once even when several test files ask for it at the same time. Throws
 * the explicit `MISSING_DATABASE_URL_MESSAGE` when the variable is unset, and
 * refuses a non-TLS URL that is not local (design D5), both before any
 * connection is attempted.
 */
export function getTestDatabase(): Promise<TestDatabase> {
  testDatabase ??= initializeTestDatabase();
  const current = testDatabase;
  void current.catch(() => {
    // A failed initialization (for example a database that is not actually
    // reachable) must not be cached forever: a later call gets a fresh try.
    if (testDatabase === current) {
      testDatabase = undefined;
    }
  });
  return current;
}
