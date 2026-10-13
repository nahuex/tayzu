/**
 * Task 8.5h of openspec/changes/043-identity-lifecycle-and-org-admin (Resolved
 * decision Q87, Q105 and Q114; spec scenario "A link cannot race a join").
 *
 * Verify (8.5h): "a link that starts while a join is adding the second membership
 * ends refused (it sees two tenants) or shed (it committed first), never an unmarked
 * link left on a two-tenant user, over repeated runs of both orders, and an
 * existing-account acceptance, whose `afterAddMember` runs inside its shared
 * context, taking the lock of 8.5i exactly once (a spy on `withUserLock`)".
 *
 * ## Harness
 *
 * The two orders are made deterministic, not left to the scheduler: the lock the
 * link takes (`createIdentityRouter`'s `withUserLock`) or the lock the shed takes
 * (`createSsoLinkShed`'s `withUserLock`) is wrapped so that it signals when its
 * body has started and holds the lock for a while, and the other operation is
 * started only after that signal. Both wrap the real `createWithUserLock` on the
 * `tayzu_auth` pool, so the exclusion under test is the real advisory lock.
 *
 * - "link first": the link holds the lock after recording the account; the join
 *   adds the membership meanwhile and its hook's shed waits for the lock, then
 *   finds the link and sheds it.
 * - "join first": the shed (inside `afterAddMember`) holds the lock before it
 *   runs; the link starts meanwhile, waits, and its membership check (inside the
 *   lock) sees both tenants. The refusal that follows is the work of task 12.9
 *   ("A user with memberships in two tenants cannot be linked"), so this order
 *   asserts what the shed owns: that the link's check ran after the join and saw
 *   two tenants, and that the join itself completed with its `_user` written.
 *
 * ## Production symbols expected (none exists yet)
 *
 * `createSsoLinkShed({ authPool, withUserLock? })` from `./sso-link-shed.js` and
 * the `createAuth` option `ssoLinkShed` (see `sso-link-shed.int.test.ts` for the
 * full contract). `createAcceptFlow` takes the option `ssoLinkShed` too.
 *
 * ## Why this fails right now
 *
 * `./sso-link-shed.js` does not exist.
 */
// Load-bearing import order (design D1): the telemetry harness registers before
// anything that loads `@tayzu/auth` creates its logger.
import { registration } from '../__fixtures__/link-telemetry.js';
import { randomUUID } from 'node:crypto';

import { createRouterClient } from '@orpc/server';
import { authSchema, createAuth, type AuthInstance } from '@tayzu/auth';
import { createCerbosClient } from '@tayzu/authz';
import { createUserSync } from '@tayzu/catalog';
import { runMigrations } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  bootstrapTestTenant,
  createAdminUser,
  testAppPool,
} from '../../../../packages/auth/src/__fixtures__/admin-user.js';
import {
  TEST_PASSWORD,
  TEST_SECRET,
} from '../../../../packages/auth/src/__fixtures__/test-secret.js';
import {
  digestInvitationToken,
  generateInvitationToken,
} from '../../../../packages/auth/src/identity/invitation-token.js';
import { harnessPools } from '../__fixtures__/pools.js';
import { randomIp } from '../__fixtures__/sso-shed.js';
import { createIdentityRouter } from '../identity-router.js';
import { createAcceptFlow } from './accept-flow.js';
import { createAuthRepository, type AuthRepository } from './auth-repository.js';
import { runWithIdentityContext } from './identity-context.js';
import { createSsoLinkShed } from './sso-link-shed.js';
import { createUserSyncAdapter } from './user-sync-adapter.js';
import { createWithUserLock, type WithUserLock } from './user-lock.js';

const RUNS = 8;
const HOLD_MS = 150;
const sharedCerbos = createCerbosClient({ address: 'localhost:3593', tls: false });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A promise with its resolver, to signal "the body has started". It rejects after
 * a few seconds, so that a lock that is never taken fails the test with a message.
 */
function signal(): { promise: Promise<void>; fire: () => void } {
  let fire: () => void = () => undefined;
  const promise = new Promise<void>((resolve, reject) => {
    fire = resolve;
    setTimeout(() => {
      reject(new Error('the lock body never started'));
    }, 10_000).unref();
  });
  return { promise, fire };
}

interface Tenant {
  readonly tenantId: string;
  readonly adminId: string;
  readonly cookie: string;
}

interface ApiSurface {
  createInvitation(args: {
    body: { email: string; role: 'member' | 'admin'; organizationId: string };
    headers: Headers;
  }): Promise<{ id: string; expiresAt: Date | string }>;
  addMember(args: {
    body: { userId: string; role: 'member' | 'admin'; organizationId: string };
  }): Promise<unknown>;
}

describe('A link cannot race a join (task 8.5h, Resolved decision Q87)', () => {
  let authPool: Pool;
  let auth: AuthInstance;
  let api: ApiSurface;
  let realLock: WithUserLock;
  let adapter: ReturnType<typeof createUserSyncAdapter>;
  let userSync: ReturnType<typeof createUserSync>;
  let real: AuthRepository;

  /** What the next link's lock wrapper does; set per test. */
  let linkHook: { inside: () => void; holdAfterMs: number } | undefined;
  /** What the next shed's lock wrapper does; set per test. */
  let shedHook: { inside: () => void; holdBeforeMs: number } | undefined;
  /** Every call of the shed's lock, by user id. */
  const shedLockCalls: string[] = [];
  /** The tenants each membership check of a link saw. */
  const checks: { userId: string; tenants: readonly string[] }[] = [];
  /** Fired once, after the link's membership check for `userId` has run (inside the lock). */
  let afterCheckHook: { userId: string; fire: () => void } | undefined;

  let client: ReturnType<
    typeof createRouterClient<ReturnType<typeof createIdentityRouter>, Record<string, unknown>>
  >;
  let shedCore: ReturnType<typeof createSsoLinkShed>;

  beforeAll(async () => {
    if ('error' in registration) {
      throw new Error(`createTelemetryTestHarness() failed: ${String(registration.error)}`, {
        cause: registration.error,
      });
    }
    ({ authPool } = await harnessPools());
    const pools = await harnessPools();
    await runMigrations(authPool);
    realLock = createWithUserLock(authPool);
    userSync = createUserSync({ pool: pools.appPool, authz: sharedCerbos });
    adapter = createUserSyncAdapter({ userSync });

    const shedLock: WithUserLock = (userId, fn) =>
      realLock(userId, async (tx) => {
        shedLockCalls.push(userId);
        const hook = shedHook;
        if (hook !== undefined) {
          shedHook = undefined;
          hook.inside();
          await sleep(hook.holdBeforeMs);
        }
        return fn(tx);
      });
    shedCore = createSsoLinkShed({ authPool, withUserLock: shedLock });

    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync: adapter,
      ssoLinkShed: shedCore.port,
    });
    api = auth.api as ApiSurface;

    real = createAuthRepository(authPool);
    const spied: AuthRepository = {
      ...real,
      globalMembershipTenantsOf: async (userId) => {
        const tenants = await real.globalMembershipTenantsOf(userId);
        checks.push({ userId, tenants });
        const hook = afterCheckHook;
        if (hook?.userId === userId) {
          afterCheckHook = undefined;
          hook.fire();
        }
        return tenants;
      },
    };
    const linkLock: WithUserLock = (userId, fn) =>
      realLock(userId, async (tx) => {
        const hook = linkHook;
        if (hook !== undefined) {
          linkHook = undefined;
          hook.inside();
        }
        const result = await fn(tx);
        if (hook !== undefined) await sleep(hook.holdAfterMs);
        return result;
      });
    client = createRouterClient(
      createIdentityRouter({
        auth,
        authz: sharedCerbos,
        authRepository: spied,
        withUserLock: linkLock,
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );
  }, 60_000);

  async function freshTenant(): Promise<Tenant> {
    const id = randomUUID();
    const t = await bootstrapTestTenant(auth, {
      pool: testAppPool(),
      name: 'Race Admin',
      email: `race-admin-${id}@example.test`,
      password: TEST_PASSWORD,
      organizationName: 'Race Org',
      organizationSlug: `race-${id}`,
      ip: randomIp(),
    });
    return { tenantId: t.organizationId, adminId: t.userId, cookie: t.cookie };
  }

  async function singleTenantMember(tenant: Tenant): Promise<{ userId: string; email: string }> {
    const person = await createAdminUser(auth, {
      name: 'Race Member',
      email: `race-member-${randomUUID()}@example.test`,
      password: TEST_PASSWORD,
    });
    await api.addMember({
      body: { userId: person.userId, organizationId: tenant.tenantId, role: 'member' },
    });
    return person;
  }

  function adminContext(tenantId: string): Record<string, unknown> {
    return {
      tenantId,
      actor: { type: 'user', id: `caller-${randomUUID()}` },
      principal: { roles: ['admin'] },
    };
  }

  async function accountCount(userId: string): Promise<number> {
    const result = await authPool.query<{ n: string }>(
      `select count(*)::text as n from auth.account where user_id = $1 and provider_id <> 'credential'`,
      [userId],
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  async function memberCount(userId: string): Promise<number> {
    const result = await authPool.query<{ n: string }>(
      `select count(*)::text as n from auth.member where user_id = $1`,
      [userId],
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  it('link first: a link that commits before the join completes is shed by the join, over repeated runs', async () => {
    for (let run = 0; run < RUNS; run += 1) {
      const t1 = await freshTenant();
      const t2 = await freshTenant();
      const person = await singleTenantMember(t1);
      const linkChecked = signal();
      // The join starts only once the link's check ran (and saw one tenant); the link keeps the lock.
      afterCheckHook = { userId: person.userId, fire: linkChecked.fire };
      linkHook = { inside: () => undefined, holdAfterMs: HOLD_MS };

      const link = client.identity.users.linkSsoAccount(
        { user: person.email, subject: `race-sub-${randomUUID()}` },
        { context: adminContext(t1.tenantId) },
      );
      await linkChecked.promise;
      const join = api.addMember({
        body: { userId: person.userId, organizationId: t2.tenantId, role: 'member' },
      });
      await Promise.all([link, join]);

      expect(await memberCount(person.userId), `run ${String(run)}: the join completed`).toBe(2);
      expect(
        await accountCount(person.userId),
        `run ${String(run)}: no unmarked link is left on a user of two tenants`,
      ).toBe(0);
    }
  }, 120_000);

  it('join first: the link waits for the join, runs its membership check after it and sees two tenants, over repeated runs', async () => {
    for (let run = 0; run < RUNS; run += 1) {
      const t1 = await freshTenant();
      const t2 = await freshTenant();
      const person = await singleTenantMember(t1);
      const shedInside = signal();
      shedHook = { inside: shedInside.fire, holdBeforeMs: HOLD_MS };
      checks.length = 0;

      const join = api.addMember({
        body: { userId: person.userId, organizationId: t2.tenantId, role: 'member' },
      });
      await shedInside.promise;
      // The membership is already inserted: the hook (and its shed) runs after `addMember` inserts.
      expect(await memberCount(person.userId), 'precondition: the second membership exists').toBe(
        2,
      );
      const link = client.identity.users
        .linkSsoAccount(
          { user: person.email, subject: `race-sub-${randomUUID()}` },
          { context: adminContext(t1.tenantId) },
        )
        .then(
          () => 'linked' as const,
          () => 'refused' as const,
        );
      const joined = await join.then(
        () => 'joined' as const,
        () => 'failed' as const,
      );
      await link;

      expect(joined, `run ${String(run)}: the join completed`).toBe('joined');
      const seen = checks.filter((check) => check.userId === person.userId);
      expect(seen, `run ${String(run)}: the link ran its check`).toHaveLength(1);
      expect(
        seen[0]?.tenants,
        `run ${String(run)}: the check, inside the lock, saw both tenants`,
      ).toHaveLength(2);
      expect(
        await userSync.getUser({ tenantId: t2.tenantId, email: person.email }),
        'the join wrote its _user',
      ).not.toBeNull();
    }
  }, 120_000);

  it('an existing-account acceptance takes the lock of 8.5i exactly once, though its afterAddMember runs inside its shared context', async () => {
    const t1 = await freshTenant();
    const t2 = await freshTenant();
    const person = await singleTenantMember(t1);
    const invitation = await runWithIdentityContext({ adminId: t2.adminId }, () =>
      api.createInvitation({
        body: { email: person.email, role: 'member', organizationId: t2.tenantId },
        headers: new Headers({ cookie: t2.cookie, 'x-forwarded-for': randomIp() }),
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
    shedLockCalls.length = 0;

    await createAcceptFlow({
      auth,
      authz: sharedCerbos,
      authRepository: real,
      authPool,
      userSync: adapter,
      ssoLinkShed: shedCore,
    }).accept({
      invitationId: invitation.id,
      token,
      session: { userId: person.userId, sessionId: randomUUID() },
    });

    expect(shedLockCalls.filter((id) => id === person.userId)).toHaveLength(1);
  }, 60_000);
});
