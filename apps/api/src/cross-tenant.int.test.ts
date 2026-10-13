/**
 * Task 12.1 of openspec/changes/043-identity-lifecycle-and-org-admin
 * (cross-tenant matrix, in process; design D4 and D10 "Input contract",
 * SEC03/SEC12; the HTTP twin is task 14.8).
 *
 * Task 12.1 Verify: "an invitation created by `t1`'s admin has
 * `organizationId = t1`, and a body with an organization or tenant field is
 * rejected."
 *
 * Spec basis: "Host-supplied context" (root CLAUDE.md: `tenantId` comes only
 * from the trusted host, never from input) and the "Invitation lifecycle"
 * requirement (an invitation is created for the caller's tenant).
 *
 * ## Harness
 *
 * Two tenants (fresh organizations, each with a real admin session), a real
 * Better Auth instance, a real Cerbos container, the recording `EmailSender`
 * behind the real gate. This file is extended by tasks 12.2 to 12.9.
 *
 * ## Production symbols expected
 *
 * None new for the first test (`identity.users.invite` exists). The second
 * test needs `parseInviteInput` in `./identity-router.ts` to reject any field
 * other than `email` and `role` with `CATALOG_VALIDATION_FAILED` (it ignores
 * them today).
 */
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
import { createAuthRepository } from './identity/auth-repository.js';
import { createEmailTenantGate } from './identity/email-tenant-gate.js';
import { createInMemoryEmailCapStore } from './identity/invitation-caps.js';
import { createUserSyncAdapter } from './identity/user-sync-adapter.js';
import { createWithUserLock } from './identity/user-lock.js';
import { createIdentityRouter } from './identity-router.js';

const LINK_BASE_URL = 'https://app.tayzu.test';

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

interface Tenant {
  readonly tenantId: string;
  readonly adminId: string;
  readonly cookie: string;
}

interface InvitationRow {
  readonly id: string;
  readonly organization_id: string;
  readonly status: string;
}

describe('cross-tenant matrix (tasks 12.x)', () => {
  let authPool: Pool;
  let auth: AuthInstance;
  let cerbos: CerbosClient;
  let sender: ReturnType<typeof createRecordingEmailSender>;
  let client: ReturnType<
    typeof createRouterClient<ReturnType<typeof createIdentityRouter>, Record<string, unknown>>
  >;

  beforeAll(async () => {
    const pools = await harnessPools();
    authPool = pools.authPool;
    await runMigrations(authPool);
    cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync: createUserSyncAdapter({
        userSync: createUserSync({ pool: pools.appPool, authz: cerbos }),
      }),
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
        emailGate: createEmailTenantGate({ disabledTenantIds: [], capStore, sender }),
        invitationLinkBaseUrl: LINK_BASE_URL,
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );
  }, 60_000);

  async function freshTenant(label: string): Promise<Tenant> {
    const id = randomUUID();
    const t = await bootstrapTestTenant(auth, {
      pool: testAppPool(),
      name: `${label} Admin`,
      email: `${label}-admin-${id}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `${label} Org`,
      organizationSlug: `${label}-${id}`,
      ip: randomIp(),
    });
    return { tenantId: t.organizationId, adminId: t.userId, cookie: t.cookie };
  }

  function sessionContext(tenant: Tenant): Record<string, unknown> {
    const headers = new Headers({ cookie: tenant.cookie, 'x-forwarded-for': randomIp() });
    return {
      tenantId: tenant.tenantId,
      actor: { type: 'user', id: tenant.adminId },
      principal: { roles: ['admin'] },
      __requestHeaders: headers,
      __stepUpHeaders: headers,
    };
  }

  async function invitationsFor(email: string): Promise<readonly InvitationRow[]> {
    const result = await authPool.query<InvitationRow>(
      'select id, organization_id, status from auth.invitation where email = $1',
      [email],
    );
    return result.rows;
  }

  function emailsTo(email: string) {
    return sender.sent.filter((message) => message.to === email);
  }

  it('identity.users.invite creates the invitation only in the host tenant: t1 admin invites, the invitation has organizationId t1 and none exists in t2', async () => {
    const t1 = await freshTenant('t1');
    const t2 = await freshTenant('t2');
    const email = `cross-invite-${randomUUID()}@example.test`;

    const { invitationId } = await client.identity.users.invite(
      { email, role: 'member' },
      { context: sessionContext(t1) },
    );

    const rows = await invitationsFor(email);
    expect(rows, 'exactly one invitation was created').toHaveLength(1);
    expect(rows[0]?.id).toBe(invitationId);
    expect(rows[0]?.organization_id).toBe(t1.tenantId);
    expect(
      rows.filter((row) => row.organization_id === t2.tenantId),
      'nothing in t2',
    ).toEqual([]);
  }, 90_000);

  it.each([['organizationId'], ['organization'], ['tenantId'], ['tenant'], ['organization_id']])(
    'identity.users.invite rejects a body that names a tenant (field %s) with CATALOG_VALIDATION_FAILED and creates nothing in either tenant',
    async (field) => {
      const t1 = await freshTenant('t1');
      const t2 = await freshTenant('t2');
      const email = `cross-named-${randomUUID()}@example.test`;

      const thrown: unknown = await client.identity.users
        .invite({ email, role: 'member', [field]: t2.tenantId }, { context: sessionContext(t1) })
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(thrown, 'the call must be rejected').toBeDefined();
      expect((thrown as { code?: unknown }).code).toBe('CATALOG_VALIDATION_FAILED');
      expect(await invitationsFor(email), 'no invitation in any tenant').toEqual([]);
      expect(emailsTo(email), 'no email').toEqual([]);
    },
    90_000,
  );

  // Task 12.2. Spec: "Another tenant's invitation cannot be cancelled or resent".
  async function invitationSnapshot(id: string): Promise<unknown> {
    const invitation = await authPool.query<Record<string, unknown>>(
      'select * from auth.invitation where id = $1',
      [id],
    );
    const verification = await authPool.query<Record<string, unknown>>(
      'select * from auth.verification where identifier = $1',
      [`invitation-accept:${id}`],
    );
    return { invitation: invitation.rows, verification: verification.rows };
  }

  async function rejectionOf(call: Promise<unknown>): Promise<unknown> {
    const thrown: unknown = await call.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown, 'the call must be rejected').toBeDefined();
    return thrown;
  }

  it.each([['cancelInvitation'], ['resendInvitation']] as const)(
    "Another tenant's invitation cannot be cancelled or resent: %s by t1's admin on a pending invitation of t2 fails with CATALOG_NOT_FOUND like an unknown id, the invitation is unchanged and no email is sent",
    async (operation) => {
      const t1 = await freshTenant('t1');
      const t2 = await freshTenant('t2');
      const email = `cross-${operation.toLowerCase()}-${randomUUID()}@example.test`;
      const created = await client.identity.users.invite(
        { email, role: 'member' },
        { context: sessionContext(t2) },
      );
      const before = await invitationSnapshot(created.invitationId);
      const emailsBefore = emailsTo(email).length;
      expect(emailsBefore, 'the invitation email of t2 was sent once').toBe(1);

      const foreign = await rejectionOf(
        client.identity.users[operation](
          { invitation: created.invitationId },
          { context: sessionContext(t1) },
        ),
      );
      const unknown = await rejectionOf(
        client.identity.users[operation](
          { invitation: randomUUID() },
          { context: sessionContext(t1) },
        ),
      );

      expect((foreign as { code?: unknown }).code).toBe('CATALOG_NOT_FOUND');
      expect((unknown as { code?: unknown }).code).toBe('CATALOG_NOT_FOUND');
      expect((foreign as { message?: unknown }).message, 'same as an unknown id').toBe(
        (unknown as { message?: unknown }).message,
      );
      expect((foreign as { status?: unknown }).status).toBe(
        (unknown as { status?: unknown }).status,
      );
      expect(
        await invitationSnapshot(created.invitationId),
        'invitation and token unchanged',
      ).toEqual(before);
      expect(emailsTo(email).length, 'no email was sent').toBe(emailsBefore);
    },
    90_000,
  );
});
