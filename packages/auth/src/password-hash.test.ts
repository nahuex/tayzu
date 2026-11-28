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
    /** Set once the derivation has finished (the callback ran, or the sync call returned). */
    completed: boolean;
  }[],
  draws: [] as { size: number; bytes: Buffer }[],
  timingSafeEqualCalls: [] as { a: Buffer; b: Buffer; result: boolean }[],
  actual: undefined as typeof import('node:crypto') | undefined,
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  spy.actual = actual;
  const record = (args: unknown[]): { completed: boolean } => {
    const [password, salt, keylen, maybeOptions] = args;
    const entry = {
      password: password as BinaryLike,
      salt: salt as BinaryLike,
      keylen: keylen as number,
      options: typeof maybeOptions === 'function' ? undefined : (maybeOptions as ScryptOptions),
      completed: false,
    };
    spy.scryptCalls.push(entry);
    return entry;
  };
  const scrypt = (...args: unknown[]): void => {
    const entry = record(args);
    const last = args.length - 1;
    const callback = args[last];
    if (typeof callback === 'function') {
      args[last] = (...result: unknown[]): void => {
        entry.completed = true;
        (callback as (...r: unknown[]) => void)(...result);
      };
    }
    (actual.scrypt as (...a: unknown[]) => void)(...args);
  };
  const scryptSync = (...args: unknown[]): Buffer => {
    const entry = record(args);
    const result = (actual.scryptSync as (...a: unknown[]) => Buffer)(...args);
    entry.completed = true;
    return result;
  };
  const randomBytes = (...args: unknown[]): unknown => {
    const result = (actual.randomBytes as (...a: unknown[]) => unknown)(...args);
    if (Buffer.isBuffer(result)) {
      spy.draws.push({ size: args[0] as number, bytes: result });
    }
    return result;
  };
  const timingSafeEqual = (...args: unknown[]): boolean => {
    const result = (actual.timingSafeEqual as (...a: unknown[]) => boolean)(...args);
    const [a, b] = args as [NodeJS.ArrayBufferView, NodeJS.ArrayBufferView];
    spy.timingSafeEqualCalls.push({
      a: Buffer.from(a.buffer, a.byteOffset, a.byteLength),
      b: Buffer.from(b.buffer, b.byteOffset, b.byteLength),
      result,
    });
    return result;
  };
  return {
    ...actual,
    default: { ...actual, scrypt, scryptSync, randomBytes, timingSafeEqual },
    scrypt,
    scryptSync,
    randomBytes,
    timingSafeEqual,
  };
});

/**
 * Delegates to Better Auth's real password functions, recording every legacy
 * verification, so the test can check that a `salt:key` hash is verified
 * through `better-auth/crypto`'s `verifyPassword` (design D5 "Verification").
 */
const legacySpy = vi.hoisted(() => ({
  verifyCalls: [] as { hash: string; password: string }[],
}));

vi.mock('better-auth/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('better-auth/crypto')>();
  return {
    ...actual,
    verifyPassword: async (input: { hash: string; password: string }): Promise<boolean> => {
      legacySpy.verifyCalls.push({ hash: input.hash, password: input.password });
      return actual.verifyPassword(input);
    },
  };
});

import { hashPassword as legacyHashPassword } from 'better-auth/crypto';

import { hashPassword, needsRehash, verifyPassword } from './password-hash.js';

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

// ---------------------------------------------------------------------------
// `048` task 5.2 (design D5, Q8): `verifyPassword({ hash, password })` and
// `needsRehash(hash)` accept the platform and the legacy formats; spec
// requirement "Passwords are stored with the platform's password hash" and
// scenario "A malformed stored hash fails closed"
// (password-reset-and-account-recovery).
// ---------------------------------------------------------------------------

const PASSWORD = 'correct horse battery staple';
const WRONG_PASSWORD = 'correct horse battery stapler';

/** Room for every fixture below; the fixtures use the real scrypt, never the module under test. */
const FIXTURE_MAXMEM = 512 * 1024 * 1024;

/** design D5 "Format": standard base64 without padding. */
function unpadded(bytes: Buffer): string {
  return bytes.toString('base64').replace(/=+$/, '');
}

/**
 * Builds a platform-shaped hash with the real scrypt, so a lenient parser that
 * accepted the shape would verify it: a strict one must refuse it instead.
 */
function platformHash(
  params: { ln: number; r: number; p: number },
  password: string,
  options: { salt?: Buffer; keyBytes?: number; paramText?: string } = {},
): { hash: string; salt: Buffer; key: Buffer } {
  const salt = options.salt ?? actualCrypto().randomBytes(SALT_BYTES);
  const key = actualCrypto().scryptSync(
    Buffer.from(password.normalize('NFC'), 'utf8'),
    salt,
    options.keyBytes ?? KEY_BYTES,
    { N: 2 ** params.ln, r: params.r, p: params.p, maxmem: FIXTURE_MAXMEM },
  );
  const paramText =
    options.paramText ?? `ln=${String(params.ln)},r=${String(params.r)},p=${String(params.p)}`;
  return { hash: `$scrypt$${paramText}$${unpadded(salt)}$${unpadded(key)}`, salt, key };
}

/** The legacy Better Auth key derivation (`@better-auth/utils@0.4.2`), with a chosen salt text. */
function legacyShapedHash(saltHex: string, password: string): string {
  const key = actualCrypto().scryptSync(password.normalize('NFKC'), saltHex, 64, {
    N: 16384,
    r: 16,
    p: 1,
    maxmem: FIXTURE_MAXMEM,
  });
  return `${saltHex}:${key.toString('hex')}`;
}

/** design D5 names `needsRehash(hash)`; the test does not depend on it being sync or async. */
async function rehashNeeded(hash: string): Promise<boolean> {
  return Promise.resolve(needsRehash(hash));
}

function resetSpies(): void {
  spy.scryptCalls.length = 0;
  spy.draws.length = 0;
  spy.timingSafeEqualCalls.length = 0;
  legacySpy.verifyCalls.length = 0;
}

describe('platform password hash: verifyPassword with the platform format', () => {
  beforeEach(resetSpies);

  it('a hash written by hashPassword verifies with the right password', async () => {
    const hash = await hashPassword(PASSWORD);

    await expect(verifyPassword({ hash, password: PASSWORD })).resolves.toBe(true);
  });

  it('a wrong password fails against a platform hash', async () => {
    const hash = await hashPassword(PASSWORD);

    await expect(verifyPassword({ hash, password: WRONG_PASSWORD })).resolves.toBe(false);
  });

  it('the password is NFC-normalized before verifying', async () => {
    // "é" precomposed (U+00E9) and decomposed (U+0065 U+0301).
    const nfc = 'café-Passw0rd';
    const nfd = 'café-Passw0rd';
    const hash = await hashPassword(nfc);

    await expect(verifyPassword({ hash, password: nfd })).resolves.toBe(true);
  });

  it('a platform hash is recomputed with its own parameters (ln=14)', async () => {
    const { hash } = platformHash({ ln: 14, r: 8, p: 3 }, PASSWORD);

    await expect(verifyPassword({ hash, password: PASSWORD })).resolves.toBe(true);
    expect(
      spy.scryptCalls.some((call) => {
        const cost = costOf(call.options);
        return call.keylen === KEY_BYTES && cost.N === 2 ** 14 && cost.r === 8 && cost.p === 3;
      }),
    ).toBe(true);
  });

  it('a wrong password fails against a lower-cost platform hash', async () => {
    const { hash } = platformHash({ ln: 14, r: 8, p: 3 }, PASSWORD);

    await expect(verifyPassword({ hash, password: WRONG_PASSWORD })).resolves.toBe(false);
  });

  it('the comparison goes through timingSafeEqual on equal-length 64-byte buffers', async () => {
    const hash = await hashPassword(PASSWORD);
    const { key } = parse(hash);
    spy.timingSafeEqualCalls.length = 0;

    await expect(verifyPassword({ hash, password: PASSWORD })).resolves.toBe(true);

    expect(spy.timingSafeEqualCalls.length).toBeGreaterThanOrEqual(1);
    const comparison = spy.timingSafeEqualCalls.find(
      (call) => call.a.equals(key) || call.b.equals(key),
    );
    expect(comparison).toBeDefined();
    expect(comparison?.a).toHaveLength(KEY_BYTES);
    expect(comparison?.b).toHaveLength(KEY_BYTES);
    expect(comparison?.result).toBe(true);
  });

  it('a wrong password is also decided by timingSafeEqual', async () => {
    const hash = await hashPassword(PASSWORD);
    const { key } = parse(hash);
    spy.timingSafeEqualCalls.length = 0;

    await expect(verifyPassword({ hash, password: WRONG_PASSWORD })).resolves.toBe(false);

    const comparison = spy.timingSafeEqualCalls.find(
      (call) => call.a.equals(key) || call.b.equals(key),
    );
    expect(comparison).toBeDefined();
    expect(comparison?.a).toHaveLength(KEY_BYTES);
    expect(comparison?.b).toHaveLength(KEY_BYTES);
    expect(comparison?.result).toBe(false);
  });
});

describe('platform password hash: verifyPassword with the legacy Better Auth format', () => {
  beforeEach(resetSpies);

  it('a legacy salt:key hash from better-auth/crypto verifies with the right password', async () => {
    const legacy = await legacyHashPassword(PASSWORD);
    expect(legacy).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    legacySpy.verifyCalls.length = 0;

    await expect(verifyPassword({ hash: legacy, password: PASSWORD })).resolves.toBe(true);
    // Verified through Better Auth's own function (design D5 "Verification").
    expect(legacySpy.verifyCalls).toEqual([{ hash: legacy, password: PASSWORD }]);
  });

  it('a wrong password fails against a legacy hash', async () => {
    const legacy = await legacyHashPassword(PASSWORD);

    await expect(verifyPassword({ hash: legacy, password: WRONG_PASSWORD })).resolves.toBe(false);
  });

  it('the legacy path receives the NFC-normalized password', async () => {
    const nfc = 'café-Passw0rd';
    const nfd = 'café-Passw0rd';
    const legacy = await legacyHashPassword(nfc);
    legacySpy.verifyCalls.length = 0;

    await expect(verifyPassword({ hash: legacy, password: nfd })).resolves.toBe(true);
    expect(legacySpy.verifyCalls).toEqual([{ hash: legacy, password: nfc }]);
  });
});

describe('A malformed stored hash fails closed', () => {
  beforeEach(resetSpies);

  /**
   * The base fixture: a current-cost platform hash of PASSWORD whose key and
   * salt differ between base64 and base64url, so an alphabet mix-up shows.
   */
  function baseFixture(): { hash: string; salt: Buffer; key: Buffer } {
    for (let seed = 0; seed < 64; seed += 1) {
      const salt = Buffer.alloc(SALT_BYTES, seed);
      const fixture = platformHash({ ln: 15, r: 8, p: 3 }, PASSWORD, { salt });
      const keyText = unpadded(fixture.key);
      if (keyText !== fixture.key.toString('base64url')) {
        return fixture;
      }
    }
    throw new Error('no base64url-distinct fixture found');
  }

  const fixtures = (() => {
    let cache:
      | {
          base: string;
          saltText: string;
          keyText: string;
          cases: { name: string; hash: string }[];
        }
      | undefined;
    return () => {
      if (cache !== undefined) {
        return cache;
      }
      const base = baseFixture();
      const saltText = unpadded(base.salt);
      const keyText = unpadded(base.key);
      const params = 'ln=15,r=8,p=3';
      const withParams = (text: string): string => `$scrypt$${text}$${saltText}$${keyText}`;
      const cases: { name: string; hash: string }[] = [
        // Unknown algorithm.
        { name: 'algorithm argon2id', hash: base.hash.replace('$scrypt$', '$argon2id$') },
        { name: 'algorithm SCRYPT (case)', hash: base.hash.replace('$scrypt$', '$SCRYPT$') },
        { name: 'algorithm scrypt2', hash: base.hash.replace('$scrypt$', '$scrypt2$') },
        { name: 'empty algorithm', hash: base.hash.replace('$scrypt$', '$$') },
        { name: 'non-empty first field', hash: `x${base.hash}` },
        { name: 'missing leading $', hash: base.hash.slice(1) },
        // Parameters out of range (keys computed with those parameters where scrypt allows).
        { name: 'ln=13 (below 14)', hash: platformHash({ ln: 13, r: 8, p: 3 }, PASSWORD).hash },
        { name: 'ln=21 (above 20)', hash: withParams('ln=21,r=8,p=3') },
        { name: 'r=0', hash: withParams('ln=15,r=0,p=3') },
        { name: 'r=17 (above 16)', hash: platformHash({ ln: 14, r: 17, p: 1 }, PASSWORD).hash },
        { name: 'p=0', hash: withParams('ln=15,r=8,p=0') },
        { name: 'p=17 (above 16)', hash: platformHash({ ln: 14, r: 1, p: 17 }, PASSWORD).hash },
        // Parameters out of order (the key matches the named parameters).
        { name: 'order r,ln,p', hash: withParams('r=8,ln=15,p=3') },
        { name: 'order ln,p,r', hash: withParams('ln=15,p=3,r=8') },
        { name: 'order p,r,ln', hash: withParams('p=3,r=8,ln=15') },
        // Malformed parameters.
        { name: 'missing p', hash: withParams('ln=15,r=8') },
        { name: 'extra parameter', hash: withParams(`${params},x=1`) },
        { name: 'repeated parameter', hash: withParams(`${params},p=3`) },
        { name: 'hexadecimal ln', hash: withParams('ln=0xf,r=8,p=3') },
        { name: 'fractional ln', hash: withParams('ln=15.0,r=8,p=3') },
        { name: 'signed ln', hash: withParams('ln=+15,r=8,p=3') },
        { name: 'space in parameters', hash: withParams('ln=15, r=8,p=3') },
        { name: 'empty parameters', hash: withParams('') },
        { name: 'long parameter names', hash: withParams('N=32768,r=8,p=3') },
        // Short or long key (each computed at that length, so a length-following parser would verify).
        {
          name: '63-byte key',
          hash: platformHash({ ln: 15, r: 8, p: 3 }, PASSWORD, { salt: base.salt, keyBytes: 63 })
            .hash,
        },
        {
          name: '32-byte key',
          hash: platformHash({ ln: 15, r: 8, p: 3 }, PASSWORD, { salt: base.salt, keyBytes: 32 })
            .hash,
        },
        {
          name: '65-byte key',
          hash: platformHash({ ln: 15, r: 8, p: 3 }, PASSWORD, { salt: base.salt, keyBytes: 65 })
            .hash,
        },
        { name: 'truncated key text', hash: base.hash.slice(0, -1) },
        { name: 'empty key', hash: `$scrypt$${params}$${saltText}$` },
        // Salt outside 16 to 64 bytes.
        {
          name: '15-byte salt',
          hash: platformHash({ ln: 15, r: 8, p: 3 }, PASSWORD, {
            salt: actualCrypto().randomBytes(15),
          }).hash,
        },
        {
          name: '65-byte salt',
          hash: platformHash({ ln: 15, r: 8, p: 3 }, PASSWORD, {
            salt: actualCrypto().randomBytes(65),
          }).hash,
        },
        { name: 'empty salt', hash: `$scrypt$${params}$$${keyText}` },
        // Extra or missing fields.
        { name: 'extra trailing field', hash: `${base.hash}$extra` },
        { name: 'trailing $', hash: `${base.hash}$` },
        { name: 'missing salt field', hash: `$scrypt$${params}$${keyText}` },
        // Padding and alphabet.
        {
          name: 'padded salt',
          hash: `$scrypt$${params}$${base.salt.toString('base64')}$${keyText}`,
        },
        {
          name: 'padded key',
          hash: `$scrypt$${params}$${saltText}$${base.key.toString('base64')}`,
        },
        {
          name: 'base64url key',
          hash: `$scrypt$${params}$${saltText}$${base.key.toString('base64url')}`,
        },
        // Surrounding whitespace.
        { name: 'trailing newline', hash: `${base.hash}\n` },
        { name: 'leading space', hash: ` ${base.hash}` },
      ];
      cache = { base: base.hash, saltText, keyText, cases };
      return cache;
    };
  })();

  it('control: the unmodified base fixture verifies', async () => {
    const { base } = fixtures();

    await expect(verifyPassword({ hash: base, password: PASSWORD })).resolves.toBe(true);
  });

  it('every malformed platform-shaped hash fails verification without throwing', async () => {
    const { cases } = fixtures();
    const outcomes: { name: string; outcome: unknown }[] = [];

    for (const { name, hash } of cases) {
      let outcome: unknown;
      try {
        outcome = await verifyPassword({ hash, password: PASSWORD });
      } catch (error) {
        outcome = { threw: error instanceof Error ? error.message : String(error) };
      }
      outcomes.push({ name, outcome });
    }

    expect(outcomes).toEqual(cases.map(({ name }) => ({ name, outcome: false })));
  }, 60_000);

  it('a malformed legacy-shaped value fails verification without throwing', async () => {
    const legacy = await legacyHashPassword(PASSWORD);
    const cases: { name: string; hash: string }[] = [
      // Better Auth's own split would ignore the third field and verify.
      { name: 'extra field', hash: `${legacy}:00` },
      // Better Auth would verify a shorter salt; the legacy shape is exactly 32:128 hex.
      { name: '8-byte salt', hash: legacyShapedHash('0123456789abcdef', PASSWORD) },
      { name: 'uppercase hex', hash: legacy.toUpperCase() },
      { name: 'truncated key', hash: legacy.slice(0, -2) },
      { name: 'trailing newline', hash: `${legacy}\n` },
      // Better Auth's verifyPassword throws on these.
      { name: 'colon only', hash: ':' },
      { name: 'no colon', hash: 'abc' },
      { name: 'empty string', hash: '' },
    ];
    const outcomes: { name: string; outcome: unknown }[] = [];

    for (const { name, hash } of cases) {
      let outcome: unknown;
      try {
        outcome = await verifyPassword({ hash, password: PASSWORD });
      } catch (error) {
        outcome = { threw: error instanceof Error ? error.message : String(error) };
      }
      outcomes.push({ name, outcome });
    }

    expect(outcomes).toEqual(cases.map(({ name }) => ({ name, outcome: false })));
  }, 60_000);
});

describe('platform password hash: needsRehash', () => {
  beforeEach(resetSpies);

  it('is false for a hash at the current cost', async () => {
    const hash = await hashPassword(PASSWORD);

    await expect(rehashNeeded(hash)).resolves.toBe(false);
  });

  it('is true for a legacy salt:key hash', async () => {
    const legacy = await legacyHashPassword(PASSWORD);

    await expect(rehashNeeded(legacy)).resolves.toBe(true);
  });

  it('is true for a lower-cost platform hash (ln=14)', async () => {
    const { hash } = platformHash({ ln: 14, r: 8, p: 3 }, PASSWORD);

    await expect(rehashNeeded(hash)).resolves.toBe(true);
  });

  it('is true for a platform hash with a lower parallelization (p=1)', async () => {
    const { hash } = platformHash({ ln: 15, r: 8, p: 1 }, PASSWORD);

    await expect(rehashNeeded(hash)).resolves.toBe(true);
  });

  it('is false for a platform hash above the current cost (ln=16)', async () => {
    const { hash } = platformHash({ ln: 16, r: 8, p: 3 }, PASSWORD);

    await expect(rehashNeeded(hash)).resolves.toBe(false);
  });

  it('is false for a value in neither format', async () => {
    const current = await hashPassword(PASSWORD);

    await expect(rehashNeeded(current.replace('$scrypt$', '$argon2id$'))).resolves.toBe(false);
    await expect(rehashNeeded('not a hash')).resolves.toBe(false);
    await expect(rehashNeeded('')).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// `048` task 5.4a (design D5 "Equal failure cost", Q33): spec scenario "A
// failed sign-in against a weaker hash costs the same as an unknown user"
// (password-reset-and-account-recovery), at the function level.
//
// GIVEN a stored hash in the earlier (legacy) format, or in the platform's
// format with a lower cost than the current one, WHEN the check fails, THEN
// the verification also computes one hash at the current cost (D5: "one
// current-cost `hashPassword(password)`", discarded) and still answers
// `false`. A successful check, a failed current-cost check and a malformed
// stored value run no extra hash.
//
// ## Why the extra hash is counted on node:crypto, not by spying `hashPassword`
//
// `verifyPassword` reaches `hashPassword` through a call inside the same
// module, which a spy on the module's export never sees (an ES module's
// internal bindings are not the namespace object's). The observable,
// implementation-independent trace of "one current-cost hash" is one
// `node:crypto` scrypt derivation with the current parameters (N=2^15, r=8,
// p=3, a 64-byte key), which is what `hashPassword` itself is pinned to by
// task 5.1's block above. Legacy verification derives with N=2^14, r=16, p=1
// and a lower-cost platform hash with its own parameters, so neither is
// mistaken for the current-cost one. The derivation must also have finished
// before `verifyPassword` resolves: a fire-and-forget hash would not make the
// failure cost the same.
// ---------------------------------------------------------------------------

describe('A failed sign-in against a weaker hash costs the same as an unknown user', () => {
  beforeEach(resetSpies);

  /** The scrypt derivations at exactly the current cost (design D5). */
  function currentCostCalls(): (typeof spy.scryptCalls)[number][] {
    return spy.scryptCalls.filter((call) => {
      const cost = costOf(call.options);
      return (
        call.keylen === KEY_BYTES &&
        cost.N === CURRENT_N &&
        cost.r === CURRENT_R &&
        cost.p === CURRENT_P
      );
    });
  }

  it('a failed legacy check runs exactly one current-cost hash and answers false', async () => {
    const legacy = await legacyHashPassword(PASSWORD);
    resetSpies();

    await expect(verifyPassword({ hash: legacy, password: WRONG_PASSWORD })).resolves.toBe(false);

    // Control: the legacy hash was still checked through Better Auth's function.
    expect(legacySpy.verifyCalls).toEqual([{ hash: legacy, password: WRONG_PASSWORD }]);
    const extra = currentCostCalls();
    expect(extra, 'exactly one current-cost hash after a failed legacy check').toHaveLength(1);
    expect(extra[0]?.completed, 'the extra hash finished before the answer').toBe(true);
    expect(
      asBuffer(extra[0]?.password ?? '').equals(Buffer.from(WRONG_PASSWORD, 'utf8')),
      'the extra hash is hashPassword(password) of the submitted password',
    ).toBe(true);
  });

  it('a failed legacy check of an NFD password hashes its NFC form once at the current cost', async () => {
    // "é" precomposed (U+00E9) and decomposed (U+0065 U+0301).
    const nfc = 'caf\u00e9-Passw0rd';
    const nfd = 'cafe\u0301-Passw0rd';
    expect(nfd).not.toBe(nfc);
    expect(nfd.normalize('NFC')).toBe(nfc);
    const legacy = await legacyHashPassword(PASSWORD);
    resetSpies();

    await expect(verifyPassword({ hash: legacy, password: nfd })).resolves.toBe(false);

    const extra = currentCostCalls();
    expect(extra).toHaveLength(1);
    expect(asBuffer(extra[0]?.password ?? '').equals(Buffer.from(nfc, 'utf8'))).toBe(true);
  });

  for (const params of [
    { ln: 14, r: 8, p: 3 },
    { ln: 15, r: 8, p: 1 },
  ] as const) {
    const label = `ln=${String(params.ln)},r=${String(params.r)},p=${String(params.p)}`;

    it(`a failed lower-cost platform check (${label}) runs its own derivation and exactly one current-cost hash, and answers false`, async () => {
      const { hash } = platformHash(params, PASSWORD);
      resetSpies();

      await expect(verifyPassword({ hash, password: WRONG_PASSWORD })).resolves.toBe(false);

      const own = spy.scryptCalls.filter((call) => {
        const cost = costOf(call.options);
        return (
          call.keylen === KEY_BYTES &&
          cost.N === 2 ** params.ln &&
          cost.r === params.r &&
          cost.p === params.p
        );
      });
      expect(own, 'control: the stored hash is recomputed with its own parameters').toHaveLength(1);
      const extra = currentCostCalls();
      expect(extra, 'exactly one current-cost hash after a failed lower-cost check').toHaveLength(
        1,
      );
      expect(extra[0]?.completed, 'the extra hash finished before the answer').toBe(true);
      expect(
        asBuffer(extra[0]?.password ?? '').equals(Buffer.from(WRONG_PASSWORD, 'utf8')),
        'the extra hash is hashPassword(password) of the submitted password',
      ).toBe(true);
      expect(spy.scryptCalls, 'no other derivation').toHaveLength(2);
    });
  }

  it('a successful legacy check runs no current-cost hash', async () => {
    const legacy = await legacyHashPassword(PASSWORD);
    resetSpies();

    await expect(verifyPassword({ hash: legacy, password: PASSWORD })).resolves.toBe(true);

    expect(currentCostCalls()).toHaveLength(0);
  });

  it('a successful lower-cost platform check (ln=14) runs no current-cost hash', async () => {
    const { hash } = platformHash({ ln: 14, r: 8, p: 3 }, PASSWORD);
    resetSpies();

    await expect(verifyPassword({ hash, password: PASSWORD })).resolves.toBe(true);

    expect(currentCostCalls()).toHaveLength(0);
    expect(spy.scryptCalls, 'only its own derivation').toHaveLength(1);
  });

  it('a successful current-cost check runs only its own derivation', async () => {
    const hash = await hashPassword(PASSWORD);
    resetSpies();

    await expect(verifyPassword({ hash, password: PASSWORD })).resolves.toBe(true);

    expect(currentCostCalls(), 'its own derivation, and no extra hash').toHaveLength(1);
    expect(spy.scryptCalls).toHaveLength(1);
  });

  it('a failed current-cost check runs only its own derivation and answers false', async () => {
    const hash = await hashPassword(PASSWORD);
    resetSpies();

    await expect(verifyPassword({ hash, password: WRONG_PASSWORD })).resolves.toBe(false);

    expect(currentCostCalls(), 'its own derivation, and no extra hash').toHaveLength(1);
    expect(spy.scryptCalls).toHaveLength(1);
  });

  it('a malformed stored value fails at once, with no hash, and answers false', async () => {
    const current = await hashPassword(PASSWORD);
    const legacy = await legacyHashPassword(PASSWORD);
    const cases: { name: string; hash: string }[] = [
      { name: 'unknown algorithm', hash: current.replace('$scrypt$', '$argon2id$') },
      { name: 'malformed parameters', hash: current.replace('ln=15', 'ln=0xf') },
      { name: 'truncated platform key', hash: current.slice(0, -1) },
      { name: 'truncated legacy key', hash: legacy.slice(0, -2) },
      { name: 'not a hash', hash: 'not a hash' },
      { name: 'empty string', hash: '' },
    ];
    const outcomes: { name: string; outcome: unknown; derivations: number; legacy: number }[] = [];

    for (const { name, hash } of cases) {
      resetSpies();
      let outcome: unknown;
      try {
        outcome = await verifyPassword({ hash, password: WRONG_PASSWORD });
      } catch (error) {
        outcome = { threw: error instanceof Error ? error.message : String(error) };
      }
      outcomes.push({
        name,
        outcome,
        derivations: spy.scryptCalls.length,
        legacy: legacySpy.verifyCalls.length,
      });
    }

    expect(outcomes).toEqual(
      cases.map(({ name }) => ({ name, outcome: false, derivations: 0, legacy: 0 })),
    );
  });
});
