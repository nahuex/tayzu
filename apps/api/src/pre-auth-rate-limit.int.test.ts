/**
 * Integration test for task 23.20 (openspec/changes/002-auth-and-rbac; design
 * Resolved decision Q48 and D20; `specs/auth-and-rbac/spec.md`, requirement
 * "Pre-authentication rate limiting protects against credential stuffing").
 *
 * Task 23.20: "Better Auth `advanced.ipAddress` is configured with an explicit
 * trusted-proxy and header setting, so a caller-supplied `X-Forwarded-For`
 * cannot pick or rotate its rate-limit bucket and the shared `no-trusted-ip`
 * bucket is not reachable by a multi-hop header. Verify: a spoofed single-value
 * and a multi-hop `X-Forwarded-For` from an untrusted peer both being limited
 * by the real peer address, and a trusted proxy's client address being used."
 *
 * This is a hardening task with no new spec scenario. It pins the existing
 * scenario "Repeated failed sign-ins from the same source are rate-limited"
 * (`AUTH_RATE_LIMITED`, `Retry-After`) to the *real* source address.
 *
 * ## Where this file lives
 *
 * The task names `pre-auth-rate-limit.int.test.ts` "(extended)", i.e. the file
 * in `packages/auth`. That file drives `auth.handler(new Request(...))`, which
 * has no socket and therefore no "real peer address"; and the group-23 rule is
 * that tests about the running server build it with `createAppFromEnv` and go
 * through Fastify, which `packages/auth` cannot import (no dependency on
 * `apps/api`). So the tests are in `apps/api`, next to the other Fastify-level
 * tests, and the existing `packages/auth` file is left untouched.
 *
 * ## Harness
 *
 * `createAppFromEnv(env)` with `PRE_AUTH_SIGN_IN_RATE_LIMIT_MAX=3`. Requests go
 * through `app.app.inject`, whose `remoteAddress` is the TCP peer. Fastify's
 * `trustProxy` trusts only loopback/link-local/unique-local peers, so a public
 * `remoteAddress` is an untrusted peer and a private one is a trusted proxy.
 * Every test uses fresh random peers (buckets live in the database for the
 * whole 60 s window).
 *
 * ## Production symbols expected (the red phase)
 *
 * No new exported symbol and no migration: the Fastify host must make the
 * address Better Auth keys the pre-auth buckets by the one Fastify resolved
 * from the real peer (`request.ip`, honoring `trustProxy`), and never a
 * caller-supplied `X-Forwarded-For` from an untrusted peer. In `createAuth`
 * that is an explicit `advanced.ipAddress` (header and trusted-proxy setting)
 * and/or the host overwriting the forwarded header before `auth.handler`. Any
 * unresolvable address must not fall into the shared `no-trusted-ip` bucket.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { harnessPools } from './__fixtures__/pools.js';

const state = vi.hoisted(() => ({ pools: new Map<string, unknown>() }));

vi.mock('@tayzu/db', async (importActual) => {
  const actual = await importActual<typeof import('@tayzu/db')>();
  return {
    ...actual,
    createPool: vi.fn((url: string) => {
      const role = url.includes('tayzu_auth') ? 'auth' : 'app';
      const real = state.pools.get(role) as object;
      return new Proxy(real, {
        get(target, prop) {
          if (prop === 'end') {
            return () => Promise.resolve();
          }
          const value: unknown = Reflect.get(target, prop, target);
          return typeof value === 'function'
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });
    }),
  };
});

import { createAppFromEnv } from './bootstrap.js';
import type { App } from './server.js';

const ORIGIN = 'https://app.tayzu.test';
const SIGN_IN_MAX = 3;
const WRONG_PASSWORD = 'definitely the wrong password, not correct';

function octet(): string {
  return randomInt(1, 255).toString(10);
}

/** A public address: not loopback, link-local or unique-local, so Fastify does not trust it as a proxy. */
function randomPublicIp(): string {
  return `203.${octet()}.${octet()}.${octet()}`;
}

/** A private address: Fastify trusts it as a proxy (the ACA ingress). */
function randomTrustedProxyIp(): string {
  return `10.${octet()}.${octet()}.${octet()}`;
}

function randomEmail(): string {
  return `peer-${randomUUID()}@example.test`;
}

describe('Pre-auth rate limit keys by the real peer address (task 23.20, design Q48 and D20)', () => {
  let app: App;

  beforeAll(async () => {
    const pools = await harnessPools();
    state.pools.set('app', pools.appPool);
    state.pools.set('auth', pools.authPool);
    app = await createAppFromEnv({
      DATABASE_URL: 'postgres://tayzu_app:pw@db.invalid:5432/tayzu?sslmode=verify-full',
      AUTH_DATABASE_URL: 'postgres://tayzu_auth:pw@db.invalid:5432/tayzu?sslmode=verify-full',
      BETTER_AUTH_SECRET: TEST_SECRET,
      CERBOS_ADDRESS: 'localhost:3593',
      ALLOWED_ORIGINS: ORIGIN,
      PRE_AUTH_SIGN_IN_RATE_LIMIT_MAX: String(SIGN_IN_MAX),
      PRE_AUTH_SIGN_IN_RATE_LIMIT_WINDOW_SECONDS: '60',
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    state.pools.clear();
  }, 60_000);

  /** One failed sign-in for a fresh random email, from `peer`, carrying `forwardedFor` when given. */
  function signIn(peer: string, forwardedFor: string | undefined) {
    return app.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      remoteAddress: peer,
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        host: 'localhost:3000',
        ...(forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor }),
      },
      payload: JSON.stringify({ email: randomEmail(), password: WRONG_PASSWORD }),
    });
  }

  type Response = Awaited<ReturnType<typeof signIn>>;

  function expectOrdinaryFailure(response: Response): void {
    expect(response.statusCode, 'an attempt under the limit is not rate-limited').toBe(401);
  }

  function expectRateLimited(response: Response): void {
    expect(response.statusCode, 'the breaching attempt is rejected with 429').toBe(429);
    expect(response.json<{ code?: unknown }>().code).toBe('AUTH_RATE_LIMITED');
    const retryAfter = Number(response.headers['retry-after']);
    expect(retryAfter, 'Retry-After is a positive number of seconds').toBeGreaterThan(0);
  }

  it('A spoofed single-value X-Forwarded-For from an untrusted peer cannot rotate its rate-limit bucket: the real peer address is limited', async () => {
    const peer = randomPublicIp();

    for (let attempt = 0; attempt < SIGN_IN_MAX; attempt += 1) {
      expectOrdinaryFailure(await signIn(peer, randomPublicIp()));
    }

    // A fresh spoofed address and a fresh email: only the real peer is shared.
    expectRateLimited(await signIn(peer, randomPublicIp()));
    // The peer is limited whether or not it spoofs.
    expectRateLimited(await signIn(peer, undefined));
  }, 60_000);

  it('A spoofed multi-hop X-Forwarded-For from an untrusted peer is limited by the real peer address', async () => {
    const peer = randomPublicIp();
    const multiHop = (): string => `${randomPublicIp()}, ${randomPublicIp()}, ${randomPublicIp()}`;

    for (let attempt = 0; attempt < SIGN_IN_MAX; attempt += 1) {
      expectOrdinaryFailure(await signIn(peer, multiHop()));
    }

    expectRateLimited(await signIn(peer, multiHop()));
  }, 60_000);

  it('A multi-hop X-Forwarded-For does not reach a shared no-trusted-ip bucket: one peer exhausting its budget never limits another peer', async () => {
    const attacker = randomPublicIp();
    const bystander = randomPublicIp();
    const multiHop = (): string => `${randomPublicIp()}, ${randomPublicIp()}`;

    for (let attempt = 0; attempt < SIGN_IN_MAX; attempt += 1) {
      expectOrdinaryFailure(await signIn(attacker, multiHop()));
    }
    expectRateLimited(await signIn(attacker, multiHop()));

    // A different untrusted peer, also sending a multi-hop header, is unaffected.
    expectOrdinaryFailure(await signIn(bystander, multiHop()));
  }, 60_000);

  it("A trusted proxy's client address is used: clients behind the same proxy are limited independently", async () => {
    const proxy = randomTrustedProxyIp();
    const clientA = randomPublicIp();
    const clientB = randomPublicIp();

    for (let attempt = 0; attempt < SIGN_IN_MAX; attempt += 1) {
      expectOrdinaryFailure(await signIn(proxy, clientA));
    }
    expectRateLimited(await signIn(proxy, clientA));

    // Another client behind the same trusted proxy has its own budget, so the
    // proxy's own address is not what the limiter keys by.
    expectOrdinaryFailure(await signIn(proxy, clientB));
  }, 60_000);
});
