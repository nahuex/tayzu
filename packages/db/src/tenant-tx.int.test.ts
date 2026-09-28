/**
 * Integration test for task 5.2 (design D5, D3; SSA finding B1).
 *
 * ## Module under test and assumed API
 *
 * `./tenant-tx.js` does not exist yet (red phase). This test assumes the
 * following exported shape, which is the minimum the design's Verify clause
 * needs:
 *
 * ```ts
 * export interface TenantTransactionContext {
 *   readonly tenantId: string;
 * }
 *
 * export interface WithTenantTransactionOptions {
 *   readonly statementTimeoutMs?: number; // default 5000 (design D5, "$2 defaults to 5 s")
 * }
 *
 * // Runs `fn` inside a transaction that has already set `app.tenant_id` and
 * // `statement_timeout` through `set_config(..., true)` (transaction-local,
 * // bind parameters only â€” never string interpolation, per B1). Commits on
 * // success, rolls back and rethrows on any error. Always releases the
 * // client back to `pool`.
 * export function withTenantTransaction<T>(
 *   pool: Pool,
 *   ctx: TenantTransactionContext,
 *   fn: (client: PoolClient) => Promise<T>,
 *   options?: WithTenantTransactionOptions,
 * ): Promise<T>;
 *
 * // The low-level setter `withTenantTransaction` calls internally, exported
 * // so a caller (or this test) can exercise it directly with a raw string
 * // that `parseCatalogContext`'s tenantId pattern would reject (for example
 * // one containing a quote), which is exactly how B1's bind-parameter-safety
 * // guarantee is proven independently of that pattern. It performs no
 * // validation of its own: `withTenantTransaction` is the one that only ever
 * // receives an already-validated `tenantId`.
 * export function setTenantContext(
 *   client: PoolClient,
 *   tenantId: string,
 *   statementTimeoutMs?: number,
 * ): Promise<void>;
 * ```
 *
 * `@tayzu/db` never imports `@tayzu/catalog` (design D1), so
 * `TenantTransactionContext` is a local, structural type (just `tenantId`),
 * not the catalog's `CatalogContext`. A `CatalogContext` value satisfies it
 * structurally, without an import.
 *
 * ## Why this test connects the way it does
 *
 * This test needs to observe GUC state across statements on one specific
 * physical connection (current_setting before/after commit, on the very
 * connection `withTenantTransaction` used), and it needs a `pg_sleep` call
 * that is not RE2-limited or otherwise affected by the rest of the stack. It
 * therefore builds its own dedicated `pg.Pool` with `max: 1` directly against
 * `DATABASE_URL` (same pattern as `harness.int.test.ts`, which already
 * constructs `Pool`/`Client` directly in its own tests), so every `.connect()`
 * call in this file returns the same underlying connection. No migration is
 * needed: nothing here touches a catalog table. The one exception is a tiny
 * scratch marker table this file creates and drops itself, used only to prove
 * that a thrown error rolls back writes made inside `fn`.
 */
import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setTenantContext, withTenantTransaction } from './tenant-tx.js';

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim() === '') {
    throw new Error(
      'DATABASE_URL is not set: the int project global setup should have stopped this run.',
    );
  }
  return url;
}

function randomTenantId(): string {
  // Matches the catalog's tenantId pattern (^[A-Za-z0-9_-]{1,64}$), so it is
  // representative of a value `parseCatalogContext` would actually accept.
  return `t${randomUUID().replaceAll('-', '')}`;
}

const MARKER_TABLE = 'tenant_tx_rollback_marker';

/**
 * Ends a pool or client that is about to be torn down, with an 'error'
 * listener attached first. This file's own `pool` never drops a database,
 * but `harness.int.test.ts` in this same package does create and drop
 * private scratch databases, and `drop database ... with (force)` there can
 * occasionally report SQLSTATE 57P01 ("terminating connection due to
 * administrator command") back to a connection that is itself already
 * mid-`.end()` (`Pool#end()`/`Client#end()` resolve once every client has
 * been told to end, not once the server side has actually finished closing
 * it). Without a listener, a stray event like that on this file's own pool
 * would be an unhandled 'error' event, not something an assertion here
 * could ever explain.
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

/** PostgreSQL's SQLSTATE for a statement cancelled by `statement_timeout`. */
const STATEMENT_TIMEOUT_SQLSTATE = '57014';

interface PgError {
  readonly code?: string;
}

function hasStringCode(candidate: unknown): candidate is PgError {
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    'code' in candidate &&
    typeof (candidate as { code?: unknown }).code === 'string'
  );
}

// Mirrors schema-hardening.int.test.ts's unwrapping: whatever throws (the raw
// `pg` driver error, or a wrapper around it), walk `.cause` until an object
// with a string `code` turns up.
function pgErrorOf(error: unknown): PgError {
  let candidate: unknown = error;
  while (candidate !== undefined && candidate !== null) {
    if (hasStringCode(candidate)) {
      return candidate;
    }
    candidate = candidate instanceof Error ? candidate.cause : undefined;
  }
  return {};
}

async function readCurrentTenantSetting(client: PoolClient): Promise<string | null> {
  // The `true` (missing_ok) argument avoids an error when the GUC was never
  // set at session level, which is exactly the state after the owning
  // transaction commits or rolls back.
  const result = await client.query<{ value: string | null }>(
    `select current_setting('app.tenant_id', true) as value`,
  );
  return result.rows[0]?.value ?? null;
}

describe('withTenantTransaction (design D5, D3; SSA B1)', () => {
  let pool: Pool;

  beforeAll(async () => {
    // `max: 1` is deliberate: every `.connect()` below returns the same
    // physical connection, which is what "unset after commit on the same
    // pooled connection" needs to observe.
    pool = new Pool({ connectionString: databaseUrl(), max: 1 });
    await pool.query(`create table if not exists ${MARKER_TABLE} (id text primary key)`);
  }, 30_000);

  afterAll(async () => {
    await pool.query(`drop table if exists ${MARKER_TABLE}`);
    await endQuietly(pool);
  }, 30_000);

  it("sets current_setting('app.tenant_id') to the given tenant inside the transaction", async () => {
    const tenantId = randomTenantId();

    const observed = await withTenantTransaction(pool, { tenantId }, async (client: PoolClient) => {
      const result = await client.query<{ value: string }>(
        `select current_setting('app.tenant_id') as value`,
      );
      return result.rows[0]?.value;
    });

    expect(observed).toBe(tenantId);
  });

  it('unsets app.tenant_id after commit, observed on the same pooled connection', async () => {
    const tenantId = randomTenantId();

    await withTenantTransaction(pool, { tenantId }, async (client: PoolClient) => {
      const result = await client.query<{ value: string }>(
        `select current_setting('app.tenant_id') as value`,
      );
      expect(result.rows[0]?.value).toBe(tenantId);
    });

    // `pool` has `max: 1`: this `.connect()` returns the exact connection
    // `withTenantTransaction` just committed on and released.
    const client = await pool.connect();
    try {
      const after = await readCurrentTenantSetting(client);
      expect(
        after === null || after === '',
        `app.tenant_id after commit, got ${JSON.stringify(after)}`,
      ).toBe(true);
    } finally {
      client.release();
    }
  });

  it('stores a quote-containing tenant value literally (bind parameter, no injection)', async () => {
    // This value would be rejected by `parseCatalogContext`'s tenantId
    // pattern, so it is fed straight to the low-level setter to prove the
    // bind-parameter guarantee independently of that pattern (SSA B1): if
    // `set_config` ever received this value through string interpolation
    // instead of a bind parameter, the embedded `'` would either break out of
    // the SQL string (a syntax error, not the value below) or truncate the
    // stored value at the quote.
    const injectionAttempt = "x'; --";

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await setTenantContext(client, injectionAttempt);
      const stored = await readCurrentTenantSetting(client);
      expect(stored).toBe(injectionAttempt);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });

  it('applies statement_timeout: a pg_sleep beyond it fails with SQLSTATE 57014', async () => {
    const tenantId = randomTenantId();

    let caught: unknown;
    try {
      await withTenantTransaction(
        pool,
        { tenantId },
        async (client: PoolClient) => {
          await client.query('select pg_sleep(0.3)');
        },
        { statementTimeoutMs: 50 },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught, 'pg_sleep beyond statement_timeout must reject').toBeDefined();
    expect(pgErrorOf(caught).code).toBe(STATEMENT_TIMEOUT_SQLSTATE);
  });

  it('rolls back everything fn did when fn throws', async () => {
    const tenantId = randomTenantId();
    const markerId = randomUUID();

    await expect(
      withTenantTransaction(pool, { tenantId }, async (client: PoolClient) => {
        await client.query(`insert into ${MARKER_TABLE} (id) values ($1)`, [markerId]);
        throw new Error('boom: deliberate failure inside fn');
      }),
    ).rejects.toThrow('boom: deliberate failure inside fn');

    const result = await pool.query(`select 1 from ${MARKER_TABLE} where id = $1`, [markerId]);
    expect(result.rows, 'the insert made inside fn must not survive the rollback').toHaveLength(0);
  });
});
