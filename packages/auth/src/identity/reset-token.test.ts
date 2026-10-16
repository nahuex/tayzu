import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const spy = vi.hoisted(() => ({
  compares: [] as { a: Uint8Array; b: Uint8Array }[],
  draws: [] as { size: number; bytes: Buffer }[],
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    timingSafeEqual: (a: Uint8Array, b: Uint8Array): boolean => {
      spy.compares.push({ a, b });
      return actual.timingSafeEqual(a, b);
    },
    randomBytes: (size: number): Buffer => {
      const bytes = actual.randomBytes(size);
      spy.draws.push({ size, bytes });
      return bytes;
    },
  };
});

import { digestResetToken, generateResetToken, verifyResetToken } from './reset-token.js';

/**
 * `044` task 2.1 (design D3): a 128-bit public id and a 256-bit secret token,
 * both base64url; the sha256 hex digest is what is stored; verification is
 * constant-time and a missing or malformed record still performs one comparison.
 */
describe('reset token: generation', () => {
  beforeEach(() => {
    spy.draws.length = 0;
  });

  it('id is 22 and token 43 base64url characters from distinct random draws', () => {
    spy.draws.length = 0;
    const { id, token } = generateResetToken();

    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(id, 'base64url')).toHaveLength(16);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);

    const sizes = spy.draws.map((draw) => draw.size).sort((x, y) => x - y);
    expect(sizes).toEqual([16, 32]);
    const idDraw = spy.draws.find((draw) => draw.size === 16);
    const tokenDraw = spy.draws.find((draw) => draw.size === 32);
    expect(idDraw?.bytes.toString('base64url')).toBe(id);
    expect(tokenDraw?.bytes.toString('base64url')).toBe(token);
    expect(id).not.toBe(token.slice(0, 22));
  });

  it('generated ids and tokens are unique', () => {
    const generated = Array.from({ length: 500 }, () => generateResetToken());
    expect(new Set(generated.map((entry) => entry.id)).size).toBe(500);
    expect(new Set(generated.map((entry) => entry.token)).size).toBe(500);
  });
});

describe('reset token: storage digest', () => {
  it('the digest is the lowercase hex sha256 of the token', () => {
    const { token } = generateResetToken();
    const digest = digestResetToken(token);
    expect(digest).toBe(createHash('sha256').update(token).digest('hex'));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain(token);
  });
});

describe('reset token: verification', () => {
  beforeEach(() => {
    spy.compares.length = 0;
  });

  it('verify accepts the right token and rejects a wrong one', () => {
    const { token } = generateResetToken();
    const stored = digestResetToken(token);
    expect(verifyResetToken(token, stored)).toBe(true);
    expect(verifyResetToken(generateResetToken().token, stored)).toBe(false);
    expect(spy.compares).toHaveLength(2);
    for (const { a, b } of spy.compares) {
      expect(a.byteLength).toBe(32);
      expect(b.byteLength).toBe(32);
    }
  });

  it('a missing digest still performs one `timingSafeEqual` and returns false', () => {
    const result = verifyResetToken(generateResetToken().token, null);
    expect(result).toBe(false);
    expect(spy.compares).toHaveLength(1);
    expect(spy.compares[0]?.a.byteLength).toBe(32);
    expect(spy.compares[0]?.b.byteLength).toBe(32);
  });

  it('a malformed digest still performs one `timingSafeEqual` and returns false', () => {
    for (const malformed of ['', 'zz', 'abcd', 'a'.repeat(63), 'a'.repeat(66)]) {
      spy.compares.length = 0;
      expect(verifyResetToken(generateResetToken().token, malformed)).toBe(false);
      expect(spy.compares).toHaveLength(1);
    }
  });
});
