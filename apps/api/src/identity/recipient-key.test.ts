/**
 * `043` task 6.7b (design D5, Resolved decision Q93): the per-recipient cap key
 * is an HMAC-SHA256 of the canonical email under the server secret
 * `IDENTITY_TOKEN_HMAC_SECRET`, never the address nor a bare digest of it.
 *
 * ## Production symbols expected
 *
 * ```ts
 * // apps/api/src/identity/recipient-key.ts (does not exist yet)
 * // `canonicalEmail` is already canonical (7.10); the function does not
 * // re-canonicalize. Returns a lowercase hex HMAC-SHA256 digest (64 chars).
 * export function recipientKey(canonicalEmail: string, secret: string): string;
 * ```
 */
import { createHash, createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

// The module under test. Does not exist yet.
import { recipientKey } from './recipient-key.js';

const SECRET = 'recipient-key-test-only-secret-0123456789-abcdef';
const OTHER_SECRET = 'recipient-key-other-test-secret-9876543210-fedcba';
const EMAIL = 'alice@example.com';

describe('the per-recipient cap key is an HMAC of the canonical email (task 6.7b, Q93)', () => {
  it('the same canonical email under the same secret gives the same key', () => {
    expect(recipientKey(EMAIL, SECRET)).toBe(recipientKey(EMAIL, SECRET));
  });

  it('a different email gives a different key', () => {
    expect(recipientKey('bob@example.com', SECRET)).not.toBe(recipientKey(EMAIL, SECRET));
  });

  it('a different secret gives a different key for the same email', () => {
    expect(recipientKey(EMAIL, OTHER_SECRET)).not.toBe(recipientKey(EMAIL, SECRET));
  });

  it('the key is the HMAC-SHA256 of the email under the secret, in hex', () => {
    const expected = createHmac('sha256', SECRET).update(EMAIL).digest('hex');

    expect(recipientKey(EMAIL, SECRET)).toBe(expected);
  });

  it('the key is not the sha256 of the email', () => {
    const bare = createHash('sha256').update(EMAIL).digest('hex');

    expect(recipientKey(EMAIL, SECRET)).not.toBe(bare);
    expect(recipientKey(EMAIL, SECRET)).not.toBe(
      createHash('sha256').update(EMAIL).digest('base64'),
    );
  });

  it('no address and no secret appears in the key', () => {
    const key = recipientKey(EMAIL, SECRET);

    expect(key).not.toContain(EMAIL);
    expect(key).not.toContain('alice');
    expect(key).not.toContain('example.com');
    expect(key).not.toContain(SECRET);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });
});
