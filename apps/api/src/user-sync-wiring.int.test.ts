/**
 * Task 4.1b of openspec/changes/043-identity-lifecycle-and-org-admin (design D2,
 * Resolved decisions Q10, Q11, Q30 and Q76).
 *
 * Task 4.1b: "`createApp` builds the adapter of 4.1 and passes it to `createAuth`
 * as `userSync` (today it passes none, so every status hook is a no-op in the
 * running app). Verify: `user-sync-wiring.int.test.ts` boots `createApp` and covers
 * a membership added through Better Auth writing the `_user` entity through the
 * state machine."
 *
 * ## Harness
 *
 * The app is built by `createApp` over the harness pools (no mock, no hand-made
 * `userSync`: the point is that `createApp` wires it). The membership is added
 * through the Better Auth instance the app mounts (`app.auth.api.addMember`), so
 * `afterAddMember` fires inside the running app. The `_user` entity is read back
 * through a separate `createUserSync` over the same app pool. Each test uses a
 * fresh organization (the tenant) and fresh users.
 *
 * ## Production symbols expected
 *
 * - `createApp` (`./server.js`) builds `createUserSyncAdapter({ userSync:
 *   createUserSync({ pool: appPool, authz }) })` (`./identity/user-sync-adapter.js`,
 *   `@tayzu/catalog`) and passes it to `createAuth` as `userSync`. Nothing new is
 *   imported by this test beyond what exists.
 *
 * ## Why this fails right now
 *
 * `createApp` passes no `userSync`, so `afterAddMember` writes nothing: the member
 * has no `_user` row (assertion failure).
 */
// Load-bearing import order (design D1): the telemetry harness registers before
// anything that loads `@tayzu/auth` creates its logger.
import { registration, type TelemetryTestHarness } from './__fixtures__/link-telemetry.js';
import { randomUUID } from 'node:crypto';

import { createCerbosClient } from '@tayzu/authz';
import { createUserSync } from '@tayzu/catalog';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { harnessPools } from './__fixtures__/pools.js';
import { createApp, type App } from './server.js';
import { createAdminUser } from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_SECRET, TEST_PASSWORD } from '../../../packages/auth/src/__fixtures__/test-secret.js';

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
}

const EVENT_NAME = 'catalog.audit.user_status_changed';

describe('createApp wires the _user status adapter into Better Auth (task 4.1b)', () => {
  let harness: TelemetryTestHarness;
  let app: App;
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
    app = await createApp({
      appPool: pools.appPool,
      authPool: pools.authPool,
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: ['https://app.tayzu.test'],
    });
    api = app.auth.api as AuthAdminSurface;
    userSync = createUserSync({
      pool: pools.appPool,
      authz: createCerbosClient({ address: 'localhost:3593', tls: false }),
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  /** An organization (the tenant) owned by an `admin`-role user. */
  async function createOrg(): Promise<string> {
    const id = randomUUID();
    const owner = await api.createUser({
      body: {
        name: 'Wiring Owner',
        email: `wiring-owner-${id}@example.test`,
        password: TEST_PASSWORD,
        role: 'admin',
      },
    });
    const org = await api.createOrganization({
      body: { name: 'Wiring Org', slug: `wiring-org-${id}`, userId: owner.user.id },
    });
    return org.id;
  }

  async function createMember(): Promise<{ userId: string; email: string }> {
    return await createAdminUser(app.auth, {
      name: 'Wiring Member',
      email: `wiring-member-${randomUUID()}@example.test`,
      password: TEST_PASSWORD,
    });
  }

  async function statusEvents(tenantId: string, userId: string): Promise<readonly unknown[]> {
    await harness.forceFlush();
    return [...harness.logExporter.getFinishedLogRecords()]
      .filter(
        (record) =>
          record.eventName === EVENT_NAME &&
          record.attributes['tayzu.tenant.id'] === tenantId &&
          record.attributes['tayzu.identity.user.id'] === userId,
      )
      .map((record) => record.attributes['tayzu.identity.user.status.event']);
  }

  it('A membership added through Better Auth writes the _user entity: Active, through created_active', async () => {
    const tenantId = await createOrg();
    const member = await createMember();
    expect(
      await userSync.getUser({ tenantId, email: member.email }),
      'precondition: the member has no _user row',
    ).toBeNull();

    await api.addMember({
      body: { userId: member.userId, organizationId: tenantId, role: 'member' },
    });

    const row = await userSync.getUser({ tenantId, email: member.email });
    expect(row, 'the membership hook wrote the _user entity').not.toBeNull();
    expect(row?.status).toBe('Active');
    expect(await statusEvents(tenantId, member.userId)).toEqual(['created_active']);
  }, 60_000);

  it('the write goes through the state machine: an Invited row is activated by invitation_accepted', async () => {
    const tenantId = await createOrg();
    const member = await createMember();
    await userSync.upsertUser({
      tenantId,
      email: member.email,
      name: 'Seeded Person',
      status: 'Invited',
    });

    await api.addMember({
      body: { userId: member.userId, organizationId: tenantId, role: 'member' },
    });

    const row = await userSync.getUser({ tenantId, email: member.email });
    expect(row?.status).toBe('Active');
    expect(await statusEvents(tenantId, member.userId)).toEqual(['invitation_accepted']);
  }, 60_000);

  it('the write goes through the state machine: a Disabled row is not revived by the membership hook', async () => {
    const tenantId = await createOrg();
    const member = await createMember();
    await userSync.upsertUser({
      tenantId,
      email: member.email,
      name: 'Seeded Person',
      status: 'Disabled',
    });

    await api.addMember({
      body: { userId: member.userId, organizationId: tenantId, role: 'member' },
    });

    const row = await userSync.getUser({ tenantId, email: member.email });
    expect(row?.status).toBe('Disabled');
    expect(await statusEvents(tenantId, member.userId)).toEqual([]);
  }, 60_000);
});
