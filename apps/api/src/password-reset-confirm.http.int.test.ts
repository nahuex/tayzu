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
import { randomBytes, randomInt, randomUUID } from 'node:crypto';

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
});
