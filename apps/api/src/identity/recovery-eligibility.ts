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
  /** Present when eligible: the Better Auth user id and the tenant ids of all memberships. */
  readonly userId?: string;
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

      const accounts = await repository.globalAccountsOf(user.id);
      if (!accounts.some((a) => a.providerId === 'credential')) {
        return { status: 'no_credential_account', email };
      }
      if ((await repository.globalUserBanned(user.id)) === true) {
        return { status: 'banned', email };
      }

      const tenantIds = await repository.globalMembershipTenantsOf(user.id);
      if (tenantIds.length === 0) return { status: 'no_membership', email };

      // A membership with no `_user` row (null) does not count as enabled.
      const statuses = await Promise.all(
        tenantIds.map((tenantId) => options.userSync.readStatus({ tenantId, email })),
      );
      if (!statuses.some((status) => status !== null && status !== 'Disabled')) {
        return { status: 'disabled_everywhere', email };
      }
      return { status: 'eligible', email, userId: user.id, tenantIds };
    },
  };
}
