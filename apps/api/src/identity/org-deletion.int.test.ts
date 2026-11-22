/**
 * Task 5.1 of openspec/changes/archive/2026-11-18-045-org-deletion-and-data-retention (design D1 "Phase 1,
 * request", D6 "API contract"; spec requirement "The deletion route is authorized, step-up
 * gated, tenant-bound and mounted behind the switch").
 *
 * Requirement (excerpt): "The confirmation MUST travel in the query string and MUST equal the
 * host tenant; a confirmation sent only in a body, or one that names another tenant, MUST fail
 * with `CATALOG_VALIDATION_FAILED` and change nothing."
 *
 * Scenario "Org deletion targets only the host tenant":
 * - WHEN an admin of `t1` requests org deletion with `t2`'s identifier as the confirmation
 * - THEN the operation fails with `CATALOG_VALIDATION_FAILED` and nothing of `t1` or `t2` changes
 *
 * Task 5.1 adds: a missing confirmation and a wrong confirmation (another tenant's id, a random
 * string) each answer `CATALOG_VALIDATION_FAILED`, and nothing changes: no deletion marker for
 * any tenant involved, sessions, credentials (no `apikey` disabled or removed, no revocation-list
 * row) and pending invitations intact, no notice sent, no deletion audit or session-revoked event.
 * A control case shows the host tenant's own identifier is not refused as a wrong confirmation,
 * so an operation that refuses every input cannot pass.
 *
 * ## Harness
 *
 * In process only (tasks.md "Order matters": no HTTP assertion before group 8): the router is
 * `createIdentityRouter` over a real Better Auth instance (`createAuth` on the harness `auth`
 * pool), the real auth repository, the `tayzu_app` pool and a real Cerbos at `localhost:3593`,
 * called through `createRouterClient` with a host-supplied context (`tenantId`, `actor`,
 * `principal.roles`). Step-up runs only in the OpenAPI interceptor (design D6), so no step-up is
 * needed in process. The email gate has a recording sender and roomy caps. Every seeded value
 * (organizations, users, emails, sessions, invitations, credential names) is random per run, so
 * the shared database is safe with tests running in parallel.
 *
 * ## Production symbols expected
 *
 * - `createIdentityRouter` (`../identity-router.js`) gains the procedure
 *   `identity.organization.delete`, a `defineIdentityOperation` on `RESOURCE_KINDS.organization`
 *   / `delete` whose target is the host tenant, route `DELETE /v1/organization` (high-risk).
 * - Under `inputStructure: 'detailed'` its input is `{ query: { confirmation: string } }`: the
 *   confirmation is the organization's identifier and must equal the host `ctx.tenantId`. A
 *   missing query, a missing or wrong `confirmation`, or a confirmation sent only in `body`
 *   fails with `CATALOG_VALIDATION_FAILED` before any write.
 * - The phase 1 logic lives in `./org-deletion.ts` (filled by group 5); this test needs no
 *   export from it.
 *
 * ## Why this fails right now
 *
 * `identity.organization.delete` does not exist on the router, so the call is a TypeError, not a
 * `CATALOG_VALIDATION_FAILED` refusal.
 */
// Load-bearing import order (design D1 of `043`): the telemetry harness registers before
// anything that loads `@tayzu/auth` creates its logger.
import { registration, type TelemetryTestHarness } from '../__fixtures__/link-telemetry.js';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';

import { createRouterClient } from '@orpc/server';
import {
  authSchema,
  createAuth,
  createContextResolver,
  createRecordingEmailSender,
  exchangeMachineToken,
  type AuthInstance,
} from '@tayzu/auth';
import { createMachineCredential } from '@tayzu/auth/machine-credentials';
import { createCerbosClient, type CerbosClient } from '@tayzu/authz';
import { createUserSync } from '@tayzu/catalog';
import { runMigrations, withTenantTransaction } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import {
  bootstrapTestTenant,
  createAdminUser,
  signInAdminUser,
} from '../../../../packages/auth/src/__fixtures__/admin-user.js';
import {
  TEST_PASSWORD,
  TEST_SECRET,
} from '../../../../packages/auth/src/__fixtures__/test-secret.js';
import { harnessPools } from '../__fixtures__/pools.js';
import { createIdentityRouter } from '../identity-router.js';
import { createApp, type App } from '../server.js';
import { createAuthRepository, type AuthRepository } from './auth-repository.js';
import { createEmailTenantGate } from './email-tenant-gate.js';
import { createInMemoryEmailCapStore } from './invitation-caps.js';
import { createResetTokenStore } from './reset-token-store.js';
import { createWithUserLock } from './user-lock.js';
import { createUserSyncAdapter } from './user-sync-adapter.js';

const REQUESTED_EVENT = 'catalog.audit.org_deletion_requested';
const REVOKED_EVENT = 'auth.security.session_revoked';
const REPEATED_EVENT = 'catalog.security.org_deletion_repeated';

interface OrganizationSurface {
  createOrganization(args: {
    body: { name: string; slug: string; userId: string };
  }): Promise<{ id: string }>;
  addMember(args: {
    body: { userId: string; organizationId: string; role: string };
  }): Promise<unknown>;
}

/** The detailed input of `identity.organization.delete`; `body` is here only to be refused. */
interface DeleteInput {
  readonly query?: Record<string, unknown>;
  readonly body?: Record<string, unknown>;
}

interface OrgDeleteClient {
  identity: {
    organization: {
      delete(input: DeleteInput, options: { context: Record<string, unknown> }): Promise<unknown>;
    };
  };
}

interface Tenant {
  readonly tenantId: string;
  readonly adminId: string;
  /** The organization's name and slug and every seeded email: free text no signal may carry. */
  readonly freeText: readonly string[];
  readonly sessionIds: readonly string[];
  readonly credentialIds: readonly string[];
  readonly invitationIds: readonly string[];
}

/** Everything phase 1 would touch for one tenant. */
interface TenantState {
  readonly markers: readonly unknown[];
  readonly sessions: readonly unknown[];
  readonly credentials: readonly unknown[];
  readonly revocations: readonly unknown[];
  readonly invitations: readonly unknown[];
  readonly members: readonly unknown[];
}

describe('identity.organization.delete requires the host tenant as confirmation (task 5.1)', () => {
  let harness: TelemetryTestHarness;
  let appPool: Pool;
  let authPool: Pool;
  let auth: AuthInstance;
  let cerbos: CerbosClient;
  let authRepository: AuthRepository;

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
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync: createUserSyncAdapter({
        userSync: createUserSync({ pool: appPool, authz: cerbos }),
      }),
    });
    authRepository = createAuthRepository(authPool);
  }, 60_000);

  /**
   * `appPool` replaces the `tayzu_app` pool the router writes through (task 5.3 passes a pool
   * with a failure seam on the credential revocation).
   */
  function freshClient(overrides: { orgDeletionWindowDays?: number; appPool?: Pool } = {}): {
    client: OrgDeleteClient;
    sender: ReturnType<typeof createRecordingEmailSender>;
  } {
    const sender = createRecordingEmailSender();
    const router = createIdentityRouter({
      auth,
      authz: cerbos,
      authRepository,
      withUserLock: createWithUserLock(authPool),
      emailGate: createEmailTenantGate({
        disabledTenantIds: [],
        recipientKeySecret: `org-deletion-test-only-secret-${randomUUID()}`,
        capStore: createInMemoryEmailCapStore({
          tenant: { max: 10_000, windowSeconds: 3600 },
          recipient: { max: 10_000, windowSeconds: 86_400 },
        }),
        sender,
      }),
      invitationLinkBaseUrl: 'https://app.tayzu.test',
      appPool,
      ...overrides,
    });
    const client = createRouterClient(router, {
      context: (raw: Record<string, unknown>) => raw,
    }) as unknown as OrgDeleteClient;
    return { client, sender };
  }

  const REVOCATION_INSERT = /insert\s+into\s+machine_credential_revocation/i;

  /**
   * The `tayzu_app` pool whose clients fail the first revocation-list insert they see, then
   * behave normally. `fired` records that the seam was reached.
   */
  function poolFailingFirstRevocation(pool: Pool): { pool: Pool; fired: () => boolean } {
    let armed = true;
    let didFire = false;
    const seamQuery =
      (target: object) =>
      async (...args: unknown[]): Promise<unknown> => {
        const first = args[0];
        const text =
          typeof first === 'string'
            ? first
            : typeof first === 'object' && first !== null && 'text' in first
              ? String(first.text)
              : '';
        if (armed && REVOCATION_INSERT.test(text)) {
          armed = false;
          didFire = true;
          throw new Error('injected failure: credential revocation (task 5.3 seam)');
        }
        const query = Reflect.get(target, 'query', target) as (...a: unknown[]) => Promise<unknown>;
        return await Reflect.apply(query, target, args);
      };
    const bindAll = <T extends object>(target: T, wrap: (property: string | symbol) => unknown) =>
      new Proxy(target, {
        get(inner, property) {
          const wrapped = wrap(property);
          if (wrapped !== undefined) {
            return wrapped;
          }
          const value: unknown = Reflect.get(inner, property, inner);
          return typeof value === 'function'
            ? (value as (...a: unknown[]) => unknown).bind(inner)
            : value;
        },
      });
    const seamed = bindAll(pool, (property) => {
      if (property === 'query') {
        return seamQuery(pool);
      }
      if (property === 'connect') {
        return async (): Promise<unknown> => {
          const client = await pool.connect();
          return bindAll(client, (clientProperty) =>
            clientProperty === 'query' ? seamQuery(client) : undefined,
          );
        };
      }
      return undefined;
    });
    return { pool: seamed, fired: () => didFire };
  }

  function adminContext(tenant: Tenant): Record<string, unknown> {
    return {
      tenantId: tenant.tenantId,
      actor: { type: 'user', id: tenant.adminId },
      principal: { roles: ['admin'] },
    };
  }

  async function seedSession(userId: string, tenantId: string): Promise<string> {
    const id = `ses-${randomUUID()}`;
    await authPool.query(
      `insert into auth.session (id, expires_at, token, created_at, updated_at, user_id, active_organization_id)
       values ($1, now() + interval '1 day', $2, now(), now(), $3, $4)`,
      [id, `tok-${randomUUID()}`, userId, tenantId],
    );
    return id;
  }

  async function seedInvitation(
    tenantId: string,
    inviterId: string,
  ): Promise<{ id: string; email: string }> {
    const id = `inv-${randomUUID()}`;
    const email = `org-del-invitee-${randomUUID()}@example.test`;
    await authPool.query(
      `insert into auth.invitation (id, organization_id, email, role, status, expires_at, created_at, inviter_id)
       values ($1, $2, $3, 'member', 'pending', now() + interval '2 days', now(), $4)`,
      [id, tenantId, email, inviterId],
    );
    return { id, email };
  }

  /** A fresh organization with an owner, an admin, two sessions, a credential and an invitation. */
  async function freshTenant(): Promise<Tenant> {
    const suffix = randomUUID();
    const api = auth.api as OrganizationSurface;
    const owner = await createAdminUser(auth, {
      name: `Org Deletion Owner ${suffix}`,
      email: `org-del-owner-${suffix}@example.test`,
      password: TEST_PASSWORD,
    });
    const org = await api.createOrganization({
      body: { name: `Org Deletion ${suffix}`, slug: `org-del-${suffix}`, userId: owner.userId },
    });
    const admin = await createAdminUser(auth, {
      name: `Org Deletion Admin ${suffix}`,
      email: `org-del-admin-${suffix}@example.test`,
      password: TEST_PASSWORD,
    });
    await api.addMember({
      body: { userId: admin.userId, organizationId: org.id, role: 'admin' },
    });
    const sessionIds = [
      await seedSession(admin.userId, org.id),
      await seedSession(owner.userId, org.id),
    ];
    const credential = await createMachineCredential(auth, {
      userId: admin.userId,
      organizationId: org.id,
      name: `org-del-cred-${randomUUID().slice(0, 8)}`,
      actorKind: 'integration',
      metadata: { createdBy: admin.userId },
    });
    const invitation = await seedInvitation(org.id, admin.userId);
    return {
      tenantId: org.id,
      adminId: admin.userId,
      freeText: [
        `Org Deletion ${suffix}`,
        `org-del-${suffix}`,
        `org-del-owner-${suffix}@example.test`,
        `org-del-admin-${suffix}@example.test`,
        invitation.email,
      ],
      sessionIds,
      credentialIds: [credential.id],
      invitationIds: [invitation.id],
    };
  }

  async function stateOf(tenant: Tenant): Promise<TenantState> {
    const { markers, revocations } = await withTenantTransaction(
      appPool,
      { tenantId: tenant.tenantId },
      async (client) => ({
        markers: (
          await client.query(
            'select tenant_id, state, purge_after from tenant_deletion_marker where tenant_id = $1',
            [tenant.tenantId],
          )
        ).rows,
        revocations: (
          await client.query(
            'select credential_id from machine_credential_revocation where tenant_id = $1 order by credential_id',
            [tenant.tenantId],
          )
        ).rows,
      }),
    );
    const sessions = (
      await authPool.query(
        'select id, expires_at, user_id, active_organization_id from auth.session where active_organization_id = $1 order by id',
        [tenant.tenantId],
      )
    ).rows;
    const credentials = (
      await authPool.query(
        'select id, enabled, expires_at, reference_id from auth.apikey where reference_id = $1 order by id',
        [tenant.tenantId],
      )
    ).rows;
    const invitations = (
      await authPool.query(
        'select id, status, expires_at from auth.invitation where organization_id = $1 order by id',
        [tenant.tenantId],
      )
    ).rows;
    const members = (
      await authPool.query(
        'select id, user_id, role from auth.member where organization_id = $1 order by id',
        [tenant.tenantId],
      )
    ).rows;
    return { markers, sessions, credentials, revocations, invitations, members };
  }

  /** The seeded rows are all live: the baseline "nothing changed" is compared against. */
  function expectIntact(tenant: Tenant, state: TenantState): void {
    expect(state.markers, 'no deletion marker for the tenant').toEqual([]);
    expect(state.revocations, 'no credential of the tenant on the revocation list').toEqual([]);
    expect(
      (state.sessions as { id: string }[]).map((row) => row.id),
      "the tenant's sessions are still there",
    ).toEqual([...tenant.sessionIds].sort());
    expect(state.credentials, "the tenant's credentials are still there and enabled").toEqual(
      tenant.credentialIds.map((id): unknown => expect.objectContaining({ id, enabled: true })),
    );
    expect(state.invitations, "the tenant's invitations are still pending").toEqual(
      tenant.invitationIds.map((id): unknown => expect.objectContaining({ id, status: 'pending' })),
    );
  }

  async function logRecordsFor(eventName: string, tenantIds: readonly string[]) {
    await harness.forceFlush();
    return [...harness.logExporter.getFinishedLogRecords()].filter(
      (record) =>
        record.eventName === eventName &&
        tenantIds.includes(record.attributes['tayzu.tenant.id'] as string),
    );
  }

  async function expectRefusedAndNothingChanged(
    caller: Tenant,
    input: DeleteInput,
    others: readonly Tenant[],
  ): Promise<void> {
    const involved = [caller, ...others];
    const before = await Promise.all(involved.map((tenant) => stateOf(tenant)));
    involved.forEach((tenant, index) => {
      expectIntact(tenant, before[index] as TenantState);
    });
    const { client, sender } = freshClient();

    await expect(
      client.identity.organization.delete(input, { context: adminContext(caller) }),
    ).rejects.toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });

    const after = await Promise.all(involved.map((tenant) => stateOf(tenant)));
    expect(after, 'nothing of any tenant involved changed').toEqual(before);
    expect(sender.sent, 'no deletion notice was sent').toEqual([]);
    const tenantIds = involved.map((tenant) => tenant.tenantId);
    expect(await logRecordsFor(REQUESTED_EVENT, tenantIds), 'no deletion was requested').toEqual(
      [],
    );
    expect(await logRecordsFor(REVOKED_EVENT, tenantIds), 'no session was revoked').toEqual([]);
  }

  it('Org deletion targets only the host tenant: an admin of t1 confirming with t2 identifier fails with CATALOG_VALIDATION_FAILED and nothing of t1 or t2 changes', async () => {
    const t1 = await freshTenant();
    const t2 = await freshTenant();
    await expectRefusedAndNothingChanged(t1, { query: { confirmation: t2.tenantId } }, [t2]);
  }, 60_000);

  it('a random-string confirmation fails with CATALOG_VALIDATION_FAILED and nothing changes', async () => {
    const t1 = await freshTenant();
    await expectRefusedAndNothingChanged(
      t1,
      { query: { confirmation: `org-${randomUUID()}` } },
      [],
    );
  }, 60_000);

  it.each([
    ['no query section', {}],
    ['an empty query', { query: {} }],
    ['an empty confirmation', { query: { confirmation: '' } }],
  ] as const)(
    'a missing confirmation (%s) fails with CATALOG_VALIDATION_FAILED and nothing changes',
    async (_name, input) => {
      const t1 = await freshTenant();
      await expectRefusedAndNothingChanged(t1, input, []);
    },
    60_000,
  );

  it('the host tenant identifier sent only in the body is a missing confirmation: CATALOG_VALIDATION_FAILED and nothing changes', async () => {
    const t1 = await freshTenant();
    await expectRefusedAndNothingChanged(t1, { body: { confirmation: t1.tenantId } }, []);
  }, 60_000);

  it('control: the host tenant identifier in the query is not refused as a wrong confirmation', async () => {
    const t3 = await freshTenant();
    const { client } = freshClient();
    const outcome = await client.identity.organization
      .delete({ query: { confirmation: t3.tenantId } }, { context: adminContext(t3) })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(outcome, 'the procedure exists and was called').not.toBeInstanceOf(TypeError);
    expect((outcome as { code?: unknown } | undefined)?.code).not.toBe('CATALOG_VALIDATION_FAILED');
  }, 60_000);
  /**
   * Task 5.2. Scenario "Requesting deletion revokes access at once" (spec, quoted):
   * - GIVEN organization `t1` with blueprints, entities, members and API credentials
   * - WHEN an admin with a fresh step-up verification confirms deletion of `t1` by its identifier
   * - THEN every member's session and every `t1` credential, human or machine, is rejected within
   *   seconds, a marker with a purge date 7 to 14 days away exists, and the data is still there
   *
   * 5.2 asserts the marker and the data-still-present parts, plus what phase 1 itself does
   * (design D1): sessions whose active organization is `t1` revoked (one
   * `auth.security.session_revoked`, reason `admin_action`, each), `t1`'s credentials on the
   * revocation list, pending invitations cancelled, and `catalog.audit.org_deletion_requested`
   * once with the admin as `tayzu.actor.id`. The rejection of the principals is task 5.6.
   * Step-up runs only in the OpenAPI interceptor (D6), so in process it is not exercised.
   */
  describe('phase 1 records the marker and revokes access (task 5.2)', () => {
    interface CatalogCounts {
      readonly blueprints: number;
      readonly entities: number;
    }

    async function catalogCounts(tenantId: string): Promise<CatalogCounts> {
      return await withTenantTransaction(appPool, { tenantId }, async (client) => {
        const result = await client.query<{ blueprints: number; entities: number }>(
          `select (select count(*)::int from catalog_blueprint where tenant_id = $1) as blueprints,
                  (select count(*)::int from catalog_entity where tenant_id = $1) as entities`,
          [tenantId],
        );
        const row = result.rows[0];
        return { blueprints: row?.blueprints ?? 0, entities: row?.entities ?? 0 };
      });
    }

    interface MarkerRow {
      readonly state: string;
      readonly requested_by: string;
      readonly exact_window: boolean;
      readonly requested_in_call: boolean;
    }

    async function markersOf(
      tenantId: string,
      windowDays: number,
      calledAt: Date,
    ): Promise<readonly MarkerRow[]> {
      return await withTenantTransaction(appPool, { tenantId }, async (client) => {
        const result = await client.query<MarkerRow>(
          `select state, requested_by,
                  purge_after = requested_at + make_interval(days => $2) as exact_window,
                  requested_at between $3 and clock_timestamp() as requested_in_call
             from tenant_deletion_marker where tenant_id = $1`,
          [tenantId, windowDays, calledAt],
        );
        return result.rows;
      });
    }

    async function databaseNow(): Promise<Date> {
      const result = await authPool.query<{ now: Date }>('select clock_timestamp() as now');
      const now = result.rows[0]?.now;
      if (now === undefined) {
        throw new Error('no database clock');
      }
      return now;
    }

    async function liveSessionsIn(tenantId: string): Promise<readonly string[]> {
      const result = await authPool.query<{ id: string }>(
        'select id from auth.session where active_organization_id = $1 and expires_at > now() order by id',
        [tenantId],
      );
      return result.rows.map((row) => row.id);
    }

    async function liveSessionIds(ids: readonly string[]): Promise<readonly string[]> {
      const result = await authPool.query<{ id: string }>(
        'select id from auth.session where id = any($1) and expires_at > now() order by id',
        [ids],
      );
      return result.rows.map((row) => row.id);
    }

    async function requestDeletion(
      tenant: Tenant,
      window: { orgDeletionWindowDays?: number } = {},
    ): Promise<Date> {
      const calledAt = await databaseNow();
      const { client } = freshClient(window);
      await client.identity.organization.delete(
        { query: { confirmation: tenant.tenantId } },
        { context: adminContext(tenant) },
      );
      return calledAt;
    }

    it('Requesting deletion revokes access at once: one pending marker with purge_after = requested_at + 14 days (the default window) requested by the admin, and the catalog data and members are still there', async () => {
      // GIVEN organization `t1` with blueprints, entities, members and API credentials.
      const t1 = await freshTenant();
      const t2 = await freshTenant();
      const catalogBefore = await catalogCounts(t1.tenantId);
      expect(catalogBefore.blueprints, 'precondition: t1 has blueprints').toBeGreaterThan(0);
      expect(catalogBefore.entities, 'precondition: t1 has entities').toBeGreaterThan(0);
      const before = await stateOf(t1);
      expect(before.members.length, 'precondition: t1 has members').toBeGreaterThan(1);
      expect(before.credentials.length, 'precondition: t1 has API credentials').toBeGreaterThan(0);
      const t2Before = await stateOf(t2);
      const t2CatalogBefore = await catalogCounts(t2.tenantId);

      // WHEN an admin confirms deletion of `t1` by its identifier (default window).
      const calledAt = await requestDeletion(t1);

      // THEN exactly one pending marker for `t1`, purge date the default 14 days after the
      // request, requested by the admin's opaque id.
      expect(await markersOf(t1.tenantId, 14, calledAt)).toEqual([
        {
          state: 'pending',
          requested_by: t1.adminId,
          exact_window: true,
          requested_in_call: true,
        },
      ]);
      // AND the data is still there: blueprints, entities and members unchanged.
      expect(await catalogCounts(t1.tenantId), "t1's catalog data is still there").toEqual(
        catalogBefore,
      );
      expect((await stateOf(t1)).members, "t1's members are still there").toEqual(before.members);
      // AND nothing of another tenant changed.
      expect(await stateOf(t2), 'nothing of t2 changed').toEqual(t2Before);
      expect(await catalogCounts(t2.tenantId)).toEqual(t2CatalogBefore);
    }, 60_000);

    it('the purge date follows the configured window: with orgDeletionWindowDays 7 the marker has purge_after = requested_at + 7 days', async () => {
      const t1 = await freshTenant();
      const calledAt = await requestDeletion(t1, { orgDeletionWindowDays: 7 });
      expect(await markersOf(t1.tenantId, 7, calledAt)).toEqual([
        {
          state: 'pending',
          requested_by: t1.adminId,
          exact_window: true,
          requested_in_call: true,
        },
      ]);
    }, 60_000);

    it("revokes every session whose active organization is t1, each with one auth.security.session_revoked (admin_action) in t1, and leaves another tenant's sessions and the admin's session in another organization untouched", async () => {
      const t1 = await freshTenant();
      const t2 = await freshTenant();
      // A session of t1's admin whose active organization is t2 is not a session of t1.
      const adminElsewhere = await seedSession(t1.adminId, t2.tenantId);
      const t1Sessions = await liveSessionsIn(t1.tenantId);
      expect(t1Sessions, 'precondition: t1 sessions are live').toEqual(
        expect.arrayContaining([...t1.sessionIds]),
      );
      const t2Sessions = await liveSessionsIn(t2.tenantId);
      expect(t2Sessions, 'precondition: t2 sessions are live').toEqual(
        expect.arrayContaining([...t2.sessionIds, adminElsewhere]),
      );

      await requestDeletion(t1);

      expect(await liveSessionsIn(t1.tenantId), 'no live session of t1 is left').toEqual([]);
      expect(
        await liveSessionIds(t2Sessions),
        "t2's sessions and the admin's session in t2 are untouched",
      ).toEqual([...t2Sessions].sort());
      const revoked = await logRecordsFor(REVOKED_EVENT, [t1.tenantId, t2.tenantId]);
      expect(revoked, 'one session_revoked per revoked session, all in t1').toHaveLength(
        t1Sessions.length,
      );
      for (const record of revoked) {
        expect(record.attributes['tayzu.tenant.id']).toBe(t1.tenantId);
        expect(record.attributes['tayzu.auth.revocation.reason']).toBe('admin_action');
      }
    }, 60_000);

    /**
     * A session active in `tenantId` with a known token, plus the two reauthorization rows
     * keyed by it, written exactly as `reauthorization.ts` writes them: the state row
     * (`sso-reauth-state:<random>`, value `{"token":<token>,"verifier":<random>}`, 600 s) and
     * the result row (`sso-reauth-result:<token>`, value the ID token, 330 s).
     */
    async function seedReauthorizedSession(
      userId: string,
      tenantId: string,
    ): Promise<{ readonly stateIdentifier: string; readonly resultIdentifier: string }> {
      const token = `tok-${randomUUID()}`;
      await authPool.query(
        `insert into auth.session (id, expires_at, token, created_at, updated_at, user_id, active_organization_id)
         values ($1, now() + interval '1 day', $2, now(), now(), $3, $4)`,
        [`ses-${randomUUID()}`, token, userId, tenantId],
      );
      const stateIdentifier = `sso-reauth-state:${randomBytes(32).toString('base64url')}`;
      const resultIdentifier = `sso-reauth-result:${token}`;
      const store =
        'insert into auth.verification (id, identifier, value, expires_at) values ($1, $2, $3, now() + make_interval(secs => $4))';
      await authPool.query(store, [
        randomUUID(),
        stateIdentifier,
        JSON.stringify({ token, verifier: randomBytes(32).toString('base64url') }),
        600,
      ]);
      await authPool.query(store, [
        randomUUID(),
        resultIdentifier,
        `id-token-${randomUUID()}`,
        330,
      ]);
      return { stateIdentifier, resultIdentifier };
    }

    /**
     * The identifiers present in `auth.verification`, sorted in JS (code-unit order) so that they
     * compare with an expected `.sort()`: a SQL `order by` would follow the database's locale
     * collation instead, and the base64url tokens in the identifiers make the two orders differ.
     */
    async function verificationIdentifiers(identifiers: readonly string[]): Promise<string[]> {
      const result = await authPool.query<{ identifier: string }>(
        'select identifier from auth.verification where identifier = any($1)',
        [identifiers],
      );
      return result.rows.map((row) => row.identifier).sort();
    }

    it("deletes the sso-reauth-state: and sso-reauth-result: rows keyed by the tokens of t1's deleted sessions, and leaves another tenant's rows (Q170)", async () => {
      const t1 = await freshTenant();
      const t2 = await freshTenant();
      const t1Rows = await seedReauthorizedSession(t1.adminId, t1.tenantId);
      const t2Rows = await seedReauthorizedSession(t2.adminId, t2.tenantId);
      const t1Identifiers = [t1Rows.stateIdentifier, t1Rows.resultIdentifier];
      const t2Identifiers = [t2Rows.stateIdentifier, t2Rows.resultIdentifier];
      expect(
        await verificationIdentifiers([...t1Identifiers, ...t2Identifiers]),
        'precondition: the four reauthorization rows exist',
      ).toEqual([...t1Identifiers, ...t2Identifiers].sort());

      await requestDeletion(t1);

      expect(
        await verificationIdentifiers(t1Identifiers),
        "t1's reauthorization state and result rows are gone",
      ).toEqual([]);
      expect(
        await verificationIdentifiers(t2Identifiers),
        "t2's reauthorization state and result rows remain",
      ).toEqual([...t2Identifiers].sort());
    }, 60_000);

    it("revokes every t1 credential through the revocation list and cancels t1's pending invitations; another tenant's credentials and invitations are untouched", async () => {
      const t1 = await freshTenant();
      const t2 = await freshTenant();
      const t2Before = await stateOf(t2);

      await requestDeletion(t1);

      const after = await stateOf(t1);
      expect(
        (after.revocations as { credential_id: string }[]).map((row) => row.credential_id),
        'every t1 credential is on the revocation list',
      ).toEqual([...t1.credentialIds].sort());
      expect(after.invitations, "t1's pending invitations are cancelled").toEqual(
        t1.invitationIds.map((id): unknown => expect.objectContaining({ id, status: 'canceled' })),
      );
      const t2After = await stateOf(t2);
      expectIntact(t2, t2After);
      expect(t2After, 'nothing of t2 changed').toEqual(t2Before);
    }, 60_000);

    it('logs catalog.audit.org_deletion_requested once, with tayzu.tenant.id and the admin as tayzu.actor.id and no free text', async () => {
      const t1 = await freshTenant();
      const t2 = await freshTenant();

      await requestDeletion(t1);

      const requested = await logRecordsFor(REQUESTED_EVENT, [t1.tenantId, t2.tenantId]);
      expect(requested).toHaveLength(1);
      const record = requested[0];
      expect(record?.attributes).toEqual({
        'tayzu.tenant.id': t1.tenantId,
        'tayzu.actor.id': t1.adminId,
      });
      const serialized = JSON.stringify({ body: record?.body, attributes: record?.attributes });
      for (const text of t1.freeText) {
        expect(serialized, 'no organization name, slug or email').not.toContain(text);
      }
    }, 60_000);
  });

  /**
   * Task 5.3 (design D1: "Requesting it again while pending inserts no second marker, sends no
   * second notice and returns the original date, but **re-runs the idempotent revocations**
   * (sessions, credentials, invitations)").
   *
   * Scenario "Requesting deletion twice returns the original date" (spec, quoted):
   * - GIVEN `t1` has a pending deletion
   * - WHEN the deletion is requested again, in process
   * - THEN no second marker or notice is created, the original purge date is returned, and
   *   `catalog.security.org_deletion_repeated` is logged
   * (The `org_deletion_repeated` event is task 5.4 and is asserted there, not here.)
   *
   * Scenario "A repeated request completes a half-failed first one" (spec, quoted):
   * - GIVEN a first request that recorded the marker but failed before revoking a credential
   * - WHEN the deletion is requested again
   * - THEN the credential is revoked
   *
   * ## Expected response shape (named by this test; neither D6 nor the committed OpenAPI
   * document, which carries paths, methods and `x-tayzu-risk` only, names an output)
   *
   * `identity.organization.delete` resolves to `{ purgeAfter: string }`: the marker's
   * `purge_after` as an ISO 8601 timestamp with an explicit offset (`Date#toISOString()` form, or
   * any ISO 8601 string denoting the same instant). The first request returns its own new
   * marker's date; a repeat while pending returns the date of the pending marker. No other key.
   *
   * ## Failure seam
   *
   * No production seam is needed: the router's `appPool` option is a proxy of the `tayzu_app` pool
   * whose clients fail the first `insert into machine_credential_revocation` (the revocation-list
   * write of `revokeMachineCredential`, which runs before the `apikey` disable), so the marker is
   * already committed and the credential is left live. The repeat runs on the real pool.
   *
   * ## Production symbols expected
   *
   * - `requestOrgDeletion` (`./org-deletion.ts`) returns `Promise<{ purgeAfter: string }>`, and
   *   the handler of `identity.organization.delete` returns it. With a pending marker for the
   *   tenant it inserts nothing (no unique-index violation reaches the caller), reads the pending
   *   marker's `purge_after`, and still re-runs the session, credential and invitation
   *   revocations.
   *
   * ## Why this fails right now
   *
   * The handler returns nothing, and a second request hits the one-pending-marker partial unique
   * index, so it rejects before any revocation is re-run.
   */
  describe('a repeated request while pending (task 5.3)', () => {
    const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

    interface PendingMarker {
      readonly state: string;
      readonly purge_after: Date;
    }

    async function markerRowsOf(tenantId: string): Promise<readonly PendingMarker[]> {
      return await withTenantTransaction(appPool, { tenantId }, async (client) => {
        const result = await client.query<PendingMarker>(
          'select state, purge_after from tenant_deletion_marker where tenant_id = $1',
          [tenantId],
        );
        return result.rows;
      });
    }

    async function onlyMarkerOf(tenantId: string): Promise<PendingMarker> {
      const rows = await markerRowsOf(tenantId);
      expect(rows, 'exactly one deletion marker for the tenant').toHaveLength(1);
      const [row] = rows;
      if (row === undefined) {
        throw new Error('no marker');
      }
      expect(row.state).toBe('pending');
      return row;
    }

    /** The response carries the purge date of `marker`, as ISO 8601, and nothing else. */
    function expectPurgeDateOf(response: unknown, marker: PendingMarker): void {
      expect(response, 'the response is { purgeAfter }').toEqual({
        purgeAfter: expect.any(String) as unknown,
      });
      const { purgeAfter } = response as { purgeAfter: string };
      expect(purgeAfter, 'purgeAfter is an ISO 8601 timestamp').toMatch(ISO_8601);
      expect(new Date(purgeAfter).getTime(), "purgeAfter is the marker's purge_after").toBe(
        marker.purge_after.getTime(),
      );
    }

    async function liveSessionIds(ids: readonly string[]): Promise<readonly string[]> {
      const result = await authPool.query<{ id: string }>(
        'select id from auth.session where id = any($1) and expires_at > now() order by id',
        [ids],
      );
      return result.rows.map((row) => row.id);
    }

    /** The credential's `enabled` flag and whether it is on the revocation list. */
    async function credentialState(
      tenantId: string,
      credentialId: string,
    ): Promise<{ enabled: unknown; onRevocationList: boolean }> {
      const enabled: unknown = (
        await authPool.query<{ enabled: unknown }>(
          'select enabled from auth.apikey where id = $1 and reference_id = $2',
          [credentialId, tenantId],
        )
      ).rows[0]?.enabled;
      const onRevocationList = await withTenantTransaction(
        appPool,
        { tenantId },
        async (client) =>
          (
            await client.query(
              'select 1 from machine_credential_revocation where tenant_id = $1 and credential_id = $2',
              [tenantId, credentialId],
            )
          ).rows.length === 1,
      );
      return { enabled, onRevocationList };
    }

    async function invitationStatus(invitationId: string): Promise<unknown> {
      const result = await authPool.query<{ status: unknown }>(
        'select status from auth.invitation where id = $1',
        [invitationId],
      );
      return result.rows[0]?.status;
    }

    async function seedCredential(tenant: Tenant): Promise<string> {
      const credential = await createMachineCredential(auth, {
        userId: tenant.adminId,
        organizationId: tenant.tenantId,
        name: `org-del-cred-${randomUUID().slice(0, 8)}`,
        actorKind: 'integration',
        metadata: { createdBy: tenant.adminId },
      });
      return credential.id;
    }

    async function deleteAs(client: OrgDeleteClient, tenant: Tenant): Promise<unknown> {
      return await client.identity.organization.delete(
        { query: { confirmation: tenant.tenantId } },
        { context: adminContext(tenant) },
      );
    }

    it('Requesting deletion twice returns the original date: the first request returns its purge date, the repeat inserts no second marker, returns the original purge date and sends no more notices than the first', async () => {
      const t1 = await freshTenant();
      const { client, sender } = freshClient();

      // GIVEN `t1` has a pending deletion (the first request returns its own purge date).
      const first = await deleteAs(client, t1);
      const marker = await onlyMarkerOf(t1.tenantId);
      expectPurgeDateOf(first, marker);
      const sentAfterFirst = sender.sent.length;

      // WHEN the deletion is requested again, in process.
      const repeat = await deleteAs(client, t1);

      // THEN no second marker is created: still one pending marker, its date unchanged.
      const after = await onlyMarkerOf(t1.tenantId);
      expect(after.purge_after.getTime(), 'the pending marker is unchanged').toBe(
        marker.purge_after.getTime(),
      );
      // AND the original purge date is returned.
      expectPurgeDateOf(repeat, marker);
      // AND no second notice: the repeat sends nothing beyond what the first sent.
      expect(sender.sent, 'the repeat sends no notice').toHaveLength(sentAfterFirst);
    }, 60_000);

    it('a repeated request re-runs the revocations: a session, a credential and an invitation of t1 created between the two requests are revoked, revoked and cancelled', async () => {
      const t1 = await freshTenant();
      const { client } = freshClient();
      await deleteAs(client, t1);
      const marker = await onlyMarkerOf(t1.tenantId);

      // Between the two requests: a new session, a new credential and a new invitation of t1.
      const lateSession = await seedSession(t1.adminId, t1.tenantId);
      const lateCredential = await seedCredential(t1);
      const lateInvitation = await seedInvitation(t1.tenantId, t1.adminId);
      expect(await liveSessionIds([lateSession]), 'precondition: the session is live').toEqual([
        lateSession,
      ]);
      expect(
        await credentialState(t1.tenantId, lateCredential),
        'precondition: the credential is live',
      ).toEqual({ enabled: true, onRevocationList: false });
      expect(
        await invitationStatus(lateInvitation.id),
        'precondition: the invitation is pending',
      ).toBe('pending');

      const repeat = await deleteAs(client, t1);

      expectPurgeDateOf(repeat, marker);
      expect(await liveSessionIds([lateSession]), 'the late session is revoked').toEqual([]);
      expect(
        await credentialState(t1.tenantId, lateCredential),
        'the late credential is on the revocation list and disabled',
      ).toEqual({ enabled: false, onRevocationList: true });
      expect(await invitationStatus(lateInvitation.id), 'the late invitation is cancelled').toBe(
        'canceled',
      );
      expect(await markerRowsOf(t1.tenantId), 'still one marker').toHaveLength(1);
    }, 60_000);

    it('A repeated request completes a half-failed first one: a first request that recorded the marker but failed on the credential revocation leaves the credential live, and the repeat revokes it', async () => {
      const t1 = await freshTenant();
      const [credentialId] = t1.credentialIds;
      const [invitationId] = t1.invitationIds;
      if (credentialId === undefined || invitationId === undefined) {
        throw new Error('the tenant fixture seeds a credential and an invitation');
      }
      const seam = poolFailingFirstRevocation(appPool);

      // GIVEN a first request that recorded the marker but failed before revoking a credential.
      const { client: failing } = freshClient({ appPool: seam.pool });
      await expect(deleteAs(failing, t1), 'the first request fails').rejects.toBeDefined();
      expect(seam.fired(), 'the failure seam on the credential revocation was reached').toBe(true);
      const marker = await onlyMarkerOf(t1.tenantId);
      expect(
        await credentialState(t1.tenantId, credentialId),
        'the half-failed request left the credential live',
      ).toEqual({ enabled: true, onRevocationList: false });

      // WHEN the deletion is requested again.
      const { client } = freshClient();
      const repeat = await deleteAs(client, t1);

      // THEN the credential is revoked.
      expect(
        await credentialState(t1.tenantId, credentialId),
        'the repeat revoked the credential',
      ).toEqual({ enabled: false, onRevocationList: true });
      // AND the rest of phase 1 the first request never reached is completed too (design D1),
      // with the original date returned and still one marker.
      expect(await invitationStatus(invitationId), 'the pending invitation is cancelled').toBe(
        'canceled',
      );
      expectPurgeDateOf(repeat, marker);
      expect(await markerRowsOf(t1.tenantId), 'still one marker').toHaveLength(1);
    }, 60_000);
  });

  /**
   * Task 5.4: "A repeated deletion request is logged as `catalog.security.org_deletion_repeated`
   * (declared in 9.1) with the tenant and the admin as actor. Verify: `org-deletion.int.test.ts`
   * covers the event on the second request and not on the first, with no email or free text in
   * it."
   *
   * Scenario "Requesting deletion twice returns the original date" (spec, quoted):
   * - GIVEN `t1` has a pending deletion
   * - WHEN the deletion is requested again, in process
   * - THEN no second marker or notice is created, the original purge date is returned, and
   *   `catalog.security.org_deletion_repeated` is logged
   * (The marker, date and notice clauses are asserted by task 5.3 above; this block asserts the
   * event.)
   *
   * Observability contract row (design.md): `catalog.security.org_deletion_repeated` | WARN |
   * `tayzu.tenant.id`, `tayzu.actor.id` | "A deletion was requested again while one was pending;
   * the idempotent revocations were re-run (D1, new)".
   *
   * Resolved decision Q168: `catalog.audit.org_deletion_requested` is emitted by the request that
   * inserts the marker; "a repeat emits none (its event is 5.4's)".
   *
   * ## Why this fails right now
   *
   * The repeat path of `requestOrgDeletion` emits no `catalog.security.org_deletion_repeated`.
   */
  describe('a repeated request is logged as catalog.security.org_deletion_repeated (task 5.4)', () => {
    async function deleteAs(client: OrgDeleteClient, tenant: Tenant): Promise<unknown> {
      return await client.identity.organization.delete(
        { query: { confirmation: tenant.tenantId } },
        { context: adminContext(tenant) },
      );
    }

    it('Requesting deletion twice returns the original date: the first request logs no org_deletion_repeated, the repeat logs exactly one WARN with tayzu.tenant.id and the admin as tayzu.actor.id and no free text', async () => {
      const t1 = await freshTenant();
      const t2 = await freshTenant();
      const { client } = freshClient();

      // GIVEN `t1` has a pending deletion: the first request logs no repeated event.
      await deleteAs(client, t1);
      expect(
        await logRecordsFor(REPEATED_EVENT, [t1.tenantId, t2.tenantId]),
        'the first request is not a repeat',
      ).toEqual([]);

      // WHEN the deletion is requested again, in process.
      await deleteAs(client, t1);

      // THEN `catalog.security.org_deletion_repeated` is logged, once, for t1 only.
      const repeated = await logRecordsFor(REPEATED_EVENT, [t1.tenantId, t2.tenantId]);
      expect(repeated, 'exactly one repeated event').toHaveLength(1);
      const record = repeated[0];
      expect(record?.severityText, 'the declared severity').toBe('WARN');
      expect(record?.attributes, 'exactly the declared attributes').toEqual({
        'tayzu.tenant.id': t1.tenantId,
        'tayzu.actor.id': t1.adminId,
      });
      const serialized = JSON.stringify({ body: record?.body, attributes: record?.attributes });
      for (const text of t1.freeText) {
        expect(serialized, 'no organization name, slug or email').not.toContain(text);
      }
    }, 60_000);

    it('the first request still logs catalog.audit.org_deletion_requested once and the repeat logs no second one (Q168)', async () => {
      const t1 = await freshTenant();
      const { client } = freshClient();

      await deleteAs(client, t1);
      expect(
        await logRecordsFor(REQUESTED_EVENT, [t1.tenantId]),
        'the first request logs the audit event once',
      ).toHaveLength(1);

      await deleteAs(client, t1);
      expect(
        await logRecordsFor(REQUESTED_EVENT, [t1.tenantId]),
        'the repeat logs no second audit event',
      ).toHaveLength(1);
      expect(
        await logRecordsFor(REPEATED_EVENT, [t1.tenantId]),
        'the repeat is logged as repeated instead',
      ).toHaveLength(1);
    }, 60_000);
  });

  /**
   * Task 5.6 (design D4, Resolved decision Q152; spec requirement "A tenant with a pending or
   * purged deletion is closed to every principal").
   *
   * Scenario "Requesting deletion revokes access at once" (spec, quoted; 5.6 asserts its access
   * part):
   * - GIVEN organization `t1` with blueprints, entities, members and API credentials
   * - WHEN an admin with a fresh step-up verification confirms deletion of `t1` by its identifier
   * - THEN every member's session and every `t1` credential, human or machine, is rejected within
   *   seconds, a marker with a purge date 7 to 14 days away exists, and the data is still there
   *
   * Scenario "An already-issued machine token and a fresh exchange are refused" (spec, quoted):
   * - GIVEN a tenant with a pending marker, a machine token issued before the request and a
   *   credential that was not revoked
   * - WHEN the token is used, and the credential is exchanged for a new token
   * - THEN both are refused, and the rejection is logged with the reason `tenant_pending_deletion`
   *
   * Scenario "A purged tenant stays rejected" (spec, quoted):
   * - GIVEN `t1` was purged and its marker remains as a tombstone in state `purged`
   * - WHEN a principal of `t1` is resolved
   * - THEN it is rejected, while a tenant whose marker is `cancelled` is accepted
   *
   * Scenario "A password reset during the window does not reopen the tenant" (spec, quoted):
   * - GIVEN a tenant with a pending marker and a member who completes a password reset
   * - WHEN that member signs in and the session is resolved
   * - THEN it is rejected with the reason `tenant_pending_deletion`, exactly as before the reset
   *
   * Observability (design D4 and the 043 Log events row): each rejection emits
   * `catalog.security.principal_rejected` (WARN) with exactly `tayzu.identity.rejection.reason`
   * `tenant_pending_deletion` and `tayzu.actor.type`. The event carries no tenant id, so the
   * records are read as the ones emitted during the resolution under test (tests in one file run
   * sequentially).
   *
   * ## Harness
   *
   * Phase 1 revokes the sessions and the credentials it finds, so the principals under test are
   * the ones phase 1 cannot reach: a session opened by a sign-in after the request, and a machine
   * token whose credential a half-failed first request (the 5.3 failure seam on the revocation
   * insert) left live, which is exactly the GIVEN of "An already-issued machine token and a fresh
   * exchange are refused". Every resolution uses a fresh `createContextResolver` (empty 5-second
   * caches), the pattern of `043`'s resolver tests after a status change. The `purged` and
   * `cancelled` markers are seeded through the owner pool. The fresh exchange through
   * `POST /v1/auth/token` and 044's password reset (`POST /v1/auth/password-reset/confirm`, a token
   * issued by the real `createResetTokenStore`) go through the real server (`createApp`, injected
   * requests, never a listener), configured as 044's `password-reset-effects.int.test.ts` does.
   *
   * ## Production symbols expected
   *
   * - `createContextResolver({ auth, revocationPool })` (`@tayzu/auth`), unchanged in signature,
   *   reads `tenant_deletion_marker` as `tayzu_app` through `revocationPool` under the tenant
   *   (session branch: the active organization; bearer branch: the token's `tenantId` claim),
   *   cached at most 5 s per tenant, failing closed. A `pending` or `purged` marker rejects with
   *   `AuthContextError` (`CATALOG_CONTEXT_REQUIRED`) and emits the event and the counter above; a
   *   `cancelled` marker does not.
   * - `createApp` wires the same check into the token route: `exchangeMachineToken` gets the
   *   marker port (`ports.tenantDeletionLookup`, see `token-exchange.int.test.ts`).
   * - The password-reset routes of `044` are unchanged (Q152).
   *
   * ## Why this fails right now
   *
   * The resolver never reads the marker, so the post-request session, the live token and the
   * `purged` tenant's principals all resolve, and the token route mints a token.
   */
  describe('a tenant with a pending or purged marker is closed to every principal (task 5.6)', () => {
    const REJECTED_EVENT = 'catalog.security.principal_rejected';
    const ORIGIN = 'https://app.tayzu.test';
    const HMAC_SECRET = `org-deletion-56-test-only-secret-${randomUUID()}`;
    const NEW_PASSWORD = `Org-Deletion-Reset-${randomUUID()}-Aa1!`;
    let app: App;

    beforeAll(async () => {
      const pools = await harnessPools();
      app = await createApp({
        appPool: pools.appPool,
        authPool: pools.authPool,
        authSecret: TEST_SECRET,
        cerbosAddress: 'localhost:3593',
        allowedOrigins: [ORIGIN],
        mountIdentityRoutes: true,
        identityTokenHmacSecret: HMAC_SECRET,
        email: {
          sender: createRecordingEmailSender(),
          invitationLinkBaseUrl: ORIGIN,
          passwordResetLinkBaseUrl: ORIGIN,
          passwordResetMinResponseMs: 0,
          disabledTenantIds: [],
          killSwitch: false,
          recipientKeySecret: HMAC_SECRET,
          tenantCap: { max: 1000, windowSeconds: 3600 },
          recipientCap: { max: 1000, windowSeconds: 86_400 },
          passwordResetRecipientCap: { max: 1000, windowSeconds: 3600 },
          passwordResetIpCap: { max: 1000, windowSeconds: 3600 },
          passwordResetGlobalCap: { max: 100_000, windowSeconds: 3600 },
          accountCreatedNoticeGlobalCap: { max: 100_000, windowSeconds: 86_400 },
        },
      });
    }, 60_000);

    afterAll(async () => {
      await app.close();
    }, 60_000);

    function randomIp(): string {
      const octet = (): string => randomInt(1, 255).toString(10);
      return `10.${octet()}.${octet()}.${octet()}`;
    }

    interface ClosedTenantMember {
      readonly tenant: Tenant;
      readonly email: string;
      readonly cookie: string;
      readonly secret: string;
    }

    /** An owner (an admin of the tenant) with an `Active` `_user`, signed in, and a live credential. */
    async function freshMember(): Promise<ClosedTenantMember> {
      const suffix = randomUUID();
      const email = `org-del-56m-${suffix}@example.test`;
      const bootstrapped = await bootstrapTestTenant(auth, {
        pool: appPool,
        name: `Org Deletion 56 ${suffix}`,
        email,
        password: TEST_PASSWORD,
        organizationName: `Org Deletion 56 ${suffix}`,
        organizationSlug: `org-del-56m-${suffix}`,
        ip: randomIp(),
      });
      const credential = await createMachineCredential(auth, {
        userId: bootstrapped.userId,
        organizationId: bootstrapped.organizationId,
        name: `org-del-56-cred-${randomUUID().slice(0, 8)}`,
        actorKind: 'integration',
        metadata: { createdBy: bootstrapped.userId },
      });
      return {
        tenant: {
          tenantId: bootstrapped.organizationId,
          adminId: bootstrapped.userId,
          freeText: [email, `Org Deletion 56 ${suffix}`, `org-del-56m-${suffix}`],
          sessionIds: [],
          credentialIds: [credential.id],
          invitationIds: [],
        },
        email,
        cookie: bootstrapped.cookie,
        secret: credential.secret,
      };
    }

    function onlyCredentialOf(member: ClosedTenantMember): string {
      const [credentialId] = member.tenant.credentialIds;
      if (credentialId === undefined) {
        throw new Error('the member fixture seeds one credential');
      }
      return credentialId;
    }

    /** Seeds a terminal marker (`purged` or `cancelled`) through the owner pool. */
    async function seedMarker(tenantId: string, state: 'purged' | 'cancelled'): Promise<void> {
      await authPool.query(
        `insert into tenant_deletion_marker
           (tenant_id, purge_after, requested_by, state,
            catalog_purged_at, auth_purged_at, cancelled_at, cancelled_by)
         values ($1, now() + interval '14 days', $2, $3::text,
                 case when $3::text = 'purged' then now() end,
                 case when $3::text = 'purged' then now() end,
                 case when $3::text = 'cancelled' then now() end,
                 case when $3::text = 'cancelled' then $4::text end)`,
        [tenantId, `usr-${randomUUID()}`, state, `gh:${String(randomInt(1, 1_000_000_000))}`],
      );
    }

    async function markerStatesOf(tenantId: string): Promise<readonly string[]> {
      return await withTenantTransaction(appPool, { tenantId }, async (client) => {
        const result = await client.query<{ state: string }>(
          'select state from tenant_deletion_marker where tenant_id = $1 order by requested_at',
          [tenantId],
        );
        return result.rows.map((row) => row.state);
      });
    }

    async function requestDeletion(member: ClosedTenantMember, pool?: Pool): Promise<unknown> {
      const { client } = freshClient(pool === undefined ? {} : { appPool: pool });
      return await client.identity.organization.delete(
        { query: { confirmation: member.tenant.tenantId } },
        { context: adminContext(member.tenant) },
      );
    }

    /** A fresh resolver: empty 5-second caches. */
    async function resolveFresh(headers: Headers): Promise<unknown> {
      return await createContextResolver({ auth, revocationPool: appPool })(headers);
    }

    async function principalRejectionCount(): Promise<number> {
      await harness.forceFlush();
      return [...harness.logExporter.getFinishedLogRecords()].filter(
        (record) => record.eventName === REJECTED_EVENT,
      ).length;
    }

    /**
     * Resolves `headers` with a fresh resolver, expects the missing-context rejection, and returns
     * the `principal_rejected` records the resolution emitted (severity and attributes).
     */
    async function expectRejected(
      headers: Headers,
    ): Promise<readonly { severityText: unknown; attributes: unknown }[]> {
      const before = await principalRejectionCount();
      await expect(resolveFresh(headers), 'rejected as a missing context').rejects.toMatchObject({
        code: 'CATALOG_CONTEXT_REQUIRED',
      });
      await harness.forceFlush();
      return [...harness.logExporter.getFinishedLogRecords()]
        .filter((record) => record.eventName === REJECTED_EVENT)
        .slice(before)
        .map((record) => ({ severityText: record.severityText, attributes: record.attributes }));
    }

    function pendingDeletionRejection(actorType: 'user' | 'integration'): unknown {
      return {
        severityText: 'WARN',
        attributes: {
          'tayzu.identity.rejection.reason': 'tenant_pending_deletion',
          'tayzu.actor.type': actorType,
        },
      };
    }

    function bearer(accessToken: string): Headers {
      return new Headers({ authorization: `Bearer ${accessToken}` });
    }

    async function exchangeThroughRoute(
      clientId: string,
      clientSecret: string,
    ): Promise<{ status: number; body: Record<string, unknown> }> {
      const response = await app.app.inject({
        method: 'POST',
        url: '/v1/auth/token',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': randomIp() },
        payload: JSON.stringify({ clientId, clientSecret }),
      });
      return { status: response.statusCode, body: response.json<Record<string, unknown>>() };
    }

    async function signIn(email: string, password: string): Promise<string> {
      const signedIn = await signInAdminUser(auth, { email, password, ip: randomIp() });
      return signedIn.cookie;
    }

    it("Requesting deletion revokes access at once: after a confirmed request a member's session, also one opened by a sign-in after the request, is rejected as a missing context and logged with tenant_pending_deletion", async () => {
      const member = await freshMember();
      // Precondition: the member's session resolves to t1 before the request.
      await expect(resolveFresh(new Headers({ cookie: member.cookie }))).resolves.toMatchObject({
        tenantId: member.tenant.tenantId,
      });

      // WHEN an admin confirms deletion of t1 by its identifier.
      await requestDeletion(member);
      expect(await markerStatesOf(member.tenant.tenantId), 'a pending marker').toEqual(['pending']);

      // THEN the session that existed before the request is rejected.
      await expect(resolveFresh(new Headers({ cookie: member.cookie }))).rejects.toMatchObject({
        code: 'CATALOG_CONTEXT_REQUIRED',
      });
      // AND a session the member opens after the request (phase 1 cannot have revoked it) is
      // rejected as a missing context, logged once with the reason tenant_pending_deletion.
      const lateCookie = await signIn(member.email, TEST_PASSWORD);
      expect(await expectRejected(new Headers({ cookie: lateCookie }))).toEqual([
        pendingDeletionRejection('user'),
      ]);
    }, 60_000);

    it('An already-issued machine token and a fresh exchange are refused: a token issued before a request that left its credential live is rejected with tenant_pending_deletion, and a fresh exchange through POST /v1/auth/token is refused', async () => {
      const member = await freshMember();
      const credentialId = onlyCredentialOf(member);
      // GIVEN a machine token issued before the request, and the token route working.
      const { accessToken } = await exchangeMachineToken(auth, {
        clientId: credentialId,
        clientSecret: member.secret,
      });
      await expect(resolveFresh(bearer(accessToken))).resolves.toMatchObject({
        tenantId: member.tenant.tenantId,
      });
      const control = await exchangeThroughRoute(credentialId, member.secret);
      expect(control.status, 'precondition: the token route exchanges the credential').toBe(200);

      // AND a pending marker whose request failed before revoking the credential.
      const seam = poolFailingFirstRevocation(appPool);
      await expect(requestDeletion(member, seam.pool), 'the request fails').rejects.toBeDefined();
      expect(seam.fired(), 'the failure seam on the credential revocation was reached').toBe(true);
      expect(await markerStatesOf(member.tenant.tenantId), 'a pending marker').toEqual(['pending']);
      const revoked = await withTenantTransaction(
        appPool,
        { tenantId: member.tenant.tenantId },
        async (client) =>
          (
            await client.query(
              'select 1 from machine_credential_revocation where tenant_id = $1 and credential_id = $2',
              [member.tenant.tenantId, credentialId],
            )
          ).rows.length,
      );
      expect(revoked, 'precondition: the credential was not revoked').toBe(0);

      // WHEN the token is used THEN it is rejected as a missing context, logged with the reason.
      expect(await expectRejected(bearer(accessToken))).toEqual([
        pendingDeletionRejection('integration'),
      ]);

      // WHEN the credential is exchanged for a new token THEN the exchange is refused.
      const fresh = await exchangeThroughRoute(credentialId, member.secret);
      expect(fresh.status, 'the fresh exchange is refused').toBe(401);
      expect(fresh.body).toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
      expect(fresh.body, 'no token is minted').not.toHaveProperty('accessToken');
    }, 60_000);

    it('A purged tenant stays rejected: a session and a machine token of a tenant whose marker is purged are rejected with tenant_pending_deletion', async () => {
      const member = await freshMember();
      const { accessToken } = await exchangeMachineToken(auth, {
        clientId: onlyCredentialOf(member),
        clientSecret: member.secret,
      });
      await expect(resolveFresh(new Headers({ cookie: member.cookie }))).resolves.toMatchObject({
        tenantId: member.tenant.tenantId,
      });

      // GIVEN the marker remains as a tombstone in state `purged`.
      await seedMarker(member.tenant.tenantId, 'purged');

      // WHEN a principal of the tenant is resolved THEN it is rejected.
      expect(await expectRejected(new Headers({ cookie: member.cookie }))).toEqual([
        pendingDeletionRejection('user'),
      ]);
      expect(await expectRejected(bearer(accessToken))).toEqual([
        pendingDeletionRejection('integration'),
      ]);
    }, 60_000);

    it('a tenant whose marker is cancelled is accepted: its session and its machine token resolve, with no principal_rejected', async () => {
      const member = await freshMember();
      const { accessToken } = await exchangeMachineToken(auth, {
        clientId: onlyCredentialOf(member),
        clientSecret: member.secret,
      });

      // GIVEN the tenant's marker is a `cancelled` tombstone.
      await seedMarker(member.tenant.tenantId, 'cancelled');

      // THEN both principals are accepted.
      const before = await principalRejectionCount();
      await expect(resolveFresh(new Headers({ cookie: member.cookie }))).resolves.toMatchObject({
        tenantId: member.tenant.tenantId,
        actor: { type: 'user', id: member.tenant.adminId },
      });
      await expect(resolveFresh(bearer(accessToken))).resolves.toMatchObject({
        tenantId: member.tenant.tenantId,
        actor: { type: 'integration', id: onlyCredentialOf(member) },
      });
      expect(await principalRejectionCount(), 'no principal is rejected').toBe(before);
    }, 60_000);

    it('A password reset during the window does not reopen the tenant: a member of a tenant with a pending marker completes the reset, and the session of the sign-in that follows is rejected with tenant_pending_deletion, exactly as before the reset', async () => {
      const member = await freshMember();

      // GIVEN a tenant with a pending marker.
      await requestDeletion(member);
      expect(await markerStatesOf(member.tenant.tenantId), 'a pending marker').toEqual(['pending']);
      // Before the reset: a sign-in's session is rejected with the reason.
      const beforeReset = await expectRejected(
        new Headers({ cookie: await signIn(member.email, TEST_PASSWORD) }),
      );
      expect(beforeReset).toEqual([pendingDeletionRejection('user')]);

      // AND the member completes 044's password reset (the routes are untouched, Q152).
      const issued = await createResetTokenStore({
        authPool,
        withUserLock: createWithUserLock(authPool),
      }).issue(member.tenant.adminId);
      vi.stubGlobal('fetch', (): Promise<Response> => {
        // The breached-password range service reports nothing as breached.
        return Promise.resolve(
          new Response('0000000000000000000000000000000000A:3\r\n', { status: 200 }),
        );
      });
      let completed: { status: number; body: unknown };
      try {
        const response = await app.app.inject({
          method: 'POST',
          url: '/v1/auth/password-reset/confirm',
          headers: {
            'content-type': 'application/json',
            origin: ORIGIN,
            'x-csrf-token': 'orpc',
            'x-forwarded-for': randomIp(),
          },
          payload: JSON.stringify({
            id: issued.id,
            token: issued.token,
            newPassword: NEW_PASSWORD,
          }),
        });
        completed = { status: response.statusCode, body: response.json() };
      } finally {
        vi.unstubAllGlobals();
      }
      expect(completed, 'the reset completes').toEqual({
        status: 200,
        body: { completed: true },
      });

      // WHEN that member signs in (with the new password) and the session is resolved.
      const afterResetCookie = await signIn(member.email, NEW_PASSWORD);

      // THEN it is rejected with the reason tenant_pending_deletion, exactly as before the reset.
      const afterReset = await expectRejected(new Headers({ cookie: afterResetCookie }));
      expect(afterReset).toEqual([pendingDeletionRejection('user')]);
      expect(afterReset).toEqual(beforeReset);
      expect(await markerStatesOf(member.tenant.tenantId), 'still pending').toEqual(['pending']);
    }, 60_000);
  });
});
