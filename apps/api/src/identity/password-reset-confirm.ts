/**
 * The confirm half of the password reset (`044` design D2 "Order of work, confirm route").
 * This skeleton runs the strict parse, the token lookup and the eligibility re-check; every
 * refusal that depends on the token or the account is the one uniform `CATALOG_NOT_FOUND`.
 * The completion (D7 steps 4-12) runs on the lock's connection; the password-changed notice
 * (D8) is sent after the commit.
 */
import {
  AuthStepUpError,
  emitSessionRevoked,
  hashPasswordNfc,
  isPasswordCompromised,
  validatePassword,
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

export interface PasswordResetConfirmFlow {
  /** Throws `CATALOG_VALIDATION_FAILED` for a malformed body, before any lookup. */
  handle(input: { readonly body: unknown }): Promise<void>;
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
  return {
    async handle({ body }) {
      const parsed = parseIdentityInput(CONFIRM_BODY_SCHEMA, { body }).body;
      const factor = parsed['factor'] === undefined ? undefined : parseFactor(parsed['factor']);

      const lookup = await options.tokens.lookup(parsed['id'] as string, parsed['token'] as string);
      if (lookup.status !== 'found') throw new ResetNotFoundError();

      const user = await repository.globalUserById(lookup.userId);
      if (user === undefined) throw new ResetNotFoundError();
      const eligibility = await options.eligibility.check(user.email);
      if (eligibility.status !== 'eligible') throw new ResetNotFoundError();

      // D6 fast fail: the read before the lock decides nothing final. An inconsistent state can
      // never be satisfied, so it answers the same way and consumes and counts nothing.
      const twoFactor = await repository.globalTwoFactorStateOf(lookup.userId);
      const enrolment = enrolmentOf(twoFactor);
      if (enrolment === 'inconsistent' || (enrolment === 'enrolled' && factor === undefined)) {
        throw new AuthStepUpError();
      }

      // D7: policy, then the breach check on the NFC form, before any lock, factor or consumption.
      // An unreachable range service throws and surfaces as the sanitized INTERNAL.
      const checked = validatePassword(parsed['newPassword'] as string);
      if (!checked.ok) throw new ResetPasswordRefusedError(checked.rule);
      if (await isPasswordCompromised(checked.password)) {
        throw new ResetPasswordRefusedError('breached');
      }

      const tokenId = parsed['id'] as string;
      const rawToken = parsed['token'] as string;
      const outcome = await options.withUserLock(lookup.userId, async (tx) => {
        // D7 step 1: the token row again, on the lock's connection.
        const again = await options.tokens.lookup(tokenId, rawToken, tx);
        if (
          again.status !== 'found' ||
          again.userId !== lookup.userId ||
          again.failures >= MAX_TOKEN_FAILURES
        ) {
          return 'rejected' as const;
        }
        // Step 2: a ban or a missing credential account can overtake the earlier check.
        const banned = await repository.globalUserBanned(lookup.userId, tx);
        const accounts = await repository.globalAccountsOf(lookup.userId, tx);
        if (banned !== false || !accounts.some((account) => account.providerId === 'credential')) {
          return 'rejected' as const;
        }
        // Step 3: the enrolled predicate again; this one decides.
        const state = await repository.globalTwoFactorStateOf(lookup.userId, tx);
        const enrolled = enrolmentOf(state);
        let checkedFactorRowId: string | undefined;
        let spend: { expected: string; remaining: string | null } | undefined;
        if (enrolled !== 'none') {
          const row = state.rows.find((candidate) => candidate.verified);
          if (enrolled === 'inconsistent' || factor === undefined || row === undefined) {
            return 'step_up' as const;
          }
          if (row.lockedUntil !== null) {
            if (row.lockedUntil.getTime() > Date.now()) {
              // Locked: not verified, one failure against the token only.
              await options.tokens.recordFailure(tokenId, tx);
              return 'step_up' as const;
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
            await options.tokens.recordFailure(tokenId, tx);
            return 'step_up' as const;
          }
          checkedFactorRowId = row.id;
          spend = { expected: row.backupCodes, remaining: verdict.remainingBackupCodes };
        }

        // D7 step 4: the same hash function as sign-in; the password is already NFC-checked.
        const passwordHash = await hashPasswordNfc(checked.password);
        // Step 5: consume; zero rows means another completion won.
        if ((await options.tokens.consume(tokenId, tx)) === 'conflict') {
          return 'rejected' as const;
        }
        await repository.globalSetCredentialPassword(lookup.userId, passwordHash, tx);
        await repository.deleteResetTokensOf(lookup.userId, tx);
        await repository.globalDeleteTemporaryPasswordMarker(lookup.userId, tx);
        await repository.globalDeleteTwoFactorChallenges(lookup.userId, tx);
        await repository.globalMarkEmailVerified(lookup.userId, tx);
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
        const revoked = await repository.globalDeleteSessionsOf(lookup.userId, tx);
        return { completed: revoked };
      });
      if (outcome === 'rejected') throw new ResetNotFoundError();
      if (outcome === 'step_up') throw new AuthStepUpError();

      // After the commit: one event per ended session; the tenant is omitted when it has none.
      for (const session of outcome.completed) {
        emitSessionRevoked({
          actorId: lookup.userId,
          ...(session.tenantId === null ? {} : { tenantId: session.tenantId }),
          reason: 'password_reset',
        });
      }

      // After the commit, to the canonical address; sendNotice never rejects (a failure is logged).
      await options.mailer?.sendNotice({
        kind: 'PasswordChangedNotice',
        address: eligibility.email,
        userId: lookup.userId,
        tenantIds: eligibility.tenantIds ?? [],
      });
    },
  };
}
