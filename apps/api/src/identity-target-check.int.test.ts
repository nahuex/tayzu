/**
 * Task 16.12a of openspec/changes/043-identity-lifecycle-and-org-admin (design D3 and
 * D10 step 3; Resolved decisions Q62, Q90 and Q149): the target check of the identity
 * wrapper sends the resolved target's real resource.
 *
 * - `setStatus` on a human sends the Better Auth user id, the target's tenant, and the
 *   `accountKind`, `portRole` and `moderatedBlueprints` of its `_user`.
 * - `setStatus` on a service account and `serviceAccounts.delete` declare the service
 *   account as their target and send its `svc-…` identifier with the same attributes.
 * - `credentials.rotate` sends the credential id and the tenant.
 * - `credentials.list` has no target; its check sends the resource id `list`.
 *
 * ## Harness
 *
 * Real `auth`, real adapter, real Cerbos at `localhost:3593`, wrapped by a recording client
 * that keeps every `checkResources` request. One fresh organization (random tenant id) with
 * an `admin` member per test. The caller check is the one with the fixed id `new`; the
 * target check is the other one.
 *
 * ## Production symbols expected
 *
 * Nothing new: `createIdentityRouter` (`./identity-router.js`) and
 * `createDefineIdentityOperation` (`./identity/define-operation.js`) change behavior. The
 * wrapper builds the target resource with `buildIdentityResource`
 * (`./identity/identity-attributes.js`) from the resolved record, and the two service
 * account procedures return a target from `resolveTarget` instead of `undefined`.
 */
import { randomUUID } from 'node:crypto';

import { createRouterClient } from '@orpc/server';
import { authSchema, createAuth, type AuthInstance } from '@tayzu/auth';
import { createCerbosClient, type CerbosClient } from '@tayzu/authz';
import { createUserSync } from '@tayzu/catalog';
import { runMigrations } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { createAdminUser } from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createIdentityRouter } from './identity-router.js';
import { createAuthRepository } from './identity/auth-repository.js';
import { createWithUserLock } from './identity/user-lock.js';
import { createUserSyncAdapter } from './identity/user-sync-adapter.js';

interface RecordedCheck {
  readonly kind: string;
  readonly id: string;
  readonly action: string;
  readonly attr: Record<string, unknown>;
}

interface OrganizationSurface {
  createOrganization(args: {
    body: { name: string; slug: string; userId: string };
  }): Promise<{ id: string }>;
  addMember(args: {
    body: { userId: string; organizationId: string; role: string };
  }): Promise<unknown>;
}

interface Tenant {
  readonly tenantId: string;
  readonly adminId: string;
}

interface IdentityClient {
  identity: {
    users: {
      setStatus(
        input: { params: { user: string }; body: { status: 'Active' | 'Disabled' } },
        options: { context: Record<string, unknown> },
      ): Promise<unknown>;
    };
    serviceAccounts: {
      create(
        input: { body: { identifier: string } },
        options: { context: Record<string, unknown> },
      ): Promise<{ clientId: string }>;
      delete(
        input: { params: { user: string } },
        options: { context: Record<string, unknown> },
      ): Promise<unknown>;
    };
    credentials: {
      rotate(
        input: { params: { credential: string } },
        options: { context: Record<string, unknown> },
      ): Promise<unknown>;
      list(
        input: { query: Record<string, never> },
        options: { context: Record<string, unknown> },
      ): Promise<unknown>;
    };
  };
}

describe('the target check of the identity wrapper sends the real resource (task 16.12a)', () => {
  let appPool: Pool;
  let authPool: Pool;
  let auth: AuthInstance;
  let cerbos: CerbosClient;
  let checks: RecordedCheck[];
  let client: IdentityClient;

  beforeAll(async () => {
    const pools = await harnessPools();
    appPool = pools.appPool;
    authPool = pools.authPool;
    await runMigrations(authPool);
    const real = createCerbosClient({ address: 'localhost:3593', tls: false });
    checks = [];
    // The real client, with every request recorded.
    cerbos = {
      checkResources: async (request: Parameters<CerbosClient['checkResources']>[0]) => {
        for (const entry of request.resources) {
          checks.push({
            kind: entry.resource.kind,
            id: entry.resource.id,
            action: entry.actions[0] ?? '',
            attr: { ...(entry.resource.attr ?? {}) },
          });
        }
        return await real.checkResources(request);
      },
    } as unknown as CerbosClient;
    const userSync = createUserSyncAdapter({
      userSync: createUserSync({ pool: appPool, authz: real }),
    });
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync,
    });
    client = createRouterClient(
      createIdentityRouter({
        auth,
        authz: cerbos,
        authRepository: createAuthRepository(authPool),
        withUserLock: createWithUserLock(authPool),
        appPool,
        userSync,
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );
  }, 60_000);

  async function freshTenant(): Promise<Tenant> {
    const id = randomUUID();
    const api = auth.api as OrganizationSurface;
    const owner = await createAdminUser(auth, {
      name: 'Target Owner',
      email: `target-owner-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    const org = await api.createOrganization({
      body: { name: 'Target Org', slug: `target-${id}`, userId: owner.userId },
    });
    const admin = await createAdminUser(auth, {
      name: 'Target Admin',
      email: `target-admin-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    await api.addMember({ body: { userId: admin.userId, organizationId: org.id, role: 'admin' } });
    return { tenantId: org.id, adminId: admin.userId };
  }

  function context(tenant: Tenant): Record<string, unknown> {
    return {
      tenantId: tenant.tenantId,
      actor: { type: 'user', id: tenant.adminId },
      principal: { roles: ['admin'] },
    };
  }

  /** The checks of one action on one kind, minus the target-less caller check (`new`). */
  function targetChecks(kind: string, action: string): RecordedCheck[] {
    return checks.filter(
      (check) => check.kind === kind && check.action === action && check.id !== 'new',
    );
  }

  it('setStatus on a human sends the user id, the tenant and the attributes of its _user', async () => {
    const tenant = await freshTenant();
    const api = auth.api as OrganizationSurface;
    const human = await createAdminUser(auth, {
      name: 'Human Target',
      email: `human-${randomUUID()}@example.test`,
      password: TEST_PASSWORD,
    });
    await api.addMember({
      body: { userId: human.userId, organizationId: tenant.tenantId, role: 'member' },
    });
    checks.length = 0;

    await client.identity.users.setStatus(
      { params: { user: human.userId }, body: { status: 'Disabled' } },
      { context: context(tenant) },
    );

    const sent = targetChecks('user', 'updateStatus');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.id).toBe(human.userId);
    expect(sent[0]?.attr).toMatchObject({
      tenantId: tenant.tenantId,
      accountKind: 'standard',
      portRole: 'member',
    });
    expect(sent[0]?.attr['moderatedBlueprints']).toEqual([]);
  }, 60_000);

  it('setStatus on a service account declares it as the target and sends its svc identifier and attributes', async () => {
    const tenant = await freshTenant();
    const identifier = `svc-target-${randomUUID().slice(0, 8)}`;
    await client.identity.serviceAccounts.create(
      { body: { identifier } },
      { context: context(tenant) },
    );
    checks.length = 0;

    await client.identity.users.setStatus(
      { params: { user: identifier }, body: { status: 'Disabled' } },
      { context: context(tenant) },
    );

    const sent = targetChecks('user', 'updateStatus');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.id).toBe(identifier);
    expect(sent[0]?.attr).toMatchObject({
      tenantId: tenant.tenantId,
      accountKind: 'service',
      portRole: 'member',
    });
    expect(sent[0]?.attr['moderatedBlueprints']).toEqual([]);
  }, 60_000);

  it('serviceAccounts.delete declares the service account as the target and sends its svc identifier and attributes', async () => {
    const tenant = await freshTenant();
    const identifier = `svc-delete-${randomUUID().slice(0, 8)}`;
    await client.identity.serviceAccounts.create(
      { body: { identifier } },
      { context: context(tenant) },
    );
    checks.length = 0;

    await client.identity.serviceAccounts.delete(
      { params: { user: identifier } },
      { context: context(tenant) },
    );

    const sent = targetChecks('service_account', 'delete');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.id).toBe(identifier);
    expect(sent[0]?.attr).toMatchObject({
      tenantId: tenant.tenantId,
      accountKind: 'service',
      portRole: 'member',
    });
    expect(sent[0]?.attr['moderatedBlueprints']).toEqual([]);
  }, 60_000);

  it('credentials.rotate sends the credential id and the tenant', async () => {
    const tenant = await freshTenant();
    const identifier = `svc-rotate-${randomUUID().slice(0, 8)}`;
    const created = await client.identity.serviceAccounts.create(
      { body: { identifier } },
      { context: context(tenant) },
    );
    checks.length = 0;

    await client.identity.credentials.rotate(
      { params: { credential: created.clientId } },
      { context: context(tenant) },
    );

    const sent = targetChecks('credential', 'rotate');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.id).toBe(created.clientId);
    expect(sent[0]?.attr['tenantId']).toBe(tenant.tenantId);
  }, 60_000);

  it('credentials.list sends the resource id list', async () => {
    const tenant = await freshTenant();
    checks.length = 0;

    await client.identity.credentials.list({ query: {} }, { context: context(tenant) });

    const sent = checks.filter((check) => check.kind === 'credential' && check.action === 'list');
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(sent.every((check) => check.id === 'list')).toBe(true);
    expect(sent.every((check) => check.attr['tenantId'] === tenant.tenantId)).toBe(true);
  }, 60_000);
});
