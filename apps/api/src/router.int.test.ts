/**
 * Task 14.1 of openspec/changes/043-identity-lifecycle-and-org-admin (design D10
 * "API contract"; Resolved decisions Q31 and Q45).
 *
 * Task 14.1 Verify (the part of this file): "`router.int.test.ts` calls each
 * procedure once on its happy path through `createRouterClient` (the route list
 * of the generated document is 14.1c's case, because 14.1c creates the
 * generator)". The merged router is `merged-router.int.test.ts`.
 *
 * D10: the thirteen oRPC procedures of the identity router each declare
 * `.route({ method, path, spec, inputStructure: 'detailed' })`, so a procedure
 * reads `input.params`, `input.query` and `input.body`. The three existing
 * procedures (`create`, `linkSsoAccount`, `unlinkSsoAccount`) are addressed by
 * the `{user}` identifier (the `_user` entity identifier, an email or `svc-...`)
 * and no longer take a Better Auth `userId` (Q31).
 *
 * ## Harness
 *
 * Real Better Auth with the Q30 adapter, a real Cerbos container and a real
 * PostgreSQL 16. Every test uses a fresh organization (the tenant) and its
 * admin, minted through `bootstrapTestTenant`; the admin's session cookie is the
 * `Headers` the context carries for `invite` (D4). The client is called with the
 * input shape of `inputStructure: 'detailed'`: `{ params, query, body }`.
 *
 * ## Production symbols expected
 *
 * - `createIdentityRouter` (`./identity-router.js`): every one of the thirteen
 *   procedures reads the detailed input shape, and the three existing ones
 *   address their target as `params.user`.
 * - The router options that already exist (`emailGate`, `invitationLinkBaseUrl`,
 *   `appPool`, `userSync`) are unchanged.
 *
 * ## Why this fails right now
 *
 * The procedures read a flat input (`{ email, name, role }`, `{ user, subject }`),
 * so a call carrying `{ body }` or `{ params }` is rejected with
 * `CATALOG_VALIDATION_FAILED` (assertion/rejection failures, no missing module).
 */
// Load-bearing import order (design D1): the telemetry harness registers
// before anything that loads `@tayzu/auth` creates its logger.
import './__fixtures__/link-telemetry.js';
import { randomInt, randomUUID } from 'node:crypto';

import { createRouterClient } from '@orpc/server';
import { authSchema, createAuth, createRecordingEmailSender, type AuthInstance } from '@tayzu/auth';
import { createCerbosClient, type CerbosClient } from '@tayzu/authz';
import { createUserSync } from '@tayzu/catalog';
import { runMigrations } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import {
  bootstrapTestTenant,
  testAppPool,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createIdentityRouter } from './identity-router.js';
import { createAuthRepository } from './identity/auth-repository.js';
import { createEmailTenantGate } from './identity/email-tenant-gate.js';
import { createInMemoryEmailCapStore } from './identity/invitation-caps.js';
import { createWithUserLock } from './identity/user-lock.js';
import { createUserSyncAdapter } from './identity/user-sync-adapter.js';

const LINK_BASE_URL = 'https://app.tayzu.test';
const SSO_PROVIDER_ID = 'visma-connect';

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

/** The detailed input shape every identity procedure reads (D10). */
interface DetailedInput {
  readonly params?: Record<string, string>;
  readonly query?: Record<string, string>;
  readonly body?: Record<string, unknown>;
}

type Call<Output = unknown> = (
  input: DetailedInput,
  options: { context: Record<string, unknown> },
) => Promise<Output>;

interface IdentityClient {
  readonly identity: {
    readonly users: {
      readonly create: Call<{ userId: string; email: string; temporaryPassword: string }>;
      readonly invite: Call<{ invitationId: string }>;
      readonly cancelInvitation: Call;
      readonly resendInvitation: Call<{ invitationId: string }>;
      readonly setStatus: Call;
      readonly linkSsoAccount: Call;
      readonly unlinkSsoAccount: Call;
    };
    readonly serviceAccounts: {
      readonly create: Call<{ clientId: string; clientSecret: string }>;
      readonly delete: Call;
    };
    readonly credentials: {
      readonly list: Call<{
        credentials: readonly { id: string; enabled: boolean }[];
        truncated: boolean;
      }>;
      readonly create: Call<{ id: string; secret: string }>;
      readonly rotate: Call<{ id: string; secret: string }>;
      readonly revoke: Call;
    };
  };
}

interface Tenant {
  readonly tenantId: string;
  readonly adminId: string;
  readonly cookie: string;
}

describe('identity router: each procedure on its happy path (task 14.1, design D10)', () => {
  let appPool: Pool;
  let authPool: Pool;
  let auth: AuthInstance;
  let cerbos: CerbosClient;
  let userSync: ReturnType<typeof createUserSync>;
  let sender: ReturnType<typeof createRecordingEmailSender>;
  let client: IdentityClient;

  beforeAll(async () => {
    const pools = await harnessPools();
    appPool = pools.appPool;
    authPool = pools.authPool;
    await runMigrations(authPool);
    cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    userSync = createUserSync({ pool: appPool, authz: cerbos });
    const adapter = createUserSyncAdapter({ userSync });
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync: adapter,
    });
    sender = createRecordingEmailSender();
    const capStore = createInMemoryEmailCapStore({
      tenant: { max: 1000, windowSeconds: 3600 },
      recipient: { max: 1000, windowSeconds: 86_400 },
    });
    const routerClient: unknown = createRouterClient(
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
        invitationLinkBaseUrl: LINK_BASE_URL,
        appPool,
        userSync: adapter,
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );
    client = routerClient as IdentityClient;
  }, 60_000);

  async function freshTenant(): Promise<Tenant> {
    const id = randomUUID();
    const tenant = await bootstrapTestTenant(auth, {
      pool: testAppPool(),
      name: 'Router Admin',
      email: `router-admin-${id}@example.test`,
      password: TEST_PASSWORD,
      organizationName: 'Router Org',
      organizationSlug: `router-${id}`,
      ip: randomIp(),
    });
    return { tenantId: tenant.organizationId, adminId: tenant.userId, cookie: tenant.cookie };
  }

  function context(tenant: Tenant): { context: Record<string, unknown> } {
    const headers = new Headers({ cookie: tenant.cookie, 'x-forwarded-for': randomIp() });
    return {
      context: {
        tenantId: tenant.tenantId,
        actor: { type: 'user', id: tenant.adminId },
        principal: { roles: ['admin'] },
        __requestHeaders: headers,
        __stepUpHeaders: headers,
      },
    };
  }

  async function createMember(tenant: Tenant): Promise<string> {
    const email = `member-${randomUUID()}@example.test`;
    await client.identity.users.create(
      { body: { email, name: 'Router Member', role: 'member' } },
      context(tenant),
    );
    return email;
  }

  async function invite(tenant: Tenant): Promise<{ email: string; invitationId: string }> {
    const email = `invitee-${randomUUID()}@example.test`;
    const { invitationId } = await client.identity.users.invite(
      { body: { email, role: 'member' } },
      context(tenant),
    );
    return { email, invitationId };
  }

  it('identity.users.create creates the user from { body } and returns its temporary password', async () => {
    const tenant = await freshTenant();
    const email = `created-${randomUUID()}@example.test`;

    const created = await client.identity.users.create(
      { body: { email, name: 'Created', role: 'member' } },
      context(tenant),
    );

    expect(created.email).toBe(email);
    expect(created.temporaryPassword.length).toBeGreaterThan(0);
    expect((await userSync.getUser({ tenantId: tenant.tenantId, email }))?.status).toBe('Active');
  }, 60_000);

  it('identity.users.invite invites from { body } and sends one email', async () => {
    const tenant = await freshTenant();

    const { email, invitationId } = await invite(tenant);

    expect(invitationId.length).toBeGreaterThan(0);
    expect(sender.sent.filter((message) => message.to === email)).toHaveLength(1);
  }, 60_000);

  it('identity.users.cancelInvitation cancels the invitation addressed by params.invitation', async () => {
    const tenant = await freshTenant();
    const { invitationId } = await invite(tenant);

    await client.identity.users.cancelInvitation(
      { params: { invitation: invitationId } },
      context(tenant),
    );

    const row = await authPool.query<{ status: string }>(
      'select status from auth.invitation where id = $1',
      [invitationId],
    );
    expect(row.rows[0]?.status).toBe('canceled');
  }, 60_000);

  it('identity.users.resendInvitation resends the invitation addressed by params.invitation', async () => {
    const tenant = await freshTenant();
    const { email, invitationId } = await invite(tenant);

    const resent = await client.identity.users.resendInvitation(
      { params: { invitation: invitationId } },
      context(tenant),
    );

    expect(resent.invitationId).toBe(invitationId);
    expect(sender.sent.filter((message) => message.to === email)).toHaveLength(2);
  }, 60_000);

  it('identity.users.setStatus disables the user addressed by params.user from { body }', async () => {
    const tenant = await freshTenant();
    const email = await createMember(tenant);

    await client.identity.users.setStatus(
      { params: { user: email }, body: { status: 'Disabled' } },
      context(tenant),
    );

    expect((await userSync.getUser({ tenantId: tenant.tenantId, email }))?.status).toBe('Disabled');
  }, 60_000);

  it('identity.users.linkSsoAccount links { body.subject } to the user addressed by params.user', async () => {
    const tenant = await freshTenant();
    const email = await createMember(tenant);
    const subject = `sub-${randomUUID()}`;

    await client.identity.users.linkSsoAccount(
      { params: { user: email }, body: { subject } },
      context(tenant),
    );

    const rows = await authPool.query(
      'select 1 from auth.account where provider_id = $1 and account_id = $2',
      [SSO_PROVIDER_ID, subject],
    );
    expect(rows.rows).toHaveLength(1);
  }, 60_000);

  it('identity.users.unlinkSsoAccount unlinks the SSO account of the user addressed by params.user', async () => {
    const tenant = await freshTenant();
    const email = await createMember(tenant);
    const subject = `sub-${randomUUID()}`;
    await client.identity.users.linkSsoAccount(
      { params: { user: email }, body: { subject } },
      context(tenant),
    );

    await client.identity.users.unlinkSsoAccount({ params: { user: email } }, context(tenant));

    const rows = await authPool.query(
      'select 1 from auth.account where provider_id = $1 and account_id = $2',
      [SSO_PROVIDER_ID, subject],
    );
    expect(rows.rows).toHaveLength(0);
  }, 60_000);

  it('identity.serviceAccounts.create creates the service account from { body.identifier }', async () => {
    const tenant = await freshTenant();
    const identifier = `svc-router-${randomUUID().slice(0, 8)}`;

    const created = await client.identity.serviceAccounts.create(
      { body: { identifier } },
      context(tenant),
    );

    expect(created.clientId.length).toBeGreaterThan(0);
    expect(created.clientSecret.length).toBeGreaterThan(0);
    expect((await userSync.getUser({ tenantId: tenant.tenantId, email: identifier }))?.status).toBe(
      'Active',
    );
  }, 60_000);

  it('identity.serviceAccounts.delete deletes the service account addressed by params.user', async () => {
    const tenant = await freshTenant();
    const identifier = `svc-router-${randomUUID().slice(0, 8)}`;
    await client.identity.serviceAccounts.create({ body: { identifier } }, context(tenant));

    await client.identity.serviceAccounts.delete({ params: { user: identifier } }, context(tenant));

    expect(await userSync.getUser({ tenantId: tenant.tenantId, email: identifier })).toBeNull();
  }, 60_000);

  it('identity.credentials.create creates a credential from { body } and returns its secret once', async () => {
    const tenant = await freshTenant();

    const created = await client.identity.credentials.create(
      { body: { name: 'router-key', kind: 'integration' } },
      context(tenant),
    );

    expect(created.id.length).toBeGreaterThan(0);
    expect(created.secret.length).toBeGreaterThan(0);
  }, 60_000);

  it('identity.credentials.list lists the tenant credentials with { query }', async () => {
    const tenant = await freshTenant();
    const created = await client.identity.credentials.create(
      { body: { name: 'router-list', kind: 'integration' } },
      context(tenant),
    );

    const listed = await client.identity.credentials.list({ query: {} }, context(tenant));

    expect(listed.credentials.map((credential) => credential.id)).toContain(created.id);
    expect(listed.truncated).toBe(false);
  }, 60_000);

  it('identity.credentials.rotate rotates the credential addressed by params.credential', async () => {
    const tenant = await freshTenant();
    const created = await client.identity.credentials.create(
      { body: { name: 'router-rotate', kind: 'integration' } },
      context(tenant),
    );

    const rotated = await client.identity.credentials.rotate(
      { params: { credential: created.id } },
      context(tenant),
    );

    expect(rotated.id).not.toBe(created.id);
    expect(rotated.secret.length).toBeGreaterThan(0);
  }, 60_000);

  it('identity.credentials.revoke revokes the credential addressed by params.credential', async () => {
    const tenant = await freshTenant();
    const created = await client.identity.credentials.create(
      { body: { name: 'router-revoke', kind: 'integration' } },
      context(tenant),
    );

    await client.identity.credentials.revoke(
      { params: { credential: created.id } },
      context(tenant),
    );

    const listed = await client.identity.credentials.list({ query: {} }, context(tenant));
    const view = listed.credentials.find((credential) => credential.id === created.id);
    expect(view?.enabled).toBe(false);
  }, 60_000);
});
