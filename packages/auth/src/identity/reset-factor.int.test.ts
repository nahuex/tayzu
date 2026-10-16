/**
 * Task 8.1 of openspec/changes/044-password-reset-and-account-recovery (design D6,
 * "Enrolled and a `factor`" and "Drift guard"; D7 step 10).
 *
 * The pure factor verifier `./reset-factor.ts`: no database. Cases named by the
 * task's Verify clause:
 *
 * - "a valid TOTP code verifies"
 * - "a backup code verifies and the remaining codes exclude it"
 * - the drift case "for the current, previous and next windows and a wrong code,
 *   the verifier and the installed `/two-factor/verify-totp` agree"
 * - "a code that is only a prefix of a stored code does not match"
 *
 * Expected production symbol (the design fixes the module and the inputs, not the
 * exact signature; this file fixes it):
 *
 *   verifyResetFactor(input: {
 *     factor: { kind: 'totp' | 'backup_code'; code: string };
 *     twoFactor: { secret: string; backupCodes: string };   // the stored, encrypted columns
 *     secretConfig: SecretConfig;                            // (await auth.$context).secretConfig
 *   }): Promise<
 *     | { verified: false }
 *     | { verified: true; remainingBackupCodes: string | null }
 *   >
 *
 * `remainingBackupCodes` is the re-encrypted list without the spent code for a
 * `backup_code` match (decryptable with Better Auth's `symmetricDecrypt` and the same
 * `secretConfig`), and `null` for a TOTP match.
 *
 * Integration-level only for the drift case (it needs a real enrolment and the real
 * endpoint); the other cases touch no database but live in this file by the task.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { createOTP } from '@better-auth/utils/otp';
import { runMigrations } from '@tayzu/db';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAdminUser, signInAdminUser } from '../__fixtures__/admin-user.js';
import '../__fixtures__/registered-harness.js';
import { TEST_SECRET } from '../__fixtures__/test-secret.js';
import { createAuth, type AuthInstance } from '../auth.js';
import * as authSchema from '../persistence/schema.js';
import { verifyResetFactor } from './reset-factor.js';

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim() === '') {
    throw new Error(
      'DATABASE_URL is not set: the int project global setup should have stopped this run.',
    );
  }
  return url;
}

type TestDb = ReturnType<typeof drizzle<typeof authSchema>>;

async function endQuietly(closeable: {
  on(event: 'error', listener: (error: unknown) => void): unknown;
  end(): Promise<void>;
}): Promise<void> {
  closeable.on('error', () => {
    // Expected only during teardown.
  });
  await closeable.end();
}

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

const TEST_USER_PASSWORD = 'correct horse battery staple';
const AUTH_BASE_URL = 'http://localhost:3000/api/auth';

function handlerOf(auth: AuthInstance): (request: Request) => Promise<Response> {
  return (auth as unknown as { handler: (request: Request) => Promise<Response> }).handler;
}

interface TwoFactorApiSurface {
  enableTwoFactor(args: {
    body: { password: string; method: 'totp' };
    headers: Headers;
  }): Promise<{ method: 'totp'; totpURI: string; backupCodes: readonly string[] }>;
  generateTOTP(args: { body: { secret: string } }): Promise<{ code: string }>;
  verifyTOTP(args: {
    body: { code: string };
    headers: Headers;
  }): Promise<{ token: string | null; user: { id: string } }>;
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32(encoded: string): Uint8Array {
  const bytes: number[] = [];
  let buffer = 0;
  let bitsCollected = 0;
  for (const char of encoded) {
    if (char === '=') {
      break;
    }
    const value = BASE32_ALPHABET.indexOf(char.toUpperCase());
    if (value === -1) {
      throw new Error(`invalid base32 character in TOTP secret: ${char}`);
    }
    buffer = (buffer << 5) | value;
    bitsCollected += 5;
    if (bitsCollected >= 8) {
      bitsCollected -= 8;
      bytes.push((buffer >> bitsCollected) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

function rawSecretFromTotpUri(totpURI: string): string {
  const secretParam = new URL(totpURI).searchParams.get('secret');
  if (secretParam === null) {
    throw new Error('expected a secret query parameter on the TOTP URI');
  }
  return new TextDecoder().decode(decodeBase32(secretParam));
}

function cookieHeaderFrom(response: Response): string {
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length === 0) {
    throw new Error('expected response to carry at least one Set-Cookie header');
  }
  return setCookies.map((raw) => raw.split(';')[0]).join('; ');
}

type SecretKey = Parameters<typeof symmetricEncrypt>[0]['key'];

describe('Reset factor verifier (task 8.1, design D6)', () => {
  let db: TestDb;
  let auth: AuthInstance;
  let secretConfig: SecretKey;

  beforeAll(async () => {
    db = drizzle(databaseUrl(), { schema: authSchema });
    await runMigrations(db.$client);
    auth = createAuth({ db, secret: TEST_SECRET });
    const context = await (auth.$context as Promise<{ secretConfig: SecretKey }>);
    secretConfig = context.secretConfig;
  }, 60_000);

  afterAll(async () => {
    await endQuietly(db.$client);
  });

  /** A stored `two_factor` pair, encrypted exactly as the installed plugin stores it. */
  async function storedFactor(
    secret: string,
    codes: readonly string[],
  ): Promise<{ secret: string; backupCodes: string }> {
    return {
      secret: await symmetricEncrypt({ key: secretConfig, data: secret }),
      backupCodes: await symmetricEncrypt({ key: secretConfig, data: JSON.stringify(codes) }),
    };
  }

  async function decryptCodes(encrypted: string): Promise<string[]> {
    const json = await symmetricDecrypt({ key: secretConfig, data: encrypted });
    return JSON.parse(json) as string[];
  }

  it('a valid TOTP code verifies', async () => {
    const secret = `secret-${randomUUID()}`;
    const twoFactor = await storedFactor(secret, ['abcde-fghij']);
    const code = await createOTP(secret, { period: 30, digits: 6 }).totp();

    const result = await verifyResetFactor({
      factor: { kind: 'totp', code },
      twoFactor,
      secretConfig,
    });

    expect(result.verified).toBe(true);
    if (result.verified) {
      expect(result.remainingBackupCodes, 'a TOTP match spends no backup code').toBeNull();
    }
  });

  it('a wrong TOTP code does not verify', async () => {
    const secret = `secret-${randomUUID()}`;
    const twoFactor = await storedFactor(secret, ['abcde-fghij']);
    const otp = createOTP(secret, { period: 30, digits: 6 });
    const counter = Math.floor(Date.now() / 30_000);
    const farCode = await otp.hotp(counter + 10);

    const result = await verifyResetFactor({
      factor: { kind: 'totp', code: farCode },
      twoFactor,
      secretConfig,
    });

    expect(result).toEqual({ verified: false });
  });

  it('a backup code verifies and the remaining codes exclude it', async () => {
    const codes = ['aaaaa-bbbbb', 'ccccc-ddddd', 'eeeee-fffff'];
    const twoFactor = await storedFactor(`secret-${randomUUID()}`, codes);

    const result = await verifyResetFactor({
      factor: { kind: 'backup_code', code: 'ccccc-ddddd' },
      twoFactor,
      secretConfig,
    });

    expect(result.verified).toBe(true);
    if (!result.verified || result.remainingBackupCodes === null) {
      throw new Error('expected a verified backup code with a remaining list');
    }
    expect(result.remainingBackupCodes, 'the remaining list is re-encrypted').not.toContain(
      'aaaaa',
    );
    const remaining = await decryptCodes(result.remainingBackupCodes);
    expect(remaining).toEqual(['aaaaa-bbbbb', 'eeeee-fffff']);
    expect(remaining).not.toContain('ccccc-ddddd');
  });

  it('a backup code that is not stored does not verify', async () => {
    const twoFactor = await storedFactor(`secret-${randomUUID()}`, ['aaaaa-bbbbb']);

    const result = await verifyResetFactor({
      factor: { kind: 'backup_code', code: 'zzzzz-yyyyy' },
      twoFactor,
      secretConfig,
    });

    expect(result).toEqual({ verified: false });
  });

  it('a code that is only a prefix of a stored code does not match', async () => {
    const twoFactor = await storedFactor(`secret-${randomUUID()}`, ['abcde-fghij', 'klmno-pqrst']);

    for (const code of ['abcde', 'abcde-', 'abcde-fghi', 'a', '']) {
      const result = await verifyResetFactor({
        factor: { kind: 'backup_code', code },
        twoFactor,
        secretConfig,
      });
      expect(result, `the prefix ${JSON.stringify(code)} must not match`).toEqual({
        verified: false,
      });
    }

    // The opposite direction (a stored code that is a prefix of the presented one)
    // must not match or throw either.
    const longer = await verifyResetFactor({
      factor: { kind: 'backup_code', code: 'abcde-fghijX' },
      twoFactor,
      secretConfig,
    });
    expect(longer).toEqual({ verified: false });
  });

  it('for the current, previous and next windows and a wrong code, the verifier and the installed /two-factor/verify-totp agree', async () => {
    const handler = handlerOf(auth);
    const api = auth.api as TwoFactorApiSurface;
    const email = `reset-factor-${randomUUID()}@example.test`;
    await createAdminUser(auth, { name: 'Reset Factor', email, password: TEST_USER_PASSWORD });
    const signedIn = await signInAdminUser(auth, {
      email,
      password: TEST_USER_PASSWORD,
      ip: randomIp(),
    });
    const enabled = await api.enableTwoFactor({
      body: { password: TEST_USER_PASSWORD, method: 'totp' },
      headers: new Headers({ cookie: signedIn.cookie }),
    });
    const secret = rawSecretFromTotpUri(enabled.totpURI);
    const enrolCode = await api.generateTOTP({ body: { secret } });
    await api.verifyTOTP({
      body: { code: enrolCode.code },
      headers: new Headers({ cookie: signedIn.cookie }),
    });

    // The stored, encrypted row exactly as the plugin wrote it.
    const [userRow] = await db
      .select({ id: authSchema.user.id })
      .from(authSchema.user)
      .where(eq(authSchema.user.email, email));
    if (userRow === undefined) {
      throw new Error('expected the enrolled user');
    }
    const [row] = await db
      .select({
        secret: authSchema.twoFactor.secret,
        backupCodes: authSchema.twoFactor.backupCodes,
      })
      .from(authSchema.twoFactor)
      .where(eq(authSchema.twoFactor.userId, userRow.id));
    if (row === undefined) {
      throw new Error('expected the stored two_factor row');
    }

    const otp = createOTP(secret, { period: 30, digits: 6 });
    const counter = Math.floor(Date.now() / 30_000);
    const current = await otp.hotp(counter);
    const previous = await otp.hotp(counter - 1);
    const next = await otp.hotp(counter + 1);
    const wrong = await otp.hotp(counter + 7);

    const endpointAccepts = async (code: string): Promise<boolean> => {
      const challenge = await handler(
        new Request(`${AUTH_BASE_URL}/sign-in/email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': randomIp() },
          body: JSON.stringify({ email, password: TEST_USER_PASSWORD }),
        }),
      );
      expect(challenge.status).toBe(200);
      const response = await handler(
        new Request(`${AUTH_BASE_URL}/two-factor/verify-totp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': randomIp(),
            origin: 'http://localhost:3000',
            cookie: cookieHeaderFrom(challenge),
          },
          body: JSON.stringify({ code }),
        }),
      );
      return response.status === 200;
    };

    const cases = [
      { name: 'current', code: current, accepted: true },
      { name: 'previous', code: previous, accepted: true },
      { name: 'next', code: next, accepted: true },
      { name: 'wrong', code: wrong, accepted: false },
    ];
    for (const { name, code, accepted } of cases) {
      const verifier = await verifyResetFactor({
        factor: { kind: 'totp', code },
        twoFactor: row,
        secretConfig,
      });
      const endpoint = await endpointAccepts(code);
      expect(verifier.verified, `the verifier on the ${name} window`).toBe(endpoint);
      expect(endpoint, `the installed endpoint on the ${name} window`).toBe(accepted);
    }
  });
});
