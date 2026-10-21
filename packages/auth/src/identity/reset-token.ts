/**
 * Password reset tokens (`044` design D3): a public 128-bit id, a secret
 * 256-bit token and the stored digest. Pure, no I/O.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const ID_BYTES = 16;
const TOKEN_BYTES = 32;

/** A fresh id (22 base64url characters) and token (43), from separate CSPRNG draws. */
export function generateResetToken(): { id: string; token: string } {
  return {
    id: randomBytes(ID_BYTES).toString('base64url'),
    token: randomBytes(TOKEN_BYTES).toString('base64url'),
  };
}

/** The sha256 digest (lowercase hex) that is stored instead of the token. */
export function digestResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time check of a presented token against a stored digest. A missing
 * (or malformed) record still performs one comparison, against a dummy digest,
 * and never verifies.
 */
export function verifyResetToken(token: string, storedDigest: string | null): boolean {
  const presented = Buffer.from(digestResetToken(token), 'hex');
  const stored = storedDigest === null ? null : Buffer.from(storedDigest, 'hex');
  if (stored?.byteLength !== TOKEN_BYTES) {
    timingSafeEqual(presented, presented);
    return false;
  }
  return timingSafeEqual(presented, stored);
}
