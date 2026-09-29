/**
 * Integration test for task 6.4 (design D6; spec "Tenant isolation is
 * enforced by the database independent of application code").
 *
 * Covers the one scenario task 6.4's own Verify clause names for this file:
 * "Query without a tenant setting sees no rows" — a query that runs as the
 * runtime role (`tayzu_app`) with no `app.tenant_id` session setting at all
 * (never even attempted, not merely reset to an empty string) must return
 * zero rows on a read and affect zero rows on a write, and must never raise
 * (spec: "A query executed with no `app.tenant_id` set MUST return zero rows
 * on read and affect zero rows on write, never an error").
 *
 * The other two 6.4 scenarios ("Runtime role cannot alter the change-event
 * log", "Runtime role cannot bypass row-level security") and the
 * negative-control assertion that `tayzu_migrator` is reachable from no
 * runtime code path live in the extended `db-isolation.int.test.ts`
 * alongside 001's own database-level isolation tests, per the task text.
 *
 * `connect()` (this package's own `tayzu_app`-role pool,
 * `service/__fixtures__/blueprint-test-helpers.ts`) is used for the
 * runtime-role check itself; `connectAsOwner()` (the raw, RLS-bypassing
 * `DATABASE_URL` role) is used only for setup — seeding the row this test
 * later confirms is invisible with no tenant setting — exactly as that
 * helper's own module doc prescribes (task 6.3, design D6 Resolved decision
 * Q1a).
 */
import { randomUUID } from 'node:crypto';

import { runMigrations } from '@tayzu/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  connect,
  connectAsOwner,
  databaseUrl,
  endQuietly,
  randomTenantId,
  type TestDb,
} from '../service/__fixtures__/blueprint-test-helpers.js';

/** Seeds one `catalog_blueprint` row directly, bypassing RLS (owner connection only). */
async function insertBlueprint(db: TestDb, tenantId: string, identifier: string): Promise<string> {
  const blueprintId = randomUUID();
  await db.execute(sql`
    insert into catalog_blueprint
      (id, tenant_id, identifier, title, schema, version,
       created_at, created_by_type, created_by_id, updated_at, updated_by_type, updated_by_id)
    values
      (${blueprintId}, ${tenantId}, ${identifier}, '{"en": "Title"}'::jsonb, '{}'::jsonb, 1,
       now(), 'system', 'sys', now(), 'system', 'sys')
  `);
  return blueprintId;
}

describe('row-level security with no tenant setting (task 6.4, design D6)', () => {
  let owner: TestDb;

  beforeAll(async () => {
    // Migrations, and the seed insert below, need the owner connection:
    // tayzu_app has no DDL privilege (task 6.3, design D6 Q1a), and seeding a
    // row with no tenant context set would itself be filtered by the very
    // policy this test exercises if done through the tayzu_app connection.
    owner = connectAsOwner(databaseUrl());
    await runMigrations(owner.$client);
  }, 60_000);

  afterAll(async () => {
    await endQuietly(owner.$client);
  }, 60_000);

  it('Query without a tenant setting sees no rows', async () => {
    const tenantId = randomTenantId();
    const blueprintId = await insertBlueprint(owner, tenantId, 'no-tenant-setting');

    // A brand-new tayzu_app pool: the on('connect') handler this fixture
    // wires only runs `SET ROLE tayzu_app`
    // (service/__fixtures__/blueprint-test-helpers.ts), never a
    // `set_config('app.tenant_id', ...)` call of any kind, so `app.tenant_id`
    // is genuinely unset on every connection this pool opens — the exact
    // precondition the scenario names, not merely an empty string (which the
    // policy predicate would treat identically here, but the scenario is
    // about the setting never having been made at all).
    const app = connect(databaseUrl());
    try {
      const readResult = await app.execute<{ id: string }>(sql`
        select id from catalog_blueprint where id = ${blueprintId}
      `);
      expect(
        readResult.rows,
        'a read with no app.tenant_id session setting must return zero rows',
      ).toHaveLength(0);

      const writeResult = await app.execute(sql`
        update catalog_blueprint set title = title where id = ${blueprintId}
      `);
      expect(
        writeResult.rowCount,
        'a write with no app.tenant_id session setting must affect zero rows, never raise',
      ).toBe(0);

      // The seeded row is untouched: the write above truly affected nothing,
      // not merely reported a zero count while mutating it regardless.
      const stillThere = await owner.execute<{ id: string; title: unknown }>(sql`
        select id, title from catalog_blueprint where id = ${blueprintId}
      `);
      expect(stillThere.rows).toHaveLength(1);
      expect(stillThere.rows[0]?.title).toEqual({ en: 'Title' });
    } finally {
      await endQuietly(app.$client);
    }
  });
});
