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
