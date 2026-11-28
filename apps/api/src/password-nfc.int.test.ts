/**
 * Task 8.1d of openspec/changes/archive/2026-10-14-043-identity-lifecycle-and-org-admin (design Q22,
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

import { createRouterClient } from '@orpc/server';
import { authSchema, createAuth, createRecordingEmailSender, type AuthInstance } from '@tayzu/auth';
import { createCerbosClient } from '@tayzu/authz';
import { createUserSync } from '@tayzu/catalog';
import { runMigrations } from '@tayzu/db';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool as PgPool, type Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { main as bootstrapMain } from '../scripts/bootstrap-admin.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createAcceptFlow } from './identity/accept-flow.js';
import { createAuthRepository } from './identity/auth-repository.js';
import { runWithIdentityContext } from './identity/identity-context.js';
import { createResetTokenStore } from './identity/reset-token-store.js';
import { createUserSyncAdapter } from './identity/user-sync-adapter.js';
import { createWithUserLock } from './identity/user-lock.js';
import { createIdentityRouter } from './identity-router.js';
import { createApp, type App } from './server.js';
import {
  bootstrapTestTenant,
  testAppPool,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import {
  digestInvitationToken,
  generateInvitationToken,
} from '../../../packages/auth/src/identity/invitation-token.js';
import { needsRehash } from '../../../packages/auth/src/password-hash.js';

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

/**
 * Task 5.3 of openspec/changes/048-production-hardening (design D5, Q8): every path that sets a
 * password uses the platform hash. Scenarios of
 * `specs/password-reset-and-account-recovery/spec.md`, quoted:
 *
 * - "A new password is stored in the current format": WHEN a password is set through acceptance,
 *   user creation, the bootstrap, `/change-password` or a reset; THEN the stored hash names scrypt
 *   with `N = 2^15`, `r = 8` and `p = 3` and verifies at sign-in.
 * - "The reset stores the platform's current hash format": WHEN a reset completes with a compliant
 *   password; THEN the stored hash of the `credential` account is in the platform's current
 *   self-describing format with the current cost parameters.
 *
 * Design D5 "Format": `$scrypt$ln=<log2 N>,r=<r>,p=<p>$<salt>$<key>`, the salt (16 bytes) and the
 * 64-byte key in standard base64 without padding, so the current format is
 * `$scrypt$ln=15,r=8,p=3$<22 characters>$<86 characters>`.
 *
 * ## Production symbols expected
 *
 * - `packages/auth/src/auth.ts`: `emailAndPassword.password` is `{ hash: hashPassword, verify:
 *   verifyPassword }` of `./password-hash.ts`, so acceptance, `identity.users.create`, the bootstrap
 *   and `/change-password` (all of which reach Better Auth's configured `password.hash`) write it.
 * - `hashPasswordNfc` (the reset's name, `apps/api/src/identity/password-reset-confirm.ts`) is an
 *   alias of the new `hashPassword`.
 *
 * Every path reads the stored `auth.account.password` of the `credential` account.
 *
 * ## Why this is expected to fail for the right reason right now
 *
 * `emailAndPassword.password.hash` and the reset both still write Better Auth's legacy
 * `salt:key` hex format: each format assertion is an assertion failure, while every set-up step
 * (and each sign-in with the new password) already works.
 */
describe('Every path that sets a password uses the platform hash (048 task 5.3, design D5)', () => {
  /** design D5 "Format", the current cost: N = 2^15, r = 8, p = 3. */
  const CURRENT_PLATFORM_FORMAT = /^\$scrypt\$ln=15,r=8,p=3\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{86}$/;
  const CERBOS_ADDRESS = 'localhost:3593';
  const OPERATOR_ID = 'gh:515151';
  const ORIGIN = 'https://app.tayzu.test';
  const LINK_BASE_URL = 'https://app.tayzu.test';
  const CONFIRM_PATH = '/v1/auth/password-reset/confirm';
  const HMAC_SECRET = 'password-format-test-only-secret-0123456789-abcdef';

  let authPool: Pool;
  let appPool: Pool;
  let auth: AuthInstance;
  let acceptAuth: AuthInstance;
  let acceptFlow: ReturnType<typeof createAcceptFlow>;
  let identity: ReturnType<
    typeof createRouterClient<ReturnType<typeof createIdentityRouter>, Record<string, unknown>>
  >;
  let app: App;
  let bootstrapAppPool: PgPool;
  let bootstrapAuthPool: PgPool;

  /** A pool whose every connection runs as `role` (a fixed literal, never input), as `bootstrap-admin.int.test.ts`. */
  function poolAs(role: 'tayzu_app' | 'tayzu_auth'): PgPool {
    const pool = new PgPool({ connectionString: process.env.DATABASE_URL });
    const statement = role === 'tayzu_app' ? 'SET ROLE tayzu_app' : 'SET ROLE tayzu_auth';
    pool.on('connect', (client) => {
      void client.query(statement).catch(() => undefined);
    });
    pool.on('error', () => undefined);
    return pool;
  }

  beforeAll(async () => {
    const pools = await harnessPools();
    authPool = pools.authPool;
    appPool = pools.appPool;
    await runMigrations(authPool);
    const cerbos = createCerbosClient({ address: CERBOS_ADDRESS, tls: false });

    auth = createAuth({ db: drizzle(authPool, { schema: authSchema }), secret: TEST_SECRET });
    identity = createRouterClient(
      createIdentityRouter({
        auth,
        authz: cerbos,
        authRepository: createAuthRepository(authPool),
        withUserLock: createWithUserLock(authPool),
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );

    // The acceptance's membership hook writes the `_user` through the user-sync adapter.
    const adapter = createUserSyncAdapter({
      userSync: createUserSync({ pool: appPool, authz: cerbos }),
    });
    acceptAuth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync: adapter,
    });
    acceptFlow = createAcceptFlow({
      auth: acceptAuth,
      authz: cerbos,
      authRepository: createAuthRepository(authPool),
      authPool,
      userSync: adapter,
    });

    app = await createApp({
      appPool,
      authPool,
      authSecret: TEST_SECRET,
      cerbosAddress: CERBOS_ADDRESS,
      allowedOrigins: [ORIGIN],
      mountIdentityRoutes: true,
      identityTokenHmacSecret: HMAC_SECRET,
      email: {
        sender: createRecordingEmailSender(),
        invitationLinkBaseUrl: LINK_BASE_URL,
        passwordResetLinkBaseUrl: LINK_BASE_URL,
        passwordResetMinResponseMs: 0,
        disabledTenantIds: [] as string[],
        killSwitch: false,
        recipientKeySecret: HMAC_SECRET,
        tenantCap: { max: 1000, windowSeconds: 3600 },
        recipientCap: { max: 1000, windowSeconds: 86_400 },
        passwordResetRecipientCap: { max: 1000, windowSeconds: 3600 },
        passwordResetIpCap: { max: 1000, windowSeconds: 3600 },
        passwordResetGlobalCap: { max: 100_000, windowSeconds: 3600 },
        accountCreatedNoticeGlobalCap: { max: 100_000, windowSeconds: 86_400 },
      },
    });

    bootstrapAppPool = poolAs('tayzu_app');
    bootstrapAuthPool = poolAs('tayzu_auth');
  }, 120_000);

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
    await bootstrapAppPool.end();
    await bootstrapAuthPool.end();
  }, 60_000);

  async function storedHashByEmail(email: string): Promise<string> {
    const result = await authPool.query<{ password: string | null }>(
      `select a.password
         from auth.account a
         join auth."user" u on u.id = a.user_id
        where u.email = $1 and a.provider_id = 'credential'`,
      [email],
    );
    expect(result.rows, 'exactly one credential account').toHaveLength(1);
    return result.rows[0]?.password ?? '';
  }

  async function signInStatus(instance: AuthInstance, email: string, password: string) {
    const response = await (
      instance as unknown as { handler: (r: Request) => Promise<Response> }
    ).handler(
      new Request(`${AUTH_BASE_URL}/sign-in/email`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': randomIp(),
          origin: 'http://localhost:3000',
        },
        body: JSON.stringify({ email, password }),
      }),
    );
    return response.status;
  }

  /** A tenant with a signed-in admin, as `invitation-accept.int.test.ts` builds it. */
  async function freshTenant(instance: AuthInstance) {
    const id = randomUUID();
    const tenant = await bootstrapTestTenant(instance, {
      pool: testAppPool(),
      name: 'Format Admin',
      email: `format-admin-${id}@example.test`,
      password: TEST_PASSWORD,
      organizationName: 'Format Org',
      organizationSlug: `format-${id}`,
      ip: randomIp(),
    });
    return {
      tenantId: tenant.organizationId,
      adminId: tenant.userId,
      cookie: tenant.cookie,
      email: `format-admin-${id}@example.test`,
    };
  }

  it('A new password is stored in the current format: acceptance', async () => {
    const tenant = await freshTenant(acceptAuth);
    const email = `format-accept-${randomUUID()}@example.test`;
    const api = acceptAuth.api as {
      createInvitation(args: {
        body: { email: string; role: 'member'; organizationId: string };
        headers: Headers;
      }): Promise<{ id: string; expiresAt: Date | string }>;
    };
    const invitation = await runWithIdentityContext({ adminId: tenant.adminId }, () =>
      api.createInvitation({
        body: { email, role: 'member', organizationId: tenant.tenantId },
        headers: new Headers({ cookie: tenant.cookie, 'x-forwarded-for': randomIp() }),
      }),
    );
    const token = generateInvitationToken();
    await authPool.query(
      `insert into auth.verification (id, identifier, value, expires_at) values ($1, $2, $3, $4)`,
      [
        randomUUID(),
        `invitation-accept:${invitation.id}`,
        digestInvitationToken(token),
        new Date(invitation.expiresAt),
      ],
    );

    // WHEN a password is set through acceptance.
    await acceptFlow.accept({ invitationId: invitation.id, token, password: PASSWORD_NFC });

    // THEN the stored hash names scrypt with N = 2^15, r = 8 and p = 3 and verifies at sign-in.
    expect(await storedHashByEmail(email)).toMatch(CURRENT_PLATFORM_FORMAT);
    expect(await signInStatus(acceptAuth, email, PASSWORD_NFC)).toBe(200);
  }, 60_000);

  it('A new password is stored in the current format: user creation', async () => {
    const tenant = await freshTenant(auth);
    const email = `format-created-${randomUUID()}@example.test`;

    // WHEN a password is set through user creation (`identity.users.create`).
    const created = await identity.identity.users.create(
      { body: { email, name: 'Format Created', role: 'member' } },
      {
        context: {
          tenantId: tenant.tenantId,
          actor: { type: 'user', id: tenant.adminId },
          principal: { roles: ['admin'] },
        },
      },
    );

    // THEN the stored hash names scrypt with N = 2^15, r = 8 and p = 3 and verifies at sign-in.
    expect(await storedHashByEmail(email)).toMatch(CURRENT_PLATFORM_FORMAT);
    expect(await signInStatus(auth, email, created.temporaryPassword)).toBe(200);
  }, 60_000);

  it('A new password is stored in the current format: the bootstrap', async () => {
    const slug = `format-bootstrap-${randomUUID()}`;
    const email = `format-bootstrap-${randomUUID()}@example.test`;
    const printed: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(' '));
    });

    // WHEN a password is set through the bootstrap CLI.
    await bootstrapMain({
      env: {
        NODE_ENV: 'test',
        DATABASE_URL: process.env.DATABASE_URL ?? '',
        AUTH_DATABASE_URL: process.env.DATABASE_URL ?? '',
        BETTER_AUTH_SECRETS: `1:${TEST_SECRET}`,
        CERBOS_ADDRESS,
        ALLOWED_ORIGINS: 'http://localhost:3000',
        BOOTSTRAP_ORGANIZATION_NAME: 'Format Bootstrap Org',
        BOOTSTRAP_ORGANIZATION_SLUG: slug,
        BOOTSTRAP_ADMIN_NAME: 'Format Bootstrap Admin',
        BOOTSTRAP_ADMIN_EMAIL: email,
        TAYZU_OPERATOR_ID: OPERATOR_ID,
      },
      appPool: bootstrapAppPool,
      authPool: bootstrapAuthPool,
    });
    vi.restoreAllMocks();
    const marker = 'change it immediately: ';
    const line = printed.find((entry) => entry.includes(marker)) ?? '';
    const temporaryPassword = line.slice(line.indexOf(marker) + marker.length);
    expect(temporaryPassword.length, 'the CLI printed the temporary password').toBeGreaterThan(0);

    // THEN the stored hash names scrypt with N = 2^15, r = 8 and p = 3 and verifies at sign-in.
    expect(await storedHashByEmail(email)).toMatch(CURRENT_PLATFORM_FORMAT);
    expect(await signInStatus(auth, email, temporaryPassword)).toBe(200);
  }, 60_000);

  it('A new password is stored in the current format: /change-password', async () => {
    const email = `format-change-${randomUUID()}@example.test`;
    await (auth.api as CreateUserSurface).createUser({
      body: { name: 'Format Change', email, password: PASSWORD_NFC },
    });
    const handle = (auth as unknown as { handler: (r: Request) => Promise<Response> }).handler;
    const headers = {
      'content-type': 'application/json',
      'x-forwarded-for': randomIp(),
      origin: 'http://localhost:3000',
    };
    const signedIn = await handle(
      new Request(`${AUTH_BASE_URL}/sign-in/email`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ email, password: PASSWORD_NFC }),
      }),
    );
    expect(signedIn.status, 'the fixture user signs in').toBe(200);
    const cookie = signedIn.headers
      .getSetCookie()
      .map((raw) => raw.split(';')[0])
      .join('; ');

    // WHEN a password is set through `/change-password`.
    const response = await handle(
      new Request(`${AUTH_BASE_URL}/change-password`, {
        method: 'POST',
        headers: { ...headers, cookie },
        body: JSON.stringify({ currentPassword: PASSWORD_NFC, newPassword: COMPLIANT_NEW }),
      }),
    );
    expect(response.status).toBe(200);

    // THEN the stored hash names scrypt with N = 2^15, r = 8 and p = 3 and verifies at sign-in.
    expect(await storedHashByEmail(email)).toMatch(CURRENT_PLATFORM_FORMAT);
    expect(await signInStatus(auth, email, COMPLIANT_NEW)).toBe(200);
  }, 60_000);

  /** A reset completed through the real confirm route; the breach service reports nothing. */
  async function completeReset(newPassword: string): Promise<{ email: string; userId: string }> {
    const tenant = await freshTenant(app.auth);
    const issued = await createResetTokenStore({
      authPool,
      withUserLock: createWithUserLock(authPool),
    }).issue(tenant.adminId);
    stubRangeService([]);
    const response = await app.app.inject({
      method: 'POST',
      url: CONFIRM_PATH,
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        'x-csrf-token': 'orpc',
        'x-forwarded-for': randomIp(),
      },
      payload: JSON.stringify({ id: issued.id, token: issued.token, newPassword }),
    });
    vi.unstubAllGlobals();
    expect(response.statusCode, 'the reset completes').toBe(200);
    expect(response.json()).toEqual({ completed: true });
    return { email: tenant.email, userId: tenant.adminId };
  }

  it('A new password is stored in the current format: a reset', async () => {
    // WHEN a password is set through a reset.
    const { email } = await completeReset(COMPLIANT_NEW);

    // THEN the stored hash names scrypt with N = 2^15, r = 8 and p = 3 and verifies at sign-in.
    expect(await storedHashByEmail(email)).toMatch(CURRENT_PLATFORM_FORMAT);
    expect(await signInStatus(app.auth, email, COMPLIANT_NEW)).toBe(200);
  }, 60_000);

  it("The reset stores the platform's current hash format", async () => {
    // WHEN a reset completes with a compliant password.
    const { userId } = await completeReset(COMPLIANT_NEW);

    // THEN the stored hash of the `credential` account is in the platform's current
    // self-describing format with the current cost parameters.
    const result = await authPool.query<{ password: string | null }>(
      `select password from auth.account where user_id = $1 and provider_id = 'credential'`,
      [userId],
    );
    expect(result.rows).toHaveLength(1);
    const stored = result.rows[0]?.password ?? '';
    expect(stored).toMatch(CURRENT_PLATFORM_FORMAT);
    expect(needsRehash(stored), 'the current cost parameters').toBe(false);
  }, 60_000);
});
