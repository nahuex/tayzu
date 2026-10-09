/**
 * Integration tests for task 12.2 (openspec/changes/002-auth-and-rbac; spec
 * auth-and-rbac, "User and Team system blueprints"; design D22, Resolved
 * decisions Q16 and Q26).
 *
 * Task 12.2: "Better Auth hooks (sign-up, organization-member add, ban/unban)
 * upsert the matching `_user` entity through the `system` actor path." Q16
 * removed sign-up: the sign-up trigger is replaced by user creation through
 * `auth.api.createUser` (admin-created) and the bootstrap script.
 *
 * The test lives in `apps/api` because it is the only package that depends on
 * `@tayzu/auth`, `@tayzu/authz` and `@tayzu/catalog` together (`@tayzu/auth`
 * has no grants on catalog tables and no dependency on `@tayzu/catalog`).
 *
 * ## Production symbols assumed (none of them exists yet)
 *
 * - `@tayzu/catalog` exports `createUserSync({ pool, authz })`, returning a
 *   `UserSync` object. It upserts the tenant's `_user` entity
 *   (`identifier` = the user's email, `title` = the user's name, properties
 *   `status`, `portRole`) through the entity service as the `system` actor
 *   (`{ type: 'system', ... }`, the reserved-identifier path). It creates the
 *   tenant's system blueprints first if they do not exist (idempotent,
 *   `bootstrapSystemBlueprints`), because the tenant (the Better Auth
 *   organization id) is only known once the organization exists, so the test
 *   cannot pre-bootstrap it.
 * - `@tayzu/auth`'s `createAuth` accepts `userSync` (the object above, typed
 *   structurally so `@tayzu/auth` need not depend on `@tayzu/catalog`) and
 *   calls it from Better Auth hooks: when an organization member row is
 *   created (organization-member add, including the owner membership created
 *   by `createOrganization`, so the bootstrap script is covered), and when a
 *   user is banned or unbanned (for every organization the user belongs to).
 *   Member role `owner`/`admin` maps to `portRole` `admin`, `member` to
 *   `member` (design Q2). Ban sets `status` `Disabled`, unban `Active`.
 *
 * The tenant is the organization id (`tenantId = organization id`).
 */
import { randomUUID } from 'node:crypto';

import { createRouterClient } from '@orpc/server';
import { bootstrapAdmin } from '../../../packages/auth/scripts/bootstrap-admin.js';
import { createAuth, authSchema, type AuthInstance } from '@tayzu/auth';
import { createCerbosClient } from '@tayzu/authz';
import { createEntityService, createUserSync } from '@tayzu/catalog';
import { runMigrations } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { harnessPools } from './__fixtures__/pools.js';
import { createIdentityRouter } from './identity-router.js';
import { createUserSyncAdapter } from './identity/user-sync-adapter.js';
import {
  createAdminUser,
  signInAdminUser,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_SECRET, TEST_PASSWORD } from '../../../packages/auth/src/__fixtures__/test-secret.js';

interface BetterAuthAdminSurface {
  createOrganization(args: {
    body: { name: string; slug: string; userId: string };
  }): Promise<{ id: string }>;
  addMember(args: {
    body: { userId: string; organizationId: string; role: string };
  }): Promise<unknown>;
  createUser(args: {
    body: { name: string; email: string; password: string; role: string };
  }): Promise<{ user: { id: string; email: string } }>;
  banUser(args: { body: { userId: string }; headers: Headers }): Promise<unknown>;
  unbanUser(args: { body: { userId: string }; headers: Headers }): Promise<unknown>;
}

interface UserEntity {
  readonly title: string;
  readonly createdBy: { readonly type: string };
  readonly spec: { readonly properties: Record<string, unknown> };
}

describe('Better Auth hooks upsert the matching `_user` entity (task 12.2)', () => {
  let appPool: Pool;
  let auth: AuthInstance;
  let api: BetterAuthAdminSurface;
  let readUser: (tenantId: string, email: string) => Promise<UserEntity>;

  beforeAll(async () => {
    const pools = await harnessPools();
    appPool = pools.appPool;
    await runMigrations(pools.authPool);
    const cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    auth = createAuth({
      db: drizzle(pools.authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync: createUserSyncAdapter({
        userSync: createUserSync({ pool: appPool, authz: cerbos }),
      }),
    });
    api = auth.api as BetterAuthAdminSurface;
    const entities = createEntityService({ pool: appPool, authz: cerbos });
    readUser = async (tenantId, email) =>
      await entities.get(
        {
          tenantId,
          actor: { type: 'system', id: 'user-sync-test' },
          principal: { roles: ['admin'] },
        },
        { blueprint: '_user', identifier: email },
      );
  }, 60_000);

  function fresh(): { email: string; slug: string } {
    const id = randomUUID();
    return { email: `sync-${id}@example.test`, slug: `sync-org-${id}` };
  }

  async function createOrgWithOwner(): Promise<{ organizationId: string }> {
    const owner = fresh();
    const ownerUser = await createAdminUser(auth, {
      name: 'Org Owner',
      email: owner.email,
      password: TEST_PASSWORD,
    });
    const org = await api.createOrganization({
      body: { name: 'Sync Org', slug: owner.slug, userId: ownerUser.userId },
    });
    return { organizationId: org.id };
  }

  it('Creating a user creates a matching `_user` entity: an admin-created user added to an organization gets an Active `_user` entity', async () => {
    const { organizationId } = await createOrgWithOwner();
    const member = fresh();
    const created = await createAdminUser(auth, {
      name: 'Created Member',
      email: member.email,
      password: TEST_PASSWORD,
    });
    await api.addMember({ body: { userId: created.userId, organizationId, role: 'member' } });

    const entity = await readUser(organizationId, member.email);
    expect(entity.title).toBe('Created Member');
    expect(entity.spec.properties['status']).toBe('Active');
    expect(entity.spec.properties['portRole']).toBe('member');
    expect(entity.createdBy.type).toBe('system');
  });

  it('Creating a user creates a matching `_user` entity: the bootstrap script creates the first admin with an Active `_user` entity', async () => {
    const params = {
      organizationName: 'Bootstrapped Org',
      organizationSlug: `sync-boot-${randomUUID()}`,
      adminName: 'First Admin',
      adminEmail: `sync-boot-${randomUUID()}@example.test`,
    };
    await bootstrapAdmin(auth, params);

    const org = await (
      auth.$context as Promise<{
        adapter: {
          findOne(a: { model: string; where: unknown[] }): Promise<{ id: string } | null>;
        };
      }>
    ).then((context) =>
      context.adapter.findOne({
        model: 'organization',
        where: [{ field: 'slug', value: params.organizationSlug }],
      }),
    );
    if (org === null) throw new Error('bootstrapped organization not found');

    const entity = await readUser(org.id, params.adminEmail);
    expect(entity.title).toBe('First Admin');
    expect(entity.spec.properties['status']).toBe('Active');
    expect(entity.spec.properties['portRole']).toBe('admin');
    expect(entity.createdBy.type).toBe('system');
  });

  it('Disabling a user updates its `_user` entity status: banning sets Disabled, unbanning sets Active again', async () => {
    // Better Auth's admin plugin requires an authenticated admin session on
    // banUser / unbanUser (adminMiddleware): sign in a real admin of the org.
    const adminCreds = fresh();
    const adminPassword = TEST_PASSWORD;
    const admin = await api.createUser({
      body: {
        name: 'Org Admin',
        email: adminCreds.email,
        password: adminPassword,
        role: 'admin',
      },
    });
    const org = await api.createOrganization({
      body: { name: 'Sync Org', slug: adminCreds.slug, userId: admin.user.id },
    });
    const organizationId = org.id;
    const session = await signInAdminUser(auth, {
      email: adminCreds.email,
      password: adminPassword,
      ip: `10.${String(Math.floor(Math.random() * 256))}.${String(Math.floor(Math.random() * 256))}.${String(1 + Math.floor(Math.random() * 254))}`,
    });
    const adminHeaders = new Headers({ cookie: session.cookie });
    const member = fresh();
    const created = await createAdminUser(auth, {
      name: 'Ban Target',
      email: member.email,
      password: TEST_PASSWORD,
    });
    await api.addMember({ body: { userId: created.userId, organizationId, role: 'member' } });
    expect((await readUser(organizationId, member.email)).spec.properties['status']).toBe('Active');

    await api.banUser({ body: { userId: created.userId }, headers: adminHeaders });
    expect((await readUser(organizationId, member.email)).spec.properties['status']).toBe(
      'Disabled',
    );

    await api.unbanUser({ body: { userId: created.userId }, headers: adminHeaders });
    expect((await readUser(organizationId, member.email)).spec.properties['status']).toBe('Active');
  });
});

/**
 * Task 18.5 (design D22): `identity.users.create` and the bootstrap script
 * upsert the `_user` entity themselves through the `system` actor path, no
 * longer relying on a Better Auth hook.
 *
 * ## Production symbols assumed (task 18.5, none exist yet)
 *
 * - `createIdentityRouter({ auth, authz, userSync })` takes a `UserSync`
 *   (`@tayzu/catalog`'s `createUserSync`) and, after `auth.api.createUser`
 *   succeeds, calls `userSync.upsertUser({ tenantId: context.tenantId, email,
 *   name, status: 'Active', ... })`, so a `_user` entity exists in the
 *   caller's tenant. The `portRole` mapping of the input `role` is not
 *   asserted (the spec leaves it open).
 * - `bootstrapAdmin(auth, params, { userSync })` takes an optional third
 *   argument carrying a `UserSync`; after creating the organization it
 *   upserts the first admin's `_user` entity (`status` `Active`, `portRole`
 *   `admin`) in that organization's tenant.
 *
 * To prove the wiring is direct and not the Better Auth hook, the `auth`
 * instance below is built WITHOUT `userSync`, so no hook can create the entity.
 */
describe('Creating a user creates a matching `_user` entity, without a Better Auth hook (task 18.5)', () => {
  let auth: AuthInstance;
  let userSync: ReturnType<typeof createUserSyncAdapter>;
  let client: ReturnType<
    typeof createRouterClient<ReturnType<typeof createIdentityRouter>, Record<string, unknown>>
  >;
  let tryReadUser: (tenantId: string, email: string) => Promise<UserEntity | undefined>;

  beforeAll(async () => {
    const pools = await harnessPools();
    await runMigrations(pools.authPool);
    const cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    auth = createAuth({
      db: drizzle(pools.authPool, { schema: authSchema }),
      secret: TEST_SECRET,
    });
    userSync = createUserSyncAdapter({
      userSync: createUserSync({ pool: pools.appPool, authz: cerbos }),
    });
    client = createRouterClient(createIdentityRouter({ auth, authz: cerbos, userSync }), {
      context: (raw: Record<string, unknown>) => raw,
    });
    const entities = createEntityService({ pool: pools.appPool, authz: cerbos });
    tryReadUser = async (tenantId, email) => {
      try {
        return await entities.get(
          {
            tenantId,
            actor: { type: 'system', id: 'user-sync-test' },
            principal: { roles: ['admin'] },
          },
          { blueprint: '_user', identifier: email },
        );
      } catch (error) {
        if ((error as { code?: unknown }).code === 'CATALOG_NOT_FOUND') return undefined;
        throw error;
      }
    };
  }, 60_000);

  it('Creating a user creates a matching `_user` entity: identity.users.create by an org admin yields an Active `_user` entity', async () => {
    const id = randomUUID();
    const owner = await createAdminUser(auth, {
      name: 'Tenant Owner',
      email: `owner-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    const org = await (auth.api as BetterAuthAdminSurface).createOrganization({
      body: { name: 'Sync Org 18.5', slug: `sync-185-${id}`, userId: owner.userId },
    });
    const email = `created-${id}@example.test`;

    await client.identity.users.create(
      { email, name: 'Created By Admin', role: 'member' },
      {
        context: {
          tenantId: org.id,
          actor: { type: 'user', id: `caller-${id}` },
          principal: { roles: ['admin'] },
        },
      },
    );

    const entity = await tryReadUser(org.id, email);
    expect(entity, 'a `_user` entity exists for the created user').toBeDefined();
    expect(entity?.title).toBe('Created By Admin');
    expect(entity?.spec.properties['status']).toBe('Active');
    expect(entity?.createdBy.type).toBe('system');
  }, 60_000);

  it('Creating a user creates a matching `_user` entity: the bootstrap script yields an Active admin `_user` entity', async () => {
    const params = {
      organizationName: 'Bootstrapped Org 18.5',
      organizationSlug: `sync-boot-185-${randomUUID()}`,
      adminName: 'First Admin',
      adminEmail: `sync-boot-185-${randomUUID()}@example.test`,
    };
    await (
      bootstrapAdmin as (
        a: AuthInstance,
        p: typeof params,
        o: { userSync: typeof userSync },
      ) => Promise<unknown>
    )(auth, params, { userSync });

    const org = await (
      auth.$context as Promise<{
        adapter: {
          findOne(a: { model: string; where: unknown[] }): Promise<{ id: string } | null>;
        };
      }>
    ).then((context) =>
      context.adapter.findOne({
        model: 'organization',
        where: [{ field: 'slug', value: params.organizationSlug }],
      }),
    );
    if (org === null) throw new Error('bootstrapped organization not found');

    const entity = await tryReadUser(org.id, params.adminEmail);
    expect(entity, 'a `_user` entity exists for the first admin').toBeDefined();
    expect(entity?.title).toBe('First Admin');
    expect(entity?.spec.properties['status']).toBe('Active');
    expect(entity?.spec.properties['portRole']).toBe('admin');
    expect(entity?.createdBy.type).toBe('system');
  }, 60_000);
});

/**
 * Task 4.1 of openspec/changes/043-identity-lifecycle-and-org-admin (spec "User
 * status has four states with forward-only transitions"; design D2; Resolved
 * decisions Q10 and Q83).
 *
 * ## Production symbols assumed (none of them exists yet)
 *
 * - `apps/api/src/identity/user-sync-adapter.ts` exports
 *   `createUserSyncAdapter({ userSync })`, where `userSync` is `@tayzu/catalog`'s
 *   `UserSync` extended with a read path `getUser({ tenantId, email })` returning
 *   `{ status, version }` or `null` (see `packages/catalog/src/service/user-sync.int.test.ts`),
 *   and an `upsertUser` that accepts `status` (four values), `expectedVersion` and
 *   `onBehalfOf`. The adapter implements `UserSyncPort`:
 *   - `upsertUser(input): Promise<void>`, whose input carries `change` (a
 *     `StatusEvent`, or the intent `membership_added`, not exercised here), `tenantId`,
 *     `email`, `name`, and optional `userId`, `invitationId` and `onBehalfOf`.
 *   - `writeUserChange(input): Promise<StatusEvent | undefined>`, the acceptance's
 *     entry point: same input, returns the status event it wrote, or `undefined`
 *     when it wrote nothing.
 *   It reads the current status and version through `userSync.getUser`, derives the
 *   status with `nextStatus`, and writes it. An existing row is written with the
 *   version it read as `expectedVersion`; a missing row is created, and a create race
 *   (`CATALOG_ALREADY_EXISTS`) or a version conflict (`CATALOG_VERSION_CONFLICT`) is
 *   re-read and retried a bounded number of times (3), then fails closed. A redundant
 *   event writes nothing. A disallowed pair rejects with `CATALOG_VALIDATION_FAILED`.
 * - The writes are made by the `system` actor with the input's `onBehalfOf` (a
 *   `{ type: 'user', id }` principal) on the change event.
 */
type StatusEventName =
  | 'created_staged'
  | 'created_invited'
  | 'created_active'
  | 'invitation_accepted'
  | 'first_sign_in'
  | 'admin_disable'
  | 'admin_enable';
type StatusName = 'Staged' | 'Invited' | 'Active' | 'Disabled';

interface UserReadModel {
  readonly status: StatusName;
  readonly version: number;
}

interface WriteInput {
  readonly tenantId: string;
  readonly email: string;
  readonly name: string;
  readonly change: StatusEventName;
  readonly userId?: string;
  readonly onBehalfOf?: { readonly type: 'user'; readonly id: string };
}

interface AdapterSurface {
  upsertUser(input: WriteInput): Promise<void>;
  writeUserChange(input: WriteInput): Promise<StatusEventName | undefined>;
}

describe('Every status writer goes through the state machine: the adapter (task 4.1)', () => {
  let appPool: Pool;
  let authPool: Pool;
  let cerbosUserSync: ReturnType<typeof createUserSync>;
  let readStatus: (tenantId: string, email: string) => Promise<StatusName | undefined>;

  beforeAll(async () => {
    const pools = await harnessPools();
    appPool = pools.appPool;
    authPool = pools.authPool;
    await runMigrations(authPool);
    const cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    cerbosUserSync = createUserSync({ pool: appPool, authz: cerbos });
    const entities = createEntityService({ pool: appPool, authz: cerbos });
    readStatus = async (tenantId, email) => {
      try {
        const entity = await entities.get(
          {
            tenantId,
            actor: { type: 'system', id: 'user-sync-adapter-test' },
            principal: { roles: ['admin'] },
          },
          { blueprint: '_user', identifier: email },
        );
        return entity.spec.properties['status'] as StatusName;
      } catch (error) {
        if ((error as { code?: unknown }).code === 'CATALOG_NOT_FOUND') return undefined;
        throw error;
      }
    };
  }, 60_000);

  function adapterOver(userSync: ReturnType<typeof createUserSync>): AdapterSurface {
    return createUserSyncAdapter({ userSync });
  }

  function adapter(): AdapterSurface {
    return adapterOver(cerbosUserSync);
  }

  function fresh(): { tenantId: string; email: string } {
    return {
      tenantId: `t${randomUUID().replaceAll('-', '')}`,
      email: `ad-${randomUUID()}@example.test`,
    };
  }

  async function seed(tenantId: string, email: string, status: StatusName): Promise<void> {
    await cerbosUserSync.upsertUser({ tenantId, email, name: 'Seeded Person', status });
  }

  async function read(tenantId: string, email: string): Promise<UserReadModel | null> {
    return await cerbosUserSync.getUser({ tenantId, email });
  }

  async function changeEventCount(tenantId: string, email: string): Promise<number> {
    const result = await authPool.query<{ n: string }>(
      `select count(*)::text as n from catalog_change_event
       where tenant_id = $1 and blueprint_identifier = '_user' and resource_identifier = $2`,
      [tenantId, email],
    );
    return Number(result.rows[0]?.n);
  }

  const ALLOWED: readonly (readonly [StatusEventName, StatusName | null, StatusName])[] = [
    ['created_staged', null, 'Staged'],
    ['created_invited', null, 'Invited'],
    ['created_invited', 'Staged', 'Invited'],
    ['created_active', null, 'Active'],
    ['invitation_accepted', 'Staged', 'Active'],
    ['invitation_accepted', 'Invited', 'Active'],
    ['first_sign_in', 'Staged', 'Active'],
    ['first_sign_in', 'Invited', 'Active'],
    ['admin_disable', 'Staged', 'Disabled'],
    ['admin_disable', 'Invited', 'Disabled'],
    ['admin_disable', 'Active', 'Disabled'],
    ['admin_enable', 'Disabled', 'Active'],
  ];

  it.each(ALLOWED)(
    'a write for the allowed event %s from %s ends %s',
    async (event, from, to) => {
      const { tenantId, email } = fresh();
      if (from !== null) await seed(tenantId, email, from);

      await adapter().upsertUser({ tenantId, email, name: 'Some Person', change: event });

      expect(await readStatus(tenantId, email)).toBe(to);
    },
    60_000,
  );

  it('Active never regresses to invited or staged: a rejected Active to Staged write fails with CATALOG_VALIDATION_FAILED and leaves Active', async () => {
    const { tenantId, email } = fresh();
    await seed(tenantId, email, 'Active');

    const error: unknown = await adapter()
      .upsertUser({ tenantId, email, name: 'Some Person', change: 'created_staged' })
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(error, 'the write must reject').toBeDefined();
    expect((error as { code?: unknown }).code).toBe('CATALOG_VALIDATION_FAILED');
    expect(await readStatus(tenantId, email)).toBe('Active');
  }, 60_000);

  it('Disable and re-enable: each change event is written as system with onBehalfOf set to the admin', async () => {
    const { tenantId, email } = fresh();
    const adminId = `admin-${randomUUID()}`;
    await seed(tenantId, email, 'Active');
    const onBehalfOf = { type: 'user', id: adminId } as const;

    await adapter().upsertUser({
      tenantId,
      email,
      name: 'Some Person',
      change: 'admin_disable',
      onBehalfOf,
    });
    expect(await readStatus(tenantId, email)).toBe('Disabled');
    await adapter().upsertUser({
      tenantId,
      email,
      name: 'Some Person',
      change: 'admin_enable',
      onBehalfOf,
    });
    expect(await readStatus(tenantId, email)).toBe('Active');

    const events = await authPool.query<{
      actor_type: string;
      on_behalf_of_type: string | null;
      on_behalf_of_id: string | null;
    }>(
      `select actor_type, on_behalf_of_type, on_behalf_of_id from catalog_change_event
       where tenant_id = $1 and blueprint_identifier = '_user' and resource_identifier = $2
       order by seq`,
      [tenantId, email],
    );
    const lastTwo = events.rows.slice(-2);
    expect(lastTwo).toHaveLength(2);
    for (const row of lastTwo) {
      expect(row.actor_type).toBe('system');
      expect(row.on_behalf_of_type).toBe('user');
      expect(row.on_behalf_of_id).toBe(adminId);
    }
  }, 60_000);

  it('A concurrent admin_disable between the adapter read and its write is never overwritten: the user stays Disabled', async () => {
    const { tenantId, email } = fresh();
    await seed(tenantId, email, 'Invited');
    let raced = false;
    const racing = {
      ...cerbosUserSync,
      upsertUser: cerbosUserSync.upsertUser.bind(cerbosUserSync),
      getUser: async (input: { tenantId: string; email: string }) => {
        const snapshot = await read(input.tenantId, input.email);
        if (!raced) {
          raced = true;
          await seed(input.tenantId, input.email, 'Disabled');
        }
        return snapshot;
      },
    };

    // The outcome of the lost write is open (it may reject on the transition from
    // Disabled or write nothing); only the status is asserted.
    await adapterOver(racing)
      .upsertUser({ tenantId, email, name: 'Some Person', change: 'first_sign_in' })
      .catch(() => undefined);

    expect(raced, 'the competing write ran').toBe(true);
    expect(await readStatus(tenantId, email)).toBe('Disabled');
  }, 60_000);

  it('A create race for a missing row (CATALOG_ALREADY_EXISTS) is retried like a version conflict, against the row the winner created', async () => {
    const { tenantId, email } = fresh();
    await seed(tenantId, email, 'Invited');
    let reads = 0;
    const racing = {
      ...cerbosUserSync,
      upsertUser: cerbosUserSync.upsertUser.bind(cerbosUserSync),
      getUser: async (input: { tenantId: string; email: string }) => {
        reads += 1;
        if (reads === 1) return null;
        return await read(input.tenantId, input.email);
      },
    };

    await adapterOver(racing).upsertUser({
      tenantId,
      email,
      name: 'Some Person',
      change: 'created_invited',
    });

    expect(reads).toBeGreaterThanOrEqual(2);
    expect(await readStatus(tenantId, email)).toBe('Invited');
  }, 60_000);

  it('A redundant event writes nothing: admin_enable on Active and admin_disable on Disabled', async () => {
    const enabled = fresh();
    await seed(enabled.tenantId, enabled.email, 'Active');
    const disabled = fresh();
    await seed(disabled.tenantId, disabled.email, 'Disabled');
    const enabledBefore = await read(enabled.tenantId, enabled.email);
    const disabledBefore = await read(disabled.tenantId, disabled.email);
    const enabledEvents = await changeEventCount(enabled.tenantId, enabled.email);
    const disabledEvents = await changeEventCount(disabled.tenantId, disabled.email);

    await adapter().upsertUser({
      tenantId: enabled.tenantId,
      email: enabled.email,
      name: 'Some Person',
      change: 'admin_enable',
    });
    await adapter().upsertUser({
      tenantId: disabled.tenantId,
      email: disabled.email,
      name: 'Some Person',
      change: 'admin_disable',
    });

    expect(await read(enabled.tenantId, enabled.email)).toEqual(enabledBefore);
    expect(await read(disabled.tenantId, disabled.email)).toEqual(disabledBefore);
    expect(await changeEventCount(enabled.tenantId, enabled.email)).toBe(enabledEvents);
    expect(await changeEventCount(disabled.tenantId, disabled.email)).toBe(disabledEvents);
  }, 60_000);

  it('A write fails closed once the retries are exhausted', async () => {
    const { tenantId, email } = fresh();
    await seed(tenantId, email, 'Invited');
    let reads = 0;
    const stale = {
      ...cerbosUserSync,
      upsertUser: cerbosUserSync.upsertUser.bind(cerbosUserSync),
      getUser: async (input: { tenantId: string; email: string }) => {
        reads += 1;
        const current = await read(input.tenantId, input.email);
        // Version 0 never exists, so every write is a version conflict.
        return current === null ? null : { status: current.status, version: 0 };
      },
    };

    await expect(
      adapterOver(stale).upsertUser({
        tenantId,
        email,
        name: 'Some Person',
        change: 'first_sign_in',
      }),
    ).rejects.toThrow();

    expect(reads, 'it retried before failing').toBeGreaterThan(1);
    expect(
      reads,
      'the retries are bounded (3 retries after the first attempt)',
    ).toBeLessThanOrEqual(4);
    expect(await readStatus(tenantId, email)).toBe('Invited');
  }, 60_000);

  it('The acceptance entry point returns invitation_accepted for an Invited row it activates', async () => {
    const { tenantId, email } = fresh();
    await seed(tenantId, email, 'Invited');

    const written = await adapter().writeUserChange({
      tenantId,
      email,
      name: 'Some Person',
      change: 'invitation_accepted',
    });

    expect(written).toBe('invitation_accepted');
    expect(await readStatus(tenantId, email)).toBe('Active');
  }, 60_000);

  it('The acceptance entry point returns created_active for a missing row it creates', async () => {
    const { tenantId, email } = fresh();

    const written = await adapter().writeUserChange({
      tenantId,
      email,
      name: 'Some Person',
      change: 'created_active',
    });

    expect(written).toBe('created_active');
    expect(await readStatus(tenantId, email)).toBe('Active');
  }, 60_000);

  it('The acceptance entry point returns no status event for a redundant event that writes nothing', async () => {
    const { tenantId, email } = fresh();
    await seed(tenantId, email, 'Active');

    const written = await adapter().writeUserChange({
      tenantId,
      email,
      name: 'Some Person',
      change: 'admin_enable',
    });

    expect(written).toBeUndefined();
    expect(await readStatus(tenantId, email)).toBe('Active');
  }, 60_000);
});
