/**
 * Integration test for task 7.1 of `openspec/changes/048-production-hardening` (design D7,
 * Resolved decision Q11), extending the `002` task 11.13 suite of the same file.
 *
 * Scenarios (verbatim from `specs/auth-and-rbac/spec.md` of the change, MODIFIED requirement
 * "Pre-authentication rate limiting protects against credential stuffing"):
 *
 * "The token-exchange budget is shared across replicas"
 * - GIVEN two running replicas over the same database
 * - WHEN one caller address spends half of the token-exchange limit on each replica
 * - THEN its next exchange on either replica fails with `AUTH_RATE_LIMITED`
 *
 * "Machine token exchange is rate-limited independently of the authenticated bucket"
 * - GIVEN a caller who has exceeded the configured attempt limit for `POST /v1/auth/token`
 *   keyed by their IP and client id
 * - WHEN they attempt another token exchange
 * - THEN it fails with `AUTH_RATE_LIMITED`, regardless of any authenticated-actor rate-limit
 *   bucket's state
 *
 * Requirement text: "`POST /v1/auth/token` MUST be separately rate-limited, keyed by both the
 * caller's IP address and the submitted client id, each in its own bucket of the same shared
 * storage ...; a varying client id MUST NOT open a fresh address bucket." "Exceeding any of
 * these limits MUST fail with `AUTH_RATE_LIMITED` and a `Retry-After` header". (The client-id
 * bucket is task 7.2; this task covers the address bucket.)
 *
 * Design D7: the in-memory `app.createRateLimit` is replaced by a pre-handler over
 * `createRateLimitBucketStore` (the `auth.rate_limit` table, hashed keys). It consumes the
 * `token_exchange` bucket, kind `ip`, value `clientIpKey(request.ip)`. A refusal answers the
 * existing `AUTH_RATE_LIMITED` 429 with `Retry-After`; a store error answers the sanitized
 * `INTERNAL` 500, like the accept limiter (`044` D16).
 *
 * ## Harness
 *
 * Two `createApp` instances (D15: "the replica-sharing tests (D7) build two `createApp`
 * instances over one database") over the harness pools, injected requests only. Each test
 * uses fresh random client addresses (`X-Forwarded-For` from the loopback peer, trusted by
 * `TEST_TRUST_PROXY`), so tests never share a bucket. The first replica's `tayzu_auth` pool is
 * wrapped so that, while a flag is on, any statement touching `rate_limit` throws an error
 * carrying a marker string (the pattern of `password-reset-limits.http.int.test.ts`); the same
 * wrapper records statements, so "no credential lookup" is observed on `apikey` statements, with
 * a control that an admitted exchange performs one.
 *
 * ## Production symbols expected
 *
 * - `CreateAppOptions.tokenExchangeRateLimit?: { max: number; timeWindowMs: number }` (existing
 *   option) now configures the `token_exchange` rule of the DB-backed store.
 * - The 429 body stays the mapped `AUTH_RATE_LIMITED` error the current endpoint sends
 *   (`new ORPCError('AUTH_RATE_LIMITED', { status: 429, message: 'Too many requests' }).toJSON()`)
 *   and `Retry-After` stays a positive integer number of seconds within the window.
 *
 * ## Why this fails right now
 *
 * The limiter is per-replica memory: two requests on each replica leave each replica's bucket at
 * half the budget, so the fifth exchange is not refused; no `auth.rate_limit` row is written; a
 * failing `rate_limit` statement is never reached, so the exchange is served instead of the 500.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { ORPCError } from '@orpc/server';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bootstrapTestTenant,
  testAppPool,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { hashBucketKey } from '../../../packages/auth/src/rate-limit/pre-auth-rate-limit.js';
import { csrfHeaders } from './__fixtures__/csrf.js';
import { enrolledAdminSession } from './__fixtures__/fresh-mfa.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createApp, type App } from './server.js';

const TEST_PASSWORD = 'correct horse battery staple';
const ALLOWED_ORIGIN = 'https://app.tayzu.test';
/** Even, so that "half of the limit on each replica" is exact. */
const TOKEN_MAX = 4;
const TOKEN_WINDOW_MS = 60_000;
const AUTHENTICATED_MAX = 2;
const RATE_LIMIT_TABLE = /rate_limit/i;
const CREDENTIAL_TABLE = /apikey/i;
const STORE_FAILURE_MARKER = 'token-exchange-store-secret-marker-5c21d8';

/** The body the current endpoint answers over budget (`server.ts`, the `limited` error). */
const EXPECTED_LIMITED_BODY: unknown = JSON.parse(
  JSON.stringify(
    new ORPCError('AUTH_RATE_LIMITED', { status: 429, message: 'Too many requests' }).toJSON(),
  ),
);

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

type QueryFunction = (...args: unknown[]) => unknown;

function statementText(first: unknown): string {
  if (typeof first === 'string') return first;
  if (typeof first === 'object' && first !== null && 'text' in first) {
    return typeof first.text === 'string' ? first.text : '';
  }
  return '';
}

/** Wraps a pool (and its clients) so every statement's text is seen by `observe` first. */
function spyOnPool(pool: Pool, observe: (sql: string) => void): Pool {
  const spyOnClient = (client: PoolClient): PoolClient =>
    new Proxy(client, {
      get(target, property): unknown {
        const value: unknown = Reflect.get(target, property, target);
        if (property === 'query') {
          return (...args: unknown[]): unknown => {
            observe(statementText(args[0]));
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
          observe(statementText(args[0]));
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

describe('apps/api POST /v1/auth/token shared address rate limit (048 task 7.1, design D7)', () => {
  let replicaA: App;
  let replicaB: App;
  let ownerPool: Pool;
  const statementsA: string[] = [];
  const flagsA = { failStore: false };

  function exchange(app: App, clientId: string, ip: string) {
    return app.app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      headers: {
        'content-type': 'application/json',
        origin: ALLOWED_ORIGIN,
        'x-forwarded-for': ip,
        ...csrfHeaders('POST'),
      },
      payload: JSON.stringify({ clientId, clientSecret: `wrong-secret-${randomUUID()}` }),
    });
  }

  function expectUnchangedLimitedAnswer(
    response: Awaited<ReturnType<typeof exchange>>,
    secrets: readonly string[],
  ): void {
    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual(EXPECTED_LIMITED_BODY);
    const header = response.headers['retry-after'];
    expect(typeof header).toBe('string');
    expect(String(header)).toMatch(/^[1-9]\d*$/);
    expect(Number(header)).toBeLessThanOrEqual(TOKEN_WINDOW_MS / 1000);
    for (const secret of secrets) {
      expect(response.body).not.toContain(secret);
      expect(JSON.stringify(response.headers)).not.toContain(secret);
    }
  }

  async function signInCookie(app: App): Promise<string> {
    const suffix = randomUUID();
    const tenant = await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: 'Token Rate Limit',
      email: `token-rate-limit-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Token Rate Limit Org ${suffix}`,
      organizationSlug: `token-rate-limit-org-${suffix}`,
      ip: randomIp(),
    });
    return (
      await enrolledAdminSession(app, tenant, { password: TEST_PASSWORD, origin: ALLOWED_ORIGIN })
    ).cookie;
  }

  async function bucketRows(ip: string): Promise<number> {
    const result = await ownerPool.query<{ count: string }>(
      'select count(*)::text as count from auth.rate_limit where key = $1',
      [hashBucketKey('token_exchange', 'ip', ip)],
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  beforeAll(async () => {
    const pools = await harnessPools();
    ownerPool = pools.authPool;
    const common = {
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ALLOWED_ORIGIN],
      rateLimit: { max: AUTHENTICATED_MAX, timeWindowMs: 60_000 },
      tokenExchangeRateLimit: { max: TOKEN_MAX, timeWindowMs: TOKEN_WINDOW_MS },
    };
    const spiedAuthPool = spyOnPool(pools.authPool, (sql) => {
      statementsA.push(sql);
      if (flagsA.failStore && RATE_LIMIT_TABLE.test(sql)) {
        throw new Error(`store down ${STORE_FAILURE_MARKER}`);
      }
    });
    replicaA = await createApp({ ...common, appPool: pools.appPool, authPool: spiedAuthPool });
    replicaB = await createApp({ ...common, appPool: pools.appPool, authPool: pools.authPool });
  }, 60_000);

  afterAll(async () => {
    await replicaA.close();
    await replicaB.close();
  }, 60_000);

  it('The token-exchange budget is shared across replicas', async () => {
    const ip = randomIp();
    const clientId = `client-${randomUUID()}`;

    // Half of the limit on each replica: never refused.
    for (let i = 0; i < TOKEN_MAX / 2; i += 1) {
      expect(
        (await exchange(replicaA, clientId, ip)).statusCode,
        `replica A, ${String(i)}`,
      ).not.toBe(429);
    }
    for (let i = 0; i < TOKEN_MAX / 2; i += 1) {
      expect(
        (await exchange(replicaB, clientId, ip)).statusCode,
        `replica B, ${String(i)}`,
      ).not.toBe(429);
    }

    // Its next exchange on either replica fails with AUTH_RATE_LIMITED, body and Retry-After unchanged.
    expectUnchangedLimitedAnswer(await exchange(replicaA, clientId, ip), [clientId, ip]);
    expectUnchangedLimitedAnswer(await exchange(replicaB, clientId, ip), [clientId, ip]);

    // The budget lives in the shared store, keyed by the address alone (hashed).
    expect(await bucketRows(ip), 'one shared token_exchange address bucket').toBe(1);

    // A varying client id does not open a fresh address bucket on either replica (002 Q56).
    expect((await exchange(replicaA, `client-${randomUUID()}`, ip)).statusCode).toBe(429);
    expect((await exchange(replicaB, `client-${randomUUID()}`, ip)).statusCode).toBe(429);

    // Another address is not affected.
    expect((await exchange(replicaB, clientId, randomIp())).statusCode).not.toBe(429);
  }, 120_000);

  it('Machine token exchange is rate-limited independently of the authenticated bucket', async () => {
    const ip = randomIp();
    const clientId = `client-${randomUUID()}`;

    for (let i = 0; i < TOKEN_MAX; i += 1) {
      expect((await exchange(replicaA, clientId, ip)).statusCode).not.toBe(429);
    }

    // Over the budget: refused, with no authenticated principal involved at all.
    expectUnchangedLimitedAnswer(await exchange(replicaA, clientId, ip), [clientId, ip]);
    expectUnchangedLimitedAnswer(await exchange(replicaB, clientId, ip), [clientId, ip]);
  }, 120_000);

  it('An exhausted authenticated-principal bucket does not limit token exchange, and vice versa', async () => {
    const cookie = await signInCookie(replicaA);
    const sharedIp = randomIp();

    // Exhaust the authenticated bucket (002 D13) for this principal on replica A.
    const probe = (cookieValue: string) =>
      replicaA.app.inject({
        method: 'GET',
        url: `/v1/blueprints/token-rate-limit-probe-${randomUUID()}`,
        headers: { cookie: cookieValue, origin: ALLOWED_ORIGIN, 'x-forwarded-for': sharedIp },
      });
    for (let i = 0; i < AUTHENTICATED_MAX; i += 1) {
      expect((await probe(cookie)).statusCode).toBe(404);
    }
    expect((await probe(cookie)).statusCode).toBe(429);

    // A token exchange from the same address is not affected by that bucket...
    const clientId = `client-${randomUUID()}`;
    for (let i = 0; i < TOKEN_MAX / 2; i += 1) {
      expect((await exchange(replicaA, clientId, sharedIp)).statusCode).not.toBe(429);
      expect((await exchange(replicaB, clientId, sharedIp)).statusCode).not.toBe(429);
    }
    // ...and is limited by its own shared bucket only.
    expectUnchangedLimitedAnswer(await exchange(replicaA, clientId, sharedIp), [
      clientId,
      sharedIp,
    ]);

    // A different, un-throttled principal's authenticated bucket is untouched by the exchange bucket.
    const freshCookie = await signInCookie(replicaA);
    expect((await probe(freshCookie)).statusCode).toBe(404);
  }, 120_000);

  it('A failing rate-limit store answers the sanitized 500 before any credential lookup', async () => {
    // Control: an admitted exchange does look the credential up.
    const controlBefore = statementsA.length;
    expect((await exchange(replicaA, `client-${randomUUID()}`, randomIp())).statusCode).not.toBe(
      429,
    );
    expect(
      statementsA.slice(controlBefore).some((sql) => CREDENTIAL_TABLE.test(sql)),
      'control: an admitted exchange queries the credential table',
    ).toBe(true);

    const ip = randomIp();
    const clientId = `client-${randomUUID()}`;
    flagsA.failStore = true;
    try {
      const before = statementsA.length;
      const answer = await exchange(replicaA, clientId, ip);

      expect(answer.statusCode).toBe(500);
      expect(answer.json()).toMatchObject({ code: 'INTERNAL', status: 500 });
      expect(answer.headers['retry-after']).toBeUndefined();
      expect(answer.body).not.toContain(STORE_FAILURE_MARKER);
      expect(answer.body).not.toContain('store down');
      expect(answer.body).not.toContain(clientId);
      expect(answer.body).not.toContain(ip);
      const since = statementsA.slice(before);
      expect(
        since.some((sql) => RATE_LIMIT_TABLE.test(sql)),
        'the store was consulted',
      ).toBe(true);
      expect(
        since.filter((sql) => CREDENTIAL_TABLE.test(sql)),
        'no credential lookup',
      ).toEqual([]);
    } finally {
      flagsA.failStore = false;
    }
  }, 120_000);
});
