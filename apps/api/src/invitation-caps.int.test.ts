/**
 * Task 16.12b of openspec/changes/archive/2026-10-14-043-identity-lifecycle-and-org-admin (spec
 * "Invitation email is fixed and capped"; Resolved decision Q149).
 *
 * Task 16.12b Verify: "`invitation-caps.int.test.ts` covers a capped invite leaving
 * no new invitation and every earlier pending one still pending, and a capped resend
 * leaving the earlier link acceptable." The task text adds three more behaviors, each
 * covered here too: the disabled-tenant suppression still runs first and consumes
 * nothing, and a cap consumed by an operation that then fails is not refunded.
 *
 * Spec clauses (verbatim): "Exceeding any cap MUST fail the operation with
 * `AUTH_RATE_LIMITED` ... send no email"; "An email of a tenant on the configured list
 * of disabled tenants (the demo tenants) MUST be suppressed before any cap is consumed,
 * MUST NOT block the operation".
 *
 * ## Harness
 *
 * A real Better Auth instance, a real Cerbos container, a real admin session per
 * test (one fresh organization, so one fresh tenant id), the recording `EmailSender`
 * behind the real `createEmailTenantGate`, and the in-memory cap store with limits
 * chosen per test. Each tenant and each recipient is random, so the buckets of
 * concurrently running tests never meet.
 *
 * ## Production symbols expected
 *
 * None new: `createIdentityRouter`, `createEmailTenantGate` and
 * `createInMemoryEmailCapStore` keep their present signatures. The change is in the
 * order of `identity.users.invite` and `identity.users.resendInvitation`, which must
 * consume the caps (through the gate) before writing any invitation, cancellation or
 * token digest.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { createRouterClient } from '@orpc/server';
import {
  authSchema,
  createAuth,
  createRecordingEmailSender,
  type AuthInstance,
  type EmailSender,
} from '@tayzu/auth';
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
import { verifyInvitationToken } from '../../../packages/auth/src/identity/invitation-token.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createAuthRepository } from './identity/auth-repository.js';
import { createWithUserLock } from './identity/user-lock.js';
import { createEmailTenantGate, type EmailCapStore } from './identity/email-tenant-gate.js';
import { createInMemoryEmailCapStore } from './identity/invitation-caps.js';
import { createUserSyncAdapter } from './identity/user-sync-adapter.js';
import { createIdentityRouter } from './identity-router.js';

const LINK_BASE_URL = 'https://app.tayzu.test';
const BIG = 1000;

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

interface InvitationRow {
  readonly id: string;
  readonly email: string;
  readonly status: string;
}

interface Limits {
  readonly tenant: number;
  readonly recipient: number;
}

describe('invite and resendInvitation consume the email caps before writing any state (task 16.12b, Resolved decision Q149)', () => {
  let authPool: Pool;
  let auth: AuthInstance;
  let cerbos: CerbosClient;
  let userSync: ReturnType<typeof createUserSync>;

  beforeAll(async () => {
    const pools = await harnessPools();
    authPool = pools.authPool;
    await runMigrations(authPool);
    cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    userSync = createUserSync({ pool: pools.appPool, authz: cerbos });
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync: createUserSyncAdapter({ userSync }),
    });
  }, 60_000);

  function build(options: {
    readonly limits: Limits;
    readonly disabledTenantIds?: readonly string[];
    readonly failSends?: { value: boolean };
  }) {
    const recording = createRecordingEmailSender();
    const sender: EmailSender = {
      async send(to, template) {
        if (options.failSends?.value === true) throw new Error('provider down');
        await recording.send(to, template);
      },
    };
    const inner = createInMemoryEmailCapStore({
      tenant: { max: options.limits.tenant, windowSeconds: 3600 },
      recipient: { max: options.limits.recipient, windowSeconds: 86_400 },
    });
    const consumed: string[] = [];
    const capStore: EmailCapStore = {
      consume(scope, key) {
        consumed.push(scope);
        return inner.consume(scope, key);
      },
    };
    const client = createRouterClient(
      createIdentityRouter({
        auth,
        authz: cerbos,
        authRepository: createAuthRepository(authPool),
        withUserLock: createWithUserLock(authPool),
        emailGate: createEmailTenantGate({
          disabledTenantIds: options.disabledTenantIds ?? [],
          capStore,
          sender,
          recipientKeySecret: 'caps-test-only-secret-0123456789-abcdefghij',
        }),
        invitationLinkBaseUrl: LINK_BASE_URL,
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );
    return { client, sent: recording.sent, consumed };
  }

  async function freshTenant(): Promise<{
    tenantId: string;
    adminId: string;
    cookie: string;
  }> {
    const id = randomUUID();
    const t = await bootstrapTestTenant(auth, {
      pool: testAppPool(),
      name: 'Caps Admin',
      email: `caps-admin-${id}@example.test`,
      password: TEST_PASSWORD,
      organizationName: 'Caps Org',
      organizationSlug: `caps-${id}`,
      ip: randomIp(),
    });
    return { tenantId: t.organizationId, adminId: t.userId, cookie: t.cookie };
  }

  function sessionContext(tenant: {
    tenantId: string;
    adminId: string;
    cookie: string;
  }): Record<string, unknown> {
    const headers = new Headers({ cookie: tenant.cookie, 'x-forwarded-for': randomIp() });
    return {
      tenantId: tenant.tenantId,
      actor: { type: 'user', id: tenant.adminId },
      principal: { roles: ['admin'] },
      __requestHeaders: headers,
      __stepUpHeaders: headers,
    };
  }

  async function invitationsOf(tenantId: string): Promise<readonly InvitationRow[]> {
    const result = await authPool.query<InvitationRow>(
      `select id, email, status from auth.invitation where organization_id = $1 order by id`,
      [tenantId],
    );
    return result.rows;
  }

  async function digestOf(invitationId: string): Promise<string | null> {
    const result = await authPool.query<{ value: string }>(
      `select value from auth.verification where identifier = $1`,
      [`invitation-accept:${invitationId}`],
    );
    return result.rows[0]?.value ?? null;
  }

  function tokenOf(
    sent: ReturnType<typeof createRecordingEmailSender>['sent'],
    index: number,
  ): string {
    const template = sent[index]?.template;
    if (template?.kind !== 'InvitationEmail') throw new Error('no invitation email was sent');
    return new URLSearchParams(new URL(template.link).hash.slice(1)).get('token') ?? '';
  }

  async function rejection(call: Promise<unknown>): Promise<unknown> {
    const thrown: unknown = await call.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown, 'the call must be rejected').toBeDefined();
    return thrown;
  }

  const SCOPES: readonly { name: string; limits: Limits }[] = [
    { name: 'tenant', limits: { tenant: 2, recipient: BIG } },
    { name: 'recipient', limits: { tenant: BIG, recipient: 1 } },
  ];

  it.each(SCOPES)(
    'A capped invite leaves no new invitation and every earlier pending one still pending ($name cap)',
    async ({ limits }) => {
      const { client, sent } = build({ limits });
      const tenant = await freshTenant();
      const other = `carol-${randomUUID()}@example.test`;
      const email = `bob-${randomUUID()}@example.test`;

      // GIVEN pending invitations, the earlier one to the address being invited among them.
      // (The tenant cap of 2 is spent by these two; the recipient cap of 1 by the one to bob.)
      await client.identity.users.invite(
        { body: { email: other, role: 'member' } },
        { context: sessionContext(tenant) },
      );
      await client.identity.users.invite(
        { body: { email, role: 'member' } },
        { context: sessionContext(tenant) },
      );
      const before = await invitationsOf(tenant.tenantId);
      expect(before).toHaveLength(2);
      expect(before.every((row) => row.status === 'pending')).toBe(true);
      const digestsBefore = await Promise.all(before.map((row) => digestOf(row.id)));
      const emailsBefore = sent.length;

      // WHEN the admin invites the address again and a cap refuses it.
      const thrown = await rejection(
        client.identity.users.invite(
          { body: { email, role: 'member' } },
          { context: sessionContext(tenant) },
        ),
      );

      // THEN it fails with AUTH_RATE_LIMITED and sends no email...
      expect((thrown as { code?: unknown }).code).toBe('AUTH_RATE_LIMITED');
      expect(sent).toHaveLength(emailsBefore);

      // ...no new invitation exists and every earlier one is still pending, untouched.
      const after = await invitationsOf(tenant.tenantId);
      expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
      expect(after.map((row) => row.status)).toEqual(before.map(() => 'pending'));
      expect(await Promise.all(after.map((row) => digestOf(row.id)))).toEqual(digestsBefore);
    },
    60_000,
  );

  it.each(SCOPES)(
    'A capped resend leaves the stored digest unchanged so the earlier link is still acceptable ($name cap)',
    async ({ limits }) => {
      const { client, sent } = build({ limits });
      const tenant = await freshTenant();
      const email = `bob-${randomUUID()}@example.test`;

      // GIVEN a pending invitation whose email was sent (spending the cap of 1 in the
      // recipient case; the tenant case spends its second slot on another address).
      const created = await client.identity.users.invite(
        { body: { email, role: 'member' } },
        { context: sessionContext(tenant) },
      );
      if (limits.tenant === 2) {
        await client.identity.users.invite(
          { body: { email: `carol-${randomUUID()}@example.test`, role: 'member' } },
          { context: sessionContext(tenant) },
        );
      }
      const earlierToken = tokenOf(sent, 0);
      const digestBefore = await digestOf(created.invitationId);
      expect(verifyInvitationToken(earlierToken, digestBefore)).toBe(true);
      const emailsBefore = sent.length;

      // WHEN the admin resends it and a cap refuses.
      const thrown = await rejection(
        client.identity.users.resendInvitation(
          { params: { invitation: created.invitationId } },
          { context: sessionContext(tenant) },
        ),
      );

      // THEN AUTH_RATE_LIMITED, no email, and the stored digest is unchanged...
      expect((thrown as { code?: unknown }).code).toBe('AUTH_RATE_LIMITED');
      expect(sent).toHaveLength(emailsBefore);
      expect(await digestOf(created.invitationId)).toBe(digestBefore);
      // ...so the earlier email's link still works.
      expect(verifyInvitationToken(earlierToken, await digestOf(created.invitationId))).toBe(true);
      const row = (await invitationsOf(tenant.tenantId)).find((r) => r.id === created.invitationId);
      expect(row?.status).toBe('pending');
    },
    60_000,
  );

  it('The disabled-tenant suppression runs first and consumes nothing: invite and resend succeed, nothing is sent and no bucket is touched', async () => {
    const tenant = await freshTenant();
    // A cap of 1 would refuse the second operation if anything had been consumed.
    const { client, sent, consumed } = build({
      limits: { tenant: 1, recipient: 1 },
      disabledTenantIds: [tenant.tenantId],
    });
    const email = `bob-${randomUUID()}@example.test`;

    const created = await client.identity.users.invite(
      { body: { email, role: 'member' } },
      { context: sessionContext(tenant) },
    );
    await client.identity.users.resendInvitation(
      { params: { invitation: created.invitationId } },
      { context: sessionContext(tenant) },
    );
    await client.identity.users.invite(
      { body: { email: `carol-${randomUUID()}@example.test`, role: 'member' } },
      { context: sessionContext(tenant) },
    );

    expect(sent, 'nothing reaches the sender').toEqual([]);
    expect(consumed, 'no cap bucket is consumed').toEqual([]);
    const rows = await invitationsOf(tenant.tenantId);
    expect(rows, 'the operations succeeded and created their invitations').toHaveLength(2);
  }, 60_000);

  it('A cap consumed by an invite that then fails is not refunded', async () => {
    const failSends = { value: false };
    const { client, sent } = build({ limits: { tenant: 1, recipient: BIG }, failSends });
    const tenant = await freshTenant();

    // GIVEN a provider failure after the caps are consumed.
    failSends.value = true;
    await rejection(
      client.identity.users.invite(
        { body: { email: `bob-${randomUUID()}@example.test`, role: 'member' } },
        { context: sessionContext(tenant) },
      ),
    );

    // WHEN the provider recovers and the admin invites again, THEN the tenant's one slot
    // is already spent.
    failSends.value = false;
    const thrown = await rejection(
      client.identity.users.invite(
        { body: { email: `dave-${randomUUID()}@example.test`, role: 'member' } },
        { context: sessionContext(tenant) },
      ),
    );
    expect((thrown as { code?: unknown }).code).toBe('AUTH_RATE_LIMITED');
    expect(sent).toEqual([]);
  }, 60_000);

  it('A cap consumed by a resend that then fails is not refunded', async () => {
    const failSends = { value: false };
    const { client } = build({ limits: { tenant: 2, recipient: BIG }, failSends });
    const tenant = await freshTenant();
    const created = await client.identity.users.invite(
      { body: { email: `bob-${randomUUID()}@example.test`, role: 'member' } },
      { context: sessionContext(tenant) },
    );

    // The resend consumes the second slot, then the provider fails.
    failSends.value = true;
    await rejection(
      client.identity.users.resendInvitation(
        { params: { invitation: created.invitationId } },
        { context: sessionContext(tenant) },
      ),
    );

    // A retry finds the tenant's slots spent.
    failSends.value = false;
    const thrown = await rejection(
      client.identity.users.resendInvitation(
        { params: { invitation: created.invitationId } },
        { context: sessionContext(tenant) },
      ),
    );
    expect((thrown as { code?: unknown }).code).toBe('AUTH_RATE_LIMITED');
  }, 60_000);
});
