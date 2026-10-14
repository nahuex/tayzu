/**
 * Integration test for task 11.1 of 043-identity-lifecycle-and-org-admin
 * (migration `0011_machine_credential_revocation_tenant_key`, Checkpoint 3):
 * `machine_credential_revocation` is keyed by the composite
 * `(tenant_id, credential_id)` instead of `credential_id` alone.
 *
 * Verify clause: a row for `(t2, c1)` neither blocks nor shadows `(t1, c1)`,
 * and a lookup for `t1` ignores `t2`'s row.
 *
 * - "Neither blocks": inserting `(t1, c1)` succeeds whether `(t2, c1)` was
 *   written before or after it (with the old `credential_id` primary key the
 *   second insert fails with a unique violation).
 * - "Nor shadows": once both rows exist, the resolver's own lookup shape
 *   (`credential_id = $1 and tenant_id = $2`, `context-resolver.ts`) under
 *   `t1` returns exactly `t1`'s row (its own `revoked_at`), and under `t2`
 *   exactly `t2`'s.
 * - "A lookup for t1 ignores t2's row": with only `(t2, c1)` present, the
 *   lookup under `t1` finds nothing.
 * - The key itself: the primary key is exactly `(tenant_id, credential_id)`,
 *   in that order, and the same `(tenant, credential)` pair is still unique.
 *
 * Expected production change (green phase): migration 0011 drops the
 * `credential_id` primary key and adds the composite one; `schema.ts`
 * declares `primaryKey({ columns: [t.tenantId, t.credentialId] })` and drops
 * the stale comment about a key on `credential_id`.
 *
 * Uses a private scratch database migrated from empty (pattern of
 * `revocation-schema.int.test.ts`), and writes through a `tayzu_app`
 * transaction with `app.tenant_id` set via `set_config`, so row level
 * security applies exactly as at runtime.
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

function scratchDatabaseUrl(name: string): string {
  const url = new URL(databaseUrl());
  url.pathname = `/${name}`;
  return url.href;
}

const SCRATCH_NAME_PATTERN = /^[a-z0-9_]+$/;

function scratchDatabaseName(): string {
  const name = `tayzu_revocation_key_${randomUUID().replaceAll('-', '')}`;
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

/** Runs `fn` as `tayzu_app` inside a transaction scoped to `tenantId`. */
async function asTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (query: Pool['query']) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role tayzu_app');
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
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

async function revoke(
  pool: Pool,
  tenantId: string,
  credentialId: string,
  revokedAt: Date,
): Promise<void> {
  await asTenant(pool, tenantId, async (query) => {
    await query(
      'insert into machine_credential_revocation (credential_id, revoked_at, tenant_id) values ($1, $2, $3)',
      [credentialId, revokedAt, tenantId],
    );
  });
}

/** The resolver's lookup shape: `credential_id = $1 and tenant_id = $2`. */
async function lookup(
  pool: Pool,
  tenantId: string,
  credentialId: string,
): Promise<{ tenant_id: string; revoked_at: Date }[]> {
  return asTenant(pool, tenantId, async (query) => {
    const result = await query<{ tenant_id: string; revoked_at: Date }>(
      'select tenant_id, revoked_at from machine_credential_revocation where credential_id = $1 and tenant_id = $2',
      [credentialId, tenantId],
    );
    return result.rows;
  });
}

describe('machine_credential_revocation composite (tenant_id, credential_id) key (task 11.1)', () => {
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

  it('has a primary key of exactly (tenant_id, credential_id), in that order', async () => {
    const result = await db.execute<{ columns: string[] }>(sql`
      select array_agg(a.attname order by k.ord) as columns
        from pg_constraint con
        join pg_class c on c.oid = con.conrelid
        join pg_namespace n on n.oid = c.relnamespace
        cross join lateral unnest(con.conkey) with ordinality as k(attnum, ord)
        join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
       where n.nspname = 'public'
         and c.relname = 'machine_credential_revocation'
         and con.contype = 'p'
       group by con.oid
    `);
    expect(result.rows.map((row) => row.columns)).toEqual([['tenant_id', 'credential_id']]);
  });

  it('a row for (t2, c1) does not block (t1, c1), whichever is written first', async () => {
    const c1 = `cred-${randomUUID()}`;
    const t1 = `tenant-${randomUUID()}`;
    const t2 = `tenant-${randomUUID()}`;
    const t3 = `tenant-${randomUUID()}`;
    const at = new Date('2026-01-01T00:00:00.000Z');

    // (t2, c1) first, then (t1, c1).
    await revoke(db.$client, t2, c1, at);
    await expect(revoke(db.$client, t1, c1, at)).resolves.toBeUndefined();

    // (t1, c1) already there; a later tenant with the same id also succeeds.
    await expect(revoke(db.$client, t3, c1, at)).resolves.toBeUndefined();
  });

  it('a row for (t2, c1) does not shadow (t1, c1): each tenant sees only its own row', async () => {
    const c1 = `cred-${randomUUID()}`;
    const t1 = `tenant-${randomUUID()}`;
    const t2 = `tenant-${randomUUID()}`;
    const t1At = new Date('2026-01-01T00:00:00.000Z');
    const t2At = new Date('2026-02-02T00:00:00.000Z');

    await revoke(db.$client, t2, c1, t2At);
    await revoke(db.$client, t1, c1, t1At);

    expect(await lookup(db.$client, t1, c1)).toEqual([{ tenant_id: t1, revoked_at: t1At }]);
    expect(await lookup(db.$client, t2, c1)).toEqual([{ tenant_id: t2, revoked_at: t2At }]);
  });

  it("a lookup for t1 ignores t2's row", async () => {
    const c1 = `cred-${randomUUID()}`;
    const t1 = `tenant-${randomUUID()}`;
    const t2 = `tenant-${randomUUID()}`;

    await revoke(db.$client, t2, c1, new Date('2026-02-02T00:00:00.000Z'));

    expect(await lookup(db.$client, t1, c1)).toEqual([]);
    expect(await lookup(db.$client, t2, c1)).toHaveLength(1);
  });

  it('the same (tenant, credential) pair is still unique', async () => {
    const c1 = `cred-${randomUUID()}`;
    const t1 = `tenant-${randomUUID()}`;
    const at = new Date('2026-01-01T00:00:00.000Z');

    await revoke(db.$client, t1, c1, at);
    await expect(revoke(db.$client, t1, c1, at)).rejects.toMatchObject({ code: '23505' });
  });
});
