/**
 * Integration test for task 21.2 (openspec/changes/002-auth-and-rbac; design
 * D25/D26, Migration Plan step 5, Resolved decisions Q19/Q20/Q29).
 *
 * Task 21.2: "A migration adding `session.additionalFields.ssoSid` (nullable
 * text) to the already-migrated `auth.session` table ... Verify:
 * `session-schema.int.test.ts` asserts the column via `information_schema`."
 * Q29 adds `UNIQUE (provider_id, account_id)` on `auth.account` to the same
 * migration, as a named constraint declared in `persistence/schema.ts`.
 *
 * The migration is a Checkpoint 3 item: the human approves its SQL after this
 * red phase and the green phase.
 *
 * ## Production changes expected (none exists yet)
 *
 * - `packages/auth/src/persistence/schema.ts`: `session.ssoSid`
 *   (`text('sso_sid')`, nullable) and `unique('account_provider_account_uq')
 *   .on(account.providerId, account.accountId)`.
 * - A drizzle-kit generated migration in `packages/db/migrations/`, plus its
 *   hand-written down script. `tayzu_auth` keeps full CRUD on the column
 *   (table-level grants from 0003 already cover a new column; asserted below
 *   so a later column-level regrant cannot silently drop it).
 * - `createAuth` declares `session.additionalFields.ssoSid` (`string`,
 *   `required: false`, `input: false`). Not asserted here: task 21.3 and the
 *   sign-in tests own the populated value.
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { runMigrations } from '@tayzu/db';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { getOwnerPool } from '../../db/src/harness.js';
import * as authSchema from './persistence/schema.js';

const UNIQUE_NAME = 'account_provider_account_uq';

describe('auth.session.sso_sid and auth.account uniqueness (task 21.2, design D25, Q29)', () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    pool = await getOwnerPool();
    await runMigrations(pool);
    db = drizzle(pool, { schema: authSchema });
  }, 60_000);

  it('auth.session has a nullable text column sso_sid with no default', async () => {
    const result = await db.execute<{
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(sql`
      select data_type, is_nullable, column_default
        from information_schema.columns
       where table_schema = 'auth' and table_name = 'session' and column_name = 'sso_sid'
    `);
    expect(result.rows, 'column auth.session.sso_sid exists').toHaveLength(1);
    expect(result.rows[0]).toEqual({
      data_type: 'text',
      is_nullable: 'YES',
      column_default: null,
    });
  });

  it('tayzu_auth keeps SELECT, INSERT and UPDATE on auth.session.sso_sid', async () => {
    const result = await db.execute<{ s: boolean; i: boolean; u: boolean }>(sql`
      select has_column_privilege('tayzu_auth', 'auth.session', 'sso_sid', 'SELECT') as s,
             has_column_privilege('tayzu_auth', 'auth.session', 'sso_sid', 'INSERT') as i,
             has_column_privilege('tayzu_auth', 'auth.session', 'sso_sid', 'UPDATE') as u
    `);
    expect(result.rows[0]).toEqual({ s: true, i: true, u: true });
  });

  it('auth.account has the named unique constraint on (provider_id, account_id)', async () => {
    const result = await db.execute<{ cols: string[] }>(sql`
      select array_agg(kcu.column_name::text order by kcu.ordinal_position) as cols
        from information_schema.table_constraints tc
        join information_schema.key_column_usage kcu
          on kcu.constraint_schema = tc.constraint_schema
         and kcu.constraint_name = tc.constraint_name
       where tc.table_schema = 'auth'
         and tc.table_name = 'account'
         and tc.constraint_type = 'UNIQUE'
         and tc.constraint_name = ${UNIQUE_NAME}
       group by tc.constraint_name
    `);
    expect(result.rows, `constraint ${UNIQUE_NAME} exists`).toHaveLength(1);
    expect(result.rows[0]?.cols).toEqual(['provider_id', 'account_id']);
  });
});
