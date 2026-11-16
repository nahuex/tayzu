/**
 * Who may receive a password-reset email (044 design D4, Resolved decision Q4). The result is an
 * internal enum used only for signals and the decision to admit and issue; it never reaches the
 * caller. Reads only through the auth-schema repository and the user-sync adapter.
 */
import type { Pool } from 'pg';

import { createAuthRepository } from './auth-repository.js';
import { canonicalEmail } from './email-canonical.js';
import type { UserSyncAdapter } from './user-sync-adapter.js';

export type RecoveryEligibilityStatus =
  | 'eligible'
  | 'unknown_address'
  | 'no_credential_account'
  | 'banned'
  | 'disabled_everywhere'
  | 'no_membership';

export interface RecoveryEligibility {
  readonly status: RecoveryEligibilityStatus;
  /** The canonical form of the address that every lookup used. */
  readonly email: string;
  /**
   * Present only when eligible: the Better Auth user id a reset may be issued for. An ineligible
   * account never has it, so no caller can admit or issue from it by mistake.
   */
  readonly userId?: string;
  /**
   * The opaque user id of every known account, eligible or not; absent for `unknown_address`.
   * For signals only (design D5: a suppression names a known account by its id).
   */
  readonly knownUserId?: string;
  /** Present only when eligible: the tenant ids of all memberships. */
  readonly tenantIds?: readonly string[];
}

export interface RecoveryEligibilityChecker {
  check: (rawEmail: string) => Promise<RecoveryEligibility>;
}

export function createRecoveryEligibility(options: {
  authPool: Pool;
  userSync: Pick<UserSyncAdapter, 'readStatus'>;
}): RecoveryEligibilityChecker {
  const repository = createAuthRepository(options.authPool);

  return {
    async check(rawEmail) {
      const email = canonicalEmail(rawEmail);
      const user = await repository.globalUserByEmail(email);
      if (user === undefined) return { status: 'unknown_address', email };

      const knownUserId = user.id;
      const accounts = await repository.globalAccountsOf(knownUserId);
      if (!accounts.some((a) => a.providerId === 'credential')) {
        return { status: 'no_credential_account', email, knownUserId };
      }
      if ((await repository.globalUserBanned(knownUserId)) === true) {
        return { status: 'banned', email, knownUserId };
      }

      const tenantIds = await repository.globalMembershipTenantsOf(knownUserId);
      if (tenantIds.length === 0) return { status: 'no_membership', email, knownUserId };

      // A membership with no `_user` row (null) does not count as enabled.
      const statuses = await Promise.all(
        tenantIds.map((tenantId) => options.userSync.readStatus({ tenantId, email })),
      );
      if (!statuses.some((status) => status !== null && status !== 'Disabled')) {
        return { status: 'disabled_everywhere', email, knownUserId };
      }
      return { status: 'eligible', email, userId: knownUserId, knownUserId, tenantIds };
    },
  };
}
