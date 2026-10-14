import { describe, expect, it } from 'vitest';

import { COMMON_PASSWORD_DENYLIST } from './common-passwords.js';
import { validatePassword } from './password-policy.js';

/**
 * `043` task 8.1 (design Q22, Q132; spec "Password policy"): the pure password
 * policy. `validatePassword` returns `{ ok: true, password }` with the NFC form,
 * or `{ ok: false, rule }` naming only the failed rule, never the password.
 * Rules: `length`, `uppercase`, `lowercase`, `digit`, `symbol`, `character`,
 * `denylist`.
 */

const COMPLIANT = 'Quartz7!Lantern-Moss';
const FILL = '\u{1F600}'; // an astral symbol: 1 code point, 2 UTF-16 units

/** A compliant password of exactly `n` code points, the tail made of astral symbols. */
function astralPassword(n: number): string {
  return 'Aa1!' + FILL.repeat(n - 4);
}

function codePoints(value: string): number {
  return Array.from(value).length;
}

function expectRefused(password: string, rule: string): void {
  const result = validatePassword(password);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.rule).toBe(rule);
  }
}

/** The refusal must never carry the password or the offending character. */
function expectNoEcho(password: string): void {
  const serialized = JSON.stringify(validatePassword(password));
  expect(serialized).not.toContain(password);
  expect(serialized).not.toContain(JSON.stringify(password).slice(1, -1));
  expect(serialized.toLowerCase()).not.toContain(password.toLowerCase());
}

describe('validatePassword: length', () => {
  it('a compliant 20-character password is accepted', () => {
    expect(codePoints(COMPLIANT)).toBe(20);
    const result = validatePassword(COMPLIANT);
    expect(result).toEqual({ ok: true, password: COMPLIANT });
  });

  it('a 19-character password that meets every other rule is refused naming the length rule', () => {
    const password = COMPLIANT.slice(0, 19);
    expect(codePoints(password)).toBe(19);
    expectRefused(password, 'length');
  });

  it('a 128-character password is accepted and a 129-character one is refused', () => {
    const ok = 'Aa1!' + 'k'.repeat(124);
    const tooLong = 'Aa1!' + 'k'.repeat(125);
    expect(codePoints(ok)).toBe(128);
    expect(validatePassword(ok).ok).toBe(true);
    expect(codePoints(tooLong)).toBe(129);
    expectRefused(tooLong, 'length');
  });

  it('astral characters are counted by code point, not by UTF-16 unit', () => {
    // 20 code points are 36 UTF-16 units; 19 code points are 35 units.
    expect(validatePassword(astralPassword(20)).ok).toBe(true);
    expectRefused(astralPassword(19), 'length');
    // 128 code points are 252 UTF-16 units: accepted; 129 are refused.
    expect(validatePassword(astralPassword(128)).ok).toBe(true);
    expectRefused(astralPassword(129), 'length');
  });

  it('the length is counted after NFC normalization', () => {
    // 19 code points in NFC, 20 in NFD: refused.
    const nfc19 = 'Quartz7!Lantern-Moé';
    expect(codePoints(nfc19)).toBe(19);
    expect(codePoints(nfc19.normalize('NFD'))).toBe(20);
    expectRefused(nfc19.normalize('NFD'), 'length');

    // 20 code points in NFC, 21 in NFD: accepted, returned in NFC.
    const nfc20 = 'Quartz7!Lantern-Mosé';
    expect(codePoints(nfc20)).toBe(20);
    expect(validatePassword(nfc20.normalize('NFD'))).toEqual({ ok: true, password: nfc20 });
  });

  it('a password presented in NFD is returned in its NFC form', () => {
    const nfd = 'Quartz7!Lantern-Mossé'.normalize('NFD');
    const result = validatePassword(nfd);
    expect(result).toEqual({ ok: true, password: 'Quartz7!Lantern-Mossé' });
  });
});

describe('validatePassword: character classes', () => {
  it('a password with no upper-case letter is refused naming the uppercase rule', () => {
    expectRefused('quartz7!lantern-moss', 'uppercase');
  });

  it('a password with no lower-case letter is refused naming the lowercase rule', () => {
    expectRefused('QUARTZ7!LANTERN-MOSS', 'lowercase');
  });

  it('a password with no digit is refused naming the digit rule', () => {
    expectRefused('Quartz!Lantern-Moss!', 'digit');
  });

  it('a password with no symbol is refused naming the symbol rule', () => {
    expectRefused('Quartz7Lantern0Moss1', 'symbol');
  });
});

describe('validatePassword: harmful characters', () => {
  const cases: [string, string][] = [
    ['a NUL', '\u0000'],
    ['a control character (U+0001)', '\u0001'],
    ['a tab', '\t'],
    ['DEL (U+007F)', '\u007f'],
    ['a C1 control character (U+0085)', '\u0085'],
    ['a bidirectional override (U+202E)', '‮'],
    ['a bidirectional isolate (U+2066)', '⁦'],
    ['a zero-width space (U+200B)', '​'],
    ['a zero-width joiner (U+200D)', '‍'],
    ['a byte order mark (U+FEFF)', '﻿'],
    ['an unpaired high surrogate', '\ud800'],
    ['an unpaired low surrogate', '\udc00'],
  ];

  it.each(cases)('%s is refused naming the character rule', (_name, harmful) => {
    const password = `${COMPLIANT}${harmful}x`;
    expect(codePoints(password)).toBeGreaterThanOrEqual(20);
    expectRefused(password, 'character');
  });

  it.each(cases)('the refusal for %s does not echo the password', (_name, harmful) => {
    expectNoEcho(`${COMPLIANT}${harmful}x`);
  });

  it('a properly paired surrogate (an astral character) is not refused as unpaired', () => {
    expect(validatePassword(`${COMPLIANT}${FILL}`).ok).toBe(true);
  });
});

describe('validatePassword: common-password denylist', () => {
  // An entry that, once its first letter is upper-cased, meets every other rule.
  const entry = COMMON_PASSWORD_DENYLIST.find(
    (candidate) => /[a-z]/.test(candidate) && /\d/.test(candidate) && /[^a-z\d]/.test(candidate),
  );

  it('the bundled denylist has an entry that can meet every other rule', () => {
    expect(entry).toBeDefined();
  });

  it('a denylisted password is refused naming the denylist rule', () => {
    if (entry === undefined) throw new Error('no usable denylist entry');
    const password = entry.replace(/[a-z]/, (letter) => letter.toUpperCase());
    expect(password).not.toBe(entry);
    expectRefused(password, 'denylist');
  });

  it('the denylist match ignores case and normalization form', () => {
    if (entry === undefined) throw new Error('no usable denylist entry');
    const mixed = entry.replace(/[a-z]/g, (letter, index: number) =>
      index % 2 === 0 ? letter.toUpperCase() : letter,
    );
    expectRefused(mixed.normalize('NFD'), 'denylist');
  });

  it('the denylist refusal does not echo the password', () => {
    if (entry === undefined) throw new Error('no usable denylist entry');
    expectNoEcho(entry.replace(/[a-z]/, (letter) => letter.toUpperCase()));
  });
});

describe('validatePassword: refusals never echo the password', () => {
  it.each([
    ['too short', COMPLIANT.slice(0, 19)],
    ['no upper-case letter', 'quartz7!lantern-moss'],
    ['no symbol', 'Quartz7Lantern0Moss1'],
  ])('a password %s is refused without echoing it', (_name, password) => {
    expectNoEcho(password);
  });
});
