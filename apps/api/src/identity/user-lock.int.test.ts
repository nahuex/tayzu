/**
 * Integration test for task 8.5i of `043-identity-lifecycle-and-org-admin`
 * (Resolved decisions Q87 and Q114; design D4 step 7, "One advisory lock per user").
 *
 * Cases (one per clause of the task's Verify):
 *
 * - two concurrent `withUserLock` calls for one user run one after the other;
 * - two concurrent `withUserLock` calls for two users run in parallel;
 * - `fn` runs on the transaction that holds the lock;
 * - `linkSsoAccount` runs its membership check and its link inside the lock (a spy on
 *   `withUserLock`).
 *
 * The interleavings of a link and a join need the shed and are 8.5h's
 * `sso-link-race.int.test.ts`; they are not tested here.
 *
 * ## Production symbols expected
 *
 * ```ts
 * // apps/api/src/identity/user-lock.ts
 * export type WithUserLock = <T>(
 *   userId: string,
 *   fn: (tx: PoolClient) => Promise<T>,
 * ) => Promise<T>;
 * // Binds the lock to the `tayzu_auth` pool: one short dedicated transaction per call,
 * // `pg_advisory_xact_lock` on a key derived from the user id (bound parameter), held
 * // until `fn` settles; `fn` receives that transaction's client.
 * export function createWithUserLock(authPool: Pool): WithUserLock;
 *
 * // apps/api/src/identity-router.ts
 * // CreateIdentityRouterOptions gains `withUserLock: WithUserLock` (the router has no
 * // pool of its own; the spy is passed here). `linkSsoAccount` calls it once, for the
 * // target user's id, and does its membership check
 * // (`authRepository.globalMembershipTenantsOf`) and its link
 * // (`internalAdapter.linkAccount`) inside `fn`.
 * ```
 *
 * If the real signature differs (for example a module-level `withUserLock` bound by an
 * initializer), the tests need the same adaptation in one place: `lockFor` below.
 *
 * Tenant-per-test isolation: each test uses fresh random user ids and tenants, and the
 * module scans no whole table, so the shared test database is safe.
 */
import { randomUUID } from 'node:crypto';

import { createRouterClient } from '@orpc/server';
import { authSchema, createAuth, type AuthInstance } from '@tayzu/auth';
import { createCerbosClient } from '@tayzu/authz';
import { runMigrations } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import { createAdminUser } from '../../../../packages/auth/src/__fixtures__/admin-user.js';
import {
  TEST_PASSWORD,
  TEST_SECRET,
} from '../../../../packages/auth/src/__fixtures__/test-secret.js';
import { harnessPools } from '../__fixtures__/pools.js';
import { createIdentityRouter } from '../identity-router.js';
import { createAuthRepository } from './auth-repository.js';
import { createWithUserLock, type WithUserLock } from './user-lock.js';

const PROVIDER_ID = 'visma-connect';
const HOLD_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface CreateOrganizationSurface {
  createOrganization(args: {
    body: { name: string; slug: string; userId: string };
  }): Promise<{ id: string }>;
}

interface MemberSurface {
  addMember(args: {
    body: { userId: string; organizationId: string; role: string };
  }): Promise<unknown>;
}

interface InternalAdapterSurface {
  readonly internalAdapter: {
    linkAccount(account: {
      userId: string;
      providerId: string;
      accountId: string;
    }): Promise<unknown>;
  };
}

describe('withUserLock (task 8.5i, Resolved decision Q87)', () => {
  let authPool: Pool;
  let auth: AuthInstance;
  let withUserLock: WithUserLock;

  beforeAll(async () => {
    ({ authPool } = await harnessPools());
    await runMigrations(authPool);
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
    });
    withUserLock = lockFor(authPool);
  }, 60_000);

  function lockFor(pool: Pool): WithUserLock {
    return createWithUserLock(pool);
  }

  it('two concurrent calls for one user run one after the other', async () => {
    const userId = `usr-${randomUUID()}`;
    const events: string[] = [];

    const run = (label: string): Promise<string> =>
      withUserLock(userId, async () => {
        events.push(`${label}:start`);
        await sleep(HOLD_MS);
        events.push(`${label}:end`);
        return label;
      });

    const results = await Promise.all([run('a'), run('b')]);

    expect(results).toEqual(['a', 'b']);
    // Never interleaved: the second start comes after the first end.
    expect(events).toHaveLength(4);
    const first = (events[0] ?? '').split(':')[0] ?? '';
    const second = (events[2] ?? '').split(':')[0] ?? '';
    expect(events).toEqual([`${first}:start`, `${first}:end`, `${second}:start`, `${second}:end`]);
    expect(new Set([first, second])).toEqual(new Set(['a', 'b']));
  });

  it('two concurrent calls for two users run in parallel', async () => {
    const userA = `usr-${randomUUID()}`;
    const userB = `usr-${randomUUID()}`;
    let started = 0;
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Each `fn` waits until the other has started. If the two calls were serialized the
    // first would wait for a second that cannot start until the first ends.
    const run = (userId: string): Promise<boolean> =>
      withUserLock(userId, async () => {
        started += 1;
        if (started === 2) release();
        const outcome = await Promise.race([
          bothStarted.then(() => 'parallel' as const),
          sleep(5_000).then(() => 'serialized' as const),
        ]);
        return outcome === 'parallel';
      });

    expect(await Promise.all([run(userA), run(userB)])).toEqual([true, true]);
  }, 20_000);

  it('fn runs on the transaction that holds the lock', async () => {
    const userId = `usr-${randomUUID()}`;
    const markerId = `lock-test-${randomUUID()}`;
    let pid = 0;

    await withUserLock(userId, async (tx) => {
      pid = ((await tx.query('select pg_backend_pid() as pid')).rows[0] as { pid: number }).pid;

      // The connection `fn` was given holds a granted advisory lock, seen from another one.
      const held = await authPool.query<{ n: string }>(
        `select count(*) as n from pg_locks
         where locktype = 'advisory' and granted and pid = $1`,
        [pid],
      );
      expect(Number(held.rows[0]?.n)).toBeGreaterThanOrEqual(1);

      // `fn` runs inside a transaction: a write through it is invisible to other
      // connections until the lock is released.
      await tx.query(
        `insert into auth.verification (id, identifier, value, expires_at)
         values ($1, $2, 'x', now() + interval '1 day')`,
        [markerId, markerId],
      );
      const outside = await authPool.query('select 1 from auth.verification where id = $1', [
        markerId,
      ]);
      expect(outside.rowCount).toBe(0);
      const inside = await tx.query('select 1 from auth.verification where id = $1', [markerId]);
      expect(inside.rowCount).toBe(1);
    });

    // Committed and released when `fn` settles.
    const after = await authPool.query('select 1 from auth.verification where id = $1', [markerId]);
    expect(after.rowCount).toBe(1);
    const stillHeld = await authPool.query<{ n: string }>(
      `select count(*) as n from pg_locks where locktype = 'advisory' and pid = $1`,
      [pid],
    );
    expect(Number(stillHeld.rows[0]?.n)).toBe(0);
    await authPool.query('delete from auth.verification where id = $1', [markerId]);
  });

  it('linkSsoAccount runs its membership check and its link inside the lock', async () => {
    const events: string[] = [];
    const lockedUsers: string[] = [];
    const base = lockFor(authPool);
    const spy: WithUserLock = (userId, fn) => {
      lockedUsers.push(userId);
      return base(userId, async (tx) => {
        events.push('lock:enter');
        try {
          return await fn(tx);
        } finally {
          events.push('lock:exit');
        }
      });
    };

    const real = createAuthRepository(authPool);
    const membershipSpy = vi.fn((userId: string) => {
      events.push('membership-check');
      return real.globalMembershipTenantsOf(userId);
    });
    const repository = { ...real, globalMembershipTenantsOf: membershipSpy };

    const ownerId = randomUUID();
    const owner = await createAdminUser(auth, {
      name: 'Tenant Owner',
      email: `owner-${ownerId}@example.test`,
      password: TEST_PASSWORD,
    });
    const org = await (auth.api as CreateOrganizationSurface).createOrganization({
      body: { name: 'Lock Org', slug: `lock-${ownerId}`, userId: owner.userId },
    });
    const target = await createAdminUser(auth, {
      name: 'Link Target',
      email: `target-${randomUUID()}@example.test`,
      password: TEST_PASSWORD,
    });
    await (auth.api as MemberSurface).addMember({
      body: { userId: target.userId, organizationId: org.id, role: 'member' },
    });

    // Installed after the setup above, which links credential accounts through the same adapter.
    const adapter = (await (auth.$context as Promise<InternalAdapterSurface>)).internalAdapter;
    const realLink = adapter.linkAccount.bind(adapter);
    const linkSpy = vi.spyOn(adapter, 'linkAccount').mockImplementation((account) => {
      events.push('link');
      return realLink(account);
    });

    const client = createRouterClient(
      createIdentityRouter({
        auth,
        authz: createCerbosClient({ address: 'localhost:3593', tls: false }),
        authRepository: repository,
        withUserLock: spy,
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );

    const subject = `visma-sub-${randomUUID()}`;
    await client.identity.users.linkSsoAccount(
      { user: target.email, subject },
      {
        context: {
          tenantId: org.id,
          actor: { type: 'user', id: `caller-${randomUUID()}` },
          principal: { roles: ['admin'] },
        },
      },
    );

    // Taken once, for the target user; the check and the link both happen inside it.
    expect(lockedUsers).toEqual([target.userId]);
    expect(events).toEqual(['lock:enter', 'membership-check', 'link', 'lock:exit']);
    expect(membershipSpy).toHaveBeenCalledTimes(1);
    expect(linkSpy).toHaveBeenCalledTimes(1);
    expect(linkSpy).toHaveBeenCalledWith({
      userId: target.userId,
      providerId: PROVIDER_ID,
      accountId: subject,
    });

    linkSpy.mockRestore();
  }, 30_000);
});
