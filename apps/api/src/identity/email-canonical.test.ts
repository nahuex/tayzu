/**
 * `043` task 7.10 (design "Email form", Resolved decisions Q33 and Q60): one pure
 * canonical form of the address (NFC, trimmed, lower-cased) and a validator that
 * rejects an address the entity identifier pattern cannot hold or that contains `/`.
 *
 * ## Production symbols expected
 *
 * ```ts
 * // apps/api/src/identity/email-canonical.ts (does not exist yet)
 * // NFC-normalizes, trims and lower-cases. Pure; does not validate.
 * export function canonicalEmail(raw: string): string;
 * // True when the canonical form is held by ENTITY_IDENTIFIER_PATTERN (from
 * // `@tayzu/catalog`) and contains no `/`. Expects an already-canonical address.
 * export function isValidIdentityEmail(canonical: string): boolean;
 * ```
 */
import { ENTITY_IDENTIFIER_PATTERN } from '@tayzu/catalog';
import { describe, expect, it } from 'vitest';

// The module under test. Does not exist yet.
import { canonicalEmail, isValidIdentityEmail } from './email-canonical.js';

describe('the canonical email form (task 7.10, Q33)', () => {
  it('`Alice@Example.com ` canonicalizes trimmed and lower-cased', () => {
    expect(canonicalEmail('Alice@Example.com ')).toBe('alice@example.com');
    expect(canonicalEmail('  ALICE@EXAMPLE.COM\t')).toBe('alice@example.com');
  });

  it('`Alice@Example.com ` and its NFC variant canonicalize identically', () => {
    const composed = 'José@Example.com ';
    const decomposed = 'José@Example.com ';
    expect(composed).not.toBe(decomposed);
    expect(canonicalEmail(decomposed)).toBe(canonicalEmail(composed));
    expect(canonicalEmail(decomposed)).toBe('josé@example.com'.normalize('NFC'));
    expect(canonicalEmail(decomposed)).toBe(canonicalEmail(decomposed).normalize('NFC'));
    expect(canonicalEmail('Alice@Example.com ')).toBe(canonicalEmail('alice@example.com'));
  });

  it('is idempotent', () => {
    const once = canonicalEmail(' Bob@Allowed.Example ');
    expect(canonicalEmail(once)).toBe(once);
  });
});

describe('the email validator (task 7.10, Q33)', () => {
  it('a plain address is accepted', () => {
    expect(isValidIdentityEmail(canonicalEmail('Alice@Example.com '))).toBe(true);
    expect(isValidIdentityEmail('alice@example.com')).toBe(true);
    expect(ENTITY_IDENTIFIER_PATTERN.test('alice@example.com')).toBe(true);
  });

  it('`a+b@example.com` is rejected (the pattern cannot hold `+`)', () => {
    expect(isValidIdentityEmail('a+b@example.com')).toBe(false);
  });

  it('`a/b@example.com` is rejected (a `/` cannot be a path segment)', () => {
    // The pattern itself holds `/`, so only the explicit rule rejects it.
    expect(ENTITY_IDENTIFIER_PATTERN.test('a/b@example.com')).toBe(true);
    expect(isValidIdentityEmail('a/b@example.com')).toBe(false);
  });

  it('an address the pattern cannot hold otherwise is rejected', () => {
    expect(isValidIdentityEmail('a b@example.com')).toBe(false);
    expect(isValidIdentityEmail('jóse@example.com')).toBe(false);
    expect(isValidIdentityEmail(`${'a'.repeat(250)}@example.com`)).toBe(false);
    expect(isValidIdentityEmail('')).toBe(false);
  });
});
