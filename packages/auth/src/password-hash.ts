/**
 * The platform's password hash (048 design D5, Q8): Tayzu-owned scrypt from
 * `node:crypto`, written in a self-describing PHC-style format,
 * `$scrypt$ln=<log2 N>,r=<r>,p=<p>$<salt>$<key>`, with the salt and the key in
 * standard base64 without padding. Legacy Better Auth `salt:key` hashes are
 * still verified, through `better-auth/crypto`, until they are rewritten.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

import { verifyPassword as verifyLegacyPassword } from 'better-auth/crypto';

/** The scrypt cost parameters a platform hash names. */
interface ScryptParams {
  /** `log2 N`. */
  readonly ln: number;
  readonly r: number;
  readonly p: number;
}

/** design D5: the current cost, `N = 2^15`, `r = 8`, `p = 3`. */
const CURRENT_PARAMS: ScryptParams = { ln: 15, r: 8, p: 3 };
/** design D5: the salt length written, in bytes, drawn from `randomBytes`. */
const SALT_BYTES = 16;
/** design D5 "Format": the salt lengths accepted when parsing, in bytes. */
const MIN_SALT_BYTES = 16;
const MAX_SALT_BYTES = 64;
/** design D5: the derived key length, in bytes. */
const KEY_BYTES = 64;
/** design D5 "Format": the accepted parameter ranges, inclusive. */
const LN_RANGE = { min: 14, max: 20 } as const;
const R_RANGE = { min: 1, max: 16 } as const;
const P_RANGE = { min: 1, max: 16 } as const;
/**
 * design D5: `maxmem` set explicitly to 64 MiB, because `128 * N * r` is
 * 32 MiB at the current cost, which Node's default `maxmem` refuses.
 */
const MAX_MEMORY_BYTES = 64 * 1024 * 1024;

/**
 * design D5 "Format": exactly five `$`-separated fields with an empty first
 * one, the literal `scrypt`, `ln`, `r` and `p` in that order as unsigned
 * decimals without a leading zero, then the salt and the key in the standard
 * base64 alphabet. The ranges and the decoded lengths are checked afterwards.
 */
const PLATFORM_FORMAT =
  /^\$scrypt\$ln=([1-9][0-9]?),r=([1-9][0-9]?),p=([1-9][0-9]?)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

/** design D5 "Verification": a legacy Better Auth hash, a 16-byte hex salt and a 64-byte hex key. */
const LEGACY_FORMAT = /^[0-9a-f]{32}:[0-9a-f]{128}$/;

/** A parsed platform hash. */
interface PlatformHash {
  readonly params: ScryptParams;
  readonly salt: Buffer;
  readonly key: Buffer;
}

/** Standard base64 without its `=` padding (design D5 "Format"). */
function toUnpaddedBase64(bytes: Buffer): string {
  return bytes.toString('base64').replace(/=+$/, '');
}

/**
 * Decodes unpadded standard base64, or `undefined` when the text is not the
 * canonical encoding of its bytes (an impossible length or non-zero trailing
 * bits), both of which `Buffer.from` would silently accept.
 */
function fromUnpaddedBase64(text: string): Buffer | undefined {
  const bytes = Buffer.from(text, 'base64');
  return toUnpaddedBase64(bytes) === text ? bytes : undefined;
}

function inRange(value: number, range: { readonly min: number; readonly max: number }): boolean {
  return value >= range.min && value <= range.max;
}

/** The strict parse of design D5 "Format"; `undefined` means "not a platform hash". */
function parsePlatformHash(hash: string): PlatformHash | undefined {
  const match = PLATFORM_FORMAT.exec(hash);
  if (match === null) {
    return undefined;
  }
  const [, lnText, rText, pText, saltText, keyText] = match;
  if (
    lnText === undefined ||
    rText === undefined ||
    pText === undefined ||
    saltText === undefined ||
    keyText === undefined
  ) {
    return undefined;
  }
  const params: ScryptParams = { ln: Number(lnText), r: Number(rText), p: Number(pText) };
  if (!inRange(params.ln, LN_RANGE) || !inRange(params.r, R_RANGE) || !inRange(params.p, P_RANGE)) {
    return undefined;
  }
  const salt = fromUnpaddedBase64(saltText);
  const key = fromUnpaddedBase64(keyText);
  if (
    salt === undefined ||
    key === undefined ||
    salt.length < MIN_SALT_BYTES ||
    salt.length > MAX_SALT_BYTES ||
    key.length !== KEY_BYTES
  ) {
    return undefined;
  }
  return { params, salt, key };
}

/**
 * The `maxmem` for a set of parameters: twice scrypt's `128 * N * r` working
 * set, and never less than the 64 MiB the current cost is hashed with.
 */
function maxMemoryFor(params: ScryptParams): number {
  return Math.max(MAX_MEMORY_BYTES, 2 * 128 * 2 ** params.ln * params.r);
}

/** `node:crypto`'s callback `scrypt`, promisified, at the given parameters. */
function deriveKey(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_BYTES,
      { N: 2 ** params.ln, r: params.r, p: params.p, maxmem: maxMemoryFor(params) },
      (error, key) => {
        if (error === null) {
          resolve(key);
        } else {
          reject(error);
        }
      },
    );
  });
}

/**
 * Hashes a password at the current cost. The password is NFC-normalized here,
 * and only NFC (design D5 "Normalization").
 */
export async function hashPassword(password: string): Promise<string> {
  const { ln, r, p } = CURRENT_PARAMS;
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveKey(password.normalize('NFC'), salt, CURRENT_PARAMS);
  return `$scrypt$ln=${String(ln)},r=${String(r)},p=${String(p)}$${toUnpaddedBase64(salt)}$${toUnpaddedBase64(key)}`;
}

/**
 * Verifies a password against a stored hash in the platform or the legacy
 * Better Auth format (design D5 "Verification"). The password is
 * NFC-normalized for both. A stored value in neither format, or any failure
 * while verifying, answers `false`: this never throws.
 */
export async function verifyPassword(input: { hash: string; password: string }): Promise<boolean> {
  try {
    const password = input.password.normalize('NFC');
    const platform = parsePlatformHash(input.hash);
    if (platform !== undefined) {
      const key = await deriveKey(password, platform.salt, platform.params);
      return key.length === platform.key.length && timingSafeEqual(key, platform.key);
    }
    if (LEGACY_FORMAT.test(input.hash)) {
      return await verifyLegacyPassword({ hash: input.hash, password });
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Whether a stored hash should be rewritten at the current cost after a
 * successful sign-in (design D5 "Rehash on sign-in"): a legacy hash, or a
 * platform hash with any parameter below the current one. A value in neither
 * format is never rehashed.
 */
export function needsRehash(hash: string): boolean {
  const platform = parsePlatformHash(hash);
  if (platform !== undefined) {
    const { ln, r, p } = platform.params;
    return ln < CURRENT_PARAMS.ln || r < CURRENT_PARAMS.r || p < CURRENT_PARAMS.p;
  }
  return LEGACY_FORMAT.test(hash);
}
