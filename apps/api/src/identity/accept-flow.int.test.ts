/**
 * Task 8.1e of openspec/changes/043-identity-lifecycle-and-org-admin (spec
 * "Invitation acceptance"; design D4 steps 1 to 5, D2; Resolved decisions Q89,
 * Q105, Q112, Q116, Q118, Q120, Q122, Q123 and Q127).
 *
 * Scenarios (from the spec, "Invitation acceptance"):
 * - "A failed `_user` write undoes the acceptance"
 * - "A failed existing-account acceptance leaves no membership"
 * - "A failure after the `_user` step keeps the membership for a retry"
 * - "A token replaced by a concurrent resend leaves nothing owed" (the
 *   flow's half: the lost-race handling; the revocation and the notice are
 *   8.5m's and 8.15's)
 * - "A new-account join whose token was replaced by a concurrent resend
 *   notifies the other admins" (the flow's half: the slot for the notice)
 * - "The acceptance holds back only its own member's hooks" (the `_user`
 *   half; the shed port's half is 8.5h's case)
 *
 * ## Harness
 *
 * A real Better Auth instance built with the Q30 `UserSyncPort` adapter over
 * the catalog's `createUserSync`, wrapped so that a test can make the `_user`
 * write of one tenant fail and can count the writes. Each test uses a fresh
 * organization (the tenant) with a real admin as the inviter, a real
 * invitation created through `auth.api.createInvitation` (its hook writes the
 * `Invited` `_user`) and the digest of a token stored as `invite` stores it.
 *
 * ## Production symbols expected
 *
 * `apps/api/src/identity/accept-flow.ts` exports `createAcceptFlow(options)`
 * returning `{ accept(input) }`:
 *
 * - options: `auth` (the `AuthInstance`), `authRepository` (the 5.1b
 *   repository; the flow deletes a membership it created through its
 *   `deleteMember`), `authPool` (the `tayzu_auth` pool: the token row of
 *   `auth.verification`), `userSync` (the `UserSyncAdapter`, whose
 *   `writeUserChange` the acceptance's own `_user` step calls with the
 *   `membership_added` intent and the invitee as `onBehalfOf`) and an
 *   optional test seam `onStep(step)`, awaited immediately BEFORE the step
 *   runs, inside the acceptance's shared context. A throw from the seam is a
 *   failure of that step. The step names, in order, are `add_member`, `shed`,
 *   `user_step`, `join_owed` (the slot for what the join owes, existing-account
 *   path, right after the `_user` step), `email_verified` (existing-account
 *   path), `consume` and `admin_notice` (the slot for the admin notice of an
 *   `admin` invitation: on the new-account path after the commit or after a
 *   zero-row consumption, never after a compensated failure). The new-account
 *   path also calls `create_user` first.
 * - `accept({ invitationId, token, password?, session? })`: `session` is the
 *   already validated session of the existing-account path
 *   (`{ userId, sessionId }`, opaque ids); the path is decided by whether a
 *   Better Auth user exists for the invitation's email. It resolves
 *   `{ userId }`.
 * - A lost consume race answers a `CatalogError` `CATALOG_NOT_FOUND` and logs
 *   `catalog.security.invitation_acceptance_denied` with
 *   `tayzu.identity.invitation.denial_reason` `consume_conflict`; any other
 *   failure answers an error that `toOrpcError` turns into `INTERNAL`.
 * - Inside the acceptance's shared context `afterAddMember` makes no `_user`
 *   write for the acceptance's own `(tenantId, userId)` (Q112, Q120), and the
 *   adapter skips only that member.
 *
 * ## Why this fails right now
 *
 * `./accept-flow.js` does not exist.
 */
// Load-bearing import order (design D1): the telemetry harness registers
// before anything that loads `@tayzu/auth` creates its logger.
import { registration, type TelemetryTestHarness } from '../__fixtures__/link-telemetry.js';
import { randomInt, randomUUID } from 'node:crypto';

import { authSchema, createAuth, createStepUpGuard, type AuthInstance } from '@tayzu/auth';
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
  verifyInvitationToken,
} from '../../../../packages/auth/src/identity/invitation-token.js';
import { harnessPools } from '../__fixtures__/pools.js';
import { toOrpcError } from '../error-mapping.js';
import { createAcceptFlow } from './accept-flow.js';
import { createAuthRepository, type AuthRepository } from './auth-repository.js';
import { runWithIdentityContext } from './identity-context.js';
import { createUserSyncAdapter } from './user-sync-adapter.js';

/** The Cerbos client the flow asks about the inviter (8.5f); the real one, lazily connected. */
const sharedCerbos = createCerbosClient({ address: 'localhost:3593', tls: false });

const STATUS_EVENT = 'catalog.audit.user_status_changed';
const DENIED_EVENT = 'catalog.security.invitation_acceptance_denied';
const COMPENSATION_EVENT = 'catalog.security.invitation_accept_compensation_failed';

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

type UserWrite = Parameters<UserSync['upsertUser']>[0];
type StepSeam = (step: string) => void | Promise<void>;

interface CreateInvitationApiSurface {
  createInvitation(args: {
    body: { email: string; role: 'member' | 'admin'; organizationId: string };
    headers: Headers;
  }): Promise<{ id: string; expiresAt: Date | string }>;
  addMember(args: {
    body: { userId: string; role: 'member' | 'admin'; organizationId: string };
  }): Promise<unknown>;
}

describe('the acceptance as idempotent steps (task 8.1e, design D4, Resolved decisions Q89, Q105, Q112, Q116, Q118, Q120, Q122, Q127)', () => {
  let harness: TelemetryTestHarness;
  let authPool: Pool;
  let auth: AuthInstance;
  let api: CreateInvitationApiSurface;
  let catalogSync: UserSync;
  let repository: AuthRepository;
  let adapter: ReturnType<typeof createUserSyncAdapter>;

  /** Tenants whose `_user` write fails, and tenants whose membership deletion fails. */
  const failingUserWrites = new Set<string>();
  const failingMemberDeletes = new Set<string>();
  const writes: UserWrite[] = [];

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
        writes.push(input);
      },
    };
    adapter = createUserSyncAdapter({ userSync: catalogSync });
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync: adapter,
    });
    api = auth.api as CreateInvitationApiSurface;
    const real = createAuthRepository(authPool);
    repository = {
      ...real,
      deleteMember: async (tenantId, memberId) => {
        if (failingMemberDeletes.has(tenantId)) throw new Error('member delete unavailable');
        return await real.deleteMember(tenantId, memberId);
      },
    };
  }, 60_000);

  function flowWith(onStep?: StepSeam) {
    return createAcceptFlow({
      auth,
      authz: sharedCerbos,
      authRepository: repository,
      authPool,
      userSync: adapter,
      ...(onStep === undefined ? {} : { onStep }),
    });
  }

  /** Records every step the flow reaches, then runs `extra` for it. */
  function recorder(extra?: StepSeam): { steps: string[]; seam: StepSeam } {
    const steps: string[] = [];
    return {
      steps,
      seam: async (step) => {
        steps.push(step);
        await extra?.(step);
      },
    };
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

  /** What `identity.users.invite` leaves: the invitation (its hook writes the `Invited` `_user`) and the token digest. */
  async function invite(
    tenant: Tenant,
    email: string,
    role: 'member' | 'admin' = 'member',
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
  ): Promise<{ id: string; emailVerified: boolean } | undefined> {
    const result = await authPool.query<{ id: string; email_verified: boolean }>(
      `select id, email_verified from auth."user" where email = $1`,
      [email],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : { id: row.id, emailVerified: row.email_verified };
  }

  async function membersOf(tenantId: string, userId: string): Promise<readonly string[]> {
    const result = await authPool.query<{ id: string }>(
      `select id from auth.member where organization_id = $1 and user_id = $2`,
      [tenantId, userId],
    );
    return result.rows.map((row) => row.id);
  }

  async function seedMember(tenantId: string, userId: string): Promise<string> {
    const id = randomUUID();
    await authPool.query(
      `insert into auth.member (id, organization_id, user_id, role, created_at)
       values ($1, $2, $3, 'member', now())`,
      [id, tenantId, userId],
    );
    return id;
  }

  async function userStatus(tenantId: string, email: string): Promise<string | undefined> {
    return (await catalogSync.getUser({ tenantId, email }))?.status;
  }

  function writesFor(tenantId: string, email: string): readonly UserWrite[] {
    return writes.filter((write) => write.tenantId === tenantId && write.email === email);
  }

  async function events(name: string, invitationId?: string) {
    await harness.forceFlush();
    return [...harness.logExporter.getFinishedLogRecords()].filter(
      (record) =>
        record.eventName === name &&
        (invitationId === undefined ||
          record.attributes['tayzu.identity.invitation.id'] === invitationId),
    );
  }

  /** The `toOrpcError` view of a rejected promise; `undefined` when it resolved. */
  async function failureOf(attempt: Promise<unknown>): Promise<{ code: string } | undefined> {
    try {
      await attempt;
      return undefined;
    } catch (error) {
      return toOrpcError(error);
    }
  }

  /** An existing account that is not a member of the tenant. */
  async function existingAccount(email: string): Promise<{ userId: string; sessionId: string }> {
    const created = await createAdminUser(auth, {
      name: 'Existing Account',
      email,
      password: TEST_PASSWORD,
    });
    return { userId: created.userId, sessionId: randomUUID() };
  }

  it('A failed `_user` write undoes the acceptance: a failure injected after createUser leaves no user row, the token still verifies and a retry succeeds', async () => {
    const tenant = await freshTenant();
    const email = `bob-${randomUUID()}@example.test`;
    const invitation = await invite(tenant, email);

    // GIVEN a step after the user was created that fails.
    let fail = true;
    const flow = flowWith((step) => {
      if (fail && step === 'add_member') throw new Error('injected failure');
    });
    const failure = await failureOf(flow.accept({ ...invitation, password: TEST_PASSWORD }));

    // THEN the answer is the sanitized generic error and no user row is left.
    expect(failure?.code).toBe('INTERNAL');
    expect(await userByEmail(email), 'no user row').toBeUndefined();
    expect(await tokenStillVerifies(invitation), 'the token is not consumed').toBe(true);
    expect(await userStatus(tenant.tenantId, email)).toBe('Invited');

    // AND a retry with the same token succeeds.
    fail = false;
    const result = await flow.accept({ ...invitation, password: TEST_PASSWORD });
    const user = await userByEmail(email);
    expect(user?.id).toBe(result.userId);
    expect(user?.emailVerified).toBe(true);
    expect(await membersOf(tenant.tenantId, result.userId)).toHaveLength(1);
    expect(await userStatus(tenant.tenantId, email)).toBe('Active');
    expect(await tokenRows(invitation.invitationId), 'the token is consumed last').toHaveLength(0);
  }, 60_000);

  it('A failed `_user` write undoes the acceptance: a userSync that throws at the _user step leaves no user, no member and the _user Invited, with the token valid and a retry succeeding', async () => {
    const tenant = await freshTenant();
    const email = `bob-${randomUUID()}@example.test`;
    const invitation = await invite(tenant, email);
    const flow = flowWith();

    // GIVEN a `_user` write that fails.
    failingUserWrites.add(tenant.tenantId);
    const failure = await failureOf(flow.accept({ ...invitation, password: TEST_PASSWORD }));

    // THEN the answer is the sanitized generic error...
    expect(failure?.code).toBe('INTERNAL');
    // ...no user and no membership exist, the `_user` keeps `Invited`, the token still verifies.
    expect(await userByEmail(email), 'no user').toBeUndefined();
    const members = await authPool.query(`select 1 from auth.member where organization_id = $1`, [
      tenant.tenantId,
    ]);
    expect(members.rowCount, 'only the admin is a member').toBe(1);
    expect(await userStatus(tenant.tenantId, email)).toBe('Invited');
    expect(await tokenStillVerifies(invitation)).toBe(true);

    // AND a retry with the same token succeeds.
    failingUserWrites.delete(tenant.tenantId);
    const result = await flow.accept({ ...invitation, password: TEST_PASSWORD });
    expect(await membersOf(tenant.tenantId, result.userId)).toHaveLength(1);
    expect(await userStatus(tenant.tenantId, email)).toBe('Active');
  }, 60_000);

  it('afterAddMember makes no _user write inside the acceptance: the adapter writes the _user exactly once, from the acceptance own step, naming the invitee (both paths)', async () => {
    const tenant = await freshTenant();

    // New-account path.
    const newEmail = `bob-${randomUUID()}@example.test`;
    const newInvitation = await invite(tenant, newEmail);
    const before = writesFor(tenant.tenantId, newEmail).length;
    const created = await flowWith().accept({ ...newInvitation, password: TEST_PASSWORD });
    const newWrites = writesFor(tenant.tenantId, newEmail).slice(before);
    expect(newWrites, 'exactly one _user write, from the acceptance own step').toHaveLength(1);
    expect(newWrites[0]?.status).toBe('Active');
    expect(newWrites[0]?.onBehalfOf).toEqual({ type: 'user', id: created.userId });

    // Existing-account path.
    const existingEmail = `carol-${randomUUID()}@example.test`;
    const carol = await existingAccount(existingEmail);
    const existingInvitation = await invite(tenant, existingEmail);
    const beforeExisting = writesFor(tenant.tenantId, existingEmail).length;
    await flowWith().accept({ ...existingInvitation, session: carol });
    const existingWrites = writesFor(tenant.tenantId, existingEmail).slice(beforeExisting);
    expect(existingWrites).toHaveLength(1);
    expect(existingWrites[0]?.status).toBe('Active');
    expect(existingWrites[0]?.onBehalfOf).toEqual({ type: 'user', id: carol.userId });

    // The change events carry the invitee as `onBehalfOf`, as `system`, for both paths.
    for (const [email, userId] of [
      [newEmail, created.userId],
      [existingEmail, carol.userId],
    ] as const) {
      const rows = await authPool.query<{
        actor_type: string;
        on_behalf_of_type: string | null;
        on_behalf_of_id: string | null;
      }>(
        `select actor_type, on_behalf_of_type, on_behalf_of_id from catalog_change_event
         where tenant_id = $1 and blueprint_identifier = '_user' and resource_identifier = $2
         order by seq`,
        [tenant.tenantId, email],
      );
      expect(rows.rows, 'the invitation hook write and the acceptance write').toHaveLength(2);
      expect(rows.rows[1]?.actor_type).toBe('system');
      expect(rows.rows[1]?.on_behalf_of_type).toBe('user');
      expect(rows.rows[1]?.on_behalf_of_id).toBe(userId);

      // Its `catalog.audit.user_status_changed` names the invitee, with the event `invitation_accepted`.
      const accepted = (await events(STATUS_EVENT)).filter(
        (record) =>
          record.attributes['tayzu.tenant.id'] === tenant.tenantId &&
          record.attributes['tayzu.identity.user.status.event'] === 'invitation_accepted' &&
          record.attributes['tayzu.identity.user.id'] === userId,
      );
      expect(accepted).toHaveLength(1);
      expect(accepted[0]?.attributes['tayzu.actor.id']).toBe(userId);
    }
  }, 60_000);

  it('An addMember that already happened is treated as done: a membership seeded before the attempt is neither duplicated nor deleted, and the acceptance completes', async () => {
    const tenant = await freshTenant();
    const email = `carol-${randomUUID()}@example.test`;
    const carol = await existingAccount(email);
    const invitation = await invite(tenant, email);
    const seeded = await seedMember(tenant.tenantId, carol.userId);

    await flowWith().accept({ ...invitation, session: carol });

    expect(await membersOf(tenant.tenantId, carol.userId)).toEqual([seeded]);
    expect(await userStatus(tenant.tenantId, email)).toBe('Active');
    expect(await tokenRows(invitation.invitationId)).toHaveLength(0);
  }, 60_000);

  it('A failed existing-account acceptance leaves no membership: a userSync that throws at the _user step ends with no membership and the token valid, and a retry adds the membership again', async () => {
    const tenant = await freshTenant();
    const email = `carol-${randomUUID()}@example.test`;
    const carol = await existingAccount(email);
    const invitation = await invite(tenant, email);
    const flow = flowWith();

    // GIVEN a step before the `_user` is activated that fails (the `_user` write).
    failingUserWrites.add(tenant.tenantId);
    const failure = await failureOf(flow.accept({ ...invitation, session: carol }));

    // THEN she has no membership of the tenant and the token still verifies.
    expect(failure?.code).toBe('INTERNAL');
    expect(await membersOf(tenant.tenantId, carol.userId)).toHaveLength(0);
    expect(await userStatus(tenant.tenantId, email)).toBe('Invited');
    expect(await tokenStillVerifies(invitation)).toBe(true);

    // AND a retry with the same token adds the membership again.
    failingUserWrites.delete(tenant.tenantId);
    await flow.accept({ ...invitation, session: carol });
    expect(await membersOf(tenant.tenantId, carol.userId)).toHaveLength(1);
    expect(await userStatus(tenant.tenantId, email)).toBe('Active');
  }, 60_000);

  it('A failed existing-account acceptance leaves no membership: a membership held before the attempt is never deleted by a failed attempt', async () => {
    const tenant = await freshTenant();
    const email = `carol-${randomUUID()}@example.test`;
    const carol = await existingAccount(email);
    const invitation = await invite(tenant, email);
    const seeded = await seedMember(tenant.tenantId, carol.userId);

    failingUserWrites.add(tenant.tenantId);
    const failure = await failureOf(flowWith().accept({ ...invitation, session: carol }));

    expect(failure?.code).toBe('INTERNAL');
    expect(await membersOf(tenant.tenantId, carol.userId)).toEqual([seeded]);
    expect(await userStatus(tenant.tenantId, email)).toBe('Invited');
    expect(await tokenStillVerifies(invitation)).toBe(true);
    expect(await events(COMPENSATION_EVENT, invitation.invitationId)).toHaveLength(0);
  }, 60_000);

  it('A failing compensation emits the event: a deletion that fails leaves the inert membership with the _user still Invited (existing account)', async () => {
    const tenant = await freshTenant();
    const email = `carol-${randomUUID()}@example.test`;
    const carol = await existingAccount(email);
    const invitation = await invite(tenant, email);

    failingUserWrites.add(tenant.tenantId);
    failingMemberDeletes.add(tenant.tenantId);
    const failure = await failureOf(flowWith().accept({ ...invitation, session: carol }));

    expect(failure?.code).toBe('INTERNAL');
    const logged = await events(COMPENSATION_EVENT, invitation.invitationId);
    expect(logged, 'one compensation failure event').toHaveLength(1);
    // Fail closed: the member stays inert.
    expect(await membersOf(tenant.tenantId, carol.userId)).toHaveLength(1);
    expect(await userStatus(tenant.tenantId, email)).toBe('Invited');
    expect(await tokenStillVerifies(invitation)).toBe(true);
  }, 60_000);

  it('A failing compensation emits the event: a deletion that fails after a new-account failure (new account)', async () => {
    const tenant = await freshTenant();
    const email = `bob-${randomUUID()}@example.test`;
    const invitation = await invite(tenant, email);

    failingUserWrites.add(tenant.tenantId);
    failingMemberDeletes.add(tenant.tenantId);
    const failure = await failureOf(flowWith().accept({ ...invitation, password: TEST_PASSWORD }));

    expect(failure?.code).toBe('INTERNAL');
    expect(await events(COMPENSATION_EVENT, invitation.invitationId)).toHaveLength(1);
    expect(await userStatus(tenant.tenantId, email)).toBe('Invited');
    expect(await tokenStillVerifies(invitation)).toBe(true);
  }, 60_000);

  it('A failure after the `_user` step keeps the membership for a retry: a failure at the emailVerified write deletes nothing, emits no compensation event and leaves the token valid; the retry completes with no second _user write', async () => {
    const tenant = await freshTenant();
    const email = `carol-${randomUUID()}@example.test`;
    const carol = await existingAccount(email);
    const invitation = await invite(tenant, email);

    // GIVEN an attempt that fails after her `_user` was activated, when her email is marked verified.
    let fail = true;
    const first = recorder((step) => {
      if (fail && step === 'email_verified') throw new Error('injected failure');
    });
    const failure = await failureOf(flowWith(first.seam).accept({ ...invitation, session: carol }));

    // THEN the failed attempt leaves her membership and her `Active` `_user` in place...
    expect(failure?.code).toBe('INTERNAL');
    expect(await membersOf(tenant.tenantId, carol.userId)).toHaveLength(1);
    expect(await userStatus(tenant.tenantId, email)).toBe('Active');
    // ...deletes nothing and leaves the token valid.
    expect(await events(COMPENSATION_EVENT, invitation.invitationId)).toHaveLength(0);
    expect(await tokenStillVerifies(invitation)).toBe(true);
    expect((await userByEmail(email))?.emailVerified).toBe(false);

    // The slot for what the join owes ran after the `_user` step and before the `emailVerified` write.
    const order = (name: string): number => first.steps.indexOf(name);
    expect(order('user_step')).toBeGreaterThan(order('shed'));
    expect(order('join_owed')).toBeGreaterThan(order('user_step'));
    expect(order('email_verified')).toBeGreaterThan(order('join_owed'));
    expect(first.steps, 'the token is not reached').not.toContain('consume');

    // AND the retry completes the acceptance, with no second status write.
    fail = false;
    const writesBefore = writesFor(tenant.tenantId, email).length;
    const retry = recorder();
    await flowWith(retry.seam).accept({ ...invitation, session: carol });
    expect(await tokenRows(invitation.invitationId), 'the token is consumed').toHaveLength(0);
    expect((await userByEmail(email))?.emailVerified).toBe(true);
    expect(writesFor(tenant.tenantId, email), 'no second _user write').toHaveLength(writesBefore);
    expect(await membersOf(tenant.tenantId, carol.userId)).toHaveLength(1);
  }, 60_000);

  it('A lost consume race deletes nothing the other attempt created and answers the uniform rejection with consume_conflict (existing account, token consumed by another attempt)', async () => {
    const tenant = await freshTenant();
    const email = `carol-${randomUUID()}@example.test`;
    const carol = await existingAccount(email);
    const invitation = await invite(tenant, email);

    // GIVEN another attempt consumed the token after this one verified it.
    const seam: StepSeam = async (step) => {
      if (step === 'consume') {
        await authPool.query(`delete from auth.verification where identifier = $1`, [
          `invitation-accept:${invitation.invitationId}`,
        ]);
      }
    };
    const failure = await failureOf(flowWith(seam).accept({ ...invitation, session: carol }));

    // THEN the uniform rejection, the reason `consume_conflict`, and nothing is deleted.
    expect(failure?.code).toBe('CATALOG_NOT_FOUND');
    const denied = await events(DENIED_EVENT, invitation.invitationId);
    expect(denied).toHaveLength(1);
    expect(denied[0]?.attributes['tayzu.identity.invitation.denial_reason']).toBe(
      'consume_conflict',
    );
    expect(await membersOf(tenant.tenantId, carol.userId)).toHaveLength(1);
    expect(await userStatus(tenant.tenantId, email)).toBe('Active');
    expect(await events(COMPENSATION_EVENT, invitation.invitationId)).toHaveLength(0);
  }, 60_000);

  it('A token replaced by a concurrent resend leaves nothing owed: the zero-row consumption is a lost race that deletes nothing, and an acceptance with the resent token completes (existing account)', async () => {
    const tenant = await freshTenant();
    const email = `carol-${randomUUID()}@example.test`;
    const plain = await existingAccount(email);
    const invitation = await invite(tenant, email, 'admin');

    // Wiring only (task 8.5d): an `admin` invitation to an existing account needs
    // the step-up guard and a fresh marker on her real session.
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
    const carol = {
      ...plain,
      headers: new Headers({ cookie: signedIn.cookie, 'x-forwarded-for': randomIp() }),
    };
    const stepUpFlow = (onStep?: StepSeam) =>
      createAcceptFlow({
        auth,
        authz: sharedCerbos,
        authRepository: repository,
        authPool,
        userSync: adapter,
        stepUp: createStepUpGuard({ auth }),
        ...(onStep === undefined ? {} : { onStep }),
      });

    // GIVEN a resend that replaces the token after the attempt's `_user` step and before its consumption.
    let resent = '';
    const first = recorder(async (step) => {
      if (step === 'consume') resent = await replaceToken(invitation.invitationId);
    });
    const failure = await failureOf(
      stepUpFlow(first.seam).accept({ ...invitation, session: carol }),
    );

    // THEN the attempt fails as a lost race and deletes nothing.
    expect(failure?.code).toBe('CATALOG_NOT_FOUND');
    const denied = await events(DENIED_EVENT, invitation.invitationId);
    expect(denied).toHaveLength(1);
    expect(denied[0]?.attributes['tayzu.identity.invitation.denial_reason']).toBe(
      'consume_conflict',
    );
    expect(await membersOf(tenant.tenantId, carol.userId)).toHaveLength(1);
    expect(await userStatus(tenant.tenantId, email)).toBe('Active');
    expect(first.steps).toContain('join_owed');
    expect(await events(COMPENSATION_EVENT, invitation.invitationId)).toHaveLength(0);

    // AND an acceptance with the resent token completes.
    const writesBefore = writesFor(tenant.tenantId, email).length;
    await stepUpFlow().accept({
      invitationId: invitation.invitationId,
      token: resent,
      session: carol,
    });
    expect(await tokenRows(invitation.invitationId)).toHaveLength(0);
    expect(writesFor(tenant.tenantId, email)).toHaveLength(writesBefore);
  }, 60_000);

  it('A new-account join whose token was replaced by a concurrent resend notifies the other admins: nothing is compensated, the uniform rejection answers consume_conflict and the notice slot runs after the zero-row consumption', async () => {
    const tenant = await freshTenant();
    const email = `dave-${randomUUID()}@example.test`;
    const invitation = await invite(tenant, email, 'admin');

    // GIVEN a resend that replaces the token after the attempt's `_user` step and before its consumption.
    const attempt = recorder(async (step) => {
      if (step === 'consume') await replaceToken(invitation.invitationId);
    });
    const failure = await failureOf(
      flowWith(attempt.seam).accept({ ...invitation, password: TEST_PASSWORD }),
    );

    // THEN the uniform rejection with the reason `consume_conflict`...
    expect(failure?.code).toBe('CATALOG_NOT_FOUND');
    const denied = await events(DENIED_EVENT, invitation.invitationId);
    expect(denied).toHaveLength(1);
    expect(denied[0]?.attributes['tayzu.identity.invitation.denial_reason']).toBe(
      'consume_conflict',
    );
    // ...the user, the membership and the `Active` `_user` stay in place...
    const user = await userByEmail(email);
    expect(user, 'the user stays').toBeDefined();
    expect(await membersOf(tenant.tenantId, user?.id ?? '')).toHaveLength(1);
    expect(await userStatus(tenant.tenantId, email)).toBe('Active');
    expect(await events(COMPENSATION_EVENT, invitation.invitationId)).toHaveLength(0);
    // ...and the slot for the admin notice ran after that consumption.
    expect(attempt.steps.indexOf('admin_notice')).toBeGreaterThan(attempt.steps.indexOf('consume'));
  }, 60_000);

  it('A new-account failure that is compensated does not run the admin notice slot, and the compensation leaves no user', async () => {
    const tenant = await freshTenant();
    const email = `dave-${randomUUID()}@example.test`;
    const invitation = await invite(tenant, email, 'admin');

    const attempt = recorder((step) => {
      if (step === 'consume') throw new Error('injected failure');
    });
    const failure = await failureOf(
      flowWith(attempt.seam).accept({ ...invitation, password: TEST_PASSWORD }),
    );

    expect(failure?.code).toBe('INTERNAL');
    expect(attempt.steps).not.toContain('admin_notice');
    expect(
      await userByEmail(email),
      'the compensation deleted the user it created',
    ).toBeUndefined();
    expect(await tokenStillVerifies(invitation)).toBe(true);
  }, 60_000);

  it('The acceptance holds back only its own member hooks: the _user of another user and of the same user in another tenant are written, the acceptance own member gets none from the hook', async () => {
    const tenant = await freshTenant();
    const otherTenant = await freshTenant();
    const email = `carol-${randomUUID()}@example.test`;
    const carol = await existingAccount(email);
    const daveEmail = `dave-${randomUUID()}@example.test`;
    const dave = await existingAccount(daveEmail);
    const invitation = await invite(tenant, email);
    const ownBefore = writesFor(tenant.tenantId, email).length;

    // GIVEN an acceptance in progress for `carol` in `t2`...
    let statusInside: string | undefined;
    const seam: StepSeam = async (step) => {
      if (step !== 'user_step') return;
      // WHEN a membership of another user, and of `carol` in another tenant, is added while it runs.
      await api.addMember({
        body: { userId: dave.userId, role: 'member', organizationId: tenant.tenantId },
      });
      await api.addMember({
        body: { userId: carol.userId, role: 'member', organizationId: otherTenant.tenantId },
      });
      statusInside = await userStatus(tenant.tenantId, email);
    };
    await flowWith(seam).accept({ ...invitation, session: carol });

    // THEN that membership's `_user` is written as on any other path...
    expect(await userStatus(tenant.tenantId, daveEmail)).toBe('Active');
    expect(writesFor(tenant.tenantId, daveEmail)).toHaveLength(1);
    expect(await userStatus(otherTenant.tenantId, email)).toBe('Active');
    expect(writesFor(otherTenant.tenantId, email)).toHaveLength(1);
    // ...while carol's own membership in `t2` got no write from the hook: still inert at the `_user` step,
    // and exactly one write (the acceptance's own step) after it.
    expect(statusInside).toBe('Invited');
    const own = writesFor(tenant.tenantId, email).slice(ownBefore);
    expect(own).toHaveLength(1);
    expect(own[0]?.status).toBe('Active');
    expect(await userStatus(tenant.tenantId, email)).toBe('Active');
  }, 60_000);
});
