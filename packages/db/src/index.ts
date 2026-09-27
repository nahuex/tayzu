/**
 * @tayzu/db: the PostgreSQL pool, the tenant transaction seam for RLS, the
 * migration runner, and the migrations directory.
 *
 * This package never imports a capability package (design D1).
 */
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

import { assertVerifiedTls } from './connection-security.js';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Advisory-lock key that serializes concurrent `runMigrations` calls against
 * the same database (design D12: Turborepo and Vitest can start several
 * migration runners at once on a fresh database). Drizzle's own migrator has
 * no locking of its own: without this, concurrent runners could each decide
 * the journal is empty and apply, and record, the same migration twice.
 */
const MIGRATION_LOCK_KEY = 848_432_001;

/**
 * Builds a pool for `url`. Outside the test harness (`getTestDatabase`),
 * `url` must set `sslmode=verify-full` (design D5); this is checked before
 * any connection is attempted, and no argument of this function can turn the
 * check off.
 */
export function createPool(url: string): Pool {
  assertVerifiedTls(url);
  return new Pool({ connectionString: url });
}

/**
 * Applies every migration in `migrations/` to `pool`'s database that is not
 * already recorded in the migration journal, holding a session-level
 * advisory lock for the duration so that concurrent callers serialize
 * instead of racing (design D12).
 */
export async function runMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
