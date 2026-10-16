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
