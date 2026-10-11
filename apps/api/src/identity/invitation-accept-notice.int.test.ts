/**
 * Task 8.15 of openspec/changes/043-identity-lifecycle-and-org-admin (spec
 * "Invitation acceptance"; design D4 step 6, D5 "Notice emails"; Resolved decisions
 * Q39, Q53, Q122 and Q127).
 *
 * Scenarios (from the spec, "Invitation acceptance"):
 * - "An accepted admin invitation notifies the other admins"
 * - "A failure after the `_user` step has already notified the other admins"
 * - "A token replaced by a concurrent resend leaves nothing owed"
 * - "A new-account join whose token was replaced by a concurrent resend notifies the
 *   other admins"
 *
 * ## Harness
 *
 * The harness of `accept-flow.int.test.ts` (a real Better Auth instance with the Q30
 * `UserSyncPort` adapter, a fresh organization per test with its owner as the inviter,
 * a real invitation and the digest of its token), plus the real notice dispatcher of
 * 6.12 over a recording email sender and a capStore that never refuses, so that what is
 * asserted is the mail that reaches the sender.
 *
 * ## Production symbols expected
 *
 * `apps/api/src/identity/accept-flow.ts`: `AcceptFlowOptions` gains an optional
 * `notices?: NoticeDispatcher` (the type of `./notices.js`). Without it the flow sends
 * nothing. When an invitation whose role is `admin` is accepted the flow resolves the
 * recipients on the server (every other member of the organization whose role is
 * `owner` or `admin`, `Disabled` ones included, the invitee excluded, each as a
 * `NoticeRecipient` with the membership's creation date) and calls
 * `notices.send({ tenantId, template: { kind: 'AdminAcceptedNotice' }, recipients })`
 * once, in the `admin_notice` step slot on the new-account path (after the commit or
 * after a zero-row consumption, never after a compensated failure) and, on the
 * existing-account path, in the `join_owed` slot and only when the attempt's `_user`
 * step returned a status event (`invitation_accepted` or `created_active`). A
 * dispatcher that rejects never fails the acceptance: the flow logs
 * `catalog.security.admin_notice_failed` with `tayzu.tenant.id`.
 *
 * ## Why this fails right now
 *
 * `createAcceptFlow` ignores `notices`, so no notice is ever sent.
 */
// Load-bearing import order (design D1): the telemetry harness registers
// before anything that loads `@tayzu/auth` creates its logger.
import { registration, type TelemetryTestHarness } from '../__fixtures__/link-telemetry.js';
import { randomInt, randomUUID } from 'node:crypto';

import {
  authSchema,
  createAuth,
  createRecordingEmailSender,
  createStepUpGuard,
  type AuthInstance,
  type EmailSender,
} from '@tayzu/auth';
import { createCerbosClient } from '@tayzu/authz';
import { createUserSync, type UserSync } from '@tayzu/catalog';
import { runMigrations } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import {
  bootstrapTestTenant,
  createAdminUser,
  signInAdminUser,
} from '../../../../packages/auth/src/__fixtures__/admin-user.js';
import { stepUpVerificationIdentifier } from '../../../../packages/auth/src/step-up.js';
import {
  TEST_PASSWORD,
  TEST_SECRET,
} from '../../../../packages/auth/src/__fixtures__/test-secret.js';
import {
  digestInvitationToken,
  generateInvitationToken,
} from '../../../../packages/auth/src/identity/invitation-token.js';
import { harnessPools } from '../__fixtures__/pools.js';
import { toOrpcError } from '../error-mapping.js';
import { createAcceptFlow } from './accept-flow.js';
import { createAuthRepository, type AuthRepository } from './auth-repository.js';
import { runWithIdentityContext } from './identity-context.js';
import { createNoticeDispatcher, type NoticeDispatcher } from './notices.js';
import { createUserSyncAdapter } from './user-sync-adapter.js';

const sharedCerbos = createCerbosClient({ address: 'localhost:3593', tls: false });

const DENIED_EVENT = 'catalog.security.invitation_acceptance_denied';
const NOTICE_FAILED_EVENT = 'catalog.security.admin_notice_failed';
const HMAC_SECRET = 'accept-notice-test-only-secret-0123456789-abcdef';

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

interface Tenant {
  readonly tenantId: string;
  readonly adminId: string;
  readonly adminEmail: string;
  readonly cookie: string;
}

interface Invitation {
  readonly invitationId: string;
  readonly token: string;
}

interface Session {
  readonly userId: string;
  readonly sessionId: string;
  readonly headers: Headers;
}

type StepSeam = (step: string) => void | Promise<void>;

interface ApiSurface {
  createInvitation(args: {
    body: { email: string; role: 'member' | 'admin'; organizationId: string };
    headers: Headers;
  }): Promise<{ id: string; expiresAt: Date | string }>;
  addMember(args: {
    body: { userId: string; role: 'member' | 'admin'; organizationId: string };
  }): Promise<unknown>;
}

describe('the admin-accepted notice (task 8.15, design D4 step 6, Resolved decisions Q39, Q53, Q122, Q127)', () => {
  let harness: TelemetryTestHarness;
  let authPool: Pool;
  let auth: AuthInstance;
  let api: ApiSurface;
  let catalogSync: UserSync;
  let repository: AuthRepository;
  let adapter: ReturnType<typeof createUserSyncAdapter>;

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
    catalogSync = createUserSync({
      pool: pools.appPool,
      authz: createCerbosClient({ address: 'localhost:3593', tls: false }),
    });
    adapter = createUserSyncAdapter({ userSync: catalogSync });
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync: adapter,
    });
    api = auth.api as ApiSurface;
    repository = createAuthRepository(authPool);
  }, 60_000);

  function dispatcherOver(sender: EmailSender): NoticeDispatcher {
    return createNoticeDispatcher({
      disabledTenantIds: [],
      capStore: { consume: () => Promise.resolve() },
      sender,
      recipientKeySecret: HMAC_SECRET,
    });
  }

  function flowWith(notices: NoticeDispatcher, onStep?: StepSeam) {
    return createAcceptFlow({
      auth,
      authz: sharedCerbos,
      authRepository: repository,
      authPool,
      userSync: adapter,
      stepUp: createStepUpGuard({ auth }),
      notices,
      ...(onStep === undefined ? {} : { onStep }),
    });
  }

  async function freshTenant(): Promise<Tenant> {
    const id = randomUUID();
    const adminEmail = `notice-owner-${id}@example.test`;
    const t = await bootstrapTestTenant(auth, {
      name: 'Notice Owner',
      email: adminEmail,
      password: TEST_PASSWORD,
      organizationName: 'Notice Org',
      organizationSlug: `notice-${id}`,
      ip: randomIp(),
    });
    return { tenantId: t.organizationId, adminId: t.userId, adminEmail, cookie: t.cookie };
  }

  async function addMemberAccount(
    tenant: Tenant,
    role: 'member' | 'admin',
    label: string,
  ): Promise<string> {
    const email = `${label}-${randomUUID()}@example.test`;
    const created = await createAdminUser(auth, {
      name: label,
      email,
      password: TEST_PASSWORD,
    });
    await api.addMember({
      body: { userId: created.userId, role, organizationId: tenant.tenantId },
    });
    return email;
  }

  /**
   * An organization with an owner, two admins, a `Disabled` admin and a plain member;
   * returns the addresses that must be notified and the one that must not.
   */
  async function populate(tenant: Tenant): Promise<{ recipients: string[]; plainMember: string }> {
    const adminOne = await addMemberAccount(tenant, 'admin', 'admin-one');
    const adminTwo = await addMemberAccount(tenant, 'admin', 'admin-two');
    const disabled = await addMemberAccount(tenant, 'admin', 'admin-disabled');
    await catalogSync.upsertUser({
      tenantId: tenant.tenantId,
      email: disabled,
      name: 'Disabled Admin',
      status: 'Disabled',
    });
    const plainMember = await addMemberAccount(tenant, 'member', 'plain');
    return { recipients: [tenant.adminEmail, adminOne, adminTwo, disabled], plainMember };
  }

  async function invite(
    tenant: Tenant,
    email: string,
    role: 'member' | 'admin' = 'admin',
  ): Promise<Invitation> {
    const invitation = await runWithIdentityContext({ adminId: tenant.adminId }, () =>
      api.createInvitation({
        body: { email, role, organizationId: tenant.tenantId },
        headers: new Headers({ cookie: tenant.cookie, 'x-forwarded-for': randomIp() }),
      }),
    );
    const token = generateInvitationToken();
    await authPool.query(
      `insert into auth.verification (id, identifier, value, expires_at)
       values ($1, $2, $3, $4)`,
      [
        randomUUID(),
        `invitation-accept:${invitation.id}`,
        digestInvitationToken(token),
        new Date(invitation.expiresAt),
      ],
    );
    return { invitationId: invitation.id, token };
  }

  async function replaceToken(invitationId: string): Promise<string> {
    const token = generateInvitationToken();
    await authPool.query(`update auth.verification set value = $1 where identifier = $2`, [
      digestInvitationToken(token),
      `invitation-accept:${invitationId}`,
    ]);
    return token;
  }

  async function userIdOf(email: string): Promise<string> {
    const result = await authPool.query<{ id: string }>(
      `select id from auth."user" where email = $1`,
      [email],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error('expected the account to exist');
    return id;
  }

  /** A real session of the account with a fresh step-up marker (the existing-account `admin` path). */
  async function sessionOf(email: string): Promise<Session> {
    const signedIn = await signInAdminUser(auth, {
      email,
      password: TEST_PASSWORD,
      ip: randomIp(),
    });
    await authPool.query(
      `insert into auth.verification (id, identifier, value, expires_at)
       values ($1, $2, 'password', now() + interval '4 minutes')`,
      [randomUUID(), stepUpVerificationIdentifier(signedIn.token)],
    );
    return {
      userId: await userIdOf(email),
      sessionId: randomUUID(),
      headers: new Headers({ cookie: signedIn.cookie, 'x-forwarded-for': randomIp() }),
    };
  }

  /** The invitee's existing account (a global account that is not a member of the tenant). */
  async function existingAccount(email: string): Promise<void> {
    await createAdminUser(auth, { name: 'Existing Account', email, password: TEST_PASSWORD });
  }

  async function failureOf(attempt: Promise<unknown>): Promise<{ code: string } | undefined> {
    try {
      await attempt;
      return undefined;
    } catch (error) {
      return toOrpcError(error);
    }
  }

  async function events(name: string, tenantId?: string) {
    await harness.forceFlush();
    return [...harness.logExporter.getFinishedLogRecords()].filter(
      (record) =>
        record.eventName === name &&
        (tenantId === undefined || record.attributes['tayzu.tenant.id'] === tenantId),
    );
  }

  /** Per recipient, the number of notices the recording sender received. */
  function noticeCounts(sender: ReturnType<typeof createRecordingEmailSender>) {
    const counts = new Map<string, number>();
    for (const mail of sender.sent) {
      if (mail.template.kind !== 'AdminAcceptedNotice') continue;
      counts.set(mail.to, (counts.get(mail.to) ?? 0) + 1);
    }
    return counts;
  }

  function expectExactlyOneEach(
    sender: ReturnType<typeof createRecordingEmailSender>,
    recipients: readonly string[],
  ): void {
    const counts = noticeCounts(sender);
    expect([...counts.keys()].sort()).toEqual([...recipients].sort());
    for (const recipient of recipients) expect(counts.get(recipient)).toBe(1);
    expect(sender.sent, 'only notices were sent').toHaveLength(recipients.length);
  }

  it('An accepted admin invitation notifies the other admins: the owner, two admins and a Disabled admin each receive exactly one fixed-template notice, a plain member and the invitee none (new account)', async () => {
    const tenant = await freshTenant();
    const { recipients, plainMember } = await populate(tenant);
    const email = `dave-${randomUUID()}@example.test`;
    const invitation = await invite(tenant, email, 'admin');
    const sender = createRecordingEmailSender();

    await flowWith(dispatcherOver(sender)).accept({ ...invitation, password: TEST_PASSWORD });

    expectExactlyOneEach(sender, recipients);
    expect(noticeCounts(sender).has(plainMember)).toBe(false);
    expect(noticeCounts(sender).has(email), 'the invitee is not notified').toBe(false);
    // The fixed template carries no value of its own (6.11).
    for (const mail of sender.sent) expect(mail.template).toEqual({ kind: 'AdminAcceptedNotice' });
  }, 90_000);

  it('An accepted admin invitation notifies the other admins on the existing-account path too', async () => {
    const tenant = await freshTenant();
    const { recipients, plainMember } = await populate(tenant);
    const email = `carol-${randomUUID()}@example.test`;
    await existingAccount(email);
    const invitation = await invite(tenant, email, 'admin');
    const carol = await sessionOf(email);
    const sender = createRecordingEmailSender();

    await flowWith(dispatcherOver(sender)).accept({ ...invitation, session: carol });

    expectExactlyOneEach(sender, recipients);
    expect(noticeCounts(sender).has(plainMember)).toBe(false);
    expect(noticeCounts(sender).has(email), 'the invitee is not notified').toBe(false);
  }, 90_000);

  it('A member invitation sends no notice, on either path', async () => {
    const tenant = await freshTenant();
    await populate(tenant);
    const sender = createRecordingEmailSender();
    const flow = flowWith(dispatcherOver(sender));

    const newEmail = `dave-${randomUUID()}@example.test`;
    const newInvitation = await invite(tenant, newEmail, 'member');
    await flow.accept({ ...newInvitation, password: TEST_PASSWORD });

    const oldEmail = `carol-${randomUUID()}@example.test`;
    await existingAccount(oldEmail);
    const oldInvitation = await invite(tenant, oldEmail, 'member');
    await flow.accept({
      ...oldInvitation,
      session: { userId: await userIdOf(oldEmail), sessionId: randomUUID() },
    });

    expect(sender.sent).toHaveLength(0);
  }, 90_000);

  it('A failing sender does not stop the acceptance', async () => {
    const tenant = await freshTenant();
    await populate(tenant);
    const email = `dave-${randomUUID()}@example.test`;
    const invitation = await invite(tenant, email, 'admin');
    const failing: EmailSender = { send: () => Promise.reject(new Error('provider down')) };

    const accepted = await flowWith(dispatcherOver(failing)).accept({
      ...invitation,
      password: TEST_PASSWORD,
    });

    expect(accepted.userId).toBe(await userIdOf(email));
    const tokens = await authPool.query(`select 1 from auth.verification where identifier = $1`, [
      `invitation-accept:${invitation.invitationId}`,
    ]);
    expect(tokens.rowCount, 'the token is consumed').toBe(0);
  }, 90_000);

  it('A notice dispatch that fails never blocks the acceptance and logs catalog.security.admin_notice_failed with the tenant and no address', async () => {
    const tenant = await freshTenant();
    const { recipients } = await populate(tenant);
    const email = `dave-${randomUUID()}@example.test`;
    const invitation = await invite(tenant, email, 'admin');
    const broken: NoticeDispatcher = { send: () => Promise.reject(new Error('dispatcher down')) };

    const accepted = await flowWith(broken).accept({ ...invitation, password: TEST_PASSWORD });

    expect(accepted.userId).toBe(await userIdOf(email));
    const failed = await events(NOTICE_FAILED_EVENT, tenant.tenantId);
    expect(failed).toHaveLength(1);
    const serialized = JSON.stringify(failed[0]?.attributes);
    for (const address of [...recipients, email]) expect(serialized).not.toContain(address);
  }, 90_000);

  it('A failure after the `_user` step has already notified the other admins: the failed existing-account attempt sent exactly one notice per recipient and a retry with the same token completes with no second notice', async () => {
    const tenant = await freshTenant();
    const { recipients } = await populate(tenant);
    const email = `carol-${randomUUID()}@example.test`;
    await existingAccount(email);
    const invitation = await invite(tenant, email, 'admin');
    const carol = await sessionOf(email);
    const sender = createRecordingEmailSender();

    // GIVEN an attempt that fails after her `_user` was activated, when her email is marked verified.
    const failure = await failureOf(
      flowWith(dispatcherOver(sender), (step) => {
        if (step === 'email_verified') throw new Error('injected failure');
      }).accept({ ...invitation, session: carol }),
    );

    // THEN each other admin has already received exactly one notice, with no retry needed...
    expect(failure?.code).toBe('INTERNAL');
    expectExactlyOneEach(sender, recipients);

    // ...and a retry, whose `_user` step writes nothing, completes with no second notice.
    await flowWith(dispatcherOver(sender)).accept({ ...invitation, session: carol });
    const tokens = await authPool.query(`select 1 from auth.verification where identifier = $1`, [
      `invitation-accept:${invitation.invitationId}`,
    ]);
    expect(tokens.rowCount, 'the retry consumed the token').toBe(0);
    expectExactlyOneEach(sender, recipients);
  }, 90_000);

  it('A new-account admin acceptance that fails and is compensated sends no notice, and its retry that commits sends one per recipient', async () => {
    const tenant = await freshTenant();
    const { recipients } = await populate(tenant);
    const email = `dave-${randomUUID()}@example.test`;
    const invitation = await invite(tenant, email, 'admin');
    const sender = createRecordingEmailSender();

    const failure = await failureOf(
      flowWith(dispatcherOver(sender), (step) => {
        if (step === 'consume') throw new Error('injected failure');
      }).accept({ ...invitation, password: TEST_PASSWORD }),
    );

    expect(failure?.code).toBe('INTERNAL');
    expect(sender.sent, 'a compensated failure sends none').toHaveLength(0);

    await flowWith(dispatcherOver(sender)).accept({ ...invitation, password: TEST_PASSWORD });

    expectExactlyOneEach(sender, recipients);
  }, 90_000);

  it('A token replaced by a concurrent resend leaves nothing owed: an existing-account attempt whose token delete removes zero rows has already sent the notice, answers consume_conflict, leaves the invitation pending, and the resent token completes with no second notice', async () => {
    const tenant = await freshTenant();
    const { recipients } = await populate(tenant);
    const email = `carol-${randomUUID()}@example.test`;
    await existingAccount(email);
    const invitation = await invite(tenant, email, 'admin');
    const carol = await sessionOf(email);
    const sender = createRecordingEmailSender();

    // GIVEN a resend that replaces the token after the attempt's `_user` step.
    let resent = '';
    const failure = await failureOf(
      flowWith(dispatcherOver(sender), async (step) => {
        if (step === 'consume') resent = await replaceToken(invitation.invitationId);
      }).accept({ ...invitation, session: carol }),
    );

    // THEN the uniform rejection with the reason `consume_conflict`, the notice already sent...
    expect(failure?.code).toBe('CATALOG_NOT_FOUND');
    const denied = (await events(DENIED_EVENT)).filter(
      (record) => record.attributes['tayzu.identity.invitation.id'] === invitation.invitationId,
    );
    expect(denied).toHaveLength(1);
    expect(denied[0]?.attributes['tayzu.identity.invitation.denial_reason']).toBe(
      'consume_conflict',
    );
    expectExactlyOneEach(sender, recipients);
    // ...and the invitation stays pending.
    const status = await authPool.query<{ status: string }>(
      `select status from auth.invitation where id = $1`,
      [invitation.invitationId],
    );
    expect(status.rows[0]?.status).toBe('pending');

    // AND the acceptance with the resent token completes with no second notice.
    await flowWith(dispatcherOver(sender)).accept({
      invitationId: invitation.invitationId,
      token: resent,
      session: carol,
    });
    const after = await authPool.query<{ status: string }>(
      `select status from auth.invitation where id = $1`,
      [invitation.invitationId],
    );
    expect(after.rows[0]?.status).toBe('accepted');
    expectExactlyOneEach(sender, recipients);
  }, 90_000);

  it('A new-account join whose token was replaced by a concurrent resend notifies the other admins: the uniform rejection answers consume_conflict with one notice per recipient, and the resent token (existing-account path) completes with no second notice', async () => {
    const tenant = await freshTenant();
    const { recipients } = await populate(tenant);
    const email = `dave-${randomUUID()}@example.test`;
    const invitation = await invite(tenant, email, 'admin');
    const sender = createRecordingEmailSender();

    // GIVEN a resend that replaces the token after the attempt's `_user` step.
    let resent = '';
    const failure = await failureOf(
      flowWith(dispatcherOver(sender), async (step) => {
        if (step === 'consume') resent = await replaceToken(invitation.invitationId);
      }).accept({ ...invitation, password: TEST_PASSWORD }),
    );

    // THEN the uniform rejection with the reason `consume_conflict` and one notice per recipient.
    expect(failure?.code).toBe('CATALOG_NOT_FOUND');
    const denied = (await events(DENIED_EVENT)).filter(
      (record) => record.attributes['tayzu.identity.invitation.id'] === invitation.invitationId,
    );
    expect(denied).toHaveLength(1);
    expect(denied[0]?.attributes['tayzu.identity.invitation.denial_reason']).toBe(
      'consume_conflict',
    );
    expectExactlyOneEach(sender, recipients);

    // AND the acceptance with the resent token takes the existing-account path and sends no second notice.
    const dave = await sessionOf(email);
    await flowWith(dispatcherOver(sender)).accept({
      invitationId: invitation.invitationId,
      token: resent,
      session: dave,
    });
    const after = await authPool.query<{ status: string }>(
      `select status from auth.invitation where id = $1`,
      [invitation.invitationId],
    );
    expect(after.rows[0]?.status).toBe('accepted');
    expectExactlyOneEach(sender, recipients);
  }, 90_000);
});
