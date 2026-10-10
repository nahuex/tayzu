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
import { registration, type TelemetryTestHarness } from './__fixtures__/link-telemetry.js';
import { randomUUID } from 'node:crypto';

import { createRouterClient } from '@orpc/server';
import { authSchema, createAuth, type AuthInstance, type UserSyncPort } from '@tayzu/auth';
import { createCerbosClient, type CerbosClient } from '@tayzu/authz';
import { createUserSync } from '@tayzu/catalog';
import { runMigrations } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { harnessPools } from './__fixtures__/pools.js';
import { createIdentityRouter } from './identity-router.js';
import { createAuthRepository } from './identity/auth-repository.js';
import { createUserSyncAdapter } from './identity/user-sync-adapter.js';
import { createAdminUser } from '../../../packages/auth/src/__fixtures__/admin-user.js';
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
      createIdentityRouter({ auth, authz: cerbos, authRepository: createAuthRepository(authPool) }),
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
      createIdentityRouter({ auth, authz: cerbos, authRepository: createAuthRepository(authPool) }),
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
