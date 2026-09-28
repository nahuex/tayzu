/**
 * Test-only Postgres harness (task 1.5; design D5 and D12). Not part of the
 * package's public entry point (`package.json` `exports`): only the test
 * harness may connect to a local database without TLS, so production code
 * must reach `@tayzu/db` only through `./index.ts`, which does not re-export
 * this module.
 *
 * Task 6.3 (design D6): migrations apply as `tayzu_migrator`, which must end
 * up owning the catalog tables it creates, and the pool this module hands
 * back is subject to the `tenant_isolation` policy exactly as `tayzu_app` is,
 * so 001's own isolation tests become RLS tests with no rewrite. Both roles
 * are provisioned out of band in a deployed environment (design D15); here,
 * the test-only bootstrap below (never a migration, never production code)
 * creates them if missing and grants the *test cluster's* `DATABASE_URL` role
 * (`tayzu` locally, the `postgres:16` service's superuser in CI) the
 * membership it needs to reach them:
 *
 * - `tayzu_migrator` gets a test-only `CREATEROLE` (so it can itself run
 *   0002/0003/0006's own idempotent `CREATE ROLE tayzu_auth`/`tayzu_app`
 *   guards on a from-scratch database) and `CREATE` on the database and on
 *   schema `public` (so it can run every catalog/`auth`-schema migration
 *   statement, WITH GRANT OPTION on the schema so it can itself grant
 *   `tayzu_app` its own `USAGE`, migration 0006). None of this is granted to
 *   `tayzu_migrator`'s production identity.
 * - The migration run itself connects as `tayzu_migrator` (`SET ROLE`,
 *   queued before any other query on that one connection, so every
 *   migration statement — including ones already applied to this shared
 *   database under an older identity — executes under it). Ownership of the
 *   six catalog tables is then explicitly reassigned to `tayzu_migrator`
 *   (idempotent), so a database this harness already migrated under a plain
 *   `DATABASE_URL` role ends up in the same state a from-scratch run would.
 * - After migration, the bootstrap role is granted plain membership in
 *   `tayzu_app` (not `SET ROLE`, only inherited privilege): every connection
 *   this harness returns, and every other test file that connects directly
 *   with `DATABASE_URL`, is then subject to the `tenant_isolation` policy
 *   exactly as `tayzu_app` is, while `current_user` stays the `DATABASE_URL`
 *   role itself.
 */
import { Client, Pool } from 'pg';

import { assertVerifiedTlsOrLocal } from './connection-security.js';
import { runMigrations } from './index.js';

const MISSING_DATABASE_URL_MESSAGE = [
  'DATABASE_URL is not set: the test harness needs a real PostgreSQL 16 database.',
  'Export a connection string before running it, for example:',
  '  export DATABASE_URL=postgres://<user>:<password>@localhost:5432/tayzu_test',
  'To run only the unit tests instead, use `pnpm test:unit`. See CLAUDE.md, "Running tests".',
].join('\n');

export interface TestDatabase {
  readonly pool: Pool;
}

/** Memoized across concurrent callers within the same process (module instance). */
let testDatabase: Promise<TestDatabase> | undefined;

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim() === '') {
    throw new Error(MISSING_DATABASE_URL_MESSAGE);
  }
  return url;
}

/** Design D6's migration/runtime role names. */
const MIGRATOR_ROLE = 'tayzu_migrator';
const APP_ROLE = 'tayzu_app';

/**
 * Advisory-lock key serializing this harness's own bootstrap (role creation,
 * ownership reassignment, membership grants) against concurrent callers on
 * the same database — Turborepo/Vitest can start several test processes at
 * once against the shared `DATABASE_URL` database, exactly like
 * `MIGRATION_LOCK_KEY` (`index.ts`) already serializes `runMigrations`
 * itself. A different key: this lock and the migration one are held by
 * different connections and must not be mistaken for the same critical
 * section.
 */
const BOOTSTRAP_LOCK_KEY = 848_432_002;

async function withBootstrapLock(client: Client, fn: () => Promise<void>): Promise<void> {
  await client.query('select pg_advisory_lock($1)', [BOOTSTRAP_LOCK_KEY]);
  try {
    await fn();
  } finally {
    await client.query('select pg_advisory_unlock($1)', [BOOTSTRAP_LOCK_KEY]);
  }
}

/** Every catalog table task 6.1/6.2 already put under `tenant_isolation` RLS. */
const CATALOG_TABLES = [
  'catalog_blueprint',
  'catalog_change_event',
  'catalog_entity',
  'catalog_entity_relation',
  'catalog_relation_definition',
  'catalog_tenant_sequence',
] as const;

/**
 * Idempotently ensures `tayzu_migrator` exists and that the bootstrap
 * connection (whatever role `DATABASE_URL` names) can act as it and grant it
 * what it needs to run every migration from scratch. Test-harness-only:
 * never run against a migration file, never against production code's own
 * connection.
 */
async function ensureMigratorRole(bootstrap: Client): Promise<void> {
  await bootstrap.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATOR_ROLE}') THEN
        CREATE ROLE ${MIGRATOR_ROLE} LOGIN;
      END IF;
    END
    $$;
  `);
  // Test-only: lets tayzu_migrator itself pass through 0002/0003/0006's own
  // idempotent `CREATE ROLE IF NOT EXISTS` guards for tayzu_auth/tayzu_app on
  // a from-scratch database. Never granted to the production role.
  await bootstrap.query(`ALTER ROLE ${MIGRATOR_ROLE} CREATEROLE;`);
  // Lets the bootstrap connection SET ROLE to tayzu_migrator for the
  // migration run below (a bare GRANT, unlike the admin-only membership a
  // role automatically gets over a role it creates, carries INHERIT and SET,
  // PostgreSQL 16's own membership options).
  await bootstrap.query(`
    DO $$
    BEGIN
      EXECUTE format('GRANT ${MIGRATOR_ROLE} TO %I', current_user);
    END
    $$;
  `);
  // CREATE on the database (schema `auth`, migration 0002) and on schema
  // `public` (every catalog table), WITH GRANT OPTION on the schema so
  // tayzu_migrator can itself grant tayzu_app USAGE (migration 0006).
  await bootstrap.query(`
    DO $$
    BEGIN
      EXECUTE format('GRANT CREATE ON DATABASE %I TO ${MIGRATOR_ROLE}', current_database());
    END
    $$;
  `);
  await bootstrap.query(
    `GRANT CREATE, USAGE ON SCHEMA public TO ${MIGRATOR_ROLE} WITH GRANT OPTION;`,
  );
  // drizzle-orm's own migrator creates schema `drizzle` and
  // `drizzle.__drizzle_migrations` the first time any migration runs
  // (`runMigrations`, production code, unchanged). On a database this
  // harness already migrated under a different role, both already exist and
  // are owned by that role; reassigning them to tayzu_migrator (guarded:
  // neither exists yet on a from-scratch database, where tayzu_migrator
  // creates and so already owns them) lets it read and record the journal.
  await bootstrap.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'drizzle') THEN
        ALTER SCHEMA drizzle OWNER TO ${MIGRATOR_ROLE};
        IF EXISTS (
          SELECT 1 FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'drizzle' AND c.relname = '__drizzle_migrations'
        ) THEN
          ALTER TABLE drizzle.__drizzle_migrations OWNER TO ${MIGRATOR_ROLE};
        END IF;
      END IF;
    END
    $$;
  `);
}

/**
 * Runs every pending migration with `current_user` set to `tayzu_migrator`
 * for the whole session: the `SET ROLE` statement is queued on the pool's one
 * physical connection before `runMigrations` (production code, unchanged)
 * ever queues a query on it, so every migration statement, including
 * `CREATE TABLE`/`CREATE SCHEMA`, executes as `tayzu_migrator`.
 */
async function runMigrationsAsMigrator(url: string): Promise<void> {
  const migratorPool = new Pool({ connectionString: url, max: 1 });
  migratorPool.on('connect', (client) => {
    void client.query(`SET ROLE ${MIGRATOR_ROLE}`).catch(() => {
      // A failure here surfaces as the real, catchable error below: the next
      // query queued on this same connection (the first migration
      // statement) fails with a permission error instead of silently
      // running under the wrong identity.
    });
  });
  try {
    await runMigrations(migratorPool);
  } finally {
    await migratorPool.end();
  }
}

/**
 * Reassigns ownership of every catalog table to `tayzu_migrator` (design D6:
 * "must end up owning the catalog tables it creates"). A from-scratch
 * database already has this ownership from `runMigrationsAsMigrator`; this
 * is what brings a database this harness migrated before task 6.3 (under a
 * plain `DATABASE_URL` role) to the same state. Idempotent: reassigning a
 * table to its current owner is a no-op.
 */
async function reassignCatalogTableOwnership(bootstrap: Client): Promise<void> {
  for (const table of CATALOG_TABLES) {
    await bootstrap.query(`ALTER TABLE ${table} OWNER TO ${MIGRATOR_ROLE};`);
  }
}

/**
 * Grants the bootstrap connection's role plain membership in `tayzu_app`
 * (inherited privilege, not `SET ROLE`): every pool this harness returns, and
 * every other test file that connects directly with `DATABASE_URL`, becomes
 * subject to the `tenant_isolation` policy exactly as `tayzu_app` is, while
 * `current_user` stays the `DATABASE_URL` role itself.
 */
async function grantAppRoleMembership(bootstrap: Client): Promise<void> {
  await bootstrap.query(`
    DO $$
    BEGIN
      EXECUTE format('GRANT ${APP_ROLE} TO %I', current_user);
    END
    $$;
  `);
}

async function initializeTestDatabase(): Promise<TestDatabase> {
  const url = requireDatabaseUrl();
  assertVerifiedTlsOrLocal(url);

  const bootstrap = new Client({ connectionString: url });
  await bootstrap.connect();
  try {
    await withBootstrapLock(bootstrap, () => ensureMigratorRole(bootstrap));
  } finally {
    await bootstrap.end();
  }

  await runMigrationsAsMigrator(url);

  const postMigration = new Client({ connectionString: url });
  await postMigration.connect();
  try {
    await withBootstrapLock(postMigration, async () => {
      await reassignCatalogTableOwnership(postMigration);
      await grantAppRoleMembership(postMigration);
    });
  } finally {
    await postMigration.end();
  }

  const pool = new Pool({ connectionString: url });
  return { pool };
}

/**
 * Returns a pool on the database named by `DATABASE_URL`, migrated once per
 * process: concurrent callers share the same initialization, so migrations
 * run once even when several test files ask for it at the same time. Throws
 * the explicit `MISSING_DATABASE_URL_MESSAGE` when the variable is unset, and
 * refuses a non-TLS URL that is not local (design D5), both before any
 * connection is attempted.
 */
export function getTestDatabase(): Promise<TestDatabase> {
  testDatabase ??= initializeTestDatabase();
  const current = testDatabase;
  void current.catch(() => {
    // A failed initialization (for example a database that is not actually
    // reachable) must not be cached forever: a later call gets a fresh try.
    if (testDatabase === current) {
      testDatabase = undefined;
    }
  });
  return current;
}
