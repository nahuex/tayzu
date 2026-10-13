/**
 * Task 11.2 of openspec/changes/043-identity-lifecycle-and-org-admin
 * (`identity.users.setStatus` for a human, Resolved decisions Q25 and Q117; design D13;
 * spec "Disabling a human takes effect immediately").
 *
 * Scenarios (verbatim from the spec):
 * - "Disable and re-enable": GIVEN a `_user` entity with status `Active`, WHEN an admin
 *   disables the user, and later re-enables them, THEN the status becomes `Disabled` and then
 *   `Active`, and in each case the change event is written as `system` with `onBehalfOf` set to
 *   the admin. Task 11.2 adds: each write emits one `catalog.audit.user_status_changed` with the
 *   admin as `tayzu.actor.id` and the status event `admin_disable` or `admin_enable`.
 * - "A disabled user's sessions stop working" (the revocation part only): GIVEN an `Active` user
 *   with a single membership and a live session, WHEN an admin disables the user, THEN the next
 *   request on that session is rejected with `CATALOG_CONTEXT_REQUIRED` (401) and no reason in
 *   the body. (A session the deletion did not reach is 13.4's; the refused sign-in is 13.x's.)
 *   Task 11.2 adds: one `auth.security.session_revoked` with the reason `admin_action` for each
 *   revoked session, the user banned by the disable, and a re-enabled single-membership user no
 *   longer banned, accepted by `resolveContext` and able to sign in.
 *
 * ## Harness
 *
 * The app is built by the production bootstrap (`createAppFromEnv`, harness pools through a
 * mocked `createPool`), so its `auth` has the real `_user` hooks and `resolveContext` serves the
 * `/v1` requests (`app.app.inject`). The operation under test runs in process through
 * `createRouterClient(createIdentityRouter(...))` on that same `auth`, with a real Cerbos at
 * `localhost:3593`. One fresh organization (random id) per test with an `admin` member and a
 * `member` target with a single membership. Every Better Auth call carries a fresh random
 * `x-forwarded-for`. Log events are read from the registered in-memory exporter.
 *
 * ## Production symbols expected
 *
 * - `createIdentityRouter` (`../identity-router.js`) gains the procedure
 *   `identity.users.setStatus`: a `defineIdentityOperation` on `RESOURCE_KINDS.user` / `update`
 *   (target resolved from the `user` field with `userTargetOf`), high-risk route
 *   `PUT /v1/users/{user}/status`, input `{ user: string; status: 'Active' | 'Disabled' }`.
 * - Its handler validates through `nextStatus`, writes `_user.status` through the adapter
 *   (`userSync.writeUserChange` with `change: 'admin_disable' | 'admin_enable'`, principal
 *   `{ kind: 'admin', id: <admin> }`, `onBehalfOf` the admin), deletes only the sessions of the
 *   tenant through `authRepository.deleteSessionsOf` (emitting `emitSessionRevoked` with the
 *   reason `admin_action` for each), and, when `globalMembershipTenantsOf` counts one tenant,
 *   sets `banned` / deletes all the user's sessions through `internalAdapter.updateUser` and
 *   `deleteUserSessions` (and `banned: false` on enable).
 *
 * ## Why this fails right now
 *
 * `identity.users.setStatus` does not exist on the router (a TypeError on the call).
 */
// Load-bearing import order (design D1): the telemetry harness registers
// before anything that loads `@tayzu/auth` creates its logger.
import { registration, type TelemetryTestHarness } from '../__fixtures__/link-telemetry.js';
import { randomInt, randomUUID } from 'node:crypto';

import { createRouterClient } from '@orpc/server';
import { createRecordingEmailSender } from '@tayzu/auth';
import { createCerbosClient, type CerbosClient } from '@tayzu/authz';
import { createEntityService, createUserSync } from '@tayzu/catalog';
import { withTenantTransaction } from '@tayzu/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import {
  bootstrapTestTenant,
  createAdminUser,
  signInAdminUser,
  testAppPool,
} from '../../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_SECRET } from '../../../../packages/auth/src/__fixtures__/test-secret.js';
import { harnessPools } from '../__fixtures__/pools.js';
import { createAppFromEnv } from '../bootstrap.js';
import { createIdentityRouter } from '../identity-router.js';
import type { App } from '../server.js';
import { createAuthRepository } from './auth-repository.js';
import { createEmailTenantGate } from './email-tenant-gate.js';
import { createInMemoryEmailCapStore } from './invitation-caps.js';
import { createWithUserLock } from './user-lock.js';
import { createUserSyncAdapter } from './user-sync-adapter.js';

const poolState = vi.hoisted(() => ({ pools: new Map<string, unknown>() }));

// `createPool` hands out the harness pools (production URLs need `sslmode=verify-full`);
// `end` is a no-op so the shared pools survive.
vi.mock('@tayzu/db', async (importActual) => {
  const actual = await importActual<typeof import('@tayzu/db')>();
  return {
    ...actual,
    createPool: vi.fn((url: string) => {
      const real = poolState.pools.get(url.includes('tayzu_auth') ? 'auth' : 'app') as object;
      return new Proxy(real, {
        get(target, prop) {
          if (prop === 'end') return () => Promise.resolve();
          const value: unknown = Reflect.get(target, prop, target);
          return typeof value === 'function'
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });
    }),
  };
});

const ORIGIN = 'https://app.tayzu.test';
const PASSWORD = 'correct horse battery staple';
const STATUS_EVENT = 'catalog.audit.user_status_changed';
const REVOKED_EVENT = 'auth.security.session_revoked';
const SELF_DENIED_EVENT = 'catalog.security.self_status_change_denied';

const ENV: Record<string, string> = {
  DATABASE_URL: 'postgres://tayzu_app:pw@db.invalid:5432/tayzu?sslmode=verify-full',
  AUTH_DATABASE_URL: 'postgres://tayzu_auth:pw@db.invalid:5432/tayzu?sslmode=verify-full',
  BETTER_AUTH_SECRET: TEST_SECRET,
  CERBOS_ADDRESS: 'localhost:3593',
  ALLOWED_ORIGINS: ORIGIN,
};

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

interface OrganizationSurface {
  addMember(args: {
    body: { userId: string; organizationId: string; role: string };
  }): Promise<unknown>;
}

interface Fixture {
  readonly tenantId: string;
  readonly adminId: string;
  readonly targetId: string;
  readonly targetEmail: string;
  /** Two live sessions of the target, both with the tenant as active organization. */
  readonly cookies: readonly string[];
  /** A live session of another member of the same tenant. */
  readonly bystanderCookie: string;
}

describe('identity.users.setStatus for a human (task 11.2)', () => {
  let harness: TelemetryTestHarness;
  let app: App;
  let appPool: Pool;
  let authPool: Pool;
  let cerbos: CerbosClient;
  let client: ReturnType<
    typeof createRouterClient<ReturnType<typeof createIdentityRouter>, Record<string, unknown>>
  >;

  interface StatusClient {
    identity: {
      users: {
        setStatus(
          input: { user: string; status: 'Active' | 'Disabled' },
          options: { context: Record<string, unknown> },
        ): Promise<unknown>;
      };
    };
  }

  beforeAll(async () => {
    if ('error' in registration) {
      throw new Error(`createTelemetryTestHarness() failed: ${String(registration.error)}`, {
        cause: registration.error,
      });
    }
    harness = registration.harness;
    const pools = await harnessPools();
    appPool = pools.appPool;
    authPool = pools.authPool;
    poolState.pools.set('app', appPool);
    poolState.pools.set('auth', authPool);
    app = await createAppFromEnv(ENV);
    cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    const userSync = createUserSyncAdapter({
      userSync: createUserSync({ pool: appPool, authz: cerbos }),
    });
    const capStore = createInMemoryEmailCapStore({
      tenant: { max: 1000, windowSeconds: 3600 },
      recipient: { max: 1000, windowSeconds: 86_400 },
    });
    client = createRouterClient(
      createIdentityRouter({
        auth: app.auth,
        authz: cerbos,
        authRepository: createAuthRepository(authPool),
        withUserLock: createWithUserLock(authPool),
        emailGate: createEmailTenantGate({
          disabledTenantIds: [],
          capStore,
          sender: createRecordingEmailSender(),
        }),
        appPool,
        userSync,
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );
  }, 60_000);

  afterAll(async () => {
    await app.close();
    poolState.pools.clear();
  }, 60_000);

  const statusClient = (): StatusClient => client;

  async function addMember(
    userId: string,
    organizationId: string,
    role: 'admin' | 'member',
  ): Promise<void> {
    await (app.auth.api as OrganizationSurface).addMember({
      body: { userId, organizationId, role },
    });
  }

  async function newMemberSession(
    tenantId: string,
    label: string,
    role: 'admin' | 'member',
  ): Promise<{ userId: string; email: string; cookie: string }> {
    const email = `status-${label}-${randomUUID()}@example.test`;
    const created = await createAdminUser(app.auth, {
      name: `Status ${label}`,
      email,
      password: PASSWORD,
    });
    await addMember(created.userId, tenantId, role);
    const signedIn = await signInAdminUser(app.auth, {
      email,
      password: PASSWORD,
      ip: randomIp(),
    });
    return { userId: created.userId, email, cookie: signedIn.cookie };
  }

  async function freshFixture(): Promise<Fixture> {
    const suffix = randomUUID();
    const owner = await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: 'Status Owner',
      email: `status-owner-${suffix}@example.test`,
      password: PASSWORD,
      organizationName: `Status Org ${suffix}`,
      organizationSlug: `status-${suffix}`,
      ip: randomIp(),
    });
    const tenantId = owner.organizationId;
    const admin = await newMemberSession(tenantId, 'admin', 'admin');
    const target = await newMemberSession(tenantId, 'target', 'member');
    const second = await signInAdminUser(app.auth, {
      email: target.email,
      password: PASSWORD,
      ip: randomIp(),
    });
    const bystander = await newMemberSession(tenantId, 'bystander', 'member');
    return {
      tenantId,
      adminId: admin.userId,
      targetId: target.userId,
      targetEmail: target.email,
      cookies: [target.cookie, second.cookie],
      bystanderCookie: bystander.cookie,
    };
  }

  function context(fixture: Fixture): Record<string, unknown> {
    return {
      tenantId: fixture.tenantId,
      actor: { type: 'user', id: fixture.adminId },
      principal: { roles: ['admin'] },
    };
  }

  function useSession(cookie: string) {
    return app.app.inject({ method: 'GET', url: '/v1/blueprints', headers: { cookie } });
  }

  async function userStatus(tenantId: string, email: string): Promise<string | null> {
    return await withTenantTransaction(appPool, { tenantId }, async (db) => {
      const result = await db.query<{ status: string | null }>(
        `select e.spec_properties ->> 'status' as status
           from catalog_entity e
           join catalog_blueprint b on b.tenant_id = e.tenant_id and b.id = e.blueprint_id
          where e.tenant_id = $1 and b.identifier = '_user' and e.identifier = $2`,
        [tenantId, email],
      );
      return result.rows[0]?.status ?? null;
    });
  }

  async function changeEvents(tenantId: string, email: string) {
    return await withTenantTransaction(appPool, { tenantId }, async (db) => {
      const result = await db.query<{
        action: string;
        actor_type: string;
        on_behalf_of_type: string | null;
        on_behalf_of_id: string | null;
      }>(
        `select action, actor_type, on_behalf_of_type, on_behalf_of_id
           from catalog_change_event
          where tenant_id = $1 and blueprint_identifier = '_user' and resource_identifier = $2
          order by seq`,
        [tenantId, email],
      );
      return result.rows;
    });
  }

  async function isBanned(userId: string): Promise<boolean> {
    const result = await authPool.query<{ banned: boolean | null }>(
      'select banned from auth."user" where id = $1',
      [userId],
    );
    return result.rows[0]?.banned === true;
  }

  async function sessionCount(userId: string): Promise<number> {
    const result = await authPool.query<{ n: string }>(
      'select count(*)::text as n from auth.session where user_id = $1',
      [userId],
    );
    return Number(result.rows[0]?.n ?? '0');
  }

  async function logRecords(eventName: string) {
    await harness.forceFlush();
    return [...harness.logExporter.getFinishedLogRecords()].filter(
      (record) => record.eventName === eventName,
    );
  }

  async function statusEventsOf(fixture: Fixture, event: 'admin_disable' | 'admin_enable') {
    return (await logRecords(STATUS_EVENT)).filter(
      (record) =>
        record.attributes['tayzu.tenant.id'] === fixture.tenantId &&
        record.attributes['tayzu.identity.user.id'] === fixture.targetId &&
        record.attributes['tayzu.identity.user.status.event'] === event,
    );
  }

  it('Disable and re-enable: the status becomes Disabled and then Active, each change event is written as system on behalf of the admin, and each write emits one user_status_changed with the admin and its status event', async () => {
    const fixture = await freshFixture();
    // GIVEN a `_user` entity with status `Active`.
    expect(await userStatus(fixture.tenantId, fixture.targetEmail)).toBe('Active');
    const eventsBefore = (await changeEvents(fixture.tenantId, fixture.targetEmail)).length;

    // WHEN an admin disables the user.
    await statusClient().identity.users.setStatus(
      { user: fixture.targetEmail, status: 'Disabled' },
      { context: context(fixture) },
    );

    // THEN the status is `Disabled`, written as `system` on behalf of the admin.
    expect(await userStatus(fixture.tenantId, fixture.targetEmail)).toBe('Disabled');
    const afterDisable = await changeEvents(fixture.tenantId, fixture.targetEmail);
    expect(afterDisable).toHaveLength(eventsBefore + 1);
    expect(afterDisable.at(-1)).toMatchObject({
      actor_type: 'system',
      on_behalf_of_type: 'user',
      on_behalf_of_id: fixture.adminId,
    });
    // AND the write emitted one `user_status_changed` naming the admin and `admin_disable`.
    const disabled = await statusEventsOf(fixture, 'admin_disable');
    expect(disabled).toHaveLength(1);
    expect(disabled[0]?.attributes).toMatchObject({
      'tayzu.actor.id': fixture.adminId,
      'tayzu.identity.user.status.from': 'Active',
      'tayzu.identity.user.status.to': 'Disabled',
      'tayzu.identity.user.status.event': 'admin_disable',
    });

    // WHEN the admin re-enables the user.
    await statusClient().identity.users.setStatus(
      { user: fixture.targetEmail, status: 'Active' },
      { context: context(fixture) },
    );

    // THEN the status is `Active` again, written as `system` on behalf of the admin.
    expect(await userStatus(fixture.tenantId, fixture.targetEmail)).toBe('Active');
    const afterEnable = await changeEvents(fixture.tenantId, fixture.targetEmail);
    expect(afterEnable).toHaveLength(eventsBefore + 2);
    expect(afterEnable.at(-1)).toMatchObject({
      actor_type: 'system',
      on_behalf_of_type: 'user',
      on_behalf_of_id: fixture.adminId,
    });
    // AND that write emitted one `user_status_changed` naming the admin and `admin_enable`.
    const enabled = await statusEventsOf(fixture, 'admin_enable');
    expect(enabled).toHaveLength(1);
    expect(enabled[0]?.attributes).toMatchObject({
      'tayzu.actor.id': fixture.adminId,
      'tayzu.identity.user.status.from': 'Disabled',
      'tayzu.identity.user.status.to': 'Active',
      'tayzu.identity.user.status.event': 'admin_enable',
    });
    // The disable's event is not repeated by the ban hook or the enable.
    expect(await statusEventsOf(fixture, 'admin_disable')).toHaveLength(1);
  }, 120_000);

  it("A disabled user's sessions stop working: for a single-membership user the next request on each deleted session answers 401 CATALOG_CONTEXT_REQUIRED with no reason, every session is revoked with one session_revoked (admin_action) each, the user is banned, other members are unaffected; re-enabling clears the ban, is accepted by the resolver and lets the user sign in", async () => {
    const fixture = await freshFixture();
    // GIVEN an `Active` user with a single membership and live sessions.
    for (const cookie of fixture.cookies) {
      expect((await useSession(cookie)).statusCode, 'precondition: live session').toBe(200);
    }
    expect(await sessionCount(fixture.targetId)).toBe(2);
    expect(await isBanned(fixture.targetId)).toBe(false);
    const revokedBefore = (await logRecords(REVOKED_EVENT)).filter(
      (record) => record.attributes['tayzu.actor.id'] === fixture.targetId,
    ).length;

    // WHEN an admin disables the user.
    await statusClient().identity.users.setStatus(
      { user: fixture.targetEmail, status: 'Disabled' },
      { context: context(fixture) },
    );

    // THEN the next request on each session is rejected with `CATALOG_CONTEXT_REQUIRED` (401)
    // and no reason in the body.
    for (const cookie of fixture.cookies) {
      const rejected = await useSession(cookie);
      expect(rejected.statusCode).toBe(401);
      expect(rejected.json<{ code: string }>().code).toBe('CATALOG_CONTEXT_REQUIRED');
      expect(rejected.body).not.toMatch(/user_banned|user_disabled|banned|disabled/i);
    }
    // AND all the user's sessions are gone and the user is banned (a single membership).
    expect(await sessionCount(fixture.targetId)).toBe(0);
    expect(await isBanned(fixture.targetId)).toBe(true);
    // AND another member of the tenant is unaffected.
    expect((await useSession(fixture.bystanderCookie)).statusCode).toBe(200);

    // AND one `auth.security.session_revoked` with the reason `admin_action` was emitted for
    // each revoked session, in the tenant.
    const revoked = (await logRecords(REVOKED_EVENT)).filter(
      (record) => record.attributes['tayzu.actor.id'] === fixture.targetId,
    );
    expect(revoked).toHaveLength(revokedBefore + 2);
    for (const record of revoked.slice(revokedBefore)) {
      expect(record.attributes['tayzu.auth.revocation.reason']).toBe('admin_action');
      expect(record.attributes['tayzu.tenant.id']).toBe(fixture.tenantId);
    }

    // WHEN the admin re-enables the user.
    await statusClient().identity.users.setStatus(
      { user: fixture.targetEmail, status: 'Active' },
      { context: context(fixture) },
    );

    // THEN the user is no longer banned, and the revoked sessions are not restored.
    expect(await isBanned(fixture.targetId)).toBe(false);
    expect(await sessionCount(fixture.targetId)).toBe(0);
    for (const cookie of fixture.cookies) {
      expect((await useSession(cookie)).statusCode).toBe(401);
    }
    // AND the user can sign in and the resolver accepts the new session.
    const signedIn = await signInAdminUser(app.auth, {
      email: fixture.targetEmail,
      password: PASSWORD,
      ip: randomIp(),
    });
    expect((await useSession(signedIn.cookie)).statusCode).toBe(200);
  }, 120_000);

  /**
   * Task 11.3. Scenario "A user cannot disable themselves" (verbatim): GIVEN an admin user
   * `u1`, WHEN `u1` attempts to change their own status to `Disabled`, THEN the operation is
   * denied with `AUTH_FORBIDDEN`, `u1` stays `Active`, and a
   * `catalog.security.self_status_change_denied` event is logged.
   *
   * The `{user}` identifier is the admin's own EMAIL, so the self-deny only works if the
   * comparison uses the resolved Better Auth user id (design D3, Q90), not the raw identifier.
   *
   * Production symbol expected: the event `catalog.security.self_status_change_denied`
   * (WARN, attributes `tayzu.tenant.id` and `tayzu.actor.id` only), emitted by the identity
   * pipeline when the Cerbos deny of `updateStatus` is a self-target.
   */
  it('A user cannot disable themselves: an admin naming their own email is denied with AUTH_FORBIDDEN, stays Active with nothing written or revoked, and self_status_change_denied is logged', async () => {
    const suffix = randomUUID();
    const owner = await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: 'Self Owner',
      email: `self-owner-${suffix}@example.test`,
      password: PASSWORD,
      organizationName: `Self Org ${suffix}`,
      organizationSlug: `self-${suffix}`,
      ip: randomIp(),
    });
    const tenantId = owner.organizationId;
    // GIVEN an admin user `u1`, `Active`, with a live session.
    const u1 = await newMemberSession(tenantId, 'self-admin', 'admin');
    const selfContext = {
      tenantId,
      actor: { type: 'user', id: u1.userId },
      principal: { roles: ['admin'] },
    };
    expect(await userStatus(tenantId, u1.email)).toBe('Active');
    // An admin session is authenticated but may be refused by the catalog (403): live means not 401.
    expect((await useSession(u1.cookie)).statusCode, 'precondition: live session').not.toBe(401);
    const eventsBefore = (await changeEvents(tenantId, u1.email)).length;
    const deniedBefore = (await logRecords(SELF_DENIED_EVENT)).filter(
      (record) => record.attributes['tayzu.tenant.id'] === tenantId,
    ).length;
    const statusBefore = (await logRecords(STATUS_EVENT)).filter(
      (record) => record.attributes['tayzu.tenant.id'] === tenantId,
    ).length;

    // WHEN `u1` attempts to change their own status to `Disabled`, naming themselves by email.
    await expect(
      statusClient().identity.users.setStatus(
        { user: u1.email, status: 'Disabled' },
        { context: selfContext },
      ),
    ).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });

    // THEN `u1` stays `Active`, nothing was written, and nothing was revoked or banned.
    expect(await userStatus(tenantId, u1.email)).toBe('Active');
    expect(await changeEvents(tenantId, u1.email)).toHaveLength(eventsBefore);
    expect(await sessionCount(u1.userId)).toBe(1);
    expect(await isBanned(u1.userId)).toBe(false);
    expect((await useSession(u1.cookie)).statusCode).not.toBe(401);
    const statusAfter = (await logRecords(STATUS_EVENT)).filter(
      (record) => record.attributes['tayzu.tenant.id'] === tenantId,
    ).length;
    expect(statusAfter).toBe(statusBefore);

    // AND exactly one `catalog.security.self_status_change_denied` is logged, with the tenant
    // and the actor and no email.
    const denied = (await logRecords(SELF_DENIED_EVENT)).filter(
      (record) => record.attributes['tayzu.tenant.id'] === tenantId,
    );
    expect(denied).toHaveLength(deniedBefore + 1);
    expect(denied.at(-1)?.attributes).toMatchObject({
      'tayzu.tenant.id': tenantId,
      'tayzu.actor.id': u1.userId,
    });
    expect(JSON.stringify(denied.at(-1))).not.toContain(u1.email);
  }, 120_000);

  /**
   * Task 11.4 (Resolved decision Q123; design D13). Scenario "Disabling cancels pending
   * invitations" (verbatim): GIVEN a pending invitation to `bob@example.com` from this tenant and
   * an existing `bob`, WHEN an admin disables `bob`, THEN the invitation's state becomes
   * `cancelled` with reason `user_disabled`, AND an invitation of `bob` that was already accepted
   * stays `accepted` and no cancellation is logged for it. Task 11.4 adds: the cancellation is
   * of that tenant only (a pending invitation to the same address from another tenant stays
   * pending). Stored `cancelled` is Better Auth's `canceled`.
   *
   * Production behavior expected: the `identity.users.setStatus` handler, on `Disabled`, reads the
   * tenant's pending invitations to the user's email (`authRepository.pendingInvitationsByEmail`),
   * cancels each (span `identity.invitation.cancel` with `tayzu.identity.invitation.id` and the
   * reason `user_disabled`) and logs `catalog.audit.invitation_cancelled` (`tayzu.tenant.id`,
   * `tayzu.actor.id` = the admin, `tayzu.identity.invitation.id`,
   * `tayzu.identity.invitation.reason` = `user_disabled`) for each one it cancelled only.
   */
  it("Disabling cancels pending invitations: the pending invitation to the user from this tenant becomes cancelled with the reason user_disabled and is logged and traced, an accepted invitation of the user stays accepted with no cancellation logged, and another tenant's pending invitation to the address stays pending", async () => {
    const fixture = await freshFixture();
    const cancelledEvent = 'catalog.audit.invitation_cancelled';
    const insertInvitation = async (
      organizationId: string,
      status: 'pending' | 'accepted',
    ): Promise<string> => {
      const id = `inv-${randomUUID()}`;
      await authPool.query(
        `insert into auth.invitation (id, organization_id, email, role, status, expires_at, created_at, inviter_id)
         values ($1, $2, $3, 'member', $4, now() + interval '48 hours', now(), $5)`,
        [id, organizationId, fixture.targetEmail, status, fixture.adminId],
      );
      return id;
    };
    const statusOf = async (id: string): Promise<string | undefined> => {
      const result = await authPool.query<{ status: string }>(
        'select status from auth.invitation where id = $1',
        [id],
      );
      return result.rows[0]?.status;
    };

    // GIVEN a pending invitation to the user from this tenant, one already accepted, and a
    // pending one to the same address from another tenant.
    const otherTenant = `org-${randomUUID()}`;
    await authPool.query(
      'insert into auth.organization (id, name, slug, created_at) values ($1, $2, $3, now())',
      [otherTenant, 'Other Org', `slug-${otherTenant}`],
    );
    const pendingId = await insertInvitation(fixture.tenantId, 'pending');
    const acceptedId = await insertInvitation(fixture.tenantId, 'accepted');
    const foreignId = await insertInvitation(otherTenant, 'pending');

    // WHEN an admin disables the user.
    await statusClient().identity.users.setStatus(
      { user: fixture.targetEmail, status: 'Disabled' },
      { context: context(fixture) },
    );

    // THEN the pending invitation is `cancelled` (stored `canceled`).
    expect(await statusOf(pendingId)).toBe('canceled');
    // AND the accepted one stays `accepted`, and the other tenant's stays `pending`.
    expect(await statusOf(acceptedId)).toBe('accepted');
    expect(await statusOf(foreignId)).toBe('pending');

    // AND exactly one cancellation is logged, for the pending invitation, with the reason
    // `user_disabled`, the tenant and the admin, and no email.
    const events = (await logRecords(cancelledEvent)).filter(
      (record) => record.attributes['tayzu.tenant.id'] === fixture.tenantId,
    );
    const forTarget = events.filter((record) =>
      [pendingId, acceptedId, foreignId].some(
        (id) => record.attributes['tayzu.identity.invitation.id'] === id,
      ),
    );
    expect(forTarget, 'one cancellation event, for the pending invitation only').toHaveLength(1);
    expect(forTarget[0]?.attributes).toMatchObject({
      'tayzu.tenant.id': fixture.tenantId,
      'tayzu.actor.id': fixture.adminId,
      'tayzu.identity.invitation.id': pendingId,
      'tayzu.identity.invitation.reason': 'user_disabled',
    });
    expect(JSON.stringify(forTarget[0]?.attributes)).not.toContain(fixture.targetEmail);

    // AND one `identity.invitation.cancel` span carries the same id and reason, none for the others.
    await harness.forceFlush();
    const spans = harness.spanExporter
      .getFinishedSpans()
      .filter(
        (span) =>
          span.name === 'identity.invitation.cancel' &&
          [pendingId, acceptedId, foreignId].some(
            (id) => span.attributes['tayzu.identity.invitation.id'] === id,
          ),
      );
    expect(spans).toHaveLength(1);
    expect(spans[0]?.attributes).toMatchObject({
      'tayzu.identity.invitation.id': pendingId,
      'tayzu.identity.invitation.reason': 'user_disabled',
    });
  }, 120_000);

  /**
   * Task 11.4b (Resolved decisions Q63 and Q123; design D13). Scenario "Disabling cancels the
   * invitations the user created" (verbatim): GIVEN an admin who created two pending invitations
   * to other people and one that its invitee has accepted, and another admin's pending
   * invitation, WHEN the first admin is disabled, THEN their two pending invitations become
   * `cancelled` with reason `inviter_disabled`, the accepted one stays `accepted` with no
   * cancellation logged, the other admin's stays `pending`, and re-enabling restores none.
   * Task 11.4b adds: an invitation created by the same user in another tenant stays pending.
   * Stored `cancelled` is Better Auth's `canceled`.
   *
   * Production behavior expected: the `identity.users.setStatus` handler, on `Disabled`, also
   * reads the tenant's pending invitations whose inviter is the disabled user, cancels each
   * (span `identity.invitation.cancel` with `tayzu.identity.invitation.id` and the reason
   * `inviter_disabled`) and logs `catalog.audit.invitation_cancelled` (`tayzu.tenant.id`,
   * `tayzu.actor.id` = the acting admin, `tayzu.identity.invitation.id`,
   * `tayzu.identity.invitation.reason` = `inviter_disabled`) for each one it cancelled only.
   * Enabling cancels or restores nothing.
   */
  it("Disabling cancels the invitations the user created: the user's two pending invitations become cancelled with the reason inviter_disabled (logged and traced), the accepted one stays accepted with no cancellation logged, another admin's and the same user's other-tenant invitations stay pending, and re-enabling restores none", async () => {
    const fixture = await freshFixture();
    const cancelledEvent = 'catalog.audit.invitation_cancelled';
    // The user being disabled is the inviter: `fixture.targetId` (a plain member here, which is
    // enough for the inviter column; the acting admin is `fixture.adminId`).
    const inviterId = fixture.targetId;
    const otherAdminId = fixture.adminId;
    const insertInvitation = async (
      organizationId: string,
      status: 'pending' | 'accepted',
      inviter: string,
    ): Promise<string> => {
      const id = `inv-${randomUUID()}`;
      await authPool.query(
        `insert into auth.invitation (id, organization_id, email, role, status, expires_at, created_at, inviter_id)
         values ($1, $2, $3, 'member', $4, now() + interval '48 hours', now(), $5)`,
        [id, organizationId, `invitee-${randomUUID()}@example.test`, status, inviter],
      );
      return id;
    };
    const statusOf = async (id: string): Promise<string | undefined> => {
      const result = await authPool.query<{ status: string }>(
        'select status from auth.invitation where id = $1',
        [id],
      );
      return result.rows[0]?.status;
    };

    // GIVEN the inviter created two pending invitations and one that its invitee accepted,
    // another admin has a pending invitation, and the inviter has a pending one in another tenant.
    const otherTenant = `org-${randomUUID()}`;
    await authPool.query(
      'insert into auth.organization (id, name, slug, created_at) values ($1, $2, $3, now())',
      [otherTenant, 'Other Org', `slug-${otherTenant}`],
    );
    const pendingA = await insertInvitation(fixture.tenantId, 'pending', inviterId);
    const pendingB = await insertInvitation(fixture.tenantId, 'pending', inviterId);
    const acceptedId = await insertInvitation(fixture.tenantId, 'accepted', inviterId);
    const otherAdminsId = await insertInvitation(fixture.tenantId, 'pending', otherAdminId);
    const otherTenantId = await insertInvitation(otherTenant, 'pending', inviterId);
    const all = [pendingA, pendingB, acceptedId, otherAdminsId, otherTenantId];

    // WHEN the inviter is disabled.
    await statusClient().identity.users.setStatus(
      { user: fixture.targetEmail, status: 'Disabled' },
      { context: context(fixture) },
    );

    // THEN their two pending invitations are `cancelled` (stored `canceled`).
    expect(await statusOf(pendingA)).toBe('canceled');
    expect(await statusOf(pendingB)).toBe('canceled');
    // AND the accepted one stays `accepted`, the other admin's and the other tenant's stay `pending`.
    expect(await statusOf(acceptedId)).toBe('accepted');
    expect(await statusOf(otherAdminsId)).toBe('pending');
    expect(await statusOf(otherTenantId)).toBe('pending');

    // AND exactly two cancellations are logged, for the two pending ones, with the reason
    // `inviter_disabled`, the tenant and the acting admin, and no email.
    const forThese = async () =>
      (await logRecords(cancelledEvent)).filter((record) =>
        all.some((id) => record.attributes['tayzu.identity.invitation.id'] === id),
      );
    const events = await forThese();
    expect(events, 'one cancellation event per pending invitation only').toHaveLength(2);
    expect(
      events.map((record) => record.attributes['tayzu.identity.invitation.id']).sort(),
    ).toEqual([pendingA, pendingB].sort());
    for (const record of events) {
      expect(record.attributes).toMatchObject({
        'tayzu.tenant.id': fixture.tenantId,
        'tayzu.actor.id': fixture.adminId,
        'tayzu.identity.invitation.reason': 'inviter_disabled',
      });
      expect(JSON.stringify(record.attributes)).not.toContain('@example.test');
    }

    // AND one `identity.invitation.cancel` span per cancelled invitation carries the reason.
    await harness.forceFlush();
    const spans = harness.spanExporter
      .getFinishedSpans()
      .filter(
        (span) =>
          span.name === 'identity.invitation.cancel' &&
          all.some((id) => span.attributes['tayzu.identity.invitation.id'] === id),
      );
    expect(spans).toHaveLength(2);
    expect(spans.map((span) => span.attributes['tayzu.identity.invitation.id']).sort()).toEqual(
      [pendingA, pendingB].sort(),
    );
    for (const span of spans) {
      expect(span.attributes['tayzu.identity.invitation.reason']).toBe('inviter_disabled');
    }

    // WHEN the inviter is re-enabled.
    await statusClient().identity.users.setStatus(
      { user: fixture.targetEmail, status: 'Active' },
      { context: context(fixture) },
    );

    // THEN no invitation is restored and nothing else changed or was logged.
    expect(await statusOf(pendingA)).toBe('canceled');
    expect(await statusOf(pendingB)).toBe('canceled');
    expect(await statusOf(acceptedId)).toBe('accepted');
    expect(await statusOf(otherAdminsId)).toBe('pending');
    expect(await statusOf(otherTenantId)).toBe('pending');
    expect(await forThese()).toHaveLength(2);
  }, 120_000);

  /**
   * Task 11.5 (Resolved decisions Q62 and Q117; design D6 "Operations", D13). Spec: "Disabling a
   * service account takes effect within seconds" names `identity.users.setStatus` on the service
   * account's `_user`; a service account has no Better Auth user, so `setStatus` writes only
   * `_user.status`. The branch is chosen by the RESOLVED `accountKind` of the target, never by the
   * shape of the identifier alone.
   *
   * Production behavior expected: `identity.users.setStatus` (`../identity-router.js`), when the
   * `{user}` identifier resolves, server-side and within the caller's tenant, to a `_user` with
   * `accountKind == "service"` and an `svc-` identifier, validates through `nextStatus`, writes
   * `_user.status` through `userSync.writeUserChange` (`change` `admin_disable` / `admin_enable`,
   * principal `{ kind: 'admin', id: <admin> }`, `onBehalfOf` the admin, the `svc-…` identifier as
   * the subject so that the adapter emits `tayzu.identity.service_account.id`) and does nothing
   * else: no Better Auth read or write, no session deletion or `session_revoked`, no ban, no
   * invitation cancellation. Any other target without a Better Auth user (a standard `_user` with an
   * `svc-`-shaped identifier, a service `_user` without the prefix, an unknown id) is answered
   * exactly like an unknown id and nothing is written or emitted.
   */
  it('setStatus for a service account writes only the _user: disable and enable change only the _user entity, each emits one user_status_changed with the admin and the svc identifier, and touch no Better Auth user, session, ban, invitation or credential', async () => {
    const fixture = await freshFixture();
    const identifier = `svc-status-${randomUUID().slice(0, 8)}`;
    interface ServiceAccountClient {
      identity: {
        serviceAccounts: {
          create(
            input: { identifier: string },
            options: { context: Record<string, unknown> },
          ): Promise<unknown>;
        };
      };
    }
    // GIVEN an `Active` service account of the tenant (created through its own operation).
    await (client as unknown as ServiceAccountClient).identity.serviceAccounts.create(
      { identifier },
      { context: context(fixture) },
    );
    expect(await userStatus(fixture.tenantId, identifier)).toBe('Active');

    const propertiesOf = async (): Promise<Record<string, unknown>> =>
      await withTenantTransaction(appPool, { tenantId: fixture.tenantId }, async (db) => {
        const result = await db.query<{ properties: Record<string, unknown> }>(
          `select e.spec_properties as properties
             from catalog_entity e
             join catalog_blueprint b on b.tenant_id = e.tenant_id and b.id = e.blueprint_id
            where e.tenant_id = $1 and b.identifier = '_user' and e.identifier = $2`,
          [fixture.tenantId, identifier],
        );
        return result.rows[0]?.properties ?? {};
      });
    const authState = async (): Promise<unknown> => {
      const users = await authPool.query<{ n: string }>(
        'select count(*)::text as n from auth."user"',
      );
      const members = await authPool.query<{ n: string }>(
        'select count(*)::text as n from auth.member where organization_id = $1',
        [fixture.tenantId],
      );
      const sessions = await authPool.query<{ n: string }>(
        'select count(*)::text as n from auth.session where user_id = any($1)',
        [[fixture.adminId, fixture.targetId]],
      );
      const banned = await authPool.query<{ id: string; banned: boolean | null }>(
        'select id, banned from auth."user" where id = any($1) order by id',
        [[fixture.adminId, fixture.targetId]],
      );
      const keys = await authPool.query<{ id: string; metadata: unknown }>(
        'select id, metadata from auth.apikey where reference_id = $1 order by id',
        [fixture.tenantId],
      );
      return {
        users: users.rows[0]?.n,
        members: members.rows[0]?.n,
        sessions: sessions.rows[0]?.n,
        banned: banned.rows,
        keys: keys.rows,
      };
    };
    const pendingInvitation = `inv-${randomUUID()}`;
    await authPool.query(
      `insert into auth.invitation (id, organization_id, email, role, status, expires_at, created_at, inviter_id)
       values ($1, $2, $3, 'member', 'pending', now() + interval '48 hours', now(), $4)`,
      [
        pendingInvitation,
        fixture.tenantId,
        `someone-${randomUUID()}@example.test`,
        fixture.adminId,
      ],
    );
    const before = await authState();
    const propertiesBefore = await propertiesOf();
    const eventsBefore = (await changeEvents(fixture.tenantId, identifier)).length;
    const revokedBefore = (await logRecords(REVOKED_EVENT)).filter(
      (record) => record.attributes['tayzu.tenant.id'] === fixture.tenantId,
    ).length;
    const cancelledBefore = (await logRecords('catalog.audit.invitation_cancelled')).filter(
      (record) => record.attributes['tayzu.tenant.id'] === fixture.tenantId,
    ).length;
    const eventsOf = async (change: 'admin_disable' | 'admin_enable') =>
      (await logRecords(STATUS_EVENT)).filter(
        (record) =>
          record.attributes['tayzu.tenant.id'] === fixture.tenantId &&
          record.attributes['tayzu.identity.service_account.id'] === identifier &&
          record.attributes['tayzu.identity.user.status.event'] === change,
      );

    // WHEN an admin disables the service account.
    await statusClient().identity.users.setStatus(
      { user: identifier, status: 'Disabled' },
      { context: context(fixture) },
    );

    // THEN only the `_user` entity changed: status `Disabled`, every other property intact,
    // one change event written as `system` on behalf of the admin.
    expect(await userStatus(fixture.tenantId, identifier)).toBe('Disabled');
    expect(await propertiesOf()).toEqual({ ...propertiesBefore, status: 'Disabled' });
    const afterDisable = await changeEvents(fixture.tenantId, identifier);
    expect(afterDisable).toHaveLength(eventsBefore + 1);
    expect(afterDisable.at(-1)).toMatchObject({
      actor_type: 'system',
      on_behalf_of_type: 'user',
      on_behalf_of_id: fixture.adminId,
    });
    // AND nothing of Better Auth changed: users, members, sessions, bans and the credential.
    expect(await authState()).toEqual(before);
    expect(await sessionCount(fixture.adminId)).toBe(1);
    // AND no session was revoked and no invitation was cancelled.
    expect(
      (await logRecords(REVOKED_EVENT)).filter(
        (record) => record.attributes['tayzu.tenant.id'] === fixture.tenantId,
      ),
    ).toHaveLength(revokedBefore);
    expect(
      (await logRecords('catalog.audit.invitation_cancelled')).filter(
        (record) => record.attributes['tayzu.tenant.id'] === fixture.tenantId,
      ),
    ).toHaveLength(cancelledBefore);
    // AND exactly one `user_status_changed` names the admin, the `svc-…` identifier and the event.
    const disabled = await eventsOf('admin_disable');
    expect(disabled).toHaveLength(1);
    expect(disabled[0]?.attributes).toMatchObject({
      'tayzu.tenant.id': fixture.tenantId,
      'tayzu.actor.id': fixture.adminId,
      'tayzu.identity.service_account.id': identifier,
      'tayzu.identity.user.status.from': 'Active',
      'tayzu.identity.user.status.to': 'Disabled',
      'tayzu.identity.user.status.event': 'admin_disable',
    });

    // WHEN the admin re-enables the service account.
    await statusClient().identity.users.setStatus(
      { user: identifier, status: 'Active' },
      { context: context(fixture) },
    );

    // THEN only the `_user` entity changed again, back to `Active`.
    expect(await userStatus(fixture.tenantId, identifier)).toBe('Active');
    expect(await propertiesOf()).toEqual(propertiesBefore);
    const afterEnable = await changeEvents(fixture.tenantId, identifier);
    expect(afterEnable).toHaveLength(eventsBefore + 2);
    expect(afterEnable.at(-1)).toMatchObject({
      actor_type: 'system',
      on_behalf_of_type: 'user',
      on_behalf_of_id: fixture.adminId,
    });
    expect(await authState()).toEqual(before);
    const enabled = await eventsOf('admin_enable');
    expect(enabled).toHaveLength(1);
    expect(enabled[0]?.attributes).toMatchObject({
      'tayzu.tenant.id': fixture.tenantId,
      'tayzu.actor.id': fixture.adminId,
      'tayzu.identity.service_account.id': identifier,
      'tayzu.identity.user.status.from': 'Disabled',
      'tayzu.identity.user.status.to': 'Active',
      'tayzu.identity.user.status.event': 'admin_enable',
    });
    expect(await eventsOf('admin_disable')).toHaveLength(1);
    // The pending invitation of the admin was never touched.
    const invitation = await authPool.query<{ status: string }>(
      'select status from auth.invitation where id = $1',
      [pendingInvitation],
    );
    expect(invitation.rows[0]?.status).toBe('pending');
  }, 120_000);

  it('setStatus chooses the service-account branch by the resolved accountKind, never by the identifier alone: a human never takes it, and a standard _user with an svc- identifier or a service _user without one is refused like an unknown id with nothing written', async () => {
    const fixture = await freshFixture();
    const suffix = randomUUID().slice(0, 8);
    const svcShapedStandard = `svc-human-${suffix}`;
    const serviceWithoutPrefix = `ci-bot-${suffix}`;
    for (const [identifier, accountKind] of [
      [svcShapedStandard, 'standard'],
      [serviceWithoutPrefix, 'service'],
    ] as const) {
      await createEntityService({ pool: appPool, authz: cerbos }).create(
        {
          tenantId: fixture.tenantId,
          actor: { type: 'system', id: 'user-status-op-test-seed' },
          principal: { roles: ['admin'] },
        },
        {
          blueprint: '_user',
          identifier,
          title: 'Seeded user',
          spec: { properties: { accountKind, status: 'Active', portRole: 'member' } },
        },
      );
    }
    const failureOf = async (identifier: string, status: 'Active' | 'Disabled') => {
      try {
        await statusClient().identity.users.setStatus(
          { user: identifier, status },
          { context: context(fixture) },
        );
      } catch (error) {
        const { code, status: httpStatus, message } = error as Record<string, unknown>;
        return { code, status: httpStatus, message };
      }
      return { code: 'NO_ERROR' };
    };
    const statusEventCount = async (): Promise<number> =>
      (await logRecords(STATUS_EVENT)).filter(
        (record) => record.attributes['tayzu.tenant.id'] === fixture.tenantId,
      ).length;

    // GIVEN the two look-alikes (seeded directly) and an unknown id for reference.
    const refused = [svcShapedStandard, serviceWithoutPrefix];
    const eventsBefore = new Map<string, unknown>();
    for (const identifier of refused) {
      eventsBefore.set(identifier, await changeEvents(fixture.tenantId, identifier));
    }
    const statusEventsBefore = await statusEventCount();
    const unknown = await failureOf(`svc-unknown-${suffix}`, 'Disabled');
    expect(unknown.code).toBe('CATALOG_NOT_FOUND');

    // WHEN an admin disables each look-alike, THEN the answer equals the unknown id's.
    for (const identifier of refused) {
      expect(await failureOf(identifier, 'Disabled')).toEqual(unknown);
      expect(await userStatus(fixture.tenantId, identifier)).toBe('Active');
      expect(await changeEvents(fixture.tenantId, identifier)).toEqual(
        eventsBefore.get(identifier),
      );
    }
    expect(await statusEventCount()).toBe(statusEventsBefore);

    // AND a human target never takes the service-account branch: the human branch revokes the
    // sessions and bans the single-membership user, and the audit event names the Better Auth user
    // and no service account.
    await statusClient().identity.users.setStatus(
      { user: fixture.targetEmail, status: 'Disabled' },
      { context: context(fixture) },
    );
    expect(await userStatus(fixture.tenantId, fixture.targetEmail)).toBe('Disabled');
    expect(await isBanned(fixture.targetId)).toBe(true);
    expect(await sessionCount(fixture.targetId)).toBe(0);
    const humanEvents = await statusEventsOf(fixture, 'admin_disable');
    expect(humanEvents).toHaveLength(1);
    expect(humanEvents[0]?.attributes).not.toHaveProperty('tayzu.identity.service_account.id');
    // AND the refused look-alikes stayed untouched by that call.
    for (const identifier of refused) {
      expect(await userStatus(fixture.tenantId, identifier)).toBe('Active');
    }
  }, 120_000);
});
