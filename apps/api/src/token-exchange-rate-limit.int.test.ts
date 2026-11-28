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
 *
 * # Task 7.2 (design D7, Resolved decision Q21): the `token_exchange_client` bucket
 *
 * Scenario (verbatim from `specs/auth-and-rbac/spec.md` of the change):
 *
 * "One client id is limited across addresses"
 * - WHEN one client id is submitted from many addresses beyond its own limit
 * - THEN further exchanges for that client id fail with `AUTH_RATE_LIMITED`, and the client id
 *   reaches no signal
 *
 * Requirement text: "keyed by both the caller's IP address and the submitted client id, each in
 * its own bucket of the same shared storage ...; a varying client id MUST NOT open a fresh
 * address bucket." "Every rate-limit rejection MUST be recorded as a security log event and a
 * metric, neither of which carries the caller's IP address, email or client id."
 *
 * Design D7: the pre-handler consumes `token_exchange` (kind `ip`) and then, when the body's
 * client id passes the credential-id shape check (a string of at most 128 characters),
 * `token_exchange_client`, kind `client`, the client id. Either refusal answers the existing
 * `AUTH_RATE_LIMITED` 429 with `Retry-After`. `BucketKeyKind` gains `client`; `RateLimitScope`
 * gains `token_exchange_client`, which reaches `tayzu.auth.rate_limit.scope` (Telemetry
 * contract: `tayzu.auth.rate_limit.events` and `auth.security.rate_limited`). Keys are hashed
 * (`hashBucketKey`), so no `auth.rate_limit` key holds the client id in clear.
 *
 * ## Production symbols expected (task 7.2)
 *
 * - `CreateAppOptions.tokenExchangeClientRateLimit?: { max: number; timeWindowMs: number }`
 *   (ASSUMED name, mirroring `tokenExchangeRateLimit`; D7 names only the variables
 *   `TOKEN_EXCHANGE_CLIENT_RATE_LIMIT_*`) configures the `token_exchange_client` rule.
 * - `RateLimitScope` gains `'token_exchange_client'` and `BucketKeyKind` gains `'client'` (in
 *   `packages/auth/src/rate-limit/pre-auth-rate-limit.ts`); this file's
 *   `hashBucketKey('token_exchange_client', 'client', ...)` only typechecks once both exist.
 *
 * ## Harness (task 7.2)
 *
 * Two more `createApp` instances (replicas C and D) with a small client budget, so the 7.1
 * cases above keep their own configuration. Replica C's `tayzu_auth` pool records every
 * statement's text and bind values: the 64-hex bind values of the `rate_limit` statements of
 * one request are the bucket keys it consumed, so "counts the address bucket only" is observed
 * as "references no key but the address key", with a control (a well-shaped client id
 * references both keys). The telemetry test harness is registered before anything loads
 * `@tayzu/auth`, and every exported span, metric point and log record is searched for the
 * client id.
 *
 * ## Why the 7.2 cases fail right now
 *
 * Only the address bucket exists: one client id from fresh addresses is never refused, no
 * `token_exchange_client` row is written, no `token_exchange_client` signal is emitted, and a
 * well-shaped client id references the address key alone.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { ORPCError } from '@orpc/server';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Task 7.2: the telemetry harness registers while the module graph loads (design D1), so this
// import stays ahead of every import that loads `@tayzu/auth`.
import { registration, type TelemetryTestHarness } from './__fixtures__/link-telemetry.js';
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

/** The bind values of a `query(text, values)` or `query({ text, values })` call. */
function statementValues(args: readonly unknown[]): readonly unknown[] {
  const [first, second] = args;
  if (Array.isArray(second)) return second as unknown[];
  if (typeof first === 'object' && first !== null && 'values' in first) {
    return Array.isArray(first.values) ? (first.values as unknown[]) : [];
  }
  return [];
}

/** Wraps a pool (and its clients) so every statement's text and bind values are seen by `observe` first. */
function spyOnPool(pool: Pool, observe: (sql: string, values: readonly unknown[]) => void): Pool {
  const spyOnClient = (client: PoolClient): PoolClient =>
    new Proxy(client, {
      get(target, property): unknown {
        const value: unknown = Reflect.get(target, property, target);
        if (property === 'query') {
          return (...args: unknown[]): unknown => {
            observe(statementText(args[0]), statementValues(args));
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
          observe(statementText(args[0]), statementValues(args));
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

describe('apps/api POST /v1/auth/token shared client-id rate limit (048 task 7.2, design D7, Q21)', () => {
  /** The address budget, larger than the client budget so either refusal is told apart. */
  const ADDRESS_MAX = 5;
  const CLIENT_MAX = 3;
  const CLIENT_WINDOW_MS = 60_000;
  const RATE_LIMITED_EVENT = 'auth.security.rate_limited';
  const RATE_LIMIT_COUNTER = 'tayzu.auth.rate_limit.events';
  const SCOPE_ATTRIBUTE = 'tayzu.auth.rate_limit.scope';
  const HEX_KEY = /^[0-9a-f]{64}$/;
  /** The credential-id shape check of D7: a string of at most 128 characters. */
  const CLIENT_ID_MAX_LENGTH = 128;

  let replicaC: App;
  let replicaD: App;
  let ownerPool: Pool;
  let harness: TelemetryTestHarness;
  const rateLimitBindsC: { sql: string; values: readonly unknown[] }[] = [];

  function registeredHarness(): TelemetryTestHarness {
    if ('error' in registration) {
      throw new Error('the telemetry test harness failed to register', {
        cause: registration.error,
      });
    }
    return registration.harness;
  }

  function post(app: App, ip: string, body: Record<string, unknown>) {
    return app.app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      headers: {
        'content-type': 'application/json',
        origin: ALLOWED_ORIGIN,
        'x-forwarded-for': ip,
        ...csrfHeaders('POST'),
      },
      payload: JSON.stringify(body),
    });
  }

  function exchange(app: App, clientId: string, ip: string) {
    return post(app, ip, { clientId, clientSecret: `wrong-secret-${randomUUID()}` });
  }

  function expectLimitedAnswer(
    response: Awaited<ReturnType<typeof post>>,
    secrets: readonly string[],
  ): void {
    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual(EXPECTED_LIMITED_BODY);
    const header = response.headers['retry-after'];
    expect(typeof header).toBe('string');
    expect(String(header)).toMatch(/^[1-9]\d*$/);
    expect(Number(header)).toBeLessThanOrEqual(CLIENT_WINDOW_MS / 1000);
    for (const secret of secrets) {
      expect(response.body).not.toContain(secret);
      expect(JSON.stringify(response.headers)).not.toContain(secret);
    }
  }

  const addressKey = (ip: string): string => hashBucketKey('token_exchange', 'ip', ip);
  const clientKey = (clientId: string): string =>
    hashBucketKey('token_exchange_client', 'client', clientId);

  async function rowCount(key: string): Promise<{ rows: number; count: number | null }> {
    const result = await ownerPool.query<{ count: number }>(
      'select count from auth.rate_limit where key = $1',
      [key],
    );
    return { rows: result.rows.length, count: result.rows[0]?.count ?? null };
  }

  /** The bucket keys (64-hex bind values of `rate_limit` statements) one request on C consumed. */
  async function keysReferencedBy(request: () => Promise<unknown>): Promise<Set<string>> {
    const before = rateLimitBindsC.length;
    await request();
    const keys = new Set<string>();
    for (const { values } of rateLimitBindsC.slice(before)) {
      for (const value of values) {
        if (typeof value === 'string' && HEX_KEY.test(value)) keys.add(value);
      }
    }
    return keys;
  }

  /** Every exported span, metric point and log record, serialized for a substring search. */
  async function exportedSignals(): Promise<string> {
    await harness.forceFlush();
    const spans = harness.spanExporter.getFinishedSpans().map((span) => ({
      name: span.name,
      attributes: span.attributes,
      status: span.status,
      events: span.events.map((event) => ({ name: event.name, attributes: event.attributes })),
    }));
    const points = harness.metricExporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics)
      .map((metric) => ({
        name: metric.descriptor.name,
        points: (metric.dataPoints as readonly { attributes: unknown }[]).map(
          (point) => point.attributes,
        ),
      }));
    const logs = [...harness.logExporter.getFinishedLogRecords()].map((record) => ({
      eventName: record.eventName,
      body: record.body,
      attributes: record.attributes,
    }));
    return JSON.stringify({ spans, points, logs });
  }

  async function clientScopeLogs(): Promise<number> {
    await harness.forceFlush();
    return [...harness.logExporter.getFinishedLogRecords()].filter(
      (record) =>
        record.eventName === RATE_LIMITED_EVENT &&
        record.attributes[SCOPE_ATTRIBUTE] === 'token_exchange_client',
    ).length;
  }

  async function clientScopeCounterTotal(): Promise<number> {
    await harness.forceFlush();
    let total = 0;
    for (const resource of harness.metricExporter.getMetrics()) {
      for (const scope of resource.scopeMetrics) {
        for (const metric of scope.metrics) {
          if (metric.descriptor.name !== RATE_LIMIT_COUNTER) continue;
          for (const point of metric.dataPoints as readonly {
            attributes: Record<string, unknown>;
            value: unknown;
          }[]) {
            if (
              point.attributes[SCOPE_ATTRIBUTE] === 'token_exchange_client' &&
              typeof point.value === 'number'
            ) {
              total += point.value;
            }
          }
        }
      }
    }
    return total;
  }

  beforeAll(async () => {
    harness = registeredHarness();
    const pools = await harnessPools();
    ownerPool = pools.authPool;
    const common = {
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ALLOWED_ORIGIN],
      tokenExchangeRateLimit: { max: ADDRESS_MAX, timeWindowMs: TOKEN_WINDOW_MS },
      tokenExchangeClientRateLimit: { max: CLIENT_MAX, timeWindowMs: CLIENT_WINDOW_MS },
    };
    const spiedAuthPool = spyOnPool(pools.authPool, (sql, values) => {
      if (RATE_LIMIT_TABLE.test(sql)) rateLimitBindsC.push({ sql, values });
    });
    replicaC = await createApp({ ...common, appPool: pools.appPool, authPool: spiedAuthPool });
    replicaD = await createApp({ ...common, appPool: pools.appPool, authPool: pools.authPool });
  }, 60_000);

  afterAll(async () => {
    await replicaC.close();
    await replicaD.close();
  }, 60_000);

  it('One client id is limited across addresses', async () => {
    const clientId = `client-marker-${randomUUID()}`;
    const logsBefore = await clientScopeLogs();
    const counterBefore = await clientScopeCounterTotal();

    // WHEN one client id is submitted from many addresses (a fresh one each time, alternating
    // replicas) up to its own limit: every exchange is admitted.
    for (let i = 0; i < CLIENT_MAX; i += 1) {
      const response = await exchange(i % 2 === 0 ? replicaC : replicaD, clientId, randomIp());
      expect(response.statusCode, `exchange ${String(i + 1)}`).not.toBe(429);
    }

    // ...and beyond it: THEN further exchanges for that client id fail with AUTH_RATE_LIMITED
    // and Retry-After, from yet another fresh address, on either replica.
    const ipC = randomIp();
    const ipD = randomIp();
    expectLimitedAnswer(await exchange(replicaC, clientId, ipC), [clientId, ipC]);
    expectLimitedAnswer(await exchange(replicaD, clientId, ipD), [clientId, ipD]);

    // Each fresh address spent one hit of its own bucket: the refusal is the client bucket's.
    expect((await rowCount(addressKey(ipC))).count).toBe(1);

    // One shared client bucket, keyed by the hash of the client id.
    const bucket = await rowCount(clientKey(clientId));
    expect(bucket.rows, 'one shared token_exchange_client bucket').toBe(1);
    expect(bucket.count).toBe(CLIENT_MAX);

    // Another client id from a fresh address is not affected.
    expect((await exchange(replicaD, `client-${randomUUID()}`, randomIp())).statusCode).not.toBe(
      429,
    );

    // The refusals are recorded as the security log event and the metric, under the new scope.
    expect((await clientScopeLogs()) - logsBefore).toBe(2);
    expect((await clientScopeCounterTotal()) - counterBefore).toBe(2);
    const logs = [...harness.logExporter.getFinishedLogRecords()].filter(
      (record) =>
        record.eventName === RATE_LIMITED_EVENT &&
        record.attributes[SCOPE_ATTRIBUTE] === 'token_exchange_client',
    );
    for (const record of logs) {
      expect(record.attributes).toEqual({ [SCOPE_ATTRIBUTE]: 'token_exchange_client' });
    }

    // AND the client id reaches no signal: no span, metric point or log record carries it.
    expect(await exportedSignals()).not.toContain(clientId);

    // No auth.rate_limit key holds the client id in clear.
    const clear = await ownerPool.query<{ count: string }>(
      'select count(*)::text as count from auth.rate_limit where position($1 in key) > 0',
      [clientId],
    );
    expect(clear.rows[0]?.count).toBe('0');
  }, 120_000);

  it('A varying client id from one address is still limited by the address bucket', async () => {
    const ip = randomIp();
    const clientIds = Array.from({ length: ADDRESS_MAX }, () => `client-${randomUUID()}`);

    // A fresh client id on every exchange, alternating replicas, up to the address budget.
    for (const [index, clientId] of clientIds.entries()) {
      const response = await exchange(index % 2 === 0 ? replicaC : replicaD, clientId, ip);
      expect(response.statusCode, `exchange ${String(index + 1)}`).not.toBe(429);
    }

    // Every admitted, well-shaped client id was counted in its own client bucket...
    for (const clientId of clientIds) {
      expect(await rowCount(clientKey(clientId)), clientId).toEqual({ rows: 1, count: 1 });
    }

    // ...yet a varying client id never opens a fresh address bucket: the next one is refused.
    const nextC = `client-${randomUUID()}`;
    const nextD = `client-${randomUUID()}`;
    expectLimitedAnswer(await exchange(replicaC, nextC, ip), [nextC, ip]);
    expectLimitedAnswer(await exchange(replicaD, nextD, ip), [nextD, ip]);
    expect(await rowCount(addressKey(ip))).toEqual({ rows: 1, count: ADDRESS_MAX });
  }, 120_000);

  describe('an oversized or missing client id counts the address bucket only', () => {
    it('control: a well-shaped client id of exactly 128 characters counts both buckets', async () => {
      const ip = randomIp();
      const clientId = `client-${randomUUID()}`.padEnd(CLIENT_ID_MAX_LENGTH, 'x');
      expect(clientId).toHaveLength(CLIENT_ID_MAX_LENGTH);

      const keys = await keysReferencedBy(() => exchange(replicaC, clientId, ip));

      expect([...keys].sort()).toEqual([addressKey(ip), clientKey(clientId)].sort());
      expect(await rowCount(clientKey(clientId))).toEqual({ rows: 1, count: 1 });
      expect(await rowCount(addressKey(ip))).toEqual({ rows: 1, count: 1 });
    }, 120_000);

    const SHAPES: readonly {
      readonly name: string;
      readonly body: (marker: string) => Record<string, unknown>;
      readonly clientId: (marker: string) => string | undefined;
    }[] = [
      {
        name: 'an oversized client id (129 characters)',
        body: (marker) => ({
          clientId: marker.padEnd(CLIENT_ID_MAX_LENGTH + 1, 'x'),
          clientSecret: `wrong-secret-${randomUUID()}`,
        }),
        clientId: (marker) => marker.padEnd(CLIENT_ID_MAX_LENGTH + 1, 'x'),
      },
      {
        name: 'a missing client id',
        body: () => ({ clientSecret: `wrong-secret-${randomUUID()}` }),
        clientId: () => undefined,
      },
      {
        name: 'a client id that is not a string',
        body: () => ({ clientId: 12_345, clientSecret: `wrong-secret-${randomUUID()}` }),
        clientId: () => undefined,
      },
    ];

    it.each(SHAPES)(
      '$name is counted by the address bucket and opens no client bucket',
      async ({ body, clientId }) => {
        const ip = randomIp();
        const marker = `client-${randomUUID()}`;

        // Up to the address budget: each request is counted by the address bucket alone.
        for (let i = 0; i < ADDRESS_MAX; i += 1) {
          const keys = await keysReferencedBy(() => post(replicaC, ip, body(marker)));
          expect([...keys], `request ${String(i + 1)}: the address key only`).toEqual([
            addressKey(ip),
          ]);
        }
        expect(await rowCount(addressKey(ip))).toEqual({ rows: 1, count: ADDRESS_MAX });

        // No client bucket row for the rejected shape.
        const rejected = clientId(marker);
        if (rejected !== undefined) {
          expect(await rowCount(clientKey(rejected))).toEqual({ rows: 0, count: null });
        }

        // The address bucket is spent: even a well-shaped client id from it is refused now.
        const wellShaped = `client-${randomUUID()}`;
        expectLimitedAnswer(await exchange(replicaD, wellShaped, ip), [wellShaped, ip]);
      },
      120_000,
    );
  });
});
