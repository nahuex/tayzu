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
import { createUserSync, type UserSync } from '@tayzu/catalog';
import { runMigrations } from '@tayzu/db';
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
          input: { user: string; status: 'Active' | 'Disabled' },
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
          { user: victim.email, status },
          { context: sessionContext(t1) },
        ),
      );
      const unknown = await rejectionOf(
        statusClient().identity.users.setStatus(
          { user: `nobody-${randomUUID()}@example.test`, status },
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
      { user: both.email, status: 'Disabled' },
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
      { user: both.email, status: 'Active' },
      { context: sessionContext(t1) },
    );

    expect(await statusIn(t1.tenantId, both.email), 're-enabled in t1').toBe('Active');
    expect(await sessionExists(s1), 'the revoked t1 session does not come back').toBe(false);
    expect(await sessionExists(s2)).toBe(true);
    expect(await statusIn(t2.tenantId, both.email)).toBe('Active');
    expect(await accountRow(both.userId)).toEqual(accountBefore);
  }, 120_000);
});
