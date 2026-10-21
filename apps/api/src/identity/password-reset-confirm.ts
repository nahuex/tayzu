/**
 * The confirm half of the password reset (`044` design D2 "Order of work, confirm route").
 * This skeleton runs the strict parse, the token lookup and the eligibility re-check; every
 * refusal that depends on the token or the account is the one uniform `CATALOG_NOT_FOUND`.
 * The completion (D7 steps 4-12) runs on the lock's connection; the password-changed notice
 * (D8) is sent after the commit.
 */
import {
  AuthStepUpError,
  emitIdentityEvent,
  emitSessionRevoked,
  hashPasswordNfc,
  type IdentitySpanHandle,
  isPasswordCompromised,
  recordIdentityMetric,
  validatePassword,
  withIdentitySpan,
} from '@tayzu/auth';

import {
  verifyResetFactor,
  type ResetFactorInput,
} from '../../../../packages/auth/src/identity/reset-factor.js';
import { createAuthRepository, type TwoFactorStateRead } from './auth-repository.js';
import { IdentityInputError, parseIdentityInput, type InputSchema } from './parse-input.js';
import type { RecoveryMailer } from './recovery-mailer.js';
import type { RecoveryEligibilityChecker } from './recovery-eligibility.js';
import type { ResetTokenStore } from './reset-token-store.js';
import type { WithUserLock } from './user-lock.js';

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const RESET_ID_LENGTH = 22;
const RESET_TOKEN_LENGTH = 43;
/** Code units; the policy maximum (128 code points) is checked later by `validatePassword`. */
const MAX_NEW_PASSWORD_LENGTH = 512;
const MAX_FACTOR_CODE_LENGTH = 32;
/** The failure budget of one token (D3). */
const MAX_TOKEN_FAILURES = 5;

const CONFIRM_BODY_SCHEMA: InputSchema = {
  body: {
    id: {
      kind: 'string',
      minLength: RESET_ID_LENGTH,
      maxLength: RESET_ID_LENGTH,
      pattern: BASE64URL,
    },
    token: {
      kind: 'string',
      minLength: RESET_TOKEN_LENGTH,
      maxLength: RESET_TOKEN_LENGTH,
      pattern: BASE64URL,
    },
    newPassword: { kind: 'string', maxLength: MAX_NEW_PASSWORD_LENGTH },
    factor: { kind: 'object', optional: true },
  },
};

/** A password refused by the policy or the breach check; names only the rule (D7). */
export class ResetPasswordRefusedError extends Error {
  readonly code = 'CATALOG_VALIDATION_FAILED' as const;
  readonly issues: readonly { path: string; message: string }[];

  constructor(rule: string) {
    super(`The password does not meet the policy: ${rule}`);
    this.name = 'ResetPasswordRefusedError';
    this.issues = [{ path: '/newPassword', message: rule }];
  }
}

/** The uniform rejection: same code and text as the catalog's not-found. */
export class ResetNotFoundError extends Error {
  readonly code = 'CATALOG_NOT_FOUND' as const;

  constructor() {
    super('The requested resource was not found');
    this.name = 'ResetNotFoundError';
  }
}

export interface ConfirmFactor {
  readonly kind: 'totp' | 'backup_code';
  readonly code: string;
}

/** The D6 predicate: enrolled needs the flag and a verified row; exactly one of them is inconsistent. */
function enrolmentOf(state: TwoFactorStateRead): 'none' | 'inconsistent' | 'enrolled' {
  const hasVerifiedRow = state.rows.some((row) => row.verified);
  if (!state.twoFactorEnabled && !hasVerifiedRow) return 'none';
  return state.twoFactorEnabled && hasVerifiedRow ? 'enrolled' : 'inconsistent';
}

/** Checks the declared shape of the opaque `factor` object (already screened for forbidden keys). */
function parseFactor(raw: unknown): ConfirmFactor {
  const factor = raw as Record<string, unknown>;
  const keys = Object.keys(factor);
  const { kind, code } = factor;
  if (
    keys.length !== 2 ||
    (kind !== 'totp' && kind !== 'backup_code') ||
    typeof code !== 'string' ||
    code.length < 1 ||
    code.length > MAX_FACTOR_CODE_LENGTH
  ) {
    throw new IdentityInputError();
  }
  return { kind, code };
}

/** Why the route refused a request cross-site; the flow reports it as a denial (D15). */
export type ConfirmCrossSiteDenial = 'csrf_rejected' | 'origin_rejected';

export interface PasswordResetConfirmFlow {
  /** Throws `CATALOG_VALIDATION_FAILED` for a malformed body, before any lookup. */
  handle(input: {
    readonly body: unknown;
    readonly crossSiteDenial?: ConfirmCrossSiteDenial;
  }): Promise<void>;
}

type ConfirmOutcome =
  'rejected' | 'factor_required' | 'policy_refused' | 'breach_check_unavailable';

type ResetMfa = 'not_enrolled' | ConfirmFactor['kind'];
type SessionsEnded = Awaited<
  ReturnType<ReturnType<typeof createAuthRepository>['globalDeleteSessionsOf']>
>;

/** A refusal decided inside the lock: the reason names the predicate, the kind picks the answer. */
interface LockRefusal {
  readonly kind: 'rejected' | 'step_up';
  readonly reason: string;
}

export function createPasswordResetConfirmFlow(options: {
  readonly authPool: Parameters<typeof createAuthRepository>[0];
  readonly eligibility: RecoveryEligibilityChecker;
  readonly tokens: ResetTokenStore;
  readonly withUserLock: WithUserLock;
  /** Sends the password-changed notice after the commit; absent when email is not configured. */
  readonly mailer?: RecoveryMailer;
  /** `(await auth.$context).secretConfig`, for the factor verifier (D6). */
  readonly secretConfig: ResetFactorInput['secretConfig'];
}): PasswordResetConfirmFlow {
  const repository = createAuthRepository(options.authPool);

  /** One refusal: the denial event, the outcome counter, then the answer's error. */
  function refuse(reason: string, outcome: ConfirmOutcome, error: Error, userId?: string): never {
    emitIdentityEvent({
      name: 'catalog.security.password_reset_denied',
      severity: 'WARN',
      attributes: {
        'tayzu.identity.reset.denial_reason': reason,
        ...(userId === undefined ? {} : { 'tayzu.identity.user.id': userId }),
      },
    });
    recordIdentityMetric('tayzu.identity.password_reset_confirms', 1, {
      'tayzu.identity.reset.confirm_outcome': outcome,
    });
    throw error;
  }

  /** The failure that reaches the budget burns the token (D3). */
  function failureReason(failures: number | undefined): string {
    return failures !== undefined && failures >= MAX_TOKEN_FAILURES
      ? 'attempts_exhausted'
      : 'factor_invalid';
  }

  async function run(
    span: IdentitySpanHandle,
    body: unknown,
    crossSiteDenial: ConfirmCrossSiteDenial | undefined,
  ): Promise<void> {
    if (crossSiteDenial !== undefined) {
      refuse(crossSiteDenial, 'rejected', new ResetNotFoundError());
    }
    let parsed: ReturnType<typeof parseIdentityInput>['body'];
    let factor: ConfirmFactor | undefined;
    try {
      parsed = parseIdentityInput(CONFIRM_BODY_SCHEMA, { body }).body;
      factor = parsed['factor'] === undefined ? undefined : parseFactor(parsed['factor']);
    } catch (error) {
      if (error instanceof IdentityInputError) refuse('malformed_request', 'rejected', error);
      throw error;
    }

    const tokenId = parsed['id'] as string;
    const rawToken = parsed['token'] as string;
    const lookup = await options.tokens.lookup(tokenId, rawToken);
    if (lookup.status !== 'found') refuse(lookup.status, 'rejected', new ResetNotFoundError());
    const userId = lookup.userId;

    const user = await repository.globalUserById(userId);
    if (user === undefined) refuse('not_eligible', 'rejected', new ResetNotFoundError());
    const eligibility = await options.eligibility.check(user.email);
    if (eligibility.status !== 'eligible') {
      refuse('not_eligible', 'rejected', new ResetNotFoundError(), userId);
    }

    // D6 fast fail: the read before the lock decides nothing final. An inconsistent state can
    // never be satisfied, so it answers the same way and consumes and counts nothing.
    const twoFactor = await repository.globalTwoFactorStateOf(userId);
    const enrolment = enrolmentOf(twoFactor);
    if (enrolment === 'inconsistent') {
      refuse('factor_state_inconsistent', 'factor_required', new AuthStepUpError(), userId);
    }
    if (enrolment === 'enrolled' && factor === undefined) {
      refuse('factor_invalid', 'factor_required', new AuthStepUpError(), userId);
    }

    // D7: policy, then the breach check on the NFC form, before any lock, factor or consumption.
    // An unreachable range service throws and surfaces as the sanitized INTERNAL.
    const checked = validatePassword(parsed['newPassword'] as string);
    if (!checked.ok) {
      refuse(
        'policy_violation',
        'policy_refused',
        new ResetPasswordRefusedError(checked.rule),
        userId,
      );
    }
    let compromised: boolean;
    try {
      compromised = await isPasswordCompromised(checked.password);
    } catch (error) {
      return refuse(
        'breach_check_unavailable',
        'breach_check_unavailable',
        error instanceof Error ? error : new Error('breach check unavailable'),
        userId,
      );
    }
    if (compromised) {
      refuse('breached', 'policy_refused', new ResetPasswordRefusedError('breached'), userId);
    }

    let outcome;
    try {
      outcome = await options.withUserLock(
        userId,
        async (tx): Promise<LockRefusal | { completed: SessionsEnded; mfa: ResetMfa }> => {
          // D7 step 1: the token row again, on the lock's connection.
          const again = await options.tokens.lookup(tokenId, rawToken, tx);
          if (again.status !== 'found') return { kind: 'rejected', reason: again.status };
          if (again.userId !== userId) return { kind: 'rejected', reason: 'token_mismatch' };
          if (again.failures >= MAX_TOKEN_FAILURES) {
            return { kind: 'rejected', reason: 'attempts_exhausted' };
          }
          // Step 2: a ban or a missing credential account can overtake the earlier check.
          const banned = await repository.globalUserBanned(userId, tx);
          const accounts = await repository.globalAccountsOf(userId, tx);
          if (
            banned !== false ||
            !accounts.some((account) => account.providerId === 'credential')
          ) {
            return { kind: 'rejected', reason: 'not_eligible' };
          }
          // Step 3: the enrolled predicate again; this one decides.
          const state = await repository.globalTwoFactorStateOf(userId, tx);
          const enrolled = enrolmentOf(state);
          let checkedFactorRowId: string | undefined;
          let spend: { expected: string; remaining: string | null } | undefined;
          if (enrolled !== 'none') {
            const row = state.rows.find((candidate) => candidate.verified);
            if (enrolled === 'inconsistent') {
              return { kind: 'step_up', reason: 'factor_state_inconsistent' };
            }
            if (factor === undefined || row === undefined) {
              return { kind: 'step_up', reason: 'factor_invalid' };
            }
            // D15: the span carries the kind once the factor step runs, even if it refuses.
            span.setAttributes({ 'tayzu.identity.reset.mfa': factor.kind });
            if (row.lockedUntil !== null) {
              if (row.lockedUntil.getTime() > Date.now()) {
                // Locked: not verified, one failure against the token only.
                const failures = await options.tokens.recordFailure(tokenId, tx);
                return { kind: 'step_up', reason: failureReason(failures) };
              }
              await repository.globalClearExpiredTwoFactorLock(row.id, tx);
            }
            const verdict = await verifyResetFactor({
              factor,
              twoFactor: { secret: row.secret, backupCodes: row.backupCodes },
              secretConfig: options.secretConfig,
            });
            if (!verdict.verified) {
              await repository.globalRecordTwoFactorFailure(row.id, tx);
              const failures = await options.tokens.recordFailure(tokenId, tx);
              return { kind: 'step_up', reason: failureReason(failures) };
            }
            checkedFactorRowId = row.id;
            spend = { expected: row.backupCodes, remaining: verdict.remainingBackupCodes };
          }

          // D7 step 4: the same hash function as sign-in; the password is already NFC-checked.
          const passwordHash = await hashPasswordNfc(checked.password);
          // Step 5: consume; zero rows means another completion won.
          if ((await options.tokens.consume(tokenId, tx)) === 'conflict') {
            return { kind: 'rejected', reason: 'consume_conflict' };
          }
          await repository.globalSetCredentialPassword(userId, passwordHash, tx);
          await repository.deleteResetTokensOf(userId, tx);
          await repository.globalDeleteTemporaryPasswordMarker(userId, tx);
          await repository.globalDeleteTwoFactorChallenges(userId, tx);
          await repository.globalMarkEmailVerified(userId, tx);
          // Step 10: a lost swap (a sign-in spent the same code) aborts and rolls everything back.
          if (spend?.remaining != null && checkedFactorRowId !== undefined) {
            const swapped = await repository.globalSpendBackupCode(
              checkedFactorRowId,
              spend.expected,
              spend.remaining,
              tx,
            );
            if (!swapped) throw new AuthStepUpError();
          }
          if (checkedFactorRowId !== undefined) {
            await repository.globalResetTwoFactorFailures(checkedFactorRowId, tx);
          }
          const revoked = await repository.globalDeleteSessionsOf(userId, tx);
          return {
            completed: revoked,
            mfa: enrolled === 'none' || factor === undefined ? 'not_enrolled' : factor.kind,
          };
        },
      );
    } catch (error) {
      if (error instanceof AuthStepUpError) {
        refuse('factor_invalid', 'factor_required', error, userId);
      }
      throw error;
    }
    if ('kind' in outcome) {
      refuse(
        outcome.reason,
        outcome.kind === 'rejected' ? 'rejected' : 'factor_required',
        outcome.kind === 'rejected' ? new ResetNotFoundError() : new AuthStepUpError(),
        userId,
      );
    }

    // After the commit: one event per ended session; the tenant is omitted when it has none.
    for (const session of outcome.completed) {
      emitSessionRevoked({
        actorId: userId,
        ...(session.tenantId === null ? {} : { tenantId: session.tenantId }),
        reason: 'password_reset',
      });
    }
    span.setAttributes({ 'tayzu.identity.reset.mfa': outcome.mfa });
    emitIdentityEvent({
      name: 'catalog.audit.password_reset_completed',
      severity: 'INFO',
      attributes: {
        'tayzu.identity.user.id': userId,
        'tayzu.identity.reset.mfa': outcome.mfa,
        'tayzu.identity.sessions.revoked': outcome.completed.length,
      },
    });
    recordIdentityMetric('tayzu.identity.password_reset_confirms', 1, {
      'tayzu.identity.reset.confirm_outcome': 'completed',
    });

    // After the commit, to the canonical address; sendNotice never rejects (a failure is logged).
    await options.mailer?.sendNotice({
      kind: 'PasswordChangedNotice',
      address: eligibility.email,
      userId,
      tenantIds: eligibility.tenantIds ?? [],
    });
  }

  return {
    handle: ({ body, crossSiteDenial }) =>
      withIdentitySpan('identity.password_reset.confirm', {}, (span) =>
        run(span, body, crossSiteDenial),
      ),
  };
}
