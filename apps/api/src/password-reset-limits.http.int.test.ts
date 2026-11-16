/**
 * Task 6.6 of openspec/changes/044-password-reset-and-account-recovery (design D2 "Order of work,
 * request route", D16 "Rate-limit scopes and the client key").
 *
 * Scenarios (verbatim from `specs/password-reset-and-account-recovery/spec.md`, requirement
 * "Reset traffic is limited before any lookup"):
 * - "The eleventh request in a minute is limited": WHEN one IP posts 11 requests to the request
 *   route within 60 seconds; THEN the eleventh answers `429` `AUTH_RATE_LIMITED` with
 *   `Retry-After`, before any account lookup.
 * - "Two addresses in one /64 share a bucket": WHEN 6 requests come from `2001:db8:1:2::1` and 5
 *   from `2001:db8:1:2:ffff::9` within 60 seconds, and one from another /64; THEN the eleventh
 *   from the first /64 answers `429`, and the request from the other /64 is accepted.
 * - "A limiter failure fails closed": GIVEN a rate-limit store that throws; WHEN either reset
 *   route is called; THEN the answer is a sanitized internal error, no account lookup runs and no
 *   email is sent. (HTTP level, the request route; the confirm route does not exist yet.)
 * - Case "two app instances over one database share the bucket" (design D16: the limiter state is
 *   shared across replicas).
 *
 * ## Harness
 *
 * The real server (`createApp`, injected requests, never a listener), identity routes mounted,
 * over a recording email sender. Each test uses its own random client address (or random /64), so
 * tests do not share buckets, and the request route's default limit (10 per 60 s) applies. The
 * store that throws is the Better Auth adapter's `auth.rate_limit` table: the `tayzu_auth` pool
 * handed to `createApp` is wrapped so that, while a flag is on, any statement touching
 * `rate_limit` throws an error carrying a marker string. "No account lookup" is observed on the
 * same wrapper (statements touching `user`, `account`, `member` or `verification`), with a control
 * that an admitted request does perform one.
 *
 * ## Production symbols expected
 *
 * - `POST /v1/auth/password-reset/request` runs a pre-handler before the handler that consumes a
 *   `password_reset_request` bucket keyed by `clientIpKey(request.ip)` (`./identity/client-ip-key.js`)
 *   on the DB-backed store (default 10 per 60 seconds), answering `429` `AUTH_RATE_LIMITED` with
 *   `Retry-After` and, when the store throws, the sanitized `500` `INTERNAL`, both before any
 *   account lookup or email.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { createRecordingEmailSender } from '@tayzu/auth';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createApp, type App } from './server.js';

const ORIGIN = 'https://app.tayzu.test';
const LINK_BASE_URL = 'https://app.tayzu.test';
const REQUEST_PATH = '/v1/auth/password-reset/request';
const HMAC_SECRET = 'reset-limits-test-only-secret-0123456789-abcdef';
const ACCOUNT_TABLES = /"user"|auth\.user\b|auth\.account\b|auth\.member\b|auth\.verification\b/i;
const RATE_LIMIT_TABLE = /rate_limit/i;
const STORE_FAILURE_MARKER = 'limiter-store-secret-marker-7f3a91';

function hex4(): string {
  return randomInt(0x1000, 0xffff).toString(16);
}

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

/** A random documentation-range /64 prefix, `2001:db8:<a>:<b>`. */
function random64(): string {
  return `2001:db8:${hex4()}:${hex4()}`;
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

interface Answer {
  readonly status: number;
  readonly body: unknown;
  readonly retryAfter: unknown;
  readonly raw: string;
}

interface Instance {
  readonly app: App;
  readonly statements: string[];
  readonly sender: ReturnType<typeof createRecordingEmailSender>;
  readonly flags: { failStore: boolean };
}

describe('The per-IP limiter of the reset request route over HTTP (task 6.6, design D2, D16)', () => {
  const instances: Instance[] = [];

  async function startInstance(): Promise<Instance> {
    const pools = await harnessPools();
    const sender = createRecordingEmailSender();
    const statements: string[] = [];
    const flags = { failStore: false };
    const authPool = spyOnPool(pools.authPool, (sql) => {
      statements.push(sql);
      if (flags.failStore && RATE_LIMIT_TABLE.test(sql)) {
        throw new Error(`store down ${STORE_FAILURE_MARKER}`);
      }
    });
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
    const app = await createApp({
      appPool: pools.appPool,
      authPool,
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ORIGIN],
      mountIdentityRoutes: true,
      identityTokenHmacSecret: HMAC_SECRET,
      ...{ email },
    });
    const instance: Instance = { app, statements, sender, flags };
    instances.push(instance);
    return instance;
  }

  beforeAll(async () => {
    await startInstance();
  }, 60_000);

  afterAll(async () => {
    for (const instance of instances) {
      await instance.app.close();
    }
  }, 60_000);

  function primary(): Instance {
    const first = instances[0];
    if (first === undefined) throw new Error('instance not started');
    return first;
  }

  async function post(instance: Instance, ip: string): Promise<Answer> {
    const response = await instance.app.app.inject({
      method: 'POST',
      url: REQUEST_PATH,
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        'x-csrf-token': 'orpc',
        'x-forwarded-for': ip,
      },
      payload: JSON.stringify({ email: `ghost-${randomUUID()}@example.test` }),
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
      retryAfter: response.headers['retry-after'],
      raw: response.body,
    };
  }

  function lookupsSince(instance: Instance, from: number): string[] {
    return instance.statements.slice(from).filter((sql) => ACCOUNT_TABLES.test(sql));
  }

  it('The eleventh request in a minute is limited: 429 AUTH_RATE_LIMITED with Retry-After, before any account lookup', async () => {
    const instance = primary();
    const ip = randomIp();

    for (let index = 1; index <= 10; index += 1) {
      const answer = await post(instance, ip);
      expect(answer.status, `request ${String(index)}`).toBe(200);
    }
    const statementsBefore = instance.statements.length;
    const sentBefore = instance.sender.sent.length;

    const eleventh = await post(instance, ip);

    expect(eleventh.status).toBe(429);
    expect(eleventh.body).toMatchObject({ code: 'AUTH_RATE_LIMITED' });
    expect(eleventh.retryAfter).toBeDefined();
    expect(Number(eleventh.retryAfter)).toBeGreaterThan(0);
    expect(lookupsSince(instance, statementsBefore), 'no account lookup').toEqual([]);
    expect(instance.sender.sent).toHaveLength(sentBefore);
    // The limiter key never reaches the response.
    expect(eleventh.raw).not.toContain(ip);
  });

  it('control: an admitted request does perform an account lookup, so the observation above is not vacuous', async () => {
    const instance = primary();
    const before = instance.statements.length;

    const answer = await post(instance, randomIp());

    expect(answer.status).toBe(200);
    expect(lookupsSince(instance, before).length).toBeGreaterThan(0);
  });

  it('Two addresses in one /64 share a bucket: the eleventh from the first /64 answers 429 and another /64 is accepted', async () => {
    const instance = primary();
    const prefix = random64();
    const first = `${prefix}::1`;
    const second = `${prefix}:ffff::9`;

    for (let index = 0; index < 6; index += 1) {
      expect((await post(instance, first)).status, `first ${String(index)}`).toBe(200);
    }
    for (let index = 0; index < 4; index += 1) {
      // Together with the six above, the tenth is the last one admitted.
      expect((await post(instance, second)).status, `second ${String(index)}`).toBe(200);
    }
    // Ten were admitted across both addresses: one more from the /64 is the eleventh.
    const limited = await post(instance, first);
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ code: 'AUTH_RATE_LIMITED' });
    expect(limited.retryAfter).toBeDefined();

    const other = await post(instance, `${random64()}::1`);
    expect(other.status).toBe(200);
    expect(other.body).toEqual({ accepted: true });
  });

  it('A limiter failure fails closed: a sanitized internal error, no account lookup and no email', async () => {
    const instance = primary();
    const ip = randomIp();
    instance.flags.failStore = true;
    try {
      const statementsBefore = instance.statements.length;
      const sentBefore = instance.sender.sent.length;

      const answer = await post(instance, ip);

      expect(answer.status).toBe(500);
      expect(answer.body).toMatchObject({ code: 'INTERNAL' });
      expect(answer.raw).not.toContain(STORE_FAILURE_MARKER);
      expect(answer.raw).not.toContain('store down');
      expect(answer.raw).not.toContain(ip);
      expect(lookupsSince(instance, statementsBefore), 'no account lookup').toEqual([]);
      expect(instance.sender.sent).toHaveLength(sentBefore);
    } finally {
      instance.flags.failStore = false;
    }
  });

  it('two app instances over one database share the bucket', async () => {
    const second = await startInstance();
    const first = primary();
    const ip = randomIp();

    for (let index = 0; index < 5; index += 1) {
      expect((await post(first, ip)).status, `instance 1, ${String(index)}`).toBe(200);
    }
    for (let index = 0; index < 5; index += 1) {
      expect((await post(second, ip)).status, `instance 2, ${String(index)}`).toBe(200);
    }

    const fromFirst = await post(first, ip);
    const fromSecond = await post(second, ip);

    expect(fromFirst.status).toBe(429);
    expect(fromFirst.body).toMatchObject({ code: 'AUTH_RATE_LIMITED' });
    expect(fromSecond.status).toBe(429);
    expect(fromSecond.body).toMatchObject({ code: 'AUTH_RATE_LIMITED' });
  }, 60_000);
});
