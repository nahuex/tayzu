/**
 * The password reset token's API (`044` design D3). It holds no SQL of its own: the
 * statements live in the verification section of `auth-repository.ts`.
 */
import type { Pool } from 'pg';

import { formatResetTokenValue } from '../../../../packages/auth/src/identity/reset-token-value.js';
import {
  digestResetToken,
  generateResetToken,
} from '../../../../packages/auth/src/identity/reset-token.js';
import { createAuthRepository } from './auth-repository.js';
import type { WithUserLock } from './user-lock.js';

/** A reset link lives 30 minutes (Q3, Q23); not configurable. */
const RESET_TOKEN_TTL_SECONDS = 30 * 60;

export interface ResetTokenStore {
  /**
   * Under the per-user lock, deletes the user's earlier rows and every expired row, then
   * inserts the new one. Returns the id and the raw token; only the digest is stored.
   */
  issue: (userId: string) => Promise<{ id: string; token: string }>;
}

export function createResetTokenStore(options: {
  authPool: Pool;
  withUserLock: WithUserLock;
}): ResetTokenStore {
  const repository = createAuthRepository(options.authPool);
  return {
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
