/**
 * Integration test for task 2.3 of 048-production-hardening: the migration
 * command refuses a runtime role before migrating (design D1, Resolved
 * decision Q5).
 *
 * Task 2.3: "The runner refuses a runtime role before migrating (design D1).
 * Verify: `packages/db/src/run-migrations.int.test.ts` covers 'The migration
 * command refuses a runtime role' for `tayzu_app`, `tayzu_auth`, `tayzu_purge`
 * and `tayzu_deletion_admin` (the harness login roles), with the fixed message
 * naming no role, user or host and no migration applied, and the owner
 * connection migrating (a no-op on the migrated database);
 * `RUNTIME_DATABASE_ROLES` is exported by `@tayzu/db` (task 12.2 adds the
 * warning role)."
 *
 * D1: "Before `runMigrations`, `assertMigrationRole(pool)` runs `select
 * current_user` and refuses when it is in `RUNTIME_DATABASE_ROLES`, a constant
 * exported by `@tayzu/db`: `tayzu_app`, `tayzu_auth`, `tayzu_purge`,
 * `tayzu_deletion_admin` and `tayzu_purge_warning` (D14). The message is
 * fixed, `'db:migrate refuses to run as a runtime database role.'`, and names
 * no role, user or host. [...] it still lets CI migrate as the image
 * superuser".
 *
 * Q5: "the runner refuses, with a fixed message naming no role or host, when
 * `current_user` is a runtime role".
 *
 * Spec `auth-and-rbac`, Scenario "The migration command refuses a runtime
 * role":
 * - WHEN the migration command is given a connection string for any runtime
 *   database role
 * - THEN it applies nothing and fails with a fixed message that names no role,
 *   user or host
 *
 * D1 names the check (`assertMigrationRole(pool)`) but not the guarded entry
 * that runs it before `runMigrations`. This test names that entry
 * `runMigrationCommand(pool)`, exported from `./run-migrations.js` next to
 * `assertMigrationRole`: it is what the CLI body runs (assert, then migrate),
 * so the scenario's "applies nothing" is observable through it in-process.
 * The CLI itself cannot be spawned here: `createPool` requires
 * `sslmode=verify-full`, which the local test cluster does not offer.
 *
 * Every runtime role acts through a pool whose connections run `SET ROLE
 * <role>` (the harness pools on the shared, migrated database, and a private
 * pool on an empty scratch database), so `current_user` is that role, exactly
 * as for a connection string that logs in as it. "Applies nothing" is read
 * back from the database: the migration journal of the shared database is
 * unchanged, and the empty scratch database still has no journal and no
 * table. The owner is the raw `DATABASE_URL` role (`getOwnerPool()`, the
 * image superuser in CI), and `tayzu_migrator` is the migration role.
 */
import { randomUUID } from 'node:crypto';

import { Client, escapeIdentifier, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  getAuthTestDatabase,
  getDeletionAdminTestDatabase,
  getOwnerPool,
  getPurgeTestDatabase,
  getTestDatabase,
} from './harness.js';
import { RUNTIME_DATABASE_ROLES } from './index.js';
import { assertMigrationRole, runMigrationCommand } from './run-migrations.js';

const FIXED_MESSAGE = 'db:migrate refuses to run as a runtime database role.';

const MIGRATOR_ROLE = 'tayzu_migrator';

/** The four harness login roles the task names (task 12.2 adds the warning role). */
const REFUSED_ROLES = ['tayzu_app', 'tayzu_auth', 'tayzu_purge', 'tayzu_deletion_admin'] as const;

type RefusedRole = (typeof REFUSED_ROLES)[number];

/** The harness pool whose every connection runs as each role. */
const HARNESS_POOLS: Record<RefusedRole, () => Promise<{ readonly pool: Pool }>> = {
  tayzu_app: getTestDatabase,
  tayzu_auth: getAuthTestDatabase,
  tayzu_purge: getPurgeTestDatabase,
  tayzu_deletion_admin: getDeletionAdminTestDatabase,
};

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim() === '') {
    throw new Error('DATABASE_URL is not set');
  }
  return url;
}

/** `DATABASE_URL` with its database replaced by `name`. */
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

/** A pool on `url` whose every connection runs as `role` (`SET ROLE`, an escaped identifier). */
function poolAsRole(url: string, role: string): Pool {
  const pool = new Pool({ connectionString: url, max: 1 });
  pool.on('connect', (client) => {
    void client.query(`SET ROLE ${escapeIdentifier(role)}`).catch(() => {
      // Surfaces as the next query's permission error, never as a silent
      // wrong identity (same pattern as the harness).
    });
  });
  return pool;
}

async function currentUser(pool: Pool): Promise<string | undefined> {
  const { rows } = await pool.query<{ current_user: string }>('select current_user');
  return rows[0]?.current_user;
}

/** Awaits `promise`, expecting it to reject, and returns the rejection. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  let outcome: { readonly rejected: boolean; readonly error: unknown } | undefined;
  try {
    await promise;
    outcome = { rejected: false, error: undefined };
  } catch (error) {
    outcome = { rejected: true, error };
  }
  expect(outcome.rejected, 'the migration command must reject').toBe(true);
  expect(outcome.error).toBeInstanceOf(Error);
  return outcome.error as Error;
}

/**
 * Every string the message must not contain: each runtime role name, the
 * migration role, the `DATABASE_URL` user and host, and the role prefix.
 * Checked as booleans so that a failure never prints a connection detail.
 */
function connectionDetails(ownerRole: string): readonly string[] {
  const url = new URL(databaseUrl());
  const details = [
    ...REFUSED_ROLES,
    ...RUNTIME_DATABASE_ROLES,
    MIGRATOR_ROLE,
    'tayzu_',
    ownerRole,
    decodeURIComponent(url.username),
    url.hostname,
    url.host,
  ];
  return details.filter((detail) => detail !== '');
}

function expectNamesNoRoleUserOrHost(message: string, ownerRole: string): void {
  for (const [index, detail] of connectionDetails(ownerRole).entries()) {
    expect(
      message.includes(detail),
      `the message must not name connection detail #${String(index)} (role, user or host)`,
    ).toBe(false);
  }
}

interface JournalState {
  readonly count: number;
  readonly hashes: readonly string[];
}

async function readJournal(owner: Pool): Promise<JournalState> {
  const { rows } = await owner.query<{ hash: string }>(
    'select hash from drizzle.__drizzle_migrations order by id',
  );
  return { count: rows.length, hashes: rows.map(({ hash }) => hash) };
}

interface ScratchState {
  readonly drizzleSchema: boolean;
  readonly authSchema: boolean;
  readonly tables: readonly string[];
}

async function readScratchState(client: Client): Promise<ScratchState> {
  const schemas = await client.query<{ nspname: string }>(
    "select nspname from pg_namespace where nspname in ('drizzle', 'auth')",
  );
  const tables = await client.query<{ name: string }>(
    `select n.nspname || '.' || c.relname as name
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p', 'v', 'm', 'S')
        and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
      order by 1`,
  );
  const names = new Set(schemas.rows.map(({ nspname }) => nspname));
  return {
    drizzleSchema: names.has('drizzle'),
    authSchema: names.has('auth'),
    tables: tables.rows.map(({ name }) => name),
  };
}

let ownerRole: string;

beforeAll(async () => {
  const owner = await getOwnerPool();
  // Migrates the shared database once (the harness), so every role exists.
  await getTestDatabase();
  const role = await currentUser(owner);
  expect(role).toBeDefined();
  ownerRole = role ?? '';
});

describe('RUNTIME_DATABASE_ROLES (048 design D1)', () => {
  it('is exported by @tayzu/db and contains tayzu_app, tayzu_auth, tayzu_purge and tayzu_deletion_admin', () => {
    expect(Array.isArray(RUNTIME_DATABASE_ROLES)).toBe(true);
    for (const role of REFUSED_ROLES) {
      expect(RUNTIME_DATABASE_ROLES).toContain(role);
    }
  });

  it('lists each role once, never the migration role, and only roles the migrations create', async () => {
    const roles: readonly string[] = RUNTIME_DATABASE_ROLES;
    expect(new Set(roles).size).toBe(roles.length);
    expect(roles).not.toContain(MIGRATOR_ROLE);

    const owner = await getOwnerPool();
    const { rows } = await owner.query<{ rolname: string }>(
      'select rolname from pg_roles where rolname = any($1::text[])',
      [[...roles]],
    );
    expect(rows.map(({ rolname }) => rolname).sort()).toEqual([...roles].sort());
  });
});

describe('The migration command refuses a runtime role (shared migrated database)', () => {
  for (const role of REFUSED_ROLES) {
    it(`The migration command refuses a runtime role: ${role} fails with the fixed message naming no role, user or host, and the journal is unchanged`, async () => {
      const owner = await getOwnerPool();
      const { pool } = await HARNESS_POOLS[role]();

      // GIVEN a connection whose current_user is the runtime role.
      expect(await currentUser(pool)).toBe(role);
      const before = await readJournal(owner);
      expect(before.count, 'precondition: the shared database is migrated').toBeGreaterThan(0);

      // WHEN the migration command is given it.
      const error = await rejectionOf(runMigrationCommand(pool));

      // THEN it fails with the fixed message that names no role, user or host.
      expect(error.message).toBe(FIXED_MESSAGE);
      expectNamesNoRoleUserOrHost(error.message, ownerRole);

      // AND it applies nothing.
      expect(await readJournal(owner)).toEqual(before);
    });

    it(`assertMigrationRole refuses ${role} with the fixed message`, async () => {
      const { pool } = await HARNESS_POOLS[role]();
      expect(await currentUser(pool)).toBe(role);

      const error = await rejectionOf(assertMigrationRole(pool));

      expect(error.message).toBe(FIXED_MESSAGE);
      expectNamesNoRoleUserOrHost(error.message, ownerRole);
    });
  }
});

describe('The migration command refuses a runtime role (empty scratch database)', () => {
  const admin = new Client({ connectionString: databaseUrl() });
  const name = `tayzu_scratch_${randomUUID().replaceAll('-', '')}`;
  let scratchUrl: string;
  let inspector: Client | undefined;
  let created = false;

  beforeAll(async () => {
    await admin.connect();
    const privilege = await admin.query<{ allowed: boolean }>(
      'select rolcreatedb or rolsuper as allowed from pg_roles where rolname = current_user',
    );
    if (privilege.rows[0]?.allowed !== true) {
      throw new Error(
        'The DATABASE_URL role needs the CREATEDB privilege: this test creates, and then drops, a private scratch database.',
      );
    }
    await admin.query(`create database ${escapeIdentifier(name)}`);
    created = true;
    scratchUrl = scratchDatabaseUrl(name);
    inspector = new Client({ connectionString: scratchUrl });
    await inspector.connect();
  });

  afterAll(async () => {
    if (inspector !== undefined) {
      await endQuietly(inspector);
    }
    if (created) {
      await dropScratchDatabase(admin, name);
    }
    await endQuietly(admin);
  });

  for (const role of REFUSED_ROLES) {
    it(`The migration command refuses a runtime role: ${role} fails with the fixed message and applies nothing to an empty database`, async () => {
      if (inspector === undefined) throw new Error('scratch database not ready');
      const before = await readScratchState(inspector);
      expect(before.drizzleSchema, 'precondition: no migration journal').toBe(false);
      expect(before.authSchema, 'precondition: no auth schema').toBe(false);
      expect(before.tables, 'precondition: no table').toEqual([]);

      // GIVEN a connection to the empty database whose current_user is the runtime role.
      const pool = poolAsRole(scratchUrl, role);
      try {
        expect(await currentUser(pool)).toBe(role);

        // WHEN the migration command is given it.
        const error = await rejectionOf(runMigrationCommand(pool));

        // THEN it fails with the fixed message that names no role, user or host.
        expect(error.message).toBe(FIXED_MESSAGE);
        expectNamesNoRoleUserOrHost(error.message, ownerRole);
      } finally {
        await endQuietly(pool);
      }

      // AND it applies nothing: no journal, no schema, no table.
      const after = await readScratchState(inspector);
      expect(after).toEqual(before);
    });
  }
});

describe('The owner connection migrates (048 design D1)', () => {
  it('runMigrationCommand on the owner connection resolves, a no-op on the migrated database', async () => {
    const owner = await getOwnerPool();
    expect(RUNTIME_DATABASE_ROLES).not.toContain(ownerRole);
    const before = await readJournal(owner);
    expect(before.count, 'precondition: the shared database is migrated').toBeGreaterThan(0);

    await expect(runMigrationCommand(owner)).resolves.toBeUndefined();

    expect(await readJournal(owner)).toEqual(before);
  });

  it('runMigrationCommand as tayzu_migrator resolves, a no-op on the migrated database', async () => {
    const owner = await getOwnerPool();
    const before = await readJournal(owner);

    const migrator = poolAsRole(databaseUrl(), MIGRATOR_ROLE);
    try {
      expect(await currentUser(migrator)).toBe(MIGRATOR_ROLE);
      await expect(runMigrationCommand(migrator)).resolves.toBeUndefined();
    } finally {
      await endQuietly(migrator);
    }

    expect(await readJournal(owner)).toEqual(before);
  });

  it('assertMigrationRole accepts the owner connection', async () => {
    const owner = await getOwnerPool();
    await expect(assertMigrationRole(owner)).resolves.toBeUndefined();
  });
});
