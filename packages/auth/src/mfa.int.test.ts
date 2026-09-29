/**
 * Integration test for task 4.1 (design D2; `specs/auth-and-rbac/spec.md`,
 * "Multi-factor authentication").
 *
 * "TOTP enrollment and backup-code generation via the `two-factor` plugin."
 * This file covers exactly the three scenarios task 4.1's own Verify clause
 * names, quoted from `specs/auth-and-rbac/spec.md`:
 *
 * #### Scenario: Enrolled user must supply a TOTP code to sign in
 * - GIVEN a user has enrolled a TOTP factor
 * - WHEN they sign in with the correct password but no TOTP code
 * - THEN sign-in does not complete and a TOTP code is requested
 *
 * #### Scenario: Backup code is single-use
 * - GIVEN a user has an unused backup code
 * - WHEN they sign in with it once, then attempt to sign in with it again
 * - THEN the first attempt succeeds and the second is rejected
 *
 * #### Scenario: Unenrolled user signs in with password alone
 * - GIVEN a user has no enrolled MFA factor
 * - WHEN they sign in with the correct password
 * - THEN sign-in completes with no additional factor requested
 *
 * The requirement text above the scenarios (same spec section) is the source
 * for "a valid TOTP code or an unused backup code in addition to the
 * password" and "A backup code MUST NOT be usable more than once."
 *
 * ## Why this is very likely already green, not red
 *
 * `./auth.ts` already registers Better Auth's own `twoFactor()` plugin with
 * no options, unconditionally, since task 2.1 (confirmed by reading the file
 * before writing this one: `plugins: [organization(), admin(), twoFactor(),
 * jwt(), apiKey(), preAuthRateLimitPlugin(options)]`). The installed
 * `better-auth@1.7.6` source (`dist/plugins/two-factor/index.mjs`,
 * `dist/plugins/two-factor/totp/index.mjs`,
 * `dist/plugins/two-factor/backup-codes/index.mjs`,
 * `dist/plugins/two-factor/verify-two-factor.mjs`, all read in full while
 * writing this file) already implements every behavior these three scenarios
 * describe, with no `@tayzu`-authored code involved at all:
 *
 * - `enableTwoFactor` (`/two-factor/enable`) with `method: 'totp'` already
 *   generates a TOTP secret/URI and plaintext backup codes.
 * - `verifyTOTP` (`/two-factor/verify-totp`), called with a real session
 *   (not a sign-in-pending 2FA cookie), already flips the enrolling user's
 *   `twoFactorEnabled` to `true` on first success.
 * - The plugin's own `hooks.after` matcher on `/sign-in/email` already checks
 *   `data.user.twoFactorEnabled` and, when true, already deletes the
 *   credential-only session, already sets a signed `two_factor` challenge
 *   cookie, and already responds `{ twoFactorRedirect: true, twoFactorMethods
 *   }` instead of a session token -- exactly scenario 1's THEN clause.
 * - `verifyBackupCode` (`/two-factor/verify-backup-code`) already removes the
 *   consumed code from the stored list (`updated: codes.filter((code) =>
 *   code !== data.code)`) before persisting it back, so a second attempt with
 *   the same code already fails `UNAUTHORIZED`/`INVALID_BACKUP_CODE` --
 *   exactly scenario 2's THEN clause, independent of the one-time-use
 *   `two_factor` cookie itself (a *second*, fresh sign-in/challenge is used
 *   below for the second attempt, so only the backup-code-list removal, not
 *   the cookie's own single-use verification token, is what scenario 2
 *   actually probes).
 * - An unenrolled user's `data.user.twoFactorEnabled` is `false`, so the same
 *   hook's `if (!data?.user.twoFactorEnabled) return;` guard leaves Better
 *   Auth's ordinary credential-only sign-in response (a real session token)
 *   untouched -- exactly scenario 3's THEN clause.
 *
 * Per this assignment's own instructions ("If they already pass because a
 * library already behaves this way, say so clearly instead of forcing a
 * failure"): all three scenarios below are expected to **already pass**
 * against today's code, unmodified. This file is still written as a real,
 * from-the-spec test (not skipped, not weakened) so it becomes this
 * requirement's regression guard for whatever task 4.1's green phase (if any
 * production change turns out to be needed once this is actually run) or a
 * later task does to `./auth.ts`'s `twoFactor()` registration.
 *
 * ## Why a locally-computed TOTP code, not a hardcoded one
 *
 * `enableTwoFactor`'s response never returns the raw secret Better Auth uses
 * for HMAC (`dist/plugins/two-factor/index.mjs`: `const secret =
 * generateRandomString(32);` is encrypted at rest and never serialized back
 * to the caller) -- only `totpURI`, an `otpauth://totp/...?secret=BASE32...`
 * string whose `secret` query parameter is that same raw secret's *Base32
 * encoding* (`dist/plugins/two-factor/index.mjs`'s `createOTP(secret,
 * ...).url(...)` calls into `@better-auth/utils`'s `generateQRCode`, which
 * Base32-encodes the exact same `secret` variable used for HMAC -- verified
 * against the installed `@better-auth/utils@0.4.2` source, `dist/otp.mjs`).
 * A real authenticator app reverses that encoding (Base32-decodes the URI's
 * `secret` back to the original raw bytes) before computing a code; this file
 * does the same with `decodeBase32`/`rawSecretFromTotpUri` below (RFC 4648
 * alphabet, no padding, matching `@better-auth/utils`'s own
 * `dist/base32.mjs`), confirmed by a discarded Node probe against the
 * installed `@better-auth/utils@0.4.2` package before writing this file: for
 * an arbitrary 32-character secret in `generateRandomString`'s own alphabet
 * (`a-z0-9A-Z-_`, `dist/crypto/random.mjs`), Base32-encoding then decoding
 * that secret and computing a TOTP from the decoded value reproduces bit for
 * bit the same 6-digit code the original (pre-encoding) secret produces. The
 * recovered raw secret is then handed to the plugin's own server-only helper,
 * `auth.api.generateTOTP({ body: { secret } })` (`dist/plugins/two-factor/
 * totp/index.mjs`: `createAuthEndpoint.serverOnly(...)`, "callable through
 * `auth.api.*` from trusted server code but never registered on the HTTP
 * router" -- verified against the installed `@better-auth/core@1.7.6`
 * source, `dist/api/index.mjs`), which computes a real, currently-valid code
 * from that secret -- so scenario 1's enrollment step below produces a
 * *provably enrolled and verifiable* TOTP factor, not merely an
 * `enableTwoFactor` call whose returned URI is never actually exercised.
 *
 * ## Why `auth.handler(new Request(...))` for sign-up/sign-in, `auth.api.*` elsewhere
 *
 * Same split as every other int test file in this package
 * (`session-policy.int.test.ts`, `active-org.int.test.ts`): sign-up and
 * sign-in need a real HTTP `Response` to read back a `Set-Cookie` header (the
 * session cookie after sign-up, and -- for an MFA-enrolled user -- the signed
 * `two_factor` challenge cookie after a 2FA-pending sign-in); `auth.api.
 * signUpEmail`/`signInEmail` never produce one. Every request below carries
 * its own fresh, random `x-forwarded-for` IP (`randomIp()`), per this task's
 * own instructions, so `./auth.ts`'s task-2.5 rate limiter (never configured
 * by this file: `createAuth({ db, secret })`, no `rateLimit` option) is not
 * in play either way, and so that repeated sign-ins for the "single-use
 * backup code" scenario are never at risk of colliding on the same IP+email
 * rate-limit bucket if a later task's default configuration changes that.
 * `enableTwoFactor`/`verifyTOTP` are session-authenticated calls with no
 * response headers this file needs back, so they go through `auth.api.*`
 * with an explicit `headers` option carrying the session cookie -- the same
 * pattern `session-policy.int.test.ts`'s own `changePasswordApiOf(auth).
 * changePassword({ body, headers })` already establishes for a
 * session-authenticated endpoint. `verifyBackupCode` is likewise called
 * through `auth.api.verifyBackupCode({ body, headers })`, headers carrying
 * the signed `two_factor` cookie instead of a session cookie -- this file
 * only needs to observe success/rejection, not a fresh `Set-Cookie` header,
 * so the thrown `APIError` (on rejection) or plain `{ user }` object (on
 * success) `auth.api.*` already returns is enough.
 *
 * ## Why no organization/tenant setup
 *
 * None of these three scenarios mention a tenant or an organization: they are
 * pure Better Auth authentication-layer behavior, exercised identically
 * whether or not the signed-up user ever joins one. Skipping organization
 * creation keeps each scenario's setup to exactly what its own GIVEN clause
 * names.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { runMigrations } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Import order is load-bearing (task 2.4; design D1; `packages/observability/
// CLAUDE.md`, "Import order"): the harness must register before `./auth.js`,
// which imports a telemetry/instruments module that creates its tracer,
// meter and logger at import time. Same rationale as every other int test
// file in this package (for example `active-org.int.test.ts`'s own,
// identically side-effecting import). Task 4.1's own Verify clause names no
// telemetry signal, so the harness is never read from in this file.
import { createAdminUser, signInAdminUser } from './__fixtures__/admin-user.js';
import './__fixtures__/registered-harness.js';
import { createAuth, type AuthInstance } from './auth.js';
import * as authSchema from './persistence/schema.js';
import { TEST_SECRET } from './__fixtures__/test-secret.js';

/** Same fail-fast pattern as every other int test file in this repo. */
function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim() === '') {
    throw new Error(
      'DATABASE_URL is not set: the int project global setup should have stopped this run.',
    );
  }
  return url;
}

function connect(url: string): ReturnType<typeof drizzle<typeof authSchema>> {
  return drizzle(url, { schema: authSchema });
}

type TestDb = ReturnType<typeof connect>;

async function endQuietly(closeable: {
  on(event: 'error', listener: (error: unknown) => void): unknown;
  end(): Promise<void>;
}): Promise<void> {
  closeable.on('error', () => {
    // Expected only during teardown; nothing left to report it to.
  });
  await closeable.end();
}

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

function randomEmail(): string {
  return `mfa-${randomUUID()}@example.test`;
}

/** A password long enough for Better Auth's default 8-character minimum. */
const TEST_PASSWORD = 'correct horse battery staple';
const TEST_USER_NAME = 'MFA Test User';

const AUTH_BASE_URL = 'http://localhost:3000/api/auth';

/**
 * `./auth.ts`'s `AuthInstance.api` is typed `unknown`; `.handler` is Better
 * Auth's real, documented HTTP entry point, not otherwise exposed on
 * `AuthInstance` yet -- same cast every other int test file in this package
 * already uses (for example `session-policy.int.test.ts`'s own `handlerOf`).
 */
function handlerOf(auth: AuthInstance): (request: Request) => Promise<Response> {
  return (auth as unknown as { handler: (request: Request) => Promise<Response> }).handler;
}

function postJson(
  handler: (request: Request) => Promise<Response>,
  path: string,
  body: Record<string, unknown>,
  ip: string,
): Promise<Response> {
  return handler(
    new Request(`${AUTH_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': ip,
      },
      body: JSON.stringify(body),
    }),
  );
}

/**
 * A real `cookie` header value built from a Better Auth HTTP response's own
 * `Set-Cookie` header(s) -- same helper as every other int test file in this
 * package (for example `session-policy.int.test.ts`'s own
 * `cookieHeaderFrom`).
 */
function cookieHeaderFrom(response: Response): string {
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length === 0) {
    throw new Error('expected response to carry at least one Set-Cookie header');
  }
  return setCookies.map((raw) => raw.split(';')[0]).join('; ');
}

interface SignInSuccessBody {
  readonly token: string | null;
  readonly user: { readonly id: string; readonly email: string };
}

interface SignInTwoFactorChallengeBody {
  readonly twoFactorRedirect: true;
  readonly twoFactorMethods: readonly string[];
}

/**
 * The narrow slice of `auth.api` this file drives (session-authenticated
 * two-factor endpoints, plus the server-only TOTP-code helper), typed
 * locally the same "introspect the narrower production type locally" pattern
 * every other int test file in this package already uses for `auth.api`
 * (`./auth.ts`'s own `AuthInstance.api` stays `unknown`).
 */
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
  verifyBackupCode(args: {
    body: { code: string };
    headers: Headers;
  }): Promise<{ token?: string | null; user: { id: string } }>;
}

function twoFactorApiOf(auth: AuthInstance): TwoFactorApiSurface {
  return auth.api as TwoFactorApiSurface;
}

/**
 * A minimal RFC 4648 Base32 decoder (no padding), matching the alphabet and
 * bit-packing `@better-auth/utils@0.4.2`'s own `dist/base32.mjs` uses to
 * *encode* a TOTP secret into `totpURI`'s `secret` query parameter -- see
 * this file's own module doc comment, "Why a locally-computed TOTP code, not
 * a hardcoded one".
 */
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

/** Recovers the raw TOTP secret Better Auth used for HMAC from `totpURI`'s Base32-encoded `secret` query parameter. */
function rawSecretFromTotpUri(totpURI: string): string {
  const secretParam = new URL(totpURI).searchParams.get('secret');
  if (secretParam === null) {
    throw new Error('expected a secret query parameter on the TOTP URI');
  }
  return new TextDecoder().decode(decodeBase32(secretParam));
}

describe('Multi-factor authentication: TOTP enrollment and backup codes (task 4.1, design D2)', () => {
  let db: TestDb;
  let auth: AuthInstance;

  beforeAll(async () => {
    db = connect(databaseUrl());
    await runMigrations(db.$client);
    auth = createAuth({ db, secret: TEST_SECRET });
  }, 60_000);

  afterAll(async () => {
    await endQuietly(db.$client);
  });

  /**
   * Task 18.1 (design D22): creates a user through the admin-creation path
   * (`./__fixtures__/admin-user.js`'s `createAdminUser`, `auth.api.
   * createUser` in-process) instead of Better Auth's own `/sign-up/email`
   * route, then signs them in to obtain a real session cookie -- `createUser`
   * itself creates no session (see that fixture's own module doc comment).
   */
  async function signUp(): Promise<{ cookie: string; userId: string; email: string }> {
    const email = randomEmail();
    const adminUser = await createAdminUser(auth, {
      name: TEST_USER_NAME,
      email,
      password: TEST_PASSWORD,
    });
    const signedIn = await signInAdminUser(auth, {
      email,
      password: TEST_PASSWORD,
      ip: randomIp(),
    });
    return { cookie: signedIn.cookie, userId: adminUser.userId, email };
  }

  /**
   * "GIVEN a user has enrolled a TOTP factor": enable TOTP, recover the raw
   * secret from the returned URI (see module doc comment), compute a
   * currently-valid code from it, then verify that code with the same
   * session -- the same two-step "enable, then verify" enrollment flow a real
   * authenticator-app user follows, ending with `user.twoFactorEnabled ===
   * true` (`dist/plugins/two-factor/totp/index.mjs`'s own
   * `verifyTOTP` handler).
   */
  async function enrollTotp(sessionCookie: string): Promise<{ backupCodes: readonly string[] }> {
    const api = twoFactorApiOf(auth);
    const enabled = await api.enableTwoFactor({
      body: { password: TEST_PASSWORD, method: 'totp' },
      headers: new Headers({ cookie: sessionCookie }),
    });
    expect(enabled.method).toBe('totp');
    expect(enabled.totpURI).toBeTypeOf('string');
    expect(enabled.backupCodes.length).toBeGreaterThan(0);

    const secret = rawSecretFromTotpUri(enabled.totpURI);
    const { code } = await api.generateTOTP({ body: { secret } });
    expect(code).toBeTypeOf('string');

    await api.verifyTOTP({
      body: { code },
      headers: new Headers({ cookie: sessionCookie }),
    });

    return { backupCodes: enabled.backupCodes };
  }

  it('Enrolled user must supply a TOTP code to sign in', async () => {
    const handler = handlerOf(auth);
    const user = await signUp();
    await enrollTotp(user.cookie);

    // WHEN "they sign in with the correct password but no TOTP code".
    const signInResponse = await postJson(
      handler,
      '/sign-in/email',
      { email: user.email, password: TEST_PASSWORD },
      randomIp(),
    );

    // THEN "sign-in does not complete and a TOTP code is requested": a
    // successful (200) response that is a 2FA challenge, not a session.
    expect(signInResponse.status, 'the request itself is not rejected outright').toBe(200);
    const body = (await signInResponse.json()) as Partial<SignInSuccessBody> &
      Partial<SignInTwoFactorChallengeBody>;
    expect(body.twoFactorRedirect, 'a TOTP code is requested, not a completed sign-in').toBe(true);
    expect(body.twoFactorMethods).toContain('totp');
    expect(body.token, 'sign-in does not complete: no session token is issued').toBeUndefined();
  });

  it('Backup code is single-use', async () => {
    const handler = handlerOf(auth);
    const user = await signUp();
    const { backupCodes } = await enrollTotp(user.cookie);
    const backupCode = backupCodes[0];
    if (backupCode === undefined) {
      throw new Error('expected at least one backup code from enrollment');
    }

    // WHEN "they sign in with it once": a fresh password sign-in first
    // produces a pending 2FA challenge (same mechanism as the previous
    // scenario), whose signed `two_factor` cookie authorizes the backup-code
    // verification below.
    const firstChallenge = await postJson(
      handler,
      '/sign-in/email',
      { email: user.email, password: TEST_PASSWORD },
      randomIp(),
    );
    expect(firstChallenge.status).toBe(200);
    const firstChallengeCookie = cookieHeaderFrom(firstChallenge);

    const api = twoFactorApiOf(auth);
    const firstAttempt = await api.verifyBackupCode({
      body: { code: backupCode },
      headers: new Headers({ cookie: firstChallengeCookie }),
    });

    // THEN "the first attempt succeeds".
    expect(firstAttempt.user.id).toBe(user.userId);

    // WHEN "... then attempt to sign in with it again": a second, independent
    // password sign-in produces a fresh 2FA challenge (a fresh `two_factor`
    // cookie), so what this second verification probes is the backup code
    // itself having been consumed from the stored list, not the first
    // challenge cookie's own one-time verification token.
    const secondChallenge = await postJson(
      handler,
      '/sign-in/email',
      { email: user.email, password: TEST_PASSWORD },
      randomIp(),
    );
    expect(secondChallenge.status).toBe(200);
    const secondChallengeCookie = cookieHeaderFrom(secondChallenge);

    // THEN "... the second is rejected".
    await expect(
      api.verifyBackupCode({
        body: { code: backupCode },
        headers: new Headers({ cookie: secondChallengeCookie }),
      }),
    ).rejects.toMatchObject({
      status: 'UNAUTHORIZED',
      body: { code: 'INVALID_BACKUP_CODE' },
    });
  });

  it('Unenrolled user signs in with password alone', async () => {
    const handler = handlerOf(auth);
    // GIVEN "a user has no enrolled MFA factor": a plain sign-up, no
    // `enableTwoFactor`/`verifyTOTP` call at all.
    const user = await signUp();

    // WHEN "they sign in with the correct password".
    const signInResponse = await postJson(
      handler,
      '/sign-in/email',
      { email: user.email, password: TEST_PASSWORD },
      randomIp(),
    );

    // THEN "sign-in completes with no additional factor requested": an
    // ordinary session token, no 2FA challenge shape at all.
    expect(signInResponse.status).toBe(200);
    const body = (await signInResponse.json()) as Partial<SignInSuccessBody> &
      Partial<SignInTwoFactorChallengeBody>;
    expect(body.twoFactorRedirect, 'no additional factor is requested').toBeUndefined();
    expect(body.token).toBeTypeOf('string');
    expect(body.token).not.toBe('');
    expect(body.user?.email).toBe(user.email);
  });
});
