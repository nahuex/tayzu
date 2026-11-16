import { describe, expect, it } from 'vitest';

import { digestResetToken, generateResetToken } from './reset-token.js';
import { formatResetTokenValue, parseResetTokenValue } from './reset-token-value.js';

/**
 * `044` task 2.2 (design D3): the strict codec of the stored
 * `auth.verification.value`, `v1:<digest>:<userId>:<failures>`. Anything that is
 * not exactly that shape parses to `null` (a non-match).
 */
const digest = digestResetToken(generateResetToken().token);
const userId = 'usr_Ab3dEf9hIj';

describe('reset token value codec', () => {
  it('round trip', () => {
    for (const failures of [0, 1, 4, 5]) {
      const value = formatResetTokenValue({ digest, userId, failures });
      expect(value).toBe(`v1:${digest}:${userId}:${String(failures)}`);
      expect(parseResetTokenValue(value)).toEqual({ digest, userId, failures });
    }
  });

  it('unknown version is a non-match', () => {
    for (const version of ['v0', 'v2', 'V1', '', '1']) {
      expect(parseResetTokenValue(`${version}:${digest}:${userId}:0`)).toBeNull();
    }
    expect(parseResetTokenValue(`${digest}:${userId}:0`)).toBeNull();
  });

  it('malformed digest or counter is a non-match', () => {
    const malformedDigests = [
      '',
      'zz',
      'a'.repeat(63),
      'a'.repeat(65),
      'g'.repeat(64),
      digest.toUpperCase(),
    ];
    for (const bad of malformedDigests) {
      expect(parseResetTokenValue(`v1:${bad}:${userId}:0`)).toBeNull();
    }

    const malformedCounters = ['', '-1', '1.5', '1e1', 'abc', ' 1', '1 ', '+1', '0x1', 'NaN'];
    for (const bad of malformedCounters) {
      expect(parseResetTokenValue(`v1:${digest}:${userId}:${bad}`)).toBeNull();
    }

    expect(parseResetTokenValue(`v1:${digest}:${userId}`)).toBeNull();
    expect(parseResetTokenValue(`v1:${digest}::0`)).toBeNull();
    expect(parseResetTokenValue('')).toBeNull();
  });

  it('a user id containing a colon is a non-match', () => {
    expect(parseResetTokenValue(`v1:${digest}:user:one:0`)).toBeNull();
    expect(parseResetTokenValue(`v1:${digest}:user:3:0`)).toBeNull();
    expect(parseResetTokenValue(`v1:${digest}:${userId}:0:`)).toBeNull();
  });
});
