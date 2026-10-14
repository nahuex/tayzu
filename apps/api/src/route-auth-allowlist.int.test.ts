/**
 * Task 14.3b of openspec/changes/043-identity-lifecycle-and-org-admin (spec
 * requirement "Identity routes are unreachable until mounted", last sentence;
 * design D15, VCDM G4).
 *
 * Task 14.3b Verify: "`route-auth-allowlist.int.test.ts` enumerates the Fastify route
 * table of the server with the switch on, fails for a route that is neither on the
 * allowlist nor behind `resolveContext`, and fails when a scratch route is added to the
 * server outside both."
 *
 * Scenario (verbatim from the spec):
 * - "A new Fastify route cannot be public by accident": GIVEN the switch is on; WHEN the
 *   Fastify route table is enumerated; THEN every route outside the public allowlist is
 *   behind the authenticated context resolution, and a route added outside both fails
 *   the test.
 *
 * ## Harness
 *
 * `createApp` over the real pools, Cerbos and Better Auth, with the switch ON. The route
 * table is read with an `onRoute` hook that the test installs through the
 * `configureApp` seam (Fastify refuses new routes and new `onRoute` hooks once the
 * instance is ready, so the seam is the only way to see every route or to add a scratch
 * route to the server). "Behind `resolveContext`" is checked by behavior, not by
 * reading the source: an anonymous call to every (method, path) pair of the table that
 * is not on the allowlist must answer 401 `CATALOG_CONTEXT_REQUIRED`, the answer of the
 * catch-all, which resolves the context first. A route that answers anything else is
 * public.
 *
 * ## Production symbols expected
 *
 * - `CreateAppOptions.configureApp?: (app: FastifyInstance) => void | Promise<void>`
 *   (`./server.js`): called once, right after the Fastify instance is created and
 *   before any hook or route is registered. Omitted: nothing happens. (The test passes
 *   it through a spread so that this file type-checks before the option exists.)
 * - `PUBLIC_ROUTE_ALLOWLIST` (`./public-routes.js`): the explicit, reviewed list of the
 *   Fastify routes that are public, as
 *   `readonly { method: string; path: string; reason: string }[]`. `path` is the route
 *   as Fastify registers it (for example `/api/auth/*`), `method` is an upper-case HTTP
 *   method or `'*'` for any, and `reason` is non-empty. A `HEAD` route Fastify derives
 *   from a `GET` entry is covered by that entry. It lists the accept route
 *   (`POST /v1/auth/invitations/accept`) and holds no entry for a route that is not
 *   registered with the switch on.
 */
import { randomInt, randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { csrfHeaders } from './__fixtures__/csrf.js';
import { harnessPools } from './__fixtures__/pools.js';
import { PUBLIC_ROUTE_ALLOWLIST } from './public-routes.js';
import { createApp, type App } from './server.js';

const ORIGIN = 'https://app.tayzu.test';
const ACCEPT_PATH = '/v1/auth/invitations/accept';

interface AllowlistEntry {
  readonly method: string;
  readonly path: string;
  readonly reason: string;
}

interface RoutePair {
  readonly method: string;
  readonly path: string;
}

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

/** A concrete URL for a route pattern: a wildcard or a parameter becomes a random segment. */
function concrete(pattern: string): string {
  return pattern.replace(/\*|:[A-Za-z0-9_]+/g, () => `probe-${randomUUID().slice(0, 8)}`);
}

function isAllowlisted(allowlist: readonly AllowlistEntry[], pair: RoutePair): boolean {
  const matches = (method: string): boolean =>
    allowlist.some(
      (entry) => entry.path === pair.path && (entry.method === '*' || entry.method === method),
    );
  // Fastify derives a HEAD route from every GET route.
  return matches(pair.method) || (pair.method === 'HEAD' && matches('GET'));
}

interface Collected {
  readonly pairs: readonly RoutePair[];
  readonly install: (app: FastifyInstance) => void;
}

/** Collects every (method, path) pair the server registers, through an `onRoute` hook. */
function routeCollector(): Collected {
  const pairs: RoutePair[] = [];
  return {
    pairs,
    install: (app) => {
      app.addHook('onRoute', (route) => {
        const methods: readonly string[] = Array.isArray(route.method)
          ? route.method
          : [route.method];
        for (const method of methods) {
          pairs.push({ method: method.toUpperCase(), path: route.url });
        }
      });
    },
  };
}

/**
 * The routes that are neither on the allowlist nor behind `resolveContext`: the ones an
 * anonymous call does not answer 401 `CATALOG_CONTEXT_REQUIRED`.
 */
async function unguardedRoutes(
  app: App,
  pairs: readonly RoutePair[],
  allowlist: readonly AllowlistEntry[],
): Promise<string[]> {
  const offenders: string[] = [];
  for (const pair of pairs) {
    if (isAllowlisted(allowlist, pair)) {
      continue;
    }
    const response = await app.app.inject({
      method: pair.method as 'GET',
      url: concrete(pair.path),
      headers: {
        origin: ORIGIN,
        'x-forwarded-for': randomIp(),
        ...csrfHeaders(pair.method),
      },
    });
    let code: unknown;
    if (pair.method !== 'HEAD') {
      try {
        code = response.json<{ code?: unknown }>().code;
      } catch {
        code = undefined;
      }
    }
    const guarded =
      response.statusCode === 401 &&
      (pair.method === 'HEAD' || code === 'CATALOG_CONTEXT_REQUIRED');
    if (!guarded) {
      offenders.push(`${pair.method} ${pair.path}`);
    }
  }
  return offenders;
}

describe('every Fastify route is public-allowlisted or behind resolveContext (task 14.3b, VCDM G4)', () => {
  const real = routeCollector();
  const scratch = routeCollector();
  const scratchPublic = `/scratch-public-${randomUUID().slice(0, 8)}`;
  const scratchUnderV1 = `/v1/scratch-${randomUUID().slice(0, 8)}`;
  let app: App;
  let scratchApp: App;
  const allowlist: readonly AllowlistEntry[] = PUBLIC_ROUTE_ALLOWLIST;

  beforeAll(async () => {
    const pools = await harnessPools();
    const base = {
      ...pools,
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ORIGIN],
      mountIdentityRoutes: true,
      ...{ identityTokenHmacSecret: 'mount-wiring-test-only-secret-0123456789-abcdef' },
    };
    // Spread so this file type-checks before `CreateAppOptions.configureApp` exists.
    app = await createApp({ ...base, ...{ configureApp: real.install } });
    scratchApp = await createApp({
      ...base,
      ...{
        configureApp: (instance: FastifyInstance): void => {
          scratch.install(instance);
          instance.get(scratchPublic, () => ({ secret: 'public by accident' }));
          instance.get(scratchUnderV1, () => ({ secret: 'public by accident' }));
        },
      },
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await scratchApp.close();
  }, 60_000);

  it('enumerates the Fastify route table with the switch on, accept route and catch-all included', () => {
    expect(real.pairs).toContainEqual({ method: 'POST', path: ACCEPT_PATH });
    expect(real.pairs).toContainEqual({ method: 'GET', path: '/v1/*' });
  });

  it('A new Fastify route cannot be public by accident: every route outside the allowlist answers 401 CATALOG_CONTEXT_REQUIRED to an anonymous caller', async () => {
    expect(await unguardedRoutes(app, real.pairs, allowlist)).toEqual([]);
  }, 120_000);

  it('the allowlist is explicit: it names the accept route, gives a reason per entry and holds no stale entry', () => {
    expect(allowlist).toContainEqual(
      expect.objectContaining({ method: 'POST', path: ACCEPT_PATH }),
    );
    for (const entry of allowlist) {
      expect(entry.reason.trim(), `${entry.method} ${entry.path}`).not.toBe('');
      const registered = real.pairs.some(
        (pair) =>
          pair.path === entry.path &&
          (entry.method === '*' || pair.method === entry.method || pair.method === 'HEAD'),
      );
      expect(registered, `${entry.method} ${entry.path} is not a registered route`).toBe(true);
    }
  });

  it('a scratch route added to the server outside both fails the check', async () => {
    expect(scratch.pairs).toContainEqual({ method: 'GET', path: scratchPublic });
    expect(scratch.pairs).toContainEqual({ method: 'GET', path: scratchUnderV1 });

    const offenders = await unguardedRoutes(scratchApp, scratch.pairs, allowlist);

    expect(offenders).toContain(`GET ${scratchPublic}`);
    expect(offenders).toContain(`GET ${scratchUnderV1}`);
    // Only the scratch routes (and the HEAD routes Fastify derives from them) offend.
    expect(
      offenders.filter(
        (route) => !route.includes(scratchPublic) && !route.includes(scratchUnderV1),
      ),
    ).toEqual([]);
  }, 120_000);

  it('a scratch route is not an offender once it is on the allowlist', async () => {
    const extended: readonly AllowlistEntry[] = [
      ...allowlist,
      { method: 'GET', path: scratchPublic, reason: 'scratch' },
      { method: 'GET', path: scratchUnderV1, reason: 'scratch' },
    ];

    expect(await unguardedRoutes(scratchApp, scratch.pairs, extended)).toEqual([]);
  }, 120_000);
});
