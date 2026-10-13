/**
 * Task 4.3 of openspec/changes/043-identity-lifecycle-and-org-admin (spec
 * "A user created by an admin is active"; design D2; Resolved decisions Q76
 * and Q117).
 *
 * Task 4.3: "`identity.users.create` performs no `_user` write of its own: the
 * hook of 4.2 writes it. The operation hands the acting admin to the hook
 * through an `AsyncLocalStorage` that it runs around its in-process `auth.api`
 * call, so the change event carries `onBehalfOf`, and the hook's write emits
 * `catalog.audit.user_status_changed` with the admin as `tayzu.actor.id`. The
 * `userSync` option of `createIdentityRouter` is removed."
 *
 * Scenario (verbatim from the spec):
 * - "A user created by an admin is active": WHEN an admin creates a user
 *   through `identity.users.create`, THEN the user's status is `Active`,
 *   written through the state machine.
 *
 * ## Harness
 *
 * `auth` is built with the real adapter of 4.1 (`createUserSyncAdapter` over
 * `createUserSync`) as its `userSync`, exactly as `createApp` does, so the
 * membership hook of 4.2 is the only writer. The router is built with
 * `{ auth, authz }` and no `userSync`. Each test uses a fresh organization (the
 * tenant) and a fresh admin caller id. The `_user` writes are counted from
 * `catalog_change_event`, the status event is read from the in-memory log
 * exporter.
 *
 * ## Production symbols expected
 *
 * - `createIdentityRouter` (`./identity-router.js`) no longer declares a
 *   `userSync` option and makes no `_user` write of its own.
 * - `apps/api/src/identity/identity-context.ts` (design D2) holds the
 *   `AsyncLocalStorage` store; the router runs its `auth.api` calls inside it
 *   with the acting admin, and `createUserSyncAdapter` reads it to set the
 *   write's `onBehalfOf` (`{ type: 'user', id }`) and `principal`
 *   (`tayzu.actor.id`). This test imports none of that: it asserts the effects.
 *
 * ## Why this fails right now
 *
 * The router still takes a `userSync` and upserts a second time when one is
 * given; the hook's write carries no `onBehalfOf` and the status event names
 * no `tayzu.actor.id` (assertion failures).
 */
// Load-bearing import order (design D1): the telemetry harness registers
// before anything that loads `@tayzu/auth` creates its logger.
import {
  linkLogEvents,
  registration,
  type TelemetryTestHarness,
} from './__fixtures__/link-telemetry.js';
import { randomInt, randomUUID } from 'node:crypto';

import { createRouterClient } from '@orpc/server';
import { authSchema, createAuth, type AuthInstance, type UserSyncPort } from '@tayzu/auth';
import { createCerbosClient, type CerbosClient } from '@tayzu/authz';
import { createUserSync } from '@tayzu/catalog';
import { runMigrations } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { harnessPools } from './__fixtures__/pools.js';
import { createIdentityRouter } from './identity-router.js';
import { createAuthRepository } from './identity/auth-repository.js';
import { createWithUserLock } from './identity/user-lock.js';
import { createUserSyncAdapter } from './identity/user-sync-adapter.js';
import {
  bootstrapTestTenant,
  createAdminUser,
  testAppPool,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { startOidcStub, type OidcStub } from '../../../packages/auth/src/__fixtures__/oidc-stub.js';
import { enrolledAdminSession } from './__fixtures__/fresh-mfa.js';
import { createApp, type App } from './server.js';
import { TEST_SECRET, TEST_PASSWORD } from '../../../packages/auth/src/__fixtures__/test-secret.js';

interface CreateOrganizationSurface {
  createOrganization(args: {
    body: { name: string; slug: string; userId: string };
  }): Promise<{ id: string }>;
}

interface AddMemberSurface {
  addMember(args: {
    body: { userId: string; organizationId: string; role: string };
  }): Promise<unknown>;
}

const EVENT_NAME = 'catalog.audit.user_status_changed';

describe('identity.users.create writes the _user through the membership hook only (task 4.3)', () => {
  let harness: TelemetryTestHarness;
  let appPool: Pool;
  let authPool: Pool;
  let auth: AuthInstance;
  let cerbos: CerbosClient;
  let userSync: ReturnType<typeof createUserSync>;
  let client: ReturnType<
    typeof createRouterClient<ReturnType<typeof createIdentityRouter>, Record<string, unknown>>
  >;

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
    await runMigrations(authPool);
    cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    userSync = createUserSync({ pool: appPool, authz: cerbos });
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync: createUserSyncAdapter({ userSync }),
    });
    client = createRouterClient(
      createIdentityRouter({
        auth,
        authz: cerbos,
        authRepository: createAuthRepository(authPool),
        withUserLock: createWithUserLock(authPool),
      }),
      {
        context: (raw: Record<string, unknown>) => raw,
      },
    );
  }, 60_000);

  async function freshTenantId(): Promise<string> {
    const id = randomUUID();
    const owner = await createAdminUser(auth, {
      name: 'Tenant Owner',
      email: `owner-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    const org = await (auth.api as CreateOrganizationSurface).createOrganization({
      body: { name: 'Identity Router Org', slug: `identity-router-${id}`, userId: owner.userId },
    });
    return org.id;
  }

  function context(tenantId: string, adminId: string): Record<string, unknown> {
    return {
      tenantId,
      actor: { type: 'user', id: adminId },
      principal: { roles: ['admin'] },
    };
  }

  it('A user created by an admin is active: exactly one _user write, status Active, onBehalfOf the admin, one status event created_active naming the admin', async () => {
    const tenantId = await freshTenantId();
    const adminId = `admin-${randomUUID()}`;
    const email = `created-${randomUUID()}@example.test`;

    // WHEN an admin creates a user through `identity.users.create`.
    const created = await client.identity.users.create(
      { email, name: 'Created By Admin', role: 'member' },
      { context: context(tenantId, adminId) },
    );

    // THEN the user's status is `Active`...
    const row = await userSync.getUser({ tenantId, email });
    expect(row, 'a _user entity exists for the created user').not.toBeNull();
    expect(row?.status).toBe('Active');

    // ...written once, with the admin as `onBehalfOf` of the change event.
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
    expect(events.rows, 'exactly one _user write').toHaveLength(1);
    expect(events.rows[0]?.actor_type).toBe('system');
    expect(events.rows[0]?.on_behalf_of_type).toBe('user');
    expect(events.rows[0]?.on_behalf_of_id).toBe(adminId);

    // ...and one status event, `created_active`, with the admin as the actor.
    await harness.forceFlush();
    const statusEvents = [...harness.logExporter.getFinishedLogRecords()].filter(
      (record) =>
        record.eventName === EVENT_NAME &&
        record.attributes['tayzu.tenant.id'] === tenantId &&
        record.attributes['tayzu.identity.user.id'] === created.userId,
    );
    expect(statusEvents).toHaveLength(1);
    const attributes = statusEvents[0]?.attributes;
    expect(attributes?.['tayzu.identity.user.status.event']).toBe('created_active');
    expect(attributes?.['tayzu.identity.user.status.to']).toBe('Active');
    expect(attributes?.['tayzu.actor.id']).toBe(adminId);
    expect(JSON.stringify(attributes)).not.toContain(email);
  }, 60_000);

  it('createIdentityRouter no longer accepts a userSync: a stub handed to it is never called', async () => {
    const tenantId = await freshTenantId();
    const email = `no-user-sync-${randomUUID()}@example.test`;
    const calls: unknown[] = [];
    const stub: UserSyncPort = {
      upsertUser: (input) => {
        calls.push(input);
        return Promise.resolve();
      },
    };

    const router = createIdentityRouter({
      auth,
      authz: cerbos,
      // @ts-expect-error -- task 4.3 (Q76): the `userSync` option is removed.
      userSync: stub,
      authRepository: createAuthRepository(authPool),
      withUserLock: createWithUserLock(authPool),
    });
    const stubbed = createRouterClient(router, {
      context: (raw: Record<string, unknown>) => raw,
    });
    await stubbed.identity.users.create(
      { email, name: 'No Second Write', role: 'member' },
      { context: context(tenantId, `admin-${randomUUID()}`) },
    );

    expect(calls, 'the router writes nothing through a userSync').toEqual([]);
  }, 60_000);
});

/**
 * Task 5.3 of openspec/changes/043-identity-lifecycle-and-org-admin (spec
 * "Only an admin may invite a user or change another user's status": the
 * identity pipeline MUST emit `catalog.security.authz_denied` on every Cerbos
 * deny and increment the authorization-decision metric; scenario "Non-admin
 * cannot invite": denied with `AUTH_FORBIDDEN`, `catalog.security.authz_denied`
 * is logged).
 *
 * Task 5.3: "a denied call logs the event and records one `deny` decision and
 * an allowed call one `allow`, with no email or identifier of the target."
 *
 * ## Production symbols expected
 *
 * - `createIdentityRouter` (`./identity-router.js`) emits
 *   `catalog.security.authz_denied` (attributes `tayzu.tenant.id`,
 *   `tayzu.actor.type`, `tayzu.actor.id`, `tayzu.authz.resource.kind`,
 *   `tayzu.authz.action`) on a deny and adds one `tayzu.authz.decisions`
 *   point (`tayzu.authz.decision` = `allow` | `deny`) per call, through a
 *   helper exported by `@tayzu/catalog` (not asserted here: only the effects).
 *
 * ## Why this fails right now
 *
 * The router throws `AUTH_FORBIDDEN` silently: no log record, no decision.
 */
describe('identity router authorization telemetry (task 5.3)', () => {
  let harness: TelemetryTestHarness;
  let authPool: Pool;
  let auth: AuthInstance;
  let client: ReturnType<
    typeof createRouterClient<ReturnType<typeof createIdentityRouter>, Record<string, unknown>>
  >;

  beforeAll(async () => {
    if ('error' in registration) {
      throw new Error(`createTelemetryTestHarness() failed: ${String(registration.error)}`, {
        cause: registration.error,
      });
    }
    harness = registration.harness;
    const pools = await harnessPools();
    authPool = pools.authPool;
    await runMigrations(authPool);
    const cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    const userSync = createUserSync({ pool: pools.appPool, authz: cerbos });
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync: createUserSyncAdapter({ userSync }),
    });
    client = createRouterClient(
      createIdentityRouter({
        auth,
        authz: cerbos,
        authRepository: createAuthRepository(authPool),
        withUserLock: createWithUserLock(authPool),
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );
  }, 60_000);

  async function freshTenantId(): Promise<string> {
    const id = randomUUID();
    const owner = await createAdminUser(auth, {
      name: 'Tenant Owner',
      email: `owner-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    const org = await (auth.api as CreateOrganizationSurface).createOrganization({
      body: {
        name: 'Identity Telemetry Org',
        slug: `identity-telemetry-${id}`,
        userId: owner.userId,
      },
    });
    return org.id;
  }

  function callerContext(
    tenantId: string,
    actorId: string,
    roles: readonly string[],
  ): Record<string, unknown> {
    return { tenantId, actor: { type: 'user', id: actorId }, principal: { roles } };
  }

  /** `user`/`create` decisions of one tenant (the catalog's own `_user` writes are other kinds). */
  async function decisionTotal(tenantId: string, decision: 'allow' | 'deny'): Promise<number> {
    await harness.forceFlush();
    let total = 0;
    for (const resourceMetrics of harness.metricExporter.getMetrics()) {
      for (const scopeMetrics of resourceMetrics.scopeMetrics) {
        for (const metric of scopeMetrics.metrics) {
          if (metric.descriptor.name !== 'tayzu.authz.decisions') continue;
          for (const point of metric.dataPoints) {
            if (
              point.attributes['tayzu.tenant.id'] === tenantId &&
              point.attributes['tayzu.authz.resource.kind'] === 'user' &&
              point.attributes['tayzu.authz.action'] === 'create' &&
              point.attributes['tayzu.authz.decision'] === decision
            ) {
              total += point.value as number;
            }
          }
        }
      }
    }
    return total;
  }

  async function deniedLogs(tenantId: string) {
    await harness.forceFlush();
    return [...harness.logExporter.getFinishedLogRecords()].filter(
      (record) =>
        record.eventName === 'catalog.security.authz_denied' &&
        record.attributes['tayzu.tenant.id'] === tenantId,
    );
  }

  function allPointAttributes(tenantId: string): string {
    const seen: unknown[] = [];
    for (const resourceMetrics of harness.metricExporter.getMetrics()) {
      for (const scopeMetrics of resourceMetrics.scopeMetrics) {
        for (const metric of scopeMetrics.metrics) {
          if (metric.descriptor.name !== 'tayzu.authz.decisions') continue;
          for (const point of metric.dataPoints) {
            if (point.attributes['tayzu.tenant.id'] === tenantId) seen.push(point.attributes);
          }
        }
      }
    }
    return JSON.stringify(seen);
  }

  it('Non-admin cannot invite: a denied call is AUTH_FORBIDDEN, logs catalog.security.authz_denied once and records one deny decision, with no email or name', async () => {
    const tenantId = await freshTenantId();
    const actorId = `member-${randomUUID()}`;
    const email = `denied-${randomUUID()}@example.test`;
    const name = `Secret Name ${randomUUID()}`;

    await expect(
      client.identity.users.create(
        { email, name, role: 'member' },
        { context: callerContext(tenantId, actorId, ['member']) },
      ),
    ).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });

    const logs = await deniedLogs(tenantId);
    expect(logs, 'exactly one authz_denied log for the deny').toHaveLength(1);
    const attributes = logs[0]?.attributes ?? {};
    expect(attributes).toMatchObject({
      'tayzu.tenant.id': tenantId,
      'tayzu.actor.type': 'user',
      'tayzu.actor.id': actorId,
      'tayzu.authz.resource.kind': 'user',
      'tayzu.authz.action': 'create',
    });
    expect(logs[0]?.severityText ?? 'WARN').toBe('WARN');
    expect(JSON.stringify(logs[0])).not.toContain(email);
    expect(JSON.stringify(logs[0])).not.toContain(name);

    expect(await decisionTotal(tenantId, 'deny')).toBe(1);
    expect(await decisionTotal(tenantId, 'allow')).toBe(0);
    expect(allPointAttributes(tenantId)).not.toContain(email);
    expect(allPointAttributes(tenantId)).not.toContain(name);
  }, 60_000);

  it('An allowed call records one allow decision and no authz_denied log, with no email or name', async () => {
    const tenantId = await freshTenantId();
    const adminId = `admin-${randomUUID()}`;
    const email = `allowed-${randomUUID()}@example.test`;
    const name = `Allowed Name ${randomUUID()}`;

    const created = await client.identity.users.create(
      { email, name, role: 'member' },
      { context: callerContext(tenantId, adminId, ['admin']) },
    );

    expect(await decisionTotal(tenantId, 'allow')).toBe(1);
    expect(await decisionTotal(tenantId, 'deny')).toBe(0);
    expect(await deniedLogs(tenantId)).toHaveLength(0);
    expect(allPointAttributes(tenantId)).not.toContain(email);
    expect(allPointAttributes(tenantId)).not.toContain(name);
    expect(allPointAttributes(tenantId)).not.toContain(created.userId);
  }, 60_000);

  // Task 5.3c (Resolved decision Q31): the three existing procedures take the
  // `{user}` identifier (the member's email), resolved on the server to the
  // Better Auth user, and no longer take a Better Auth `userId`.
  async function ssoAccountCount(userId: string): Promise<number> {
    const result = await authPool.query<{ count: string }>(
      `select count(*)::text as count from auth.account
       where user_id = $1 and provider_id = 'visma-connect'`,
      [userId],
    );
    return Number(result.rows[0]?.count);
  }

  async function memberOfTenant(tenantId: string): Promise<{ userId: string; email: string }> {
    const email = `member-${randomUUID()}@example.test`;
    const user = await createAdminUser(auth, {
      name: 'Identifier Target',
      email,
      password: TEST_PASSWORD,
    });
    await (auth.api as AddMemberSurface).addMember({
      body: { userId: user.userId, organizationId: tenantId, role: 'member' },
    });
    return user;
  }

  it('An unknown {user} identifier is rejected with CATALOG_NOT_FOUND by link and unlink', async () => {
    const tenantId = await freshTenantId();
    const admin = callerContext(tenantId, `admin-${randomUUID()}`, ['admin']);
    const subject = `visma-sub-${randomUUID()}`;
    const unknown = `nobody-${randomUUID()}@example.test`;

    await expect(
      client.identity.users.linkSsoAccount({ user: unknown, subject }, { context: admin }),
    ).rejects.toMatchObject({ code: 'CATALOG_NOT_FOUND' });
    await expect(
      client.identity.users.unlinkSsoAccount({ user: unknown }, { context: admin }),
    ).rejects.toMatchObject({ code: 'CATALOG_NOT_FOUND' });

    const written = await authPool.query(
      `select 1 from auth.account where provider_id = 'visma-connect' and account_id = $1`,
      [subject],
    );
    expect(written.rows, 'nothing was linked').toHaveLength(0);
  }, 60_000);

  it('A Better Auth userId body is rejected by link and unlink, and nothing is written or deleted', async () => {
    const tenantId = await freshTenantId();
    const admin = callerContext(tenantId, `admin-${randomUUID()}`, ['admin']);
    const target = await memberOfTenant(tenantId);
    const subject = `visma-sub-${randomUUID()}`;

    // Control: the same target, addressed by its identifier, is linked.
    await client.identity.users.linkSsoAccount(
      { user: target.email, subject: `visma-sub-${randomUUID()}` },
      { context: admin },
    );
    expect(await ssoAccountCount(target.userId), 'control: linked by identifier').toBe(1);

    await expect(
      client.identity.users.linkSsoAccount({ userId: target.userId, subject }, { context: admin }),
    ).rejects.toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });
    await expect(
      client.identity.users.unlinkSsoAccount({ userId: target.userId }, { context: admin }),
    ).rejects.toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });

    const written = await authPool.query(
      `select 1 from auth.account where provider_id = 'visma-connect' and account_id = $1`,
      [subject],
    );
    expect(written.rows, 'the userId link wrote nothing').toHaveLength(0);
    expect(await ssoAccountCount(target.userId), 'the userId unlink deleted nothing').toBe(1);
  }, 60_000);
});

/**
 * Task 13.2 of openspec/changes/043-identity-lifecycle-and-org-admin (`002` VCDM
 * M10): identity operations that act on the global account refuse a target with
 * a membership outside the caller's tenant. `linkSsoAccount` and
 * `unlinkSsoAccount` on a two-tenant user are refused with the generic
 * `CATALOG_VALIDATION_FAILED` and change nothing; the same operations on a
 * single-tenant user (control) succeed.
 *
 * ## Production symbols expected
 *
 * None new: `createIdentityRouter` reads `globalMembershipTenantsOf` (5.1b).
 * The behavior may already exist, in which case these pass on arrival.
 */
describe('identity operations refuse a target with a membership in another tenant (task 13.2)', () => {
  let authPool: Pool;
  let auth: AuthInstance;
  let client: ReturnType<
    typeof createRouterClient<ReturnType<typeof createIdentityRouter>, Record<string, unknown>>
  >;

  beforeAll(async () => {
    const pools = await harnessPools();
    authPool = pools.authPool;
    await runMigrations(authPool);
    const cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    const userSync = createUserSync({ pool: pools.appPool, authz: cerbos });
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync: createUserSyncAdapter({ userSync }),
    });
    client = createRouterClient(
      createIdentityRouter({
        auth,
        authz: cerbos,
        authRepository: createAuthRepository(authPool),
        withUserLock: createWithUserLock(authPool),
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );
  }, 60_000);

  async function freshTenantId(): Promise<string> {
    const id = randomUUID();
    const owner = await createAdminUser(auth, {
      name: 'Tenant Owner',
      email: `owner-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    const org = await (auth.api as CreateOrganizationSurface).createOrganization({
      body: { name: 'Two Tenant Org', slug: `two-tenant-${id}`, userId: owner.userId },
    });
    return org.id;
  }

  function adminContext(tenantId: string): Record<string, unknown> {
    return {
      tenantId,
      actor: { type: 'user', id: `admin-${randomUUID()}` },
      principal: { roles: ['admin'] },
    };
  }

  async function memberOf(tenantId: string): Promise<{ userId: string; email: string }> {
    const email = `member-${randomUUID()}@example.test`;
    const user = await createAdminUser(auth, {
      name: 'Two Tenant Target',
      email,
      password: TEST_PASSWORD,
    });
    await (auth.api as AddMemberSurface).addMember({
      body: { userId: user.userId, organizationId: tenantId, role: 'member' },
    });
    return user;
  }

  /** A second membership, seeded directly so no membership hook can shed anything. */
  async function seedMembership(tenantId: string, userId: string): Promise<void> {
    await authPool.query(
      `insert into auth.member (id, organization_id, user_id, role, created_at)
       values ($1, $2, $3, 'member', now())`,
      [randomUUID(), tenantId, userId],
    );
  }

  async function seedLink(userId: string, sub: string): Promise<void> {
    await authPool.query(
      `insert into auth.account (id, account_id, provider_id, user_id, created_at, updated_at)
       values ($1, $2, 'visma-connect', $3, now(), now())`,
      [randomUUID(), sub, userId],
    );
  }

  async function linkedSubjects(userId: string): Promise<string[]> {
    const result = await authPool.query<{ account_id: string }>(
      `select account_id from auth.account where user_id = $1 and provider_id = 'visma-connect'`,
      [userId],
    );
    return result.rows.map((row) => row.account_id);
  }

  it('linkSsoAccount on a two-tenant user is refused with CATALOG_VALIDATION_FAILED and writes no account row', async () => {
    const tenantA = await freshTenantId();
    const tenantB = await freshTenantId();
    const target = await memberOf(tenantA);
    await seedMembership(tenantB, target.userId);
    const subject = `visma-sub-${randomUUID()}`;

    await expect(
      client.identity.users.linkSsoAccount(
        { user: target.email, subject },
        { context: adminContext(tenantA) },
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });
    // The admin of the other tenant is refused as well.
    await expect(
      client.identity.users.linkSsoAccount(
        { user: target.email, subject },
        { context: adminContext(tenantB) },
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });

    expect(await linkedSubjects(target.userId), 'no account row was written').toEqual([]);
  }, 60_000);

  it('unlinkSsoAccount on a two-tenant user is refused with CATALOG_VALIDATION_FAILED and deletes nothing', async () => {
    const tenantA = await freshTenantId();
    const tenantB = await freshTenantId();
    const target = await memberOf(tenantA);
    await seedMembership(tenantB, target.userId);
    const subject = `visma-sub-${randomUUID()}`;
    await seedLink(target.userId, subject);

    await expect(
      client.identity.users.unlinkSsoAccount(
        { user: target.email },
        { context: adminContext(tenantA) },
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });

    expect(await linkedSubjects(target.userId), 'the link is still there').toEqual([subject]);
  }, 60_000);

  it('control: the same operations on a single-tenant user succeed', async () => {
    const tenantA = await freshTenantId();
    const target = await memberOf(tenantA);
    const subject = `visma-sub-${randomUUID()}`;

    await client.identity.users.linkSsoAccount(
      { user: target.email, subject },
      { context: adminContext(tenantA) },
    );
    expect(await linkedSubjects(target.userId)).toEqual([subject]);

    await client.identity.users.unlinkSsoAccount(
      { user: target.email },
      { context: adminContext(tenantA) },
    );
    expect(await linkedSubjects(target.userId)).toEqual([]);
  }, 60_000);
});

/**
 * Task 13.2b of openspec/changes/043-identity-lifecycle-and-org-admin (Resolved
 * decision Q88, Q115; spec scenario "An admin cannot record an SSO link on an
 * admin or an owner").
 *
 * Scenario (verbatim from the spec):
 * - GIVEN another admin and an owner of `t1`, WHEN an admin of `t1` links an SSO
 *   `sub` to either of them, THEN the operation is refused with the same generic
 *   rejection as every other link conflict, no account is written and no session
 *   is revoked, and they can still link their own identity through the
 *   self-service route with a fresh step-up verification.
 * - AND `catalog.security.identity_conflict_refused` is logged with the reason
 *   `target_is_admin_or_owner` and opaque identifiers only.
 *
 * ## Production symbols expected
 *
 * None new beyond the telemetry contract (design, log events table):
 * `catalog.security.identity_conflict_refused` (WARN) with `tayzu.tenant.id`,
 * `tayzu.actor.id` (the acting admin), `tayzu.identity.conflict.reason` and
 * `tayzu.identity.user.id` (the target's Better Auth user id). `linkSsoAccount`
 * reads the target's membership role in the host tenant through the repository
 * of 5.1b and refuses `admin` and `owner`.
 */
describe('linkSsoAccount refuses an admin or owner target (task 13.2b, Q88)', () => {
  const EVENT = 'catalog.security.identity_conflict_refused';
  let harness: TelemetryTestHarness;
  let authPool: Pool;
  let auth: AuthInstance;
  let client: ReturnType<
    typeof createRouterClient<ReturnType<typeof createIdentityRouter>, Record<string, unknown>>
  >;

  interface SessionApiSurface {
    signInEmail(args: {
      body: { email: string; password: string };
      headers: Headers;
    }): Promise<unknown>;
  }

  beforeAll(async () => {
    if ('error' in registration) {
      throw new Error(`createTelemetryTestHarness() failed: ${String(registration.error)}`, {
        cause: registration.error,
      });
    }
    harness = registration.harness;
    const pools = await harnessPools();
    authPool = pools.authPool;
    await runMigrations(authPool);
    const cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    const userSync = createUserSync({ pool: pools.appPool, authz: cerbos });
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync: createUserSyncAdapter({ userSync }),
    });
    client = createRouterClient(
      createIdentityRouter({
        auth,
        authz: cerbos,
        authRepository: createAuthRepository(authPool),
        withUserLock: createWithUserLock(authPool),
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );
  }, 60_000);

  function randomIp(): string {
    const octet = (): string => randomInt(1, 255).toString(10);
    return `10.${octet()}.${octet()}.${octet()}`;
  }

  async function freshTenant(): Promise<{ tenantId: string; ownerId: string; ownerEmail: string }> {
    const id = randomUUID();
    const ownerEmail = `owner-${id}@example.test`;
    const owner = await createAdminUser(auth, {
      name: 'Tenant Owner',
      email: ownerEmail,
      password: TEST_PASSWORD,
    });
    const org = await (auth.api as CreateOrganizationSurface).createOrganization({
      body: { name: 'Admin Link Org', slug: `admin-link-${id}`, userId: owner.userId },
    });
    return { tenantId: org.id, ownerId: owner.userId, ownerEmail };
  }

  async function userWithRole(
    tenantId: string,
    role: 'member' | 'admin' | 'owner',
  ): Promise<{ userId: string; email: string }> {
    const user = await createAdminUser(auth, {
      name: `Target ${role}`,
      email: `${role}-${randomUUID()}@example.test`,
      password: TEST_PASSWORD,
    });
    await (auth.api as AddMemberSurface).addMember({
      body: { userId: user.userId, organizationId: tenantId, role },
    });
    return user;
  }

  function adminContext(tenantId: string, adminId: string): Record<string, unknown> {
    return {
      tenantId,
      actor: { type: 'user', id: adminId },
      principal: { roles: ['admin'] },
    };
  }

  async function accountCount(userId: string): Promise<number> {
    const result = await authPool.query<{ count: string }>(
      `select count(*)::text as count from auth.account where user_id = $1 and provider_id = 'visma-connect'`,
      [userId],
    );
    return Number(result.rows[0]?.count);
  }

  async function sessionCount(userId: string): Promise<number> {
    const result = await authPool.query<{ count: string }>(
      `select count(*)::text as count from auth.session where user_id = $1`,
      [userId],
    );
    return Number(result.rows[0]?.count);
  }

  async function refusals(tenantId: string) {
    const records = await linkLogEvents(harness, EVENT);
    return records.filter((record) => record.attributes['tayzu.tenant.id'] === tenantId);
  }

  async function expectRefused(role: 'admin' | 'owner'): Promise<void> {
    const { tenantId } = await freshTenant();
    const actingAdminId = `admin-${randomUUID()}`;
    const target = await userWithRole(tenantId, role);
    const subject = `visma-sub-${randomUUID()}`;
    await (auth.api as SessionApiSurface).signInEmail({
      body: { email: target.email, password: TEST_PASSWORD },
      headers: new Headers({ 'x-forwarded-for': randomIp() }),
    });
    const sessionsBefore = await sessionCount(target.userId);
    expect(sessionsBefore, 'precondition: the target has a live session').toBeGreaterThan(0);

    await expect(
      client.identity.users.linkSsoAccount(
        { user: target.email, subject },
        { context: adminContext(tenantId, actingAdminId) },
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });

    expect(await accountCount(target.userId), 'no account row was written').toBe(0);
    const bySub = await authPool.query(
      `select 1 from auth.account where provider_id = 'visma-connect' and account_id = $1`,
      [subject],
    );
    expect(bySub.rows, 'the sub is linked to nobody').toHaveLength(0);
    expect(await sessionCount(target.userId), 'no session was revoked').toBe(sessionsBefore);

    const events = await refusals(tenantId);
    expect(events).toHaveLength(1);
    const attributes = events[0]?.attributes;
    expect(attributes?.['tayzu.identity.conflict.reason']).toBe('target_is_admin_or_owner');
    expect(attributes?.['tayzu.actor.id']).toBe(actingAdminId);
    expect(attributes?.['tayzu.identity.user.id']).toBe(target.userId);
    const serialized = JSON.stringify(events[0]);
    expect(serialized, 'no email in the event').not.toContain(target.email);
    expect(serialized, 'no sub in the event').not.toContain(subject);
  }

  it('A link on an admin of the tenant is refused with CATALOG_VALIDATION_FAILED, writes nothing, revokes nothing and logs target_is_admin_or_owner', async () => {
    await expectRefused('admin');
  }, 60_000);

  it('A link on an owner of the tenant is refused with CATALOG_VALIDATION_FAILED, writes nothing, revokes nothing and logs target_is_admin_or_owner', async () => {
    await expectRefused('owner');
  }, 60_000);

  it('A link on the creating owner of the tenant is refused as well', async () => {
    const { tenantId, ownerId, ownerEmail } = await freshTenant();
    const subject = `visma-sub-${randomUUID()}`;

    await expect(
      client.identity.users.linkSsoAccount(
        { user: ownerEmail, subject },
        { context: adminContext(tenantId, `admin-${randomUUID()}`) },
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });

    expect(await accountCount(ownerId)).toBe(0);
  }, 60_000);

  it('control: a link on a plain member still succeeds and logs no refusal', async () => {
    const { tenantId } = await freshTenant();
    const target = await userWithRole(tenantId, 'member');
    const subject = `visma-sub-${randomUUID()}`;

    await client.identity.users.linkSsoAccount(
      { user: target.email, subject },
      { context: adminContext(tenantId, `admin-${randomUUID()}`) },
    );

    expect(await accountCount(target.userId)).toBe(1);
    expect(await refusals(tenantId)).toHaveLength(0);
  }, 60_000);
});

/**
 * Task 13.2b, last clause: "an admin linking their own identity through
 * `/link-social` with step-up" still succeeds. Driven through the real
 * `createApp` and the local OIDC stub, like `link-social-step-up.int.test.ts`.
 * Runs for an `owner` and for an `admin` member.
 */
describe('an admin links their own identity through /link-social with step-up (task 13.2b)', () => {
  const ORIGIN = 'http://localhost:3000';
  const AUTH_BASE_URL = `${ORIGIN}/api/auth`;
  const PROVIDER_ID = 'visma-connect';
  let app: App;
  let stub: OidcStub;
  let authPool: Pool;

  beforeAll(async () => {
    const pools = await harnessPools();
    authPool = pools.authPool;
    stub = await startOidcStub();
    app = await createApp({
      ...pools,
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ORIGIN],
      sso: {
        discoveryUrl: stub.discoveryUrl,
        clientId: stub.clientId,
        clientSecret: stub.clientSecret,
      },
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await stub.close();
  }, 60_000);

  function randomIp(): string {
    const octet = (): string => randomInt(1, 255).toString(10);
    return `10.${octet()}.${octet()}.${octet()}`;
  }

  function cookieFrom(setCookie: string | string[] | number | undefined): string {
    const cookies = Array.isArray(setCookie)
      ? setCookie
      : typeof setCookie === 'string'
        ? [setCookie]
        : [];
    return cookies.map((raw) => raw.split(';')[0]).join('; ');
  }

  async function selfLink(cookie: string, email: string, sub: string): Promise<void> {
    const handler = (app.auth as unknown as { handler: (request: Request) => Promise<Response> })
      .handler;
    stub.setSubject({
      sub,
      email,
      name: 'Admin Self Link',
      sid: `sid-${randomUUID()}`,
      claims: { email_verified: true },
    });
    const initiated = await app.app.inject({
      method: 'POST',
      url: '/api/auth/link-social',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': randomIp(),
        origin: ORIGIN,
        host: 'localhost:3000',
        cookie,
      },
      payload: JSON.stringify({ provider: PROVIDER_ID, callbackURL: '/' }),
    });
    expect(initiated.statusCode, initiated.body).toBe(200);
    const approval = await fetch(initiated.json<{ url: string }>().url, { redirect: 'manual' });
    const page = await approval.text();
    const inputs = Object.fromEntries(
      [...page.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [
        m[1] ?? '',
        m[2] ?? '',
      ]),
    );
    const code = inputs['code'];
    const state = inputs['state'];
    if (code === undefined || state === undefined) {
      throw new Error('the OIDC stub did not return code and state');
    }
    const params = new URLSearchParams({
      code,
      state,
      ...(inputs['iss'] === undefined ? {} : { iss: inputs['iss'] }),
    });
    const callbackCookie = [cookie, cookieFrom(initiated.headers['set-cookie'])]
      .filter((part) => part !== '')
      .join('; ');
    const headers = (): Record<string, string> => ({
      'x-forwarded-for': randomIp(),
      cookie: callbackCookie,
    });
    const posted = await handler(
      new Request(`${AUTH_BASE_URL}/callback/${PROVIDER_ID}`, {
        method: 'POST',
        headers: {
          ...headers(),
          'content-type': 'application/x-www-form-urlencoded',
          origin: ORIGIN,
        },
        body: params.toString(),
      }),
    );
    const location = posted.headers.get('location');
    if (
      posted.status >= 300 &&
      posted.status < 400 &&
      location !== null &&
      new URL(location, AUTH_BASE_URL).pathname.endsWith(`/callback/${PROVIDER_ID}`)
    ) {
      await handler(
        new Request(new URL(location, AUTH_BASE_URL), { method: 'GET', headers: headers() }),
      );
    }
  }

  async function linkedSubjects(userId: string): Promise<string[]> {
    const result = await authPool.query<{ account_id: string }>(
      `select account_id from auth.account where user_id = $1 and provider_id = $2`,
      [userId, PROVIDER_ID],
    );
    return result.rows.map((row) => row.account_id);
  }

  it('an owner links their own identity with a fresh MFA verification', async () => {
    const email = `self-owner-${randomUUID()}@example.test`;
    const tenant = await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: 'Self Link Owner',
      email,
      password: TEST_PASSWORD,
      organizationName: 'Self Link Org',
      organizationSlug: `self-link-${randomUUID()}`,
      ip: randomIp(),
    });
    const session = await enrolledAdminSession(app, tenant, {
      password: TEST_PASSWORD,
      origin: ORIGIN,
    });
    const sub = `self-sub-${randomUUID()}`;

    await selfLink(session.cookie, email, sub);

    expect(await linkedSubjects(tenant.userId)).toEqual([sub]);
  }, 60_000);

  it('an admin member links their own identity with a fresh MFA verification', async () => {
    const ownerEmail = `self-admin-owner-${randomUUID()}@example.test`;
    const tenant = await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: 'Self Link Owner',
      email: ownerEmail,
      password: TEST_PASSWORD,
      organizationName: 'Self Link Admin Org',
      organizationSlug: `self-link-admin-${randomUUID()}`,
      ip: randomIp(),
    });
    const email = `self-admin-${randomUUID()}@example.test`;
    const admin = await createAdminUser(app.auth, {
      name: 'Self Link Admin',
      email,
      password: TEST_PASSWORD,
    });
    await (app.auth.api as AddMemberSurface).addMember({
      body: { userId: admin.userId, organizationId: tenant.organizationId, role: 'admin' },
    });
    const signedIn = await app.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': randomIp(),
        origin: ORIGIN,
        host: 'localhost:3000',
      },
      payload: JSON.stringify({ email, password: TEST_PASSWORD }),
    });
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    const session = await enrolledAdminSession(
      app,
      { email, cookie: cookieFrom(signedIn.headers['set-cookie']) },
      { password: TEST_PASSWORD, origin: ORIGIN },
    );
    const sub = `self-admin-sub-${randomUUID()}`;

    await selfLink(session.cookie, email, sub);

    expect(await linkedSubjects(admin.userId)).toEqual([sub]);
  }, 60_000);
});
