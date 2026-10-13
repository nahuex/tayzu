/**
 * Task 13.5 of openspec/changes/043-identity-lifecycle-and-org-admin (design D13,
 * Resolved decision Q36). Spec scenario, quoted from
 * `specs/identity-lifecycle-and-org-admin/spec.md`:
 *
 * #### Scenario: A temporary password grants only a password change
 * - GIVEN a user created with a temporary password
 * - WHEN they sign in with it
 * - THEN the session reaches only the change-password route until they set a
 *   policy-compliant password, and the temporary password expires if not changed
 *
 * The task's Verify clause: a temporary password grants only the change-password
 * route, `/sign-out` and `/get-session` on both `/v1` (where only the change is
 * reachable) and `/api/auth/*`, and changing it clears the marker. The expiry
 * blocking sign-in is 13.5d's, not covered here.
 *
 * The marker is a row in `auth.verification` with identifier
 * `temp-password:<userId>` and `expiresAt` equal to the expiry. These tests write it
 * directly (the creation paths that write it are other tasks').
 *
 * ## Production symbols expected
 *
 * - `auth.ts`: a session-aware `hooks.before` that, for a session whose user holds
 *   an unexpired marker, lets only `/change-password`, `/sign-out` and
 *   `/get-session` through on `/api/auth/*` (any other route is refused with a
 *   client error), and an after-hook / endpoint path that deletes the marker row
 *   when `/change-password` succeeds.
 * - `context-resolver.ts`: `createContextResolver(...)` rejects with
 *   `CATALOG_CONTEXT_REQUIRED` for such a session (the only `/v1` route reachable
 *   under a marker is none: the change itself is an `/api/auth` route).
 *
 * ## Harness
 *
 * `auth.handler(new Request(...))` with a fresh random `x-forwarded-for` per request;
 * a fresh random tenant and user per test.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { runMigrations } from '@tayzu/db';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Import order is load-bearing (design D1): the harness registers before `./auth.js`.
import './__fixtures__/registered-harness.js';
import { bootstrapTestTenant, signInAdminUser, testAppPool } from './__fixtures__/admin-user.js';
import { TEST_PASSWORD, TEST_SECRET } from './__fixtures__/test-secret.js';
import { createAuth, type AuthInstance } from './auth.js';
import { createContextResolver } from './context-resolver.js';
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

function cookieHeaderFrom(response: Response, fallback: string): string {
  const cookies = response.headers.getSetCookie().map((raw) => raw.split(';')[0]);
  return cookies.length === 0 ? fallback : cookies.join('; ');
}

describe('A temporary password grants only a password change (task 13.5, D13, Q36)', () => {
  let db: TestDb;
  let auth: AuthInstance;
  let resolveContext: (headers: Headers) => Promise<unknown>;

  beforeAll(async () => {
    db = connect(databaseUrl());
    await runMigrations(db.$client);
    auth = createAuth({ db, secret: TEST_SECRET });
    const appPool = testAppPool();
    resolveContext = (
      createContextResolver as (options: {
        readonly auth: AuthInstance;
        readonly revocationPool: typeof appPool;
      }) => (headers: Headers) => Promise<unknown>
    )({ auth, revocationPool: appPool });
  }, 60_000);

  afterAll(async () => {
    await endQuietly(db.$client);
  });

  async function newUser(): Promise<{
    userId: string;
    email: string;
    tenantId: string;
    password: string;
  }> {
    const email = `temp-pw-${randomUUID()}@example.test`;
    const tenant = await bootstrapTestTenant(auth, {
      pool: testAppPool(),
      name: 'Temp Password User',
      email,
      password: TEST_PASSWORD,
      organizationName: 'Temp Password Org',
      organizationSlug: `temp-pw-${randomUUID()}`,
      ip: randomIp(),
    });
    return {
      userId: tenant.userId,
      email,
      tenantId: tenant.organizationId,
      password: TEST_PASSWORD,
    };
  }

  async function writeMarker(userId: string, expiresInMs: number): Promise<void> {
    await db.insert(authSchema.verification).values({
      id: randomUUID(),
      identifier: `temp-password:${userId}`,
      value: 'temporary-password',
      expiresAt: new Date(Date.now() + expiresInMs),
    });
  }

  async function markerCount(userId: string): Promise<number> {
    const result = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from auth.verification where identifier = ${`temp-password:${userId}`}`,
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  async function signIn(user: { email: string; password: string }): Promise<string> {
    const signedIn = await signInAdminUser(auth, {
      email: user.email,
      password: user.password,
      ip: randomIp(),
    });
    return signedIn.cookie;
  }

  function authRequest(
    path: string,
    cookie: string,
    method: 'GET' | 'POST',
    body?: unknown,
  ): Promise<Response> {
    return handlerOf(auth)(
      new Request(`${AUTH_BASE_URL}${path}`, {
        method,
        headers: {
          cookie,
          'x-forwarded-for': randomIp(),
          origin: 'http://localhost:3000',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }

  it('control: without a marker a session reaches the other routes and resolves on /v1', async () => {
    const user = await newUser();
    const cookie = await signIn(user);

    expect((await authRequest('/list-accounts', cookie, 'GET')).status).toBe(200);
    await expect(resolveContext(new Headers({ cookie }))).resolves.toMatchObject({
      tenantId: user.tenantId,
      actor: { type: 'user', id: user.userId },
    });
  }, 60_000);

  it('/api/auth/*: a session under an unexpired marker reaches /get-session, and every other route is refused', async () => {
    const user = await newUser();
    await writeMarker(user.userId, 60 * 60 * 1000);
    const cookie = await signIn(user);

    const session = await authRequest('/get-session', cookie, 'GET');
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ user: { id: user.userId } });

    const listAccounts = await authRequest('/list-accounts', cookie, 'GET');
    expect(listAccounts.status, 'list-accounts is refused under a marker').toBeGreaterThanOrEqual(
      400,
    );
    expect(listAccounts.status).toBeLessThan(500);

    const setActive = await authRequest('/organization/set-active', cookie, 'POST', {
      organizationId: user.tenantId,
    });
    expect(setActive.status, 'set-active is refused under a marker').toBeGreaterThanOrEqual(400);
    expect(setActive.status).toBeLessThan(500);

    const verifyPassword = await authRequest('/verify-password', cookie, 'POST', {
      password: user.password,
    });
    expect(
      verifyPassword.status,
      'verify-password is refused under a marker',
    ).toBeGreaterThanOrEqual(400);
    expect(verifyPassword.status).toBeLessThan(500);

    expect(await markerCount(user.userId), 'refusals do not clear the marker').toBe(1);
  }, 60_000);

  it('/api/auth/*: a session under an unexpired marker can still sign out', async () => {
    const user = await newUser();
    await writeMarker(user.userId, 60 * 60 * 1000);
    const cookie = await signIn(user);

    const signOut = await authRequest('/sign-out', cookie, 'POST', {});
    expect(signOut.status).toBe(200);

    const after = await authRequest('/get-session', cookie, 'GET');
    expect(after.status).toBe(200);
    expect(await after.json(), 'the session no longer exists').toBeNull();
    expect(await markerCount(user.userId), 'sign-out does not clear the marker').toBe(1);
  }, 60_000);

  it('/v1: a session under an unexpired marker is rejected with CATALOG_CONTEXT_REQUIRED', async () => {
    const user = await newUser();
    await writeMarker(user.userId, 60 * 60 * 1000);
    const cookie = await signIn(user);

    await expect(resolveContext(new Headers({ cookie }))).rejects.toMatchObject({
      code: 'CATALOG_CONTEXT_REQUIRED',
    });
  }, 60_000);

  it('/api/auth/*: the change-password route is reachable, and changing the password clears the marker on both surfaces', async () => {
    const user = await newUser();
    await writeMarker(user.userId, 60 * 60 * 1000);
    const cookie = await signIn(user);
    await expect(resolveContext(new Headers({ cookie }))).rejects.toMatchObject({
      code: 'CATALOG_CONTEXT_REQUIRED',
    });

    const newPassword = generateTemporaryPassword();
    const changed = await authRequest('/change-password', cookie, 'POST', {
      currentPassword: user.password,
      newPassword,
    });
    expect(changed.status, 'change-password is reachable under a marker').toBe(200);
    expect(await markerCount(user.userId), 'the marker is cleared').toBe(0);

    const freshCookie = cookieHeaderFrom(changed, cookie);
    expect((await authRequest('/list-accounts', freshCookie, 'GET')).status).toBe(200);
    await expect(resolveContext(new Headers({ cookie: freshCookie }))).resolves.toMatchObject({
      tenantId: user.tenantId,
      actor: { type: 'user', id: user.userId },
    });
  }, 60_000);

  it('a refused change-password (wrong current password) does not clear the marker', async () => {
    const user = await newUser();
    await writeMarker(user.userId, 60 * 60 * 1000);
    const cookie = await signIn(user);

    const refused = await authRequest('/change-password', cookie, 'POST', {
      currentPassword: `${user.password}-wrong`,
      newPassword: generateTemporaryPassword(),
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(await markerCount(user.userId)).toBe(1);
  }, 60_000);

  /**
   * Task 13.5d (Resolved decisions Q36, Q97, design D13): an expired marker blocks
   * sign-in with the uniform failure.
   *
   * Production symbols expected: a `hooks.after` on `/sign-in/email` in `auth.ts`
   * (the one of task 13.4b) that, when the sign-in succeeded and the user holds an
   * expired marker, deletes the session just created and RETURNS a `Response` with
   * the wrong password's status, error code and body, without the session
   * `Set-Cookie`.
   */
  describe('an expired temporary-password marker blocks sign-in (task 13.5d)', () => {
    const SIGN_IN_URL = `${AUTH_BASE_URL}/sign-in/email`;

    function postSignIn(email: string, password: string): Promise<Response> {
      return handlerOf(auth)(
        new Request(SIGN_IN_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': randomIp() },
          body: JSON.stringify({ email, password }),
        }),
      );
    }

    async function sessionCount(userId: string): Promise<number> {
      const result = await db.execute<{ n: string }>(
        sql`select count(*)::text as n from auth.session where user_id = ${userId}`,
      );
      return Number(result.rows[0]?.n ?? 0);
    }

    async function clearSessions(userId: string): Promise<void> {
      await db.execute(sql`delete from auth.session where user_id = ${userId}`);
    }

    function sessionCookies(response: Response): string[] {
      return response.headers
        .getSetCookie()
        .filter((raw) => raw.includes('session_token') && !/=\s*;/.test(raw));
    }

    it('the correct temporary password after the marker expired answers exactly like a wrong password, with no session and no cookie', async () => {
      const user = await newUser();
      await clearSessions(user.userId);
      await writeMarker(user.userId, -60 * 1000);

      const wrong = await postSignIn(user.email, `${user.password}-wrong`);
      const expired = await postSignIn(user.email, user.password);

      expect(wrong.status).toBeGreaterThanOrEqual(400);
      expect(expired.status, "the HTTP response's own status").toBe(wrong.status);
      const wrongBody = (await wrong.json()) as { code?: string; message?: string };
      const expiredBody = (await expired.json()) as { code?: string; message?: string };
      expect(expiredBody.code).toBe(wrongBody.code);
      expect(expiredBody).toEqual(wrongBody);
      expect(sessionCookies(expired), 'no session cookie is set').toEqual([]);
      expect(await sessionCount(user.userId), 'no session row remains').toBe(0);
    }, 60_000);

    it('the user can sign in again after an admin sets a new temporary password', async () => {
      const user = await newUser();
      await clearSessions(user.userId);
      await writeMarker(user.userId, -60 * 1000);
      expect((await postSignIn(user.email, user.password)).status).toBeGreaterThanOrEqual(400);

      // Better Auth's admin middleware needs a session whose user has the admin role.
      const adminEmail = `temp-pw-admin-${randomUUID()}@example.test`;
      const adminApi = auth.api as {
        createUser(args: {
          body: { name: string; email: string; password: string; role: 'admin' };
        }): Promise<unknown>;
        addMember(args: {
          body: { userId: string; organizationId: string; role: 'admin' };
        }): Promise<unknown>;
        setUserPassword(args: {
          body: { userId: string; newPassword: string };
          headers: Headers;
        }): Promise<unknown>;
      };
      const createdAdmin = (await adminApi.createUser({
        body: {
          name: 'Temp Password Admin',
          email: adminEmail,
          password: TEST_PASSWORD,
          role: 'admin',
        },
      })) as { user: { id: string } };
      await adminApi.addMember({
        body: { userId: createdAdmin.user.id, organizationId: user.tenantId, role: 'admin' },
      });
      const adminSession = await signInAdminUser(auth, {
        email: adminEmail,
        password: TEST_PASSWORD,
        ip: randomIp(),
      });

      const newTemporary = generateTemporaryPassword();
      await adminApi.setUserPassword({
        body: { userId: user.userId, newPassword: newTemporary },
        headers: new Headers({ cookie: adminSession.cookie }),
      });
      await db.execute(
        sql`delete from auth.verification where identifier = ${`temp-password:${user.userId}`}`,
      );
      await writeMarker(user.userId, 60 * 60 * 1000);

      const signedIn = await postSignIn(user.email, newTemporary);
      expect(signedIn.status).toBe(200);
      expect(await sessionCount(user.userId)).toBe(1);
    }, 60_000);
  });
});
