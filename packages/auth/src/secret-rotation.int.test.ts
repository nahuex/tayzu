/**
 * Task 4.3 of `openspec/changes/048-production-hardening` (design D4, Q9;
 * `specs/auth-and-rbac/spec.md`, "Authentication secrets are versioned and
 * come only from the host").
 *
 * Spec scenario, quoted from the change's `specs/auth-and-rbac/spec.md`:
 *
 * #### Scenario: Encrypted data survives a rotation
 * - GIVEN a user whose TOTP factor was enrolled while version `1` was current
 * - WHEN the platform restarts with version `2` current and version `1` still listed
 * - THEN that user's TOTP code still verifies at sign-in
 *
 * The requirement text above it: "Data the library encrypts (second-factor
 * secrets, backup codes, provider tokens and the token signing key) MUST stay
 * readable after a new version becomes current while the earlier version is
 * still listed."
 *
 * Task 4.3's Verify clause adds: "a backup code generated under version 1
 * still works, a session cookie signed under version 1 no longer resolves, and
 * every Tayzu consumer of the signing key follows the current version (design
 * D4): the pre-auth limiter's cookie signature (`pre-auth-rate-limit.ts:309`),
 * the step-up-versus-login check of `packages/auth/src/auth.ts:1640-1643` (a
 * re-sign-in with a current-version cookie is still a step-up) and
 * `identity/reset-factor.ts`."
 *
 * Design D4, "What a rotation does": "Cookie signing uses the current entry,
 * so a rotation still signs every session out; Tayzu's three own consumers
 * (...) follow the same rule."
 *
 * ## How a "restart" is modelled
 *
 * Two `createAuth` instances over the same database: `authV1` with
 * `secrets: [{ version: 1, value: V1 }]` and `authRotated` with
 * `secrets: [{ version: 2, value: V2 }, { version: 1, value: V1 }]`. Every row
 * the first instance wrote (users, sessions, `two_factor`) is what the second
 * one reads, exactly as after a process restart with a new
 * `BETTER_AUTH_SECRETS`.
 *
 * `V1` is the shared `TEST_SECRET`, so this file never writes data under a key
 * other suites cannot read. Nothing here signs a token, so the shared
 * `auth.jwks` row is never created or read under version 2 (the token signing
 * key is outside task 4.3's Verify clause).
 *
 * ## Isolation
 *
 * Every test creates its own users (random emails) and, where a tenant
 * matters, its own organization (`bootstrapTestTenant`, random slug), and
 * every request carries a fresh random `x-forwarded-for`.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { SeverityNumber } from '@opentelemetry/api-logs';
import { runMigrations } from '@tayzu/db';
import { symmetricDecrypt, type SecretConfig } from 'better-auth/crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Import order is load-bearing: the harness registers before `./auth.js`
// creates its tracer, meter and logger at import time.
import {
  bootstrapTestTenant,
  createAdminUser,
  signInAdminUser,
  testAppPool,
} from './__fixtures__/admin-user.js';
import { registration, type TelemetryTestHarness } from './__fixtures__/registered-harness.js';
import { createAuth, type AuthInstance, type AuthSecret } from './auth.js';
import { verifyResetFactor } from './identity/reset-factor.js';
import * as authSchema from './persistence/schema.js';
import { TEST_PASSWORD, TEST_SECRET } from './__fixtures__/test-secret.js';

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
    // Expected only during teardown.
  });
  await closeable.end();
}

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

function randomEmail(): string {
  return `rotation-${randomUUID()}@example.test`;
}

function randomSlug(): string {
  return `rotation-org-${randomUUID()}`;
}

const TEST_USER_NAME = 'Secret Rotation Test User';
const AUTH_BASE_URL = 'http://localhost:3000/api/auth';
const TRUSTED_ORIGIN = 'http://localhost:3000';

/** Version 1: the shared test secret (see the module doc comment). */
const V1: AuthSecret = { version: 1, value: TEST_SECRET };
/** Version 2: generated per run, so no second key literal lives in the repository. */
const V2: AuthSecret = {
  version: 2,
  value: `rotation-test-only-${randomUUID()}-${randomUUID()}`,
};

const SECRETS_BEFORE: readonly AuthSecret[] = [V1];
const SECRETS_AFTER: readonly AuthSecret[] = [V2, V1];

/** Better Auth's versioned envelope prefix: `$ba$<version>$<ciphertext>`. */
function envelopePrefix(version: number): string {
  return `$ba$${String(version)}$`;
}

function handlerOf(auth: AuthInstance): (request: Request) => Promise<Response> {
  return (auth as unknown as { handler: (request: Request) => Promise<Response> }).handler;
}

function postJson(
  auth: AuthInstance,
  path: string,
  body: Record<string, unknown>,
  ip: string,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  return handlerOf(auth)(
    new Request(`${AUTH_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': ip,
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    }),
  );
}

function getSession(auth: AuthInstance, cookie: string): Promise<Response> {
  return handlerOf(auth)(
    new Request(`${AUTH_BASE_URL}/get-session`, {
      method: 'GET',
      headers: { cookie, 'x-forwarded-for': randomIp() },
    }),
  );
}

function cookieHeaderFrom(response: Response): string {
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length === 0) {
    throw new Error('expected response to carry at least one Set-Cookie header');
  }
  return setCookies.map((raw) => raw.split(';')[0]).join('; ');
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

function twoFactorApiOf(auth: AuthInstance): TwoFactorApiSurface {
  return auth.api as TwoFactorApiSurface;
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

/** The raw TOTP secret, from `totpURI`'s Base32 `secret` parameter (same as `mfa.int.test.ts`). */
function rawSecretFromTotpUri(totpURI: string): string {
  const secretParam = new URL(totpURI).searchParams.get('secret');
  if (secretParam === null) {
    throw new Error('expected a secret query parameter on the TOTP URI');
  }
  return new TextDecoder().decode(decodeBase32(secretParam));
}

interface SignInBody {
  readonly token?: string | null;
  readonly twoFactorRedirect?: boolean;
  readonly user?: { readonly id: string };
}

interface EnrolledUser {
  readonly email: string;
  readonly userId: string;
  /** The raw TOTP secret, as an authenticator app holds it. */
  readonly totpSecret: string;
  readonly backupCodes: readonly string[];
  /** Set when the user was created with an organization. */
  readonly organizationId?: string;
}

describe('Encrypted data survives a rotation (task 4.3, design D4, Q9)', () => {
  let db: TestDb;
  /** The instance before the restart: version 1 only. */
  let authV1: AuthInstance;
  /** The instance after the restart: version 2 current, version 1 still listed. */
  let authRotated: AuthInstance;
  let harness: TelemetryTestHarness;

  beforeAll(async () => {
    db = connect(databaseUrl());
    await runMigrations(db.$client);
    authV1 = createAuth({ db, secrets: SECRETS_BEFORE, trustedOrigins: [TRUSTED_ORIGIN] });
    authRotated = createAuth({ db, secrets: SECRETS_AFTER, trustedOrigins: [TRUSTED_ORIGIN] });
    if ('error' in registration) {
      throw new Error(`createTelemetryTestHarness() failed: ${String(registration.error)}`, {
        cause: registration.error,
      });
    }
    harness = registration.harness;
  }, 60_000);

  afterAll(async () => {
    await endQuietly(db.$client);
  });

  async function storedTwoFactor(
    userId: string,
  ): Promise<{ readonly secret: string; readonly backupCodes: string }> {
    const rows = await db
      .select({
        secret: authSchema.twoFactor.secret,
        backupCodes: authSchema.twoFactor.backupCodes,
      })
      .from(authSchema.twoFactor)
      .where(eq(authSchema.twoFactor.userId, userId));
    const row = rows[0];
    if (row === undefined) {
      throw new Error('expected one two_factor row for the enrolled user');
    }
    return row;
  }

  /**
   * GIVEN "a user whose TOTP factor was enrolled while version `1` was
   * current": created, signed in and enrolled entirely through `authV1`, and
   * the stored factor is checked to carry the version-1 envelope.
   */
  async function enrolledUnderVersionOne(
    options: { readonly withOrganization?: boolean } = {},
  ): Promise<EnrolledUser> {
    const email = randomEmail();
    let cookie: string;
    let userId: string;
    let organizationId: string | undefined;
    if (options.withOrganization === true) {
      const tenant = await bootstrapTestTenant(authV1, {
        pool: testAppPool(),
        name: TEST_USER_NAME,
        email,
        password: TEST_PASSWORD,
        organizationName: 'Secret Rotation Test Org',
        organizationSlug: randomSlug(),
        ip: randomIp(),
      });
      cookie = tenant.cookie;
      userId = tenant.userId;
      organizationId = tenant.organizationId;
    } else {
      const created = await createAdminUser(authV1, {
        name: TEST_USER_NAME,
        email,
        password: TEST_PASSWORD,
      });
      const signedIn = await signInAdminUser(authV1, {
        email,
        password: TEST_PASSWORD,
        ip: randomIp(),
      });
      cookie = signedIn.cookie;
      userId = created.userId;
    }

    const api = twoFactorApiOf(authV1);
    const enabled = await api.enableTwoFactor({
      body: { password: TEST_PASSWORD, method: 'totp' },
      headers: new Headers({ cookie }),
    });
    expect(enabled.backupCodes.length, 'enrolment returns backup codes').toBeGreaterThan(0);
    const totpSecret = rawSecretFromTotpUri(enabled.totpURI);
    await api.verifyTOTP({
      body: { code: (await api.generateTOTP({ body: { secret: totpSecret } })).code },
      headers: new Headers({ cookie }),
    });

    const stored = await storedTwoFactor(userId);
    expect(
      stored.secret.startsWith(envelopePrefix(1)),
      'the TOTP secret was encrypted while version 1 was current',
    ).toBe(true);
    expect(
      stored.backupCodes.startsWith(envelopePrefix(1)),
      'the backup codes were encrypted while version 1 was current',
    ).toBe(true);

    return {
      email,
      userId,
      totpSecret,
      backupCodes: enabled.backupCodes,
      ...(organizationId === undefined ? {} : { organizationId }),
    };
  }

  /** A password sign-in on `auth` that stops at the second-factor challenge. */
  async function challengeCookie(auth: AuthInstance, email: string): Promise<string> {
    const response = await postJson(
      auth,
      '/sign-in/email',
      { email, password: TEST_PASSWORD },
      randomIp(),
    );
    expect(response.status, 'the password sign-in is challenged, not rejected').toBe(200);
    const body = (await response.json()) as SignInBody;
    expect(body.twoFactorRedirect, 'a second factor is requested').toBe(true);
    return cookieHeaderFrom(response);
  }

  async function currentTotpCode(auth: AuthInstance, totpSecret: string): Promise<string> {
    return (await twoFactorApiOf(auth).generateTOTP({ body: { secret: totpSecret } })).code;
  }

  /** A full sign-in on `authRotated` with TOTP: the resulting current-version session cookie. */
  async function signInRotatedWithTotp(user: EnrolledUser): Promise<string> {
    const verified = await postJson(
      authRotated,
      '/two-factor/verify-totp',
      { code: await currentTotpCode(authRotated, user.totpSecret) },
      randomIp(),
      { cookie: await challengeCookie(authRotated, user.email), origin: TRUSTED_ORIGIN },
    );
    expect(verified.status, 'the TOTP sign-in completes after the rotation').toBe(200);
    return cookieHeaderFrom(verified);
  }

  function logsNamed(
    eventName: string,
  ): ReturnType<TelemetryTestHarness['logExporter']['getFinishedLogRecords']> {
    return [...harness.logExporter.getFinishedLogRecords()].filter(
      (record) => record.eventName === eventName,
    );
  }

  it('Encrypted data survives a rotation: a TOTP factor enrolled under version 1 verifies at sign-in with version 2 current', async () => {
    const user = await enrolledUnderVersionOne();

    // WHEN the platform restarts with version 2 current and version 1 still listed.
    const cookie = await challengeCookie(authRotated, user.email);
    const response = await postJson(
      authRotated,
      '/two-factor/verify-totp',
      { code: await currentTotpCode(authRotated, user.totpSecret) },
      randomIp(),
      { cookie, origin: TRUSTED_ORIGIN },
    );

    // THEN that user's TOTP code still verifies at sign-in.
    expect(response.status, 'the TOTP code verifies after the rotation').toBe(200);
    const body = (await response.json()) as SignInBody;
    expect(body.user?.id, 'the sign-in completes for that user').toBe(user.userId);
    expect(body.token, 'a session is issued').toBeTypeOf('string');
  }, 60_000);

  it('A backup code generated under version 1 still works after the rotation', async () => {
    const user = await enrolledUnderVersionOne();
    const backupCode = user.backupCodes[0];
    if (backupCode === undefined) {
      throw new Error('expected at least one backup code from enrolment');
    }

    const cookie = await challengeCookie(authRotated, user.email);
    const response = await postJson(
      authRotated,
      '/two-factor/verify-backup-code',
      { code: backupCode },
      randomIp(),
      { cookie, origin: TRUSTED_ORIGIN },
    );

    expect(response.status, 'the version-1 backup code verifies after the rotation').toBe(200);
    const body = (await response.json()) as SignInBody;
    expect(body.user?.id, 'the sign-in completes for that user').toBe(user.userId);
  }, 60_000);

  it('A session cookie signed under version 1 no longer resolves after the rotation', async () => {
    const email = randomEmail();
    const created = await createAdminUser(authV1, {
      name: TEST_USER_NAME,
      email,
      password: TEST_PASSWORD,
    });
    const signedUnderV1 = await signInAdminUser(authV1, {
      email,
      password: TEST_PASSWORD,
      ip: randomIp(),
    });

    // The version-1 instance still serves the session (the cookie itself is valid).
    const beforeRestart = await getSession(authV1, signedUnderV1.cookie);
    expect(beforeRestart.status).toBe(200);
    expect(await beforeRestart.text(), 'the session resolves under version 1').toContain(
      created.userId,
    );

    // After the rotation, the same cookie no longer resolves.
    const afterRestart = await getSession(authRotated, signedUnderV1.cookie);
    const afterBody = await afterRestart.text();
    expect(afterBody, 'the version-1 cookie no longer resolves').not.toContain(created.userId);
    expect(afterBody, 'the version-1 cookie no longer resolves').not.toContain(signedUnderV1.token);

    // A fresh sign-in after the rotation resolves on the rotated instance.
    const signedUnderV2 = await signInAdminUser(authRotated, {
      email,
      password: TEST_PASSWORD,
      ip: randomIp(),
    });
    const fresh = await getSession(authRotated, signedUnderV2.cookie);
    expect(fresh.status).toBe(200);
    expect(await fresh.text(), 'a current-version cookie resolves').toContain(created.userId);
  }, 60_000);

  it('The step-up-versus-login check follows the current version: a re-verification with a current-version session cookie is still a step-up', async () => {
    const user = await enrolledUnderVersionOne({ withOrganization: true });
    const sessionCookie = await signInRotatedWithTotp(user);
    await harness.reset();

    // WHEN they verify TOTP again on that same, current-version session.
    const stepUp = await postJson(
      authRotated,
      '/two-factor/verify-totp',
      { code: await currentTotpCode(authRotated, user.totpSecret) },
      randomIp(),
      { cookie: sessionCookie, origin: TRUSTED_ORIGIN },
    );
    expect(stepUp.status, 'the step-up verification succeeds').toBe(200);
    await harness.forceFlush();

    // THEN it is a step-up, not a login.
    expect(
      logsNamed('auth.security.login_succeeded'),
      'a step-up on an existing current-version session is not a login',
    ).toHaveLength(0);
    const events = logsNamed('auth.security.step_up_succeeded');
    expect(events, 'exactly one step_up_succeeded').toHaveLength(1);
    expect(events[0]?.severityNumber).toBe(SeverityNumber.INFO);
    expect(events[0]?.attributes).toEqual({
      'tayzu.actor.id': user.userId,
      'tayzu.tenant.id': user.organizationId,
      'tayzu.auth.method': 'local',
    });
  }, 60_000);

  describe('The pre-auth limiter follows the current version', () => {
    const PASSWORD_CHECK_MAX = 3;
    let authRotatedLimited: AuthInstance;
    let authV1Limited: AuthInstance;

    beforeAll(() => {
      const rateLimit = { passwordCheck: { window: 60, max: PASSWORD_CHECK_MAX } };
      authV1Limited = createAuth({
        db,
        secrets: SECRETS_BEFORE,
        trustedOrigins: [TRUSTED_ORIGIN],
        rateLimit,
      });
      authRotatedLimited = createAuth({
        db,
        secrets: SECRETS_AFTER,
        trustedOrigins: [TRUSTED_ORIGIN],
        rateLimit,
      });
    });

    /** A wrong password on `/verify-password`, each from a fresh IP: only the per-user bucket can block it. */
    function verifyWrongPassword(auth: AuthInstance, cookie: string): Promise<Response> {
      return postJson(auth, '/verify-password', { password: `wrong-${randomUUID()}` }, randomIp(), {
        cookie,
        origin: TRUSTED_ORIGIN,
      });
    }

    async function newUser(): Promise<string> {
      const email = randomEmail();
      await createAdminUser(authV1Limited, {
        name: TEST_USER_NAME,
        email,
        password: TEST_PASSWORD,
      });
      return email;
    }

    it('A current-version session cookie names the per-user bucket after the rotation', async () => {
      const email = await newUser();
      const signedUnderV2 = await signInAdminUser(authRotatedLimited, {
        email,
        password: TEST_PASSWORD,
        ip: randomIp(),
      });

      for (let attempt = 0; attempt < PASSWORD_CHECK_MAX; attempt += 1) {
        const response = await verifyWrongPassword(authRotatedLimited, signedUnderV2.cookie);
        expect(response.status, 'an attempt under the limit is not rate-limited').not.toBe(429);
        expect(response.status, 'a wrong password is refused, never accepted').not.toBe(200);
      }

      // A fresh IP has an untouched per-IP bucket: only the per-user bucket,
      // resolved from the current-version cookie signature, can block this.
      const blocked = await verifyWrongPassword(authRotatedLimited, signedUnderV2.cookie);
      expect(blocked.status, 'the per-user bucket applies to the current-version cookie').toBe(429);
      const body = (await blocked.json()) as { readonly code?: string };
      expect(body.code).toBe('AUTH_RATE_LIMITED');
    }, 60_000);

    it('A version-1 session cookie names no user bucket after the rotation', async () => {
      const email = await newUser();
      const signedUnderV1 = await signInAdminUser(authV1Limited, {
        email,
        password: TEST_PASSWORD,
        ip: randomIp(),
      });

      // More attempts than the per-user limit, each from a fresh IP: a stale
      // signature must never resolve to the user's bucket.
      for (let attempt = 0; attempt <= PASSWORD_CHECK_MAX; attempt += 1) {
        const response = await verifyWrongPassword(authRotatedLimited, signedUnderV1.cookie);
        expect(
          response.status,
          'a version-1 cookie resolves no user bucket after the rotation',
        ).not.toBe(429);
        expect(response.status, 'a stale session is never accepted').not.toBe(200);
      }
    }, 60_000);
  });

  describe('The reset factor verifier follows the current version', () => {
    let rotatedSecretConfig: SecretConfig;

    beforeAll(async () => {
      const context = (await (authRotated as unknown as { readonly $context: Promise<unknown> })
        .$context) as { readonly secretConfig: SecretConfig };
      rotatedSecretConfig = context.secretConfig;
    });

    it('A TOTP factor enrolled under version 1 verifies with the rotated keys', async () => {
      const user = await enrolledUnderVersionOne();
      const stored = await storedTwoFactor(user.userId);

      const result = await verifyResetFactor({
        factor: { kind: 'totp', code: await currentTotpCode(authRotated, user.totpSecret) },
        twoFactor: stored,
        secretConfig: rotatedSecretConfig,
      });

      expect(result).toEqual({ verified: true, remainingBackupCodes: null });
    }, 60_000);

    it('A backup code generated under version 1 verifies with the rotated keys, and the remaining codes are re-encrypted under the current version', async () => {
      const user = await enrolledUnderVersionOne();
      const stored = await storedTwoFactor(user.userId);
      const backupCode = user.backupCodes[0];
      if (backupCode === undefined) {
        throw new Error('expected at least one backup code from enrolment');
      }

      const result = await verifyResetFactor({
        factor: { kind: 'backup_code', code: backupCode },
        twoFactor: stored,
        secretConfig: rotatedSecretConfig,
      });

      expect(result.verified, 'the version-1 backup code verifies after the rotation').toBe(true);
      if (!result.verified) {
        return;
      }
      const remaining = result.remainingBackupCodes;
      expect(remaining, 'a backup-code match returns the remaining codes').toBeTypeOf('string');
      if (remaining === null) {
        return;
      }
      expect(
        remaining.startsWith(envelopePrefix(V2.version)),
        'the remaining codes are encrypted under the current version',
      ).toBe(true);
      // Readable with the current version's key alone.
      const currentOnly: SecretConfig = {
        keys: new Map([[V2.version, V2.value]]),
        currentVersion: V2.version,
      };
      const decrypted = JSON.parse(
        await symmetricDecrypt({ key: currentOnly, data: remaining }),
      ) as string[];
      expect(decrypted).toEqual(user.backupCodes.filter((code) => code !== backupCode));
    }, 60_000);
  });
});
