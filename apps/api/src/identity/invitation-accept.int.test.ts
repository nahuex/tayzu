/**
 * Task 8.2 of openspec/changes/043-identity-lifecycle-and-org-admin (spec
 * "Invitation acceptance"; design D4 steps 1 to 5 and the Observability
 * contract; Resolved decisions Q112 and Q116).
 *
 * Scenarios (from the spec, "Invitation acceptance"):
 * - "A new person accepts and can then sign in": the account has a verified
 *   email, a membership with the invited role and status `Active`, no session
 *   exists, and the invitee then signs in through the normal route, also with
 *   the password in its NFD form (8.1d). The `accepted` invitation status and
 *   the single use of the token are 8.3's.
 * - "A failed `_user` write undoes the acceptance": with a `userSync` that
 *   throws, no user, no member, the `_user` still `Invited`, the token still
 *   verifies, the sanitized `INTERNAL` answer, and a retry with the same token
 *   succeeds.
 * - A successful acceptance emits `catalog.audit.invitation_accepted` with
 *   `tayzu.actor.type` `user` and `tayzu.actor.id` the new user's Better Auth
 *   user id, the same value as `tayzu.identity.user.id` (Q116).
 *
 * ## Production symbols expected
 *
 * `apps/api/src/identity/accept-flow.ts` (exists since 8.1e): `createAcceptFlow`
 * whose `accept({ invitationId, token, password })` emits, once the new-account
 * acceptance has committed, `catalog.audit.invitation_accepted` through
 * `emitIdentityEvent` with `tayzu.tenant.id`, `tayzu.identity.invitation.id`,
 * `tayzu.actor.type` `user`, `tayzu.actor.id` and `tayzu.identity.user.id` (both
 * the new user's id). It emits nothing for a failed attempt.
 */
// Load-bearing import order (design D1): the telemetry harness registers
// before anything that loads `@tayzu/auth` creates its logger.
import { registration, type TelemetryTestHarness } from '../__fixtures__/link-telemetry.js';
import { randomInt, randomUUID } from 'node:crypto';

import { authSchema, createAuth, type AuthInstance } from '@tayzu/auth';
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
import {
  TEST_PASSWORD,
  TEST_SECRET,
} from '../../../../packages/auth/src/__fixtures__/test-secret.js';
import {
  digestInvitationToken,
  generateInvitationToken,
  verifyInvitationToken,
} from '../../../../packages/auth/src/identity/invitation-token.js';
import { harnessPools } from '../__fixtures__/pools.js';
import { toOrpcError } from '../error-mapping.js';
import { createAcceptFlow } from './accept-flow.js';
import { createAuthRepository, type AuthRepository } from './auth-repository.js';
import { runWithIdentityContext } from './identity-context.js';
import { createUserSyncAdapter } from './user-sync-adapter.js';

const ACCEPTED_EVENT = 'catalog.audit.invitation_accepted';
const AUTH_BASE_URL = 'http://localhost:3000/api/auth';

/** Compliant, NFC (precomposed é, ñ, ä), so that its NFD form differs. */
const PASSWORD_NFC = 'Café-Mañana-Passäphrase-2026!';
const PASSWORD_NFD = PASSWORD_NFC.normalize('NFD');

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

interface Tenant {
  readonly tenantId: string;
  readonly adminId: string;
  readonly cookie: string;
}

interface Invitation {
  readonly invitationId: string;
  readonly token: string;
}

interface InviteApiSurface {
  createInvitation(args: {
    body: { email: string; role: 'member' | 'admin'; organizationId: string };
    headers: Headers;
  }): Promise<{ id: string; expiresAt: Date | string }>;
}

describe('A new person accepts an invitation (task 8.2, design D4, Resolved decisions Q112 and Q116)', () => {
  let harness: TelemetryTestHarness;
  let authPool: Pool;
  let auth: AuthInstance;
  let catalogSync: UserSync;
  let acceptFlow: ReturnType<typeof createAcceptFlow>;
  const failingUserWrites = new Set<string>();

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
    const base = createUserSync({ pool: pools.appPool, authz: cerbos });
    catalogSync = {
      getUser: (input) => base.getUser(input),
      upsertUser: async (input) => {
        if (failingUserWrites.has(input.tenantId)) throw new Error('user sync unavailable');
        await base.upsertUser(input);
      },
    };
    const adapter = createUserSyncAdapter({ userSync: catalogSync });
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync: adapter,
    });
    acceptFlow = createAcceptFlow({
      auth,
      authRepository: createAuthRepository(authPool),
      authPool,
      userSync: adapter,
    });
  }, 60_000);

  async function freshTenant(): Promise<Tenant> {
    const id = randomUUID();
    const t = await bootstrapTestTenant(auth, {
      name: 'Accept Admin',
      email: `accept-admin-${id}@example.test`,
      password: TEST_PASSWORD,
      organizationName: 'Accept Org',
      organizationSlug: `accept-${id}`,
      ip: randomIp(),
    });
    return { tenantId: t.organizationId, adminId: t.userId, cookie: t.cookie };
  }

  /** What `identity.users.invite` leaves: the invitation (its hook writes the `Invited` `_user`) and the token digest. */
  async function invite(
    tenant: Tenant,
    email: string,
    role: 'member' | 'admin' = 'member',
  ): Promise<Invitation> {
    const api = auth.api as InviteApiSurface;
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

  async function tokenRows(invitationId: string): Promise<readonly string[]> {
    const result = await authPool.query<{ value: string }>(
      `select value from auth.verification where identifier = $1`,
      [`invitation-accept:${invitationId}`],
    );
    return result.rows.map((row) => row.value);
  }

  async function tokenStillVerifies(invitation: Invitation): Promise<boolean> {
    const rows = await tokenRows(invitation.invitationId);
    return rows.length === 1 && verifyInvitationToken(invitation.token, rows[0] ?? null);
  }

  async function userByEmail(
    email: string,
  ): Promise<{ id: string; emailVerified: boolean; role: string | null } | undefined> {
    const result = await authPool.query<{
      id: string;
      email_verified: boolean;
      role: string | null;
    }>(`select id, email_verified, role from auth."user" where email = $1`, [email]);
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : { id: row.id, emailVerified: row.email_verified, role: row.role };
  }

  async function members(
    tenantId: string,
    userId: string,
  ): Promise<readonly { id: string; role: string }[]> {
    const result = await authPool.query<{ id: string; role: string }>(
      `select id, role from auth.member where organization_id = $1 and user_id = $2`,
      [tenantId, userId],
    );
    return result.rows;
  }

  async function sessionCount(userId: string): Promise<number> {
    const result = await authPool.query(`select 1 from auth.session where user_id = $1`, [userId]);
    return result.rowCount ?? 0;
  }

  async function userStatus(tenantId: string, email: string): Promise<string | undefined> {
    return (await catalogSync.getUser({ tenantId, email }))?.status;
  }

  async function signIn(email: string, password: string): Promise<Response> {
    return (auth as unknown as { handler: (r: Request) => Promise<Response> }).handler(
      new Request(`${AUTH_BASE_URL}/sign-in/email`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': randomIp(),
          origin: 'http://localhost:3000',
        },
        body: JSON.stringify({ email, password }),
      }),
    );
  }

  async function acceptedEvents(invitationId: string) {
    await harness.forceFlush();
    return [...harness.logExporter.getFinishedLogRecords()].filter(
      (record) =>
        record.eventName === ACCEPTED_EVENT &&
        record.attributes['tayzu.identity.invitation.id'] === invitationId,
    );
  }

  it('A new person accepts and can then sign in: verified email, global role user, membership with the invited role, Active _user and no session', async () => {
    const tenant = await freshTenant();
    const email = `bob-${randomUUID()}@example.test`;
    const invitation = await invite(tenant, email, 'admin');

    // GIVEN a pending invitation to a person with no account.
    expect(await userByEmail(email)).toBeUndefined();

    // WHEN they present the invitation id, the token and a policy-compliant password.
    const { userId } = await acceptFlow.accept({ ...invitation, password: PASSWORD_NFC });

    // THEN they have an account with a verified email and the global role `user`...
    const user = await userByEmail(email);
    expect(user?.id).toBe(userId);
    expect(user?.emailVerified).toBe(true);
    expect(user?.role).toBe('user');
    // ...a membership with the invited role and the status `Active`...
    const memberships = await members(tenant.tenantId, userId);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.role).toBe('admin');
    expect(await userStatus(tenant.tenantId, email)).toBe('Active');
    // ...and no session exists.
    expect(await sessionCount(userId), 'the acceptance creates no session').toBe(0);
  }, 60_000);

  it('A new person accepts and can then sign in: sign-in through the normal route succeeds afterward, also with the password in its NFD form', async () => {
    const tenant = await freshTenant();
    const email = `bob-${randomUUID()}@example.test`;
    const invitation = await invite(tenant, email);
    const { userId } = await acceptFlow.accept({ ...invitation, password: PASSWORD_NFC });
    expect(PASSWORD_NFD).not.toBe(PASSWORD_NFC);

    const nfc = await signIn(email, PASSWORD_NFC);
    const nfd = await signIn(email, PASSWORD_NFD);

    expect(nfc.status, 'sign-in with the password as supplied').toBe(200);
    expect(nfd.status, 'sign-in with the NFD form of the password').toBe(200);
    expect(await sessionCount(userId), 'only the sign-ins created sessions').toBe(2);
  }, 60_000);

  it('A failed `_user` write undoes the acceptance: no user, no member, the _user still Invited, the token still verifies, the sanitized INTERNAL answer, and a retry with the same token succeeds', async () => {
    const tenant = await freshTenant();
    const email = `bob-${randomUUID()}@example.test`;
    const invitation = await invite(tenant, email);

    // GIVEN a `_user` write that fails.
    failingUserWrites.add(tenant.tenantId);
    let failure: { code: string } | undefined;
    try {
      await acceptFlow.accept({ ...invitation, password: PASSWORD_NFC });
    } catch (error) {
      failure = toOrpcError(error);
    }

    // THEN the answer is the sanitized generic server error...
    expect(failure?.code).toBe('INTERNAL');
    // ...no user and no membership exist, the `_user` keeps `Invited`, and the token still verifies...
    expect(await userByEmail(email), 'no user').toBeUndefined();
    const count = await authPool.query(`select 1 from auth.member where organization_id = $1`, [
      tenant.tenantId,
    ]);
    expect(count.rowCount, 'only the inviting admin is a member').toBe(1);
    expect(await userStatus(tenant.tenantId, email)).toBe('Invited');
    expect(await tokenStillVerifies(invitation)).toBe(true);
    expect(
      await acceptedEvents(invitation.invitationId),
      'a failed attempt is no audit event',
    ).toHaveLength(0);

    // AND a retry with the same token succeeds.
    failingUserWrites.delete(tenant.tenantId);
    const result = await acceptFlow.accept({ ...invitation, password: PASSWORD_NFC });
    expect((await userByEmail(email))?.id).toBe(result.userId);
    expect(await members(tenant.tenantId, result.userId)).toHaveLength(1);
    expect(await userStatus(tenant.tenantId, email)).toBe('Active');
  }, 60_000);

  it('A successful acceptance emits catalog.audit.invitation_accepted with tayzu.actor.type user and tayzu.actor.id the new user id, the same value as tayzu.identity.user.id (Q116)', async () => {
    const tenant = await freshTenant();
    const email = `bob-${randomUUID()}@example.test`;
    const invitation = await invite(tenant, email);

    const { userId } = await acceptFlow.accept({ ...invitation, password: PASSWORD_NFC });

    const logged = await acceptedEvents(invitation.invitationId);
    expect(logged, 'one audit event').toHaveLength(1);
    const attributes = logged[0]?.attributes;
    expect(attributes?.['tayzu.actor.type']).toBe('user');
    expect(attributes?.['tayzu.actor.id']).toBe(userId);
    expect(attributes?.['tayzu.identity.user.id']).toBe(userId);
    expect(attributes?.['tayzu.tenant.id']).toBe(tenant.tenantId);
  }, 60_000);
});

/**
 * Task 8.3 (spec "Invitation acceptance"; design D4 steps 1, 4 and 5; Resolved
 * decisions Q89 and Q123).
 *
 * Scenarios:
 * - "A new person accepts and can then sign in" (its AND clause): the invitation
 *   is `accepted` and the token cannot be used a second time.
 * - "A replayed acceptance is recorded as already accepted".
 * - The requirement's single use: two concurrent attempts, exactly one succeeds
 *   and the loser answers the uniform rejection with `consume_conflict`; the
 *   `accepted` status is written in the same transaction as the token delete; an
 *   `accepted` write that changes no row fails as a lost race.
 *
 * ## Production symbols expected
 *
 * - `apps/api/src/identity/auth-repository.ts`: `AuthRepository.markInvitationAccepted(
 *   tenantId: string, invitationId: string): Promise<boolean>`, the third tenant-keyed
 *   write of 5.1b. It requires a `tenantId` (throws without one), filters by
 *   `organization_id` and the invitation id, updates only while the status is
 *   `pending`, and resolves true when a row changed.
 * - `apps/api/src/identity/accept-flow.ts`: the token delete conditioned on its digest
 *   and the `accepted` write run in one short `authPool` transaction. A new `onStep`
 *   name, `consume_in_transaction`, is awaited inside that transaction after the token
 *   delete and before the commit; a throw rolls the transaction back.
 * - A replay (the invitation's status is `accepted`) logs
 *   `catalog.security.invitation_acceptance_denied` with
 *   `tayzu.identity.invitation.denial_reason` `already_accepted` and answers
 *   `CATALOG_NOT_FOUND`.
 */
describe('single-use token and the accepted status (task 8.3, Resolved decision Q123)', () => {
  const DENIED_EVENT = 'catalog.security.invitation_acceptance_denied';
  const REASON = 'tayzu.identity.invitation.denial_reason';

  let harness: TelemetryTestHarness;
  let authPool: Pool;
  let auth: AuthInstance;
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
    const cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    adapter = createUserSyncAdapter({
      userSync: createUserSync({ pool: pools.appPool, authz: cerbos }),
    });
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync: adapter,
    });
    repository = createAuthRepository(authPool);
  }, 60_000);

  type StepSeam = (step: string) => void | Promise<void>;

  function flowWith(onStep?: StepSeam) {
    return createAcceptFlow({
      auth,
      authRepository: repository,
      authPool,
      userSync: adapter,
      ...(onStep === undefined ? {} : { onStep }),
    });
  }

  async function freshTenant(): Promise<Tenant> {
    const id = randomUUID();
    const t = await bootstrapTestTenant(auth, {
      name: 'Accept Admin',
      email: `accept-admin-${id}@example.test`,
      password: TEST_PASSWORD,
      organizationName: 'Accept Org',
      organizationSlug: `accept-${id}`,
      ip: randomIp(),
    });
    return { tenantId: t.organizationId, adminId: t.userId, cookie: t.cookie };
  }

  async function invite(tenant: Tenant, email: string): Promise<Invitation> {
    const api = auth.api as InviteApiSurface;
    const invitation = await runWithIdentityContext({ adminId: tenant.adminId }, () =>
      api.createInvitation({
        body: { email, role: 'member', organizationId: tenant.tenantId },
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

  async function existingAccount(email: string): Promise<{ userId: string; sessionId: string }> {
    const created = await createAdminUser(auth, {
      name: 'Existing Account',
      email,
      password: TEST_PASSWORD,
    });
    return { userId: created.userId, sessionId: randomUUID() };
  }

  async function tokenRowCount(invitationId: string): Promise<number> {
    const result = await authPool.query(`select 1 from auth.verification where identifier = $1`, [
      `invitation-accept:${invitationId}`,
    ]);
    return result.rowCount ?? 0;
  }

  async function statusOf(invitationId: string): Promise<string | undefined> {
    const result = await authPool.query<{ status: string }>(
      `select status from auth.invitation where id = $1`,
      [invitationId],
    );
    return result.rows[0]?.status;
  }

  async function memberCount(tenantId: string): Promise<number> {
    const result = await authPool.query(`select 1 from auth.member where organization_id = $1`, [
      tenantId,
    ]);
    return result.rowCount ?? 0;
  }

  async function deniedReasons(invitationId: string): Promise<readonly unknown[]> {
    await harness.forceFlush();
    return [...harness.logExporter.getFinishedLogRecords()]
      .filter(
        (record) =>
          record.eventName === DENIED_EVENT &&
          record.attributes['tayzu.identity.invitation.id'] === invitationId,
      )
      .map((record) => record.attributes[REASON]);
  }

  async function failureOf(attempt: Promise<unknown>): Promise<{ code: string } | undefined> {
    try {
      await attempt;
      return undefined;
    } catch (error) {
      return toOrpcError(error);
    }
  }

  it('A new person accepts and can then sign in: the invitation is accepted and the token cannot be used a second time', async () => {
    const tenant = await freshTenant();
    const email = `bob-${randomUUID()}@example.test`;
    const invitation = await invite(tenant, email);
    expect(await statusOf(invitation.invitationId)).toBe('pending');

    await flowWith().accept({ ...invitation, password: PASSWORD_NFC });

    expect(await statusOf(invitation.invitationId)).toBe('accepted');
    expect(await tokenRowCount(invitation.invitationId), 'the token row is consumed').toBe(0);
    const second = await failureOf(flowWith().accept({ ...invitation, password: PASSWORD_NFC }));
    expect(second?.code, 'the second use of the token fails').toBe('CATALOG_NOT_FOUND');
  }, 60_000);

  it('A replayed acceptance is recorded as already accepted: the uniform rejection, the reason already_accepted (not token_mismatch) and nothing changes', async () => {
    const tenant = await freshTenant();
    const email = `bob-${randomUUID()}@example.test`;
    const invitation = await invite(tenant, email);
    const { userId } = await flowWith().accept({ ...invitation, password: PASSWORD_NFC });
    const members = await memberCount(tenant.tenantId);

    // WHEN the same acceptance request is sent again.
    const replay = await failureOf(flowWith().accept({ ...invitation, password: PASSWORD_NFC }));

    // THEN the uniform rejection, recorded as `already_accepted`, with nothing changed.
    expect(replay?.code).toBe('CATALOG_NOT_FOUND');
    expect(await deniedReasons(invitation.invitationId)).toEqual(['already_accepted']);
    expect(await statusOf(invitation.invitationId)).toBe('accepted');
    expect(await memberCount(tenant.tenantId)).toBe(members);
    const users = await authPool.query(`select 1 from auth."user" where email = $1`, [email]);
    expect(users.rowCount).toBe(1);
    const rows = await authPool.query(`select 1 from auth.member where user_id = $1`, [userId]);
    expect(rows.rowCount).toBe(1);
  }, 60_000);

  it('two concurrent attempts: exactly one succeeds and the loser, held before its consumption until the winner committed, answers the uniform rejection with consume_conflict', async () => {
    const tenant = await freshTenant();
    const email = `carol-${randomUUID()}@example.test`;
    const carol = await existingAccount(email);
    const invitation = await invite(tenant, email);

    // GIVEN the loser reaches its consumption first and is held there.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached: () => void = () => undefined;
    const loserAtConsume = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const loser = failureOf(
      flowWith(async (step) => {
        if (step !== 'consume') return;
        reached();
        await held;
      }).accept({ ...invitation, session: carol }),
    );
    await loserAtConsume;

    // WHEN the winner runs to completion and the loser is released.
    const winner = await failureOf(flowWith().accept({ ...invitation, session: carol }));
    release();
    const lost = await loser;

    // THEN exactly one succeeded and the loser answered the uniform rejection.
    expect(winner, 'the winner succeeds').toBeUndefined();
    expect(lost?.code).toBe('CATALOG_NOT_FOUND');
    expect(await deniedReasons(invitation.invitationId)).toEqual(['consume_conflict']);
    expect(await statusOf(invitation.invitationId)).toBe('accepted');
    expect(await tokenRowCount(invitation.invitationId)).toBe(0);
  }, 60_000);

  it('the accepted status is written in the same transaction as the token delete: a failure after the delete leaves the token row in place and the invitation pending', async () => {
    const tenant = await freshTenant();
    const email = `carol-${randomUUID()}@example.test`;
    const carol = await existingAccount(email);
    const invitation = await invite(tenant, email);

    const failure = await failureOf(
      flowWith((step) => {
        if (step === 'consume_in_transaction') throw new Error('injected failure');
      }).accept({ ...invitation, session: carol }),
    );

    expect(failure, 'the attempt fails').toBeDefined();
    expect(await tokenRowCount(invitation.invitationId), 'the delete was rolled back').toBe(1);
    expect(await statusOf(invitation.invitationId)).toBe('pending');
  }, 60_000);

  it('a consumption whose accepted write changes no row (the invitation cancelled after the token verified) leaves the token row and the cancelled status untouched and fails as a lost race', async () => {
    const tenant = await freshTenant();
    const email = `carol-${randomUUID()}@example.test`;
    const carol = await existingAccount(email);
    const invitation = await invite(tenant, email);

    // GIVEN a cancellation that commits after the token verified.
    const failure = await failureOf(
      flowWith(async (step) => {
        if (step !== 'add_member') return;
        await authPool.query(`update auth.invitation set status = 'canceled' where id = $1`, [
          invitation.invitationId,
        ]);
      }).accept({ ...invitation, session: carol }),
    );

    // THEN the same answer and reason as a lost race, and the consumption changed nothing.
    expect(failure?.code).toBe('CATALOG_NOT_FOUND');
    expect(await deniedReasons(invitation.invitationId)).toEqual(['consume_conflict']);
    expect(await tokenRowCount(invitation.invitationId), 'the token row stays').toBe(1);
    expect(await statusOf(invitation.invitationId)).toBe('canceled');
  }, 60_000);

  describe('the repository write markInvitationAccepted', () => {
    async function seedInvitation(tenantId: string, status = 'pending'): Promise<string> {
      const inviterId = `usr-${randomUUID()}`;
      await authPool.query(
        `insert into auth."user" (id, name, email, email_verified, created_at, updated_at)
         values ($1, 'Inviter', $2, true, now(), now())`,
        [inviterId, `inviter-${randomUUID()}@example.test`],
      );
      const id = `inv-${randomUUID()}`;
      await authPool.query(
        `insert into auth.invitation (id, organization_id, email, role, status, expires_at, created_at, inviter_id)
         values ($1, $2, $3, 'member', $4, now() + interval '1 day', now(), $5)`,
        [id, tenantId, `invitee-${randomUUID()}@example.test`, status, inviterId],
      );
      return id;
    }

    async function seedTenant(): Promise<string> {
      const id = `org-${randomUUID()}`;
      await authPool.query(
        'insert into auth.organization (id, name, slug, created_at) values ($1, $2, $3, now())',
        [id, 'Org', `slug-${id}`],
      );
      return id;
    }

    it('sets pending to accepted once, and only while the status is still pending', async () => {
      const tenantId = await seedTenant();
      const pending = await seedInvitation(tenantId);
      const cancelled = await seedInvitation(tenantId, 'canceled');

      expect(await repository.markInvitationAccepted(tenantId, pending)).toBe(true);
      expect(await statusOf(pending)).toBe('accepted');
      expect(await repository.markInvitationAccepted(tenantId, pending), 'a second write').toBe(
        false,
      );
      expect(await repository.markInvitationAccepted(tenantId, cancelled)).toBe(false);
      expect(await statusOf(cancelled)).toBe('canceled');
    });

    it('changes no invitation of another tenant', async () => {
      const tenantId = await seedTenant();
      const otherTenantId = await seedTenant();
      const invitationId = await seedInvitation(otherTenantId);

      expect(await repository.markInvitationAccepted(tenantId, invitationId)).toBe(false);
      expect(await statusOf(invitationId)).toBe('pending');
    });

    it('refuses a call without a tenantId', async () => {
      const tenantId = await seedTenant();
      const invitationId = await seedInvitation(tenantId);
      const call = (...args: unknown[]): Promise<unknown> =>
        Promise.resolve().then(() =>
          (repository.markInvitationAccepted as (...a: unknown[]) => unknown)(...args),
        );

      for (const bad of ['', undefined, null]) {
        await expect(call(bad, invitationId)).rejects.toThrow('a tenantId is required');
      }
      expect(await statusOf(invitationId)).toBe('pending');
    });
  });
});

/**
 * Task 8.4 (spec "Invitation acceptance", scenario "The tenant comes from the
 * invitation"; design D4 "Acceptance", Observability contract).
 *
 * Scenarios:
 * - "The tenant comes from the invitation": a body that carries `tenantId` or
 *   `actor` (and `role`, `email`, `organizationId`, `userId`, or a forbidden
 *   `__proto__`, `constructor`, `prototype` key) is rejected with
 *   `CATALOG_VALIDATION_FAILED`, nothing is created, and
 *   `catalog.security.invitation_acceptance_denied` is logged with the reason
 *   `malformed_request`. A valid body acts on the invitation's own tenant.
 * - An over-long or malformed invitation id is never logged as its value: the
 *   `tayzu.identity.invitation.id` of the `identity.invitation.accept` span and of
 *   the denied event is the constant `invalid`.
 *
 * ## Production symbols expected
 *
 * `apps/api/src/identity/accept-flow.ts`: `createAcceptFlow(...)` also returns
 * `acceptRequest(request: { body: unknown; session?: { userId: string;
 * sessionId: string } }): Promise<{ userId: string }>`, the service function behind
 * the public route. It parses `request.body` (the raw JSON value) as an allowlist of
 * exactly `invitationId`, `token` and, optionally, `password`, into null-prototype
 * objects, through the shared parser of `parse-input.ts` (`parseIdentityInput` with a
 * `body` section), checking shape and length of the id before any lookup or logging,
 * and then runs `accept`. A rejected body or id shape throws the
 * `CATALOG_VALIDATION_FAILED` input error, emits the denied event with
 * `tayzu.identity.invitation.denial_reason` `malformed_request` and
 * `tayzu.identity.invitation.id` `invalid`, and runs inside a span
 * `identity.invitation.accept` whose `tayzu.identity.invitation.id` is `invalid` in
 * that case (and the real id otherwise).
 */
describe('the accept body is an allowlist and the tenant comes from the invitation (task 8.4)', () => {
  const DENIED_EVENT = 'catalog.security.invitation_acceptance_denied';
  const REASON = 'tayzu.identity.invitation.denial_reason';
  const ACCEPT_SPAN = 'identity.invitation.accept';

  let harness: TelemetryTestHarness;
  let authPool: Pool;
  let auth: AuthInstance;
  let catalogSync: UserSync;
  let flow: ReturnType<typeof createAcceptFlow>;

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
    catalogSync = createUserSync({ pool: pools.appPool, authz: cerbos });
    const adapter = createUserSyncAdapter({ userSync: catalogSync });
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync: adapter,
    });
    flow = createAcceptFlow({
      auth,
      authRepository: createAuthRepository(authPool),
      authPool,
      userSync: adapter,
    });
  }, 60_000);

  async function freshTenant(): Promise<Tenant> {
    const id = randomUUID();
    const t = await bootstrapTestTenant(auth, {
      name: 'Accept Admin',
      email: `accept-admin-${id}@example.test`,
      password: TEST_PASSWORD,
      organizationName: 'Accept Org',
      organizationSlug: `accept-${id}`,
      ip: randomIp(),
    });
    return { tenantId: t.organizationId, adminId: t.userId, cookie: t.cookie };
  }

  async function invite(tenant: Tenant, email: string): Promise<Invitation> {
    const api = auth.api as InviteApiSurface;
    const invitation = await runWithIdentityContext({ adminId: tenant.adminId }, () =>
      api.createInvitation({
        body: { email, role: 'member', organizationId: tenant.tenantId },
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

  async function failureOf(attempt: Promise<unknown>): Promise<{ code: string } | undefined> {
    try {
      await attempt;
      return undefined;
    } catch (error) {
      return toOrpcError(error);
    }
  }

  async function count(sql: string, params: readonly unknown[]): Promise<number> {
    const result = await authPool.query(sql, [...params]);
    return result.rowCount ?? 0;
  }

  async function deniedRecords() {
    await harness.forceFlush();
    return [...harness.logExporter.getFinishedLogRecords()].filter(
      (record) => record.eventName === DENIED_EVENT,
    );
  }

  async function malformedCount(): Promise<number> {
    return (await deniedRecords()).filter(
      (record) => record.attributes[REASON] === 'malformed_request',
    ).length;
  }

  async function acceptSpans() {
    await harness.forceFlush();
    return harness.spanExporter.getFinishedSpans().filter((span) => span.name === ACCEPT_SPAN);
  }

  async function everythingEmitted(): Promise<string> {
    await harness.forceFlush();
    const logs = [...harness.logExporter.getFinishedLogRecords()].map((record) => ({
      eventName: record.eventName,
      body: record.body,
      attributes: record.attributes,
    }));
    const spans = harness.spanExporter.getFinishedSpans().map((span) => ({
      name: span.name,
      attributes: span.attributes,
      events: span.events.map((event) => ({ name: event.name, attributes: event.attributes })),
    }));
    return JSON.stringify({ logs, spans });
  }

  it('The tenant comes from the invitation: a valid body (id, token, password only) joins the invitation’s own tenant and no other', async () => {
    const tenant = await freshTenant();
    const other = await freshTenant();
    const email = `bob-${randomUUID()}@example.test`;
    const invitation = await invite(tenant, email);

    const { userId } = await flow.acceptRequest({
      body: { ...invitation, password: PASSWORD_NFC },
    });

    const inTenant = await count(
      `select 1 from auth.member where organization_id = $1 and user_id = $2`,
      [tenant.tenantId, userId],
    );
    const inOther = await count(
      `select 1 from auth.member where organization_id = $1 and user_id = $2`,
      [other.tenantId, userId],
    );
    expect(inTenant, 'a member of the invitation’s tenant').toBe(1);
    expect(inOther, 'no member of any other tenant').toBe(0);
    expect((await catalogSync.getUser({ tenantId: tenant.tenantId, email }))?.status).toBe(
      'Active',
    );
  }, 60_000);

  const extraFields: readonly (readonly [string, unknown])[] = [
    ['tenantId', 'any-tenant'],
    ['actor', { type: 'user', id: 'someone' }],
    ['role', 'admin'],
    ['email', 'someone-else@example.test'],
    ['organizationId', 'any-organization'],
    ['userId', 'any-user'],
  ];

  it.each(extraFields)(
    'The tenant comes from the invitation: a body carrying %s is rejected with CATALOG_VALIDATION_FAILED, nothing is created and malformed_request is logged',
    async (field, value) => {
      const tenant = await freshTenant();
      const email = `bob-${randomUUID()}@example.test`;
      const invitation = await invite(tenant, email);
      const members = await count(`select 1 from auth.member where organization_id = $1`, [
        tenant.tenantId,
      ]);
      const before = await malformedCount();

      const failure = await failureOf(
        flow.acceptRequest({ body: { ...invitation, password: PASSWORD_NFC, [field]: value } }),
      );

      expect(failure?.code).toBe('CATALOG_VALIDATION_FAILED');
      expect(await count(`select 1 from auth."user" where email = $1`, [email]), 'no user').toBe(0);
      expect(
        await count(`select 1 from auth.member where organization_id = $1`, [tenant.tenantId]),
        'no member',
      ).toBe(members);
      expect(
        await count(`select 1 from auth.verification where identifier = $1`, [
          `invitation-accept:${invitation.invitationId}`,
        ]),
        'the token row stays',
      ).toBe(1);
      expect(
        await count(`select 1 from auth.invitation where id = $1 and status = 'pending'`, [
          invitation.invitationId,
        ]),
        'the invitation stays pending',
      ).toBe(1);
      expect((await catalogSync.getUser({ tenantId: tenant.tenantId, email }))?.status).toBe(
        'Invited',
      );
      expect(await malformedCount(), 'one malformed_request denial').toBe(before + 1);
    },
    60_000,
  );

  it.each(['__proto__', 'constructor', 'prototype'])(
    'The tenant comes from the invitation: a %s key, at the top level or nested, is rejected with CATALOG_VALIDATION_FAILED and nothing is created',
    async (key) => {
      const tenant = await freshTenant();
      const email = `bob-${randomUUID()}@example.test`;
      const invitation = await invite(tenant, email);
      const before = await malformedCount();
      const json = JSON.stringify({ ...invitation, password: PASSWORD_NFC });
      // JSON.parse creates an own `__proto__` key, as a request body would.
      const top = JSON.parse(`${json.slice(0, -1)},${JSON.stringify(key)}:{"a":1}}`) as unknown;
      const nested = JSON.parse(
        `${json.slice(0, -1)},"token2":{"x":{${JSON.stringify(key)}:{}}}}`,
      ) as unknown;
      const nestedInField = JSON.parse(
        JSON.stringify({ ...invitation }).slice(0, -1) +
          `,"password":{"x":{${JSON.stringify(key)}:{}}}}`,
      ) as unknown;

      for (const body of [top, nested, nestedInField]) {
        const failure = await failureOf(flow.acceptRequest({ body }));
        expect(failure?.code).toBe('CATALOG_VALIDATION_FAILED');
      }

      expect(await count(`select 1 from auth."user" where email = $1`, [email])).toBe(0);
      expect(
        await count(`select 1 from auth.invitation where id = $1 and status = 'pending'`, [
          invitation.invitationId,
        ]),
      ).toBe(1);
      expect(await malformedCount()).toBe(before + 3);
    },
    60_000,
  );

  it('The tenant comes from the invitation: a body that is not an object, or that lacks the id or the token, is rejected with CATALOG_VALIDATION_FAILED', async () => {
    const tenant = await freshTenant();
    const invitation = await invite(tenant, `bob-${randomUUID()}@example.test`);

    for (const body of [
      null,
      'text',
      [invitation],
      { token: invitation.token },
      { invitationId: invitation.invitationId },
    ]) {
      const failure = await failureOf(flow.acceptRequest({ body }));
      expect(failure?.code).toBe('CATALOG_VALIDATION_FAILED');
    }
  }, 60_000);

  it('an over-long or malformed invitation id never appears in a log record or span, the id attribute being invalid', async () => {
    const marker = `evil-${randomUUID()}`;
    const ids = [
      `${marker}${'x'.repeat(10_000)}`,
      `${marker}/../../etc/passwd;drop table "user"; --`,
      `${marker} <script>alert(1)</script>\n`,
    ];
    const spansBefore = (await acceptSpans()).length;
    const deniedBefore = (await deniedRecords()).length;

    for (const invitationId of ids) {
      const failure = await failureOf(
        flow.acceptRequest({
          body: { invitationId, token: generateInvitationToken(), password: PASSWORD_NFC },
        }),
      );
      expect(failure?.code).toBe('CATALOG_VALIDATION_FAILED');
    }

    // THEN the value is nowhere in what was emitted...
    expect(await everythingEmitted()).not.toContain(marker);
    // ...the denied events carry the reason malformed_request and the constant id...
    const denied = (await deniedRecords()).slice(deniedBefore);
    expect(denied).toHaveLength(ids.length);
    for (const record of denied) {
      expect(record.attributes[REASON]).toBe('malformed_request');
      expect(record.attributes['tayzu.identity.invitation.id']).toBe('invalid');
    }
    // ...and so do the spans.
    const spans = (await acceptSpans()).slice(spansBefore);
    expect(spans).toHaveLength(ids.length);
    for (const span of spans) {
      expect(span.attributes['tayzu.identity.invitation.id']).toBe('invalid');
    }
  }, 60_000);
});

/**
 * Task 8.5 (spec "Invitation acceptance", scenario "Acceptance does not touch an
 * existing account"; Resolved decisions Q18 and Q24).
 *
 * - GIVEN a pending invitation to an email that already has an account, WHEN it is
 *   accepted with its valid token and a password, without a session, THEN the
 *   existing account's password is unchanged, no password is set, and the answer is
 *   the uniform rejection (`CATALOG_NOT_FOUND`). A `password` in the body is ignored.
 *
 * ## Production symbols expected
 *
 * None new: `createAcceptFlow(...).accept` and `.acceptRequest` of
 * `apps/api/src/identity/accept-flow.ts`. Without a session of the existing account
 * they answer the uniform rejection and write nothing.
 */
describe('Acceptance does not touch an existing account (task 8.5, Resolved decisions Q18 and Q24)', () => {
  let authPool: Pool;
  let auth: AuthInstance;
  let catalogSync: UserSync;
  let flow: ReturnType<typeof createAcceptFlow>;

  beforeAll(async () => {
    const pools = await harnessPools();
    authPool = pools.authPool;
    await runMigrations(authPool);
    const cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    catalogSync = createUserSync({ pool: pools.appPool, authz: cerbos });
    const adapter = createUserSyncAdapter({ userSync: catalogSync });
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync: adapter,
    });
    flow = createAcceptFlow({
      auth,
      authRepository: createAuthRepository(authPool),
      authPool,
      userSync: adapter,
    });
  }, 60_000);

  async function freshTenant(): Promise<Tenant> {
    const id = randomUUID();
    const t = await bootstrapTestTenant(auth, {
      name: 'Accept Admin',
      email: `accept-admin-${id}@example.test`,
      password: TEST_PASSWORD,
      organizationName: 'Accept Org',
      organizationSlug: `accept-${id}`,
      ip: randomIp(),
    });
    return { tenantId: t.organizationId, adminId: t.userId, cookie: t.cookie };
  }

  async function invite(tenant: Tenant, email: string): Promise<Invitation> {
    const api = auth.api as InviteApiSurface;
    const invitation = await runWithIdentityContext({ adminId: tenant.adminId }, () =>
      api.createInvitation({
        body: { email, role: 'member', organizationId: tenant.tenantId },
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

  async function failureOf(attempt: Promise<unknown>): Promise<{ code: string } | undefined> {
    try {
      await attempt;
      return undefined;
    } catch (error) {
      return toOrpcError(error);
    }
  }

  async function count(sql: string, params: readonly unknown[]): Promise<number> {
    const result = await authPool.query(sql, [...params]);
    return result.rowCount ?? 0;
  }

  async function accounts(userId: string): Promise<readonly string[]> {
    const result = await authPool.query<{ provider_id: string; password: string | null }>(
      `select provider_id, password from auth.account where user_id = $1 order by id`,
      [userId],
    );
    return result.rows.map((row) => `${row.provider_id}:${row.password ?? ''}`);
  }

  async function signIn(email: string, password: string): Promise<number> {
    const response = await (
      auth as unknown as { handler: (r: Request) => Promise<Response> }
    ).handler(
      new Request(`${AUTH_BASE_URL}/sign-in/email`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': randomIp(),
          origin: 'http://localhost:3000',
        },
        body: JSON.stringify({ email, password }),
      }),
    );
    return response.status;
  }

  const NEW_PASSWORD = 'Another-Passphrase-For-Mallory-2026!';

  async function scenario() {
    const tenant = await freshTenant();
    const email = `carol-${randomUUID()}@example.test`;
    const existing = await createAdminUser(auth, {
      name: 'Existing Account',
      email,
      password: TEST_PASSWORD,
    });
    const invitation = await invite(tenant, email);
    return { tenant, email, userId: existing.userId, invitation };
  }

  async function expectUntouched(
    s: Awaited<ReturnType<typeof scenario>>,
    before: readonly string[],
  ) {
    expect(await accounts(s.userId), 'the accounts and the password hash are unchanged').toEqual(
      before,
    );
    expect(await signIn(s.email, TEST_PASSWORD), 'the old password still signs in').toBe(200);
    expect(await signIn(s.email, NEW_PASSWORD), 'the body password was not set').not.toBe(200);
    expect(
      await count(`select 1 from auth.member where organization_id = $1 and user_id = $2`, [
        s.tenant.tenantId,
        s.userId,
      ]),
      'no membership',
    ).toBe(0);
    expect(
      await count(`select 1 from auth.verification where identifier = $1`, [
        `invitation-accept:${s.invitation.invitationId}`,
      ]),
      'the token row stays',
    ).toBe(1);
    expect(
      await count(`select 1 from auth.invitation where id = $1 and status = 'pending'`, [
        s.invitation.invitationId,
      ]),
      'the invitation stays pending',
    ).toBe(1);
    expect(
      (await catalogSync.getUser({ tenantId: s.tenant.tenantId, email: s.email }))?.status,
    ).toBe('Invited');
  }

  it('Acceptance does not touch an existing account: with the valid token and a password, without a session, the account is unchanged and the answer is the uniform rejection', async () => {
    const s = await scenario();
    const before = await accounts(s.userId);
    expect(before).toHaveLength(1);

    const failure = await failureOf(flow.accept({ ...s.invitation, password: NEW_PASSWORD }));

    expect(failure?.code).toBe('CATALOG_NOT_FOUND');
    await expectUntouched(s, before);
  }, 60_000);

  it('Acceptance does not touch an existing account: a password in the request body is ignored and the answer is the uniform rejection', async () => {
    const s = await scenario();
    const before = await accounts(s.userId);

    const failure = await failureOf(
      flow.acceptRequest({ body: { ...s.invitation, password: NEW_PASSWORD } }),
    );

    expect(failure?.code).toBe('CATALOG_NOT_FOUND');
    await expectUntouched(s, before);
  }, 60_000);

  it('Acceptance does not touch an existing account: without a password either, the answer is the same uniform rejection', async () => {
    const s = await scenario();
    const before = await accounts(s.userId);

    const failure = await failureOf(flow.acceptRequest({ body: { ...s.invitation } }));

    expect(failure?.code).toBe('CATALOG_NOT_FOUND');
    await expectUntouched(s, before);
  }, 60_000);
});

/**
 * Task 8.5b (spec "Invitation acceptance", scenario "An existing account accepts
 * with its session"; Resolved decisions Q38, Q112, Q116 and Q120).
 *
 * - GIVEN a pending invitation to `carol`, who has an account, a session and no
 *   SSO link she did not make, WHEN she presents the token with her session, THEN
 *   she gains the membership with the invited role and her `_user` becomes
 *   `Active`, her email is marked verified (it was not), her password, session,
 *   active organization and linked accounts are unchanged, and the response has
 *   the same status and shape as a new person's acceptance.
 * - The `_user` of the tenant is written once, by the acceptance's own `_user` step
 *   and after the shed step (a recording of the two steps and of the write).
 * - `catalog.audit.invitation_accepted` names the invitee on this path too
 *   (`tayzu.actor.type` `user`, `tayzu.actor.id` her Better Auth user id, Q116).
 *
 * ## Production symbols expected
 *
 * None new: `createAcceptFlow(...).accept` of `apps/api/src/identity/accept-flow.ts`
 * emits `catalog.audit.invitation_accepted` also on the existing-account path (with
 * the same attributes as the new-account path, the actor being the invitee).
 */
describe('An existing account accepts with its session (task 8.5b, Resolved decisions Q38, Q112 and Q116)', () => {
  const ACCEPTED = 'catalog.audit.invitation_accepted';

  let harness: TelemetryTestHarness;
  let authPool: Pool;
  let auth: AuthInstance;
  let catalogSync: UserSync;
  let adapter: ReturnType<typeof createUserSyncAdapter>;
  const log: string[] = [];

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
    const base = createUserSync({ pool: pools.appPool, authz: cerbos });
    catalogSync = {
      getUser: (input) => base.getUser(input),
      upsertUser: async (input) => {
        await base.upsertUser(input);
        log.push(`write:${input.tenantId}:${input.email}:${String(input.status)}`);
      },
    };
    adapter = createUserSyncAdapter({ userSync: catalogSync });
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync: adapter,
    });
  }, 60_000);

  async function freshTenant(): Promise<Tenant> {
    const id = randomUUID();
    const t = await bootstrapTestTenant(auth, {
      name: 'Accept Admin',
      email: `accept-admin-${id}@example.test`,
      password: TEST_PASSWORD,
      organizationName: 'Accept Org',
      organizationSlug: `accept-${id}`,
      ip: randomIp(),
    });
    return { tenantId: t.organizationId, adminId: t.userId, cookie: t.cookie };
  }

  async function invite(
    tenant: Tenant,
    email: string,
    role: 'member' | 'admin' = 'member',
  ): Promise<Invitation> {
    const api = auth.api as InviteApiSurface;
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

  /** Carol: an account that is a member of her `home` tenant, with a real session whose active organization is `home`. */
  async function carolWithSession(home: Tenant, email: string) {
    const created = await createAdminUser(auth, {
      name: 'Carol',
      email,
      password: TEST_PASSWORD,
    });
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
      `select id from auth.session where token = $1`,
      [signedIn.token],
    );
    const sessionId = row.rows[0]?.id;
    if (sessionId === undefined) throw new Error('the session row is missing');
    return { userId: created.userId, sessionId };
  }

  async function snapshot(userId: string, sessionId: string) {
    const accounts = await authPool.query<{ id: string; provider_id: string; password: string }>(
      `select id, provider_id, password from auth.account where user_id = $1 order by id`,
      [userId],
    );
    const sessions = await authPool.query<{
      id: string;
      token: string;
      active_organization_id: string | null;
      expires_at: Date;
    }>(
      `select id, token, active_organization_id, expires_at from auth.session where user_id = $1 order by id`,
      [userId],
    );
    const session = sessions.rows.find((row) => row.id === sessionId);
    return { accounts: accounts.rows, sessions: sessions.rows, session };
  }

  async function emailVerified(userId: string): Promise<boolean | undefined> {
    const result = await authPool.query<{ email_verified: boolean }>(
      `select email_verified from auth."user" where id = $1`,
      [userId],
    );
    return result.rows[0]?.email_verified;
  }

  async function acceptedEvents(invitationId: string) {
    await harness.forceFlush();
    return [...harness.logExporter.getFinishedLogRecords()].filter(
      (record) =>
        record.eventName === ACCEPTED &&
        record.attributes['tayzu.identity.invitation.id'] === invitationId,
    );
  }

  it('An existing account accepts with its session: membership with the invited role, Active _user, verified email, and password, session, active organization and accounts unchanged', async () => {
    const home = await freshTenant();
    const target = await freshTenant();
    const email = `carol-${randomUUID()}@example.test`;
    const carol = await carolWithSession(home, email);
    const invitation = await invite(target, email, 'admin');
    const before = await snapshot(carol.userId, carol.sessionId);
    expect(before.session?.active_organization_id, 'precondition').toBe(home.tenantId);
    expect(before.accounts, 'precondition: one credential account').toHaveLength(1);
    expect(await emailVerified(carol.userId), 'precondition: not verified').toBe(false);

    const flow = createAcceptFlow({
      auth,
      authRepository: createAuthRepository(authPool),
      authPool,
      userSync: adapter,
    });
    const result = await flow.accept({ ...invitation, session: carol });

    // THEN she gains the membership with the invited role and her `_user` is Active...
    expect(result.userId).toBe(carol.userId);
    const member = await authPool.query<{ role: string }>(
      `select role from auth.member where organization_id = $1 and user_id = $2`,
      [target.tenantId, carol.userId],
    );
    expect(member.rows.map((row) => row.role)).toEqual(['admin']);
    expect((await catalogSync.getUser({ tenantId: target.tenantId, email }))?.status).toBe(
      'Active',
    );
    // ...her email is now marked verified...
    expect(await emailVerified(carol.userId)).toBe(true);
    // ...and her password, session, active organization and linked accounts are unchanged.
    const after = await snapshot(carol.userId, carol.sessionId);
    expect(after.accounts).toEqual(before.accounts);
    expect(after.sessions).toEqual(before.sessions);
    expect(after.session?.active_organization_id).toBe(home.tenantId);
  }, 60_000);

  it('An existing account accepts with its session: the response has the same shape as a new person’s acceptance', async () => {
    const target = await freshTenant();
    const home = await freshTenant();
    const flow = createAcceptFlow({
      auth,
      authRepository: createAuthRepository(authPool),
      authPool,
      userSync: adapter,
    });
    const newEmail = `bob-${randomUUID()}@example.test`;
    const created = await flow.accept({
      ...(await invite(target, newEmail)),
      password: PASSWORD_NFC,
    });
    const email = `carol-${randomUUID()}@example.test`;
    const carol = await carolWithSession(home, email);

    const joined = await flow.acceptRequest({
      body: { ...(await invite(target, email)) },
      session: carol,
    });

    expect(Object.keys(joined).sort()).toEqual(Object.keys(created).sort());
    expect(joined.userId).toBe(carol.userId);
  }, 60_000);

  it('An existing account accepts with its session: the _user is written once, by the acceptance’s _user step, after the shed step', async () => {
    const home = await freshTenant();
    const target = await freshTenant();
    const email = `carol-${randomUUID()}@example.test`;
    const carol = await carolWithSession(home, email);
    const invitation = await invite(target, email);

    const start = log.length;
    const prefix = `write:${target.tenantId}:${email}:`;
    const flow = createAcceptFlow({
      auth,
      authRepository: createAuthRepository(authPool),
      authPool,
      userSync: adapter,
      onStep: (step) => {
        if (step === 'shed' || step === 'user_step') log.push(`step:${step}`);
      },
    });
    await flow.accept({ ...invitation, session: carol });

    // One write of the tenant's `_user`, to `Active`, and it follows the two steps in order.
    const recorded = log
      .slice(start)
      .filter((entry) => entry.startsWith('step:') || entry.startsWith(prefix));
    expect(recorded).toEqual(['step:shed', 'step:user_step', `${prefix}Active`]);
  }, 60_000);

  it('An existing account accepts with its session: catalog.audit.invitation_accepted names the invitee as the actor (type user, her Better Auth user id)', async () => {
    const home = await freshTenant();
    const target = await freshTenant();
    const email = `carol-${randomUUID()}@example.test`;
    const carol = await carolWithSession(home, email);
    const invitation = await invite(target, email);
    const flow = createAcceptFlow({
      auth,
      authRepository: createAuthRepository(authPool),
      authPool,
      userSync: adapter,
    });

    await flow.accept({ ...invitation, session: carol });

    const logged = await acceptedEvents(invitation.invitationId);
    expect(logged, 'one audit event').toHaveLength(1);
    const attributes = logged[0]?.attributes;
    expect(attributes?.['tayzu.actor.type']).toBe('user');
    expect(attributes?.['tayzu.actor.id']).toBe(carol.userId);
    expect(attributes?.['tayzu.identity.user.id']).toBe(carol.userId);
    expect(attributes?.['tayzu.tenant.id']).toBe(target.tenantId);
  }, 60_000);
});

/**
 * Task 8.5c (spec "Invitation acceptance", scenario "A session of another account
 * cannot accept"; Resolved decision Q38).
 *
 * - GIVEN a pending invitation to `carol`, WHEN it is accepted with the valid token
 *   and a session of another user, THEN the answer is the uniform rejection and
 *   nothing changes; `catalog.security.invitation_acceptance_denied` records
 *   `tayzu.identity.invitation.denial_reason` `email_mismatch` or `session_required`.
 * - The match is on the email only: an existing account whose email was never
 *   verified accepts successfully (Q38).
 *
 * ## Production symbols expected
 *
 * None new: `createAcceptFlow(...).accept` of `apps/api/src/identity/accept-flow.ts`
 * emits the denied event with the reason `email_mismatch` (a session of another
 * user) or `session_required` (no session) before it answers the uniform rejection.
 */
describe('A session of another account cannot accept (task 8.5c, Resolved decision Q38)', () => {
  const DENIED = 'catalog.security.invitation_acceptance_denied';
  const REASON = 'tayzu.identity.invitation.denial_reason';

  let harness: TelemetryTestHarness;
  let authPool: Pool;
  let auth: AuthInstance;
  let catalogSync: UserSync;
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
    const cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    catalogSync = createUserSync({ pool: pools.appPool, authz: cerbos });
    adapter = createUserSyncAdapter({ userSync: catalogSync });
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync: adapter,
    });
  }, 60_000);

  function flowOf() {
    return createAcceptFlow({
      auth,
      authRepository: createAuthRepository(authPool),
      authPool,
      userSync: adapter,
    });
  }

  async function freshTenant(): Promise<Tenant> {
    const id = randomUUID();
    const t = await bootstrapTestTenant(auth, {
      name: 'Accept Admin',
      email: `accept-admin-${id}@example.test`,
      password: TEST_PASSWORD,
      organizationName: 'Accept Org',
      organizationSlug: `accept-${id}`,
      ip: randomIp(),
    });
    return { tenantId: t.organizationId, adminId: t.userId, cookie: t.cookie };
  }

  async function invite(tenant: Tenant, email: string): Promise<Invitation> {
    const api = auth.api as InviteApiSurface;
    const invitation = await runWithIdentityContext({ adminId: tenant.adminId }, () =>
      api.createInvitation({
        body: { email, role: 'member', organizationId: tenant.tenantId },
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

  /** An account with a real session; its email is never verified. */
  async function accountWithSession(email: string) {
    const created = await createAdminUser(auth, {
      name: 'Account',
      email,
      password: TEST_PASSWORD,
    });
    const signedIn = await signInAdminUser(auth, {
      email,
      password: TEST_PASSWORD,
      ip: randomIp(),
    });
    const row = await authPool.query<{ id: string }>(
      `select id from auth.session where token = $1`,
      [signedIn.token],
    );
    const sessionId = row.rows[0]?.id;
    if (sessionId === undefined) throw new Error('the session row is missing');
    return { userId: created.userId, sessionId };
  }

  async function failureOf(attempt: Promise<unknown>): Promise<{ code: string } | undefined> {
    try {
      await attempt;
      return undefined;
    } catch (error) {
      return toOrpcError(error);
    }
  }

  async function rows(sql: string, params: readonly unknown[]): Promise<number> {
    const result = await authPool.query(sql, [...params]);
    return result.rowCount ?? 0;
  }

  async function deniedReasons(invitationId: string): Promise<unknown[]> {
    await harness.forceFlush();
    return [...harness.logExporter.getFinishedLogRecords()]
      .filter(
        (record) =>
          record.eventName === DENIED &&
          record.attributes['tayzu.identity.invitation.id'] === invitationId,
      )
      .map((record) => record.attributes[REASON]);
  }

  async function expectNothingChanged(
    tenant: Tenant,
    invitation: Invitation,
    email: string,
    carolId: string,
  ) {
    expect(
      await rows(`select 1 from auth.member where organization_id = $1 and user_id = $2`, [
        tenant.tenantId,
        carolId,
      ]),
      'no membership',
    ).toBe(0);
    expect(
      await rows(`select 1 from auth.verification where identifier = $1`, [
        `invitation-accept:${invitation.invitationId}`,
      ]),
      'the token row stays',
    ).toBe(1);
    expect(
      await rows(`select 1 from auth.invitation where id = $1 and status = 'pending'`, [
        invitation.invitationId,
      ]),
      'the invitation stays pending',
    ).toBe(1);
    expect(
      await rows(`select 1 from auth."user" where id = $1 and email_verified = false`, [carolId]),
      'her email is still unverified',
    ).toBe(1);
    expect((await catalogSync.getUser({ tenantId: tenant.tenantId, email }))?.status).toBe(
      'Invited',
    );
  }

  it('A session of another account cannot accept: a different user’s session gets the uniform rejection, a denial reason and no change', async () => {
    const tenant = await freshTenant();
    const email = `carol-${randomUUID()}@example.test`;
    const carol = await createAdminUser(auth, {
      name: 'Carol',
      email,
      password: TEST_PASSWORD,
    });
    const mallory = await accountWithSession(`mallory-${randomUUID()}@example.test`);
    const invitation = await invite(tenant, email);

    const failure = await failureOf(flowOf().accept({ ...invitation, session: mallory }));

    expect(failure?.code).toBe('CATALOG_NOT_FOUND');
    await expectNothingChanged(tenant, invitation, email, carol.userId);
    expect(
      await rows(`select 1 from auth.member where organization_id = $1 and user_id = $2`, [
        tenant.tenantId,
        mallory.userId,
      ]),
      'the other user gains no membership either',
    ).toBe(0);
    const reasons = await deniedReasons(invitation.invitationId);
    expect(reasons).toHaveLength(1);
    expect(['email_mismatch', 'session_required']).toContain(reasons[0]);
  }, 60_000);

  it('A session of another account cannot accept: through the request path too, the answer is the same uniform rejection', async () => {
    const tenant = await freshTenant();
    const email = `carol-${randomUUID()}@example.test`;
    const carol = await createAdminUser(auth, {
      name: 'Carol',
      email,
      password: TEST_PASSWORD,
    });
    const mallory = await accountWithSession(`mallory-${randomUUID()}@example.test`);
    const invitation = await invite(tenant, email);

    const failure = await failureOf(
      flowOf().acceptRequest({ body: { ...invitation }, session: mallory }),
    );

    expect(failure?.code).toBe('CATALOG_NOT_FOUND');
    await expectNothingChanged(tenant, invitation, email, carol.userId);
    expect(['email_mismatch', 'session_required']).toContain(
      (await deniedReasons(invitation.invitationId))[0],
    );
  }, 60_000);

  it('An existing account whose email was never verified accepts successfully with its own session', async () => {
    const tenant = await freshTenant();
    const email = `carol-${randomUUID()}@example.test`;
    const carol = await accountWithSession(email);
    const invitation = await invite(tenant, email);
    expect(
      await rows(`select 1 from auth."user" where id = $1 and email_verified = false`, [
        carol.userId,
      ]),
      'precondition: not verified',
    ).toBe(1);

    const result = await flowOf().accept({ ...invitation, session: carol });

    expect(result.userId).toBe(carol.userId);
    expect(
      await rows(`select 1 from auth.member where organization_id = $1 and user_id = $2`, [
        tenant.tenantId,
        carol.userId,
      ]),
    ).toBe(1);
    expect(await deniedReasons(invitation.invitationId)).toEqual([]);
  }, 60_000);
});
