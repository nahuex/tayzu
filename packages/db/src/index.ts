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
import './pg-type-parsers.js';

export {
  setTenantContext,
  withTenantTransaction,
  type TenantTransactionContext,
  type WithTenantTransactionOptions,
} from './tenant-tx.js';

/**
 * The runtime database roles: every login role the migrations create except
 * the migration role, `tayzu_migrator` (048 design D1). `db:migrate` refuses
 * to run as any of them. The list is hand-kept; a role added by a migration
 * must be added here too.
 */
export const RUNTIME_DATABASE_ROLES: readonly string[] = Object.freeze([
  'tayzu_app',
  'tayzu_auth',
  'tayzu_purge',
  'tayzu_deletion_admin',
]);

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Advisory-lock key that serializes concurrent `runMigrations` calls against
 * the same database (design D12: Turborepo and Vitest can start several
 * migration runners at once on a fresh database). Drizzle's own migrator has
 * no locking of its own: without this, concurrent runners could each decide
 * the journal is empty and apply, and record, the same migration twice.
 */
const MIGRATION_LOCK_KEY = 848_432_001;

export interface CreatePoolOptions {
  /**
   * The environment variable that held `url`, named in the TLS error
   * (048 design D1). Defaults to `DATABASE_URL`.
   */
  readonly variable?: string;
}

/**
 * Builds a pool for `url`. Outside the test harness (`getTestDatabase`),
 * `url` must set `sslmode=verify-full` (design D5); this is checked before
 * any connection is attempted, and no argument of this function can turn the
 * check off.
 */
export function createPool(url: string, options: CreatePoolOptions = {}): Pool {
  assertVerifiedTls(url, options.variable);
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
