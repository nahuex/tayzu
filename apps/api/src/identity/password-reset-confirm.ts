/**
 * The confirm half of the password reset (`044` design D2 "Order of work, confirm route").
 * This skeleton runs the strict parse, the token lookup and the eligibility re-check; every
 * refusal that depends on the token or the account is the one uniform `CATALOG_NOT_FOUND`.
 * The completion (factor, policy, effects) is not implemented yet.
 */
import { AuthStepUpError, isPasswordCompromised, validatePassword } from '@tayzu/auth';

import { createAuthRepository } from './auth-repository.js';
import { IdentityInputError, parseIdentityInput, type InputSchema } from './parse-input.js';
import type { RecoveryEligibilityChecker } from './recovery-eligibility.js';
import type { ResetTokenStore } from './reset-token-store.js';

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const RESET_ID_LENGTH = 22;
const RESET_TOKEN_LENGTH = 43;
/** Code units; the policy maximum (128 code points) is checked later by `validatePassword`. */
const MAX_NEW_PASSWORD_LENGTH = 512;
const MAX_FACTOR_CODE_LENGTH = 32;

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
}): PasswordResetConfirmFlow {
  const repository = createAuthRepository(options.authPool);
  return {
    async handle({ body }) {
      const parsed = parseIdentityInput(CONFIRM_BODY_SCHEMA, { body }).body;
      if (parsed['factor'] !== undefined) parseFactor(parsed['factor']);

      const lookup = await options.tokens.lookup(parsed['id'] as string, parsed['token'] as string);
      if (lookup.status !== 'found') throw new ResetNotFoundError();

      const user = await repository.globalUserById(lookup.userId);
      if (user === undefined) throw new ResetNotFoundError();
      const eligibility = await options.eligibility.check(user.email);
      if (eligibility.status !== 'eligible') throw new ResetNotFoundError();

      // D6 fast fail: the read before the lock decides nothing final. Enrolled means the flag OR
      // a verified row; an inconsistent state (only one of them) can never be satisfied, so it
      // answers the same way and consumes and counts nothing.
      const twoFactor = await repository.globalTwoFactorStateOf(lookup.userId);
      const hasVerifiedRow = twoFactor.rows.some((row) => row.verified);
      if (
        (twoFactor.twoFactorEnabled || hasVerifiedRow) &&
        (!twoFactor.twoFactorEnabled || !hasVerifiedRow || parsed['factor'] === undefined)
      ) {
        throw new AuthStepUpError();
      }

      // D7: policy, then the breach check on the NFC form, before any lock, factor or consumption.
      // An unreachable range service throws and surfaces as the sanitized INTERNAL.
      const checked = validatePassword(parsed['newPassword'] as string);
      if (!checked.ok) throw new ResetPasswordRefusedError(checked.rule);
      if (await isPasswordCompromised(checked.password)) {
        throw new ResetPasswordRefusedError('breached');
      }

      // Task 8.9 replaces this with the completion; until then the sanitized INTERNAL 500.
      throw new Error('The password reset completion is not implemented');
    },
  };
}
