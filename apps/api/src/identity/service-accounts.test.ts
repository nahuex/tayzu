/**
 * `043` task 10.1 (design D6, ADR-0017): a service-account identifier follows
 * `^svc-[A-Za-z][A-Za-z0-9_-]{0,58}$`, validated at creation.
 *
 * ## Production symbols expected
 *
 * ```ts
 * // apps/api/src/identity/service-accounts.ts (exists as an empty scaffold)
 * // True when the identifier matches ^svc-[A-Za-z][A-Za-z0-9_-]{0,58}$.
 * // Pure; never throws, whatever the input string.
 * export function isValidServiceAccountIdentifier(identifier: string): boolean;
 * ```
 */
import { describe, expect, it } from 'vitest';

// The symbol under test. Not exported yet.
import { isValidServiceAccountIdentifier } from './service-accounts.js';

describe('the service-account identifier pattern (task 10.1)', () => {
  it('accepts `svc-ci-github`', () => {
    expect(isValidServiceAccountIdentifier('svc-ci-github')).toBe(true);
  });

  it('rejects `ci-github` (missing prefix)', () => {
    expect(isValidServiceAccountIdentifier('ci-github')).toBe(false);
  });

  it('rejects an over-length identifier and accepts the longest allowed one', () => {
    // `svc-` (4) + 1 letter + up to 58 more = 63 characters at most.
    const longest = `svc-a${'b'.repeat(58)}`;
    expect(longest).toHaveLength(63);
    expect(isValidServiceAccountIdentifier(longest)).toBe(true);
    expect(isValidServiceAccountIdentifier(`${longest}b`)).toBe(false);
    expect(isValidServiceAccountIdentifier(`svc-${'a'.repeat(200)}`)).toBe(false);
  });

  it('rejects an identifier whose first character after the prefix is not a letter', () => {
    expect(isValidServiceAccountIdentifier('svc-')).toBe(false);
    expect(isValidServiceAccountIdentifier('svc-1ci')).toBe(false);
    expect(isValidServiceAccountIdentifier('svc--ci')).toBe(false);
    expect(isValidServiceAccountIdentifier('svc-_ci')).toBe(false);
  });

  it('rejects characters outside letters, digits, `_` and `-`, including an email shape', () => {
    expect(isValidServiceAccountIdentifier('svc-ci@x.com')).toBe(false);
    expect(isValidServiceAccountIdentifier('svc-ci.github')).toBe(false);
    expect(isValidServiceAccountIdentifier('svc-ci github')).toBe(false);
    expect(isValidServiceAccountIdentifier('svc-ci/github')).toBe(false);
    expect(isValidServiceAccountIdentifier('alice@x.com')).toBe(false);
  });

  it('is anchored: no leading or trailing extra text, no trailing newline, case-sensitive prefix', () => {
    expect(isValidServiceAccountIdentifier(' svc-ci')).toBe(false);
    expect(isValidServiceAccountIdentifier('svc-ci ')).toBe(false);
    expect(isValidServiceAccountIdentifier('svc-ci\n')).toBe(false);
    expect(isValidServiceAccountIdentifier('x-svc-ci')).toBe(false);
    expect(isValidServiceAccountIdentifier('SVC-ci')).toBe(false);
    expect(isValidServiceAccountIdentifier('')).toBe(false);
  });

  it('accepts mixed case, digits, `_` and `-` after the first letter', () => {
    expect(isValidServiceAccountIdentifier('svc-Ci_Github-2')).toBe(true);
    expect(isValidServiceAccountIdentifier('svc-a')).toBe(true);
  });
});
