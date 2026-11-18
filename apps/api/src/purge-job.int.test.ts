/**
 * Task 6.6 of openspec/changes/045-org-deletion-and-data-retention (design D2, Resolved
 * decision Q49): the purge job entry point, `apps/api/scripts/purge-job.ts`
 * (`pnpm --filter @tayzu/api identity:purge`).
 *
 * Verify clause: runs the script once against a due tenant, asserts it is purged, asserts the
 * process opened no listener and no connection other than `tayzu_purge`, and asserts it refuses
 * to start as `tayzu_app` (which passes `assertRuntimeRole`) and as `tayzu_auth`.
 *
 * ## Production symbols expected
 *
 * ```ts
 * // apps/api/scripts/purge-job.ts (runPurge and RunPurgeOptions exist already)
 * export interface RunPurgeOptions {
 *   readonly pool: Pool;
 *   // When absent, the pass lists the due tenants itself through the marker policy
 *   // (`purge_due_select` of `0013`, as tayzu_purge) and purges each one.
 *   readonly tenantIds?: readonly string[];
 *   readonly env?: RunScriptOptions['env'];
 *   readonly telemetry?: Telemetry;
 *   // catalogOptions, authOptions as today.
 * }
 * // Asserts `current_user = 'tayzu_purge'` on `pool` through runScript's role check
 * // (roles: [{ pool, roles: ['tayzu_purge'] }]) before any other query, and rejects with a
 * // fixed message otherwise.
 * export function runPurge(options: RunPurgeOptions): Promise<void>;
 *
 * export interface PurgeJobOptions {
 *   // Defaults to process.env; read through loadScriptConfig('purge-job', env), so only
 *   // PURGE_DATABASE_URL is a database URL it reads.
 *   readonly env?: Readonly<Record<string, string | undefined>>;
 *   // A pool the host already built; when given, main does not end it. When absent, main builds
 *   // one with `createPool(config.PURGE_DATABASE_URL)` (`@tayzu/db`) and ends it.
 *   readonly pool?: Pool;
 *   // Replaces startTelemetry(env); a test seam.
 *   readonly telemetry?: Telemetry;
 * }
 * // The entry point (044's recover-admin-mfa shape): one pass over the due tenants listed by the
 * // job itself, no HTTP listener.
 * export function main(options?: PurgeJobOptions): Promise<void>;
 * ```
 *
 * ## How the job reaches `tayzu_purge` here
 *
 * `tayzu_purge` is a `LOGIN` role with no password in the test cluster, so a
 * `PURGE_DATABASE_URL` built from `DATABASE_URL` by swapping the user cannot authenticate. The
 * test uses the harness's own mechanism (`getPurgeTestDatabase()`, `SET ROLE tayzu_purge` on every
 * connection): `createPool` of `@tayzu/db` is mocked, the injected env carries a sentinel
 * `PURGE_DATABASE_URL` (and different sentinels for the other database URLs), and the mock hands
 * the harness's `tayzu_purge` pool back only for the sentinel. `DATABASE_URL` is never printed.
 *
 * ## Shared database
 *
 * Other test files (in parallel workers and in other packages under Turborepo) seed due markers
 * in the same database and drive them through interrupted steps. A pass that lists every due
 * tenant would purge their tenants under them. So the pool handed to the job is wrapped: a query
 * whose parameters name a tenant with a due marker that this file did not seed returns no rows
 * without reaching the database (both steps read the tenant's marker first, so a foreign tenant is
 * a no-op). The listing itself (no parameters) goes through untouched, and every assertion is
 * about this file's tenants only.
 */
import net from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';

import pg, { type Pool, type PoolClient, type QueryResult } from 'pg';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  getAuthTestDatabase,
  getOwnerPool,
  getPurgeTestDatabase,
  getTestDatabase,
} from '../../../packages/db/src/harness.js';
import { main, runPurge } from '../scripts/purge-job.js';
import type { Telemetry } from './telemetry.js';

const createPoolMock = vi.hoisted(() => vi.fn<(url: string) => Pool>());

vi.mock('@tayzu/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tayzu/db')>()),
  createPool: createPoolMock,
}));

const PURGE_URL_SENTINEL = 'postgres://tayzu_purge@purge.invalid:5432/tayzu?sslmode=verify-full';
const APP_URL_SENTINEL = 'postgres://tayzu_app@app.invalid:5432/tayzu?sslmode=verify-full';
const AUTH_URL_SENTINEL = 'postgres://tayzu_auth@auth.invalid:5432/tayzu?sslmode=verify-full';

const ENV: Readonly<Record<string, string>> = {
  PURGE_DATABASE_URL: PURGE_URL_SENTINEL,
  DATABASE_URL: APP_URL_SENTINEL,
  AUTH_DATABASE_URL: AUTH_URL_SENTINEL,
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
};

/** `runScript`'s flush, stubbed: no SDK starts and nothing is exported. */
const NO_TELEMETRY: Telemetry = {
  async shutdown() {
    // Nothing to flush.
  },
};

async function ownerQuery(statement: string, params: unknown[]): Promise<void> {
  await (await getOwnerPool()).query(statement, params);
}

// ---------------------------------------------------------------------------
// Seeding, through the owner pool (the shapes of `org-purge-resume.int.test.ts`).

type AuthTable = 'organization' | 'member' | 'user' | 'session';

interface SeededTenant {
  readonly tenantId: string;
  readonly rows: readonly { readonly table: AuthTable; readonly id: string }[];
}

/** Every tenant this file seeded: the only ones the wrapped pool lets the job reach. */
const ownTenants = new Set<string>();

/**
 * A tenant with an organization, a user who belongs only to it (with a session), a blueprint
 * and one entity, and a pending marker that is due (`due`) or whose date is in the future.
 */
async function seedTenant(marker: 'due' | 'future'): Promise<SeededTenant> {
  const tenantId = `org-${randomUUID()}`;
  ownTenants.add(tenantId);
  await ownerQuery(
    'insert into auth.organization (id, name, slug, created_at) values ($1, $2, $3, now())',
    [tenantId, 'Org', `slug-${tenantId}`],
  );
  await ownerQuery(
    marker === 'due'
      ? `insert into tenant_deletion_marker (tenant_id, requested_at, purge_after, requested_by)
         values ($1, now() - interval '15 days', now() - interval '1 day', $2)`
      : `insert into tenant_deletion_marker (tenant_id, requested_at, purge_after, requested_by)
         values ($1, now(), now() + interval '10 days', $2)`,
    [tenantId, `actor-${randomUUID()}`],
  );
  const userId = `user-${randomUUID()}`;
  await ownerQuery(
    `insert into auth."user" (id, name, email, email_verified, created_at, updated_at)
     values ($1, 'User', $2, true, now(), now())`,
    [userId, `${userId}@example.test`],
  );
  const memberId = `member-${randomUUID()}`;
  await ownerQuery(
    `insert into auth.member (id, organization_id, user_id, role, created_at)
     values ($1, $2, $3, 'member', now())`,
    [memberId, tenantId, userId],
  );
  const sessionId = `session-${randomUUID()}`;
  await ownerQuery(
    `insert into auth.session (id, expires_at, token, created_at, updated_at, user_id, active_organization_id)
     values ($1, now() + interval '1 day', $2, now(), now(), $3, $4)`,
    [sessionId, randomBytes(24).toString('hex'), userId, tenantId],
  );
  const actorId = `actor-${randomUUID()}`;
  const blueprintId = randomUUID();
  await ownerQuery(
    `insert into catalog_blueprint
       (id, tenant_id, identifier, title, schema, version, created_at, created_by_type,
        created_by_id, updated_at, updated_by_type, updated_by_id)
     values ($1, $2, $3, '"Service"'::jsonb, '{}'::jsonb, 1, now(), 'user', $4,
             now(), 'user', $4)`,
    [blueprintId, tenantId, `service-${randomUUID()}`, actorId],
  );
  await ownerQuery(
    `insert into catalog_entity
       (id, tenant_id, blueprint_id, identifier, title, spec_properties, generation, version,
        created_at, created_by_type, created_by_id, updated_at, updated_by_type, updated_by_id)
     values ($1, $2, $3, $4, $4, '{}'::jsonb, 1, 1, now(), 'user', $5, now(), 'user', $5)`,
    [randomUUID(), tenantId, blueprintId, `entity-${randomUUID()}`, actorId],
  );
  return {
    tenantId,
    rows: [
      { table: 'organization', id: tenantId },
      { table: 'member', id: memberId },
      { table: 'user', id: userId },
      { table: 'session', id: sessionId },
    ],
  };
}

// ---------------------------------------------------------------------------
// Reads, through the owner pool.

async function presentAuthRows(tenant: SeededTenant): Promise<AuthTable[]> {
  const owner = await getOwnerPool();
  const present: AuthTable[] = [];
  for (const { table, id } of tenant.rows) {
    // `table` is one of the fixed `AuthTable` literals.
    const { rows } = await owner.query<{ present: boolean }>(
      `select exists (select 1 from auth."${table}" where id = $1) as present`,
      [id],
    );
    if (rows[0]?.present === true) present.push(table);
  }
  return present;
}

async function catalogCounts(tenantId: string): Promise<{ entities: number; blueprints: number }> {
  const owner = await getOwnerPool();
  const { rows } = await owner.query<{ entities: number; blueprints: number }>(
    `select (select count(*)::int from catalog_entity where tenant_id = $1) as entities,
            (select count(*)::int from catalog_blueprint where tenant_id = $1) as blueprints`,
    [tenantId],
  );
  return rows[0] ?? { entities: -1, blueprints: -1 };
}

interface Marker {
  readonly state: string;
  readonly catalog_purged_at: string | null;
  readonly auth_purged_at: string | null;
}

async function readMarker(tenantId: string): Promise<Marker | undefined> {
  const owner = await getOwnerPool();
  const { rows } = await owner.query<Marker>(
    `select state::text as state,
            catalog_purged_at::text as catalog_purged_at,
            auth_purged_at::text as auth_purged_at
       from tenant_deletion_marker where tenant_id = $1`,
    [tenantId],
  );
  return rows[0];
}

async function expectUntouched(tenant: SeededTenant): Promise<void> {
  expect(await presentAuthRows(tenant), 'every auth row stays').toEqual([
    'organization',
    'member',
    'user',
    'session',
  ]);
  expect(await catalogCounts(tenant.tenantId), 'every catalog row stays').toEqual({
    entities: 1,
    blueprints: 1,
  });
  expect(await readMarker(tenant.tenantId), 'the marker is unchanged').toEqual({
    state: 'pending',
    catalog_purged_at: null,
    auth_purged_at: null,
  });
}

// ---------------------------------------------------------------------------
// The shared-database guard (see the header).

type QueryFunction = (...args: unknown[]) => Promise<unknown>;

const EMPTY_RESULT = {
  command: '',
  rowCount: 0,
  oid: 0,
  fields: [],
  rows: [],
} satisfies QueryResult;

function paramsOf(args: readonly unknown[]): readonly unknown[] {
  const [first, second] = args;
  if (Array.isArray(second)) return second as unknown[];
  if (typeof first === 'object' && first !== null && 'values' in first) {
    const { values } = first as { values?: unknown };
    return Array.isArray(values) ? (values as unknown[]) : [];
  }
  return [];
}

/**
 * True when a parameter names a tenant with a due marker that this file did not seed. Asked on
 * the raw `tayzu_purge` pool (whose `purge_due_select` shows exactly the due pending markers), so
 * that the guard itself opens no connection as another role.
 */
async function namesForeignDueTenant(raw: Pool, params: readonly unknown[]): Promise<boolean> {
  for (const value of params) {
    if (typeof value !== 'string' || ownTenants.has(value)) continue;
    const { rows } = await raw.query<{ due: boolean }>(
      'select exists (select 1 from tenant_deletion_marker where tenant_id = $1) as due',
      [value],
    );
    if (rows[0]?.due === true) return true;
  }
  return false;
}

function guardedQuery(raw: Pool, query: QueryFunction, target: object): QueryFunction {
  return async (...args: unknown[]): Promise<unknown> => {
    if (await namesForeignDueTenant(raw, paramsOf(args))) return EMPTY_RESULT;
    return query.apply(target, args);
  };
}

/**
 * `target` as the job sees it: a query naming a foreign due tenant is a no-op, and `end` leaves
 * the shared harness pool open. The lookups go through `raw`, the `tayzu_purge` pool.
 */
function guardedPool(raw: Pool, target: Pool = raw): Pool {
  const guardClient = (client: PoolClient): PoolClient =>
    new Proxy(client, {
      get(target, property): unknown {
        const value: unknown = Reflect.get(target, property, target);
        if (property === 'query') return guardedQuery(raw, value as QueryFunction, target);
        return typeof value === 'function' ? (value as QueryFunction).bind(target) : value;
      },
    });
  return new Proxy(target, {
    get(pool, property): unknown {
      const value: unknown = Reflect.get(pool, property, pool);
      if (property === 'query') return guardedQuery(raw, value as QueryFunction, pool);
      if (property === 'connect') {
        return async (): Promise<PoolClient> => guardClient(await pool.connect());
      }
      if (property === 'end') {
        // The harness pool is shared by the whole file.
        return async (): Promise<void> => undefined;
      }
      return typeof value === 'function' ? (value as QueryFunction).bind(pool) : value;
    },
  });
}

/**
 * Asks `current_user` of every client that ran a query while `spy` was installed, after removing
 * the spy. A client that can no longer be asked (the job ended it) reports `unverifiable`.
 */
async function rolesOfQueriedClients(spy: {
  mock: { contexts: unknown[] };
  mockRestore: () => void;
}): Promise<string[]> {
  const clients = new Set(spy.mock.contexts as pg.Client[]);
  spy.mockRestore();
  const roles: string[] = [];
  for (const client of clients) {
    try {
      const { rows } = await client.query<{ current_user: string }>('select current_user');
      roles.push(rows[0]?.current_user ?? 'unverifiable');
    } catch {
      roles.push('unverifiable');
    }
  }
  return roles;
}

// ---------------------------------------------------------------------------

describe('purge job entry point (task 6.6)', () => {
  let purgePool: Pool;
  let appPool: Pool;
  let authPool: Pool;

  beforeAll(async () => {
    purgePool = (await getPurgeTestDatabase()).pool;
    appPool = (await getTestDatabase()).pool;
    authPool = (await getAuthTestDatabase()).pool;
    await getOwnerPool();
  }, 120_000);

  afterEach(() => {
    vi.restoreAllMocks();
    createPoolMock.mockReset();
  });

  it('runs once as tayzu_purge from PURGE_DATABASE_URL: it lists the due tenants itself, purges the due tenant, leaves a tenant that is not due, opens no listener and no connection as another role', async () => {
    const due = await seedTenant('due');
    const notDue = await seedTenant('future');
    // Warm the guard's own path before the spies, so every client below is one the job used.
    await purgePool.query('select 1');

    createPoolMock.mockImplementation((url: string) => {
      if (url !== PURGE_URL_SENTINEL) {
        throw new Error('the purge job built a pool from a URL other than PURGE_DATABASE_URL');
      }
      return guardedPool(purgePool);
    });
    const listen = vi.spyOn(net.Server.prototype, 'listen');
    const createServer = vi.spyOn(net, 'createServer');
    const queries = vi.spyOn(pg.Client.prototype, 'query');

    await main({ env: ENV, telemetry: NO_TELEMETRY });

    const roles = await rolesOfQueriedClients(queries);
    expect(createPoolMock.mock.calls, 'one pool, built from PURGE_DATABASE_URL only').toEqual([
      [PURGE_URL_SENTINEL],
    ]);
    expect(roles.length, 'the job ran its queries on a database connection').toBeGreaterThan(0);
    expect(new Set(roles), 'every connection the job queried runs as tayzu_purge').toEqual(
      new Set(['tayzu_purge']),
    );
    expect(listen, 'no listener is opened').not.toHaveBeenCalled();
    expect(createServer, 'no server is created').not.toHaveBeenCalled();

    expect(await readMarker(due.tenantId), 'the due tenant is marked purged').toMatchObject({
      state: 'purged',
      catalog_purged_at: expect.any(String) as unknown,
      auth_purged_at: expect.any(String) as unknown,
    });
    expect(await presentAuthRows(due), 'the due tenant has no auth row left').toEqual([]);
    expect(await catalogCounts(due.tenantId), 'the due tenant has no catalog row left').toEqual({
      entities: 0,
      blueprints: 0,
    });

    await expectUntouched(notDue);
  });

  it('runPurge with no tenantIds lists the due tenants itself through the marker policy: the due tenant is purged and the tenant that is not due is not touched', async () => {
    const due = await seedTenant('due');
    const notDue = await seedTenant('future');

    await runPurge({ pool: guardedPool(purgePool), env: ENV, telemetry: NO_TELEMETRY });

    expect(await readMarker(due.tenantId)).toMatchObject({ state: 'purged' });
    expect(await presentAuthRows(due)).toEqual([]);
    expect(await catalogCounts(due.tenantId)).toEqual({ entities: 0, blueprints: 0 });
    await expectUntouched(notDue);
  });

  describe.each([
    { role: 'tayzu_app', why: 'passes assertRuntimeRole' },
    { role: 'tayzu_auth', why: 'holds the auth schema' },
  ] as const)('refuses to start as $role ($why), before deleting anything', ({ role }) => {
    function poolFor(): Pool {
      return role === 'tayzu_app' ? appPool : authPool;
    }

    function expectFixedMessage(error: unknown): string {
      expect(error).toBeInstanceOf(Error);
      const { message } = error as Error;
      expect(message, 'the refusal is about the database role').toMatch(/role/i);
      for (const secret of [
        process.env['DATABASE_URL'] ?? '',
        PURGE_URL_SENTINEL,
        APP_URL_SENTINEL,
        AUTH_URL_SENTINEL,
      ]) {
        expect(secret !== '' && message.includes(secret), 'the message names no URL').toBe(false);
      }
      expect(message, 'the message names no host').not.toMatch(/\.invalid|localhost|postgres:\/\//);
      return message;
    }

    it(`runPurge rejects with a fixed message as ${role}, and the due tenant keeps every row`, async () => {
      const due = await seedTenant('due');

      const error: unknown = await runPurge({
        pool: guardedPool(purgePool, poolFor()),
        tenantIds: [due.tenantId],
        env: ENV,
        telemetry: NO_TELEMETRY,
      }).then(
        () => undefined,
        (reason: unknown) => reason,
      );

      expect(error, 'runPurge refuses to run').toBeDefined();
      expect(expectFixedMessage(error)).toBe(
        'script database role is not one of its declared roles',
      );
      await expectUntouched(due);
    });

    it(`main refuses to start as ${role}, and the due tenant keeps every row`, async () => {
      const due = await seedTenant('due');
      createPoolMock.mockImplementation(() => guardedPool(purgePool, poolFor()));

      const error: unknown = await main({ env: ENV, telemetry: NO_TELEMETRY }).then(
        () => undefined,
        (reason: unknown) => reason,
      );

      expect(error, 'the job refuses to start').toBeDefined();
      expectFixedMessage(error);
      await expectUntouched(due);
    });
  });
});
