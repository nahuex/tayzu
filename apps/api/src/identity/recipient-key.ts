import { createHmac } from 'node:crypto';

/**
 * Per-recipient cap key (design D5, Q93): the lowercase hex HMAC-SHA256 of the
 * already-canonical email under `IDENTITY_TOKEN_HMAC_SECRET`. A bare digest would
 * be a pseudonym anyone can recompute, and the key persists in `auth.rate_limit`.
 */
export function recipientKey(canonicalEmail: string, secret: string): string {
  return createHmac('sha256', secret).update(canonicalEmail).digest('hex');
}
