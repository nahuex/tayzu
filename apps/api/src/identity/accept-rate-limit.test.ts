/**
 * `043` task 8.13 (spec "The accept route is rate-limited"; design D5, "Invitation email
 * caps"): the public accept route has its own limiter, a Fastify `preHandler` that
 * consumes a bucket of the DB-backed store through the helper of 6.10 (scope
 * `invitation_accept`, keyed by `request.ip` as Fastify resolves it under the app's
 * trust setting). It answers `AUTH_RATE_LIMITED` (429) with a `Retry-After` header, and
 * it runs before the handler, so before any invitation lookup. This file exercises the
 * preHandler alone, on a bare Fastify instance, with an in-memory store; the route
 * itself is not mounted here. The shared count across replicas is the case of
 * `invitation-rate-limit-store.int.test.ts` (6.10).
 *
 * ## Production symbols expected
 *
 * ```ts
 * // apps/api/src/identity/accept-rate-limit.ts (does not exist yet)
 * import type { RateLimitBucketStore } from '@tayzu/auth';
 * import type { preHandlerAsyncHookHandler } from 'fastify';
 *
 * export interface AcceptRateLimitOptions {
 *   // Only `consume` is used. The preHandler calls
 *   //   store.consume({ scope: 'invitation_accept', kind: 'ip', value: request.ip })
 *   // exactly once per request; the store hashes the key and owns max/window.
 *   readonly store: RateLimitBucketStore;
 * }
 * // When `allowed` is false: reply 429, header `retry-after` = String(retryAfterSeconds),
 * // body { defined: false, code: 'AUTH_RATE_LIMITED', status: 429, ... }, and the route
 * // handler never runs. When allowed: returns without replying.
 * export function createAcceptRateLimitPreHandler(
 *   options: AcceptRateLimitOptions,
 * ): preHandlerAsyncHookHandler;
 * ```
 */
import { randomInt } from 'node:crypto';

import type { RateLimitBucketStore } from '@tayzu/auth';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { createAcceptRateLimitPreHandler } from './accept-rate-limit.js';

const ACCEPT_PATH = '/v1/auth/invitations/accept';
const MAX = 3;
const RETRY_AFTER_SECONDS = 3600;

interface Consumed {
  readonly scope: string;
  readonly kind: string;
  readonly value: string;
}

/** An in-memory fixed-count store: the first `MAX` hits per bucket pass, the rest are denied. */
function createFakeStore(): { store: RateLimitBucketStore; consumed: Consumed[] } {
  const counts = new Map<string, number>();
  const consumed: Consumed[] = [];
  const store: RateLimitBucketStore = {
    consume(bucket) {
      consumed.push({ scope: bucket.scope, kind: bucket.kind, value: bucket.value });
      const key = `${bucket.scope}:${bucket.kind}:${bucket.value}`;
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return Promise.resolve(
        count <= MAX
          ? { allowed: true, retryAfterSeconds: null }
          : { allowed: false, retryAfterSeconds: RETRY_AFTER_SECONDS },
      );
    },
  };
  return { store, consumed };
}

function freshIp(): string {
  return `203.0.113.${String(randomInt(1, 255))}`;
}

describe('The accept route is rate-limited (task 8.13)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function build(): Promise<{
    app: FastifyInstance;
    consumed: Consumed[];
    lookups: { count: number };
  }> {
    const { store, consumed } = createFakeStore();
    const lookups = { count: 0 };
    const instance = Fastify({ trustProxy: ['loopback', 'linklocal', 'uniquelocal'] });
    instance.post(ACCEPT_PATH, { preHandler: createAcceptRateLimitPreHandler({ store }) }, () => {
      // Stands for the invitation lookup: it must never run on a limited request.
      lookups.count += 1;
      return { ok: true };
    });
    await instance.ready();
    app = instance;
    return { app: instance, consumed, lookups };
  }

  function accept(instance: FastifyInstance, ip: string) {
    return instance.inject({
      method: 'POST',
      url: ACCEPT_PATH,
      remoteAddress: ip,
      payload: { invitationId: 'marker-id', token: 'marker-token' },
    });
  }

  it('requests over the configured rate fail with AUTH_RATE_LIMITED and a Retry-After header, before any invitation lookup', async () => {
    const { app: instance, lookups } = await build();
    const ip = freshIp();

    for (let i = 0; i < MAX; i += 1) {
      const allowed = await accept(instance, ip);
      expect(allowed.statusCode).toBe(200);
    }
    expect(lookups.count).toBe(MAX);

    const limited = await accept(instance, ip);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe(String(RETRY_AFTER_SECONDS));
    expect(limited.json()).toMatchObject({ code: 'AUTH_RATE_LIMITED', status: 429 });
    // The limit fired before the handler: no further lookup happened.
    expect(lookups.count).toBe(MAX);

    const stillLimited = await accept(instance, ip);
    expect(stillLimited.statusCode).toBe(429);
    expect(lookups.count).toBe(MAX);
  });

  it('consumes the invitation_accept bucket keyed by the client IP Fastify resolves', async () => {
    const { app: instance, consumed } = await build();
    const ip = freshIp();

    await accept(instance, ip);

    expect(consumed).toEqual([{ scope: 'invitation_accept', kind: 'ip', value: ip }]);
  });

  it('keys the bucket by request.ip under the trust setting, not by a spoofed header from a public peer', async () => {
    const { app: instance, consumed } = await build();
    const peer = freshIp();

    await instance.inject({
      method: 'POST',
      url: ACCEPT_PATH,
      remoteAddress: peer,
      headers: { 'x-forwarded-for': '198.51.100.99' },
      payload: {},
    });

    expect(consumed).toEqual([{ scope: 'invitation_accept', kind: 'ip', value: peer }]);
  });

  it('keeps one bucket per client: another IP is not limited by the first one', async () => {
    const { app: instance, lookups } = await build();
    const first = freshIp();
    let second = freshIp();
    while (second === first) {
      second = freshIp();
    }

    for (let i = 0; i <= MAX; i += 1) {
      await accept(instance, first);
    }
    expect((await accept(instance, first)).statusCode).toBe(429);
    const before = lookups.count;

    const other = await accept(instance, second);
    expect(other.statusCode).toBe(200);
    expect(lookups.count).toBe(before + 1);
  });
});

/**
 * `044` task 1.6 (design D16, Q28; spec "Reset traffic is limited before any lookup"): the
 * pre-handler keys the bucket by the normalized client key (`clientIpKey`, one /64 shares a
 * bucket) and fails closed: a throwing store makes the pre-handler itself answer the
 * sanitized `INTERNAL` 500, with no handler run. The bare Fastify instance here has no
 * error handler, so only the pre-handler can produce that body.
 */
describe('The shared pre-handler keys by /64 and fails closed (044 task 1.6)', () => {
  const LIMIT = 10;
  const SECRET_FAILURE = 'connection terminated: relation "auth.rate_limit" (password=hunter2)';
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  function createStore(): {
    store: RateLimitBucketStore;
    consumed: Consumed[];
    state: { failing: boolean };
  } {
    const counts = new Map<string, number>();
    const consumed: Consumed[] = [];
    const state = { failing: false };
    const store: RateLimitBucketStore = {
      consume(bucket) {
        if (state.failing) {
          return Promise.reject(new Error(SECRET_FAILURE));
        }
        consumed.push({ scope: bucket.scope, kind: bucket.kind, value: bucket.value });
        const key = `${bucket.scope}:${bucket.kind}:${bucket.value}`;
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        return Promise.resolve(
          count <= LIMIT
            ? { allowed: true, retryAfterSeconds: null }
            : { allowed: false, retryAfterSeconds: 60 },
        );
      },
    };
    return { store, consumed, state };
  }

  async function build(scope?: 'password_reset_request') {
    const harness = createStore();
    const handled = { count: 0 };
    const instance = Fastify({ trustProxy: ['loopback', 'linklocal', 'uniquelocal'] });
    instance.post(
      ACCEPT_PATH,
      {
        preHandler: createAcceptRateLimitPreHandler({
          store: harness.store,
          ...(scope === undefined ? {} : { scope }),
        }),
      },
      () => {
        handled.count += 1;
        return { ok: true };
      },
    );
    await instance.ready();
    app = instance;
    return { app: instance, handled, ...harness };
  }

  function post(instance: FastifyInstance, ip: string) {
    return instance.inject({
      method: 'POST',
      url: ACCEPT_PATH,
      remoteAddress: ip,
      payload: { invitationId: 'marker-id', token: 'marker-token' },
    });
  }

  const FIRST = '2001:db8:1:2::1';
  const SAME_64 = '2001:db8:1:2:ffff::9';
  const OTHER_64 = '2001:db8:1:3::1';

  it('Two addresses in one /64 share a bucket', async () => {
    const { app: instance, handled, consumed } = await build('password_reset_request');

    for (let i = 0; i < 6; i += 1) {
      expect((await post(instance, FIRST)).statusCode).toBe(200);
    }
    for (let i = 0; i < 4; i += 1) {
      expect((await post(instance, SAME_64)).statusCode).toBe(200);
    }
    expect((await post(instance, OTHER_64)).statusCode).toBe(200);
    const eleventh = await post(instance, SAME_64);

    expect(eleventh.statusCode).toBe(429);
    expect(eleventh.headers['retry-after']).toBe('60');
    expect(eleventh.json()).toMatchObject({ code: 'AUTH_RATE_LIMITED', status: 429 });
    expect(handled.count).toBe(11);
    // The other /64 is accepted again after the first /64 is limited.
    expect((await post(instance, OTHER_64)).statusCode).toBe(200);
    expect(consumed.every((c) => c.scope === 'password_reset_request' && c.kind === 'ip')).toBe(
      true,
    );
    for (const { value } of consumed) {
      expect(value).not.toContain(FIRST);
      expect(value).not.toContain(SAME_64);
      expect(value).not.toContain(OTHER_64);
    }
  });

  it('keys an IPv4-mapped IPv6 peer by its IPv4 form', async () => {
    const { app: instance, consumed } = await build();

    await post(instance, '::ffff:203.0.113.9');

    expect(consumed).toEqual([{ scope: 'invitation_accept', kind: 'ip', value: '203.0.113.9' }]);
  });

  it('A limiter failure fails closed: a sanitized INTERNAL 500 from the pre-handler, no handler run', async () => {
    const { app: instance, handled, state } = await build('password_reset_request');
    state.failing = true;

    const response = await post(instance, freshIp());

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: 'INTERNAL', status: 500 });
    expect(response.body).not.toContain('hunter2');
    expect(response.body).not.toContain('auth.rate_limit');
    expect(response.body).not.toContain('connection terminated');
    expect(handled.count).toBe(0);
  });

  it('The invitation accept route shares the key and the failure behavior', async () => {
    const { app: instance, handled, state } = await build();

    for (let i = 0; i < 6; i += 1) {
      expect((await post(instance, FIRST)).statusCode).toBe(200);
    }
    for (let i = 0; i < 4; i += 1) {
      expect((await post(instance, SAME_64)).statusCode).toBe(200);
    }
    // The eleventh request of that /64 is limited like any other route's.
    expect((await post(instance, SAME_64)).statusCode).toBe(429);
    expect(handled.count).toBe(10);

    state.failing = true;
    const response = await post(instance, FIRST);

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: 'INTERNAL', status: 500 });
    expect(response.body).not.toContain('hunter2');
    // No acceptance was attempted during the failure.
    expect(handled.count).toBe(10);
  });
});
