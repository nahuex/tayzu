/**
 * Task 10.3 of openspec/changes/043-identity-lifecycle-and-org-admin
 * (`identity.serviceAccounts.create`; design D6, Resolved decisions Q30, Q40, Q90, Q117;
 * spec "Service accounts are non-human users created API-only").
 *
 * Scenarios (verbatim from the spec):
 * - "Service account is active immediately, no email": WHEN an admin with a fresh step-up
 *   verification creates service account `svc-ci-github` for tenant `t1`, THEN the returned
 *   `_user` entity has status `Active` and `accountKind: "service"`, AND no invitation email
 *   is sent, AND the response includes a `clientId` and a `clientSecret` that never appear in
 *   any later read of the account. (The step-up part is asserted over HTTP in 14.4; this is
 *   the service-level part.) Task 10.3 adds: the key's metadata records the creating admin as
 *   `createdBy`, one `catalog.audit.user_status_changed` names the admin and the `svc-…`
 *   identifier, and one `catalog.audit.service_account_created` carries the admin as
 *   `tayzu.actor.id` and the `svc-…` identifier.
 * - "A new service account does not inherit a surviving credential": GIVEN a non-revoked
 *   credential still bound to `svc-ci-github`, whose service account no longer exists, WHEN
 *   an admin creates the service account `svc-ci-github` again, THEN the creation fails with
 *   `CATALOG_VALIDATION_FAILED`, nothing is created and the old credential still does not
 *   resolve (the last part is 11.6's and 11.7's case). The creation succeeds once that key
 *   is revoked.
 *
 * ## Harness
 *
 * Real `auth` with the real Q30 adapter as `userSync`, a real Cerbos at `localhost:3593`, the
 * shared pools, the recording `EmailSender` behind the real `createEmailTenantGate`, and one
 * fresh organization (the tenant, random id) per test with an `admin` member who is not the
 * owner. Log events are read from the registered in-memory exporter, filtered by tenant.
 *
 * ## Production symbols expected
 *
 * - `createIdentityRouter` (`../identity-router.js`) gains the option
 *   `userSync: UserSyncAdapter` (`./user-sync-adapter.js`, the Q30 adapter the `_user` is
 *   written through) and the procedure `identity.serviceAccounts.create`: a
 *   `defineIdentityOperation` on `RESOURCE_KINDS.serviceAccount` / `create`, high-risk route,
 *   input `{ identifier: string }` (an `svc-…` identifier; 10.4 adds `role` and
 *   `moderatedBlueprints`), output `{ user: EntityOutput; clientId: string; clientSecret: string }`
 *   where `clientId` is the key's `id` and `clientSecret` its secret.
 * - It writes `userSync.writeUserChange({ tenantId, email: identifier, name, portRole: 'member',
 *   change: 'created_active', userId: identifier, accountKind: 'service', principal: { kind:
 *   'admin', id: <admin> }, onBehalfOf: { type: 'user', id: <admin> } })`, so
 *   `UserSyncInput` of `@tayzu/catalog` must carry `accountKind` into the stored
 *   `spec.properties.accountKind` (`service`) and the adapter must forward it.
 * - It issues the key through `createMachineCredential` with `userId` the admin and metadata
 *   `{ createdBy: <admin>, userId: <identifier> }`, a fixed `name` of at most 32 characters,
 *   under the per-service-account lock, refusing with `CredentialConflictError`
 *   (`CATALOG_VALIDATION_FAILED`) when a non-revoked key of the tenant is bound to the identifier.
 * - It emits `catalog.audit.service_account_created` (INFO) with exactly
 *   `tayzu.tenant.id`, `tayzu.actor.id` and `tayzu.identity.service_account.id`.
 *
 * ## Why this fails right now
 *
 * `identity.serviceAccounts` does not exist on the router (a TypeError on the call).
 */
// Load-bearing import order (design D1): the telemetry harness registers
// before anything that loads `@tayzu/auth` creates its logger.
import { registration, type TelemetryTestHarness } from '../__fixtures__/link-telemetry.js';
import { randomUUID } from 'node:crypto';

import { createRouterClient } from '@orpc/server';
import {
  authSchema,
  createAuth,
  createContextResolver,
  createRecordingEmailSender,
  exchangeMachineToken,
  type AuthInstance,
  createServiceAccountLookup,
} from '@tayzu/auth';
import { createMachineCredential, revokeMachineCredential } from '@tayzu/auth/machine-credentials';
import { createCerbosClient, type CerbosClient } from '@tayzu/authz';
import { createBlueprintService, createEntityService, createUserSync } from '@tayzu/catalog';
import { runMigrations, withTenantTransaction } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import { createAdminUser } from '../../../../packages/auth/src/__fixtures__/admin-user.js';
import {
  TEST_PASSWORD,
  TEST_SECRET,
} from '../../../../packages/auth/src/__fixtures__/test-secret.js';
import { harnessPools } from '../__fixtures__/pools.js';
import { createIdentityRouter } from '../identity-router.js';
import { createAuthRepository } from './auth-repository.js';
import { readAllApiKeys, readApiKeyMetadata, readRevokedIds } from './credentials.js';
import { createInMemoryEmailCapStore } from './invitation-caps.js';
import { createEmailTenantGate } from './email-tenant-gate.js';
import { createWithUserLock } from './user-lock.js';
import { createUserSyncAdapter } from './user-sync-adapter.js';

/**
 * Failure seam of task 10.3b: `createMachineCredential` delegates to the real function except for
 * the tenants listed here, for which it throws before issuing anything. Empty by default, so every
 * other test of this file sees the real behavior.
 */
const keySeam = vi.hoisted(() => ({
  failTenants: new Set<string>(),
  /**
   * Task 10.7 seam: the first `revokeMachineCredential` of a listed tenant completes for real and
   * then signals `entered` and waits for `wait`, so the deletion that called it is paused while it
   * still holds the per-service-account lock. One-shot: the entry is removed when it fires.
   */
  pauseAfterRevoke: new Map<string, { entered: () => void; wait: Promise<void> }>(),
}));

vi.mock('@tayzu/auth/machine-credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tayzu/auth/machine-credentials')>();
  return {
    ...actual,
    createMachineCredential: async (
      ...args: Parameters<typeof actual.createMachineCredential>
    ): Promise<Awaited<ReturnType<typeof actual.createMachineCredential>>> => {
      if (keySeam.failTenants.has(args[1].organizationId)) {
        throw new Error('injected key creation failure');
      }
      return await actual.createMachineCredential(...args);
    },
    revokeMachineCredential: async (
      ...args: Parameters<typeof actual.revokeMachineCredential>
    ): Promise<void> => {
      await actual.revokeMachineCredential(...args);
      const pause = keySeam.pauseAfterRevoke.get(args[1].tenantId);
      if (pause !== undefined) {
        keySeam.pauseAfterRevoke.delete(args[1].tenantId);
        pause.entered();
        await pause.wait;
      }
    },
  };
});

const STATUS_EVENT = 'catalog.audit.user_status_changed';
const CREATED_EVENT = 'catalog.audit.service_account_created';
const IDENTIFIER = 'svc-ci-github';

interface OrganizationSurface {
  createOrganization(args: {
    body: { name: string; slug: string; userId: string };
  }): Promise<{ id: string }>;
  addMember(args: {
    body: { userId: string; organizationId: string; role: string };
  }): Promise<unknown>;
}

interface CreatedServiceAccount {
  readonly user: {
    readonly identifier: string;
    readonly spec: { readonly properties: Record<string, unknown> };
  };
  readonly clientId: string;
  readonly clientSecret: string;
}

interface Tenant {
  readonly tenantId: string;
  readonly adminId: string;
}

interface UserRow {
  readonly status: string | null;
  readonly account_kind: string | null;
  readonly port_role: string | null;
  readonly moderated: unknown;
}

describe('identity.serviceAccounts.create (task 10.3)', () => {
  let harness: TelemetryTestHarness;
  let appPool: Pool;
  let authPool: Pool;
  let auth: AuthInstance;
  let cerbos: CerbosClient;
  let sender: ReturnType<typeof createRecordingEmailSender>;
  let client: ReturnType<
    typeof createRouterClient<ReturnType<typeof createIdentityRouter>, Record<string, unknown>>
  >;

  interface CreatingClient {
    identity: {
      serviceAccounts: {
        create(
          input: { body: { identifier: string } },
          options: { context: Record<string, unknown> },
        ): Promise<CreatedServiceAccount>;
      };
      credentials: {
        list(
          input: { query: Record<string, never> },
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
    await runMigrations(authPool);
    cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    const userSync = createUserSyncAdapter({
      userSync: createUserSync({ pool: appPool, authz: cerbos }),
    });
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync,
    });
    sender = createRecordingEmailSender();
    const capStore = createInMemoryEmailCapStore({
      tenant: { max: 1000, windowSeconds: 3600 },
      recipient: { max: 1000, windowSeconds: 86_400 },
    });
    client = createRouterClient(
      createIdentityRouter({
        auth,
        authz: cerbos,
        authRepository: createAuthRepository(authPool),
        withUserLock: createWithUserLock(authPool),
        emailGate: createEmailTenantGate({
          disabledTenantIds: [],
          capStore,
          sender,
          recipientKeySecret: 'gate-wiring-test-only-secret-0123456789-abcdef',
        }),
        appPool,
        userSync,
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );
  }, 60_000);

  const creator = (): CreatingClient => client;

  async function freshTenant(): Promise<Tenant> {
    const id = randomUUID();
    const api = auth.api as OrganizationSurface;
    const owner = await createAdminUser(auth, {
      name: 'Service Owner',
      email: `sa-owner-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    const org = await api.createOrganization({
      body: { name: 'Service Org', slug: `service-${id}`, userId: owner.userId },
    });
    const admin = await createAdminUser(auth, {
      name: 'Service Admin',
      email: `sa-admin-${id}@example.test`,
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

  async function userRows(tenantId: string, identifier: string): Promise<UserRow[]> {
    return await withTenantTransaction(appPool, { tenantId }, async (db) => {
      const result = await db.query<UserRow>(
        `select e.spec_properties ->> 'status' as status,
                e.spec_properties ->> 'accountKind' as account_kind,
                e.spec_properties ->> 'portRole' as port_role,
                e.spec_properties -> 'moderatedBlueprints' as moderated
           from catalog_entity e
           join catalog_blueprint b on b.tenant_id = e.tenant_id and b.id = e.blueprint_id
          where e.tenant_id = $1 and b.identifier = '_user' and e.identifier = $2`,
        [tenantId, identifier],
      );
      return result.rows;
    });
  }

  async function changeEvents(tenantId: string, identifier: string) {
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
        [tenantId, identifier],
      );
      return result.rows;
    });
  }

  interface KeyRow {
    readonly id: string;
    readonly name: string | null;
    readonly metadata: unknown;
  }

  async function keyRows(tenantId: string): Promise<KeyRow[]> {
    const rows = await authPool.query<KeyRow>(
      'select id, name, metadata from auth.apikey where reference_id = $1 order by created_at',
      [tenantId],
    );
    return rows.rows;
  }

  async function logRecords(eventName: string, tenantId: string) {
    await harness.forceFlush();
    return [...harness.logExporter.getFinishedLogRecords()].filter(
      (record) =>
        record.eventName === eventName && record.attributes['tayzu.tenant.id'] === tenantId,
    );
  }

  it('Service account is active immediately, no email: the entity is Active and service as system on behalf of the admin, one key bound to the identifier with createdBy, the secret returned once, and one status event and one created event naming the admin and the identifier', async () => {
    const tenant = await freshTenant();
    const sentBefore = sender.sent.length;

    const created = await creator().identity.serviceAccounts.create(
      { body: { identifier: IDENTIFIER } },
      { context: context(tenant) },
    );

    // THEN the returned `_user` entity has status `Active` and `accountKind: "service"`.
    expect(created.user.identifier).toBe(IDENTIFIER);
    expect(created.user.spec.properties['status']).toBe('Active');
    expect(created.user.spec.properties['accountKind']).toBe('service');
    const rows = await userRows(tenant.tenantId, IDENTIFIER);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'Active',
      account_kind: 'service',
      port_role: 'member',
    });
    expect(rows[0]?.moderated ?? []).toEqual([]);

    // Written as `system` with `onBehalfOf` the admin.
    const events = await changeEvents(tenant.tenantId, IDENTIFIER);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'created',
      actor_type: 'system',
      on_behalf_of_type: 'user',
      on_behalf_of_id: tenant.adminId,
    });

    // AND no invitation email is sent (the `EmailSender` fake recorded zero calls).
    expect(sender.sent).toHaveLength(sentBefore);

    // AND the response carries a `clientId` and a `clientSecret`; the key is the tenant's only
    // one, organization-owned, bound to the identifier, with the admin recorded as `createdBy`.
    expect(created.clientSecret).toMatch(/^tayzu_mc_/);
    const keys = await keyRows(tenant.tenantId);
    expect(keys).toHaveLength(1);
    expect(keys[0]?.id).toBe(created.clientId);
    expect(readApiKeyMetadata(keys[0]?.metadata)).toEqual({
      actorKind: 'integration',
      role: 'member',
      userId: IDENTIFIER,
      createdBy: tenant.adminId,
    });
    // The label is fixed because the plugin limits the name to 32 characters.
    const name = keys[0]?.name ?? '';
    expect(name.length).toBeGreaterThan(0);
    expect(name.length).toBeLessThanOrEqual(32);

    // AND neither value appears in any later read of the account or its credentials.
    const listed = await creator().identity.credentials.list(
      { query: {} },
      { context: context(tenant) },
    );
    const laterReads = JSON.stringify([listed, rows, keys]);
    expect(laterReads).not.toContain(created.clientSecret);
    expect(JSON.stringify(rows)).not.toContain(created.clientId);

    // One `catalog.audit.user_status_changed` names the admin and the `svc-…` identifier.
    const statusChanges = await logRecords(STATUS_EVENT, tenant.tenantId);
    const ofAccount = statusChanges.filter(
      (record) => record.attributes['tayzu.identity.service_account.id'] === IDENTIFIER,
    );
    expect(ofAccount).toHaveLength(1);
    expect(ofAccount[0]?.attributes).toMatchObject({
      'tayzu.actor.id': tenant.adminId,
      'tayzu.identity.service_account.id': IDENTIFIER,
      'tayzu.identity.user.status.event': 'created_active',
      'tayzu.identity.user.status.to': 'Active',
    });
    expect(ofAccount[0]?.attributes).not.toHaveProperty('tayzu.identity.user.status.from');

    // One `catalog.audit.service_account_created` carries the admin and the identifier.
    const createdEvents = await logRecords(CREATED_EVENT, tenant.tenantId);
    expect(createdEvents).toHaveLength(1);
    expect(createdEvents[0]?.attributes).toMatchObject({
      'tayzu.actor.id': tenant.adminId,
      'tayzu.identity.service_account.id': IDENTIFIER,
    });
    // No secret in any record of the tenant's two events.
    expect(JSON.stringify([...ofAccount, ...createdEvents].map((r) => r.attributes))).not.toContain(
      created.clientSecret,
    );
  }, 120_000);

  it('A new service account does not inherit a surviving credential: with a non-revoked key bound to the identifier and no such _user the creation is refused with CATALOG_VALIDATION_FAILED and nothing is created, and it succeeds once that key is revoked', async () => {
    const tenant = await freshTenant();
    // GIVEN a non-revoked key bound to `svc-ci-github`, seeded directly, and no such `_user`.
    const surviving = await createMachineCredential(auth, {
      userId: tenant.adminId,
      organizationId: tenant.tenantId,
      name: 'Surviving key',
      actorKind: 'integration',
      metadata: { createdBy: tenant.adminId, userId: IDENTIFIER },
    });
    expect(await userRows(tenant.tenantId, IDENTIFIER)).toHaveLength(0);
    const statusEventsBefore = (await logRecords(STATUS_EVENT, tenant.tenantId)).length;

    // WHEN an admin creates the service account again, THEN it fails and nothing is created.
    await expect(
      creator().identity.serviceAccounts.create(
        { body: { identifier: IDENTIFIER } },
        { context: context(tenant) },
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });

    expect(await userRows(tenant.tenantId, IDENTIFIER)).toHaveLength(0);
    expect(await changeEvents(tenant.tenantId, IDENTIFIER)).toHaveLength(0);
    expect((await keyRows(tenant.tenantId)).map((key) => key.id)).toEqual([surviving.id]);
    expect(await logRecords(CREATED_EVENT, tenant.tenantId)).toHaveLength(0);
    expect((await logRecords(STATUS_EVENT, tenant.tenantId)).length).toBe(statusEventsBefore);

    // It succeeds once that key is revoked.
    await revokeMachineCredential(auth, {
      userId: tenant.adminId,
      id: surviving.id,
      pool: appPool,
      tenantId: tenant.tenantId,
    });
    const created = await creator().identity.serviceAccounts.create(
      { body: { identifier: IDENTIFIER } },
      { context: context(tenant) },
    );

    expect(created.user.identifier).toBe(IDENTIFIER);
    const rows = await userRows(tenant.tenantId, IDENTIFIER);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('Active');
    expect(created.clientId).not.toBe(surviving.id);
  }, 120_000);

  it('A failed credential issue leaves no orphan service account: when the key creation fails after the _user was written, the operation fails, no _user of that identifier remains, no key exists and the failure is the error of the identity.service_account.create span', async () => {
    const tenant = await freshTenant();
    const identifier = `svc-orphan-${randomUUID().slice(0, 8)}`;
    // GIVEN the key creation fails after the `_user` entity was written.
    keySeam.failTenants.add(tenant.tenantId);

    // WHEN an admin creates a service account, THEN the operation fails.
    try {
      await expect(
        creator().identity.serviceAccounts.create(
          { body: { identifier } },
          { context: context(tenant) },
        ),
      ).rejects.toThrow();
    } finally {
      keySeam.failTenants.delete(tenant.tenantId);
    }

    // AND no `_user` entity of that service account remains, and no key exists.
    expect(await userRows(tenant.tenantId, identifier)).toHaveLength(0);
    expect(await keyRows(tenant.tenantId)).toEqual([]);
    expect(await logRecords(CREATED_EVENT, tenant.tenantId)).toHaveLength(0);

    // The failure is recorded as the error of the `identity.service_account.create` span.
    await harness.forceFlush();
    const spans = harness.spanExporter
      .getFinishedSpans()
      .filter(
        (span) =>
          span.name === 'identity.service_account.create' &&
          span.attributes['tayzu.identity.service_account.id'] === identifier,
      );
    expect(spans).toHaveLength(1);
    // SpanStatusCode.ERROR
    expect(spans[0]?.status.code).toBe(2);
  }, 120_000);

  // Task 10.4: creation validates the requested role and `moderatedBlueprints` (design D6 "Ceiling").
  interface CeilingClient {
    identity: {
      serviceAccounts: {
        create(
          input: { body: { identifier: string; role?: string; moderatedBlueprints?: string[] } },
          options: { context: Record<string, unknown> },
        ): Promise<CreatedServiceAccount>;
      };
    };
  }
  const ceilingClient = (): CeilingClient => client;

  it('Creating a service account with an elevated role is rejected: role admin, or a non-empty moderatedBlueprints, fails with CATALOG_VALIDATION_FAILED and no _user, change event, key or created event exists', async () => {
    const tenant = await freshTenant();
    const statusEventsBefore = (await logRecords(STATUS_EVENT, tenant.tenantId)).length;
    const attempts: {
      identifier: string;
      role?: string;
      moderatedBlueprints?: string[];
    }[] = [
      { identifier: 'svc-elevated-admin', role: 'admin' },
      { identifier: 'svc-elevated-moderator', moderatedBlueprints: ['service'] },
      { identifier: 'svc-elevated-both', role: 'admin', moderatedBlueprints: ['service'] },
      { identifier: 'svc-elevated-owner', role: 'owner' },
    ];

    for (const attempt of attempts) {
      // WHEN an admin attempts to create a service account with that role or grant.
      await expect(
        ceilingClient().identity.serviceAccounts.create(
          { body: attempt },
          { context: context(tenant) },
        ),
      ).rejects.toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });

      // THEN no `_user` entity is created.
      expect(await userRows(tenant.tenantId, attempt.identifier)).toHaveLength(0);
      expect(await changeEvents(tenant.tenantId, attempt.identifier)).toHaveLength(0);
    }

    // AND no credential is created.
    expect(await keyRows(tenant.tenantId)).toEqual([]);
    // AND no event of a creation is emitted.
    expect(await logRecords(CREATED_EVENT, tenant.tenantId)).toHaveLength(0);
    expect((await logRecords(STATUS_EVENT, tenant.tenantId)).length).toBe(statusEventsBefore);
  }, 120_000);

  it('Creating a service account with an elevated role is rejected: the accepted values (role member, an empty moderatedBlueprints) still create it as member with no grant', async () => {
    const tenant = await freshTenant();
    const identifier = `svc-member-${randomUUID().slice(0, 8)}`;

    const created = await ceilingClient().identity.serviceAccounts.create(
      { body: { identifier, role: 'member', moderatedBlueprints: [] } },
      { context: context(tenant) },
    );

    expect(created.user.identifier).toBe(identifier);
    const rows = await userRows(tenant.tenantId, identifier);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'Active', port_role: 'member' });
    expect(rows[0]?.moderated ?? []).toEqual([]);
    expect(await keyRows(tenant.tenantId)).toHaveLength(1);
  }, 120_000);

  // Task 10.5: authorization of `identity.serviceAccounts.create` against the real Cerbos.
  it('A non-admin cannot create a service account: a member is denied with AUTH_FORBIDDEN and no _user, change event, key or created event exists', async () => {
    const tenant = await freshTenant();
    const memberId = `member-${randomUUID()}`;
    const identifier = `svc-denied-${randomUUID().slice(0, 8)}`;
    const statusEventsBefore = (await logRecords(STATUS_EVENT, tenant.tenantId)).length;

    // WHEN an actor without the grant attempts to create a service account.
    await expect(
      creator().identity.serviceAccounts.create(
        { body: { identifier } },
        {
          context: {
            tenantId: tenant.tenantId,
            actor: { type: 'user', id: memberId },
            principal: { roles: ['member'] },
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });

    // THEN no `_user` entity or credential is created.
    expect(await userRows(tenant.tenantId, identifier)).toHaveLength(0);
    expect(await changeEvents(tenant.tenantId, identifier)).toHaveLength(0);
    expect(await keyRows(tenant.tenantId)).toEqual([]);
    expect(await logRecords(CREATED_EVENT, tenant.tenantId)).toHaveLength(0);
    expect((await logRecords(STATUS_EVENT, tenant.tenantId)).length).toBe(statusEventsBefore);
  }, 120_000);

  // Task 10.7: `identity.serviceAccounts.delete` (design D6, Resolved decisions Q40, Q90).
  interface DeleteClient {
    identity: {
      serviceAccounts: {
        delete(
          input: { params: { user: string } },
          options: { context: Record<string, unknown> },
        ): Promise<unknown>;
      };
      credentials: {
        create(
          input: { body: { name: string; kind: string; userId?: string } },
          options: { context: Record<string, unknown> },
        ): Promise<{ id: string; secret: string }>;
        rotate(
          input: { params: { credential: string } },
          options: { context: Record<string, unknown> },
        ): Promise<{ id: string; secret: string }>;
      };
    };
  }
  const deleter = (): DeleteClient => client;

  const REJECTION_WINDOW_MS = 8_000;

  /** Polls the resolver until it rejects the token, or the window (cache TTL 5 s plus slack) passes. */
  async function rejectedWithinWindow(token: string): Promise<boolean> {
    const resolveContext = createContextResolver({ auth, revocationPool: appPool });
    const deadline = Date.now() + REJECTION_WINDOW_MS;
    while (Date.now() < deadline) {
      try {
        await resolveContext(new Headers({ authorization: `Bearer ${token}` }));
      } catch {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }

  /** The ids of the tenant's keys bound to the identifier that are not on the revocation list. */
  async function nonRevokedBound(tenantId: string, identifier: string): Promise<string[]> {
    const [keys, revoked] = await Promise.all([
      readAllApiKeys(createAuthRepository(authPool), tenantId),
      readRevokedIds(appPool, tenantId),
    ]);
    return keys
      .filter((k) => !revoked.has(k.id) && readApiKeyMetadata(k.metadata).userId === identifier)
      .map((k) => k.id);
  }

  async function revocationCount(tenantId: string, id: string): Promise<number> {
    const result = await withTenantTransaction(appPool, { tenantId }, (db) =>
      db.query<{ n: string }>(
        `select count(*)::text as n from machine_credential_revocation
          where credential_id = $1 and tenant_id = $2`,
        [id, tenantId],
      ),
    );
    return Number(result.rows[0]?.n);
  }

  async function createAccount(tenant: Tenant, identifier: string): Promise<CreatedServiceAccount> {
    return await creator().identity.serviceAccounts.create(
      { body: { identifier } },
      { context: context(tenant) },
    );
  }

  it('Deleting a service account revokes its credential: the key is on the revocation list, its issued token and a new exchange are rejected, and the _user entity is gone, removed as system on behalf of the admin', async () => {
    const tenant = await freshTenant();
    const identifier = `svc-del-${randomUUID().slice(0, 8)}`;
    const created = await createAccount(tenant, identifier);
    const issued = await exchangeMachineToken(
      auth,
      {
        clientId: created.clientId,
        clientSecret: created.clientSecret,
      },
      { serviceAccountLookup: createServiceAccountLookup(appPool) },
    );

    await deleter().identity.serviceAccounts.delete(
      { params: { user: identifier } },
      { context: context(tenant) },
    );

    // THEN the `_user` entity is gone, removed as `system` on behalf of the admin.
    expect(await userRows(tenant.tenantId, identifier)).toHaveLength(0);
    const events = await changeEvents(tenant.tenantId, identifier);
    expect(events.at(-1)).toMatchObject({
      action: 'deleted',
      actor_type: 'system',
      on_behalf_of_type: 'user',
      on_behalf_of_id: tenant.adminId,
    });
    // AND the credential is revoked (permanently, on the revocation list) and cannot be restored.
    expect(await revocationCount(tenant.tenantId, created.clientId)).toBe(1);
    expect(await nonRevokedBound(tenant.tenantId, identifier)).toEqual([]);
    await expect(
      exchangeMachineToken(
        auth,
        {
          clientId: created.clientId,
          clientSecret: created.clientSecret,
        },
        { serviceAccountLookup: createServiceAccountLookup(appPool) },
      ),
    ).rejects.toThrow();
    expect(await rejectedWithinWindow(issued.accessToken)).toBe(true);
  }, 120_000);

  it('Deleting a service account revokes every bound credential: two non-revoked keys seeded directly are both revoked and both tokens are rejected within the cache window', async () => {
    const tenant = await freshTenant();
    const identifier = `svc-two-${randomUUID().slice(0, 8)}`;
    const first = await createAccount(tenant, identifier);
    // A second key, seeded as before the one-credential rule.
    const second = await createMachineCredential(auth, {
      userId: tenant.adminId,
      organizationId: tenant.tenantId,
      name: 'Second key',
      actorKind: 'integration',
      metadata: { createdBy: tenant.adminId, userId: identifier },
    });
    const tokens = await Promise.all(
      [
        { clientId: first.clientId, clientSecret: first.clientSecret },
        { clientId: second.id, clientSecret: second.secret },
      ].map((credentials) =>
        exchangeMachineToken(auth, credentials, {
          serviceAccountLookup: createServiceAccountLookup(appPool),
        }),
      ),
    );
    expect(await nonRevokedBound(tenant.tenantId, identifier)).toHaveLength(2);

    await deleter().identity.serviceAccounts.delete(
      { params: { user: identifier } },
      { context: context(tenant) },
    );

    expect(await nonRevokedBound(tenant.tenantId, identifier)).toEqual([]);
    expect(await revocationCount(tenant.tenantId, first.clientId)).toBe(1);
    expect(await revocationCount(tenant.tenantId, second.id)).toBe(1);
    for (const token of tokens) {
      expect(await rejectedWithinWindow(token.accessToken)).toBe(true);
    }
    expect(await userRows(tenant.tenantId, identifier)).toHaveLength(0);
  }, 120_000);

  it('Deleting a service account revokes every bound credential: a service account that a relation targets is deleted all the same', async () => {
    const tenant = await freshTenant();
    const identifier = `svc-rel-${randomUUID().slice(0, 8)}`;
    const created = await createAccount(tenant, identifier);
    const seeder = {
      tenantId: tenant.tenantId,
      actor: { type: 'user', id: 'relation-seeder' },
      principal: { roles: ['admin'] },
    } as const;
    await createBlueprintService({ pool: appPool, authz: cerbos }).create(seeder, {
      identifier: 'asset',
      title: { en: 'Asset' },
      schema: { properties: {} },
      relations: { owner: { title: { en: 'Owner' }, target: '_user' } },
    });
    await createEntityService({ pool: appPool, authz: cerbos }).create(seeder, {
      blueprint: 'asset',
      identifier: 'asset-1',
      title: 'Asset 1',
      spec: { properties: {}, relations: { owner: identifier } },
    });

    await deleter().identity.serviceAccounts.delete(
      { params: { user: identifier } },
      { context: context(tenant) },
    );

    expect(await userRows(tenant.tenantId, identifier)).toHaveLength(0);
    expect(await revocationCount(tenant.tenantId, created.clientId)).toBe(1);
    expect(await nonRevokedBound(tenant.tenantId, identifier)).toEqual([]);
  }, 120_000);

  /**
   * Starts a deletion that pauses (still holding the per-service-account lock) right after its
   * first revocation, runs `concurrent` while it is paused, and returns once both complete.
   */
  async function deleteWhile(
    tenant: Tenant,
    identifier: string,
    concurrent: () => Promise<unknown>,
  ): Promise<{ concurrentSettledWhilePaused: boolean }> {
    let signalEntered: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let release: () => void = () => undefined;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    keySeam.pauseAfterRevoke.set(tenant.tenantId, { entered: signalEntered, wait });
    const deletion = deleter().identity.serviceAccounts.delete(
      { params: { user: identifier } },
      { context: context(tenant) },
    );
    try {
      await Promise.race([
        entered,
        new Promise<never>((_, reject) =>
          setTimeout(() => {
            reject(new Error('the deletion never reached its first revocation'));
          }, 30_000),
        ),
      ]);
      let settled = false;
      const other = Promise.allSettled([concurrent()]).then(() => {
        settled = true;
      });
      // Give the concurrent call time to run: with the lock held it must still be waiting.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const concurrentSettledWhilePaused = settled;
      release();
      await Promise.allSettled([deletion, other]);
      await deletion;
      return { concurrentSettledWhilePaused };
    } finally {
      keySeam.pauseAfterRevoke.delete(tenant.tenantId);
      release();
    }
  }

  it('A credential created during a deletion does not survive it: a credentials.create bound to the account, started while the deletion holds the lock, ends with no non-revoked key bound to the identifier', async () => {
    const tenant = await freshTenant();
    const identifier = `svc-race-c-${randomUUID().slice(0, 8)}`;
    await createAccount(tenant, identifier);

    const { concurrentSettledWhilePaused } = await deleteWhile(tenant, identifier, () =>
      deleter().identity.credentials.create(
        { body: { name: 'During deletion', kind: 'integration', userId: identifier } },
        { context: context(tenant) },
      ),
    );

    // The create waited for the lock the deletion held.
    expect(concurrentSettledWhilePaused).toBe(false);
    // THEN no non-revoked credential is bound to the deleted identifier.
    expect(await userRows(tenant.tenantId, identifier)).toHaveLength(0);
    expect(await nonRevokedBound(tenant.tenantId, identifier)).toEqual([]);
  }, 120_000);

  it('A credential created during a deletion does not survive it: a rotation of its credential, started while the deletion holds the lock, ends with no non-revoked key bound to the identifier', async () => {
    const tenant = await freshTenant();
    const identifier = `svc-race-r-${randomUUID().slice(0, 8)}`;
    const created = await createAccount(tenant, identifier);

    const { concurrentSettledWhilePaused } = await deleteWhile(tenant, identifier, () =>
      deleter().identity.credentials.rotate(
        { params: { credential: created.clientId } },
        { context: context(tenant) },
      ),
    );

    expect(concurrentSettledWhilePaused).toBe(false);
    expect(await userRows(tenant.tenantId, identifier)).toHaveLength(0);
    expect(await nonRevokedBound(tenant.tenantId, identifier)).toEqual([]);
  }, 120_000);

  // Task 10.7b: every service-account route resolves its target as a service account (Q62).
  async function failureOf(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
    try {
      await run();
    } catch (error) {
      return {
        code: (error as { code?: unknown }).code,
        status: (error as { status?: unknown }).status,
        message: (error as Error).message,
        data: (error as { data?: unknown }).data,
      };
    }
    return { code: 'NO_ERROR' };
  }

  async function userSnapshot(tenantId: string, identifier: string): Promise<unknown> {
    return await withTenantTransaction(appPool, { tenantId }, async (db) => {
      const result = await db.query<{ spec: string; version: string }>(
        `select e.spec_properties::text as spec, e.version::text as version
           from catalog_entity e
           join catalog_blueprint b on b.tenant_id = e.tenant_id and b.id = e.blueprint_id
          where e.tenant_id = $1 and b.identifier = '_user' and e.identifier = $2`,
        [tenantId, identifier],
      );
      return result.rows;
    });
  }

  async function seedUserRow(
    tenantId: string,
    identifier: string,
    properties: Record<string, unknown>,
  ): Promise<void> {
    await createEntityService({ pool: appPool, authz: cerbos }).create(
      {
        tenantId,
        actor: { type: 'system', id: 'service-accounts-test-seed' },
        principal: { roles: ['admin'] },
      },
      { blueprint: '_user', identifier, title: 'Seeded user', spec: { properties } },
    );
  }

  /** Seeds the `_user` row only when the membership hook did not already write it. */
  async function ensureHumanRow(
    tenantId: string,
    identifier: string,
    portRole: string,
  ): Promise<void> {
    if ((await userRows(tenantId, identifier)).length > 0) return;
    await seedUserRow(tenantId, identifier, {
      accountKind: 'standard',
      status: 'Active',
      portRole,
    });
  }

  it('A service-account route refuses a human target: a delete of another human, of the admin, of an owner and of look-alikes answers the same CATALOG_NOT_FOUND as an unknown id, with rows intact, no credential revoked and no event emitted', async () => {
    const tenant = await freshTenant();
    const suffix = randomUUID().slice(0, 8);
    const adminEmail = (
      await authPool.query<{ email: string }>('select email from auth."user" where id = $1', [
        tenant.adminId,
      ])
    ).rows[0]?.email;
    const ownerEmail = (
      await authPool.query<{ email: string }>(
        `select u.email from auth.member m join auth."user" u on u.id = m.user_id
          where m.organization_id = $1 and m.role = 'owner'`,
        [tenant.tenantId],
      )
    ).rows[0]?.email;
    expect(adminEmail).toBeDefined();
    expect(ownerEmail).toBeDefined();
    const alice = `alice-${suffix}@example.com`;
    // A standard `_user` with an `svc-` shape, and a service `_user` without one (seeded directly).
    const svcShapedHuman = `svc-human-${suffix}`;
    const serviceWithoutPrefix = `ci-bot-${suffix}`;
    await ensureHumanRow(tenant.tenantId, adminEmail ?? '', 'admin');
    await ensureHumanRow(tenant.tenantId, ownerEmail ?? '', 'owner');
    await seedUserRow(tenant.tenantId, alice, {
      accountKind: 'standard',
      status: 'Active',
      portRole: 'member',
    });
    await seedUserRow(tenant.tenantId, svcShapedHuman, {
      accountKind: 'standard',
      status: 'Active',
      portRole: 'member',
    });
    await seedUserRow(tenant.tenantId, serviceWithoutPrefix, {
      accountKind: 'service',
      status: 'Active',
      portRole: 'member',
    });
    // Credentials bound to those identifiers must survive the refused deletes.
    const bound: string[] = [];
    for (const userId of [alice, svcShapedHuman, serviceWithoutPrefix, adminEmail ?? '']) {
      const key = await createMachineCredential(auth, {
        userId: tenant.adminId,
        organizationId: tenant.tenantId,
        name: 'Bound to a non service account',
        actorKind: 'integration',
        metadata: { createdBy: tenant.adminId, userId },
      });
      bound.push(key.id);
    }
    const targets = [
      alice,
      adminEmail ?? '',
      ownerEmail ?? '',
      svcShapedHuman,
      serviceWithoutPrefix,
    ];
    const before = new Map<string, unknown>();
    for (const target of targets) before.set(target, await userSnapshot(tenant.tenantId, target));
    const eventsBefore = new Map<string, unknown>();
    for (const target of targets) {
      eventsBefore.set(target, await changeEvents(tenant.tenantId, target));
    }
    const statusBefore = (await logRecords(STATUS_EVENT, tenant.tenantId)).length;
    const deletedBefore = (
      await logRecords('catalog.audit.service_account_deleted', tenant.tenantId)
    ).length;

    const unknown = await failureOf(() =>
      deleter().identity.serviceAccounts.delete(
        { params: { user: `svc-unknown-${suffix}` } },
        { context: context(tenant) },
      ),
    );
    expect(unknown['code']).toBe('CATALOG_NOT_FOUND');

    for (const target of targets) {
      // WHEN an admin deletes the human (or look-alike), THEN the answer equals the unknown id's.
      const failure = await failureOf(() =>
        deleter().identity.serviceAccounts.delete(
          { params: { user: target } },
          { context: context(tenant) },
        ),
      );
      expect(failure).toEqual(unknown);
      // AND the row and its status are intact.
      expect(await userSnapshot(tenant.tenantId, target)).toEqual(before.get(target));
      expect(await changeEvents(tenant.tenantId, target)).toEqual(eventsBefore.get(target));
    }

    // AND no credential is revoked and no event is emitted.
    for (const id of bound) expect(await revocationCount(tenant.tenantId, id)).toBe(0);
    expect(await nonRevokedBound(tenant.tenantId, alice)).toHaveLength(1);
    expect((await logRecords(STATUS_EVENT, tenant.tenantId)).length).toBe(statusBefore);
    expect(
      (await logRecords('catalog.audit.service_account_deleted', tenant.tenantId)).length,
    ).toBe(deletedBefore);
  }, 120_000);

  // Task 10.8: the per-tenant cap of 50 service accounts (Resolved decision Q56; design D6).
  // Production symbol expected: `createIdentityRouter` counts the tenant's `_user` entities with
  // `accountKind: "service"` under a per-tenant advisory lock and refuses beyond the cap (default
  // 50, option `serviceAccountCap?: number` fed from `Config.serviceAccountCap`) with
  // `CATALOG_VALIDATION_FAILED`.
  async function serviceAccountCount(tenantId: string): Promise<number> {
    return await withTenantTransaction(appPool, { tenantId }, async (db) => {
      const result = await db.query<{ n: string }>(
        `select count(*)::text as n
           from catalog_entity e
           join catalog_blueprint b on b.tenant_id = e.tenant_id and b.id = e.blueprint_id
          where e.tenant_id = $1 and b.identifier = '_user'
            and e.spec_properties ->> 'accountKind' = 'service'`,
        [tenantId],
      );
      return Number(result.rows[0]?.n);
    });
  }

  /** Seeds service accounts (and one human, never counted) directly, with no credential. */
  async function seedServiceAccounts(tenant: Tenant, count: number): Promise<void> {
    const seeder = createUserSyncAdapter({
      userSync: createUserSync({ pool: appPool, authz: cerbos }),
    });
    const write = async (identifier: string, service: boolean): Promise<void> => {
      await seeder.writeUserChange({
        tenantId: tenant.tenantId,
        email: identifier,
        name: identifier,
        portRole: 'member',
        change: 'created_active',
        userId: identifier,
        ...(service ? { accountKind: 'service' as const } : {}),
        principal: { kind: 'admin', id: tenant.adminId },
        onBehalfOf: { type: 'user', id: tenant.adminId },
      });
    };
    // The first write creates the tenant's `_user` blueprint, so it runs alone.
    await write('seed-human@example.test', false);
    for (let start = 0; start < count; start += 10) {
      await Promise.all(
        Array.from({ length: Math.min(10, count - start) }, (_, offset) =>
          write(`svc-seed-${String(start + offset)}`, true),
        ),
      );
    }
  }

  it('The per-tenant service-account cap holds: with 50 seeded the 51st is refused with CATALOG_VALIDATION_FAILED, nothing is created and the count stays 50', async () => {
    const tenant = await freshTenant();
    await seedServiceAccounts(tenant, 50);
    expect(await serviceAccountCount(tenant.tenantId)).toBe(50);
    const identifier = `svc-over-${randomUUID().slice(0, 8)}`;
    const statusEventsBefore = (await logRecords(STATUS_EVENT, tenant.tenantId)).length;

    await expect(
      creator().identity.serviceAccounts.create(
        { body: { identifier } },
        { context: context(tenant) },
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });

    expect(await userRows(tenant.tenantId, identifier)).toHaveLength(0);
    expect(await changeEvents(tenant.tenantId, identifier)).toHaveLength(0);
    expect(await keyRows(tenant.tenantId)).toEqual([]);
    expect(await logRecords(CREATED_EVENT, tenant.tenantId)).toHaveLength(0);
    expect((await logRecords(STATUS_EVENT, tenant.tenantId)).length).toBe(statusEventsBefore);
    expect(await serviceAccountCount(tenant.tenantId)).toBe(50);
  }, 180_000);

  it('The per-tenant service-account cap holds: two concurrent creates at 49 yield exactly one success and the tenant holds 50', async () => {
    const tenant = await freshTenant();
    await seedServiceAccounts(tenant, 49);
    expect(await serviceAccountCount(tenant.tenantId)).toBe(49);
    const identifiers = [
      `svc-race-a-${randomUUID().slice(0, 8)}`,
      `svc-race-b-${randomUUID().slice(0, 8)}`,
    ];

    const outcomes = await Promise.allSettled(
      identifiers.map((identifier) =>
        creator().identity.serviceAccounts.create(
          { body: { identifier } },
          { context: context(tenant) },
        ),
      ),
    );

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });
    expect(await serviceAccountCount(tenant.tenantId)).toBe(50);
    expect(await keyRows(tenant.tenantId)).toHaveLength(1);
    expect(await logRecords(CREATED_EVENT, tenant.tenantId)).toHaveLength(1);
  }, 180_000);

  // Task 14.17: the key issued by `identity.serviceAccounts.create` counts against the credential
  // cap (Resolved decisions Q56 and Q138; 9.5d), under the `credential-cap:<tenant>` advisory
  // lock of `identity.credentials.create`. Production symbol expected: `createServiceAccount`
  // (`./service-accounts.js`) takes `credentialCap?: number` (default `DEFAULT_CREDENTIAL_CAP`),
  // which `createIdentityRouter` feeds from `options.credentialCap`; beyond it the creation fails
  // with `CredentialConflictError` (`CATALOG_VALIDATION_FAILED`) before anything is written.
  interface CappedClient {
    identity: {
      serviceAccounts: CreatingClient['identity']['serviceAccounts'];
      credentials: {
        create(
          input: { body: { name: string; kind: string } },
          options: { context: Record<string, unknown> },
        ): Promise<{ id: string; secret: string }>;
      };
    };
  }

  function cappedClient(credentialCap: number): CappedClient {
    return createRouterClient(
      createIdentityRouter({
        auth,
        authz: cerbos,
        authRepository: createAuthRepository(authPool),
        withUserLock: createWithUserLock(authPool),
        emailGate: createEmailTenantGate({
          disabledTenantIds: [],
          capStore: createInMemoryEmailCapStore({
            tenant: { max: 1000, windowSeconds: 3600 },
            recipient: { max: 1000, windowSeconds: 86_400 },
          }),
          sender,
          recipientKeySecret: 'gate-wiring-test-only-secret-0123456789-abcdef',
        }),
        appPool,
        userSync: createUserSyncAdapter({
          userSync: createUserSync({ pool: appPool, authz: cerbos }),
        }),
        credentialCap,
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );
  }

  /** Seeds plain organization keys (bound to no service account) and returns their ids. */
  async function seedKeys(tenant: Tenant, count: number): Promise<string[]> {
    return await Promise.all(
      Array.from({ length: count }, async (_, index) => {
        const created = await createMachineCredential(auth, {
          userId: tenant.adminId,
          organizationId: tenant.tenantId,
          name: `seed-${String(index)}`,
          actorKind: 'integration',
          metadata: { createdBy: tenant.adminId },
        });
        return created.id;
      }),
    );
  }

  it('The key of a service account counts against the credential cap: a tenant at the cap refuses the creation with CATALOG_VALIDATION_FAILED and creates neither a _user nor a key, and a revoked key does not count', async () => {
    const cap = 3;
    const tenant = await freshTenant();
    const ids = await seedKeys(tenant, cap);
    const identifier = `svc-capped-${randomUUID().slice(0, 8)}`;
    const statusEventsBefore = (await logRecords(STATUS_EVENT, tenant.tenantId)).length;

    await expect(
      cappedClient(cap).identity.serviceAccounts.create(
        { body: { identifier } },
        { context: context(tenant) },
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });

    expect(await userRows(tenant.tenantId, identifier)).toHaveLength(0);
    expect(await changeEvents(tenant.tenantId, identifier)).toHaveLength(0);
    expect(await keyRows(tenant.tenantId)).toHaveLength(cap);
    expect(await logRecords(CREATED_EVENT, tenant.tenantId)).toHaveLength(0);
    expect((await logRecords(STATUS_EVENT, tenant.tenantId)).length).toBe(statusEventsBefore);

    // A revoked key does not count: revoking one frees exactly one place.
    await revokeMachineCredential(auth, {
      userId: tenant.adminId,
      id: ids[0] ?? '',
      pool: appPool,
      tenantId: tenant.tenantId,
    });
    const created = await cappedClient(cap).identity.serviceAccounts.create(
      { body: { identifier } },
      { context: context(tenant) },
    );
    expect(created.clientId).toEqual(expect.any(String));
    expect(await userRows(tenant.tenantId, identifier)).toHaveLength(1);
    expect(await keyRows(tenant.tenantId)).toHaveLength(cap + 1);

    // The tenant is at the cap again, so the next creation is refused.
    const another = `svc-capped-more-${randomUUID().slice(0, 8)}`;
    await expect(
      cappedClient(cap).identity.serviceAccounts.create(
        { body: { identifier: another } },
        { context: context(tenant) },
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });
    expect(await userRows(tenant.tenantId, another)).toHaveLength(0);
    expect(await keyRows(tenant.tenantId)).toHaveLength(cap + 1);
  }, 180_000);

  it('A concurrent credentials.create and serviceAccounts.create at one below the cap yield exactly one success under the same lock', async () => {
    const cap = 4;
    const tenant = await freshTenant();
    await seedKeys(tenant, cap - 1);
    const identifier = `svc-race-cap-${randomUUID().slice(0, 8)}`;
    const api = cappedClient(cap);

    const outcomes = await Promise.allSettled([
      api.identity.credentials.create(
        { body: { name: 'Racing credential', kind: 'integration' } },
        { context: context(tenant) },
      ),
      api.identity.serviceAccounts.create({ body: { identifier } }, { context: context(tenant) }),
    ]);

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });
    expect(await keyRows(tenant.tenantId)).toHaveLength(cap);
    // A refused service account leaves no _user behind; an accepted one has exactly its key.
    const accountCreated = (await userRows(tenant.tenantId, identifier)).length;
    expect(accountCreated).toBe(outcomes[1].status === 'fulfilled' ? 1 : 0);
  }, 180_000);
});

/**
 * Task 16.11b of openspec/changes/043-identity-lifecycle-and-org-admin (Resolved decision Q147;
 * the security review's LOW-2): `identity.serviceAccounts.create` never takes a second pooled
 * connection while its transaction holds an advisory lock.
 *
 * Scenario: GIVEN a `tayzu_app` pool built for the test with a small `max`, WHEN more concurrent
 * `identity.serviceAccounts.create` calls of one tenant than the pool has connections are made,
 * THEN all of them complete within the cap, none with a statement timeout or a pool timeout.
 *
 * ## Production symbols expected
 *
 * None new: `createServiceAccount` (`./service-accounts.js`) runs `readRevokedIds` (and the entity
 * and key steps that need the pool) on the client that holds the lock.
 *
 * ## Why this fails right now
 *
 * `readRevokedIds(args.appPool, …)` asks the pool for a second connection while every connection
 * is held by a creation waiting for the cap lock, so nobody progresses until the checkout
 * timeout rejects the calls.
 */
describe('identity.serviceAccounts.create under a small pool (task 16.11b)', () => {
  const POOL_MAX = 3;
  const CONCURRENT = 8;
  let smallPool: Pool;
  let authPool: Pool;
  let auth: AuthInstance;
  let cerbos: CerbosClient;
  let userSync: ReturnType<typeof createUserSyncAdapter>;

  beforeAll(async () => {
    const pools = await harnessPools();
    authPool = pools.authPool;
    await runMigrations(authPool);
    cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    userSync = createUserSyncAdapter({
      userSync: createUserSync({ pool: pools.appPool, authz: cerbos }),
    });
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync,
    });
    const { Pool: PoolConstructor } = await import('pg');
    smallPool = new PoolConstructor({
      connectionString: process.env['DATABASE_URL'],
      max: POOL_MAX,
      // A stalled checkout rejects instead of hanging the file.
      connectionTimeoutMillis: 15_000,
    });
    smallPool.on('connect', (client) => {
      void client.query('SET ROLE tayzu_app').catch(() => undefined);
    });
  }, 60_000);

  afterAll(async () => {
    await smallPool.end();
  }, 60_000);

  it('more concurrent serviceAccounts.create calls of one tenant than the pool has connections all complete with no statement timeout', async () => {
    const id = randomUUID();
    const api = auth.api as OrganizationSurface;
    const owner = await createAdminUser(auth, {
      name: 'Pool Owner',
      email: `sa-pool-owner-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    const org = await api.createOrganization({
      body: { name: 'Pool Org', slug: `sa-pool-${id}`, userId: owner.userId },
    });
    const admin = await createAdminUser(auth, {
      name: 'Pool Admin',
      email: `sa-pool-admin-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    await api.addMember({ body: { userId: admin.userId, organizationId: org.id, role: 'admin' } });

    const client = createRouterClient(
      createIdentityRouter({
        auth,
        authz: cerbos,
        authRepository: createAuthRepository(authPool),
        withUserLock: createWithUserLock(authPool),
        appPool: smallPool,
        userSync,
      }),
      { context: (raw: Record<string, unknown>) => raw },
    ) as unknown as {
      identity: {
        serviceAccounts: {
          create(
            input: { body: { identifier: string } },
            options: { context: Record<string, unknown> },
          ): Promise<CreatedServiceAccount>;
        };
      };
    };
    const context = {
      tenantId: org.id,
      actor: { type: 'user', id: admin.userId },
      principal: { roles: ['admin'] },
    };

    const started = Date.now();
    const outcomes = await Promise.allSettled(
      Array.from({ length: CONCURRENT }, (_, i) =>
        client.identity.serviceAccounts.create(
          { body: { identifier: `svc-pool-${String(i)}` } },
          { context },
        ),
      ),
    );
    const elapsedMs = Date.now() - started;

    const failures = outcomes.flatMap((o) =>
      o.status === 'rejected' ? [(o.reason as Error).message] : [],
    );
    expect(failures).toEqual([]);
    expect(outcomes.every((o) => o.status === 'fulfilled')).toBe(true);
    expect(elapsedMs).toBeLessThan(10_000);
    const keys = await authPool.query('select id from auth.apikey where reference_id = $1', [
      org.id,
    ]);
    expect(keys.rows).toHaveLength(CONCURRENT);
  }, 90_000);
});

/**
 * Task 16.12j of openspec/changes/043-identity-lifecycle-and-org-admin (Resolved decision Q148):
 * identity mutations that take an advisory lock are bounded per process by an in-memory semaphore
 * of 2, taken before a pooled connection.
 *
 * Scenario: GIVEN one small `tayzu_app` pool shared by the router and the user-sync adapter (as in
 * production), WHEN more concurrent `identity.serviceAccounts.create` calls of one tenant than the
 * pool has connections are made, THEN all of them complete within the cap, none with a statement
 * timeout or a pool timeout.
 *
 * ## Production symbols expected
 *
 * None new in the public surface: a process-wide semaphore of 2 (for example
 * `./mutation-semaphore.js`) wraps `credentials.create`, `rotate`, `revoke` and
 * `serviceAccounts.create`, `delete` in `createIdentityRouter`, before `appPool` is asked for a
 * connection.
 *
 * ## Why this fails right now
 *
 * Every in-flight creation holds a pooled connection waiting for the cap lock, and the holder
 * needs another one from the same pool for the `_user` write, so nobody progresses until the
 * checkout timeout rejects the calls.
 */
describe('identity.serviceAccounts.create under a small pool shared with the user-sync adapter (task 16.12j, Q148)', () => {
  const POOL_MAX = 3;
  const CONCURRENT = 8;
  let sharedPool: Pool;
  let authPool: Pool;
  let auth: AuthInstance;
  let cerbos: CerbosClient;
  let userSync: ReturnType<typeof createUserSyncAdapter>;

  beforeAll(async () => {
    const pools = await harnessPools();
    authPool = pools.authPool;
    await runMigrations(authPool);
    cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    const { Pool: PoolConstructor } = await import('pg');
    sharedPool = new PoolConstructor({
      connectionString: process.env['DATABASE_URL'],
      max: POOL_MAX,
      connectionTimeoutMillis: 15_000,
    });
    sharedPool.on('connect', (client) => {
      void client.query('SET ROLE tayzu_app').catch(() => undefined);
    });
    userSync = createUserSyncAdapter({
      userSync: createUserSync({ pool: sharedPool, authz: cerbos }),
    });
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync,
    });
  }, 60_000);

  afterAll(async () => {
    await sharedPool.end();
  }, 60_000);

  it('more concurrent serviceAccounts.create calls of one tenant than the shared pool has connections all complete with no statement timeout', async () => {
    const id = randomUUID();
    const api = auth.api as OrganizationSurface;
    const owner = await createAdminUser(auth, {
      name: 'Bound Owner',
      email: `sa-bound-owner-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    const org = await api.createOrganization({
      body: { name: 'Bound Org', slug: `sa-bound-${id}`, userId: owner.userId },
    });
    const admin = await createAdminUser(auth, {
      name: 'Bound Admin',
      email: `sa-bound-admin-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    await api.addMember({ body: { userId: admin.userId, organizationId: org.id, role: 'admin' } });

    const client = createRouterClient(
      createIdentityRouter({
        auth,
        authz: cerbos,
        authRepository: createAuthRepository(authPool),
        withUserLock: createWithUserLock(authPool),
        appPool: sharedPool,
        userSync,
      }),
      { context: (raw: Record<string, unknown>) => raw },
    ) as unknown as {
      identity: {
        serviceAccounts: {
          create(
            input: { body: { identifier: string } },
            options: { context: Record<string, unknown> },
          ): Promise<CreatedServiceAccount>;
        };
      };
    };
    const context = {
      tenantId: org.id,
      actor: { type: 'user', id: admin.userId },
      principal: { roles: ['admin'] },
    };

    const started = Date.now();
    const outcomes = await Promise.allSettled(
      Array.from({ length: CONCURRENT }, (_, i) =>
        client.identity.serviceAccounts.create(
          { body: { identifier: `svc-bound-${String(i)}` } },
          { context },
        ),
      ),
    );
    const elapsedMs = Date.now() - started;

    const failures = outcomes.flatMap((o) =>
      o.status === 'rejected' ? [(o.reason as Error).message] : [],
    );
    expect(failures).toEqual([]);
    expect(outcomes.every((o) => o.status === 'fulfilled')).toBe(true);
    expect(elapsedMs).toBeLessThan(10_000);
    const keys = await authPool.query('select id from auth.apikey where reference_id = $1', [
      org.id,
    ]);
    expect(keys.rows).toHaveLength(CONCURRENT);
  }, 90_000);
});
