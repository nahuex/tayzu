/**
 * Integration test for task 5.4 of `048-production-hardening` (design D5 "Rehash on sign-in",
 * Resolved decisions Q8 and Q27). Spec scenarios of
 * `specs/password-reset-and-account-recovery/spec.md`:
 *
 * #### Scenario: A legacy hash still signs in and is upgraded
 * - GIVEN a user whose stored hash is in the earlier `salt:key` format
 * - WHEN they sign in with the correct password
 * - THEN the sign-in succeeds and the stored hash is now in the current format, and the next
 *   sign-in still succeeds
 *
 * #### Scenario: A failed sign-in does not touch the hash
 * - GIVEN a user whose stored hash is in the earlier format
 * - WHEN they sign in with a wrong password
 * - THEN the answer is the uniform sign-in failure, the stored hash is unchanged, and no rehash
 *   event or write happens
 *
 * #### Scenario: A rehash never overwrites a concurrent reset
 * - GIVEN a sign-in with the old password whose hash read happens before a reset commits
 * - WHEN the sign-in's rehash runs after the reset
 * - THEN the reset's hash is kept, and the sign-in is refused as it is today
 *
 * plus the cases the task names: the upgrade with a pending second factor (Q27: "once the
 * password has verified and the reset-race check has passed, whether or not a second factor
 * follows"), a lower-cost platform hash (`$scrypt$ln=14,...`, D5: "platform parameters below
 * the current ones"), and a rehash error that still completes the sign-in (D5: "a rehash error
 * is swallowed after a sanitized `auth.internal_error`, and the sign-in still succeeds").
 *
 * ## How the race and the error are made deterministic
 *
 * Every connection of the pool the Drizzle handle uses has its `query` wrapped (through the
 * pool's `connect` event, so both `pool.query` and `pool.connect()` clients are covered). The
 * wrapper records every statement and, when a test arms it, acts just before the rehash write:
 * an `update` of `auth.account` that binds a current-format hash (`$scrypt$ln=15,r=8,p=3$`).
 *
 * - The race: the armed action first commits a stood-in reset on a separate pool (the new
 *   password's hash and the user's sessions deleted, as the real reset of `apps/api` does in
 *   one transaction), then lets the rehash write run. The write lands after the reset, so only
 *   the compare-and-set on the stored hash (D5) keeps the reset's hash.
 * - The error: the armed action fails the rehash write instead of running it.
 *
 * Every request carries a fresh random `x-forwarded-for`, and the sign-in limiter is roomy.
 * Each test creates its own users with fresh random addresses.
 *
 * ## Production symbols expected
 *
 * None new: the rehash branch of `hooks.after` on `/sign-in/email` in `auth.ts` (D5), using
 * `needsRehash` and `hashPassword` of `./password-hash.ts`.
 */
import { randomBytes, randomInt, randomUUID, scrypt } from 'node:crypto';

import { runMigrations } from '@tayzu/db';
import { hashPassword as legacyHashPassword } from 'better-auth/crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAdminUser, signInAdminUser } from './__fixtures__/admin-user.js';
import './__fixtures__/registered-harness.js';
import { registration, type TelemetryTestHarness } from './__fixtures__/registered-harness.js';
import { createAuth, type AuthInstance } from './auth.js';
import { hashPassword, needsRehash, verifyPassword } from './password-hash.js';
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
const RESET_PASSWORD = 'a brand new password after the reset 7!';
const SIGN_IN_URL = 'http://localhost:3000/api/auth/sign-in/email';

/** design D5 "Format" at the current cost: `$scrypt$ln=15,r=8,p=3$<22 characters>$<86 characters>`. */
const CURRENT_FORMAT = /^\$scrypt\$ln=15,r=8,p=3\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{86}$/;
const CURRENT_PREFIX = '$scrypt$ln=15,r=8,p=3$';
/** design D5 "Verification": the legacy Better Auth `salt:key` format. */
const LEGACY_FORMAT = /^[0-9a-f]{32}:[0-9a-f]{128}$/;

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

function randomEmail(): string {
  return `rehash-${randomUUID()}@example.test`;
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

/** A platform-format hash at a cost below the current one (`ln=14`, D5 "Format"). */
function lowerCostHash(password: string): Promise<string> {
  const salt = randomBytes(16);
  const unpadded = (bytes: Buffer): string => bytes.toString('base64').replace(/=+$/, '');
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFC'),
      salt,
      64,
      { N: 2 ** 14, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
      (error, key) => {
        if (error === null) {
          resolve(`$scrypt$ln=14,r=8,p=3$${unpadded(salt)}$${unpadded(key)}`);
        } else {
          reject(error);
        }
      },
    );
  });
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

interface Statement {
  readonly text: string;
  readonly values: readonly unknown[];
}

/** Any write to `auth.account` (Drizzle quotes the identifiers; hand-written SQL may not). */
function isAccountUpdate(text: string): boolean {
  return /^\s*update\s+(?:"?auth"?\s*\.\s*)?"?account"?(?:\s|$)/i.test(text);
}

/** The rehash write: an `auth.account` update that binds a current-format hash. */
function isRehashWrite(statement: Statement): boolean {
  return (
    isAccountUpdate(statement.text) &&
    statement.values.some((v) => typeof v === 'string' && v.startsWith(CURRENT_PREFIX))
  );
}

function describeQuery(args: readonly unknown[]): Statement {
  const first = args[0];
  const text =
    typeof first === 'string' ? first : ((first as { text?: unknown } | undefined)?.text ?? '');
  const second = args[1];
  const values = Array.isArray(second)
    ? (second as unknown[])
    : ((first as { values?: unknown } | undefined)?.values ?? []);
  return {
    text: typeof text === 'string' ? text : '',
    values: Array.isArray(values) ? (values as unknown[]) : [],
  };
}

/** Thrown in place of the rehash write when a test injects a rehash error. */
class InjectedRehashFailure extends Error {
  constructor() {
    super('injected-rehash-failure-marker-5f1c');
    this.name = 'InjectedRehashFailure';
  }
}

type BeforeRehashWrite = () => Promise<void>;

describe('A successful local sign-in rewrites a weaker hash (task 5.4, design D5, Q8, Q27)', () => {
  let pool: Pool;
  let resetPool: Pool;
  let db: ReturnType<typeof drizzle<typeof authSchema>>;
  let auth: AuthInstance;
  let harness: TelemetryTestHarness;
  let statements: Statement[] = [];
  let beforeRehashWrite: BeforeRehashWrite | undefined;
  let rehashWritesSeen = 0;

  async function gate(statement: Statement): Promise<void> {
    statements.push(statement);
    if (!isRehashWrite(statement)) return;
    rehashWritesSeen += 1;
    const armed = beforeRehashWrite;
    beforeRehashWrite = undefined;
    if (armed !== undefined) await armed();
  }

  function instrument(client: PoolClient): void {
    const marked = client as unknown as { __rehashGate?: true };
    if (marked.__rehashGate === true) return;
    marked.__rehashGate = true;
    const target = client as unknown as { query: (...args: unknown[]) => unknown };
    const original = target.query.bind(client);
    target.query = (...args: unknown[]): unknown => {
      const statement = describeQuery(args);
      const last = args[args.length - 1];
      if (typeof last === 'function') {
        const callback = last as (error: unknown, result?: unknown) => void;
        gate(statement).then(
          () => {
            original(...args);
          },
          (error: unknown) => {
            callback(error);
          },
        );
        return undefined;
      }
      return gate(statement).then(() => original(...args));
    };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl() });
    pool.on('connect', (client) => {
      instrument(client);
    });
    resetPool = new Pool({ connectionString: databaseUrl() });
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
    for (const closeable of [pool, resetPool]) {
      closeable.on('error', () => {
        // Expected only during teardown.
      });
      await closeable.end();
    }
  });

  /** A fresh user whose stored hash is then replaced with `storedHash` (and, optionally, MFA). */
  async function newUser(options: {
    readonly storedHash: (password: string) => Promise<string>;
    readonly enrol: boolean;
  }): Promise<{ userId: string; email: string; storedHash: string }> {
    const email = randomEmail();
    const created = await createAdminUser(auth, {
      name: 'Rehash Test User',
      email,
      password: TEST_PASSWORD,
    });
    if (options.enrol) {
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
    }
    // Only the sign-in under test may leave a session behind.
    await db.execute(sql`delete from auth.session where user_id = ${created.userId}`);
    const storedHash = await options.storedHash(TEST_PASSWORD);
    await db.execute(
      sql`update auth.account set password = ${storedHash} where user_id = ${created.userId} and provider_id = 'credential'`,
    );
    expect(await credentialHash(created.userId), 'control: the weaker hash is stored').toBe(
      storedHash,
    );
    expect(needsRehash(storedHash), 'control: the seeded hash is weaker than current').toBe(true);
    return { userId: created.userId, email, storedHash };
  }

  async function credentialHash(userId: string): Promise<string> {
    const rows = await db.execute<{ password: string }>(
      sql`select password from auth.account where user_id = ${userId} and provider_id = 'credential'`,
    );
    const hash = rows.rows[0]?.password;
    if (hash === undefined) throw new Error('no credential account');
    return hash;
  }

  async function sessionCount(userId: string): Promise<number> {
    const rows = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from auth.session where user_id = ${userId}`,
    );
    return Number(rows.rows[0]?.n ?? -1);
  }

  async function expectUpgraded(userId: string, previous: string): Promise<string> {
    const upgraded = await credentialHash(userId);
    expect(upgraded, 'the stored hash changed').not.toBe(previous);
    expect(upgraded, 'the stored hash is now in the current format').toMatch(CURRENT_FORMAT);
    expect(needsRehash(upgraded), 'the new hash is at the current cost').toBe(false);
    expect(
      await verifyPassword({ hash: upgraded, password: TEST_PASSWORD }),
      'the new hash verifies the same password',
    ).toBe(true);
    return upgraded;
  }

  async function expectSignedIn(response: Response, userId: string): Promise<void> {
    expect(response.status, 'the sign-in succeeds').toBe(200);
    const body = (await response.json()) as { token?: unknown };
    expect(body.token, 'a session token is issued').toBeTypeOf('string');
    expect(
      response.headers.getSetCookie().some((c) => c.includes('session_token')),
      'a session cookie is set',
    ).toBe(true);
    expect(await sessionCount(userId), 'the session exists').toBe(1);
  }

  async function expectSecondFactorPending(response: Response, userId: string): Promise<void> {
    expect(response.status, 'the password is accepted').toBe(200);
    const body = (await response.json()) as { twoFactorRedirect?: unknown };
    expect(body.twoFactorRedirect, 'the second factor is still requested').toBe(true);
    expect(await sessionCount(userId), 'no session before the factor').toBe(0);
  }

  async function refusedLikeWrongPassword(response: Response): Promise<void> {
    const control = await postSignIn(auth, randomEmail(), WRONG_PASSWORD);
    expect(control.status, 'control: a wrong password is a failure').toBeGreaterThanOrEqual(400);
    expect(response.status, 'the wrong-password status').toBe(control.status);
    expect(await response.json(), 'the wrong-password body').toEqual(await control.json());
    expect(
      response.headers.getSetCookie().some((c) => c.includes('session_token')),
      'no session cookie',
    ).toBe(false);
  }

  async function internalErrors(): Promise<{ severity: unknown; attributes: unknown }[]> {
    await harness.forceFlush();
    return [...harness.logExporter.getFinishedLogRecords()]
      .filter((record) => record.eventName === 'auth.internal_error')
      .map((record) => ({ severity: record.severityText, attributes: record.attributes }));
  }

  it('A legacy hash still signs in and is upgraded (no second factor)', async () => {
    const user = await newUser({ storedHash: legacyHashPassword, enrol: false });
    expect(user.storedHash, 'control: the seeded hash is a legacy salt:key hash').toMatch(
      LEGACY_FORMAT,
    );

    const response = await postSignIn(auth, user.email, TEST_PASSWORD);

    await expectSignedIn(response, user.userId);
    const upgraded = await expectUpgraded(user.userId, user.storedHash);

    // AND the next sign-in still succeeds, and needs no further rewrite.
    await db.execute(sql`delete from auth.session where user_id = ${user.userId}`);
    const next = await postSignIn(auth, user.email, TEST_PASSWORD);
    await expectSignedIn(next, user.userId);
    expect(await credentialHash(user.userId), 'a current hash is not rewritten again').toBe(
      upgraded,
    );
  }, 60_000);

  it('A legacy hash still signs in and is upgraded (a second factor is still pending, Q27)', async () => {
    const user = await newUser({ storedHash: legacyHashPassword, enrol: true });

    const response = await postSignIn(auth, user.email, TEST_PASSWORD);

    await expectSecondFactorPending(response, user.userId);
    const upgraded = await expectUpgraded(user.userId, user.storedHash);

    // AND the next sign-in still succeeds (the password is accepted again).
    const next = await postSignIn(auth, user.email, TEST_PASSWORD);
    await expectSecondFactorPending(next, user.userId);
    expect(await credentialHash(user.userId), 'a current hash is not rewritten again').toBe(
      upgraded,
    );
  }, 60_000);

  it('A lower-cost platform hash ($scrypt$ln=14) signs in and is upgraded', async () => {
    const user = await newUser({ storedHash: lowerCostHash, enrol: false });
    expect(user.storedHash.startsWith('$scrypt$ln=14,r=8,p=3$')).toBe(true);
    expect(
      await verifyPassword({ hash: user.storedHash, password: TEST_PASSWORD }),
      'control: the lower-cost hash verifies',
    ).toBe(true);

    const response = await postSignIn(auth, user.email, TEST_PASSWORD);

    await expectSignedIn(response, user.userId);
    await expectUpgraded(user.userId, user.storedHash);

    await db.execute(sql`delete from auth.session where user_id = ${user.userId}`);
    const next = await postSignIn(auth, user.email, TEST_PASSWORD);
    await expectSignedIn(next, user.userId);
  }, 60_000);

  it('A failed sign-in does not touch the hash', async () => {
    for (const storedHash of [legacyHashPassword, lowerCostHash]) {
      const user = await newUser({ storedHash, enrol: false });
      const unknown = await postSignIn(auth, randomEmail(), WRONG_PASSWORD);

      await harness.reset();
      statements = [];
      rehashWritesSeen = 0;
      const response = await postSignIn(auth, user.email, WRONG_PASSWORD);
      const seen = statements;

      // THEN the answer is the uniform sign-in failure ...
      expect(unknown.status, 'control: an unknown address is a failure').toBeGreaterThanOrEqual(
        400,
      );
      expect(response.status, 'the uniform failure status').toBe(unknown.status);
      expect(await response.json(), 'the uniform failure body').toEqual(await unknown.json());
      expect(seen.length, 'control: the sign-in reached the database').toBeGreaterThan(0);

      // ... the stored hash is unchanged (byte-identical) ...
      expect(await credentialHash(user.userId), 'the stored hash is byte-identical').toBe(
        user.storedHash,
      );

      // ... and no rehash event or write happens.
      expect(rehashWritesSeen, 'no rehash write').toBe(0);
      expect(
        seen.filter((s) => isAccountUpdate(s.text)),
        'no write to auth.account at all',
      ).toEqual([]);
      expect(await internalErrors(), 'no rehash error event').toEqual([]);
      expect(await sessionCount(user.userId), 'no session').toBe(0);
    }
  }, 120_000);

  it('A rehash never overwrites a concurrent reset (the compare-and-set keeps the reset hash)', async () => {
    const user = await newUser({ storedHash: legacyHashPassword, enrol: false });
    const resetHash = await hashPassword(RESET_PASSWORD);
    let resetCommitted = false;
    // The stood-in reset commits after the sign-in read and verified the old hash and after the
    // reset-race comparison, right before the rehash write: the write runs after the reset.
    beforeRehashWrite = async (): Promise<void> => {
      const client = await resetPool.connect();
      try {
        await client.query('begin');
        await client.query(
          `update auth.account set password = $1 where user_id = $2 and provider_id = 'credential'`,
          [resetHash, user.userId],
        );
        await client.query('delete from auth.session where user_id = $1', [user.userId]);
        await client.query('commit');
        resetCommitted = true;
      } finally {
        client.release();
      }
    };
    rehashWritesSeen = 0;

    const response = await postSignIn(auth, user.email, TEST_PASSWORD);

    expect(rehashWritesSeen, 'control: the sign-in attempted its rehash').toBe(1);
    expect(resetCommitted, 'control: the reset committed before the rehash write').toBe(true);
    // THEN the reset's hash is kept ...
    expect(await credentialHash(user.userId), "the reset's hash is kept").toBe(resetHash);
    // ... and the sign-in is refused as it is today (like a wrong password, no session).
    await refusedLikeWrongPassword(response);
    expect(await sessionCount(user.userId), 'no session exists').toBe(0);

    // The reset's password is the one that works now; the old one no longer does.
    const old = await postSignIn(auth, user.email, TEST_PASSWORD);
    expect(old.status, 'the old password is refused').toBeGreaterThanOrEqual(400);
    const fresh = await postSignIn(auth, user.email, RESET_PASSWORD);
    expect(fresh.status, "the reset's password signs in").toBe(200);
    expect(await credentialHash(user.userId), "the reset's current hash is not rewritten").toBe(
      resetHash,
    );
  }, 60_000);

  it('a rehash error still completes the sign-in, after a sanitized auth.internal_error', async () => {
    const user = await newUser({ storedHash: legacyHashPassword, enrol: false });
    let injected = false;
    beforeRehashWrite = (): Promise<void> => {
      injected = true;
      return Promise.reject(new InjectedRehashFailure());
    };
    rehashWritesSeen = 0;
    await harness.reset();

    const response = await postSignIn(auth, user.email, TEST_PASSWORD);

    expect(injected, 'control: the rehash write was attempted and failed').toBe(true);
    expect(rehashWritesSeen).toBe(1);
    await expectSignedIn(response, user.userId);
    expect(await credentialHash(user.userId), 'the failed rehash left the hash as it was').toBe(
      user.storedHash,
    );

    const errors = await internalErrors();
    expect(errors, 'one sanitized auth.internal_error for the swallowed rehash error').toHaveLength(
      1,
    );
    expect(errors[0]?.severity).toBe('ERROR');
    const attributeKeys = Object.keys(errors[0]?.attributes ?? {}).sort();
    for (const key of attributeKeys) {
      expect(['db.response.status_code', 'error.type'], 'only sanitized attributes').toContain(key);
    }
    expect(attributeKeys).toContain('error.type');

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
    for (const fragment of [
      'injected-rehash-failure-marker-5f1c',
      TEST_PASSWORD,
      user.storedHash,
      CURRENT_PREFIX,
    ]) {
      expect(emitted.includes(fragment), 'no message, password or hash reaches telemetry').toBe(
        false,
      );
    }
  }, 60_000);
});
