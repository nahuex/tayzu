/**
 * `043` task 2.2: the one-off, idempotent backfill that brings every existing
 * tenant's `_user` blueprint forward to the `USER_BLUEPRINT` of task 2.1
 * (`accountKind`, four-value `status`), through `blueprints.update` as the
 * `system` actor (design D1, D9).
 *
 * ## Production symbols expected (none of them is implemented yet)
 *
 * ```ts
 * // apps/api/scripts/backfill-user-blueprint.ts
 * export interface BackfillOptions {
 *   // Defaults to process.env. Read through loadScriptConfig(
 *   // 'backfill-user-blueprint', env): DATABASE_URL, AUTH_DATABASE_URL and
 *   // CERBOS_ADDRESS. The Cerbos client is built the way createApp does
 *   // (tls: false only on a loopback address).
 *   readonly env?: Readonly<Record<string, string | undefined>>;
 *   // Pools the host already built. When given, the script uses them and does
 *   // not build or end pools from the URLs. appPool runs as tayzu_app, authPool
 *   // as tayzu_auth; both are passed to runScript as role checks.
 *   readonly appPool?: Pool;
 *   readonly authPool?: Pool;
 * }
 * export function main(options?: BackfillOptions): Promise<void>;
 * ```
 *
 * The script lists tenants (`auth.organization.id`) through the `authPool`,
 * and for each one, one at a time: reads the tenant's `_user` through the
 * catalog's blueprint service as the `system` actor, skips it when its
 * `schema` already equals the one `buildUserBlueprintInput()` yields, and
 * otherwise calls `blueprints.update` with that full input. Any other failure
 * propagates and fails the run.
 *
 * ## Why a private scratch database
 *
 * The backfill enumerates EVERY tenant of `auth.organization`. Running it on
 * the shared `DATABASE_URL` database would rewrite the `_user` blueprint of the
 * tens of thousands of tenants that concurrently running test files own. This
 * file therefore migrates its own scratch database (the pattern of
 * `packages/catalog/src/persistence/schema.int.test.ts`) and seeds only its
 * own tenants there.
 */
import { randomUUID } from 'node:crypto';

import {
  buildUserBlueprintInput,
  createBlueprintService,
  createEntityService,
  type BlueprintService,
} from '@tayzu/catalog';
import { createCerbosClient } from '@tayzu/authz';
import { runMigrations } from '@tayzu/db';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { main } from '../../scripts/backfill-user-blueprint.js';

const CERBOS_ADDRESS = 'localhost:3593';
/** Nothing listens here: a loopback address, so the client is built without TLS. */
const UNREACHABLE_CERBOS_ADDRESS = 'localhost:1';
const SYSTEM_ACTOR = { type: 'system', id: 'backfill-test' } as const;
const SCRATCH_NAME_PATTERN = /^[a-z0-9_]+$/;

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
  const name = `tayzu_api_backfill_${randomUUID().replaceAll('-', '')}`;
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

/** The `_user` blueprint as it was before this change: no `accountKind`, two-value `status`. */
function oldUserBlueprint() {
  const current = buildUserBlueprintInput();
  const kept = { ...current.schema.properties };
  delete kept['accountKind'];
  delete kept['status'];
  return {
    ...current,
    schema: {
      ...current.schema,
      properties: {
        status: { type: 'string', title: { en: 'Status' }, enum: ['Active', 'Disabled'] },
        ...kept,
      },
    },
  };
}

describe('backfill-user-blueprint (task 2.2)', () => {
  const scratchName = scratchDatabaseName();
  let adminPool: Pool;
  let ownerScratchPool: Pool;
  let appPool: Pool;
  let authPool: Pool;
  let blueprints: ReturnType<typeof createBlueprintService>;
  let entities: ReturnType<typeof createEntityService>;
  let expectedSchema: Awaited<ReturnType<BlueprintService['get']>>['schema'];

  const env = (cerbosAddress: string) => ({
    NODE_ENV: 'test',
    DATABASE_URL: scratchUrl(scratchName),
    AUTH_DATABASE_URL: scratchUrl(scratchName),
    CERBOS_ADDRESS: cerbosAddress,
  });

  const context = (tenantId: string) => ({
    tenantId,
    actor: SYSTEM_ACTOR,
    principal: { roles: ['admin'] },
  });

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: ownerUrl(), max: 1 });
    await adminPool.query(`create database ${scratchName}`);

    ownerScratchPool = new Pool({ connectionString: scratchUrl(scratchName) });
    await runMigrations(ownerScratchPool);
    appPool = poolAs(scratchUrl(scratchName), 'tayzu_app');
    authPool = poolAs(scratchUrl(scratchName), 'tayzu_auth');

    const authz = createCerbosClient({ address: CERBOS_ADDRESS, tls: false });
    blueprints = createBlueprintService({ pool: appPool, authz });
    entities = createEntityService({ pool: appPool, authz });

    // The reference: what a new tenant's `_user` looks like after `buildUserBlueprintInput()`.
    const reference = await blueprints.create(
      context(`reference-${randomUUID()}`),
      buildUserBlueprintInput(),
    );
    expectedSchema = reference.schema;
  }, 120_000);

  afterAll(async () => {
    // End every pool first, then drop: a live connection would block the drop.
    await endQuietly(appPool);
    await endQuietly(authPool);
    await endQuietly(ownerScratchPool);
    await adminPool.query(`drop database if exists ${scratchName} with (force)`);
    await endQuietly(adminPool);
  }, 60_000);

  /** One tenant: an `auth.organization` row, the OLD `_user` blueprint and two `_user` entities. */
  async function seedTenant(): Promise<{ tenantId: string; emails: string[] }> {
    const tenantId = `org-${randomUUID()}`;
    await authPool.query(
      'insert into auth.organization (id, name, slug, created_at) values ($1, $2, $3, now())',
      [tenantId, 'Backfill Org', `backfill-${tenantId}`],
    );
    await blueprints.create(context(tenantId), oldUserBlueprint());
    const emails = [`a-${randomUUID()}@example.test`, `b-${randomUUID()}@example.test`];
    for (const [index, email] of emails.entries()) {
      await entities.create(context(tenantId), {
        blueprint: '_user',
        identifier: email,
        title: `User ${String(index)}`,
        spec: { properties: { status: index === 0 ? 'Active' : 'Disabled', portRole: 'member' } },
      });
    }
    return { tenantId, emails };
  }

  async function changeEventCount(tenantId: string): Promise<number> {
    const client = await appPool.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await client.query<{ count: string }>(
        'select count(*)::text as count from catalog_change_event where tenant_id = $1',
        [tenantId],
      );
      await client.query('commit');
      return Number(result.rows[0]?.count);
    } finally {
      client.release();
    }
  }

  const getUser = (tenantId: string) => blueprints.get(context(tenantId), { identifier: '_user' });

  it('seeds tenants that tayzu_app cannot enumerate (precondition)', async () => {
    await seedTenant();

    await expect(appPool.query('select id from auth.organization')).rejects.toThrow();
  }, 60_000);

  it('finds both seeded tenants through tayzu_auth, without enumerating through tayzu_app, and brings `_user` forward', async () => {
    const first = await seedTenant();
    const second = await seedTenant();
    const before = await Promise.all([first, second].map((t) => getUser(t.tenantId)));
    expect(before.map((b) => b.version)).toEqual([1, 1]);

    await main({ env: env(CERBOS_ADDRESS), appPool, authPool });

    for (const tenant of [first, second]) {
      const after = await getUser(tenant.tenantId);
      expect(after.version).toBe(2);
      expect(after.schema).toEqual(expectedSchema);
      expect(after.schema.properties).toHaveProperty('accountKind');
    }
  }, 120_000);

  it('adding accountKind and widening status is a compatible change: the update succeeds, existing `_user` entities stay valid and are not rewritten', async () => {
    const tenant = await seedTenant();
    const context_ = context(tenant.tenantId);
    const before = await Promise.all(
      tenant.emails.map((identifier) => entities.get(context_, { blueprint: '_user', identifier })),
    );

    await main({ env: env(CERBOS_ADDRESS), appPool, authPool });

    expect((await getUser(tenant.tenantId)).version).toBe(2);
    const after = await Promise.all(
      tenant.emails.map((identifier) => entities.get(context_, { blueprint: '_user', identifier })),
    );
    expect(after).toEqual(before);
    for (const entity of after) {
      expect(entity.spec.properties).not.toHaveProperty('accountKind');
    }
  }, 120_000);

  it('a second run changes nothing: no version bump and no new change event', async () => {
    const tenant = await seedTenant();
    await main({ env: env(CERBOS_ADDRESS), appPool, authPool });
    const versionAfterFirst = (await getUser(tenant.tenantId)).version;
    const eventsAfterFirst = await changeEventCount(tenant.tenantId);
    expect(versionAfterFirst).toBe(2);

    await main({ env: env(CERBOS_ADDRESS), appPool, authPool });

    expect((await getUser(tenant.tenantId)).version).toBe(versionAfterFirst);
    expect(await changeEventCount(tenant.tenantId)).toBe(eventsAfterFirst);
  }, 120_000);

  it('a run whose CERBOS_ADDRESS is unreachable updates no tenant (the pipeline fails closed)', async () => {
    const first = await seedTenant();
    const second = await seedTenant();
    const events = await Promise.all([first, second].map((t) => changeEventCount(t.tenantId)));

    await expect(
      main({ env: env(UNREACHABLE_CERBOS_ADDRESS), appPool, authPool }),
    ).rejects.toThrow();

    for (const [index, tenant] of [first, second].entries()) {
      const after = await getUser(tenant.tenantId);
      expect(after.version).toBe(1);
      expect(after.schema.properties).not.toHaveProperty('accountKind');
      expect(await changeEventCount(tenant.tenantId)).toBe(events[index]);
    }
  }, 120_000);
});
