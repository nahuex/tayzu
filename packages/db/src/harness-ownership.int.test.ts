import { randomUUID } from 'node:crypto';

import { Client, escapeIdentifier, Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runMigrations } from './index.js';

/**
 * Task 23.17 (design Q47, D6): the test harness reassigns schema `auth`, its
 * tables and sequences, and `machine_credential_revocation` to
 * `tayzu_migrator`, like the catalog tables, so a database this harness (or
 * anyone) migrated under the bootstrap role ends up in the same state as a
 * from-scratch run, and a later `ALTER TABLE auth.session` migration applied
 * as `tayzu_migrator` succeeds.
 *
 * The test builds a private scratch database with a random name, migrates it
 * under the plain `DATABASE_URL` role (legacy ownership), points a fresh copy
 * of the harness module at it and calls `getTestDatabase()`. It never touches
 * shared tables.
 */

const MIGRATOR_ROLE = 'tayzu_migrator';

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim() === '') {
    throw new Error('DATABASE_URL is not set');
  }
  return url;
}

function scratchDatabaseUrl(name: string): string {
  const url = new URL(databaseUrl());
  url.pathname = `/${name}`;
  url.searchParams.delete('database');
  url.searchParams.delete('dbname');
  url.hash = '';
  return url.href;
}

async function endQuietly(closeable: {
  on(event: 'error', listener: (error: unknown) => void): unknown;
  end(): Promise<void>;
}): Promise<void> {
  closeable.on('error', () => {
    // Expected only during teardown.
  });
  await closeable.end();
}

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

async function withScratchDatabase(action: (url: string) => Promise<void>): Promise<void> {
  const admin = new Client({ connectionString: databaseUrl() });
  await admin.connect();
  try {
    const name = `tayzu_scratch_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`create database ${escapeIdentifier(name)}`);
    try {
      await action(scratchDatabaseUrl(name));
    } finally {
      await dropScratchDatabase(admin, name);
    }
  } finally {
    await endQuietly(admin);
  }
}

interface OwnedObject {
  readonly name: string;
  readonly owner: string;
}

async function readAuthObjectOwners(client: Client): Promise<OwnedObject[]> {
  const { rows } = await client.query<OwnedObject>(
    `select n.nspname || '.' || c.relname || ' (' || c.relkind::text || ')' as name,
            pg_get_userbyid(c.relowner) as owner
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p', 'S')
        and (n.nspname = 'auth' or (n.nspname = 'public' and c.relname = 'machine_credential_revocation'))
      order by 1`,
  );
  return rows;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('harness ownership of the auth schema (task 23.17)', () => {
  it('reassigns schema auth, its tables and sequences, and machine_credential_revocation to tayzu_migrator on a database owned by the bootstrap role, and a later ALTER TABLE auth.session runs as tayzu_migrator', async () => {
    await withScratchDatabase(async (url) => {
      // GIVEN a database whose objects are owned by the bootstrap role: the
      // migrations run under the plain DATABASE_URL role, with no SET ROLE.
      const legacyPool = new Pool({ connectionString: url, max: 1 });
      try {
        await runMigrations(legacyPool);
      } finally {
        await endQuietly(legacyPool);
      }

      const inspector = new Client({ connectionString: url });
      await inspector.connect();
      try {
        const bootstrapRole = (
          await inspector.query<{ current_user: string }>('select current_user')
        ).rows[0]?.current_user;
        expect(bootstrapRole).toBeDefined();
        expect(bootstrapRole).not.toBe(MIGRATOR_ROLE);

        const before = await readAuthObjectOwners(inspector);
        expect(before.length).toBeGreaterThan(0);
        expect(
          before.every((object) => object.owner === bootstrapRole),
          'precondition: every object is owned by the bootstrap role',
        ).toBe(true);

        // WHEN the harness runs against that database.
        vi.stubEnv('DATABASE_URL', url);
        vi.resetModules();
        const freshHarness = await import('./harness.js');
        const { pool } = await freshHarness.getTestDatabase();

        try {
          // THEN the schema owner and every relowner is tayzu_migrator.
          const schemaOwner = await inspector.query<{ owner: string }>(
            `select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = 'auth'`,
          );
          expect(schemaOwner.rows[0]?.owner).toBe(MIGRATOR_ROLE);

          const after = await readAuthObjectOwners(inspector);
          expect(after.map((object) => object.name)).toEqual(before.map((object) => object.name));
          expect(after.filter((object) => object.owner !== MIGRATOR_ROLE)).toEqual([]);
          expect(after.map((object) => object.name)).toContain(
            'public.machine_credential_revocation (r)',
          );
          expect(after.map((object) => object.name)).toContain('auth.session (r)');

          // AND a later ALTER TABLE auth.session migration succeeds as tayzu_migrator.
          await inspector.query(`set role ${MIGRATOR_ROLE}`);
          await inspector.query('alter table auth.session add column ownership_probe text null');
          await inspector.query('reset role');
        } finally {
          await endQuietly(pool);
        }
      } finally {
        await endQuietly(inspector);
      }
    });
  }, 60_000);
});
