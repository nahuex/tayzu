/**
 * Invitation tokens (`043` design D4): single-use random tokens and their
 * stored digests. Pure, no I/O.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_BYTES = 32;

/** 256 bits from the CSPRNG, base64url (43 characters). */
export function generateInvitationToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** The sha256 digest (lowercase hex) that is stored instead of the token. */
export function digestInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time check of a presented token against a stored digest. A missing
 * (or malformed) record still performs one comparison, against a dummy digest,
 * and never verifies.
 */
export function verifyInvitationToken(token: string, storedDigest: string | null): boolean {
  const presented = Buffer.from(digestInvitationToken(token), 'hex');
  const stored = storedDigest === null ? null : Buffer.from(storedDigest, 'hex');
  if (stored?.byteLength !== TOKEN_BYTES) {
    timingSafeEqual(presented, presented);
    return false;
  }
  return timingSafeEqual(presented, stored);
}
