/**
 * Task 4.2 of openspec/changes/043-identity-lifecycle-and-org-admin (spec
 * "A disabled user is not revived by a hook"; design D2; Resolved decisions Q11,
 * Q62 and Q76).
 *
 * `afterAddMember` is the single writer for a membership. It cannot read the
 * status, so it passes the `membership_added` intent and the adapter derives the
 * event from the stored status:
 *
 * - no row         -> `created_active`
 * - `Invited`      -> `invitation_accepted`
 * - `Staged`       -> `invitation_accepted`
 * - `Active`       -> no write
 * - `Disabled`     -> no write (a hook never revives a user)
 *
 * A member whose Better Auth user is `banned` and who has no row ends `Disabled`
 * (`created_active`, then `admin_disable`). The hook passes the Better Auth id of
 * its `user` as the port's `userId`, which the adapter exports as
 * `tayzu.identity.user.id`.
 *
 * ## Production symbols assumed
 *
 * - `createAuth` (`@tayzu/auth`) with `userSync` set to `createUserSyncAdapter`
 *   (`apps/api/src/identity/user-sync-adapter.ts`) over `createUserSync`
 *   (`@tayzu/catalog`). Both exist from task 4.1; this file asserts the behavior
 *   of `afterAddMember` through them. Each test observes the write through the
 *   `_user` read model and the `catalog.audit.user_status_changed` event (4.1e).
 *
 * The test lives in `apps/api` because the adapter does. Each test uses a fresh
 * organization (the tenant), so tests are isolated and run in parallel.
 */
import { randomUUID } from 'node:crypto';

// Load-bearing import order (design D1): the telemetry harness registers before
// anything that loads `@tayzu/auth` creates its logger.
import { registration, type TelemetryTestHarness } from './__fixtures__/link-telemetry.js';
import { createAuth, authSchema, type AuthInstance } from '@tayzu/auth';
import { createCerbosClient } from '@tayzu/authz';
import { createUserSync } from '@tayzu/catalog';
import { runMigrations } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { harnessPools } from './__fixtures__/pools.js';
import { createUserSyncAdapter } from './identity/user-sync-adapter.js';
import {
  createAdminUser,
  signInAdminUser,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_SECRET, TEST_PASSWORD } from '../../../packages/auth/src/__fixtures__/test-secret.js';

type StatusName = 'Staged' | 'Invited' | 'Active' | 'Disabled';

interface AuthAdminSurface {
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
}

const EVENT_NAME = 'catalog.audit.user_status_changed';

describe('afterAddMember is the single writer for a membership (task 4.2)', () => {
  let harness: TelemetryTestHarness;
  let authPool: Pool;
  let auth: AuthInstance;
  let api: AuthAdminSurface;
  let userSync: ReturnType<typeof createUserSync>;

  beforeAll(async () => {
    if ('error' in registration) {
      throw new Error(`createTelemetryTestHarness() failed: ${String(registration.error)}`, {
        cause: registration.error,
      });
    }
    harness = registration.harness;
    const pools = await harnessPools();
    authPool = pools.authPool;
    await runMigrations(pools.authPool);
    const cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    userSync = createUserSync({ pool: pools.appPool, authz: cerbos });
    auth = createAuth({
      db: drizzle(pools.authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync: createUserSyncAdapter({ userSync }),
    });
    api = auth.api as AuthAdminSurface;
  }, 60_000);

  function fresh(): { email: string; slug: string } {
    const id = randomUUID();
    return { email: `hook-${id}@example.test`, slug: `hook-org-${id}` };
  }

  function randomIp(): string {
    const octet = (): string => String(Math.floor(Math.random() * 256));
    return `10.${octet()}.${octet()}.${String(1 + Math.floor(Math.random() * 254))}`;
  }

  /** An organization (the tenant) owned by an `admin`-role user, plus that admin's session headers. */
  async function createOrg(): Promise<{ organizationId: string; adminHeaders: Headers }> {
    const owner = fresh();
    const admin = await api.createUser({
      body: { name: 'Org Admin', email: owner.email, password: TEST_PASSWORD, role: 'admin' },
    });
    const org = await api.createOrganization({
      body: { name: 'Hook Org', slug: owner.slug, userId: admin.user.id },
    });
    const session = await signInAdminUser(auth, {
      email: owner.email,
      password: TEST_PASSWORD,
      ip: randomIp(),
    });
    return {
      organizationId: org.id,
      adminHeaders: new Headers({ cookie: session.cookie }),
    };
  }

  async function createMember(): Promise<{ userId: string; email: string }> {
    const member = fresh();
    return await createAdminUser(auth, {
      name: 'Hook Member',
      email: member.email,
      password: TEST_PASSWORD,
    });
  }

  async function seed(tenantId: string, email: string, status: StatusName): Promise<void> {
    await userSync.upsertUser({ tenantId, email, name: 'Seeded Person', status });
  }

  async function changeEventCount(tenantId: string, email: string): Promise<number> {
    const result = await authPool.query<{ n: string }>(
      `select count(*)::text as n from catalog_change_event
       where tenant_id = $1 and blueprint_identifier = '_user' and resource_identifier = $2`,
      [tenantId, email],
    );
    return Number(result.rows[0]?.n);
  }

  /** The status events written for the tenant's members, in emission order (the owner's included). */
  async function auditEvents(tenantId: string) {
    await harness.forceFlush();
    return [...harness.logExporter.getFinishedLogRecords()].filter(
      (record) =>
        record.eventName === EVENT_NAME && record.attributes['tayzu.tenant.id'] === tenantId,
    );
  }

  function eventsFor(
    records: Awaited<ReturnType<typeof auditEvents>>,
    userId: string,
  ): readonly unknown[] {
    return records
      .filter((record) => record.attributes['tayzu.identity.user.id'] === userId)
      .map((record) => record.attributes['tayzu.identity.user.status.event']);
  }

  it('A disabled user is not revived by a hook: adding the membership of a Disabled user again leaves it Disabled', async () => {
    const { organizationId } = await createOrg();
    const member = await createMember();
    await seed(organizationId, member.email, 'Disabled');
    const before = await userSync.getUser({ tenantId: organizationId, email: member.email });
    const eventsBefore = await changeEventCount(organizationId, member.email);

    await api.addMember({
      body: { userId: member.userId, organizationId, role: 'member' },
    });

    const after = await userSync.getUser({ tenantId: organizationId, email: member.email });
    expect(after?.status).toBe('Disabled');
    expect(after).toEqual(before);
    expect(await changeEventCount(organizationId, member.email)).toBe(eventsBefore);
    expect(eventsFor(await auditEvents(organizationId), member.userId)).toEqual([]);
  }, 60_000);

  it('a member with no row gets created_active and an Active row', async () => {
    const { organizationId } = await createOrg();
    const member = await createMember();

    await api.addMember({
      body: { userId: member.userId, organizationId, role: 'member' },
    });

    const row = await userSync.getUser({ tenantId: organizationId, email: member.email });
    expect(row?.status).toBe('Active');
    expect(eventsFor(await auditEvents(organizationId), member.userId)).toEqual(['created_active']);
  }, 60_000);

  it.each(['Invited', 'Staged'] as const)(
    'a member whose row is %s gets invitation_accepted and an Active row',
    async (status) => {
      const { organizationId } = await createOrg();
      const member = await createMember();
      await seed(organizationId, member.email, status);

      await api.addMember({
        body: { userId: member.userId, organizationId, role: 'member' },
      });

      const row = await userSync.getUser({ tenantId: organizationId, email: member.email });
      expect(row?.status).toBe('Active');
      expect(eventsFor(await auditEvents(organizationId), member.userId)).toEqual([
        'invitation_accepted',
      ]);
    },
    60_000,
  );

  it('a member whose row is Active is no write: the row, its version and its change events stay as they were', async () => {
    const { organizationId } = await createOrg();
    const member = await createMember();
    await seed(organizationId, member.email, 'Active');
    const before = await userSync.getUser({ tenantId: organizationId, email: member.email });
    const eventsBefore = await changeEventCount(organizationId, member.email);

    await api.addMember({
      body: { userId: member.userId, organizationId, role: 'member' },
    });

    const after = await userSync.getUser({ tenantId: organizationId, email: member.email });
    expect(after?.status).toBe('Active');
    expect(after).toEqual(before);
    expect(await changeEventCount(organizationId, member.email)).toBe(eventsBefore);
    expect(eventsFor(await auditEvents(organizationId), member.userId)).toEqual([]);
  }, 60_000);

  it('a banned member with no row ends Disabled: created_active, then admin_disable', async () => {
    const { organizationId, adminHeaders } = await createOrg();
    const member = await createMember();
    await api.banUser({ body: { userId: member.userId }, headers: adminHeaders });

    await api.addMember({
      body: { userId: member.userId, organizationId, role: 'member' },
    });

    const row = await userSync.getUser({ tenantId: organizationId, email: member.email });
    expect(row?.status).toBe('Disabled');
    expect(eventsFor(await auditEvents(organizationId), member.userId)).toEqual([
      'created_active',
      'admin_disable',
    ]);
  }, 60_000);

  it("the membership event names its user's Better Auth id as tayzu.identity.user.id, and no email", async () => {
    const { organizationId } = await createOrg();
    const member = await createMember();

    await api.addMember({
      body: { userId: member.userId, organizationId, role: 'member' },
    });

    const records = (await auditEvents(organizationId)).filter(
      (record) => record.attributes['tayzu.identity.user.id'] === member.userId,
    );
    expect(records).toHaveLength(1);
    expect(records[0]?.attributes).toMatchObject({
      'tayzu.tenant.id': organizationId,
      'tayzu.identity.user.status.to': 'Active',
      'tayzu.identity.user.status.event': 'created_active',
      'tayzu.identity.user.id': member.userId,
    });
    expect(JSON.stringify(records[0]?.attributes)).not.toContain(member.email);
  }, 60_000);
});
