/**
 * The admin form's `RecoveryNoticePort` (044 task 10.5): an adapter over the mailer's notice
 * path (task 5.5). It reads the target's address and memberships, hands the notice to the
 * mailer, which never rejects, and reports `suppressed` when no mailer is wired.
 */
import type { AuthRepository } from './auth-repository.js';
import type { RecoveryNoticePort } from './mfa-reset.js';
import type { RecoveryMailer } from './recovery-mailer.js';

export function createMailerNoticePort(deps: {
  readonly authRepository: AuthRepository;
  readonly recoveryMailer: RecoveryMailer | undefined;
}): RecoveryNoticePort {
  return {
    async send(kind, userId) {
      const { recoveryMailer } = deps;
      if (recoveryMailer === undefined) return 'suppressed';
      try {
        const user = await deps.authRepository.globalUserById(userId);
        if (user === undefined) return 'failed';
        const tenantIds = await deps.authRepository.globalMembershipTenantsOf(userId);
        await recoveryMailer.sendNotice({ kind, address: user.email, userId, tenantIds });
        // The mailer reports no outcome: `sent` means handed to it.
        return 'sent';
      } catch {
        return 'failed';
      }
    },
  };
}
