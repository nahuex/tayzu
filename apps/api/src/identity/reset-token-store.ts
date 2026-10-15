/**
 * The password reset token's API (`044` design D3). It holds no SQL of its own: the
 * statements live in the verification section of `auth-repository.ts`.
 */
import type { Pool } from 'pg';

import {
  formatResetTokenValue,
  parseResetTokenValue,
} from '../../../../packages/auth/src/identity/reset-token-value.js';
import {
  digestResetToken,
  generateResetToken,
  verifyResetToken,
} from '../../../../packages/auth/src/identity/reset-token.js';
import { createAuthRepository } from './auth-repository.js';
import type { WithUserLock } from './user-lock.js';

/** A reset link lives 30 minutes (Q3, Q23); not configurable. */
const RESET_TOKEN_TTL_SECONDS = 30 * 60;

/** The reason is for internal use only; callers answer every non-`found` status alike. */
export type ResetTokenLookup =
  | { status: 'found'; userId: string; failures: number }
  | { status: 'not_found' | 'expired' | 'token_mismatch' };

export interface ResetTokenStore {
  /**
   * Under the per-user lock, deletes the user's earlier rows and every expired row, then
   * inserts the new one. Returns the id and the raw token; only the digest is stored.
   */
  issue: (userId: string) => Promise<{ id: string; token: string }>;
  /**
   * Reads the row by id and checks the digest in constant time. `db` is the lock's
   * connection when the completion re-reads the row; without it the read uses the pool.
   */
  lookup: (id: string, token: string, db?: Pick<Pool, 'query'>) => Promise<ResetTokenLookup>;
  /**
   * Counts one failed factor with one atomic conditional update, then deletes the row once
   * the count reaches 5. Resolves to the new count, or `undefined` when no row was updated.
   */
  recordFailure: (id: string, db?: Pick<Pool, 'query'>) => Promise<number | undefined>;
}

/** The failure budget of one token (D3). */
const MAX_FAILURES = 5;

export function createResetTokenStore(options: {
  authPool: Pool;
  withUserLock: WithUserLock;
}): ResetTokenStore {
  const repository = createAuthRepository(options.authPool);
  return {
    async lookup(id, token, db = options.authPool) {
      const row = await repository.findResetToken(id, db);
      if (row === undefined) return { status: 'not_found' };
      const parsed = parseResetTokenValue(row.value);
      const matches = verifyResetToken(token, parsed?.digest ?? null);
      if (row.expired) return { status: 'expired' };
      if (parsed === null || !matches) return { status: 'token_mismatch' };
      return { status: 'found', userId: parsed.userId, failures: parsed.failures };
    },
    async recordFailure(id, db = options.authPool) {
      const failures = await repository.incrementResetTokenFailures(id, db);
      if (failures !== undefined && failures >= MAX_FAILURES) {
        await repository.deleteResetToken(id, db);
      }
      return failures;
    },
    issue: (userId) =>
      options.withUserLock(userId, async (tx) => {
        await repository.deleteResetTokensOf(userId, tx);
        await repository.deleteExpiredResetTokens(tx);
        const { id, token } = generateResetToken();
        await repository.insertResetToken(
          {
            id,
            value: formatResetTokenValue({ digest: digestResetToken(token), userId, failures: 0 }),
            ttlSeconds: RESET_TOKEN_TTL_SECONDS,
          },
          tx,
        );
        return { id, token };
      }),
  };
}
