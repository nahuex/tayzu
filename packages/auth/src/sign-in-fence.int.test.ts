/**
 * Integration test for task 8.13 (044 design D7 "A sign-in that the reset overtook is refused",
 * Resolved decision Q28), sign-in fence half. Spec scenarios of
 * `specs/password-reset-and-account-recovery/spec.md`:
 *
 * #### Scenario: A sign-in that began before the reset does not survive it
 * - GIVEN a sign-in that has verified the old password and is held before it creates its session
 * - WHEN a reset completes and the held sign-in then continues
 * - THEN the sign-in is refused like a wrong password, no session exists and no usable
 *   second-factor challenge exists
 *
 * plus the cases named by the task: "a sign-in with no reset in between is unaffected" and
 * "the kept hash reaches no log, span or metric".
 *
 * ## How the sign-in is held
 *
 * The real reset is task 8.9; here it is stood in for by a credential-hash update. The hold is
 * a wrapper on the Postgres pool the Drizzle handle uses: the first `insert into
 * "auth"."session"` of an armed sign-in is preceded by the hash update (on the original
 * `query`), so the update lands after the password was verified and `hooks.before` ran, and
 * before `hooks.after`. Every request carries a fresh random `x-forwarded-for`, and the sign-in
 * limiter is roomy.
 *
 * ## Production symbols expected
 *
 * None new: `hooks.before` / `hooks.after` on `/sign-in/email` in `auth.ts` (D7).
 */
import { randomInt, randomUUID } from 'node:crypto';

import { runMigrations } from '@tayzu/db';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAdminUser, signInAdminUser } from './__fixtures__/admin-user.js';
import './__fixtures__/registered-harness.js';
import { registration, type TelemetryTestHarness } from './__fixtures__/registered-harness.js';
import { createAuth, type AuthInstance } from './auth.js';
import * as authSchema from './persistence/schema.js';
import { TEST_SECRET } from './__fixtures__/test-secret.js';

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim() === '') {
    throw new Error(
      'DATABASE_URL is not set: the int project global setup should have stopped this run.',
    );
  }
  return url;
}

const TEST_PASSWORD = 'correct horse battery staple';
const WRONG_PASSWORD = 'definitely the wrong password, not correct';
const SIGN_IN_URL = 'http://localhost:3000/api/auth/sign-in/email';

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

function randomEmail(): string {
  return `fence-${randomUUID()}@example.test`;
}

function handlerOf(auth: AuthInstance): (request: Request) => Promise<Response> {
  return (auth as unknown as { handler: (request: Request) => Promise<Response> }).handler;
}

function postSignIn(auth: AuthInstance, email: string, password: string): Promise<Response> {
  return handlerOf(auth)(
    new Request(SIGN_IN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': randomIp() },
      body: JSON.stringify({ email, password }),
    }),
  );
}

interface TwoFactorApiSurface {
  enableTwoFactor(args: {
    body: { password: string; method: 'totp' };
    headers: Headers;
  }): Promise<{ totpURI: string }>;
  generateTOTP(args: { body: { secret: string } }): Promise<{ code: string }>;
  verifyTOTP(args: { body: { code: string }; headers: Headers }): Promise<unknown>;
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function rawSecretFromTotpUri(totpURI: string): string {
  const secretParam = new URL(totpURI).searchParams.get('secret');
  if (secretParam === null) {
    throw new Error('expected a secret query parameter on the TOTP URI');
  }
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of secretParam) {
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

interface Hold {
  readonly userId: string;
  readonly newHash: string;
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v)) return undefined;
      seen.add(v);
    }
    return v;
  });
}

describe('The sign-in fence (task 8.13, design D7, Q28)', () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof authSchema>>;
  let auth: AuthInstance;
  let harness: TelemetryTestHarness;
  let hold: Hold | undefined;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl() });
    const originalQuery = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;
    (pool as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = async (
      ...args: unknown[]
    ): Promise<unknown> => {
      const first = args[0];
      const text =
        typeof first === 'string' ? first : ((first as { text?: string } | undefined)?.text ?? '');
      const armed = hold;
      if (armed !== undefined && /insert\s+into\s+"auth"\."session"/i.test(text)) {
        hold = undefined;
        await originalQuery(
          `update auth.account set password = $1 where user_id = $2 and provider_id = 'credential'`,
          [armed.newHash, armed.userId],
        );
      }
      return originalQuery(...args);
    };
    db = drizzle(pool, { schema: authSchema });
    await runMigrations(pool);
    auth = createAuth({
      db,
      secret: TEST_SECRET,
      rateLimit: { signIn: { window: 60, max: 100_000 } },
    });
    if ('error' in registration) {
      throw new Error('createTelemetryTestHarness() failed while the module graph loaded', {
        cause: registration.error,
      });
    }
    harness = registration.harness;
  }, 60_000);

  afterAll(async () => {
    pool.on('error', () => {
      // Expected only during teardown.
    });
    await pool.end();
  });

  async function newUser(enrol: boolean): Promise<{ userId: string; email: string }> {
    const email = randomEmail();
    const created = await createAdminUser(auth, {
      name: 'Fence Test User',
      email,
      password: TEST_PASSWORD,
    });
    if (enrol) {
      const signedIn = await signInAdminUser(auth, {
        email,
        password: TEST_PASSWORD,
        ip: randomIp(),
      });
      const api = auth.api as TwoFactorApiSurface;
      const headers = (): Headers => new Headers({ cookie: signedIn.cookie });
      const enabled = await api.enableTwoFactor({
        body: { password: TEST_PASSWORD, method: 'totp' },
        headers: headers(),
      });
      const { code } = await api.generateTOTP({
        body: { secret: rawSecretFromTotpUri(enabled.totpURI) },
      });
      await api.verifyTOTP({ body: { code }, headers: headers() });
      // Only the sign-in under test may leave a session behind.
      await db.execute(sql`delete from auth.session where user_id = ${created.userId}`);
    }
    return { userId: created.userId, email };
  }

  async function sessionCount(userId: string): Promise<number> {
    const rows = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from auth.session where user_id = ${userId}`,
    );
    return Number(rows.rows[0]?.n ?? -1);
  }

  async function challengeCount(userId: string): Promise<number> {
    const rows = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from auth.verification where value = ${userId} and (identifier like '2fa-%' or identifier like 'trust-device-%')`,
    );
    return Number(rows.rows[0]?.n ?? -1);
  }

  async function credentialHash(userId: string): Promise<string> {
    const rows = await db.execute<{ password: string }>(
      sql`select password from auth.account where user_id = ${userId} and provider_id = 'credential'`,
    );
    const hash = rows.rows[0]?.password;
    if (hash === undefined) throw new Error('no credential account');
    return hash;
  }

  async function refusedLikeWrongPassword(response: Response): Promise<void> {
    const control = await postSignIn(auth, randomEmail(), WRONG_PASSWORD);
    expect(control.status, 'control: a wrong password is a failure').toBeGreaterThanOrEqual(400);
    expect(response.status, 'refused with the wrong-password status').toBe(control.status);
    expect(await response.json(), 'refused with the wrong-password body').toEqual(
      await control.json(),
    );
    expect(
      response.headers.getSetCookie().some((c) => c.includes('session_token')),
      'no session cookie',
    ).toBe(false);
    expect(
      response.headers.getSetCookie().some((c) => c.includes('two_factor')),
      'no challenge cookie',
    ).toBe(false);
  }

  it('A sign-in that began before the reset does not survive it: a password-only user', async () => {
    const user = await newUser(false);
    hold = { userId: user.userId, newHash: `stood-in-reset:${randomUUID()}` };

    const response = await postSignIn(auth, user.email, TEST_PASSWORD);

    expect(hold, 'control: the hold fired between verification and session creation').toBe(
      undefined,
    );
    await refusedLikeWrongPassword(response);
    expect(await sessionCount(user.userId), 'no session exists').toBe(0);
  }, 60_000);

  it('A sign-in that began before the reset does not survive it: an enrolled user', async () => {
    const user = await newUser(true);
    hold = { userId: user.userId, newHash: `stood-in-reset:${randomUUID()}` };

    const response = await postSignIn(auth, user.email, TEST_PASSWORD);

    expect(hold, 'control: the hold fired between verification and session creation').toBe(
      undefined,
    );
    await refusedLikeWrongPassword(response);
    expect(await sessionCount(user.userId), 'no session exists').toBe(0);
    expect(await challengeCount(user.userId), 'no usable second-factor challenge exists').toBe(0);
  }, 60_000);

  it('a sign-in with no reset in between is unaffected', async () => {
    const plain = await newUser(false);
    const plainResponse = await postSignIn(auth, plain.email, TEST_PASSWORD);
    expect(plainResponse.status).toBe(200);
    const plainBody = (await plainResponse.json()) as { token?: string | null };
    expect(plainBody.token).toBeTypeOf('string');
    expect(await sessionCount(plain.userId), 'the session exists').toBe(1);

    const enrolled = await newUser(true);
    const enrolledResponse = await postSignIn(auth, enrolled.email, TEST_PASSWORD);
    expect(enrolledResponse.status).toBe(200);
    const enrolledBody = (await enrolledResponse.json()) as { twoFactorRedirect?: boolean };
    expect(enrolledBody.twoFactorRedirect, 'the second factor is still requested').toBe(true);
    expect(await sessionCount(enrolled.userId), 'no session before the factor').toBe(0);
  }, 60_000);

  it('the kept hash reaches no log, span or metric', async () => {
    const user = await newUser(false);
    const oldHash = await credentialHash(user.userId);
    const newHash = `stood-in-reset:${randomUUID()}`;
    const fragments = [oldHash, ...oldHash.split(':').filter((p) => p.length >= 16), newHash];

    await harness.reset();
    const ok = await postSignIn(auth, user.email, TEST_PASSWORD);
    expect(ok.status).toBe(200);
    const other = await newUser(false);
    hold = { userId: other.userId, newHash };
    const held = await postSignIn(auth, other.email, TEST_PASSWORD);
    expect(held.status).toBeGreaterThanOrEqual(400);
    expect(await credentialHash(other.userId), 'control: the stood-in reset landed').toBe(newHash);
    await harness.forceFlush();

    const emitted = safeStringify({
      spans: harness.spanExporter.getFinishedSpans().map((s) => ({
        name: s.name,
        attributes: s.attributes,
        events: s.events,
        status: s.status,
      })),
      logs: harness.logExporter
        .getFinishedLogRecords()
        .map((r) => ({ name: r.eventName, body: r.body, attributes: r.attributes })),
      metrics: harness.metricExporter.getMetrics(),
    });
    expect(emitted.length, 'control: the sign-ins emitted telemetry').toBeGreaterThan(0);
    expect(oldHash.length).toBeGreaterThan(16);
    for (const fragment of fragments) {
      expect(emitted.includes(fragment), 'a credential hash fragment reached telemetry').toBe(
        false,
      );
    }
  }, 60_000);
});
