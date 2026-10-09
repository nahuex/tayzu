/**
 * Task 4.4 of openspec/changes/043-identity-lifecycle-and-org-admin (spec "User
 * status has four states with forward-only transitions": the scenarios "First
 * sign-in activates a staged or invited user" and "First sign-in does not activate
 * a second tenant's `_user`"; design D2; Resolved decisions Q111 and Q117).
 *
 * ## Harness
 *
 * Two Better Auth instances share one database:
 *
 * - `seedAuth` has no `userSync`, so creating users, organizations and memberships
 *   through it never runs a status hook. The `_user` rows are then seeded directly
 *   through `createUserSync` (the way a failed acceptance whose compensation failed
 *   leaves them), so the membership hook cannot activate them first.
 * - `auth` is the instance under test: `userSync` is a recording wrapper around the
 *   real `createUserSyncAdapter`, so a hook's port input is visible and its write
 *   still goes through the state machine.
 *
 * The sign-in is a real `auth.handler(new Request(...))` call with a fresh random
 * `x-forwarded-for`. Each test uses fresh organizations (the tenants) and users.
 *
 * ## Production symbols expected
 *
 * - `createAuth` (`@tayzu/auth`) registers a first-sign-in hook (the task names no
 *   hook point; any successful local sign-in qualifies) that, for a user with exactly
 *   one `member` row, calls `options.userSync.upsertUser` with `change:
 *   'first_sign_in'`, `userId` the Better Auth user id, `principal: { kind: 'user',
 *   id: userId }` and `onBehalfOf: { type: 'user', id: userId }`, for that
 *   membership's tenant and the user's email; for two or more memberships it calls
 *   it with no `change`, or not at all.
 * - `createUserSyncAdapter` (`./identity/user-sync-adapter.js`) already handles the
 *   `first_sign_in` event (`nextStatus`) and the audit event.
 *
 * ## What the tests cover
 *
 * The activation tests assert that a first sign-in moves a `Staged` or `Invited`
 * row to `Active` (one `first_sign_in` write, with its audit event and telemetry).
 * The two-tenant and `Disabled` tests assert that nothing changes: a user with
 * memberships in two tenants is not activated, and a disabled user is refused
 * (4xx) and never revived.
 */
import { randomUUID } from 'node:crypto';

// Load-bearing import order (design D1): the telemetry harness registers before
// anything that loads `@tayzu/auth` creates its logger.
import { registration, type TelemetryTestHarness } from './__fixtures__/link-telemetry.js';
import { createAuth, authSchema, type AuthInstance, type UserSyncPort } from '@tayzu/auth';
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
type PortInput = Parameters<UserSyncPort['upsertUser']>[0];

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

interface ChangeEventRow {
  actor_type: string;
  on_behalf_of_type: string | null;
  on_behalf_of_id: string | null;
}

const EVENT_NAME = 'catalog.audit.user_status_changed';

describe('The first-sign-in hook (task 4.4)', () => {
  let harness: TelemetryTestHarness;
  let authPool: Pool;
  let auth: AuthInstance;
  let seedAuth: AuthInstance;
  let seedApi: AuthAdminSurface;
  let userSync: ReturnType<typeof createUserSync>;
  const portInputs: PortInput[] = [];

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
    const adapter = createUserSyncAdapter({ userSync });
    const db = drizzle(pools.authPool, { schema: authSchema });
    seedAuth = createAuth({ db, secret: TEST_SECRET });
    seedApi = seedAuth.api as AuthAdminSurface;
    auth = createAuth({
      db,
      secret: TEST_SECRET,
      userSync: {
        upsertUser: async (input) => {
          portInputs.push(input);
          await adapter.upsertUser(input);
        },
      },
    });
  }, 60_000);

  function randomIp(): string {
    const octet = (): string => String(Math.floor(Math.random() * 256));
    return `10.${octet()}.${octet()}.${String(1 + Math.floor(Math.random() * 254))}`;
  }

  /** An organization (the tenant), owned by a fresh user; no status hook runs. */
  async function createOrg(): Promise<string> {
    const id = randomUUID();
    const owner = await seedApi.createUser({
      body: {
        name: 'Org Owner',
        email: `first-sign-in-owner-${id}@example.test`,
        password: TEST_PASSWORD,
        role: 'admin',
      },
    });
    const org = await seedApi.createOrganization({
      body: { name: 'First Sign-In Org', slug: `first-sign-in-org-${id}`, userId: owner.user.id },
    });
    return org.id;
  }

  /** A member of every given tenant, each `_user` row seeded directly with the given status. */
  async function memberOf(
    seeded: readonly { readonly tenantId: string; readonly status: StatusName }[],
  ): Promise<{ userId: string; email: string }> {
    const member = await createAdminUser(seedAuth, {
      name: 'First Sign-In Member',
      email: `first-sign-in-member-${randomUUID()}@example.test`,
      password: TEST_PASSWORD,
    });
    for (const { tenantId, status } of seeded) {
      await seedApi.addMember({
        body: { userId: member.userId, organizationId: tenantId, role: 'member' },
      });
      await userSync.upsertUser({
        tenantId,
        email: member.email,
        name: 'Seeded Person',
        status,
      });
    }
    return member;
  }

  async function signIn(email: string): Promise<void> {
    await signInAdminUser(auth, { email, password: TEST_PASSWORD, ip: randomIp() });
  }

  async function changeEvents(tenantId: string, email: string): Promise<ChangeEventRow[]> {
    const result = await authPool.query<ChangeEventRow>(
      `select actor_type, on_behalf_of_type, on_behalf_of_id from catalog_change_event
       where tenant_id = $1 and blueprint_identifier = '_user' and resource_identifier = $2
       order by seq`,
      [tenantId, email],
    );
    return result.rows;
  }

  async function statusRecords(tenantId: string, userId: string) {
    await harness.forceFlush();
    return [...harness.logExporter.getFinishedLogRecords()].filter(
      (record) =>
        record.eventName === EVENT_NAME &&
        record.attributes['tayzu.tenant.id'] === tenantId &&
        record.attributes['tayzu.identity.user.id'] === userId,
    );
  }

  function statusWritesFor(userId: string): PortInput[] {
    return portInputs.filter((input) => input.userId === userId && input.change !== undefined);
  }

  it.each(['Staged', 'Invited'] as const)(
    'First sign-in activates a staged or invited user: a user whose only membership is %s ends Active',
    async (status) => {
      const tenantId = await createOrg();
      const member = await memberOf([{ tenantId, status }]);
      const seededEvents = (await changeEvents(tenantId, member.email)).length;
      expect(
        (await userSync.getUser({ tenantId, email: member.email }))?.status,
        'precondition',
      ).toBe(status);

      await signIn(member.email);

      const row = await userSync.getUser({ tenantId, email: member.email });
      expect(row?.status).toBe('Active');

      // The write is attributed to the user: `system` actor, `onBehalfOf` the user's own id.
      const events = await changeEvents(tenantId, member.email);
      expect(events).toHaveLength(seededEvents + 1);
      expect(events.at(-1)).toEqual({
        actor_type: 'system',
        on_behalf_of_type: 'user',
        on_behalf_of_id: member.userId,
      });

      // The hook's port input names the user as `userId`, the event and the principal.
      const writes = statusWritesFor(member.userId);
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        tenantId,
        email: member.email,
        userId: member.userId,
        change: 'first_sign_in',
        principal: { kind: 'user', id: member.userId },
      });

      // One status event, through the state machine, naming the user three ways.
      const records = await statusRecords(tenantId, member.userId);
      expect(records).toHaveLength(1);
      expect(records[0]?.attributes).toMatchObject({
        'tayzu.tenant.id': tenantId,
        'tayzu.identity.user.status.from': status,
        'tayzu.identity.user.status.to': 'Active',
        'tayzu.identity.user.status.event': 'first_sign_in',
        'tayzu.identity.user.id': member.userId,
        'tayzu.actor.id': member.userId,
      });
      expect(JSON.stringify(records[0]?.attributes)).not.toContain(member.email);
    },
    60_000,
  );

  it('A disabled user is not revived by signing in: the only membership stays Disabled', async () => {
    const tenantId = await createOrg();
    const member = await memberOf([{ tenantId, status: 'Disabled' }]);
    // The disable of a single-membership user also bans the Better Auth user.
    await authPool.query('update auth."user" set banned = true where id = $1', [member.userId]);
    const before = await userSync.getUser({ tenantId, email: member.email });
    const eventsBefore = await changeEvents(tenantId, member.email);
    const recordsBefore = await statusRecords(tenantId, member.userId);

    // Sign-in is refused with a client error (4xx); a 5xx would be an internal error.
    await expect(signIn(member.email)).rejects.toThrow(/status 4\d\d/);

    expect(await userSync.getUser({ tenantId, email: member.email })).toEqual(before);
    expect((await userSync.getUser({ tenantId, email: member.email }))?.status).toBe('Disabled');
    expect(await changeEvents(tenantId, member.email)).toEqual(eventsBefore);
    expect(await statusRecords(tenantId, member.userId)).toEqual(recordsBefore);
    expect(statusWritesFor(member.userId)).toEqual([]);
  }, 60_000);

  it('A disabled user is not revived by signing in: Disabled in one of two tenants stays unchanged', async () => {
    const t1 = await createOrg();
    const t2 = await createOrg();
    const member = await memberOf([
      { tenantId: t1, status: 'Disabled' },
      { tenantId: t2, status: 'Active' },
    ]);
    const before1 = await userSync.getUser({ tenantId: t1, email: member.email });
    const before2 = await userSync.getUser({ tenantId: t2, email: member.email });
    const events1 = await changeEvents(t1, member.email);
    const events2 = await changeEvents(t2, member.email);

    // Disabled in one tenant of two does not ban the user, so the sign-in itself succeeds.
    await signIn(member.email);

    expect(await userSync.getUser({ tenantId: t1, email: member.email })).toEqual(before1);
    expect((await userSync.getUser({ tenantId: t1, email: member.email }))?.status).toBe(
      'Disabled',
    );
    expect(await userSync.getUser({ tenantId: t2, email: member.email })).toEqual(before2);
    expect(await changeEvents(t1, member.email)).toEqual(events1);
    expect(await changeEvents(t2, member.email)).toEqual(events2);
    expect(statusWritesFor(member.userId)).toEqual([]);
    expect(await statusRecords(t1, member.userId)).toEqual([]);
    expect(await statusRecords(t2, member.userId)).toEqual([]);
  }, 60_000);

  it('a member whose single membership has no _user row signs in locally', async () => {
    const tenantId = await createOrg();
    // `memberOf([])` creates the user with no `_user` row; the membership is added by hand.
    const member = await memberOf([]);
    await seedApi.addMember({
      body: { userId: member.userId, organizationId: tenantId, role: 'member' },
    });
    expect(
      await userSync.getUser({ tenantId, email: member.email }),
      'precondition: the member has no _user row',
    ).toBeNull();
    const eventsBefore = await changeEvents(tenantId, member.email);

    // `signIn` throws on any non-200 answer, so this asserts that the sign-in succeeds.
    await signIn(member.email);

    expect(
      await userSync.getUser({ tenantId, email: member.email }),
      'no _user row was created',
    ).toBeNull();
    expect(await changeEvents(tenantId, member.email)).toEqual(eventsBefore);
    // Q133: the hook cannot read whether a row exists, so it calls the port once with
    // `first_sign_in`; the adapter treats that call as a no-op (no row, no event, no record).
    const writes = statusWritesFor(member.userId);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      tenantId,
      email: member.email,
      userId: member.userId,
      change: 'first_sign_in',
    });
    expect(await statusRecords(tenantId, member.userId)).toEqual([]);
  }, 60_000);

  it.each(['Invited', 'Staged'] as const)(
    "First sign-in does not activate a second tenant's _user: Active in t1, %s in t2, both rows unchanged",
    async (secondStatus) => {
      const t1 = await createOrg();
      const t2 = await createOrg();
      const member = await memberOf([
        { tenantId: t1, status: 'Active' },
        { tenantId: t2, status: secondStatus },
      ]);
      const before1 = await userSync.getUser({ tenantId: t1, email: member.email });
      const before2 = await userSync.getUser({ tenantId: t2, email: member.email });
      const events1 = await changeEvents(t1, member.email);
      const events2 = await changeEvents(t2, member.email);

      await signIn(member.email);

      expect(await userSync.getUser({ tenantId: t1, email: member.email })).toEqual(before1);
      expect(await userSync.getUser({ tenantId: t2, email: member.email })).toEqual(before2);
      expect((await userSync.getUser({ tenantId: t2, email: member.email }))?.status).toBe(
        secondStatus,
      );
      expect(await changeEvents(t1, member.email)).toEqual(events1);
      expect(await changeEvents(t2, member.email)).toEqual(events2);

      // No status write reached the port, and no status event was emitted in either tenant.
      expect(statusWritesFor(member.userId)).toEqual([]);
      expect(await statusRecords(t1, member.userId)).toEqual([]);
      expect(await statusRecords(t2, member.userId)).toEqual([]);
    },
    60_000,
  );
});
