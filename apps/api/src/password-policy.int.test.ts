/**
 * Task 8.1c of openspec/changes/archive/2026-10-14-043-identity-lifecycle-and-org-admin (design Q22,
 * Q132; spec "Password policy", scenario "A short password is refused" and the
 * requirement that `/change-password` sets only a policy-compliant password).
 *
 * ## Production symbols expected
 *
 * - `packages/auth/src/auth.ts`: `createAuth` sets `emailAndPassword.minPasswordLength`
 *   to 20 and `emailAndPassword.maxPasswordLength` to 256 (UTF-16 units, so a
 *   compliant 128-code-point password of astral characters is never rejected by
 *   Better Auth's own bound), and its top-level `hooks.before` runs
 *   `validatePassword` (`packages/auth/src/identity/password-policy.ts`, existing)
 *   on `newPassword` of `/change-password`, refusing a non-compliant one with a 400
 *   before anything is written.
 * - `apps/api/src/identity-router.ts`: `identity.users.create` applies
 *   `validatePassword` to the generated temporary password before
 *   `auth.api.createUser` (which enforces only the maximum length), so a password
 *   under 20 characters is refused and no user is created. The generator of the
 *   temporary password is the shared `generateTemporaryPassword()` of `@tayzu/auth`
 *   (Q136); it is mocked here, where `identity-router.ts` imports it (the other
 *   `@tayzu/auth` exports stay real), so a 19-character value can be fed in.
 *
 * The breached-password check is answered by the shared stub of task 8.1a.
 */
import { randomUUID } from 'node:crypto';

import { createRouterClient } from '@orpc/server';
import { authSchema, createAuth, type AuthInstance } from '@tayzu/auth';
import { createCerbosClient } from '@tayzu/authz';
import { runMigrations } from '@tayzu/db';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { harnessPools } from './__fixtures__/pools.js';
import { createAuthRepository } from './identity/auth-repository.js';
import { createWithUserLock } from './identity/user-lock.js';
import { createIdentityRouter } from './identity-router.js';
import { createAdminUser } from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { COMMON_PASSWORD_DENYLIST } from '../../../packages/auth/src/identity/common-passwords.js';
import {
  validatePassword,
  type PasswordRule,
} from '../../../packages/auth/src/identity/password-policy.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';

const AUTH_BASE_URL = 'http://localhost:3000/api/auth';

/** 19 characters (code points), base64url-safe, meeting every other rule. */
const SHORT_PASSWORD = `Ab1-${'c'.repeat(14)}E`;

const ALL_RULES: readonly PasswordRule[] = [
  'length',
  'uppercase',
  'lowercase',
  'digit',
  'symbol',
  'character',
  'denylist',
];

const state: { forced: string | undefined } = { forced: undefined };

vi.mock('@tayzu/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tayzu/auth')>();
  return {
    ...actual,
    generateTemporaryPassword: (): string => state.forced ?? actual.generateTemporaryPassword(),
  };
});

const COMPLIANT_NEW = 'Fresh-Compliant-Passphrase-2026!';
/**
 * 128 astral code points (256 UTF-16 units), the longest compliant password: an
 * astral upper-case letter, lower-case letter, digit and symbol, then 124 symbols.
 */
const ASTRAL_128 = '\u{1D400}\u{1D41A}\u{1D7CF}\u{1F600}' + '\u{1F600}'.repeat(124);

function denylistedPassword(): string {
  const entry = COMMON_PASSWORD_DENYLIST.find(
    (candidate) =>
      Array.from(candidate).length >= 20 &&
      Array.from(candidate).length <= 128 &&
      /[a-z]/.test(candidate) &&
      /\d/.test(candidate) &&
      /[^a-z\d]/.test(candidate),
  );
  if (entry === undefined) throw new Error('no usable denylist entry');
  return entry.replace(/[a-z]/, (letter) => letter.toUpperCase());
}

function randomIp(): string {
  const octet = (): number => Math.floor(Math.random() * 250) + 1;
  return `${String(octet())}.${String(octet())}.${String(octet())}.${String(octet())}`;
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

interface CreateOrganizationSurface {
  createOrganization(args: {
    body: { name: string; slug: string; userId: string };
  }): Promise<{ id: string }>;
}

describe('The password policy on Better Auth routes (task 8.1c, design Q22)', () => {
  let authPool: Pool;
  let auth: AuthInstance;
  let client: ReturnType<
    typeof createRouterClient<ReturnType<typeof createIdentityRouter>, Record<string, unknown>>
  >;

  beforeAll(async () => {
    const pools = await harnessPools();
    authPool = pools.authPool;
    await runMigrations(authPool);
    auth = createAuth({ db: drizzle(authPool, { schema: authSchema }), secret: TEST_SECRET });
    const cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    client = createRouterClient(
      createIdentityRouter({
        auth,
        authz: cerbos,
        authRepository: createAuthRepository(authPool),
        withUserLock: createWithUserLock(authPool),
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );
  }, 60_000);

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

  async function signedInUser(): Promise<{ email: string; cookie: string }> {
    const email = `policy-${randomUUID()}@example.test`;
    await createAdminUser(auth, { name: 'Policy User', email, password: TEST_PASSWORD });
    const response = await post('/sign-in/email', { email, password: TEST_PASSWORD });
    expect(response.status, 'the fixture user signs in').toBe(200);
    const cookie = response.headers
      .getSetCookie()
      .map((raw) => raw.split(';')[0])
      .join('; ');
    return { email, cookie };
  }

  async function canSignIn(email: string, password: string): Promise<boolean> {
    const response = await post('/sign-in/email', { email, password });
    return response.status === 200;
  }

  async function freshTenantId(): Promise<string> {
    const id = randomUUID();
    const owner = await createAdminUser(auth, {
      name: 'Tenant Owner',
      email: `owner-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    const org = await (auth.api as CreateOrganizationSurface).createOrganization({
      body: { name: 'Policy Org', slug: `policy-${id}`, userId: owner.userId },
    });
    return org.id;
  }

  async function countUsers(email: string): Promise<number> {
    const result = await drizzle(authPool, { schema: authSchema }).execute<{ count: string }>(sql`
      select count(*)::text as count from auth."user" where email = ${email}
    `);
    return Number(result.rows[0]?.count ?? '0');
  }

  it('/change-password refuses a 19-character password that meets every other rule', async () => {
    const { email, cookie } = await signedInUser();
    expect(validatePassword(SHORT_PASSWORD)).toEqual({ ok: false, rule: 'length' });
    expect(Array.from(SHORT_PASSWORD)).toHaveLength(19);

    const response = await post(
      '/change-password',
      { currentPassword: TEST_PASSWORD, newPassword: SHORT_PASSWORD },
      cookie,
    );

    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(SHORT_PASSWORD);
    expect(await canSignIn(email, TEST_PASSWORD), 'the old password still works').toBe(true);
    expect(await canSignIn(email, SHORT_PASSWORD), 'the short password was not set').toBe(false);
  });

  it('/change-password refuses a denylisted password', async () => {
    const { email, cookie } = await signedInUser();
    const denylisted = denylistedPassword();
    expect(validatePassword(denylisted), 'the fixture meets every rule but the denylist').toEqual({
      ok: false,
      rule: 'denylist',
    });

    const response = await post(
      '/change-password',
      { currentPassword: TEST_PASSWORD, newPassword: denylisted },
      cookie,
    );

    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(denylisted);
    expect(await canSignIn(email, TEST_PASSWORD), 'the old password still works').toBe(true);
    expect(await canSignIn(email, denylisted), 'the denylisted password was not set').toBe(false);
  });

  it('/change-password accepts a compliant password', async () => {
    const { email, cookie } = await signedInUser();
    expect(validatePassword(COMPLIANT_NEW).ok).toBe(true);

    const response = await post(
      '/change-password',
      { currentPassword: TEST_PASSWORD, newPassword: COMPLIANT_NEW },
      cookie,
    );

    expect(response.status).toBe(200);
    expect(await canSignIn(email, COMPLIANT_NEW), 'the new password is set').toBe(true);
    expect(await canSignIn(email, TEST_PASSWORD), 'the old password is gone').toBe(false);
  });

  it('/change-password accepts a compliant password of 128 astral code points (256 UTF-16 units)', async () => {
    const { email, cookie } = await signedInUser();
    expect(Array.from(ASTRAL_128)).toHaveLength(128);
    expect(ASTRAL_128).toHaveLength(256);
    expect(validatePassword(ASTRAL_128).ok).toBe(true);

    const response = await post(
      '/change-password',
      { currentPassword: TEST_PASSWORD, newPassword: ASTRAL_128 },
      cookie,
    );

    expect(response.status, "Better Auth's own bounds never reject a compliant password").toBe(200);
    expect(await canSignIn(email, ASTRAL_128), 'the new password is set').toBe(true);
  });

  // Task 16.12e (Resolved decisions Q136, Q149): the refusal names only the failed rule.
  const RULE_CASES: readonly { rule: PasswordRule; password: string }[] = [
    { rule: 'length', password: SHORT_PASSWORD },
    { rule: 'uppercase', password: `${'a'.repeat(8)}1-${'b'.repeat(15)}` },
    { rule: 'lowercase', password: `${'A'.repeat(8)}1-${'B'.repeat(15)}` },
    { rule: 'digit', password: `A${'b'.repeat(7)}-${'c'.repeat(16)}` },
    { rule: 'symbol', password: `A${'b'.repeat(7)}1${'c'.repeat(16)}` },
    { rule: 'character', password: 'Fresh-Compliant​-Passphrase-2026!' },
    { rule: 'denylist', password: denylistedPassword() },
  ];

  it.each(RULE_CASES)(
    '/change-password refusal for the $rule rule names that rule and never echoes the password',
    async ({ rule, password }) => {
      const { email, cookie } = await signedInUser();
      expect(validatePassword(password), 'the fixture fails exactly this rule').toEqual({
        ok: false,
        rule,
      });

      const response = await post(
        '/change-password',
        { currentPassword: TEST_PASSWORD, newPassword: password },
        cookie,
      );
      const text = await response.text();

      expect(response.status).toBe(400);
      expect(text).toContain('PASSWORD_POLICY_VIOLATION');
      expect(text, 'the failed rule is named').toContain(rule);
      for (const other of ALL_RULES.filter((candidate) => candidate !== rule)) {
        expect(text, `the passing rule ${other} is not named`).not.toContain(other);
      }
      expect(text).not.toContain(password);
      expect(await canSignIn(email, TEST_PASSWORD), 'the old password still works').toBe(true);
    },
  );

  it('identity.users.create refuses a 19-character password and creates no user', async () => {
    const tenantId = await freshTenantId();
    const email = `short-${randomUUID()}@example.test`;
    state.forced = SHORT_PASSWORD;
    try {
      const error = await caught(
        client.identity.users.create(
          { body: { email, name: 'Short Password', role: 'member' } },
          {
            context: {
              tenantId,
              actor: { type: 'user', id: `admin-${randomUUID()}` },
              principal: { roles: ['admin'] },
            },
          },
        ),
      );

      expect(error, 'the 19-character password is refused').toBeDefined();
      expect(JSON.stringify(error)).not.toContain(SHORT_PASSWORD);
      expect(await countUsers(email), 'no user is created').toBe(0);
    } finally {
      state.forced = undefined;
    }
  }, 60_000);
});
