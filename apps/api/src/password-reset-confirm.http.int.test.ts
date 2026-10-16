/**
 * Task 8.3 of openspec/changes/044-password-reset-and-account-recovery (design D2 "The routes",
 * "Order of work, confirm route", "Answers", "No caching"; D3 "Consumption"; D4 "Eligibility").
 *
 * Task 8.3 Verify (the part of this file): scenarios "Every token problem looks the same", "Cheap
 * checks run first" and "Reset responses are not cacheable" (confirm route, including the limiter
 * `429` and the malformed `400`) of `specs/password-reset-and-account-recovery/spec.md`.
 *
 * Scenarios (verbatim from the spec):
 * - "Every token problem looks the same": GIVEN an unknown id, a wrong token for a real id, an
 *   expired token, a used token and a token of a banned account; WHEN each is submitted to the
 *   confirm route; THEN all five answers have the same status, code and body shape.
 * - "Cheap checks run first": WHEN the confirm route receives an oversized body, an unknown field or
 *   a `constructor` key; THEN it answers `CATALOG_VALIDATION_FAILED` before any database, hash or
 *   breached-password lookup.
 * - "Reset responses are not cacheable": WHEN either reset route answers a success, a refusal or a
 *   rate-limit response; THEN the response carries `Cache-Control: no-store` and `Pragma: no-cache`.
 *
 * ## Harness
 *
 * The real server (`createApp`, injected requests, never a listener) with the identity routes
 * mounted, over a recording sender. Tokens are issued through the real `createResetTokenStore`
 * (`issue` returns the id and the raw token), for accounts bootstrapped with
 * `bootstrapTestTenant` (a password account, a membership and an Active `_user` row). Every request
 * carries a fresh random `x-forwarded-for` (except the limiter case), `Origin` and
 * `x-csrf-token: orpc`, so neither the limiter nor the CSRF check interferes (those are 8.4).
 *
 * "No database lookup" is observed on the `tayzu_auth` pool handed to `createApp`: a wrapper records
 * the text of every statement, and a lookup is a statement touching the Better Auth `user`,
 * `account`, `member` or `verification` tables (the limiter's `rate_limit` table is not among
 * them: the limiter runs first by design). The same wrapper is the control: a well-formed request
 * must produce such statements, so the assertion is not vacuous. "No breached-password lookup" is
 * observed on a stubbed global `fetch` (the range service is the only network call). "No hash" has
 * no observable seam without a production symbol and is covered by the two observations above (the
 * hash comes after the token lookup and the breach check in the stated order).
 *
 * The valid-token request answers the sanitized `INTERNAL` `500` until task 8.9; this file does not
 * assert that status (8.9 replaces it with the real completion), only that it is not one of the
 * refusals above and that its headers are not cacheable.
 *
 * ## Production symbols expected
 *
 * - `createApp` (`./server.js`) registers `POST /v1/auth/password-reset/confirm` as a plain Fastify
 *   route in the `mountIdentityRoutes` block, before the `/v1/*` catch-all, with a
 *   `PUBLIC_ROUTE_ALLOWLIST` entry (`./public-routes.js`).
 * - Its pre-handler is the per-IP limiter (default 10 per 60 seconds) with its own scope
 *   `password_reset_confirm`; `applyNoCacheHeaders` (`./identity/no-cache.js`, existing) is applied
 *   to every response of the route, the pre-handler refusals included.
 * - Body `{ id, token, newPassword, factor? }`, strict; a malformed body answers
 *   `400 CATALOG_VALIDATION_FAILED`; every token- or account-dependent refusal answers
 *   `404 CATALOG_NOT_FOUND` with one body shape.
 */
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';

import { createRecordingEmailSender } from '@tayzu/auth';
import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  bootstrapTestTenant,
  testAppPool,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createResetTokenStore } from './identity/reset-token-store.js';
import { createWithUserLock } from './identity/user-lock.js';
import { createApp, type App } from './server.js';

const ORIGIN = 'https://app.tayzu.test';
const LINK_BASE_URL = 'https://app.tayzu.test';
const CONFIRM_PATH = '/v1/auth/password-reset/confirm';
const HMAC_SECRET = 'reset-confirm-test-only-secret-0123456789-abcdef';
const NEW_PASSWORD = 'Another-Perfectly-Fine-Passphrase-77!';
const ACCOUNT_TABLES = /"user"|auth\.user\b|auth\.account\b|auth\.member\b|auth\.verification\b/i;

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

/** A syntactically valid id (22 base64url characters) that no row has. */
function randomId(): string {
  return randomBytes(16).toString('base64url');
}

/** A syntactically valid token (43 base64url characters). */
function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

type QueryFunction = (...args: unknown[]) => unknown;

function statementText(first: unknown): string {
  if (typeof first === 'string') return first;
  if (typeof first === 'object' && first !== null && 'text' in first) {
    return typeof first.text === 'string' ? first.text : '';
  }
  return '';
}

/** Wraps a pool (and the clients it hands out) so that every statement's text is recorded. */
function spyOnPool(pool: Pool, record: (sql: string) => void): Pool {
  const spyOnClient = (client: PoolClient): PoolClient =>
    new Proxy(client, {
      get(target, property): unknown {
        const value: unknown = Reflect.get(target, property, target);
        if (property === 'query') {
          return (...args: unknown[]): unknown => {
            record(statementText(args[0]));
            return (value as QueryFunction).apply(target, args);
          };
        }
        return typeof value === 'function' ? (value as QueryFunction).bind(target) : value;
      },
    });
  return new Proxy(pool, {
    get(target, property): unknown {
      const value: unknown = Reflect.get(target, property, target);
      if (property === 'query') {
        return (...args: unknown[]): unknown => {
          record(statementText(args[0]));
          return (value as QueryFunction).apply(target, args);
        };
      }
      if (property === 'connect') {
        return async (): Promise<PoolClient> => spyOnClient(await target.connect());
      }
      return typeof value === 'function' ? (value as QueryFunction).bind(target) : value;
    },
  });
}

interface Answer {
  readonly status: number;
  readonly body: unknown;
  readonly cacheControl: unknown;
  readonly pragma: unknown;
  readonly retryAfter: unknown;
}

/** The status, the code and the body's key set: what "the same shape" means. */
function shapeOf(answer: Answer): { status: number; code: unknown; keys: string[] } {
  const body = answer.body;
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  return { status: answer.status, code: record['code'], keys: Object.keys(record).sort() };
}

describe('POST /v1/auth/password-reset/confirm over HTTP (task 8.3)', () => {
  let app: App;
  let authPool: Pool;
  let statements: string[];
  let failRateLimitStore = false;
  const sender = createRecordingEmailSender();

  beforeAll(async () => {
    const pools = await harnessPools();
    statements = [];
    authPool = pools.authPool;
    const email = {
      sender,
      invitationLinkBaseUrl: LINK_BASE_URL,
      passwordResetLinkBaseUrl: LINK_BASE_URL,
      passwordResetMinResponseMs: 0,
      disabledTenantIds: [] as string[],
      killSwitch: false,
      recipientKeySecret: HMAC_SECRET,
      tenantCap: { max: 1000, windowSeconds: 3600 },
      recipientCap: { max: 1000, windowSeconds: 86_400 },
    };
    app = await createApp({
      appPool: pools.appPool,
      authPool: spyOnPool(pools.authPool, (sql) => {
        if (failRateLimitStore && /rate_limit/i.test(sql)) throw new Error('store down');
        statements.push(sql);
      }),
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ORIGIN],
      mountIdentityRoutes: true,
      identityTokenHmacSecret: HMAC_SECRET,
      ...{ email },
    });
  }, 60_000);

  afterEach(() => {
    failRateLimitStore = false;
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await app.close();
  }, 60_000);

  function store() {
    return createResetTokenStore({ authPool, withUserLock: createWithUserLock(authPool) });
  }

  async function createAccount(): Promise<{ email: string; userId: string }> {
    const suffix = randomUUID();
    const email = `confirm-${suffix}@example.test`;
    const tenant = await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: 'Confirm User',
      email,
      password: TEST_PASSWORD,
      organizationName: `Confirm Org ${suffix}`,
      organizationSlug: `confirm-${suffix}`,
      ip: randomIp(),
    });
    return { email, userId: tenant.userId };
  }

  async function postRaw(
    payload: string,
    overrides: { ip?: string; headers?: Record<string, string> } = {},
  ): Promise<Answer> {
    const response = await app.app.inject({
      method: 'POST',
      url: CONFIRM_PATH,
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        'x-csrf-token': 'orpc',
        'x-forwarded-for': overrides.ip ?? randomIp(),
        ...overrides.headers,
      },
      payload,
    });
    let body: unknown;
    try {
      body = response.json();
    } catch {
      body = response.body;
    }
    return {
      status: response.statusCode,
      body,
      cacheControl: response.headers['cache-control'],
      pragma: response.headers['pragma'],
      retryAfter: response.headers['retry-after'],
    };
  }

  function post(
    fields: Record<string, unknown>,
    overrides: { ip?: string; headers?: Record<string, string> } = {},
  ): Promise<Answer> {
    return postRaw(JSON.stringify({ newPassword: NEW_PASSWORD, ...fields }), overrides);
  }

  function expectNotCacheable(answer: Answer): void {
    expect(String(answer.cacheControl)).toContain('no-store');
    expect(answer.pragma).toBe('no-cache');
  }

  describe('Every token problem looks the same', () => {
    it('an unknown id, a wrong token, an expired token, a used token and a banned account answer the same status, code and body shape', async () => {
      const real = await createAccount();
      const issued = await store().issue(real.userId);

      const expiredAccount = await createAccount();
      const expiredIssued = await store().issue(expiredAccount.userId);
      await authPool.query(
        `update auth.verification set expires_at = now() - interval '1 second'
          where identifier = $1`,
        [`password-reset:${expiredIssued.id}`],
      );

      const usedAccount = await createAccount();
      const usedIssued = await store().issue(usedAccount.userId);
      expect(await store().consume(usedIssued.id, authPool)).toBe('consumed');

      const bannedAccount = await createAccount();
      const bannedIssued = await store().issue(bannedAccount.userId);
      await authPool.query('update auth."user" set banned = true where id = $1', [
        bannedAccount.userId,
      ]);

      const unknownId = await post({ id: randomId(), token: randomToken() });
      const wrongToken = await post({ id: issued.id, token: randomToken() });
      const expired = await post({ id: expiredIssued.id, token: expiredIssued.token });
      const used = await post({ id: usedIssued.id, token: usedIssued.token });
      const banned = await post({ id: bannedIssued.id, token: bannedIssued.token });

      expect(unknownId.status).toBe(404);
      expect(unknownId.body).toMatchObject({ code: 'CATALOG_NOT_FOUND' });
      const expected = shapeOf(unknownId);
      expect(shapeOf(wrongToken)).toEqual(expected);
      expect(shapeOf(expired)).toEqual(expected);
      expect(shapeOf(used)).toEqual(expected);
      expect(shapeOf(banned)).toEqual(expected);
    });

    it('a rejected token is not consumed by the refusal of a wrong token (the real token still reaches past the uniform rejection)', async () => {
      const account = await createAccount();
      const issued = await store().issue(account.userId);

      const wrong = await post({ id: issued.id, token: randomToken() });
      const right = await post({ id: issued.id, token: issued.token });

      expect(wrong.status).toBe(404);
      // Past the cheap checks, the lookup, the eligibility re-check: not a refusal of this family.
      expect([400, 404, 429]).not.toContain(right.status);
    });
  });

  describe('Cheap checks run first', () => {
    const cases: readonly { readonly name: string; readonly payload: () => string }[] = [
      {
        name: 'an oversized newPassword (513 code units)',
        payload: () =>
          JSON.stringify({ id: randomId(), token: randomToken(), newPassword: 'a'.repeat(513) }),
      },
      {
        name: 'an oversized token (44 characters)',
        payload: () =>
          JSON.stringify({ id: randomId(), token: `${randomToken()}A`, newPassword: NEW_PASSWORD }),
      },
      {
        name: 'an oversized id (23 characters)',
        payload: () =>
          JSON.stringify({ id: `${randomId()}A`, token: randomToken(), newPassword: NEW_PASSWORD }),
      },
      {
        name: 'an oversized factor code (33 characters)',
        payload: () =>
          JSON.stringify({
            id: randomId(),
            token: randomToken(),
            newPassword: NEW_PASSWORD,
            factor: { kind: 'totp', code: '1'.repeat(33) },
          }),
      },
      {
        name: 'an unknown field',
        payload: () =>
          JSON.stringify({
            id: randomId(),
            token: randomToken(),
            newPassword: NEW_PASSWORD,
            extra: 1,
          }),
      },
      {
        name: 'a constructor key',
        payload: () =>
          `{"id":"${randomId()}","token":"${randomToken()}","newPassword":"${NEW_PASSWORD}","constructor":{"prototype":{"polluted":true}}}`,
      },
      {
        name: 'a nested __proto__ key',
        payload: () =>
          `{"id":"${randomId()}","token":"${randomToken()}","newPassword":"${NEW_PASSWORD}","factor":{"kind":"totp","code":"123456","__proto__":{"polluted":true}}}`,
      },
    ];

    for (const { name, payload } of cases) {
      it(`${name}: CATALOG_VALIDATION_FAILED, no database lookup, no breached-password lookup`, async () => {
        const rangeLookups: string[] = [];
        vi.stubGlobal('fetch', (input: string | URL | Request): Promise<Response> => {
          rangeLookups.push(
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
          );
          return Promise.resolve(new Response('', { status: 200 }));
        });
        const before = statements.length;

        const answer = await postRaw(payload());

        expect(answer.status).toBe(400);
        expect(answer.body).toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });
        const lookups = statements.slice(before).filter((sql) => ACCOUNT_TABLES.test(sql));
        expect(lookups, 'no statement touched the account or verification tables').toEqual([]);
        expect(rangeLookups, 'no breached-password lookup').toEqual([]);
      });
    }

    it('control: a well-formed request does look the token up, so the observation above is not vacuous', async () => {
      const before = statements.length;

      const answer = await post({ id: randomId(), token: randomToken() });

      expect(answer.status).toBe(404);
      const lookups = statements.slice(before).filter((sql) => ACCOUNT_TABLES.test(sql));
      expect(lookups.length).toBeGreaterThan(0);
    });
  });

  describe('Reset responses are not cacheable (confirm route)', () => {
    it('the uniform rejection (404): Cache-Control: no-store and Pragma: no-cache', async () => {
      const answer = await post({ id: randomId(), token: randomToken() });

      expect(answer.status).toBe(404);
      expectNotCacheable(answer);
    });

    it('the malformed 400: Cache-Control: no-store and Pragma: no-cache', async () => {
      const answer = await postRaw(JSON.stringify({ id: 12_345 }));

      expect(answer.status).toBe(400);
      expect(answer.body).toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });
      expectNotCacheable(answer);
    });

    it('a valid token past the checks: Cache-Control: no-store and Pragma: no-cache, whatever its status', async () => {
      const account = await createAccount();
      const issued = await store().issue(account.userId);

      const answer = await post({ id: issued.id, token: issued.token });

      expect([400, 404, 429]).not.toContain(answer.status);
      expectNotCacheable(answer);
    });

    it('the limiter 429: AUTH_RATE_LIMITED with Retry-After, Cache-Control: no-store and Pragma: no-cache', async () => {
      const ip = randomIp();
      for (let index = 0; index < 10; index += 1) {
        const admitted = await post({ id: randomId(), token: randomToken() }, { ip });
        expect(admitted.status, `request ${String(index + 1)}`).toBe(404);
      }

      const limited = await post({ id: randomId(), token: randomToken() }, { ip });

      expect(limited.status).toBe(429);
      expect(limited.body).toMatchObject({ code: 'AUTH_RATE_LIMITED' });
      expect(limited.retryAfter).toBeDefined();
      expectNotCacheable(limited);
    });

    it('the fail-closed 500 (the limiter store throws): Cache-Control: no-store and Pragma: no-cache', async () => {
      const account = await createAccount();
      const issued = await store().issue(account.userId);
      failRateLimitStore = true;
      const before = statements.length;

      const answer = await post({ id: issued.id, token: issued.token });

      expect(answer.status).toBe(500);
      expectNotCacheable(answer);
      const lookups = statements.slice(before).filter((sql) => ACCOUNT_TABLES.test(sql));
      expect(lookups, 'no lookup runs when the limiter fails').toEqual([]);
    });
  });

  /**
   * Task 8.4: scenario "A cross-site confirmation is rejected the same way" (WHEN a valid token is
   * submitted without the `x-csrf-token` header, or from an `Origin` that is not allowed; THEN the
   * answer is the uniform rejection and the token is not consumed). Design D2: the check runs after
   * the limiter and before any lookup; the reasons `csrf_rejected` / `origin_rejected` are internal.
   */
  describe('A cross-site confirmation is rejected the same way (task 8.4)', () => {
    async function postWithHeaders(
      fields: Record<string, unknown>,
      headers: Record<string, string>,
    ): Promise<Answer> {
      const response = await app.app.inject({
        method: 'POST',
        url: CONFIRM_PATH,
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': randomIp(),
          ...headers,
        },
        payload: JSON.stringify({ newPassword: NEW_PASSWORD, ...fields }),
      });
      let body: unknown;
      try {
        body = response.json();
      } catch {
        body = response.body;
      }
      return {
        status: response.statusCode,
        body,
        cacheControl: response.headers['cache-control'],
        pragma: response.headers['pragma'],
        retryAfter: response.headers['retry-after'],
      };
    }

    async function tokenRowCount(id: string): Promise<number> {
      const result = await authPool.query('select 1 from auth.verification where identifier = $1', [
        `password-reset:${id}`,
      ]);
      return result.rowCount ?? 0;
    }

    const cases: readonly {
      readonly name: string;
      readonly headers: Record<string, string>;
    }[] = [
      { name: 'no x-csrf-token header', headers: { origin: ORIGIN } },
      { name: 'a wrong x-csrf-token value', headers: { origin: ORIGIN, 'x-csrf-token': 'nope' } },
      { name: 'no Origin header', headers: { 'x-csrf-token': 'orpc' } },
      {
        name: 'an Origin that is not allowed',
        headers: { origin: 'https://evil.example', 'x-csrf-token': 'orpc' },
      },
      {
        name: 'neither the header nor an allowed Origin',
        headers: { origin: 'https://evil.example' },
      },
    ];

    for (const { name, headers } of cases) {
      it(`${name}: the uniform rejection, no lookup, the token is not consumed and still works afterwards`, async () => {
        const account = await createAccount();
        const issued = await store().issue(account.userId);
        const unknown = await post({ id: randomId(), token: randomToken() });
        const before = statements.length;

        const answer = await postWithHeaders({ id: issued.id, token: issued.token }, headers);

        expect(answer.status).toBe(404);
        expect(answer.body).toMatchObject({ code: 'CATALOG_NOT_FOUND' });
        expect(shapeOf(answer)).toEqual(shapeOf(unknown));
        expectNotCacheable(answer);
        const lookups = statements.slice(before).filter((sql) => ACCOUNT_TABLES.test(sql));
        expect(lookups, 'rejected before any lookup').toEqual([]);
        expect(await tokenRowCount(issued.id), 'the token row is untouched').toBe(1);

        const retry = await post({ id: issued.id, token: issued.token });
        expect([400, 404, 429]).not.toContain(retry.status);
      });
    }
  });

  /**
   * Task 8.5 (design D6 "What enrolled means, failing closed", "Enrolled and no factor in the body";
   * D2 order of work): scenarios "The link alone does not change an enrolled user's password" and
   * "An inconsistent factor state fails closed" of `specs/password-reset-and-account-recovery/spec.md`.
   *
   * - GIVEN a user with TOTP enrolled and a valid token; WHEN the token and a new password are
   *   submitted without a factor; THEN the answer is `AUTH_STEP_UP_REQUIRED`, the password is
   *   unchanged and the token is still valid.
   * - GIVEN a user whose `twoFactorEnabled` is true but who has no verified `twoFactor` row (or the
   *   reverse), and a valid token; WHEN the token and a compliant password are submitted, with or
   *   without a factor; THEN the answer is `AUTH_STEP_UP_REQUIRED`, the password is unchanged, the
   *   token is not consumed and no failure is counted.
   *
   * Expected production behavior: the confirm route answers `403 AUTH_STEP_UP_REQUIRED` from the
   * enrolled predicate of D6 (`globalTwoFactorStateOf`) before the password policy, the breach check
   * and the lock. The factor rows are seeded raw (the route refuses before decrypting anything).
   */
  describe('The factor gate and the enrolled predicate (task 8.5)', () => {
    const FACTOR = { kind: 'totp', code: '123456' } as const;

    async function seedTwoFactor(userId: string, verified: boolean): Promise<string> {
      const id = `tf-${randomUUID()}`;
      await authPool.query(
        `insert into auth.two_factor (id, secret, backup_codes, user_id, verified, failed_verification_count)
         values ($1, $2, $3, $4, $5, 0)`,
        [id, `enc-secret-${id}`, `enc-codes-${id}`, userId, verified],
      );
      return id;
    }

    async function setFlag(userId: string, enabled: boolean): Promise<void> {
      await authPool.query('update auth."user" set two_factor_enabled = $2 where id = $1', [
        userId,
        enabled,
      ]);
    }

    async function passwordHash(userId: string): Promise<string> {
      const result = await authPool.query<{ password: string | null }>(
        `select password from auth.account where user_id = $1 and provider_id = 'credential'`,
        [userId],
      );
      return result.rows[0]?.password ?? '';
    }

    async function twoFactorCounters(
      id: string,
    ): Promise<{ failed: number | null; lockedUntil: Date | null; backupCodes: string }> {
      const result = await authPool.query<{
        failed: number | null;
        locked_until: Date | null;
        backup_codes: string;
      }>(
        'select failed_verification_count as failed, locked_until, backup_codes from auth.two_factor where id = $1',
        [id],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error('expected the two_factor row');
      return { failed: row.failed, lockedUntil: row.locked_until, backupCodes: row.backup_codes };
    }

    async function expectRefusedUntouched(
      userId: string,
      tokenId: string,
      token: string,
      fields: Record<string, unknown>,
      twoFactorId: string | undefined,
    ): Promise<void> {
      const hashBefore = await passwordHash(userId);
      const countersBefore =
        twoFactorId === undefined ? undefined : await twoFactorCounters(twoFactorId);

      const answer = await post({ id: tokenId, token, ...fields });

      expect(answer.status).toBe(403);
      expect(answer.body).toMatchObject({ code: 'AUTH_STEP_UP_REQUIRED' });
      expectNotCacheable(answer);
      expect(await passwordHash(userId), 'the password is unchanged').toBe(hashBefore);
      const lookup = await store().lookup(tokenId, token);
      expect(lookup, 'the token is not consumed and no failure is counted').toEqual({
        status: 'found',
        userId,
        failures: 0,
      });
      if (twoFactorId !== undefined) {
        expect(await twoFactorCounters(twoFactorId), 'no account failure is counted').toEqual(
          countersBefore,
        );
      }
    }

    it('The link alone does not change an enrolled user: no factor answers AUTH_STEP_UP_REQUIRED, the password is unchanged and the token is still valid', async () => {
      const account = await createAccount();
      const twoFactorId = await seedTwoFactor(account.userId, true);
      await setFlag(account.userId, true);
      const issued = await store().issue(account.userId);

      await expectRefusedUntouched(account.userId, issued.id, issued.token, {}, twoFactorId);
    });

    it('the enrolled fast fail runs before the password policy: a non-compliant password without a factor still answers AUTH_STEP_UP_REQUIRED', async () => {
      const account = await createAccount();
      const twoFactorId = await seedTwoFactor(account.userId, true);
      await setFlag(account.userId, true);
      const issued = await store().issue(account.userId);

      await expectRefusedUntouched(
        account.userId,
        issued.id,
        issued.token,
        { newPassword: 'short' },
        twoFactorId,
      );
    });

    it('the enrolled fast fail makes no breached-password lookup', async () => {
      const account = await createAccount();
      await seedTwoFactor(account.userId, true);
      await setFlag(account.userId, true);
      const issued = await store().issue(account.userId);
      const rangeLookups: string[] = [];
      vi.stubGlobal('fetch', (input: string | URL | Request): Promise<Response> => {
        rangeLookups.push(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        return Promise.resolve(new Response('', { status: 200 }));
      });

      const answer = await post({ id: issued.id, token: issued.token });

      expect(answer.status).toBe(403);
      expect(rangeLookups).toEqual([]);
    });

    it('control: a user with no factor and no flag is not refused by the gate (the link is enough)', async () => {
      const account = await createAccount();
      const issued = await store().issue(account.userId);

      const answer = await post({ id: issued.id, token: issued.token });

      expect(answer.body).not.toMatchObject({ code: 'AUTH_STEP_UP_REQUIRED' });
    });

    const inconsistent: readonly {
      readonly name: string;
      readonly flag: boolean;
      readonly row: 'none' | 'unverified' | 'verified';
    }[] = [
      { name: 'the flag is on and there is no two_factor row', flag: true, row: 'none' },
      { name: 'the flag is on and the only row is unverified', flag: true, row: 'unverified' },
      { name: 'a verified row exists and the flag is off', flag: false, row: 'verified' },
    ];

    for (const { name, flag, row } of inconsistent) {
      for (const withFactor of [false, true]) {
        it(`An inconsistent factor state fails closed: ${name}, ${withFactor ? 'with' : 'without'} a factor`, async () => {
          const account = await createAccount();
          const twoFactorId =
            row === 'none' ? undefined : await seedTwoFactor(account.userId, row === 'verified');
          await setFlag(account.userId, flag);
          const issued = await store().issue(account.userId);

          await expectRefusedUntouched(
            account.userId,
            issued.id,
            issued.token,
            withFactor ? { factor: FACTOR } : {},
            twoFactorId,
          );
        });
      }
    }

    it('an enrolment still in progress (flag off, only an unverified row) counts as not enrolled: the gate does not refuse', async () => {
      const account = await createAccount();
      await seedTwoFactor(account.userId, false);
      await setFlag(account.userId, false);
      const issued = await store().issue(account.userId);

      const answer = await post({ id: issued.id, token: issued.token });

      expect(answer.body).not.toMatchObject({ code: 'AUTH_STEP_UP_REQUIRED' });
    });
  });

  /**
   * Task 8.6 (design D7 "Before taking any lock or consuming anything", Q19): scenarios "A weak
   * password is refused and the token survives", "A breached password is refused and the token
   * survives", "A breached password in a decomposed form is refused" and "A breach-service outage
   * does not burn the token" of `specs/password-reset-and-account-recovery/spec.md`.
   *
   * Expected production behavior: after the cheap checks, the token lookup and the eligibility
   * re-check, the route runs `validatePassword` and then the breached-password check (on the NFC
   * form) before the per-user lock, the factor and the consumption. A policy or breach refusal
   * answers `400 CATALOG_VALIDATION_FAILED` naming only the rule; an unreachable range service answers
   * the sanitized `500 INTERNAL`. In every case the password hash and the token row are unchanged
   * and no advisory lock statement runs. That the same token then completes a reset is task 8.9.
   */
  describe('Password policy and breached-password check before any lock (task 8.6)', () => {
    const BREACHED_NFC = 'Crème-Brûlée-Battery-Staple-2026!';
    const BREACHED_NFD = BREACHED_NFC.normalize('NFD');

    function sha1Upper(value: string): string {
      return createHash('sha1').update(value).digest('hex').toUpperCase();
    }

    /** The range service: decoys plus the SHA-1 suffix of every given (NFC) password. */
    function stubRangeService(breached: readonly string[]): string[] {
      const urls: string[] = [];
      vi.stubGlobal('fetch', (input: string | URL | Request): Promise<Response> => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        urls.push(url);
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
      return urls;
    }

    async function passwordHash(userId: string): Promise<string> {
      const result = await authPool.query<{ password: string | null }>(
        `select password from auth.account where user_id = $1 and provider_id = 'credential'`,
        [userId],
      );
      return result.rows[0]?.password ?? '';
    }

    async function tokenRow(id: string): Promise<unknown> {
      const result = await authPool.query(
        'select id, identifier, value, expires_at from auth.verification where identifier = $1',
        [`password-reset:${id}`],
      );
      return result.rows;
    }

    async function expectNothingChanged(
      account: { userId: string },
      issued: { id: string; token: string },
      attempt: () => Promise<Answer>,
    ): Promise<Answer> {
      const hashBefore = await passwordHash(account.userId);
      const rowBefore = await tokenRow(issued.id);
      expect(rowBefore).toHaveLength(1);
      const before = statements.length;

      const answer = await attempt();

      expect(await passwordHash(account.userId), 'the password is unchanged').toBe(hashBefore);
      expect(await tokenRow(issued.id), 'the token row is unchanged').toEqual(rowBefore);
      expect(await store().lookup(issued.id, issued.token)).toEqual({
        status: 'found',
        userId: account.userId,
        failures: 0,
      });
      expect(
        statements.slice(before).filter((sql) => /pg_advisory/i.test(sql)),
        'no lock was taken',
      ).toEqual([]);
      expectNotCacheable(answer);
      return answer;
    }

    const weak: readonly { readonly rule: string; readonly password: string }[] = [
      { rule: 'length', password: 'Short-1!' },
      { rule: 'uppercase', password: 'all-lowercase-passphrase-77!' },
      { rule: 'lowercase', password: 'ALL-UPPERCASE-PASSPHRASE-77!' },
      { rule: 'digit', password: 'No-Digits-In-This-Passphrase!' },
      { rule: 'symbol', password: 'NoSymbolsInThisPassphrase77' },
    ];

    for (const { rule, password } of weak) {
      it(`A weak password is refused and the token survives: failing the ${rule} rule answers CATALOG_VALIDATION_FAILED naming only the rule`, async () => {
        const account = await createAccount();
        const issued = await store().issue(account.userId);
        const rangeLookups = stubRangeService([]);

        const answer = await expectNothingChanged(account, issued, () =>
          post({ id: issued.id, token: issued.token, newPassword: password }),
        );

        expect(answer.status).toBe(400);
        expect(answer.body).toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });
        const text = JSON.stringify(answer.body);
        expect(text).toContain(rule);
        expect(text).not.toContain(password);
        expect(rangeLookups, 'the policy runs before the breach lookup').toEqual([]);
      });
    }

    it('A breached password is refused and the token survives', async () => {
      const account = await createAccount();
      const issued = await store().issue(account.userId);
      const rangeLookups = stubRangeService([BREACHED_NFC]);

      const answer = await expectNothingChanged(account, issued, () =>
        post({ id: issued.id, token: issued.token, newPassword: BREACHED_NFC }),
      );

      expect(answer.status).toBe(400);
      expect(answer.body).toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });
      expect(JSON.stringify(answer.body)).not.toContain(BREACHED_NFC);
      expect(rangeLookups.length, 'the range service was asked').toBeGreaterThan(0);
    });

    it('A breached password in a decomposed form is refused', async () => {
      expect(BREACHED_NFD).not.toBe(BREACHED_NFC);
      const account = await createAccount();
      const issued = await store().issue(account.userId);
      stubRangeService([BREACHED_NFC]);

      const answer = await expectNothingChanged(account, issued, () =>
        post({ id: issued.id, token: issued.token, newPassword: BREACHED_NFD }),
      );

      expect(answer.status).toBe(400);
      expect(answer.body).toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });
      expect(JSON.stringify(answer.body)).not.toContain(BREACHED_NFD);
    });

    it('control: a compliant password that is not in the corpus is not refused by the policy or the breach check', async () => {
      const account = await createAccount();
      const issued = await store().issue(account.userId);
      stubRangeService([BREACHED_NFC]);

      const answer = await post({ id: issued.id, token: issued.token });

      expect(answer.status).not.toBe(400);
      expect(answer.body).not.toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });
    });

    it('A breach-service outage does not burn the token: a sanitized internal error, the password and the token unchanged', async () => {
      const account = await createAccount();
      const issued = await store().issue(account.userId);
      vi.stubGlobal('fetch', (): Promise<Response> => {
        return Promise.reject(
          new TypeError('fetch failed: getaddrinfo ENOTFOUND provider-detail.example'),
        );
      });

      const answer = await expectNothingChanged(account, issued, () =>
        post({ id: issued.id, token: issued.token }),
      );

      expect(answer.status).toBe(500);
      expect(answer.body).toMatchObject({ code: 'INTERNAL' });
      const text = JSON.stringify(answer.body);
      expect(text).not.toContain('provider-detail');
      expect(text).not.toContain('ENOTFOUND');
      expect(text).not.toContain(NEW_PASSWORD);
    });
  });
});
