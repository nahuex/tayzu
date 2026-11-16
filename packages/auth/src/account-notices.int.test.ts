/**
 * Task 7.1 of openspec/changes/044-password-reset-and-account-recovery (design D8,
 * "Hook points"). Spec scenario, quoted from
 * `specs/password-reset-and-account-recovery/spec.md`:
 *
 * #### Scenario: A password change is announced
 * - WHEN a user changes their password with the current password
 * - THEN the user receives the password-changed notice, and a failed change sends none
 *
 * The task's Verify clause: that scenario and the case "a failed change sends none".
 *
 * ## Production symbols expected
 *
 * - `auth.ts`: `CreateAuthOptions.accountNotices?: AccountNoticePort`, where
 *   `AccountNoticePort.notify(kind, { userId })` never throws. For a successful
 *   `/change-password` the `hooks.after` calls
 *   `accountNotices.notify('PasswordChangedNotice', { userId })` exactly once, with
 *   the session user's id and nothing else. The `kind` is the `EmailTemplate` kind of
 *   design D8 (`PasswordChangedNotice`). A refused change calls `notify` never.
 *
 * ## Harness
 *
 * `auth.handler(new Request(...))` with a fresh random `x-forwarded-for` per request;
 * a fresh random tenant and user per test.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { runMigrations } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Import order is load-bearing (design D1): the harness registers before `./auth.js`.
import './__fixtures__/registered-harness.js';
import { bootstrapTestTenant, signInAdminUser, testAppPool } from './__fixtures__/admin-user.js';
import { TEST_PASSWORD, TEST_SECRET } from './__fixtures__/test-secret.js';
import { createAuth, type AuthInstance, type CreateAuthOptions } from './auth.js';
import { generateTemporaryPassword } from './identity/temporary-password.js';
import * as authSchema from './persistence/schema.js';

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

const AUTH_BASE_URL = 'http://localhost:3000/api/auth';

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

function handlerOf(auth: AuthInstance): (request: Request) => Promise<Response> {
  return (auth as unknown as { handler: (request: Request) => Promise<Response> }).handler;
}

/** The structural shape of the port of design D8; the production type lands in `auth.ts`. */
interface RecordingNotices {
  notify: (kind: string, subject: { userId: string }) => Promise<void>;
}

describe('A password change is announced (task 7.1, D8)', () => {
  let db: TestDb;
  let auth: AuthInstance;
  const notify = vi.fn<RecordingNotices['notify']>(() => Promise.resolve());

  beforeAll(async () => {
    db = connect(databaseUrl());
    await runMigrations(db.$client);
    const options = {
      db,
      secret: TEST_SECRET,
      accountNotices: { notify },
    } as unknown as CreateAuthOptions;
    auth = createAuth(options);
  }, 60_000);

  afterAll(async () => {
    await endQuietly(db.$client);
  });

  async function newUser(): Promise<{ userId: string; email: string; cookie: string }> {
    const email = `account-notice-${randomUUID()}@example.test`;
    const tenant = await bootstrapTestTenant(auth, {
      pool: testAppPool(),
      name: 'Account Notice User',
      email,
      password: TEST_PASSWORD,
      organizationName: 'Account Notice Org',
      organizationSlug: `account-notice-${randomUUID()}`,
      ip: randomIp(),
    });
    const signedIn = await signInAdminUser(auth, {
      email,
      password: TEST_PASSWORD,
      ip: randomIp(),
    });
    return { userId: tenant.userId, email, cookie: signedIn.cookie };
  }

  function changePassword(
    cookie: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<Response> {
    return handlerOf(auth)(
      new Request(`${AUTH_BASE_URL}/change-password`, {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
          'x-forwarded-for': randomIp(),
          origin: 'http://localhost:3000',
        },
        body: JSON.stringify({ currentPassword, newPassword }),
      }),
    );
  }

  function callsFor(userId: string): readonly (readonly [string, { userId: string }])[] {
    return notify.mock.calls.filter(([, subject]) => subject.userId === userId);
  }

  it('a successful change-password sends exactly one PasswordChangedNotice to that user', async () => {
    const user = await newUser();
    expect(callsFor(user.userId), 'sign-in and bootstrap send none').toEqual([]);

    const response = await changePassword(user.cookie, TEST_PASSWORD, generateTemporaryPassword());
    expect(response.status).toBe(200);

    await vi.waitFor(() => {
      expect(callsFor(user.userId)).toHaveLength(1);
    });
    const [kind, subject] = callsFor(user.userId)[0] ?? ['', { userId: '' }];
    expect(kind).toBe('PasswordChangedNotice');
    expect(subject).toEqual({ userId: user.userId });
  }, 60_000);

  it('a failed change (wrong current password) sends none', async () => {
    const user = await newUser();

    const refused = await changePassword(
      user.cookie,
      `${TEST_PASSWORD}-wrong`,
      generateTemporaryPassword(),
    );
    expect(refused.status).toBeGreaterThanOrEqual(400);

    // A later successful change proves the hooks of the earlier request have run:
    // exactly one call in total means the refused one sent nothing.
    const ok = await changePassword(user.cookie, TEST_PASSWORD, generateTemporaryPassword());
    expect(ok.status).toBe(200);
    await vi.waitFor(() => {
      expect(callsFor(user.userId)).toHaveLength(1);
    });
  }, 60_000);

  it('a failed change (new password refused by the policy) sends none', async () => {
    const user = await newUser();

    const refused = await changePassword(user.cookie, TEST_PASSWORD, 'short');
    expect(refused.status).toBeGreaterThanOrEqual(400);

    const ok = await changePassword(user.cookie, TEST_PASSWORD, generateTemporaryPassword());
    expect(ok.status).toBe(200);
    await vi.waitFor(() => {
      expect(callsFor(user.userId)).toHaveLength(1);
    });
  }, 60_000);

  it('a change-password with no session sends none', async () => {
    const user = await newUser();

    const refused = await changePassword('', TEST_PASSWORD, generateTemporaryPassword());
    expect(refused.status).toBeGreaterThanOrEqual(400);

    const ok = await changePassword(user.cookie, TEST_PASSWORD, generateTemporaryPassword());
    expect(ok.status).toBe(200);
    await vi.waitFor(() => {
      expect(callsFor(user.userId)).toHaveLength(1);
    });
    expect(notify.mock.calls.filter(([, s]) => s.userId === '')).toEqual([]);
  }, 60_000);
});

/**
 * Task 7.2 of openspec/changes/044-password-reset-and-account-recovery (design D8,
 * "Hook points"). Spec scenario, quoted from
 * `specs/password-reset-and-account-recovery/spec.md`:
 *
 * #### Scenario: A second-factor change is announced
 * - WHEN a user verifies a new TOTP factor, regenerates their backup codes, or an admin resets their factor
 * - THEN the user receives the matching fixed notice
 *
 * This file covers enrolment and regeneration (the admin reset is task 10), and the case
 * "a sign-in challenge sends none".
 *
 * ## Production symbols expected
 *
 * - `auth.ts`: `AccountNoticeKind` widens to include `'MfaChangedNotice'`. `hooks.after`
 *   calls `accountNotices.notify('MfaChangedNotice', { userId })` exactly once for
 *   `/two-factor/verify-totp` when the request has a session and `hooks.before` recorded
 *   `twoFactorEnabled` as not true, and exactly once for a successful
 *   `/two-factor/generate-backup-codes`. Never on the sign-in challenge (no session),
 *   never on a refused call.
 */
describe('A second-factor change is announced (task 7.2, D8)', () => {
  let db: TestDb;
  let auth: AuthInstance;
  const notify = vi.fn<RecordingNotices['notify']>(() => Promise.resolve());

  beforeAll(async () => {
    db = connect(databaseUrl());
    await runMigrations(db.$client);
    const options = {
      db,
      secret: TEST_SECRET,
      accountNotices: { notify },
    } as unknown as CreateAuthOptions;
    auth = createAuth(options);
  }, 60_000);

  afterAll(async () => {
    await endQuietly(db.$client);
  });

  interface TwoFactorApi {
    enableTwoFactor(args: {
      body: { password: string; method: 'totp' };
      headers: Headers;
    }): Promise<{ totpURI: string; backupCodes: readonly string[] }>;
    generateTOTP(args: { body: { secret: string } }): Promise<{ code: string }>;
  }

  function twoFactorApi(): TwoFactorApi {
    return auth.api as TwoFactorApi;
  }

  const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  /** The raw HMAC secret, from the Base32 `secret` parameter of the TOTP URI. */
  function rawSecretFromUri(totpURI: string): string {
    const param = new URL(totpURI).searchParams.get('secret');
    if (param === null) {
      throw new Error('expected a secret query parameter on the TOTP URI');
    }
    const bytes: number[] = [];
    let buffer = 0;
    let bits = 0;
    for (const char of param) {
      const value = BASE32.indexOf(char.toUpperCase());
      if (value === -1) {
        break;
      }
      buffer = (buffer << 5) | value;
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((buffer >> bits) & 0xff);
      }
    }
    return new TextDecoder().decode(Uint8Array.from(bytes));
  }

  async function newUser(): Promise<{ userId: string; email: string; cookie: string }> {
    const email = `account-notice-mfa-${randomUUID()}@example.test`;
    const tenant = await bootstrapTestTenant(auth, {
      pool: testAppPool(),
      name: 'Account Notice MFA User',
      email,
      password: TEST_PASSWORD,
      organizationName: 'Account Notice MFA Org',
      organizationSlug: `account-notice-mfa-${randomUUID()}`,
      ip: randomIp(),
    });
    const signedIn = await signInAdminUser(auth, {
      email,
      password: TEST_PASSWORD,
      ip: randomIp(),
    });
    return { userId: tenant.userId, email, cookie: signedIn.cookie };
  }

  function post(path: string, cookie: string, body: Record<string, unknown>): Promise<Response> {
    return handlerOf(auth)(
      new Request(`${AUTH_BASE_URL}${path}`, {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
          'x-forwarded-for': randomIp(),
          origin: 'http://localhost:3000',
        },
        body: JSON.stringify(body),
      }),
    );
  }

  /** Starts enrolment (`/two-factor/enable`): the factor is not yet verified. */
  async function startEnrolment(
    cookie: string,
  ): Promise<{ secret: string; backupCodes: readonly string[] }> {
    const enabled = await twoFactorApi().enableTwoFactor({
      body: { password: TEST_PASSWORD, method: 'totp' },
      headers: new Headers({ cookie }),
    });
    return { secret: rawSecretFromUri(enabled.totpURI), backupCodes: enabled.backupCodes };
  }

  async function currentCode(secret: string): Promise<string> {
    return (await twoFactorApi().generateTOTP({ body: { secret } })).code;
  }

  function mfaCallsFor(userId: string): readonly (readonly [string, { userId: string }])[] {
    return notify.mock.calls.filter(
      ([kind, subject]) => subject.userId === userId && kind === 'MfaChangedNotice',
    );
  }

  function allCallsFor(userId: string): readonly (readonly [string, { userId: string }])[] {
    return notify.mock.calls.filter(([, subject]) => subject.userId === userId);
  }

  function cookieFrom(response: Response): string {
    return response.headers
      .getSetCookie()
      .map((raw) => raw.split(';')[0])
      .join('; ');
  }

  /**
   * A live session carrying a fresh MFA verification (002 Q52): Better Auth rotates the
   * session on a first TOTP verification, so the enrolment cookie is dead afterwards.
   * Signs in (challenged) and completes the TOTP challenge; neither sends a notice.
   */
  async function freshMfaCookie(email: string, secret: string): Promise<string> {
    const challenge = await post('/sign-in/email', '', { email, password: TEST_PASSWORD });
    expect(challenge.status).toBe(200);
    const verified = await post('/two-factor/verify-totp', cookieFrom(challenge), {
      code: await currentCode(secret),
    });
    expect(verified.status).toBe(200);
    return cookieFrom(verified);
  }

  async function enrolledUser(): Promise<{
    userId: string;
    email: string;
    cookie: string;
    secret: string;
  }> {
    const user = await newUser();
    const { secret } = await startEnrolment(user.cookie);
    const verified = await post('/two-factor/verify-totp', user.cookie, {
      code: await currentCode(secret),
    });
    expect(verified.status).toBe(200);
    await vi.waitFor(() => {
      expect(mfaCallsFor(user.userId)).toHaveLength(1);
    });
    return { ...user, secret };
  }

  it('verifying a new TOTP factor with a session sends exactly one MfaChangedNotice to that user', async () => {
    const user = await newUser();
    const { secret } = await startEnrolment(user.cookie);
    expect(allCallsFor(user.userId), 'starting enrolment sends none').toEqual([]);

    const response = await post('/two-factor/verify-totp', user.cookie, {
      code: await currentCode(secret),
    });
    expect(response.status).toBe(200);

    await vi.waitFor(() => {
      expect(mfaCallsFor(user.userId)).toHaveLength(1);
    });
    const [kind, subject] = mfaCallsFor(user.userId)[0] ?? ['', { userId: '' }];
    expect(kind).toBe('MfaChangedNotice');
    expect(subject).toEqual({ userId: user.userId });
    expect(allCallsFor(user.userId)).toHaveLength(1);
  }, 60_000);

  it('a refused enrolment verification (wrong code) sends none', async () => {
    const user = await newUser();
    const { secret } = await startEnrolment(user.cookie);

    const refused = await post('/two-factor/verify-totp', user.cookie, { code: '000000' });
    expect(refused.status).toBeGreaterThanOrEqual(400);

    // A later good verification proves the refused one's hooks have run.
    const ok = await post('/two-factor/verify-totp', user.cookie, {
      code: await currentCode(secret),
    });
    expect(ok.status).toBe(200);
    await vi.waitFor(() => {
      expect(mfaCallsFor(user.userId)).toHaveLength(1);
    });
    expect(allCallsFor(user.userId)).toHaveLength(1);
  }, 60_000);

  it('regenerating the backup codes sends exactly one MfaChangedNotice to that user', async () => {
    const user = await enrolledUser();
    const mfaCookie = await freshMfaCookie(user.email, user.secret);

    const response = await post('/two-factor/generate-backup-codes', mfaCookie, {
      password: TEST_PASSWORD,
    });
    expect(response.status).toBe(200);

    await vi.waitFor(() => {
      expect(mfaCallsFor(user.userId)).toHaveLength(2);
    });
    const [kind, subject] = mfaCallsFor(user.userId)[1] ?? ['', { userId: '' }];
    expect(kind).toBe('MfaChangedNotice');
    expect(subject).toEqual({ userId: user.userId });
    expect(allCallsFor(user.userId)).toHaveLength(2);
  }, 60_000);

  it('a refused backup-code regeneration (wrong password) sends none', async () => {
    const user = await enrolledUser();
    const mfaCookie = await freshMfaCookie(user.email, user.secret);

    const refused = await post('/two-factor/generate-backup-codes', mfaCookie, {
      password: `${TEST_PASSWORD}-wrong`,
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);

    const ok = await post('/two-factor/generate-backup-codes', mfaCookie, {
      password: TEST_PASSWORD,
    });
    expect(ok.status).toBe(200);
    await vi.waitFor(() => {
      expect(mfaCallsFor(user.userId)).toHaveLength(2);
    });
    expect(allCallsFor(user.userId)).toHaveLength(2);
  }, 60_000);

  it('a sign-in challenge (TOTP) sends none', async () => {
    const user = await enrolledUser();
    const before = allCallsFor(user.userId).length;

    const challenge = await post('/sign-in/email', '', {
      email: user.email,
      password: TEST_PASSWORD,
    });
    expect(challenge.status).toBe(200);
    const challengeCookie = challenge.headers
      .getSetCookie()
      .map((raw) => raw.split(';')[0])
      .join('; ');

    const verified = await post('/two-factor/verify-totp', challengeCookie, {
      code: await currentCode(user.secret),
    });
    expect(verified.status).toBe(200);

    // A later regeneration (one more notice) proves the challenge's hooks have run.
    const regenerated = await post('/two-factor/generate-backup-codes', cookieFrom(verified), {
      password: TEST_PASSWORD,
    });
    expect(regenerated.status).toBe(200);
    await vi.waitFor(() => {
      expect(allCallsFor(user.userId)).toHaveLength(before + 1);
    });
    expect(mfaCallsFor(user.userId)).toHaveLength(2);
  }, 60_000);

  it('a sign-in challenge (backup code) sends none', async () => {
    const user = await newUser();
    const { secret, backupCodes } = await startEnrolment(user.cookie);
    const verified = await post('/two-factor/verify-totp', user.cookie, {
      code: await currentCode(secret),
    });
    expect(verified.status).toBe(200);
    await vi.waitFor(() => {
      expect(mfaCallsFor(user.userId)).toHaveLength(1);
    });
    const backupCode = backupCodes[0];
    if (backupCode === undefined) {
      throw new Error('expected at least one backup code from enrolment');
    }

    const challenge = await post('/sign-in/email', '', {
      email: user.email,
      password: TEST_PASSWORD,
    });
    expect(challenge.status).toBe(200);
    const challengeCookie = challenge.headers
      .getSetCookie()
      .map((raw) => raw.split(';')[0])
      .join('; ');
    const used = await post('/two-factor/verify-backup-code', challengeCookie, {
      code: backupCode,
    });
    expect(used.status).toBe(200);

    const mfaCookie = await freshMfaCookie(user.email, secret);
    const regenerated = await post('/two-factor/generate-backup-codes', mfaCookie, {
      password: TEST_PASSWORD,
    });
    expect(regenerated.status).toBe(200);
    await vi.waitFor(() => {
      expect(allCallsFor(user.userId)).toHaveLength(2);
    });
    expect(mfaCallsFor(user.userId)).toHaveLength(2);
  }, 60_000);
});
