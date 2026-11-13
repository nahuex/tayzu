/**
 * The pure factor verifier of the password-reset confirm route (044 design D6): no
 * database, no telemetry. The route passes the stored, encrypted `two_factor` columns and
 * the instance's `secretConfig` (`(await auth.$context).secretConfig`).
 */
import { createHash, timingSafeEqual } from 'node:crypto';

import { createOTP } from '@better-auth/utils/otp';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';

type SecretConfig = Parameters<typeof symmetricDecrypt>[0]['key'];

export interface ResetFactorInput {
  readonly factor: { readonly kind: 'totp' | 'backup_code'; readonly code: string };
  /** The stored, encrypted columns of the user's `two_factor` row. */
  readonly twoFactor: { readonly secret: string; readonly backupCodes: string };
  readonly secretConfig: SecretConfig;
}

export type ResetFactorResult =
  | { readonly verified: false }
  | {
      readonly verified: true;
      /** Re-encrypted list without the spent code for a backup code; `null` for TOTP. */
      readonly remainingBackupCodes: string | null;
    };

const NOT_VERIFIED: ResetFactorResult = { verified: false };

/** Constant-time equality: both sides are hashed first so lengths always match. */
function constantTimeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

async function verifyBackupCode(input: ResetFactorInput): Promise<ResetFactorResult> {
  const json = await symmetricDecrypt({
    key: input.secretConfig,
    data: input.twoFactor.backupCodes,
  });
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed) || !parsed.every((code): code is string => typeof code === 'string')) {
    return NOT_VERIFIED;
  }
  const stored: string[] = parsed;

  // Compare every stored code, with no early exit.
  let matchIndex = -1;
  stored.forEach((code, index) => {
    if (constantTimeEqual(code, input.factor.code) && matchIndex === -1) {
      matchIndex = index;
    }
  });
  if (matchIndex === -1) {
    return NOT_VERIFIED;
  }

  const remaining = stored.filter((_, index) => index !== matchIndex);
  return {
    verified: true,
    remainingBackupCodes: await symmetricEncrypt({
      key: input.secretConfig,
      data: JSON.stringify(remaining),
    }),
  };
}

async function verifyTotp(input: ResetFactorInput): Promise<ResetFactorResult> {
  const secret = await symmetricDecrypt({ key: input.secretConfig, data: input.twoFactor.secret });
  const valid = await createOTP(secret, { period: 30, digits: 6 }).verify(input.factor.code);
  return valid ? { verified: true, remainingBackupCodes: null } : NOT_VERIFIED;
}

export async function verifyResetFactor(input: ResetFactorInput): Promise<ResetFactorResult> {
  return input.factor.kind === 'totp' ? verifyTotp(input) : verifyBackupCode(input);
}
