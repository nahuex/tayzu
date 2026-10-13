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
import { createUserSync } from '@tayzu/catalog';
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
});
