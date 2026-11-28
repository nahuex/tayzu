/**
 * Task 3.3 of openspec/changes/048-production-hardening (design D2, Q6; spec
 * `specs/auth-and-rbac/spec.md`).
 *
 * Task 3.3: "`createApp` and `createAppFromEnv` use the configured trust (design D2). Verify:
 * `apps/api/src/trust-proxy.http.int.test.ts` covers "A spoofed forwarded address from an
 * untrusted peer is ignored", "A forwarded address from the trusted ingress is used" and
 * "Extra hops beyond the configured count are not trusted" through `inject` with
 * `remoteAddress`, observed on the accept route's limiter."
 *
 * Scenarios (verbatim from the spec):
 *
 * "A spoofed forwarded address from an untrusted peer is ignored"
 * - GIVEN the platform trusts one hop from the range `10.0.0.0/16`
 * - WHEN a request arrives from the peer `203.0.113.7` with `X-Forwarded-For: 198.51.100.1`
 * - THEN the request is keyed on `203.0.113.7`, so exhausting a per-address limit with varying
 *   forwarded values still limits that peer
 *
 * "A forwarded address from the trusted ingress is used"
 * - GIVEN the platform trusts one hop from the range `10.0.0.0/16`
 * - WHEN a request arrives from the peer `10.0.4.2` with `X-Forwarded-For: 198.51.100.1`
 * - THEN the request is keyed on `198.51.100.1`
 *
 * "Extra hops beyond the configured count are not trusted"
 * - GIVEN the platform trusts one hop from the range `10.0.0.0/16`
 * - WHEN a request arrives from the peer `10.0.4.2` with
 *   `X-Forwarded-For: 198.51.100.9, 10.0.4.3, 198.51.100.1`
 * - THEN the request is keyed on `198.51.100.1`, the right-most forwarded value, and never on
 *   an address further left
 *
 * ## Harness
 *
 * The real server, driven by `app.app.inject` with `remoteAddress` as the TCP peer (never a
 * listener). The observable is the per-address limiter of `POST /v1/auth/invitations/accept`
 * (`max` 2 per 60 s window): an unknown invitation answers the uniform 404 under the limit and
 * `429 AUTH_RATE_LIMITED` once the bucket of the resolved address is spent. The buckets live
 * in the database for the whole window and are shared by every app of a run, so the spec's
 * literal addresses are replaced by fresh random addresses of the same kind in every test
 * (a public peer, a peer inside `10.0.0.0/16`, a public forwarded client); no test needs a
 * tenant, since an unknown invitation is refused before any tenant is involved.
 *
 * The configured trust differs from the test default (`loopback`, `linklocal`,
 * `uniquelocal`) on purpose: a private peer outside `10.0.0.0/16` (for example `10.1.x.y` or
 * `192.168.x.y`) and a forwarded address inside the range are trusted by the default and
 * must not be by the configured trust; a peer in a public range is trusted only by a
 * configuration that names it.
 *
 * ## Production symbols expected (the red phase)
 *
 * - `CreateAppOptions.trustProxy` (`./server.js`): "the function or the test list" (D2), here
 *   the function `createTrustProxy({ hops, cidrs })` of `./trust-proxy.js` (task 3.2). The
 *   Fastify instance uses it in place of the hard-coded list.
 * - `createAppFromEnv` (`./bootstrap.js`) sets `trustProxy` from `Config.trustProxy`
 *   (`TRUST_PROXY_HOPS`, `TRUST_PROXY_CIDRS`, task 3.1).
 */
import { randomInt, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { csrfHeaders } from './__fixtures__/csrf.js';
import { testEmailOptions } from './__fixtures__/email-options.js';
import { harnessPools } from './__fixtures__/pools.js';

const state = vi.hoisted(() => ({ pools: new Map<string, unknown>() }));

// `createAppFromEnv` builds its pools from URLs; they are the harness pools here.
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
import { createApp, type App } from './server.js';
import { createTrustProxy } from './trust-proxy.js';

const ORIGIN = 'https://app.tayzu.test';
const ACCEPT_PATH = '/v1/auth/invitations/accept';
const ACCEPT_PASSWORD = 'Café-Mañana-Passäphrase-2026!';
const ACCEPT_LIMIT = 2;
const HMAC_SECRET = 'trust-proxy-test-only-secret-0123456789-abcdef';

function octet(): string {
  return randomInt(1, 255).toString(10);
}

/** A public peer: outside `10.0.0.0/16` and outside the default list. */
function publicPeer(): string {
  return `203.${octet()}.${octet()}.${octet()}`;
}

/** A private peer in `10/8` but outside `10.0.0.0/16`: trusted by the default list only. */
function privatePeerOutsideRange(): string {
  return `10.${octet()}.${octet()}.${octet()}`;
}

/** A private peer in `192.168/16`: trusted by the default list only. */
function lanPeerOutsideRange(): string {
  return `192.168.${octet()}.${octet()}`;
}

/** The trusted ingress: a peer inside `10.0.0.0/16`. */
function ingressPeer(): string {
  return `10.0.${octet()}.${octet()}`;
}

/** A public client address as the ingress forwards it. */
function forwardedClient(): string {
  return `198.${octet()}.${octet()}.${octet()}`;
}

/** A peer of the public range `198.18.0.0/15`, which only an explicit configuration trusts. */
function publicIngressPeer(): string {
  return `198.${randomInt(18, 20).toString(10)}.${octet()}.${octet()}`;
}

interface Answer {
  readonly status: number;
  readonly code: unknown;
  readonly retryAfter: string | undefined;
}

/** One acceptance of an unknown invitation from `peer`, carrying `forwardedFor` when given. */
async function accept(app: App, peer: string, forwardedFor: string | undefined): Promise<Answer> {
  const response = await app.app.inject({
    method: 'POST',
    url: ACCEPT_PATH,
    remoteAddress: peer,
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
      ...csrfHeaders('POST'),
      ...(forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor }),
    },
    payload: JSON.stringify({
      invitationId: `unknown-${randomUUID()}`,
      token: 'not-a-token',
      password: ACCEPT_PASSWORD,
    }),
  });
  let code: unknown;
  try {
    code = response.json<{ code?: unknown }>().code;
  } catch {
    // A non-JSON body leaves the code undefined, which fails the assertions.
  }
  const retryAfter = response.headers['retry-after'];
  return {
    status: response.statusCode,
    code,
    retryAfter: typeof retryAfter === 'string' ? retryAfter : undefined,
  };
}

function expectUnderLimit(answer: Answer, because: string): void {
  expect(answer.status, because).toBe(404);
}

function expectLimited(answer: Answer, because: string): void {
  expect(answer.status, because).toBe(429);
  expect(answer.code).toBe('AUTH_RATE_LIMITED');
  expect(answer.retryAfter).toMatch(/^[1-9]\d*$/);
}

/** Spends the bucket of `peer` with a fresh forwarded value per request, then checks the limit. */
async function expectPeerLimitedDespiteSpoofing(
  app: App,
  peer: string,
  spoofed: () => string,
): Promise<void> {
  for (let attempt = 0; attempt < ACCEPT_LIMIT; attempt += 1) {
    expectUnderLimit(await accept(app, peer, spoofed()), 'an attempt under the limit');
  }
  expectLimited(
    await accept(app, peer, spoofed()),
    'a fresh forwarded value does not mint a bucket: the peer is limited',
  );
  expectLimited(await accept(app, peer, undefined), 'the peer is limited without the header too');
}

/** Distinct forwarded clients behind one trusted `ingress` get distinct buckets. */
async function expectForwardedClientsKeyedApart(app: App, ingress: string): Promise<void> {
  // More requests than one bucket allows, each from a fresh client: none is limited.
  for (let attempt = 0; attempt <= ACCEPT_LIMIT; attempt += 1) {
    expectUnderLimit(
      await accept(app, ingress, forwardedClient()),
      'each forwarded client has its own bucket, not the ingress address',
    );
  }
  // One client spends its own bucket; the next client behind the same ingress is unaffected.
  const client = forwardedClient();
  for (let attempt = 0; attempt < ACCEPT_LIMIT; attempt += 1) {
    expectUnderLimit(await accept(app, ingress, client), 'an attempt under the limit');
  }
  expectLimited(await accept(app, ingress, client), 'the forwarded client is limited');
  // The client stays limited on its own key.
  expectLimited(
    await accept(app, ingress, client),
    'the forwarded client stays limited on its own key',
  );
  expectUnderLimit(
    await accept(app, ingress, forwardedClient()),
    'another client behind the same ingress is not limited',
  );
}

describe('createApp uses the configured proxy trust (048 task 3.3, design D2, Q6)', () => {
  let app: App;

  beforeAll(async () => {
    const pools = await harnessPools();
    app = await createApp({
      ...pools,
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ORIGIN],
      mountIdentityRoutes: true,
      identityTokenHmacSecret: HMAC_SECRET,
      email: testEmailOptions(),
      invitationAcceptRateLimit: { max: ACCEPT_LIMIT, window: 60 },
      // GIVEN the platform trusts one hop from the range `10.0.0.0/16`.
      trustProxy: createTrustProxy({ hops: 1, cidrs: ['10.0.0.0/16'] }),
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
  }, 60_000);

  it('A spoofed forwarded address from an untrusted peer is ignored: a public peer with varying X-Forwarded-For values is keyed on the peer', async () => {
    // WHEN requests arrive from one public peer, each with a different `X-Forwarded-For`.
    // THEN they are keyed on the peer: exhausting the limit with varying values still limits it.
    await expectPeerLimitedDespiteSpoofing(app, publicPeer(), forwardedClient);
  }, 60_000);

  it('A spoofed forwarded address from an untrusted peer is ignored: a private peer outside 10.0.0.0/16 is not a trusted proxy', async () => {
    // A `10.x` peer outside `10.0.0.0/16` and a `192.168.x` peer are private (the default list
    // trusts both), but neither is inside the configured range.
    await expectPeerLimitedDespiteSpoofing(app, privatePeerOutsideRange(), forwardedClient);
    await expectPeerLimitedDespiteSpoofing(app, lanPeerOutsideRange(), forwardedClient);
  }, 60_000);

  it('A spoofed forwarded address from an untrusted peer is ignored: a multi-hop value naming the trusted range does not help', async () => {
    // The untrusted peer's header is never read, even when its right-most value is in range.
    await expectPeerLimitedDespiteSpoofing(
      app,
      privatePeerOutsideRange(),
      () => `${forwardedClient()}, ${ingressPeer()}`,
    );
  }, 60_000);

  it('A forwarded address from the trusted ingress is used: distinct forwarded clients behind one peer in 10.0.0.0/16 get distinct buckets', async () => {
    // WHEN requests arrive from a peer in `10.0.0.0/16` with `X-Forwarded-For: <client>`.
    // THEN each request is keyed on its forwarded client.
    await expectForwardedClientsKeyedApart(app, ingressPeer());
  }, 60_000);

  it('A forwarded address from the trusted ingress is used: the same client through two ingress hosts of the range shares one bucket', async () => {
    const client = forwardedClient();
    const first = ingressPeer();
    const second = ingressPeer();
    for (let attempt = 0; attempt < ACCEPT_LIMIT; attempt += 1) {
      expectUnderLimit(await accept(app, first, client), 'an attempt under the limit');
    }
    // The key is the client, not the ingress host the request came through.
    expectLimited(await accept(app, second, client), 'the client is limited on any ingress host');
  }, 60_000);

  it('Extra hops beyond the configured count are not trusted: with X-Forwarded-For "<left>, <range address>, <client>" the request is keyed on the right-most value', async () => {
    // WHEN requests arrive from a peer in range with `X-Forwarded-For: <a>, <10.0.x.y>, <client>`,
    // the left-most two values varying and the right-most one fixed.
    const ingress = ingressPeer();
    const client = forwardedClient();
    const header = (): string => `${forwardedClient()}, ${ingressPeer()}, ${client}`;
    for (let attempt = 0; attempt < ACCEPT_LIMIT; attempt += 1) {
      expectUnderLimit(await accept(app, ingress, header()), 'an attempt under the limit');
    }
    // THEN the request is keyed on the right-most forwarded value.
    expectLimited(
      await accept(app, ingress, header()),
      'the right-most forwarded value is the key',
    );
    expectLimited(await accept(app, ingress, client), 'the same client alone shares the bucket');
  }, 60_000);

  it('Extra hops beyond the configured count are not trusted: a right-most value inside the range is the key, never an address further left', async () => {
    // WHEN the right-most forwarded value is itself inside `10.0.0.0/16` (a second hop the
    // configuration does not trust) and the values further left vary.
    const ingress = ingressPeer();
    const secondHop = ingressPeer();
    for (let attempt = 0; attempt < ACCEPT_LIMIT; attempt += 1) {
      expectUnderLimit(
        await accept(app, ingress, `${forwardedClient()}, ${secondHop}`),
        'an attempt under the limit',
      );
    }
    // THEN the request is keyed on the right-most value: varying left values share its bucket.
    expectLimited(
      await accept(app, ingress, `${forwardedClient()}, ${secondHop}`),
      'the left-most value is never the key',
    );
  }, 60_000);

  it('Extra hops beyond the configured count are not trusted: a fixed left-most value never selects the bucket', async () => {
    // The left-most value is fixed and the right-most (in-range) value varies: if the second
    // hop were trusted every request would share the left-most value's bucket.
    const ingress = ingressPeer();
    const left = forwardedClient();
    for (let attempt = 0; attempt <= ACCEPT_LIMIT; attempt += 1) {
      expectUnderLimit(
        await accept(app, ingress, `${left}, ${ingressPeer()}`),
        'the request is keyed on its right-most value, not on the fixed left-most one',
      );
    }
  }, 60_000);
});

describe('createAppFromEnv uses TRUST_PROXY_HOPS and TRUST_PROXY_CIDRS (048 task 3.3, design D2)', () => {
  let app: App;

  beforeAll(async () => {
    const pools = await harnessPools();
    state.pools.set('app', pools.appPool);
    state.pools.set('auth', pools.authPool);
    app = await createAppFromEnv({
      DATABASE_URL: 'postgres://tayzu_app:pw@127.0.0.1:1/tayzu?sslmode=verify-full',
      AUTH_DATABASE_URL: 'postgres://tayzu_auth:pw@127.0.0.1:1/tayzu?sslmode=verify-full',
      BETTER_AUTH_SECRET: TEST_SECRET,
      CERBOS_ADDRESS: 'localhost:3593',
      ALLOWED_ORIGINS: ORIGIN,
      INVITATION_LINK_BASE_URL: ORIGIN,
      PASSWORD_RESET_LINK_BASE_URL: ORIGIN,
      IDENTITY_TOKEN_HMAC_SECRET: HMAC_SECRET,
      MOUNT_IDENTITY_ROUTES: 'true',
      INVITATION_ACCEPT_RATE_LIMIT_MAX: String(ACCEPT_LIMIT),
      INVITATION_ACCEPT_RATE_LIMIT_WINDOW_SECONDS: '60',
      // One hop from the private ingress range or from a public range (an edge in front).
      TRUST_PROXY_HOPS: '1',
      TRUST_PROXY_CIDRS: '10.0.0.0/16, 198.18.0.0/15',
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    state.pools.clear();
  }, 60_000);

  it('A forwarded address from the trusted ingress is used: a peer of a configured public range, which the test default does not trust, forwards its clients', async () => {
    await expectForwardedClientsKeyedApart(app, publicIngressPeer());
  }, 60_000);

  it('A spoofed forwarded address from an untrusted peer is ignored: a private peer outside the configured ranges is keyed on itself', async () => {
    await expectPeerLimitedDespiteSpoofing(app, privatePeerOutsideRange(), forwardedClient);
  }, 60_000);

  it('Extra hops beyond the configured count are not trusted: a right-most value inside the ranges is the key', async () => {
    // A second hop inside `10.0.0.0/16` (which the test default would trust) is not trusted
    // when `TRUST_PROXY_HOPS` is 1, so the varying values further left never pick the bucket.
    const ingress = ingressPeer();
    const secondHop = ingressPeer();
    for (let attempt = 0; attempt < ACCEPT_LIMIT; attempt += 1) {
      expectUnderLimit(
        await accept(app, ingress, `${forwardedClient()}, ${secondHop}`),
        'an attempt under the limit',
      );
    }
    expectLimited(
      await accept(app, ingress, `${forwardedClient()}, ${secondHop}`),
      'the left-most value is never the key',
    );
  }, 60_000);
});
