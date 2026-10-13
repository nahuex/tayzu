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
import {
  authSchema,
  createAuth,
  createRecordingEmailSender,
  exchangeMachineToken,
  type AuthInstance,
} from '@tayzu/auth';
import { createMachineCredential, revokeMachineCredential } from '@tayzu/auth/machine-credentials';
import { createCerbosClient, type CerbosClient } from '@tayzu/authz';
import { createEntityService, createUserSync, type UserSync } from '@tayzu/catalog';
import { runMigrations, withTenantTransaction } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import {
  bootstrapTestTenant,
  createAdminUser,
  signInAdminUser,
  testAppPool,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import {
  digestInvitationToken,
  generateInvitationToken,
} from '../../../packages/auth/src/identity/invitation-token.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createAcceptFlow } from './identity/accept-flow.js';
import { runWithIdentityContext } from './identity/identity-context.js';
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
      { body: { email, role: 'member' } },
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
        .invite(
          { body: { email, role: 'member', [field]: t2.tenantId } },
          { context: sessionContext(t1) },
        )
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
        { body: { email, role: 'member' } },
        { context: sessionContext(t2) },
      );
      const before = await invitationSnapshot(created.invitationId);
      const emailsBefore = emailsTo(email).length;
      expect(emailsBefore, 'the invitation email of t2 was sent once').toBe(1);

      const foreign = await rejectionOf(
        client.identity.users[operation](
          { params: { invitation: created.invitationId } },
          { context: sessionContext(t1) },
        ),
      );
      const unknown = await rejectionOf(
        client.identity.users[operation](
          { params: { invitation: randomUUID() } },
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

/**
 * Task 12.3. Spec: "Targets belong to the caller's tenant" (every Better Auth
 * call is given the host tenant only) and "Invitation acceptance" (the accept
 * route derives the tenant from the invitation record).
 *
 * Verify: "the accept of `t2`'s invitation leaves `t1` without a new member and
 * no cross-tenant write", for a new and for an existing account (with its
 * session). Written against `createAcceptFlow` as it stands; if it already
 * behaves this way these tests pass at once (a regression guard).
 */
describe('cross-tenant matrix: acceptance (task 12.3)', () => {
  const PASSWORD = 'Café-Mañana-Passäphrase-2026!';

  let authPool: Pool;
  let auth: AuthInstance;
  let userSync: UserSync;
  let flow: ReturnType<typeof createAcceptFlow>;

  beforeAll(async () => {
    const pools = await harnessPools();
    authPool = pools.authPool;
    await runMigrations(authPool);
    const cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    userSync = createUserSync({ pool: pools.appPool, authz: cerbos });
    const adapter = createUserSyncAdapter({ userSync });
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync: adapter,
    });
    flow = createAcceptFlow({
      auth,
      authz: cerbos,
      authRepository: createAuthRepository(authPool),
      authPool,
      userSync: adapter,
    });
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

  async function invite(tenant: Tenant, email: string) {
    const api = auth.api as {
      createInvitation(args: {
        body: { email: string; role: 'member'; organizationId: string };
        headers: Headers;
      }): Promise<{ id: string; expiresAt: Date | string }>;
    };
    const invitation = await runWithIdentityContext({ adminId: tenant.adminId }, () =>
      api.createInvitation({
        body: { email, role: 'member', organizationId: tenant.tenantId },
        headers: new Headers({ cookie: tenant.cookie, 'x-forwarded-for': randomIp() }),
      }),
    );
    const token = generateInvitationToken();
    await authPool.query(
      `insert into auth.verification (id, identifier, value, expires_at) values ($1, $2, $3, $4)`,
      [
        randomUUID(),
        `invitation-accept:${invitation.id}`,
        digestInvitationToken(token),
        new Date(invitation.expiresAt),
      ],
    );
    return { invitationId: invitation.id, token };
  }

  /** Everything of a tenant that an acceptance elsewhere must not touch. */
  async function tenantState(tenantId: string, email: string): Promise<unknown> {
    const members = await authPool.query<Record<string, unknown>>(
      'select * from auth.member where organization_id = $1 order by id',
      [tenantId],
    );
    const invitations = await authPool.query<Record<string, unknown>>(
      'select * from auth.invitation where organization_id = $1 order by id',
      [tenantId],
    );
    const catalogUser = await userSync.getUser({ tenantId, email });
    return { members: members.rows, invitations: invitations.rows, catalogUser };
  }

  async function memberships(email: string): Promise<readonly string[]> {
    const result = await authPool.query<{ organization_id: string }>(
      `select m.organization_id from auth.member m join auth."user" u on u.id = m.user_id
       where u.email = $1 order by m.organization_id`,
      [email],
    );
    return result.rows.map((row) => row.organization_id);
  }

  it("The acceptance of t2's invitation by a new account creates the membership only in t2: t1 has no new member and no write", async () => {
    const t1 = await freshTenant('t1');
    const t2 = await freshTenant('t2');
    const email = `cross-accept-new-${randomUUID()}@example.test`;
    const invitation = await invite(t2, email);
    const t1Before = await tenantState(t1.tenantId, email);

    const result = await flow.accept({ ...invitation, password: PASSWORD });

    expect(await memberships(email), 'the only membership is t2').toEqual([t2.tenantId]);
    expect(result.userId).toBeDefined();
    expect(await tenantState(t1.tenantId, email), 't1 is unchanged').toEqual(t1Before);
    expect((await userSync.getUser({ tenantId: t2.tenantId, email }))?.status).toBe('Active');
    expect(await userSync.getUser({ tenantId: t1.tenantId, email }), 'no _user in t1').toBeFalsy();
  }, 90_000);

  it("The acceptance of t2's invitation by an existing account with its session creates the membership only in t2: t1 has no new member and no write", async () => {
    const t1 = await freshTenant('t1');
    const t2 = await freshTenant('t2');
    const home = await freshTenant('home');
    const email = `cross-accept-existing-${randomUUID()}@example.test`;
    const created = await createAdminUser(auth, { name: 'Carol', email, password: TEST_PASSWORD });
    await (
      auth.api as {
        addMember(args: {
          body: { userId: string; role: 'member'; organizationId: string };
        }): Promise<unknown>;
      }
    ).addMember({
      body: { userId: created.userId, role: 'member', organizationId: home.tenantId },
    });
    const signedIn = await signInAdminUser(auth, {
      email,
      password: TEST_PASSWORD,
      ip: randomIp(),
    });
    const row = await authPool.query<{ id: string }>(
      'select id from auth.session where token = $1',
      [signedIn.token],
    );
    const sessionId = row.rows[0]?.id;
    if (sessionId === undefined) throw new Error('the session row is missing');
    const invitation = await invite(t2, email);
    const t1Before = await tenantState(t1.tenantId, email);

    const result = await flow.accept({
      ...invitation,
      session: {
        userId: created.userId,
        sessionId,
        headers: new Headers({ cookie: signedIn.cookie, 'x-forwarded-for': randomIp() }),
      },
    });

    expect(result.userId).toBe(created.userId);
    expect(await memberships(email), 'home and t2 only').toEqual(
      [home.tenantId, t2.tenantId].sort(),
    );
    expect(await tenantState(t1.tenantId, email), 't1 is unchanged').toEqual(t1Before);
    expect((await userSync.getUser({ tenantId: t2.tenantId, email }))?.status).toBe('Active');
    expect(await userSync.getUser({ tenantId: t1.tenantId, email }), 'no _user in t1').toBeFalsy();
  }, 90_000);
});

/**
 * Task 12.4. Spec scenarios (verbatim):
 * - "Another tenant's user cannot have its status changed": GIVEN a user whose membership is only
 *   in tenant `t2`, WHEN an admin of `t1` calls `setStatus` for it, THEN the operation fails with
 *   `CATALOG_NOT_FOUND` and nothing changes. (The service-account delete half is task 12.5.)
 * - "A member of two tenants is disabled in one only": GIVEN an `Active` user who belongs to `t1`
 *   and `t2`, with a session in each, WHEN the admin of `t1` disables the user, THEN the user's
 *   `t1` session is rejected and their `_user` status in `t1` is `Disabled`, AND their `t2`
 *   session, `_user` status and global account are unchanged, and re-enabling in `t1` restores
 *   only `t1`.
 *
 * ## Production symbols expected
 *
 * None new: `identity.users.setStatus` (task 11.2) exists. If it already behaves this way these
 * tests pass at once (a regression guard for Resolved decision Q25).
 */
describe('cross-tenant matrix: setStatus (task 12.4)', () => {
  let authPool: Pool;
  let auth: AuthInstance;
  let userSync: UserSync;
  let client: ReturnType<
    typeof createRouterClient<ReturnType<typeof createIdentityRouter>, Record<string, unknown>>
  >;

  interface StatusClient {
    identity: {
      users: {
        setStatus(
          input: { params: { user: string }; body: { status: 'Active' | 'Disabled' } },
          options: { context: Record<string, unknown> },
        ): Promise<unknown>;
      };
    };
  }

  beforeAll(async () => {
    const pools = await harnessPools();
    authPool = pools.authPool;
    await runMigrations(authPool);
    const cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    userSync = createUserSync({ pool: pools.appPool, authz: cerbos });
    const adapter = createUserSyncAdapter({ userSync });
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync: adapter,
    });
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
          sender: createRecordingEmailSender(),
        }),
        appPool: pools.appPool,
        userSync: adapter,
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );
  }, 60_000);

  const statusClient = (): StatusClient => client;

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

  async function memberOf(userId: string, tenantId: string): Promise<void> {
    await (
      auth.api as {
        addMember(args: {
          body: { userId: string; role: 'member'; organizationId: string };
        }): Promise<unknown>;
      }
    ).addMember({ body: { userId, role: 'member', organizationId: tenantId } });
  }

  async function newUser(label: string): Promise<{ userId: string; email: string }> {
    const email = `cross-status-${label}-${randomUUID()}@example.test`;
    const created = await createAdminUser(auth, { name: label, email, password: TEST_PASSWORD });
    return { userId: created.userId, email };
  }

  /** A fresh sign-in whose active organization is set directly to the tenant. */
  async function sessionIn(email: string, tenantId: string): Promise<string> {
    const signedIn = await signInAdminUser(auth, {
      email,
      password: TEST_PASSWORD,
      ip: randomIp(),
    });
    await authPool.query('update auth.session set active_organization_id = $1 where token = $2', [
      tenantId,
      signedIn.token,
    ]);
    return signedIn.token;
  }

  async function sessionExists(token: string): Promise<boolean> {
    const result = await authPool.query('select 1 from auth.session where token = $1', [token]);
    return result.rows.length === 1;
  }

  async function accountRow(userId: string): Promise<unknown> {
    const result = await authPool.query<Record<string, unknown>>(
      'select id, email, banned, ban_reason, ban_expires from auth."user" where id = $1',
      [userId],
    );
    return result.rows[0];
  }

  async function statusIn(tenantId: string, email: string): Promise<string | undefined> {
    return (await userSync.getUser({ tenantId, email }))?.status;
  }

  async function rejectionOf(call: Promise<unknown>): Promise<unknown> {
    const thrown: unknown = await call.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown, 'the call must be rejected').toBeDefined();
    return thrown;
  }

  it.each([['Disabled'], ['Active']] as const)(
    "Another tenant's user cannot have its status changed: t1's admin setting %s on a user whose only membership is t2 fails with CATALOG_NOT_FOUND like an unknown user and nothing changes",
    async (status) => {
      const t1 = await freshTenant('t1');
      const t2 = await freshTenant('t2');
      const victim = await newUser('victim');
      await memberOf(victim.userId, t2.tenantId);
      const token = await sessionIn(victim.email, t2.tenantId);
      expect(await statusIn(t2.tenantId, victim.email), 'precondition').toBe('Active');
      const accountBefore = await accountRow(victim.userId);
      const stateBefore = await userSync.getUser({ tenantId: t2.tenantId, email: victim.email });

      const foreign = await rejectionOf(
        statusClient().identity.users.setStatus(
          { params: { user: victim.email }, body: { status } },
          { context: sessionContext(t1) },
        ),
      );
      const unknown = await rejectionOf(
        statusClient().identity.users.setStatus(
          { params: { user: `nobody-${randomUUID()}@example.test` }, body: { status } },
          { context: sessionContext(t1) },
        ),
      );

      expect((foreign as { code?: unknown }).code).toBe('CATALOG_NOT_FOUND');
      expect((unknown as { code?: unknown }).code).toBe('CATALOG_NOT_FOUND');
      expect((foreign as { message?: unknown }).message, 'same as an unknown user').toBe(
        (unknown as { message?: unknown }).message,
      );
      expect((foreign as { status?: unknown }).status).toBe(
        (unknown as { status?: unknown }).status,
      );
      expect(await statusIn(t2.tenantId, victim.email), 't2 status unchanged').toBe('Active');
      expect(await userSync.getUser({ tenantId: t2.tenantId, email: victim.email })).toEqual(
        stateBefore,
      );
      expect(
        await userSync.getUser({ tenantId: t1.tenantId, email: victim.email }),
        'no _user in t1',
      ).toBeFalsy();
      expect(await sessionExists(token), 'the t2 session is intact').toBe(true);
      expect(await accountRow(victim.userId), 'the account is unchanged').toEqual(accountBefore);
    },
    90_000,
  );

  it("A member of two tenants is disabled in one only: t1's admin disables the user, only the t1 session goes, banned stays false, t2 session, status and account are unchanged, and re-enabling restores only t1", async () => {
    const t1 = await freshTenant('t1');
    const t2 = await freshTenant('t2');
    const both = await newUser('both');
    await memberOf(both.userId, t1.tenantId);
    await memberOf(both.userId, t2.tenantId);
    const s1 = await sessionIn(both.email, t1.tenantId);
    const s2 = await sessionIn(both.email, t2.tenantId);
    expect(await statusIn(t1.tenantId, both.email), 'precondition t1').toBe('Active');
    expect(await statusIn(t2.tenantId, both.email), 'precondition t2').toBe('Active');
    const accountBefore = await accountRow(both.userId);
    const t2Before = await userSync.getUser({ tenantId: t2.tenantId, email: both.email });

    await statusClient().identity.users.setStatus(
      { params: { user: both.email }, body: { status: 'Disabled' } },
      { context: sessionContext(t1) },
    );

    expect(await statusIn(t1.tenantId, both.email)).toBe('Disabled');
    expect(await sessionExists(s1), 'the t1 session was revoked').toBe(false);
    expect(await sessionExists(s2), 'the t2 session was not touched').toBe(true);
    expect(await statusIn(t2.tenantId, both.email)).toBe('Active');
    expect(await userSync.getUser({ tenantId: t2.tenantId, email: both.email })).toEqual(t2Before);
    expect(await accountRow(both.userId), 'global account and banned unchanged').toEqual(
      accountBefore,
    );
    expect(((await accountRow(both.userId)) as { banned: unknown }).banned).not.toBe(true);

    await statusClient().identity.users.setStatus(
      { params: { user: both.email }, body: { status: 'Active' } },
      { context: sessionContext(t1) },
    );

    expect(await statusIn(t1.tenantId, both.email), 're-enabled in t1').toBe('Active');
    expect(await sessionExists(s1), 'the revoked t1 session does not come back').toBe(false);
    expect(await sessionExists(s2)).toBe(true);
    expect(await statusIn(t2.tenantId, both.email)).toBe('Active');
    expect(await accountRow(both.userId)).toEqual(accountBefore);
  }, 120_000);
});

/**
 * Task 12.5. Spec scenario (verbatim): "Another tenant's user cannot have its status changed":
 * GIVEN a user whose membership is only in tenant `t2`, WHEN an admin of `t1` ... deletes a
 * service account of `t2`, THEN the operation fails with `CATALOG_NOT_FOUND` and nothing changes.
 * Requirement "Targets belong to the caller's tenant": every service account targeted MUST belong
 * to the host's `tenantId`, otherwise `CATALOG_NOT_FOUND`, identical to a nonexistent id.
 *
 * Verify: "the created entity and key are in `t1`, and the foreign delete leaves the service
 * account and its credential intact."
 *
 * ## Production symbols expected
 *
 * None new: `identity.serviceAccounts.create` (10.3) and `.delete` (10.7) exist. If they already
 * behave this way these tests pass at once (a regression guard).
 */
describe('cross-tenant matrix: service accounts (task 12.5)', () => {
  let appPool: Pool;
  let authPool: Pool;
  let auth: AuthInstance;
  let client: ReturnType<
    typeof createRouterClient<ReturnType<typeof createIdentityRouter>, Record<string, unknown>>
  >;

  interface ServiceAccountClient {
    identity: {
      serviceAccounts: {
        create(
          input: { body: { identifier: string } },
          options: { context: Record<string, unknown> },
        ): Promise<{ clientId: string; clientSecret: string }>;
        delete(
          input: { params: { user: string } },
          options: { context: Record<string, unknown> },
        ): Promise<unknown>;
      };
    };
  }

  beforeAll(async () => {
    const pools = await harnessPools();
    appPool = pools.appPool;
    authPool = pools.authPool;
    await runMigrations(authPool);
    const cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    const adapter = createUserSyncAdapter({
      userSync: createUserSync({ pool: appPool, authz: cerbos }),
    });
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync: adapter,
    });
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
          sender: createRecordingEmailSender(),
        }),
        appPool,
        userSync: adapter,
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );
  }, 60_000);

  const accounts = (): ServiceAccountClient => client;

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

  /** Every `_user` entity of the tenant with the identifier, read under that tenant. */
  async function userEntities(tenantId: string, identifier: string): Promise<readonly unknown[]> {
    const result = await withTenantTransaction(appPool, { tenantId }, (db) =>
      db.query<Record<string, unknown>>(
        `select e.identifier, e.spec_properties
           from catalog_entity e
           join catalog_blueprint b on b.tenant_id = e.tenant_id and b.id = e.blueprint_id
          where e.tenant_id = $1 and b.identifier = '_user' and e.identifier = $2`,
        [tenantId, identifier],
      ),
    );
    return result.rows;
  }

  async function keysOf(
    tenantId: string,
  ): Promise<readonly { id: string; reference_id: string }[]> {
    const result = await authPool.query<{ id: string; reference_id: string }>(
      'select id, reference_id from auth.apikey where reference_id = $1 order by id',
      [tenantId],
    );
    return result.rows;
  }

  async function revocations(tenantId: string): Promise<number> {
    const result = await withTenantTransaction(appPool, { tenantId }, (db) =>
      db.query<{ n: string }>(
        'select count(*)::text as n from machine_credential_revocation where tenant_id = $1',
        [tenantId],
      ),
    );
    return Number(result.rows[0]?.n);
  }

  async function rejectionOf(call: Promise<unknown>): Promise<unknown> {
    const thrown: unknown = await call.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown, 'the call must be rejected').toBeDefined();
    return thrown;
  }

  it('identity.serviceAccounts.create creates only in the host tenant: the _user entity and the key are in t1 and nothing exists in t2', async () => {
    const t1 = await freshTenant('t1');
    const t2 = await freshTenant('t2');
    const identifier = `svc-x12-${randomUUID().slice(0, 8)}`;
    const t2KeysBefore = await keysOf(t2.tenantId);

    const created = await accounts().identity.serviceAccounts.create(
      { body: { identifier } },
      { context: sessionContext(t1) },
    );

    expect(await userEntities(t1.tenantId, identifier), 'the entity is in t1').toHaveLength(1);
    expect(await userEntities(t2.tenantId, identifier), 'no entity in t2').toEqual([]);
    const t1Keys = await keysOf(t1.tenantId);
    expect(
      t1Keys.map((key) => key.id),
      'the key is in t1',
    ).toEqual([created.clientId]);
    expect(t1Keys[0]?.reference_id).toBe(t1.tenantId);
    expect(await keysOf(t2.tenantId), 'no key in t2').toEqual(t2KeysBefore);
  }, 90_000);

  it("Another tenant's service account cannot be deleted: t1's admin deleting a service account of t2 fails with CATALOG_NOT_FOUND like an unknown id, and the service account and its credential stay intact and usable", async () => {
    const t1 = await freshTenant('t1');
    const t2 = await freshTenant('t2');
    const identifier = `svc-x12-${randomUUID().slice(0, 8)}`;
    const created = await accounts().identity.serviceAccounts.create(
      { body: { identifier } },
      { context: sessionContext(t2) },
    );
    const entityBefore = await userEntities(t2.tenantId, identifier);
    const keysBefore = await keysOf(t2.tenantId);
    expect(entityBefore, 'precondition').toHaveLength(1);

    const foreign = await rejectionOf(
      accounts().identity.serviceAccounts.delete(
        { params: { user: identifier } },
        { context: sessionContext(t1) },
      ),
    );
    const unknown = await rejectionOf(
      accounts().identity.serviceAccounts.delete(
        { params: { user: `svc-nobody-${randomUUID().slice(0, 8)}` } },
        { context: sessionContext(t1) },
      ),
    );

    expect((foreign as { code?: unknown }).code).toBe('CATALOG_NOT_FOUND');
    expect((unknown as { code?: unknown }).code).toBe('CATALOG_NOT_FOUND');
    expect((foreign as { message?: unknown }).message, 'same as an unknown id').toBe(
      (unknown as { message?: unknown }).message,
    );
    expect((foreign as { status?: unknown }).status).toBe((unknown as { status?: unknown }).status);
    expect(await userEntities(t2.tenantId, identifier), 'the service account is intact').toEqual(
      entityBefore,
    );
    expect(await keysOf(t2.tenantId), 'the credential row is intact').toEqual(keysBefore);
    expect(await revocations(t2.tenantId), 'nothing was revoked').toBe(0);
    await expect(
      exchangeMachineToken(auth, {
        clientId: created.clientId,
        clientSecret: created.clientSecret,
      }),
      'the credential still exchanges',
    ).resolves.toBeDefined();
  }, 90_000);
});

/**
 * Task 12.6 of openspec/changes/043-identity-lifecycle-and-org-admin (list and create).
 *
 * Scenario (verbatim from the spec, "Another tenant's credential cannot be listed, rotated or
 * revoked"): GIVEN a credential of tenant `t2`, WHEN an admin of `t1` lists, rotates or revokes
 * it, THEN the list omits it and rotate and revoke fail with `CATALOG_NOT_FOUND`. This block
 * covers the list, the `referenceId` that create writes, and a create bound to `t2`'s service
 * account (rotate and revoke are 12.7's).
 *
 * Production symbols expected: none new (`createIdentityRouter` in `./identity-router.js`,
 * `identity.credentials.list` and `identity.credentials.create`).
 */
describe('cross-tenant matrix: credentials list and create (task 12.6)', () => {
  let appPool: Pool;
  let authPool: Pool;
  let auth: AuthInstance;
  let cerbos: CerbosClient;
  let client: ReturnType<
    typeof createRouterClient<ReturnType<typeof createIdentityRouter>, Record<string, unknown>>
  >;

  interface ListOutput {
    readonly credentials: readonly { readonly id: string }[];
    readonly truncated: boolean;
  }

  interface IsolationClient {
    identity: {
      credentials: {
        list(
          input: { query: Record<string, never> },
          options: { context: Record<string, unknown> },
        ): Promise<ListOutput>;
        create(
          input: { body: { name: string; kind: string; userId?: string } },
          options: { context: Record<string, unknown> },
        ): Promise<{ id: string; secret: string }>;
      };
    };
  }

  interface Seeded {
    readonly id: string;
    readonly secret: string;
  }

  beforeAll(async () => {
    const pools = await harnessPools();
    appPool = pools.appPool;
    authPool = pools.authPool;
    await runMigrations(authPool);
    cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    const adapter = createUserSyncAdapter({
      userSync: createUserSync({ pool: appPool, authz: cerbos }),
    });
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync: adapter,
    });
    client = createRouterClient(
      createIdentityRouter({
        auth,
        authz: cerbos,
        authRepository: createAuthRepository(authPool),
        withUserLock: createWithUserLock(authPool),
        appPool,
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );
  }, 60_000);

  const isolation = (): IsolationClient => client;

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

  function seed(tenant: Tenant, name: string): Promise<Seeded> {
    return createMachineCredential(auth, {
      userId: tenant.adminId,
      organizationId: tenant.tenantId,
      name,
      actorKind: 'integration',
      metadata: { createdBy: tenant.adminId },
    }).then((c) => ({ id: c.id, secret: c.secret }));
  }

  async function referenceIdsOf(ids: readonly string[]): Promise<string[]> {
    const rows = await authPool.query<{ reference_id: string }>(
      'select reference_id from auth.apikey where id = any($1::text[])',
      [ids],
    );
    return rows.rows.map((r) => r.reference_id);
  }

  async function keyIds(tenant: Tenant): Promise<string[]> {
    const rows = await authPool.query<{ id: string }>(
      'select id from auth.apikey where reference_id = $1',
      [tenant.tenantId],
    );
    return rows.rows.map((r) => r.id);
  }

  it("Another tenant's credential cannot be listed: t1's list omits t2's credentials, live and revoked, and shows only t1's own", async () => {
    const t1 = await freshTenant('t1');
    const t2 = await freshTenant('t2');
    const own = await seed(t1, 'Own credential');
    const foreignLive = await seed(t2, 'Foreign live');
    const foreignRevoked = await seed(t2, 'Foreign revoked');
    await revokeMachineCredential(auth, {
      userId: t2.adminId,
      id: foreignRevoked.id,
      pool: appPool,
      tenantId: t2.tenantId,
    });

    const output = await isolation().identity.credentials.list(
      { query: {} },
      { context: sessionContext(t1) },
    );

    const ids = output.credentials.map((c) => c.id);
    expect(ids).toEqual([own.id]);
    expect(ids).not.toContain(foreignLive.id);
    expect(ids).not.toContain(foreignRevoked.id);
    expect(output.truncated).toBe(false);
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain(foreignLive.id);
    expect(serialized).not.toContain(foreignRevoked.id);

    // The other direction: t2's admin sees only t2's credentials.
    const theirs = await isolation().identity.credentials.list(
      { query: {} },
      { context: sessionContext(t2) },
    );
    expect(theirs.credentials.map((c) => c.id).sort()).toEqual(
      [foreignLive.id, foreignRevoked.id].sort(),
    );
  }, 120_000);

  it("Create writes only the host tenant's referenceId: the created key's referenceId is t1 and t2 gains no key", async () => {
    const t1 = await freshTenant('t1');
    const t2 = await freshTenant('t2');
    const t2Before = await keyIds(t2);

    const created = await isolation().identity.credentials.create(
      { body: { name: 'Created in t1', kind: 'integration' } },
      { context: sessionContext(t1) },
    );

    expect(await referenceIdsOf([created.id])).toEqual([t1.tenantId]);
    expect(await keyIds(t1)).toEqual([created.id]);
    expect(await keyIds(t2)).toEqual(t2Before);
    const listed = await isolation().identity.credentials.list(
      { query: {} },
      { context: sessionContext(t1) },
    );
    expect(listed.credentials.map((c) => c.id)).toEqual([created.id]);
  }, 120_000);

  it("A create bound to t2's service account is refused with CATALOG_NOT_FOUND, like an unknown id, and nothing is written to either tenant", async () => {
    const t1 = await freshTenant('t1');
    const t2 = await freshTenant('t2');
    const suffix = randomUUID().slice(0, 8);
    const foreign = `svc-t2-${suffix}`;
    await createEntityService({ pool: appPool, authz: cerbos }).create(
      {
        tenantId: t2.tenantId,
        actor: { type: 'system', id: 'credentials-test-seed' },
        principal: { roles: ['admin'] },
      },
      {
        blueprint: '_user',
        identifier: foreign,
        title: 'Seeded service account',
        spec: { properties: { accountKind: 'service', status: 'Active' } },
      },
    );

    const attempt = async (userId: string): Promise<Record<string, unknown>> => {
      try {
        await isolation().identity.credentials.create(
          { body: { name: 'Cross tenant', kind: 'integration', userId } },
          { context: sessionContext(t1) },
        );
      } catch (error) {
        return {
          code: (error as { code?: unknown }).code,
          status: (error as { status?: unknown }).status,
          message: (error as Error).message,
          data: (error as { data?: unknown }).data,
        };
      }
      return { code: 'NO_ERROR' };
    };

    const refused = await attempt(foreign);
    expect(refused['code']).toBe('CATALOG_NOT_FOUND');
    expect(await attempt(`svc-unknown-${suffix}`)).toEqual(refused);
    expect(await keyIds(t1)).toHaveLength(0);
    expect(await keyIds(t2)).toHaveLength(0);
  }, 120_000);
});

/**
 * Task 12.7 of openspec/changes/043-identity-lifecycle-and-org-admin (rotate and revoke).
 *
 * Scenario (spec "Targets belong to the caller's tenant", "Another tenant's credential cannot be
 * listed, rotated or revoked"): for `identity.credentials.rotate` and `.revoke`, an admin of `t1`
 * acting on a credential of `t2` gets `CATALOG_NOT_FOUND` identical to an unknown id, the
 * credential stays enabled and its token exchange still succeeds, and no
 * `machine_credential_revocation` row is written in either tenant.
 *
 * ## Production symbols expected
 *
 * None new: task 9.11 already implements this (the same behavior is covered in
 * `identity/credentials.int.test.ts`). This test is the matrix entry and is expected to pass on
 * arrival (a regression guard).
 */
describe('cross-tenant matrix: credentials rotate and revoke (task 12.7)', () => {
  let appPool: Pool;
  let authPool: Pool;
  let auth: AuthInstance;
  let client: ReturnType<
    typeof createRouterClient<ReturnType<typeof createIdentityRouter>, Record<string, unknown>>
  >;

  interface CredentialClient {
    identity: {
      credentials: {
        rotate(
          input: { params: { credential: string } },
          options: { context: Record<string, unknown> },
        ): Promise<unknown>;
        revoke(
          input: { params: { credential: string } },
          options: { context: Record<string, unknown> },
        ): Promise<unknown>;
      };
    };
  }

  beforeAll(async () => {
    const pools = await harnessPools();
    appPool = pools.appPool;
    authPool = pools.authPool;
    await runMigrations(authPool);
    const cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    const adapter = createUserSyncAdapter({
      userSync: createUserSync({ pool: appPool, authz: cerbos }),
    });
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync: adapter,
    });
    client = createRouterClient(
      createIdentityRouter({
        auth,
        authz: cerbos,
        authRepository: createAuthRepository(authPool),
        withUserLock: createWithUserLock(authPool),
        appPool,
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );
  }, 60_000);

  const credentials = (): CredentialClient => client;

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

  async function revocations(tenantId: string): Promise<number> {
    const result = await withTenantTransaction(appPool, { tenantId }, (db) =>
      db.query<{ n: string }>(
        'select count(*)::text as n from machine_credential_revocation where tenant_id = $1',
        [tenantId],
      ),
    );
    return Number(result.rows[0]?.n);
  }

  async function failureOf(call: Promise<unknown>): Promise<Record<string, unknown>> {
    const thrown: unknown = await call.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown, 'the call must be rejected').toBeDefined();
    return {
      code: (thrown as { code?: unknown }).code,
      status: (thrown as { status?: unknown }).status,
      message: (thrown as { message?: unknown }).message,
      data: (thrown as { data?: unknown }).data,
    };
  }

  for (const operation of ['rotate', 'revoke'] as const) {
    it(`Another tenant's credential cannot be ${operation === 'rotate' ? 'rotated' : 'revoked'}: t1's admin gets CATALOG_NOT_FOUND like an unknown id, the credential stays enabled and exchangeable, and no revocation row is written`, async () => {
      const t1 = await freshTenant('t1');
      const t2 = await freshTenant('t2');
      const foreign = await createMachineCredential(auth, {
        userId: t2.adminId,
        organizationId: t2.tenantId,
        name: 'Foreign',
        actorKind: 'integration',
        metadata: { createdBy: t2.adminId },
      });
      const t1Revocations = await revocations(t1.tenantId);
      const t2Revocations = await revocations(t2.tenantId);

      const foreignFailure = await failureOf(
        credentials().identity.credentials[operation](
          { params: { credential: foreign.id } },
          { context: sessionContext(t1) },
        ),
      );
      const unknownFailure = await failureOf(
        credentials().identity.credentials[operation](
          { params: { credential: randomUUID() } },
          { context: sessionContext(t1) },
        ),
      );

      expect(foreignFailure['code']).toBe('CATALOG_NOT_FOUND');
      expect(unknownFailure['code']).toBe('CATALOG_NOT_FOUND');
      expect(foreignFailure, 'same as an unknown id').toEqual(unknownFailure);
      const stored = await authPool.query<{ enabled: boolean; reference_id: string }>(
        'select enabled, reference_id from auth.apikey where id = $1',
        [foreign.id],
      );
      expect(stored.rows[0]?.enabled, 'still enabled').toBe(true);
      expect(stored.rows[0]?.reference_id).toBe(t2.tenantId);
      expect(await revocations(t2.tenantId), 'no revocation in t2').toBe(t2Revocations);
      expect(await revocations(t1.tenantId), 'no revocation in t1').toBe(t1Revocations);
      await expect(
        exchangeMachineToken(auth, { clientId: foreign.id, clientSecret: foreign.secret }),
        'the credential still exchanges',
      ).resolves.toBeDefined();
    }, 120_000);
  }
});

/**
 * Task 12.8 of openspec/changes/043-identity-lifecycle-and-org-admin (Resolved decision Q135).
 *
 * Verify: with a recording Cerbos client, a call on a target of the caller's tenant reaches Cerbos
 * with the resource tenant taken from the record, and a call whose target belongs to `t2` answers
 * `CATALOG_NOT_FOUND` with no Cerbos request carrying a resource of `t2`. (The `same_tenant` denial
 * of a principal of one tenant on a resource of another is pinned by the Cerbos policy tests.)
 *
 * Covered on a user target (`identity.users.setStatus`) and a credential target
 * (`identity.credentials.revoke`).
 *
 * ## Production symbols expected
 *
 * None new: `defineIdentityOperation` already asks Cerbos with the resolved target's tenant. If it
 * already behaves this way these tests pass at once (a regression guard).
 */
describe("cross-tenant matrix: Cerbos receives the target's real tenant (task 12.8)", () => {
  type CheckResourcesRequest = Parameters<CerbosClient['checkResources']>[0];

  let appPool: Pool;
  let authPool: Pool;
  let auth: AuthInstance;
  let userSync: UserSync;
  const requests: CheckResourcesRequest[] = [];
  let client: ReturnType<
    typeof createRouterClient<ReturnType<typeof createIdentityRouter>, Record<string, unknown>>
  >;

  interface TargetClient {
    identity: {
      users: {
        setStatus(
          input: { params: { user: string }; body: { status: 'Active' | 'Disabled' } },
          options: { context: Record<string, unknown> },
        ): Promise<unknown>;
      };
      credentials: {
        revoke(
          input: { params: { credential: string } },
          options: { context: Record<string, unknown> },
        ): Promise<unknown>;
      };
    };
  }

  beforeAll(async () => {
    const pools = await harnessPools();
    appPool = pools.appPool;
    authPool = pools.authPool;
    await runMigrations(authPool);
    const cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    userSync = createUserSync({ pool: appPool, authz: cerbos });
    const adapter = createUserSyncAdapter({ userSync });
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync: adapter,
    });
    // Records every Cerbos request, then delegates to the real Cerbos.
    const recording = Object.create(cerbos) as CerbosClient;
    recording.checkResources = (request: CheckResourcesRequest) => {
      requests.push(request);
      return cerbos.checkResources(request);
    };
    const capStore = createInMemoryEmailCapStore({
      tenant: { max: 1000, windowSeconds: 3600 },
      recipient: { max: 1000, windowSeconds: 86_400 },
    });
    client = createRouterClient(
      createIdentityRouter({
        auth,
        authz: recording,
        authRepository: createAuthRepository(authPool),
        withUserLock: createWithUserLock(authPool),
        emailGate: createEmailTenantGate({
          disabledTenantIds: [],
          capStore,
          sender: createRecordingEmailSender(),
        }),
        appPool,
        userSync: adapter,
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );
  }, 60_000);

  const targets = (): TargetClient => client;

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

  async function memberOf(email: string, tenantId: string): Promise<void> {
    const created = await createAdminUser(auth, { name: 'Target', email, password: TEST_PASSWORD });
    await (
      auth.api as {
        addMember(args: {
          body: { userId: string; role: 'member'; organizationId: string };
        }): Promise<unknown>;
      }
    ).addMember({ body: { userId: created.userId, role: 'member', organizationId: tenantId } });
  }

  function resourceTenants(list: readonly CheckResourcesRequest[]): unknown[] {
    return list.flatMap((request) =>
      request.resources.map((entry) => entry.resource.attr?.['tenantId']),
    );
  }

  async function rejectionOf(call: Promise<unknown>): Promise<unknown> {
    const thrown: unknown = await call.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown, 'the call must be rejected').toBeDefined();
    return thrown;
  }

  it("A setStatus on a target of the caller's tenant reaches Cerbos with the resource tenant of the record", async () => {
    const t1 = await freshTenant('t1');
    const email = `cerbos-own-${randomUUID()}@example.test`;
    await memberOf(email, t1.tenantId);
    requests.length = 0;

    await targets().identity.users.setStatus(
      { params: { user: email }, body: { status: 'Disabled' } },
      { context: sessionContext(t1) },
    );

    const targetChecks = requests.filter((request) =>
      request.resources.some((entry) => entry.actions.includes('updateStatus')),
    );
    expect(targetChecks.length, 'a check on the resolved target reached Cerbos').toBeGreaterThan(0);
    for (const request of targetChecks) {
      expect(request.principal.attr?.['tenantId']).toBe(t1.tenantId);
    }
    expect(resourceTenants(targetChecks)).toEqual(targetChecks.map(() => t1.tenantId));
    expect((await userSync.getUser({ tenantId: t1.tenantId, email }))?.status).toBe('Disabled');
  }, 90_000);

  it('A setStatus on a user of t2 answers CATALOG_NOT_FOUND and no Cerbos request carries a resource of t2', async () => {
    const t1 = await freshTenant('t1');
    const t2 = await freshTenant('t2');
    const email = `cerbos-foreign-${randomUUID()}@example.test`;
    await memberOf(email, t2.tenantId);
    requests.length = 0;

    const thrown = await rejectionOf(
      targets().identity.users.setStatus(
        { params: { user: email }, body: { status: 'Disabled' } },
        { context: sessionContext(t1) },
      ),
    );

    expect((thrown as { code?: unknown }).code).toBe('CATALOG_NOT_FOUND');
    expect(resourceTenants(requests), 'nothing of t2 reaches Cerbos').not.toContain(t2.tenantId);
    expect((await userSync.getUser({ tenantId: t2.tenantId, email }))?.status).toBe('Active');
  }, 90_000);

  it("A credentials.revoke on a credential of the caller's tenant reaches Cerbos with the resource tenant of the record", async () => {
    const t1 = await freshTenant('t1');
    const own = await createMachineCredential(auth, {
      userId: t1.adminId,
      organizationId: t1.tenantId,
      name: 'Own',
      actorKind: 'integration',
      metadata: { createdBy: t1.adminId },
    });
    requests.length = 0;

    await targets().identity.credentials.revoke(
      { params: { credential: own.id } },
      { context: sessionContext(t1) },
    );

    const tenants = resourceTenants(requests);
    expect(tenants.length, 'Cerbos was asked').toBeGreaterThan(0);
    expect(tenants.every((tenant) => tenant === t1.tenantId)).toBe(true);
    expect(
      requests.some((request) => request.resources.some((e) => e.resource.id === own.id)),
    ).toBe(true);
  }, 90_000);

  it('A credentials.revoke on a credential of t2 answers CATALOG_NOT_FOUND and no Cerbos request carries a resource of t2', async () => {
    const t1 = await freshTenant('t1');
    const t2 = await freshTenant('t2');
    const foreign = await createMachineCredential(auth, {
      userId: t2.adminId,
      organizationId: t2.tenantId,
      name: 'Foreign',
      actorKind: 'integration',
      metadata: { createdBy: t2.adminId },
    });
    requests.length = 0;

    const thrown = await rejectionOf(
      targets().identity.credentials.revoke(
        { params: { credential: foreign.id } },
        { context: sessionContext(t1) },
      ),
    );

    expect((thrown as { code?: unknown }).code).toBe('CATALOG_NOT_FOUND');
    expect(resourceTenants(requests), 'nothing of t2 reaches Cerbos').not.toContain(t2.tenantId);
  }, 90_000);
});

/**
 * Task 12.9. Spec: "Targets belong to the caller's tenant" (every user targeted MUST belong to the
 * host's `tenantId`, otherwise `CATALOG_NOT_FOUND`, identical to a nonexistent id) and the scenario
 * "A user with memberships in two tenants cannot be linked": GIVEN a user who belongs to `t1` and
 * `t2`, WHEN an admin of `t1` links or unlinks an SSO `sub` for it, THEN the operation is refused
 * and nothing changes.
 *
 * Verify: that scenario for link and unlink, and the foreign target answering the same as an
 * unknown one; `create` writes only the host tenant.
 *
 * ## Production symbols expected
 *
 * None new. `identity.users.create` already writes only the host tenant and the targets of link and
 * unlink are resolved inside the tenant; the two-tenant refusal in `linkSsoAccount` and
 * `unlinkSsoAccount` (task 13.2b, 002 VCDM M10) is the behavior expected to be missing today.
 */
describe('cross-tenant matrix: users create, link and unlink (task 12.9)', () => {
  let authPool: Pool;
  let auth: AuthInstance;
  let userSync: UserSync;
  let client: ReturnType<
    typeof createRouterClient<ReturnType<typeof createIdentityRouter>, Record<string, unknown>>
  >;

  interface UsersClient {
    identity: {
      users: {
        create(
          input: { body: { email: string; name: string; role: 'member' | 'admin' } },
          options: { context: Record<string, unknown> },
        ): Promise<{ userId: string; email: string }>;
        linkSsoAccount(
          input: { params: { user: string }; body: { subject: string } },
          options: { context: Record<string, unknown> },
        ): Promise<unknown>;
        unlinkSsoAccount(
          input: { params: { user: string } },
          options: { context: Record<string, unknown> },
        ): Promise<unknown>;
      };
    };
  }

  beforeAll(async () => {
    const pools = await harnessPools();
    authPool = pools.authPool;
    await runMigrations(authPool);
    const cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    userSync = createUserSync({ pool: pools.appPool, authz: cerbos });
    const adapter = createUserSyncAdapter({ userSync });
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync: adapter,
    });
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
          sender: createRecordingEmailSender(),
        }),
        appPool: pools.appPool,
        userSync: adapter,
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );
  }, 60_000);

  const users = (): UsersClient => client;

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

  async function memberOf(userId: string, tenantId: string): Promise<void> {
    await (
      auth.api as {
        addMember(args: {
          body: { userId: string; role: 'member'; organizationId: string };
        }): Promise<unknown>;
      }
    ).addMember({ body: { userId, role: 'member', organizationId: tenantId } });
  }

  async function newUser(label: string): Promise<{ userId: string; email: string }> {
    const email = `cross-users-${label}-${randomUUID()}@example.test`;
    const created = await createAdminUser(auth, { name: label, email, password: TEST_PASSWORD });
    return { userId: created.userId, email };
  }

  async function accountsOf(userId: string): Promise<readonly Record<string, unknown>[]> {
    const result = await authPool.query<Record<string, unknown>>(
      'select * from auth.account where user_id = $1 order by id',
      [userId],
    );
    return result.rows;
  }

  async function membershipsOf(userId: string): Promise<readonly string[]> {
    const result = await authPool.query<{ organization_id: string }>(
      'select organization_id from auth.member where user_id = $1 order by organization_id',
      [userId],
    );
    return result.rows.map((row) => row.organization_id);
  }

  async function subjectOwners(subject: string): Promise<number> {
    const result = await authPool.query('select 1 from auth.account where account_id = $1', [
      subject,
    ]);
    return result.rows.length;
  }

  async function rejectionOf(call: Promise<unknown>): Promise<unknown> {
    const thrown: unknown = await call.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown, 'the call must be rejected').toBeDefined();
    return thrown;
  }

  it('identity.users.create writes only the host tenant: the membership and the _user are in t1 and nothing exists in t2', async () => {
    const t1 = await freshTenant('t1');
    const t2 = await freshTenant('t2');
    const email = `cross-create-${randomUUID()}@example.test`;
    const t2Before = await authPool.query('select id from auth.member where organization_id = $1', [
      t2.tenantId,
    ]);

    const created = await users().identity.users.create(
      { body: { email, name: 'Created', role: 'member' } },
      { context: sessionContext(t1) },
    );

    expect(await membershipsOf(created.userId), 'the only membership is t1').toEqual([t1.tenantId]);
    expect((await userSync.getUser({ tenantId: t1.tenantId, email }))?.status).toBe('Active');
    expect(await userSync.getUser({ tenantId: t2.tenantId, email }), 'no _user in t2').toBeFalsy();
    const t2After = await authPool.query('select id from auth.member where organization_id = $1', [
      t2.tenantId,
    ]);
    expect(t2After.rows, 't2 gained no member').toEqual(t2Before.rows);
  }, 90_000);

  it.each([['linkSsoAccount'], ['unlinkSsoAccount']] as const)(
    "Another tenant's user cannot be linked or unlinked: %s by t1's admin on a user whose only membership is t2 fails with CATALOG_NOT_FOUND like an unknown user and nothing changes",
    async (operation) => {
      const t1 = await freshTenant('t1');
      const t2 = await freshTenant('t2');
      const victim = await newUser('victim');
      await memberOf(victim.userId, t2.tenantId);
      const subject = `sub-${randomUUID()}`;
      const accountsBefore = await accountsOf(victim.userId);

      const call = (email: string): Promise<unknown> =>
        operation === 'linkSsoAccount'
          ? users().identity.users.linkSsoAccount(
              { params: { user: email }, body: { subject } },
              { context: sessionContext(t1) },
            )
          : users().identity.users.unlinkSsoAccount(
              { params: { user: email } },
              { context: sessionContext(t1) },
            );
      const foreign = await rejectionOf(call(victim.email));
      const unknown = await rejectionOf(call(`nobody-${randomUUID()}@example.test`));

      expect((foreign as { code?: unknown }).code).toBe('CATALOG_NOT_FOUND');
      expect((unknown as { code?: unknown }).code).toBe('CATALOG_NOT_FOUND');
      expect((foreign as { message?: unknown }).message, 'same as an unknown user').toBe(
        (unknown as { message?: unknown }).message,
      );
      expect((foreign as { status?: unknown }).status).toBe(
        (unknown as { status?: unknown }).status,
      );
      expect(await accountsOf(victim.userId), 'accounts unchanged').toEqual(accountsBefore);
      expect(await subjectOwners(subject), 'the sub was not linked').toBe(0);
    },
    90_000,
  );

  it("A user with memberships in two tenants cannot be linked: t1's admin linking an SSO sub for a member of t1 and t2 is refused and nothing changes", async () => {
    const t1 = await freshTenant('t1');
    const t2 = await freshTenant('t2');
    const both = await newUser('both');
    await memberOf(both.userId, t1.tenantId);
    await memberOf(both.userId, t2.tenantId);
    const subject = `sub-${randomUUID()}`;
    const accountsBefore = await accountsOf(both.userId);

    await rejectionOf(
      users().identity.users.linkSsoAccount(
        { params: { user: both.email }, body: { subject } },
        { context: sessionContext(t1) },
      ),
    );

    expect(await accountsOf(both.userId), 'no account written').toEqual(accountsBefore);
    expect(await subjectOwners(subject), 'the sub was not linked').toBe(0);
    expect(await membershipsOf(both.userId)).toEqual([t1.tenantId, t2.tenantId].sort());
  }, 90_000);

  it("A user with memberships in two tenants cannot be unlinked: t1's admin unlinking the SSO sub of a member of t1 and t2 is refused and the link and the sessions stay", async () => {
    const t1 = await freshTenant('t1');
    const t2 = await freshTenant('t2');
    const both = await newUser('both');
    await memberOf(both.userId, t1.tenantId);
    // The link is recorded while the user still has a single membership.
    const subject = `sub-${randomUUID()}`;
    await users().identity.users.linkSsoAccount(
      { params: { user: both.email }, body: { subject } },
      { context: sessionContext(t1) },
    );
    await memberOf(both.userId, t2.tenantId);
    const signedIn = await signInAdminUser(auth, {
      email: both.email,
      password: TEST_PASSWORD,
      ip: randomIp(),
    });
    expect(await subjectOwners(subject), 'precondition: the link exists').toBe(1);
    const accountsBefore = await accountsOf(both.userId);

    await rejectionOf(
      users().identity.users.unlinkSsoAccount(
        { params: { user: both.email } },
        { context: sessionContext(t1) },
      ),
    );

    expect(await accountsOf(both.userId), 'accounts unchanged').toEqual(accountsBefore);
    const session = await authPool.query('select 1 from auth.session where token = $1', [
      signedIn.token,
    ]);
    expect(session.rows, 'the session was not revoked').toHaveLength(1);
  }, 90_000);
});
