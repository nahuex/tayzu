/**
 * The platform's password hash (048 design D5, Q8): Tayzu-owned scrypt from
 * `node:crypto`, written in a self-describing PHC-style format,
 * `$scrypt$ln=<log2 N>,r=<r>,p=<p>$<salt>$<key>`, with the salt and the key in
 * standard base64 without padding.
 */
import { randomBytes, scrypt } from 'node:crypto';

/** design D5: the current cost, `N = 2^LOG2_N`. */
const LOG2_N = 15;
/** design D5: the scrypt block size. */
const BLOCK_SIZE = 8;
/** design D5: the scrypt parallelization. */
const PARALLELIZATION = 3;
/** design D5: the salt length, in bytes, drawn from `randomBytes`. */
const SALT_BYTES = 16;
/** design D5: the derived key length, in bytes. */
const KEY_BYTES = 64;
/**
 * design D5: `maxmem` set explicitly to 64 MiB, because `128 * N * r` is
 * 32 MiB, which Node's default `maxmem` refuses.
 */
const MAX_MEMORY_BYTES = 64 * 1024 * 1024;

/** Standard base64 without its `=` padding (design D5 "Format"). */
function toUnpaddedBase64(bytes: Buffer): string {
  return bytes.toString('base64').replace(/=+$/, '');
}

/** `node:crypto`'s callback `scrypt`, promisified. */
function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_BYTES,
      { N: 2 ** LOG2_N, r: BLOCK_SIZE, p: PARALLELIZATION, maxmem: MAX_MEMORY_BYTES },
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
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveKey(password.normalize('NFC'), salt);
  return `$scrypt$ln=${String(LOG2_N)},r=${String(BLOCK_SIZE)},p=${String(PARALLELIZATION)}$${toUnpaddedBase64(salt)}$${toUnpaddedBase64(key)}`;
}
