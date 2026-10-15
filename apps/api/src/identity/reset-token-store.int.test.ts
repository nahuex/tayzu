/**
 * Task 2.3 of openspec/changes/044-password-reset-and-account-recovery (design D3 "Storage" and
 * "Newest wins", Resolved decision Q13).
 *
 * Cases: scenario "The newest link wins" (store level), scenario "Only a digest is stored",
 * and "expired rows are purged by the next issue".
 *
 * ## Production symbols expected (none exists yet)
 *
 * ```ts
 * // apps/api/src/identity/reset-token-store.ts
 * export interface ResetTokenStore {
 *   // One authPool transaction under the per-user advisory lock: delete the user's earlier
 *   // `password-reset:` rows and every expired `password-reset:` row, then insert
 *   // `password-reset:<id>` with `v1:<digest>:<userId>:0` expiring in 30 minutes.
 *   issue: (userId: string) => Promise<{ id: string; token: string }>;
 * }
 * export function createResetTokenStore(options: {
 *   authPool: Pool;
 *   withUserLock: WithUserLock; // ./user-lock.js, bound to the same pool
 * }): ResetTokenStore;
 * ```
 *
 * The SQL lives in the verification section of `auth-repository.ts`; this test only observes
 * the `auth.verification` rows. Every test uses fresh random user ids, and the test scans
 * only rows it can attribute to its own users or ids, so the shared database is safe.
 */
import { randomUUID } from 'node:crypto';

import { runMigrations } from '@tayzu/db';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';

import { digestResetToken } from '../../../../packages/auth/src/identity/reset-token.js';
import { parseResetTokenValue } from '../../../../packages/auth/src/identity/reset-token-value.js';
import { harnessPools } from '../__fixtures__/pools.js';
import { createResetTokenStore, type ResetTokenStore } from './reset-token-store.js';
import { createWithUserLock } from './user-lock.js';

const PREFIX = 'password-reset:';
const THIRTY_MINUTES_MS = 30 * 60 * 1000;

interface VerificationRow {
  identifier: string;
  value: string;
  expires_at: Date;
}

describe('reset token store: issue (task 2.3)', () => {
  let authPool: Pool;
  let store: ResetTokenStore;

  beforeAll(async () => {
    ({ authPool } = await harnessPools());
    await runMigrations(authPool);
    store = createResetTokenStore({ authPool, withUserLock: createWithUserLock(authPool) });
  }, 60_000);

  async function rowById(id: string): Promise<VerificationRow | undefined> {
    const result = await authPool.query<VerificationRow>(
      'select identifier, value, expires_at from auth.verification where identifier = $1',
      [`${PREFIX}${id}`],
    );
    return result.rows[0];
  }

  async function rowsOfUser(userId: string): Promise<VerificationRow[]> {
    const result = await authPool.query<VerificationRow>(
      `select identifier, value, expires_at from auth.verification
       where identifier like 'password-reset:%' and split_part(value, ':', 3) = $1`,
      [userId],
    );
    return result.rows;
  }

  async function insertRaw(id: string, userId: string, expiresAt: Date): Promise<void> {
    await authPool.query(
      `insert into auth.verification (id, identifier, value, expires_at, created_at, updated_at)
       values ($1, $2, $3, $4, now(), now())`,
      [randomUUID(), `${PREFIX}${id}`, `v1:${'a'.repeat(64)}:${userId}:0`, expiresAt],
    );
  }

  it('The newest link wins: issuing again deletes the earlier row and keeps the new one', async () => {
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const other = await store.issue(otherUserId);

    const first = await store.issue(userId);
    const second = await store.issue(userId);

    expect(await rowById(first.id)).toBeUndefined();
    expect(await rowById(second.id)).toBeDefined();
    expect(await rowsOfUser(userId)).toHaveLength(1);
    // Another user's token is untouched.
    expect(await rowById(other.id)).toBeDefined();
  });

  it('Only a digest is stored: the row holds the sha256 digest and no row holds the token', async () => {
    const userId = randomUUID();
    const { id, token } = await store.issue(userId);

    const row = await rowById(id);
    expect(row).toBeDefined();
    expect(row?.identifier).toBe(`${PREFIX}${id}`);
    expect(parseResetTokenValue(row?.value ?? '')).toEqual({
      digest: digestResetToken(token),
      userId,
      failures: 0,
    });
    expect(row?.identifier).not.toContain(token);
    expect(row?.value).not.toContain(token);

    const leaks = await authPool.query(
      'select 1 from auth.verification where position($1 in identifier) > 0 or position($1 in value) > 0',
      [token],
    );
    expect(leaks.rowCount).toBe(0);
  });

  it('the row expires 30 minutes after issue', async () => {
    const before = Date.now();
    const { id } = await store.issue(randomUUID());
    const after = Date.now();

    const row = await rowById(id);
    const expiry = row?.expires_at.getTime() ?? 0;
    // Allow a little slack for clock differences between this process and the database.
    expect(expiry).toBeGreaterThanOrEqual(before + THIRTY_MINUTES_MS - 5000);
    expect(expiry).toBeLessThanOrEqual(after + THIRTY_MINUTES_MS + 5000);
  });

  it('expired rows are purged by the next issue', async () => {
    const strangerExpired = randomUUID();
    const strangerLive = randomUUID();
    await insertRaw(strangerExpired, randomUUID(), new Date(Date.now() - 60_000));
    await insertRaw(strangerLive, randomUUID(), new Date(Date.now() + 10 * 60_000));

    await store.issue(randomUUID());

    expect(await rowById(strangerExpired)).toBeUndefined();
    // A live row of another user is not touched.
    expect(await rowById(strangerLive)).toBeDefined();
  });
});

/**
 * Task 2.4 (design D3, D7 step 1; precedent `markInvitationAccepted(..., db?)`).
 *
 * ## Production symbols expected
 *
 * ```ts
 * // apps/api/src/identity/reset-token-store.ts, added to ResetTokenStore
 * export type ResetTokenLookup =
 *   | { status: 'found'; userId: string; failures: number }
 *   | { status: 'not_found' | 'expired' | 'token_mismatch' };
 * lookup: (id: string, token: string, db?: Pick<Pool, 'query'>) => Promise<ResetTokenLookup>;
 * ```
 *
 * Without `db` the read runs on the pool; with `db` it runs on that client.
 */
describe('reset token store: lookup (task 2.4)', () => {
  let authPool: Pool;
  let store: ResetTokenStore;

  beforeAll(async () => {
    ({ authPool } = await harnessPools());
    await runMigrations(authPool);
    store = createResetTokenStore({ authPool, withUserLock: createWithUserLock(authPool) });
  }, 60_000);

  async function insertWithDigest(
    db: Pick<Pool, 'query'>,
    id: string,
    token: string,
    userId: string,
    expiresAt: Date,
  ): Promise<void> {
    await db.query(
      `insert into auth.verification (id, identifier, value, expires_at, created_at, updated_at)
       values ($1, $2, $3, $4, now(), now())`,
      [randomUUID(), `${PREFIX}${id}`, `v1:${digestResetToken(token)}:${userId}:0`, expiresAt],
    );
  }

  it('a live token with the right secret is found, with its user and failure count', async () => {
    const userId = randomUUID();
    const { id, token } = await store.issue(userId);

    expect(await store.lookup(id, token)).toEqual({ status: 'found', userId, failures: 0 });
  });

  it('A token expires after 30 minutes: one issued 30 minutes and one second ago is expired', async () => {
    const id = randomUUID();
    const token = randomUUID();
    await insertWithDigest(authPool, id, token, randomUUID(), new Date(Date.now() - 1000));

    expect(await store.lookup(id, token)).toEqual({ status: 'expired' });
  });

  it('an unknown id is not_found', async () => {
    const { token } = await store.issue(randomUUID());

    expect(await store.lookup(randomUUID(), token)).toEqual({ status: 'not_found' });
  });

  it('a wrong token for a live id is token_mismatch', async () => {
    const { id } = await store.issue(randomUUID());

    expect(await store.lookup(id, 'not-the-token')).toEqual({ status: 'token_mismatch' });
  });

  it('with a db argument the statement runs on that client and not on the pool', async () => {
    const id = randomUUID();
    const token = randomUUID();
    const userId = randomUUID();
    const client = await authPool.connect();
    try {
      await client.query('begin');
      // Uncommitted: visible to this client only.
      await insertWithDigest(client, id, token, userId, new Date(Date.now() + 60_000));

      expect(await store.lookup(id, token, client)).toEqual({
        status: 'found',
        userId,
        failures: 0,
      });
      expect(await store.lookup(id, token)).toEqual({ status: 'not_found' });
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});
