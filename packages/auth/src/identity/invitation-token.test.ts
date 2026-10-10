import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const compare = vi.hoisted(() => ({
  calls: [] as { a: Uint8Array; b: Uint8Array }[],
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    timingSafeEqual: (a: Uint8Array, b: Uint8Array): boolean => {
      compare.calls.push({ a, b });
      return actual.timingSafeEqual(a, b);
    },
  };
});

import {
  digestInvitationToken,
  generateInvitationToken,
  verifyInvitationToken,
} from './invitation-token.js';

/**
 * `043` task 7.1 (design D4, "Token"): 256-bit CSPRNG tokens, sha256 digest for
 * storage (lowercase hex), constant-time comparison over equal-length digests,
 * and a dummy comparison for a missing record.
 */
describe('invitation token: generation', () => {
  it('Token has 256 bits of entropy', () => {
    const token = generateInvitationToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(token).toHaveLength(43);
  });

  it('Tokens are unique', () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => generateInvitationToken()));
    expect(tokens.size).toBe(1000);
  });
});

describe('invitation token: storage digest', () => {
  it('Only the sha256 digest is derivable for storage', () => {
    const token = generateInvitationToken();
    const digest = digestInvitationToken(token);
    expect(digest).toBe(createHash('sha256').update(token).digest('hex'));
    expect(digest).toHaveLength(64);
    expect(digest).not.toContain(token);
    expect(digestInvitationToken(token)).toBe(digest);
    expect(digestInvitationToken(generateInvitationToken())).not.toBe(digest);
  });
});

describe('invitation token: verification', () => {
  beforeEach(() => {
    compare.calls.length = 0;
  });

  it('A matching token verifies', () => {
    const token = generateInvitationToken();
    expect(verifyInvitationToken(token, digestInvitationToken(token))).toBe(true);
  });

  it('A wrong token does not verify', () => {
    const stored = digestInvitationToken(generateInvitationToken());
    expect(verifyInvitationToken(generateInvitationToken(), stored)).toBe(false);
  });

  it('Comparison is constant-time over equal-length digests', () => {
    const token = generateInvitationToken();
    const stored = digestInvitationToken(token);
    verifyInvitationToken(generateInvitationToken(), stored);
    verifyInvitationToken(token, stored);
    expect(compare.calls).toHaveLength(2);
    for (const { a, b } of compare.calls) {
      expect(a.byteLength).toBe(32);
      expect(b.byteLength).toBe(32);
    }
  });

  it('A missing record still performs one comparison', () => {
    const result = verifyInvitationToken(generateInvitationToken(), null);
    expect(result).toBe(false);
    expect(compare.calls).toHaveLength(1);
    const call = compare.calls[0];
    expect(call?.a.byteLength).toBe(32);
    expect(call?.b.byteLength).toBe(32);
  });

  it('A missing record never verifies, whatever the token', () => {
    expect(verifyInvitationToken('', null)).toBe(false);
    expect(verifyInvitationToken(generateInvitationToken(), null)).toBe(false);
  });
});
