/**
 * Task 8.1d of openspec/changes/043-identity-lifecycle-and-org-admin (design Q22,
 * Q132; spec "Password policy", scenarios "A password verifies in any normalization
 * form" and "A breached password is refused in any normalization form").
 *
 * ## Production symbols expected
 *
 * - `packages/auth/src/auth.ts`: `createAuth` sets `emailAndPassword.password.hash`
 *   and `emailAndPassword.password.verify`, wrapping Better Auth's own scrypt
 *   functions so that both NFC-normalize the password first. Every verifying path
 *   (sign-in, `/verify-password`, `/two-factor/enable`, `/change-password`,
 *   `/two-factor/generate-backup-codes`, and any path outside every list such as
 *   `/two-factor/disable`) is then covered without a list.
 * - `packages/auth/src/auth.ts`: its top-level `hooks.before` NFC-normalizes the
 *   `password`, `newPassword` and `currentPassword` body fields of every
 *   `/api/auth/*` request (also an in-process `auth.api.*` call) before Better
 *   Auth's plugins run, selecting by field name, so the `haveIBeenPwned` plugin and
 *   the `/admin/create-user` check see the NFC form. A body without those fields
 *   is left untouched.
 *
 * The breached-password stub is keyed on the NFC form of the password only, so an
 * NFD presentation is refused only when the hook runs ahead of the check. The
 * password is set through `auth.api.createUser`; a password set through the
 * acceptance itself is task 8.2's case.
 */
import { createHash, randomUUID } from 'node:crypto';

import { authSchema, createAuth, type AuthInstance } from '@tayzu/auth';
import { runMigrations } from '@tayzu/db';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { harnessPools } from './__fixtures__/pools.js';
import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';

const AUTH_BASE_URL = 'http://localhost:3000/api/auth';

/** Compliant, NFC (precomposed é, ñ, ä). */
const PASSWORD_NFC = 'Café-Mañana-Passäphrase-2026!';
const PASSWORD_NFD = PASSWORD_NFC.normalize('NFD');
const COMPLIANT_NEW = 'Fresh-Compliant-Passphrase-2026!';

/** A breached password (its NFC form is the one in the stubbed range). */
const BREACHED_NFC = 'Breäched-Horse-Battery-Staple-2026!';
const BREACHED_NFD = BREACHED_NFC.normalize('NFD');

function sha1Upper(value: string): string {
  return createHash('sha1').update(value).digest('hex').toUpperCase();
}

/** The range service answers decoys plus the SHA-1 suffixes of the given passwords as they are written. */
function stubRangeService(breached: readonly string[]): void {
  vi.stubGlobal('fetch', (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const prefix = new URL(url).pathname.split('/').pop() ?? '';
    const lines = [
      '0000000000000000000000000000000000A:3',
      '1111111111111111111111111111111111B:9',
    ];
    for (const password of breached) {
      const hash = sha1Upper(password);
      if (hash.startsWith(prefix)) lines.push(`${hash.slice(5)}:42`);
    }
    return Promise.resolve(new Response(lines.join('\r\n'), { status: 200 }));
  });
}

function randomIp(): string {
  const octet = (): number => Math.floor(Math.random() * 250) + 1;
  return `${String(octet())}.${String(octet())}.${String(octet())}.${String(octet())}`;
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Recovers the raw TOTP secret from `totpURI`'s Base32 `secret` parameter (same as `mfa.int.test.ts`). */
function rawSecretFromTotpUri(totpURI: string): string {
  const encoded = new URL(totpURI).searchParams.get('secret');
  if (encoded === null) throw new Error('expected a secret query parameter on the TOTP URI');
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of encoded) {
    if (char === '=') break;
    const value = BASE32_ALPHABET.indexOf(char.toUpperCase());
    if (value === -1) throw new Error('invalid base32 character in TOTP secret');
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

interface CreateUserSurface {
  createUser(args: { body: { name: string; email: string; password: string } }): Promise<{
    user: { id: string; email: string };
  }>;
  generateTOTP(args: { body: { secret: string } }): Promise<{ code: string }>;
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('The password is NFC-normalized in two layers (task 8.1d, design Q22)', () => {
  let authPool: Pool;
  let auth: AuthInstance;

  beforeAll(async () => {
    const pools = await harnessPools();
    authPool = pools.authPool;
    await runMigrations(authPool);
    auth = createAuth({ db: drizzle(authPool, { schema: authSchema }), secret: TEST_SECRET });
  }, 60_000);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function api(): CreateUserSurface {
    return auth.api as CreateUserSurface;
  }

  function handler(request: Request): Promise<Response> {
    return (auth as unknown as { handler: (r: Request) => Promise<Response> }).handler(request);
  }

  async function post(path: string, body: unknown, cookie?: string): Promise<Response> {
    return handler(
      new Request(`${AUTH_BASE_URL}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': randomIp(),
          origin: 'http://localhost:3000',
          ...(cookie === undefined ? {} : { cookie }),
        },
        body: JSON.stringify(body),
      }),
    );
  }

  function cookieOf(response: Response): string {
    return response.headers
      .getSetCookie()
      .map((raw) => raw.split(';')[0])
      .join('; ');
  }

  /** A user created through `auth.api.createUser` with the NFC password, and a session for it. */
  async function userWithSession(
    password: string = PASSWORD_NFC,
  ): Promise<{ email: string; cookie: string }> {
    const email = `nfc-${randomUUID()}@example.test`;
    await api().createUser({ body: { name: 'NFC User', email, password } });
    const response = await post('/sign-in/email', { email, password });
    expect(response.status, 'the fixture user signs in with its NFC password').toBe(200);
    return { email, cookie: cookieOf(response) };
  }

  /**
   * Enrolls a TOTP factor (NFC password), then signs in again and completes the
   * second factor, which records the fresh `mfa` step-up marker on the new session.
   * Returns that session's cookie.
   */
  async function enrollAndVerifyTotp(email: string, cookie: string): Promise<string> {
    const enabled = await post('/two-factor/enable', { password: PASSWORD_NFC }, cookie);
    expect(enabled.status, 'enrollment with the NFC password').toBe(200);
    const { totpURI } = (await enabled.json()) as { totpURI: string };
    const secret = rawSecretFromTotpUri(totpURI);
    const enrolled = await api().generateTOTP({ body: { secret } });
    const confirmed = await post('/two-factor/verify-totp', { code: enrolled.code }, cookie);
    expect(confirmed.status, 'the enrollment code verifies').toBe(200);

    const challenge = await post('/sign-in/email', { email, password: PASSWORD_NFC });
    expect(challenge.status).toBe(200);
    const next = await api().generateTOTP({ body: { secret } });
    const completed = await post(
      '/two-factor/verify-totp',
      { code: next.code },
      cookieOf(challenge),
    );
    expect(completed.status, 'the second factor completes the sign-in').toBe(200);
    return cookieOf(completed);
  }

  async function countUsers(email: string): Promise<number> {
    const result = await drizzle(authPool, { schema: authSchema }).execute<{ count: string }>(sql`
      select count(*)::text as count from auth."user" where email = ${email}
    `);
    return Number(result.rows[0]?.count ?? '0');
  }

  it('fixtures: the NFD form differs from the NFC form', () => {
    expect(PASSWORD_NFD).not.toBe(PASSWORD_NFC);
    expect(BREACHED_NFD).not.toBe(BREACHED_NFC);
    expect(sha1Upper(BREACHED_NFD)).not.toBe(sha1Upper(BREACHED_NFC));
  });

  it('A password verifies in any normalization form: sign-in', async () => {
    const email = `nfc-${randomUUID()}@example.test`;
    await api().createUser({ body: { name: 'NFC User', email, password: PASSWORD_NFC } });

    const nfd = await post('/sign-in/email', { email, password: PASSWORD_NFD });
    const nfc = await post('/sign-in/email', { email, password: PASSWORD_NFC });

    expect(nfd.status, 'the NFD form signs in').toBe(200);
    expect(nfc.status, 'the NFC form signs in').toBe(200);
  });

  it('A password set in its NFD form is stored as the NFC password', async () => {
    const email = `nfc-${randomUUID()}@example.test`;
    await api().createUser({ body: { name: 'NFC User', email, password: PASSWORD_NFD } });

    const nfc = await post('/sign-in/email', { email, password: PASSWORD_NFC });
    const nfd = await post('/sign-in/email', { email, password: PASSWORD_NFD });

    expect(nfc.status).toBe(200);
    expect(nfd.status).toBe(200);
  });

  it('A password verifies in any normalization form: /verify-password', async () => {
    const { cookie } = await userWithSession();

    const response = await post('/verify-password', { password: PASSWORD_NFD }, cookie);

    expect(response.status).toBe(200);
  });

  it('A password verifies in any normalization form: /two-factor/enable', async () => {
    const { cookie } = await userWithSession();

    const response = await post('/two-factor/enable', { password: PASSWORD_NFD }, cookie);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { totpURI?: unknown };
    expect(body.totpURI).toBeTypeOf('string');
  });

  it('A password verifies in any normalization form: /change-password (its currentPassword)', async () => {
    const { email, cookie } = await userWithSession();

    const response = await post(
      '/change-password',
      { currentPassword: PASSWORD_NFD, newPassword: COMPLIANT_NEW },
      cookie,
    );

    expect(response.status).toBe(200);
    const signIn = await post('/sign-in/email', { email, password: COMPLIANT_NEW });
    expect(signIn.status, 'the new password is set').toBe(200);
  });

  it('A password verifies in any normalization form: /two-factor/generate-backup-codes', async () => {
    const { email, cookie } = await userWithSession();
    const fresh = await enrollAndVerifyTotp(email, cookie);

    const response = await post(
      '/two-factor/generate-backup-codes',
      { password: PASSWORD_NFD },
      fresh,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { backupCodes?: unknown };
    expect(Array.isArray(body.backupCodes)).toBe(true);
  });

  it('An endpoint outside any list verifies in NFD too: /two-factor/disable', async () => {
    const { email, cookie } = await userWithSession();
    const fresh = await enrollAndVerifyTotp(email, cookie);

    const response = await post('/two-factor/disable', { password: PASSWORD_NFD }, fresh);

    expect(response.status, 'the normalization is in the verify function, not a path list').toBe(
      200,
    );
  });

  it('A breached password presented in its NFD form is refused on /change-password', async () => {
    const { email, cookie } = await userWithSession();
    stubRangeService([BREACHED_NFC]);

    const response = await post(
      '/change-password',
      { currentPassword: PASSWORD_NFC, newPassword: BREACHED_NFD },
      cookie,
    );

    expect(response.status, 'the breach check sees the NFC form').toBe(400);
    const text = await response.text();
    expect(text).not.toContain(BREACHED_NFD);
    expect(text).not.toContain(BREACHED_NFC);
    vi.unstubAllGlobals();
    const old = await post('/sign-in/email', { email, password: PASSWORD_NFC });
    expect(old.status, 'the old password still works').toBe(200);
    const set = await post('/sign-in/email', { email, password: BREACHED_NFC });
    expect(set.status, 'the breached password was not set').not.toBe(200);
  });

  it('A breached password presented in its NFD form is refused through auth.api.createUser', async () => {
    const email = `nfc-breached-${randomUUID()}@example.test`;
    stubRangeService([BREACHED_NFC]);

    const error = await caught(
      api().createUser({ body: { name: 'Breached', email, password: BREACHED_NFD } }),
    );

    expect(error, 'the NFD form of a breached password is refused').toBeDefined();
    expect(await countUsers(email), 'no user is created').toBe(0);
  });

  it('The hook leaves a body without the password fields untouched', async () => {
    const { cookie } = await userWithSession();
    const decomposedName = 'José Muñoz';
    expect(decomposedName).not.toBe(decomposedName.normalize('NFC'));

    const update = await post('/update-user', { name: decomposedName }, cookie);
    expect(update.status).toBe(200);

    const session = await handler(
      new Request(`${AUTH_BASE_URL}/get-session`, {
        method: 'GET',
        headers: { 'x-forwarded-for': randomIp(), cookie },
      }),
    );
    expect(session.status, 'a request with no body is not broken by the hook').toBe(200);
    const body = (await session.json()) as { user: { name: string } };
    expect(body.user.name, 'a non-password field keeps its form').toBe(decomposedName);
  });
});
