/**
 * `043` task 4.2b: the repeatable `_user` reconcile
 * (`apps/api/scripts/reconcile-users.ts`; design D1 and D9; Resolved decisions
 * Q50, Q62, Q84, Q89, Q116, Q117 and Q124).
 *
 * Scenarios of `specs/identity-lifecycle-and-org-admin/spec.md`, requirement
 * "Every member has a `_user` row":
 *
 * - "The reconcile repairs a member and is repeatable"
 * - "The reconcile does not revive a banned user"
 * - "The reconcile removes an orphan"
 *
 * The shed scenario ("The reconcile sheds before it creates a `_user`") is task
 * 8.5l's, not this task's.
 *
 * ## Production symbols expected
 *
 * ```ts
 * // apps/api/scripts/reconcile-users.ts (today a scaffold whose `main()` does nothing)
 * export interface ReconcileOptions {
 *   // Defaults to process.env. Read through loadScriptConfig('reconcile-users', env):
 *   // DATABASE_URL, AUTH_DATABASE_URL, CERBOS_ADDRESS and TAYZU_OPERATOR_ID. A
 *   // missing operator id rejects main() before any write.
 *   readonly env?: Readonly<Record<string, string | undefined>>;
 *   // Pools the host already built (the script then does not end them). appPool
 *   // runs as tayzu_app, authPool as tayzu_auth; both go to runScript as role checks.
 *   readonly appPool?: Pool;
 *   readonly authPool?: Pool;
 *   // The clock seam of the orphan grace period. Defaults to `() => new Date()`.
 *   readonly now?: () => Date;
 * }
 * export function main(options?: ReconcileOptions): Promise<void>;
 * ```
 *
 * The script lists organizations and members (and `user.banned`) through
 * `authPool`, writes `_user` rows through `createUserSyncAdapter` over
 * `createUserSync` (the `membership_added` intent with `banned`, the `userId` of
 * the Better Auth user, and `onBehalfOf: { type: 'user', id: <operator> }`, the
 * principal `{ kind: 'operator', id: <operator> }`), and removes orphans through
 * the catalog's entity service as a `system` actor whose `onBehalfOf` is the
 * operator, with `detachReferences: true`. Per tenant it emits the audit event
 * `catalog.audit.users_reconciled` with `tayzu.tenant.id`,
 * `tayzu.identity.operator.id`, `tayzu.identity.reconcile.created` and
 * `tayzu.identity.reconcile.orphans` (numbers).
 *
 * ## Why a private scratch database
 *
 * The reconcile scans EVERY organization and member of the database it is
 * given. Run on the shared test database it would write `_user` rows and delete
 * rows of the tenants that concurrently running test files own. This file
 * therefore migrates its own scratch database (the pattern of
 * `backfill-user-blueprint.int.test.ts` and
 * `packages/catalog/src/persistence/schema.int.test.ts`).
 */
// Load-bearing import order (design D1): the telemetry harness registers before
// anything that loads `@tayzu/auth` creates its logger.
import { registration, type TelemetryTestHarness } from '../__fixtures__/link-telemetry.js';
import { randomUUID } from 'node:crypto';

import { createAuth, authSchema, createContextResolver, type AuthInstance } from '@tayzu/auth';
import { createCerbosClient } from '@tayzu/authz';
import {
  createBlueprintService,
  createEntityService,
  createUserSync,
  type UserSync,
} from '@tayzu/catalog';
import { runMigrations } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { main } from '../../scripts/reconcile-users.js';
import {
  createAdminUser,
  signInAdminUser,
} from '../../../../packages/auth/src/__fixtures__/admin-user.js';
import {
  TEST_SECRET,
  TEST_PASSWORD,
} from '../../../../packages/auth/src/__fixtures__/test-secret.js';

const CERBOS_ADDRESS = 'localhost:3593';
/** Nothing listens here: a loopback address, so the client is built without TLS. */
const UNREACHABLE_CERBOS_ADDRESS = 'localhost:1';
const OPERATOR_ID = 'gh:424242';
const STATUS_EVENT = 'catalog.audit.user_status_changed';
const RECONCILED_EVENT = 'catalog.audit.users_reconciled';
const SCRATCH_NAME_PATTERN = /^[a-z0-9_]+$/;
const MINUTES_PER_HOUR = 60;

interface AuthAdminSurface {
  createOrganization(args: {
    body: { name: string; slug: string; userId: string };
  }): Promise<{ id: string }>;
  addMember(args: {
    body: { userId: string; organizationId: string; role: string };
  }): Promise<unknown>;
}

interface ChangeEventRow extends QueryResultRow {
  action: string;
  actor_type: string;
  on_behalf_of_type: string | null;
  on_behalf_of_id: string | null;
}

interface TestUser {
  readonly userId: string;
  readonly email: string;
}

function ownerUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim() === '') {
    throw new Error(
      'DATABASE_URL is not set: the int project global setup should have stopped this run.',
    );
  }
  return url;
}

function scratchUrl(name: string): string {
  const url = new URL(ownerUrl());
  url.pathname = `/${name}`;
  return url.href;
}

function scratchDatabaseName(): string {
  const name = `tayzu_api_reconcile_${randomUUID().replaceAll('-', '')}`;
  if (!SCRATCH_NAME_PATTERN.test(name)) {
    throw new Error(`generated scratch database name is unsafe: ${name}`);
  }
  return name;
}

/** A pool whose every connection runs as `role` (a fixed literal, never input). */
function poolAs(url: string, role: 'tayzu_app' | 'tayzu_auth'): Pool {
  const pool = new Pool({ connectionString: url });
  const statement = role === 'tayzu_app' ? 'SET ROLE tayzu_app' : 'SET ROLE tayzu_auth';
  pool.on('connect', (client) => {
    void client.query(statement).catch(() => undefined);
  });
  pool.on('error', () => undefined);
  return pool;
}

async function endQuietly(pool: Pool): Promise<void> {
  pool.on('error', () => undefined);
  await pool.end();
}

function randomIp(): string {
  const octet = () => String(Math.floor(Math.random() * 256));
  return `10.${octet()}.${octet()}.${String(1 + Math.floor(Math.random() * 254))}`;
}

describe('reconcile-users (task 4.2b)', () => {
  const scratchName = scratchDatabaseName();
  let harness: TelemetryTestHarness;
  let adminPool: Pool;
  let ownerScratchPool: Pool;
  let appPool: Pool;
  let authPool: Pool;
  let auth: AuthInstance;
  let api: AuthAdminSurface;
  let userSync: UserSync;
  let blueprints: ReturnType<typeof createBlueprintService>;
  let entities: ReturnType<typeof createEntityService>;

  const env = (cerbosAddress: string, operatorId: string | null = OPERATOR_ID) => ({
    NODE_ENV: 'test',
    DATABASE_URL: scratchUrl(scratchName),
    AUTH_DATABASE_URL: scratchUrl(scratchName),
    CERBOS_ADDRESS: cerbosAddress,
    ...(operatorId === null ? {} : { TAYZU_OPERATOR_ID: operatorId }),
  });

  const run = (options: { now?: () => Date } = {}) =>
    main({ env: env(CERBOS_ADDRESS), appPool, authPool, ...options });

  beforeAll(async () => {
    if ('error' in registration) {
      throw new Error(`createTelemetryTestHarness() failed: ${String(registration.error)}`, {
        cause: registration.error,
      });
    }
    harness = registration.harness;

    adminPool = new Pool({ connectionString: ownerUrl(), max: 1 });
    await adminPool.query(`create database ${scratchName}`);

    ownerScratchPool = new Pool({ connectionString: scratchUrl(scratchName) });
    await runMigrations(ownerScratchPool);
    appPool = poolAs(scratchUrl(scratchName), 'tayzu_app');
    authPool = poolAs(scratchUrl(scratchName), 'tayzu_auth');

    const authz = createCerbosClient({ address: CERBOS_ADDRESS, tls: false });
    // No `userSync`: a membership added here writes no `_user` row, which is
    // exactly the state the reconcile repairs.
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
    });
    api = auth.api as AuthAdminSurface;
    userSync = createUserSync({ pool: appPool, authz });
    blueprints = createBlueprintService({ pool: appPool, authz });
    entities = createEntityService({ pool: appPool, authz });
  }, 120_000);

  afterAll(async () => {
    // End every pool first, then drop: a live connection would block the drop.
    await endQuietly(appPool);
    await endQuietly(authPool);
    await endQuietly(ownerScratchPool);
    await adminPool.query(`drop database if exists ${scratchName} with (force)`);
    await endQuietly(adminPool);
  }, 60_000);

  /** Runs `text` as the scratch database's owner with the tenant GUC set (RLS-safe). */
  async function ownerQuery<R extends QueryResultRow>(
    tenantId: string,
    text: string,
    params: readonly unknown[],
  ): Promise<R[]> {
    const client = await ownerScratchPool.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await client.query<R>(text, [...params]);
      await client.query('commit');
      return result.rows;
    } finally {
      client.release();
    }
  }

  async function newUser(label: string): Promise<TestUser> {
    return await createAdminUser(auth, {
      name: `Reconcile ${label}`,
      email: `reconcile-${label}-${randomUUID()}@example.test`,
      password: TEST_PASSWORD,
    });
  }

  /** An organization (the tenant) with an owner member and no `_user` row at all. */
  async function seedTenant(): Promise<{ tenantId: string; owner: TestUser }> {
    const owner = await newUser('owner');
    const org = await api.createOrganization({
      body: { name: 'Reconcile Org', slug: `reconcile-${randomUUID()}`, userId: owner.userId },
    });
    return { tenantId: org.id, owner };
  }

  async function addMember(tenantId: string): Promise<TestUser> {
    const member = await newUser('member');
    await api.addMember({
      body: { userId: member.userId, organizationId: tenantId, role: 'member' },
    });
    return member;
  }

  async function seedRow(
    tenantId: string,
    email: string,
    status: 'Staged' | 'Invited' | 'Active' | 'Disabled',
  ): Promise<void> {
    await userSync.upsertUser({ tenantId, email, name: 'Seeded Person', status });
  }

  /** Sets a seeded `_user` row's `created_at` and `updated_at` (minutes before now). */
  async function ageRow(
    tenantId: string,
    email: string,
    createdMinutesAgo: number,
    updatedMinutesAgo: number,
  ): Promise<void> {
    await ownerQuery(
      tenantId,
      `update catalog_entity
          set created_at = now() - make_interval(mins => $3::int),
              updated_at = now() - make_interval(mins => $4::int)
        where tenant_id = $1 and identifier = $2
          and blueprint_id = (select id from catalog_blueprint
                               where tenant_id = $1 and identifier = '_user')`,
      [tenantId, email, createdMinutesAgo, updatedMinutesAgo],
    );
  }

  async function changeEvents(tenantId: string, email: string): Promise<ChangeEventRow[]> {
    return await ownerQuery<ChangeEventRow>(
      tenantId,
      `select action, actor_type, on_behalf_of_type, on_behalf_of_id
         from catalog_change_event
        where tenant_id = $1 and blueprint_identifier = '_user' and resource_identifier = $2
        order by seq`,
      [tenantId, email],
    );
  }

  async function userEventCount(tenantId: string): Promise<number> {
    const rows = await ownerQuery<{ count: string }>(
      tenantId,
      `select count(*)::text as count from catalog_change_event
        where tenant_id = $1 and blueprint_identifier = '_user'`,
      [tenantId],
    );
    return Number(rows[0]?.count);
  }

  async function logRecords(eventName: string, tenantId: string) {
    await harness.forceFlush();
    return [...harness.logExporter.getFinishedLogRecords()].filter(
      (record) =>
        record.eventName === eventName && record.attributes['tayzu.tenant.id'] === tenantId,
    );
  }

  async function exists(tenantId: string, email: string): Promise<boolean> {
    return (await userSync.getUser({ tenantId, email })) !== null;
  }

  it('The reconcile repairs a member and is repeatable: the first run creates the missing row as Active for the operator and leaves the Active one untouched', async () => {
    const first = await seedTenant();
    const second = await seedTenant();
    const kept = await Promise.all([first, second].map(async (t) => await addMember(t.tenantId)));
    const keptBefore: { version: number; events: number }[] = [];
    for (const [index, tenant] of [first, second].entries()) {
      const member = kept[index];
      if (member === undefined) throw new Error('member missing');
      await seedRow(tenant.tenantId, member.email, 'Active');
      const row = await userSync.getUser({ tenantId: tenant.tenantId, email: member.email });
      keptBefore.push({
        version: row?.version ?? -1,
        events: (await changeEvents(tenant.tenantId, member.email)).length,
      });
      expect(await exists(tenant.tenantId, tenant.owner.email), 'precondition').toBe(false);
    }

    await run();

    for (const [index, tenant] of [first, second].entries()) {
      const created = await userSync.getUser({
        tenantId: tenant.tenantId,
        email: tenant.owner.email,
      });
      expect(created?.status).toBe('Active');

      const events = await changeEvents(tenant.tenantId, tenant.owner.email);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: 'created',
        actor_type: 'system',
        on_behalf_of_type: 'user',
        on_behalf_of_id: OPERATOR_ID,
      });

      const statusChanges = await logRecords(STATUS_EVENT, tenant.tenantId);
      const ofOwner = statusChanges.filter(
        (record) => record.attributes['tayzu.identity.user.id'] === tenant.owner.userId,
      );
      expect(ofOwner).toHaveLength(1);
      expect(ofOwner[0]?.attributes).toMatchObject({
        'tayzu.identity.operator.id': OPERATOR_ID,
        'tayzu.identity.user.status.event': 'created_active',
        'tayzu.identity.user.status.to': 'Active',
      });
      expect(ofOwner[0]?.attributes).not.toHaveProperty('tayzu.actor.id');
      expect(ofOwner[0]?.attributes).not.toHaveProperty('tayzu.identity.user.status.from');

      const member = kept[index];
      if (member === undefined) throw new Error('member missing');
      const row = await userSync.getUser({ tenantId: tenant.tenantId, email: member.email });
      expect(row?.version, 'the existing row is untouched').toBe(keptBefore[index]?.version);
      expect((await changeEvents(tenant.tenantId, member.email)).length).toBe(
        keptBefore[index]?.events,
      );

      const reconciled = await logRecords(RECONCILED_EVENT, tenant.tenantId);
      expect(reconciled).toHaveLength(1);
      expect(reconciled[0]?.attributes).toMatchObject({
        'tayzu.identity.operator.id': OPERATOR_ID,
        'tayzu.identity.reconcile.created': 1,
        'tayzu.identity.reconcile.orphans': 0,
      });
    }
  }, 120_000);

  it('The reconcile repairs a member and is repeatable: the second run changes nothing, and the repaired member is accepted by resolveContext', async () => {
    const tenant = await seedTenant();
    const member = await addMember(tenant.tenantId);
    await seedRow(tenant.tenantId, member.email, 'Active');

    await run();
    const eventsAfterFirst = await userEventCount(tenant.tenantId);
    const ownerAfterFirst = await userSync.getUser({
      tenantId: tenant.tenantId,
      email: tenant.owner.email,
    });
    const statusLogsAfterFirst = (await logRecords(STATUS_EVENT, tenant.tenantId)).length;
    expect(ownerAfterFirst?.status).toBe('Active');

    await run();

    expect(await userEventCount(tenant.tenantId)).toBe(eventsAfterFirst);
    expect(
      await userSync.getUser({ tenantId: tenant.tenantId, email: tenant.owner.email }),
    ).toEqual(ownerAfterFirst);
    expect((await logRecords(STATUS_EVENT, tenant.tenantId)).length).toBe(statusLogsAfterFirst);

    // The repaired owner holds exactly one membership, so the session is bound to the tenant.
    const session = await signInAdminUser(auth, {
      email: tenant.owner.email,
      password: TEST_PASSWORD,
      ip: randomIp(),
    });
    const resolveContext = createContextResolver({ auth, revocationPool: appPool });
    await expect(resolveContext(new Headers({ cookie: session.cookie }))).resolves.toMatchObject({
      tenantId: tenant.tenantId,
      actor: { type: 'user', id: tenant.owner.userId },
    });
  }, 120_000);

  it('The reconcile refuses to run with no operator id: nothing is written', async () => {
    const tenant = await seedTenant();

    await expect(main({ env: env(CERBOS_ADDRESS, null), appPool, authPool })).rejects.toThrow(
      /TAYZU_OPERATOR_ID/,
    );

    expect(await exists(tenant.tenantId, tenant.owner.email)).toBe(false);
    expect(await userEventCount(tenant.tenantId)).toBe(0);
  }, 120_000);

  it('The reconcile does not revive a banned user: the row is created and ends Disabled, with both writes attributed to the operator', async () => {
    const tenant = await seedTenant();
    const banned = await addMember(tenant.tenantId);
    await ownerScratchPool.query('update auth."user" set banned = true where id = $1', [
      banned.userId,
    ]);
    expect(await exists(tenant.tenantId, banned.email), 'precondition').toBe(false);

    await run();

    const row = await userSync.getUser({ tenantId: tenant.tenantId, email: banned.email });
    expect(row?.status).toBe('Disabled');

    const events = await changeEvents(tenant.tenantId, banned.email);
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event).toMatchObject({
        actor_type: 'system',
        on_behalf_of_type: 'user',
        on_behalf_of_id: OPERATOR_ID,
      });
    }

    const statusChanges = (await logRecords(STATUS_EVENT, tenant.tenantId)).filter(
      (record) => record.attributes['tayzu.identity.user.id'] === banned.userId,
    );
    expect(
      statusChanges.map((record) => record.attributes['tayzu.identity.user.status.event']),
    ).toEqual(['created_active', 'admin_disable']);
    for (const record of statusChanges) {
      expect(record.attributes['tayzu.identity.operator.id']).toBe(OPERATOR_ID);
      expect(record.attributes).not.toHaveProperty('tayzu.actor.id');
    }
  }, 120_000);

  /**
   * One tenant holding, besides its owner's row, the rows the orphan rule must
   * tell apart. Returns the emails by role.
   */
  async function seedOrphanTenant() {
    const tenant = await seedTenant();
    const emails = {
      owner: tenant.owner.email,
      orphanOld: `orphan-old-${randomUUID()}@example.test`,
      orphanRelated: `orphan-related-${randomUUID()}@example.test`,
      orphanRecent: `orphan-recent-${randomUUID()}@example.test`,
      createdOldActivatedRecently: `orphan-failed-accept-${randomUUID()}@example.test`,
      invited: `invited-${randomUUID()}@example.test`,
      staged: `staged-${randomUUID()}@example.test`,
      service: `service-${randomUUID()}@example.test`,
    };
    const { tenantId } = tenant;
    const twoHours = 2 * MINUTES_PER_HOUR;
    // The owner is a member: an old `Active` row of a member is never an orphan.
    await seedRow(tenantId, emails.owner, 'Active');
    await seedRow(tenantId, emails.orphanOld, 'Active');
    await seedRow(tenantId, emails.orphanRelated, 'Active');
    await seedRow(tenantId, emails.orphanRecent, 'Active');
    await seedRow(tenantId, emails.createdOldActivatedRecently, 'Active');
    await seedRow(tenantId, emails.invited, 'Invited');
    await seedRow(tenantId, emails.staged, 'Staged');
    await entities.create(
      {
        tenantId,
        actor: { type: 'system', id: 'reconcile-test' },
        principal: { roles: ['admin'] },
      },
      {
        blueprint: '_user',
        identifier: emails.service,
        title: 'Service account',
        spec: { properties: { accountKind: 'service', status: 'Active' } },
      },
    );

    // A relation that targets the orphan: a RESTRICT foreign key unless detached.
    const admin = {
      tenantId,
      actor: { type: 'user', id: 'seeder' },
      principal: { roles: ['admin'] },
    } as const;
    await blueprints.create(admin, {
      identifier: 'asset',
      title: { en: 'Asset' },
      schema: { properties: {} },
      relations: { owner: { title: { en: 'Owner' }, target: '_user' } },
    });
    await entities.create(admin, {
      blueprint: 'asset',
      identifier: 'asset-1',
      title: 'Asset 1',
      spec: { properties: {}, relations: { owner: emails.orphanRelated } },
    });

    for (const email of [
      emails.owner,
      emails.orphanOld,
      emails.orphanRelated,
      emails.invited,
      emails.staged,
      emails.service,
    ]) {
      await ageRow(tenantId, email, twoHours, twoHours);
    }
    await ageRow(tenantId, emails.orphanRecent, 30, 5);
    // Created by an invitation three hours ago, activated ten minutes ago.
    await ageRow(tenantId, emails.createdOldActivatedRecently, 3 * MINUTES_PER_HOUR, 10);
    return { tenantId, emails };
  }

  it('The reconcile removes an orphan: only the Active human row with no member, activated more than an hour ago, is removed (also when a relation targets it), attributed to the operator', async () => {
    const { tenantId, emails } = await seedOrphanTenant();

    await run();

    expect(await exists(tenantId, emails.orphanOld), 'orphan removed').toBe(false);
    expect(await exists(tenantId, emails.orphanRelated), 'orphan with a relation removed').toBe(
      false,
    );
    expect(await exists(tenantId, emails.owner), 'a member is not an orphan').toBe(true);
    expect(await exists(tenantId, emails.orphanRecent), 'updated within the hour').toBe(true);
    expect(await exists(tenantId, emails.invited), 'Invited').toBe(true);
    expect(await exists(tenantId, emails.staged), 'Staged').toBe(true);
    expect(await exists(tenantId, emails.service), 'service account').toBe(true);
    expect(
      await exists(tenantId, emails.createdOldActivatedRecently),
      'created long ago, activated within the hour',
    ).toBe(true);

    for (const email of [emails.orphanOld, emails.orphanRelated]) {
      const events = await changeEvents(tenantId, email);
      const removal = events.at(-1);
      expect(removal).toMatchObject({
        action: 'deleted',
        actor_type: 'system',
        on_behalf_of_type: 'user',
        on_behalf_of_id: OPERATOR_ID,
      });
    }

    const reconciled = await logRecords(RECONCILED_EVENT, tenantId);
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]?.attributes).toMatchObject({
      'tayzu.identity.operator.id': OPERATOR_ID,
      'tayzu.identity.reconcile.created': 0,
      'tayzu.identity.reconcile.orphans': 2,
    });
  }, 120_000);

  it('The reconcile removes an orphan: a row activated within the hour is kept, and removed by a run made after that hour (clock seam)', async () => {
    const { tenantId, emails } = await seedOrphanTenant();
    // A first run at the real clock: the two rows whose age decides stay.
    await run();
    expect(await exists(tenantId, emails.createdOldActivatedRecently), 'within the hour').toBe(
      true,
    );
    expect(await exists(tenantId, emails.orphanRecent), 'within the hour').toBe(true);

    const afterTheHour = () => new Date(Date.now() + (MINUTES_PER_HOUR + 1) * 60_000);
    await run({ now: afterTheHour });

    expect(
      await exists(tenantId, emails.createdOldActivatedRecently),
      'more than an hour after its activation',
    ).toBe(false);
    expect(
      await exists(tenantId, emails.orphanRecent),
      'more than an hour after its activation',
    ).toBe(false);
    expect(await exists(tenantId, emails.owner), 'a member is never an orphan').toBe(true);
    expect(await exists(tenantId, emails.invited), 'Invited').toBe(true);
    expect(await exists(tenantId, emails.staged), 'Staged').toBe(true);
    expect(await exists(tenantId, emails.service), 'service account').toBe(true);
  }, 120_000);

  it('A run whose CERBOS_ADDRESS is unreachable creates and removes no `_user` row (the pipeline fails closed)', async () => {
    const { tenantId, emails } = await seedOrphanTenant();
    const missing = await seedTenant();
    const before = await userEventCount(tenantId);

    await expect(
      main({ env: env(UNREACHABLE_CERBOS_ADDRESS), appPool, authPool }),
    ).rejects.toThrow();

    expect(await exists(missing.tenantId, missing.owner.email), 'no row created').toBe(false);
    expect(await userEventCount(missing.tenantId)).toBe(0);
    expect(await userEventCount(tenantId), 'no orphan removed').toBe(before);
    expect(await exists(tenantId, emails.orphanOld)).toBe(true);
    expect(await exists(tenantId, emails.orphanRelated)).toBe(true);
  }, 120_000);
});
