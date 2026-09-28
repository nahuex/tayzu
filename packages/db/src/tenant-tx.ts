/**
 * Tenant transaction seam for RLS (design D5, task 5.2).
 *
 * `withTenantTransaction` opens a transaction on a connection from `pool`,
 * sets `app.tenant_id` and `statement_timeout` transaction-local through
 * `set_config(..., true)` bind parameters (never string interpolation, per
 * SSA finding B1), runs `fn` on that connection, commits on success, and
 * rolls back and rethrows on any error (including one thrown by `fn`). The
 * client is always released back to `pool`.
 *
 * `@tayzu/db` never imports `@tayzu/catalog` (design D1), so
 * `TenantTransactionContext` is a local, structural type: a `CatalogContext`
 * value satisfies it without an import.
 */
import type { Pool, PoolClient } from 'pg';

export interface TenantTransactionContext {
  readonly tenantId: string;
}

export interface WithTenantTransactionOptions {
  /** Statement timeout for the transaction, in milliseconds. Defaults to 5 s (design D5). */
  readonly statementTimeoutMs?: number;
}

/** Design D5: "`$2` defaults to 5 s". */
const DEFAULT_STATEMENT_TIMEOUT_MS = 5_000;

/**
 * Sets `app.tenant_id` and `statement_timeout` on `client`, transaction-local
 * (`set_config(..., true)`), through bind parameters only. Performs no
 * validation of its own: `withTenantTransaction` is the only caller, and it
 * only ever passes an already-validated `tenantId` (`parseCatalogContext`'s
 * pattern), never untrusted input.
 */
export async function setTenantContext(
  client: PoolClient,
  tenantId: string,
  statementTimeoutMs: number = DEFAULT_STATEMENT_TIMEOUT_MS,
): Promise<void> {
  await client.query(
    `select set_config('app.tenant_id', $1, true), set_config('statement_timeout', $2, true)`,
    [tenantId, String(statementTimeoutMs)],
  );
}

/**
 * Runs `fn` inside a transaction with `app.tenant_id` and `statement_timeout`
 * already set (design D5). Commits on success. Rolls back and rethrows on any
 * error, including one `fn` throws. Always releases the client back to
 * `pool`, whether the transaction committed, rolled back, or the rollback
 * itself failed.
 */
export async function withTenantTransaction<T>(
  pool: Pool,
  ctx: TenantTransactionContext,
  fn: (client: PoolClient) => Promise<T>,
  options: WithTenantTransactionOptions = {},
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await setTenantContext(client, ctx.tenantId, options.statementTimeoutMs);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}
