/**
 * Integration test for task 2.1 of 045-org-deletion-and-data-retention
 * (migration `0012_tenant_deletion`, Checkpoint 3): the
 * `tenant_deletion_marker` table (design D1, Migration Plan).
 *
 * Verify clause: a `purge_after` of 6 and of 15 days refused and one computed
 * as `now() + make_interval(days => 14)` accepted, a second pending marker for
 * one tenant refused, and the defaults (`requested_at` now, `state`
 * `pending`) applying to an insert that omits them.
 *
 * - The `CHECK` keeps `purge_after` between `requested_at + 7 days` and
 *   `requested_at + 14 days`; both bounds are inclusive, so 7 and 14 days are
 *   accepted and 6 and 15 are refused (SQLSTATE 23514).
 * - `purge_after` is computed the way the request computes it (task 5.2),
 *   `now() + make_interval(days => $1)` with the day count as a bound
 *   parameter, in the same transaction whose clock sets `requested_at`.
 * - The partial unique index allows one `pending` marker per tenant (23505
 *   for a second one), while a `cancelled` tombstone does not block a new
 *   `pending` marker, and another tenant's `pending` marker does not either.
 * - `state` is limited to `pending`, `cancelled` and `purged`; whether the
 *   refusal is a `CHECK` (23514) or an enum type (22P02) is left to the
 *   migration.
 *
 * The grants of the request role come in task 2.2, so every write here runs
 * as the scratch database's owner (the plain `DATABASE_URL` role, which
 * created the database and applied the migrations), with no `SET ROLE`.
 * Uses a private scratch database migrated from empty (the pattern of
 * `revocation-key.int.test.ts`, migration `0011`). Every tenant id is random
 * per run.
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
type Pool = Db['$client'];
type Query = Pool['query'];

function scratchDatabaseUrl(name: string): string {
  const url = new URL(databaseUrl());
  url.pathname = `/${name}`;
  return url.href;
}

const SCRATCH_NAME_PATTERN = /^[a-z0-9_]+$/;

function scratchDatabaseName(): string {
  const name = `tayzu_tenant_deletion_${randomUUID().replaceAll('-', '')}`;
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

/** Runs `fn` as the owner inside one transaction (one transaction clock). */
async function inTransaction<T>(pool: Pool, fn: (query: Query) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client.query.bind(client));
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

function newTenantId(): string {
  return `tenant-${randomUUID()}`;
}

function newActorId(): string {
  return `actor-${randomUUID()}`;
}

/**
 * Inserts a marker the way the request does (task 5.2): only the tenant, the
 * purge date and the requesting actor, with `purge_after` computed in SQL
 * from the transaction clock. `requested_at` and `state` take their defaults.
 */
async function requestDeletion(pool: Pool, tenantId: string, days: number): Promise<void> {
  await inTransaction(pool, async (query) => {
    await query(
      `insert into tenant_deletion_marker (tenant_id, purge_after, requested_by)
       values ($1, now() + make_interval(days => $2), $3)`,
      [tenantId, days, newActorId()],
    );
  });
}

async function countMarkers(pool: Pool, tenantId: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    'select count(*)::int as count from tenant_deletion_marker where tenant_id = $1',
    [tenantId],
  );
  return result.rows[0]?.count ?? -1;
}

describe('tenant_deletion_marker (migration 0012_tenant_deletion, task 2.1)', () => {
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

  describe('the CHECK keeps purge_after between requested_at + 7 days and requested_at + 14 days', () => {
    it('refuses a purge_after 6 days after requested_at', async () => {
      const tenantId = newTenantId();
      await expect(requestDeletion(db.$client, tenantId, 6)).rejects.toMatchObject({
        code: '23514',
      });
      expect(await countMarkers(db.$client, tenantId)).toBe(0);
    });

    it('refuses a purge_after 15 days after requested_at', async () => {
      const tenantId = newTenantId();
      await expect(requestDeletion(db.$client, tenantId, 15)).rejects.toMatchObject({
        code: '23514',
      });
      expect(await countMarkers(db.$client, tenantId)).toBe(0);
    });

    it('refuses a past-dated marker whose explicit requested_at is 6 days before purge_after', async () => {
      const tenantId = newTenantId();
      await expect(
        inTransaction(db.$client, async (query) => {
          await query(
            `insert into tenant_deletion_marker (tenant_id, requested_at, purge_after, requested_by)
             values ($1, $2::timestamptz, $2::timestamptz + make_interval(days => 6), $3)`,
            [tenantId, '2026-01-01T00:00:00.000Z', newActorId()],
          );
        }),
      ).rejects.toMatchObject({ code: '23514' });
      expect(await countMarkers(db.$client, tenantId)).toBe(0);
    });

    it('accepts a purge_after computed as now() + make_interval(days => 14), the inclusive upper bound', async () => {
      const tenantId = newTenantId();
      await expect(requestDeletion(db.$client, tenantId, 14)).resolves.toBeUndefined();

      const result = await db.$client.query<{ exact: boolean }>(
        `select purge_after = requested_at + make_interval(days => 14) as exact
           from tenant_deletion_marker where tenant_id = $1`,
        [tenantId],
      );
      expect(result.rows).toEqual([{ exact: true }]);
    });

    it('accepts a purge_after computed as now() + make_interval(days => 7), the inclusive lower bound', async () => {
      const tenantId = newTenantId();
      await expect(requestDeletion(db.$client, tenantId, 7)).resolves.toBeUndefined();
      expect(await countMarkers(db.$client, tenantId)).toBe(1);
    });
  });

  describe('the partial unique index allows one pending marker per tenant', () => {
    it('refuses a second pending marker for one tenant', async () => {
      const tenantId = newTenantId();
      await requestDeletion(db.$client, tenantId, 14);

      await expect(requestDeletion(db.$client, tenantId, 14)).rejects.toMatchObject({
        code: '23505',
      });
      expect(await countMarkers(db.$client, tenantId)).toBe(1);
    });

    it("does not let another tenant's pending marker block a tenant's own", async () => {
      const t1 = newTenantId();
      const t2 = newTenantId();
      await requestDeletion(db.$client, t2, 14);

      await expect(requestDeletion(db.$client, t1, 14)).resolves.toBeUndefined();
      expect(await countMarkers(db.$client, t1)).toBe(1);
      expect(await countMarkers(db.$client, t2)).toBe(1);
    });

    it('allows a new pending marker once the earlier one is a cancelled tombstone', async () => {
      const tenantId = newTenantId();
      await requestDeletion(db.$client, tenantId, 14);

      // The reversal tombstones the marker (never deletes it): state, the
      // cancellation time and the operator's opaque id.
      await inTransaction(db.$client, async (query) => {
        const updated = await query(
          `update tenant_deletion_marker
              set state = 'cancelled', cancelled_at = now(), cancelled_by = $2
            where tenant_id = $1 and state = 'pending'`,
          [tenantId, `operator-${randomUUID()}`],
        );
        expect(updated.rowCount).toBe(1);
      });

      await expect(requestDeletion(db.$client, tenantId, 14)).resolves.toBeUndefined();

      const states = await db.$client.query<{ state: string }>(
        'select state::text as state from tenant_deletion_marker where tenant_id = $1 order by state',
        [tenantId],
      );
      expect(states.rows.map((row) => row.state)).toEqual(['cancelled', 'pending']);
    });
  });

  it("an insert that omits requested_at and state gets the transaction's now() and pending", async () => {
    const tenantId = newTenantId();

    const row = await inTransaction(db.$client, async (query) => {
      await query(
        `insert into tenant_deletion_marker (tenant_id, purge_after, requested_by)
         values ($1, now() + make_interval(days => 14), $2)`,
        [tenantId, newActorId()],
      );
      const result = await query<{ requested_at_is_now: boolean; state: string }>(
        `select requested_at = now() as requested_at_is_now, state::text as state
           from tenant_deletion_marker where tenant_id = $1`,
        [tenantId],
      );
      return result.rows;
    });

    expect(row).toEqual([{ requested_at_is_now: true, state: 'pending' }]);
  });

  it('refuses a state outside pending, cancelled and purged', async () => {
    const tenantId = newTenantId();

    let caught: unknown;
    try {
      await inTransaction(db.$client, async (query) => {
        await query(
          `insert into tenant_deletion_marker (tenant_id, purge_after, requested_by, state)
           values ($1, now() + make_interval(days => 14), $2, $3)`,
          [tenantId, newActorId(), 'deleted'],
        );
      });
    } catch (error) {
      caught = error;
    }

    expect(caught, 'the insert is refused').toBeDefined();
    expect(['23514', '22P02']).toContain((caught as { code?: unknown }).code);
    expect(await countMarkers(db.$client, tenantId)).toBe(0);
  });
});
