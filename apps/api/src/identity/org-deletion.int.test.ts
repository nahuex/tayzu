/**
 * Task 5.1 of openspec/changes/045-org-deletion-and-data-retention (design D1 "Phase 1,
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
import { randomUUID } from 'node:crypto';

import { createRouterClient } from '@orpc/server';
import { authSchema, createAuth, createRecordingEmailSender, type AuthInstance } from '@tayzu/auth';
import { createMachineCredential } from '@tayzu/auth/machine-credentials';
import { createCerbosClient, type CerbosClient } from '@tayzu/authz';
import { createUserSync } from '@tayzu/catalog';
import { runMigrations, withTenantTransaction } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { createAdminUser } from '../../../../packages/auth/src/__fixtures__/admin-user.js';
import {
  TEST_PASSWORD,
  TEST_SECRET,
} from '../../../../packages/auth/src/__fixtures__/test-secret.js';
import { harnessPools } from '../__fixtures__/pools.js';
import { createIdentityRouter } from '../identity-router.js';
import { createAuthRepository, type AuthRepository } from './auth-repository.js';
import { createEmailTenantGate } from './email-tenant-gate.js';
import { createInMemoryEmailCapStore } from './invitation-caps.js';
import { createWithUserLock } from './user-lock.js';
import { createUserSyncAdapter } from './user-sync-adapter.js';

const REQUESTED_EVENT = 'catalog.audit.org_deletion_requested';
const REVOKED_EVENT = 'auth.security.session_revoked';

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

  function freshClient(): {
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
    });
    const client = createRouterClient(router, {
      context: (raw: Record<string, unknown>) => raw,
    }) as unknown as OrgDeleteClient;
    return { client, sender };
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

  async function seedInvitation(tenantId: string, inviterId: string): Promise<string> {
    const id = `inv-${randomUUID()}`;
    await authPool.query(
      `insert into auth.invitation (id, organization_id, email, role, status, expires_at, created_at, inviter_id)
       values ($1, $2, $3, 'member', 'pending', now() + interval '2 days', now(), $4)`,
      [id, tenantId, `org-del-invitee-${randomUUID()}@example.test`, inviterId],
    );
    return id;
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
    const invitationId = await seedInvitation(org.id, admin.userId);
    return {
      tenantId: org.id,
      adminId: admin.userId,
      sessionIds,
      credentialIds: [credential.id],
      invitationIds: [invitationId],
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
});
