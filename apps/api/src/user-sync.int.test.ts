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
import {
  createAdminUser,
  signInAdminUser,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';

const TEST_SECRET = 'int-test-only-secret-not-used-for-anything-real-0123456789';

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
      userSync: createUserSync({ pool: appPool, authz: cerbos }),
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
      password: 'correct-horse-battery-staple',
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
      password: 'correct-horse-battery-staple',
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
    const adminPassword = 'correct-horse-battery-staple';
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
      password: 'correct-horse-battery-staple',
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
  let userSync: ReturnType<typeof createUserSync>;
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
    userSync = createUserSync({ pool: pools.appPool, authz: cerbos });
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
      password: 'correct-horse-battery-staple',
    });
    const org = await (auth.api as BetterAuthAdminSurface).createOrganization({
      body: { name: 'Sync Org 18.5', slug: `sync-185-${id}`, userId: owner.userId },
    });
    const email = `created-${id}@example.test`;

    await client.identity.users.create(
      { email, name: 'Created By Admin', role: 'user' },
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
