import type { BinaryLike, ScryptOptions } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Records every call into `node:crypto`'s scrypt (async and sync) and every
 * `randomBytes` draw, while delegating to the real implementation, so the test
 * can check the exact parameters (`N`, `r`, `p`, key length, `maxmem`) the
 * platform hash passes and that the salt is the random draw.
 */
const spy = vi.hoisted(() => ({
  scryptCalls: [] as {
    password: BinaryLike;
    salt: BinaryLike;
    keylen: number;
    options: ScryptOptions | undefined;
  }[],
  draws: [] as { size: number; bytes: Buffer }[],
  actual: undefined as typeof import('node:crypto') | undefined,
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  spy.actual = actual;
  const record = (args: unknown[]): void => {
    const [password, salt, keylen, maybeOptions] = args;
    spy.scryptCalls.push({
      password: password as BinaryLike,
      salt: salt as BinaryLike,
      keylen: keylen as number,
      options: typeof maybeOptions === 'function' ? undefined : (maybeOptions as ScryptOptions),
    });
  };
  const scrypt = (...args: unknown[]): void => {
    record(args);
    (actual.scrypt as (...a: unknown[]) => void)(...args);
  };
  const scryptSync = (...args: unknown[]): Buffer => {
    record(args);
    return (actual.scryptSync as (...a: unknown[]) => Buffer)(...args);
  };
  const randomBytes = (...args: unknown[]): unknown => {
    const result = (actual.randomBytes as (...a: unknown[]) => unknown)(...args);
    if (Buffer.isBuffer(result)) {
      spy.draws.push({ size: args[0] as number, bytes: result });
    }
    return result;
  };
  return {
    ...actual,
    default: { ...actual, scrypt, scryptSync, randomBytes },
    scrypt,
    scryptSync,
    randomBytes,
  };
});

import { hashPassword } from './password-hash.js';

/** design D5: `N = 2^15`, `r = 8`, `p = 3`, a 64-byte key, `maxmem` 64 MiB. */
const CURRENT_N = 2 ** 15;
const CURRENT_R = 8;
const CURRENT_P = 3;
const KEY_BYTES = 64;
const SALT_BYTES = 16;
const MAXMEM = 64 * 1024 * 1024;

/** design D5 "Format": standard base64 alphabet, no padding. */
const PLATFORM_FORMAT = /^\$scrypt\$ln=15,r=8,p=3\$([A-Za-z0-9+/]{22})\$([A-Za-z0-9+/]{86})$/;

function actualCrypto(): typeof import('node:crypto') {
  if (spy.actual === undefined) {
    throw new Error('node:crypto mock did not load');
  }
  return spy.actual;
}

function parse(hash: string): { salt: Buffer; key: Buffer; saltText: string; keyText: string } {
  const match = PLATFORM_FORMAT.exec(hash);
  if (match === null) {
    throw new Error('hash is not in the platform format');
  }
  const saltText = match[1] ?? '';
  const keyText = match[2] ?? '';
  return {
    salt: Buffer.from(saltText, 'base64'),
    key: Buffer.from(keyText, 'base64'),
    saltText,
    keyText,
  };
}

/** Recomputes the key of a platform hash with the real scrypt, from its own salt. */
function recompute(hash: string, password: string): Buffer {
  const { salt } = parse(hash);
  return actualCrypto().scryptSync(Buffer.from(password, 'utf8'), salt, KEY_BYTES, {
    N: CURRENT_N,
    r: CURRENT_R,
    p: CURRENT_P,
    maxmem: MAXMEM,
  });
}

/** Accepts both the short and the long option names Node's scrypt supports. */
function costOf(options: ScryptOptions | undefined): {
  N: number | undefined;
  r: number | undefined;
  p: number | undefined;
  maxmem: number | undefined;
} {
  return {
    N: options?.N ?? options?.cost,
    r: options?.r ?? options?.blockSize,
    p: options?.p ?? options?.parallelization,
    maxmem: options?.maxmem,
  };
}

function asBuffer(value: BinaryLike): Buffer {
  if (typeof value === 'string') {
    return Buffer.from(value, 'utf8');
  }
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error('unexpected scrypt input type');
}

/**
 * `048` task 5.1 (design D5, Q8): `hashPassword` writes the self-describing
 * scrypt format `$scrypt$ln=15,r=8,p=3$<salt>$<key>`; spec requirement
 * "Passwords are stored with the platform's password hash"
 * (password-reset-and-account-recovery).
 */
describe('platform password hash: hashPassword format', () => {
  beforeEach(() => {
    spy.scryptCalls.length = 0;
    spy.draws.length = 0;
  });

  it('writes $scrypt$ln=15,r=8,p=3$<salt>$<key> with a 16-byte salt and a 64-byte key in unpadded base64', async () => {
    const hash = await hashPassword('correct horse battery staple');

    expect(hash).toMatch(PLATFORM_FORMAT);
    expect(hash.split('$')).toHaveLength(5);
    const { salt, key, saltText, keyText } = parse(hash);
    expect(saltText).not.toContain('=');
    expect(keyText).not.toContain('=');
    expect(salt).toHaveLength(SALT_BYTES);
    expect(key).toHaveLength(KEY_BYTES);
    // Canonical unpadded base64: re-encoding the decoded bytes gives the same text.
    expect(salt.toString('base64').replace(/=+$/, '')).toBe(saltText);
    expect(key.toString('base64').replace(/=+$/, '')).toBe(keyText);
  });

  it('the key is scrypt of the password with the stored salt and the named parameters', async () => {
    const password = 'correct horse battery staple';
    const hash = await hashPassword(password);
    const { key } = parse(hash);

    expect(recompute(hash, password).equals(key)).toBe(true);
    expect(recompute(hash, `${password}!`).equals(key)).toBe(false);
  });

  it('the salt is a 16-byte randomBytes draw', async () => {
    const hash = await hashPassword('correct horse battery staple');
    const { salt } = parse(hash);

    const saltDraws = spy.draws.filter((draw) => draw.size === SALT_BYTES);
    expect(saltDraws.some((draw) => draw.bytes.equals(salt))).toBe(true);
  });

  it('two hashes of one password differ', async () => {
    const password = 'correct horse battery staple';
    const first = await hashPassword(password);
    const second = await hashPassword(password);

    expect(first).not.toBe(second);
    const a = parse(first);
    const b = parse(second);
    expect(a.salt.equals(b.salt)).toBe(false);
    expect(a.key.equals(b.key)).toBe(false);
    // Both still describe the same password.
    expect(recompute(first, password).equals(a.key)).toBe(true);
    expect(recompute(second, password).equals(b.key)).toBe(true);
  });
});

describe('platform password hash: NFC normalization only', () => {
  beforeEach(() => {
    spy.scryptCalls.length = 0;
    spy.draws.length = 0;
  });

  // "é" precomposed (U+00E9) and decomposed (U+0065 U+0301).
  const nfc = 'café-Passw0rd';
  const nfd = 'café-Passw0rd';

  it('an NFD input and its NFC form hash to values that verify each other', async () => {
    expect(nfd).not.toBe(nfc);
    expect(nfd.normalize('NFC')).toBe(nfc);

    const fromNfd = await hashPassword(nfd);
    const fromNfc = await hashPassword(nfc);

    // The hash of the NFD input verifies the NFC form, and the other way around.
    expect(recompute(fromNfd, nfc).equals(parse(fromNfd).key)).toBe(true);
    expect(recompute(fromNfc, nfc).equals(parse(fromNfc).key)).toBe(true);
    expect(recompute(fromNfc, nfd.normalize('NFC')).equals(parse(fromNfc).key)).toBe(true);
    // The raw NFD bytes are not what was hashed.
    expect(recompute(fromNfd, nfd).equals(parse(fromNfd).key)).toBe(false);
  });

  it('scrypt receives the NFC form of the password', async () => {
    await hashPassword(nfd);

    const hashingCalls = spy.scryptCalls.filter((call) => call.keylen === KEY_BYTES);
    expect(hashingCalls).toHaveLength(1);
    const input = asBuffer(hashingCalls[0]?.password ?? '');
    expect(input.equals(Buffer.from(nfc, 'utf8'))).toBe(true);
  });

  it('an NFKC-only equivalent does not match', async () => {
    // U+FB01 (LATIN SMALL LIGATURE FI) is unchanged by NFC; NFKC maps it to "fi".
    const ligature = 'proﬁle-Passw0rd';
    const folded = 'profile-Passw0rd';
    expect(ligature.normalize('NFC')).toBe(ligature);
    expect(ligature.normalize('NFKC')).toBe(folded);

    const fromLigature = await hashPassword(ligature);
    const fromFolded = await hashPassword(folded);

    expect(recompute(fromLigature, ligature).equals(parse(fromLigature).key)).toBe(true);
    expect(recompute(fromLigature, folded).equals(parse(fromLigature).key)).toBe(false);
    expect(recompute(fromFolded, ligature).equals(parse(fromFolded).key)).toBe(false);

    const hashingCalls = spy.scryptCalls.filter((call) => call.keylen === KEY_BYTES);
    expect(hashingCalls).toHaveLength(2);
    expect(asBuffer(hashingCalls[0]?.password ?? '').equals(Buffer.from(ligature, 'utf8'))).toBe(
      true,
    );
  });
});

describe('platform password hash: scrypt parameters', () => {
  beforeEach(() => {
    spy.scryptCalls.length = 0;
    spy.draws.length = 0;
  });

  it('calls node:crypto scrypt once with N=2^15, r=8, p=3, a 64-byte key and an explicit 64 MiB maxmem', async () => {
    const hash = await hashPassword('correct horse battery staple');
    const { salt } = parse(hash);

    expect(spy.scryptCalls).toHaveLength(1);
    const call = spy.scryptCalls[0];
    expect(call?.keylen).toBe(KEY_BYTES);
    expect(asBuffer(call?.salt ?? '').equals(salt)).toBe(true);
    expect(costOf(call?.options)).toEqual({
      N: CURRENT_N,
      r: CURRENT_R,
      p: CURRENT_P,
      maxmem: MAXMEM,
    });
    // Node's default maxmem (32 MiB) refuses 128 * N * r = 32 MiB; the explicit one must exceed it.
    expect(call?.options?.maxmem ?? 0).toBeGreaterThan(128 * CURRENT_N * CURRENT_R);
  });
});
