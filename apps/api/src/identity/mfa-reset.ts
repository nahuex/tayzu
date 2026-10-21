/**
 * The MFA reset service shared by the admin operation and the operator CLI (044 design D10
 * "Effects", D11, D12). It works on the `tayzu_auth` pool with parameterized SQL inside the
 * per-user lock and builds no Better Auth instance and no mailer: the notice goes out through
 * the `RecoveryNoticePort` its caller supplies.
 */
import {
  emitIdentityEvent,
  emitSessionRevoked,
  recordIdentityMetric,
  withIdentitySpan,
} from '@tayzu/auth';
import type { Pool } from 'pg';

import { createAuthRepository } from './auth-repository.js';
import { createWithUserLock } from './user-lock.js';

/** Fixed message and code for every admin-form refusal: nothing says which predicate held (D10, Q12). */
class MfaResetRefusedError extends Error {
  readonly code = 'CATALOG_VALIDATION_FAILED' as const;

  constructor() {
    super('The request was rejected');
    this.name = 'MfaResetRefusedError';
  }
}

export type MfaResetReason =
  'lost_both_factors' | 'device_replaced' | 'suspected_compromise' | 'identity_verified_request';

export type NoticeOutcome = 'sent' | 'suppressed' | 'failed';

export interface RecoveryNoticePort {
  /** Never throws. */
  send(kind: 'MfaResetNotice', userId: string): Promise<NoticeOutcome>;
}

export interface MfaResetResult {
  readonly sessionsRevoked: number;
  readonly notice: NoticeOutcome;
}

export interface MfaResetService {
  resetAdmin(input: {
    tenantId: string;
    actorId: string;
    userId: string;
    reason: MfaResetReason;
  }): Promise<MfaResetResult>;
  resetOperator(input: {
    tenantId: string;
    operatorId: string;
    approverId: string;
    userId: string;
  }): Promise<MfaResetResult>;
}

export interface MfaResetServiceOptions {
  readonly authPool: Pool;
  readonly notices: RecoveryNoticePort;
}

export function createMfaResetService(options: MfaResetServiceOptions): MfaResetService {
  const repository = createAuthRepository(options.authPool);
  const withUserLock = createWithUserLock(options.authPool);

  /**
   * The single refusal path of the admin form (D10, Q12): every predicate is read, none
   * short-circuits, and one `refuse` throws the same error whatever held. The internal reason
   * goes only to the log, with opaque identifiers.
   */
  async function refuseUnlessAllowed(
    tenantId: string,
    actorId: string,
    userId: string,
  ): Promise<void> {
    const twoFactor = await repository.globalTwoFactorStateOf(userId);
    const tenants = await repository.globalMembershipTenantsOf(userId);
    const member = await repository.memberOf(tenantId, userId);
    const hasFactor = twoFactor.twoFactorEnabled || twoFactor.rows.some((row) => row.verified);
    const inOtherTenant = tenants.some((id) => id !== tenantId);
    const notPlainMember = member?.role !== 'member';
    const isSelf = actorId === userId;

    if (!isSelf && hasFactor && !inOtherTenant && !notPlainMember) return;
    if (isSelf) {
      emitIdentityEvent({
        name: 'catalog.security.self_mfa_reset_denied',
        severity: 'WARN',
        attributes: { 'tayzu.tenant.id': tenantId, 'tayzu.actor.id': actorId },
      });
    } else {
      emitIdentityEvent({
        name: 'catalog.security.identity_conflict_refused',
        severity: 'WARN',
        attributes: {
          'tayzu.tenant.id': tenantId,
          'tayzu.actor.id': actorId,
          'tayzu.identity.conflict.reason': !hasFactor
            ? 'no_enrolled_factor'
            : inOtherTenant
              ? 'target_in_other_tenant'
              : 'target_is_admin_or_owner',
          'tayzu.identity.user.id': userId,
        },
      });
    }
    throw new MfaResetRefusedError();
  }

  async function run(
    path: 'admin' | 'operator',
    tenantId: string,
    userId: string,
    audit: Readonly<Record<string, string>>,
  ): Promise<MfaResetResult> {
    return withIdentitySpan(
      'identity.mfa.reset',
      { 'tayzu.identity.mfa_reset.path': path },
      async () => {
        const sessions = await withUserLock(userId, async (tx) => {
          await repository.deleteTwoFactorRows(userId, tx);
          await repository.setTwoFactorEnabled(userId, false, tx);
          await repository.writeMfaReenrolMarker(userId, tx);
          const deleted = await repository.globalDeleteSessionsOf(userId, tx);
          await repository.globalDeleteTwoFactorChallenges(userId, tx);
          return deleted;
        });

        // After the commit: one event per ended session; the tenant is omitted when it has none.
        for (const session of sessions) {
          emitSessionRevoked({
            actorId: userId,
            ...(session.tenantId === null ? {} : { tenantId: session.tenantId }),
            reason: 'mfa_reset',
          });
        }

        const notice = await options.notices.send('MfaResetNotice', userId);
        emitIdentityEvent({
          name: 'catalog.audit.mfa_reset',
          severity: 'INFO',
          attributes: {
            'tayzu.tenant.id': tenantId,
            ...audit,
            'tayzu.identity.user.id': userId,
            'tayzu.identity.sessions.revoked': sessions.length,
          },
        });
        recordIdentityMetric('tayzu.identity.mfa_resets', 1, {
          'tayzu.tenant.id': tenantId,
          'tayzu.identity.mfa_reset.path': path,
        });
        return { sessionsRevoked: sessions.length, notice };
      },
    );
  }

  return {
    resetAdmin: async ({ tenantId, actorId, userId, reason }) => {
      await refuseUnlessAllowed(tenantId, actorId, userId);
      return run('admin', tenantId, userId, {
        'tayzu.actor.id': actorId,
        'tayzu.identity.mfa_reset.reason': reason,
      });
    },
    resetOperator: ({ tenantId, operatorId, approverId, userId }) =>
      run('operator', tenantId, userId, {
        'tayzu.identity.operator.id': operatorId,
        'tayzu.identity.approver.id': approverId,
      }),
  };
}
