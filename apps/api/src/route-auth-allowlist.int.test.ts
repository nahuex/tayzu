/**
 * Task 14.3b of openspec/changes/archive/2026-10-14-043-identity-lifecycle-and-org-admin (spec
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
import { fileURLToPath } from 'node:url';

import {
  ALLOWED_AUTH_ROUTES,
  AUTH_BASE_PATH,
  createRecordingEmailSender,
  isAllowedAuthPath,
} from '@tayzu/auth';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { csrfHeaders } from './__fixtures__/csrf.js';
import { testEmailOptions } from './__fixtures__/email-options.js';
import { harnessPools } from './__fixtures__/pools.js';
import { PUBLIC_ROUTE_ALLOWLIST } from './public-routes.js';
import { createApp, type App } from './server.js';
import { ROOT_BUILD_FILES } from './web-static.js';

const ORIGIN = 'https://app.tayzu.test';
const ACCEPT_PATH = '/v1/auth/invitations/accept';
const REAUTH_CALLBACK_PATH = '/v1/auth/visma-connect/reauthorize/callback';

interface AllowlistEntry {
  readonly method: string;
  readonly path: string;
  readonly reason: string;
  /** 003 task 4.3 (Q39): `true` covers every registered route whose path starts with `path`. */
  readonly prefix?: boolean;
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

/** An exact entry names the route as registered; a prefix entry covers every route under it. */
function coversPath(entry: AllowlistEntry, path: string): boolean {
  return entry.prefix === true ? path.startsWith(entry.path) : entry.path === path;
}

function isAllowlisted(allowlist: readonly AllowlistEntry[], pair: RoutePair): boolean {
  const matches = (method: string): boolean =>
    allowlist.some(
      (entry) => coversPath(entry, pair.path) && (entry.method === '*' || entry.method === method),
    );
  // Fastify derives a HEAD route from every GET route.
  return matches(pair.method) || (pair.method === 'HEAD' && matches('GET'));
}

/** The entry is a registered route of the table (a prefix entry: at least one route under it). */
function isRegistered(entry: AllowlistEntry, pairs: readonly RoutePair[]): boolean {
  return pairs.some(
    (pair) =>
      coversPath(entry, pair.path) &&
      (entry.method === '*' || pair.method === entry.method || pair.method === 'HEAD'),
  );
}

/**
 * 003 task 4.3 (design D9, Q39): the reviewed entries of the web build's routes, which are
 * registered only when `webDistDir` (`WEB_DIST_DIR`) is set: a prefix entry for the hashed
 * assets (`wildcard: false` registers one route per file), and exact entries for the SPA
 * fallback (`GET /*`) and each root build file.
 */
const WEB_ENTRIES: readonly Omit<AllowlistEntry, 'reason'>[] = [
  { method: 'GET', path: '/assets/', prefix: true },
  { method: 'GET', path: '/*' },
  ...Object.keys(ROOT_BUILD_FILES).map((name) => ({ method: 'GET', path: `/${name}` })),
];

function isWebEntry(entry: AllowlistEntry): boolean {
  return WEB_ENTRIES.some(
    (web) =>
      web.method === entry.method &&
      web.path === entry.path &&
      (web.prefix === true) === (entry.prefix === true),
  );
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
      // 044 N4: the switch needs the email path to start.
      email: testEmailOptions(),
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

  /*
   * 003 task 3.9 (design D8): "The route is in no public allowlist;
   * `route-auth-allowlist.int.test.ts` keeps covering it." `GET /v1/me` is its own route,
   * registered before the catch-all, so the behavioral check below reaches it as itself; it
   * answers an anonymous caller like the catch-all only because it is not on the allowlist.
   */
  it('GET /v1/me (003 task 3.9, design D8) is a registered route of its own and on no public allowlist', () => {
    expect(real.pairs).toContainEqual({ method: 'GET', path: '/v1/me' });
    expect(allowlist.filter((entry) => entry.path === '/v1/me')).toEqual([]);
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
      // 003 task 4.3 (Q39): a web build entry is registered only with a build, so the
      // second harness app below proves it registered; without a build it must not be.
      if (isWebEntry(entry)) {
        expect(
          isRegistered(entry, real.pairs),
          `${entry.method} ${entry.path} is registered without a build directory`,
        ).toBe(false);
        continue;
      }
      expect(
        isRegistered(entry, real.pairs),
        `${entry.method} ${entry.path} is not a registered route`,
      ).toBe(true);
    }
  });

  /*
   * 048 task 6.5 (design D6, Q7): "Only `GET REAUTH_CALLBACK_PATH` is registered; `scope.post`
   * and its form parser are removed [...] `PUBLIC_ROUTE_ALLOWLIST`'s entry becomes `GET` with
   * the reason "authenticated by the single-use state, the nonce and the session cookie"."
   * Replaces the callback's former `'*'` entry, which covered the `form_post` `POST`.
   */
  it('the re-authorization callback is allowlisted for GET only, with the reason of 048 D6, and only GET is registered (048 task 6.5)', () => {
    const entries = allowlist.filter((entry) => entry.path === REAUTH_CALLBACK_PATH);

    expect(entries.map((entry) => entry.method)).toEqual(['GET']);
    expect(entries[0]?.prefix).toBeUndefined();
    expect(entries[0]?.reason).toContain(
      'authenticated by the single-use state, the nonce and the session cookie',
    );
    expect(real.pairs).toContainEqual({ method: 'GET', path: REAUTH_CALLBACK_PATH });
    expect(
      real.pairs.filter((pair) => pair.path === REAUTH_CALLBACK_PATH).map((pair) => pair.method),
      'no POST (form_post) callback route is registered',
    ).not.toContain('POST');
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

/**
 * Task 4.3 of change `003-catalog-ui-core` (design D9 "Allowlists", Resolved decision Q39).
 *
 * Task 4.3: "`PUBLIC_ROUTE_ALLOWLIST` gains a reviewed prefix entry for `/assets/` and exact
 * entries for the fallback and each root build file, each with its reason. Verify: [...]
 * `route-auth-allowlist.int.test.ts` gains a second harness app started with the fixture
 * `web-dist` and `WEB_DIST_DIR`, in which the new entries are registered routes, and the
 * first app still proves every other route closed."
 *
 * Design D9 (excerpt): "`PUBLIC_ROUTE_ALLOWLIST` gains reviewed entries, each with its reason
 * ("static, public by nature, no data"): a prefix entry for `/assets/`, because
 * `wildcard: false` registers one route per file, and exact entries for the fallback and each
 * root build file."
 *
 * ## Harness
 *
 * The first describe's app (no build) keeps proving every route closed and, through its
 * stale-entry check, that no web entry is registered without a build. This second app is
 * the same `createApp` with `webDistDir` (the host's `WEB_DIST_DIR`) set to the committed
 * fixture build, so the asset routes, the root build files and the fallback are registered.
 *
 * ## Production symbols expected (the red phase)
 *
 * - `PublicRoute` (`./public-routes.js`) gains `readonly prefix?: boolean`: `true` makes the
 *   entry cover every registered route whose path starts with `path`.
 * - `PUBLIC_ROUTE_ALLOWLIST` gains, each with a non-empty reason:
 *   `{ method: 'GET', path: '/assets/', prefix: true }`, `{ method: 'GET', path: '/*' }` (the
 *   SPA fallback route) and `{ method: 'GET', path: '/<name>' }` for each key of
 *   `ROOT_BUILD_FILES` (`/theme-init.js`, `/favicon.svg`). No other entry is a prefix entry.
 *
 * ## Why this fails right now
 *
 * The allowlist holds none of the web entries and no fallback route exists, so the entry,
 * registration and offender checks fail.
 */
describe('the web build routes are reviewed public routes (003 task 4.3, design D9, Q39)', () => {
  const FIXTURE_WEB_DIST = fileURLToPath(new URL('./__fixtures__/web-dist/', import.meta.url));
  const bare = routeCollector();
  const withWeb = routeCollector();
  let bareApp: App;
  let webApp: App;
  const allowlist: readonly AllowlistEntry[] = PUBLIC_ROUTE_ALLOWLIST;
  const key = (pair: RoutePair): string => `${pair.method} ${pair.path}`;

  beforeAll(async () => {
    const pools = await harnessPools();
    const base = {
      ...pools,
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ORIGIN],
      mountIdentityRoutes: true,
      identityTokenHmacSecret: 'mount-wiring-test-only-secret-0123456789-abcdef',
      email: testEmailOptions(),
    };
    bareApp = await createApp({ ...base, configureApp: bare.install });
    webApp = await createApp({
      ...base,
      webDistDir: FIXTURE_WEB_DIST,
      configureApp: withWeb.install,
    });
  }, 60_000);

  afterAll(async () => {
    await bareApp.close();
    await webApp.close();
  }, 60_000);

  it('the allowlist holds the reviewed web entries, each with its reason', () => {
    for (const web of WEB_ENTRIES) {
      const entry = allowlist.find(
        (candidate) =>
          candidate.method === web.method &&
          candidate.path === web.path &&
          (candidate.prefix === true) === (web.prefix === true),
      );
      expect(entry, `${web.method} ${web.path} is on the allowlist`).toBeDefined();
      expect(entry?.reason.trim(), `${web.method} ${web.path}`).not.toBe('');
    }
    // The `/assets/` entry is the only prefix entry.
    expect(
      allowlist
        .filter((entry) => entry.prefix === true)
        .map((entry) => `${entry.method} ${entry.path}`),
    ).toEqual(['GET /assets/']);
  });

  it('with the fixture build, every allowlist entry is a registered route, web entries included', () => {
    for (const entry of allowlist) {
      expect(
        isRegistered(entry, withWeb.pairs),
        `${entry.method} ${entry.path} is not a registered route`,
      ).toBe(true);
    }
    for (const web of WEB_ENTRIES) {
      expect(
        isRegistered({ ...web, reason: 'web' }, withWeb.pairs),
        `${web.method} ${web.path} is registered with a build`,
      ).toBe(true);
    }
    expect(withWeb.pairs).toContainEqual({ method: 'GET', path: '/*' });
    expect(withWeb.pairs).toContainEqual({ method: 'GET', path: '/assets/index-Fx7Wd1Aa.js' });
  });

  it('the build adds only routes the web entries cover', () => {
    const bareKeys = new Set(bare.pairs.map(key));
    const added = withWeb.pairs.filter((pair) => !bareKeys.has(key(pair)));
    const webEntries: readonly AllowlistEntry[] = WEB_ENTRIES.map((web) => ({
      ...web,
      reason: 'web',
    }));

    expect(added.length).toBeGreaterThan(0);
    expect(added.filter((pair) => !isAllowlisted(webEntries, pair)).map(key)).toEqual([]);
    expect(bare.pairs.filter((pair) => isAllowlisted(webEntries, pair)).map(key)).toEqual([]);
  });

  it('with the fixture build, every route outside the allowlist still answers 401 CATALOG_CONTEXT_REQUIRED to an anonymous caller', async () => {
    expect(await unguardedRoutes(webApp, withWeb.pairs, allowlist)).toEqual([]);
  }, 120_000);

  it('without the web entries the web routes would be offenders (they are public)', async () => {
    const withoutWeb = allowlist.filter((entry) => !isWebEntry(entry));

    const offenders = await unguardedRoutes(webApp, withWeb.pairs, withoutWeb);

    expect(offenders).toContain('GET /*');
    expect(offenders).toContain('GET /assets/index-Fx7Wd1Aa.js');
    for (const name of Object.keys(ROOT_BUILD_FILES)) {
      expect(offenders).toContain(`GET /${name}`);
    }
    const webEntries: readonly AllowlistEntry[] = WEB_ENTRIES.map((web) => ({
      ...web,
      reason: 'web',
    }));
    expect(
      offenders.filter((offender) => {
        const [method = '', path = ''] = offender.split(' ');
        return !isAllowlisted(webEntries, { method, path });
      }),
    ).toEqual([]);
  }, 120_000);
});

/**
 * Task 6.1 of openspec/changes/archive/2026-11-16-044-password-reset-and-account-recovery, scenario "A route
 * outside the allowlist cannot be public" (spec requirement "The reset routes are public,
 * API-only and behind the mount switch"): with the switch on, the request route is a new
 * public entry with a reason, and any other route outside the allowlist still answers an
 * anonymous call like the `/v1/*` catch-all. The cases of the describe above stay as they are.
 *
 * Production symbols expected: `POST /v1/auth/password-reset/request` registered when the
 * switch is on (with or without email settings), and its `PUBLIC_ROUTE_ALLOWLIST` entry with a
 * non-empty `reason`.
 */
describe('the password reset request route is a reviewed public route (044 task 6.1)', () => {
  const REQUEST_PATH = '/v1/auth/password-reset/request';
  const collected = routeCollector();
  let app: App;
  const allowlist: readonly AllowlistEntry[] = PUBLIC_ROUTE_ALLOWLIST;

  beforeAll(async () => {
    const pools = await harnessPools();
    const secret = 'mount-wiring-test-only-secret-0123456789-abcdef';
    const email = {
      sender: createRecordingEmailSender(),
      invitationLinkBaseUrl: ORIGIN,
      passwordResetLinkBaseUrl: ORIGIN,
      disabledTenantIds: [] as string[],
      killSwitch: false,
      recipientKeySecret: secret,
      tenantCap: { max: 1000, windowSeconds: 3600 },
      recipientCap: { max: 1000, windowSeconds: 86_400 },
    };
    app = await createApp({
      ...pools,
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ORIGIN],
      mountIdentityRoutes: true,
      identityTokenHmacSecret: secret,
      ...{ email, configureApp: collected.install },
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
  }, 60_000);

  it('the route table holds the request route and the allowlist names it with a reason', () => {
    expect(collected.pairs).toContainEqual({ method: 'POST', path: REQUEST_PATH });
    const entry = allowlist.find((candidate) => candidate.path === REQUEST_PATH);
    expect(entry, 'the request route is on the allowlist').toBeDefined();
    expect(entry?.method).toBe('POST');
    expect(entry?.reason.trim()).not.toBe('');
  });

  it('every other route outside the allowlist still answers 401 CATALOG_CONTEXT_REQUIRED to an anonymous caller', async () => {
    expect(await unguardedRoutes(app, collected.pairs, allowlist)).toEqual([]);
  }, 120_000);

  it('without its allowlist entry the request route would be an offender (it is public)', async () => {
    const withoutEntry = allowlist.filter((candidate) => candidate.path !== REQUEST_PATH);

    const offenders = await unguardedRoutes(app, collected.pairs, withoutEntry);

    expect(offenders).toEqual([`POST ${REQUEST_PATH}`]);
  }, 120_000);
});

/**
 * Task 8.3 of openspec/changes/archive/2026-11-16-044-password-reset-and-account-recovery, scenario "A route
 * outside the allowlist cannot be public" (spec requirement "The reset routes are public,
 * API-only and behind the mount switch"), now covering both reset routes: they are the only new
 * public entries, each with a reason, and any other route outside the allowlist still answers an
 * anonymous call like the `/v1/*` catch-all.
 *
 * Also the _guard_ scenario "No email-only removal of a second factor exists" (spec requirement
 * "Backup codes remain the self-service recovery for a lost authenticator"): WHEN every public
 * route is enumerated; THEN none removes or disables a second factor without a session and a fresh
 * verification. "Every public route" is the Fastify allowlist (`PUBLIC_ROUTE_ALLOWLIST`) and the
 * Better Auth routes it forwards (`ALLOWED_AUTH_ROUTES`).
 *
 * Production symbols expected: `POST /v1/auth/password-reset/confirm` registered when the switch
 * is on, and its `PUBLIC_ROUTE_ALLOWLIST` entry with a non-empty `reason`.
 */
describe('the password reset routes are reviewed public routes (044 task 8.3)', () => {
  const REQUEST_PATH = '/v1/auth/password-reset/request';
  const CONFIRM_PATH = '/v1/auth/password-reset/confirm';
  const collected = routeCollector();
  let app: App;
  const allowlist: readonly AllowlistEntry[] = PUBLIC_ROUTE_ALLOWLIST;

  beforeAll(async () => {
    const pools = await harnessPools();
    const secret = 'mount-wiring-test-only-secret-0123456789-abcdef';
    const email = {
      sender: createRecordingEmailSender(),
      invitationLinkBaseUrl: ORIGIN,
      passwordResetLinkBaseUrl: ORIGIN,
      disabledTenantIds: [] as string[],
      killSwitch: false,
      recipientKeySecret: secret,
      tenantCap: { max: 1000, windowSeconds: 3600 },
      recipientCap: { max: 1000, windowSeconds: 86_400 },
    };
    app = await createApp({
      ...pools,
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ORIGIN],
      mountIdentityRoutes: true,
      identityTokenHmacSecret: secret,
      ...{ email, configureApp: collected.install },
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
  }, 60_000);

  it('the route table holds the confirm route and the allowlist names it with a reason', () => {
    expect(collected.pairs).toContainEqual({ method: 'POST', path: CONFIRM_PATH });
    const entry = allowlist.find((candidate) => candidate.path === CONFIRM_PATH);
    expect(entry, 'the confirm route is on the allowlist').toBeDefined();
    expect(entry?.method).toBe('POST');
    expect(entry?.reason.trim()).not.toBe('');
  });

  it('the two reset routes are the only password-reset entries of the allowlist, each with a reason', () => {
    const resetEntries = allowlist.filter((candidate) => /password-reset/.test(candidate.path));
    expect(resetEntries.map((entry) => `${entry.method} ${entry.path}`).sort()).toEqual([
      `POST ${CONFIRM_PATH}`,
      `POST ${REQUEST_PATH}`,
    ]);
    for (const entry of resetEntries) {
      expect(entry.reason.trim(), entry.path).not.toBe('');
    }
  });

  it('every other route outside the allowlist still answers 401 CATALOG_CONTEXT_REQUIRED to an anonymous caller', async () => {
    expect(await unguardedRoutes(app, collected.pairs, allowlist)).toEqual([]);
  }, 120_000);

  it('without its allowlist entry the confirm route would be an offender (it is public)', async () => {
    const withoutEntry = allowlist.filter((candidate) => candidate.path !== CONFIRM_PATH);

    const offenders = await unguardedRoutes(app, collected.pairs, withoutEntry);

    expect(offenders).toEqual([`POST ${CONFIRM_PATH}`]);
  }, 120_000);

  it('No email-only removal of a second factor exists: no public Fastify route and no allowlisted Better Auth route disables or removes a second factor', () => {
    const publicPaths = allowlist.map((entry) => entry.path);
    for (const path of publicPaths) {
      expect(path, 'a public Fastify route names a second factor').not.toMatch(/two-?factor|mfa/i);
    }
    const betterAuthRoutes = [...ALLOWED_AUTH_ROUTES];
    expect(betterAuthRoutes.length).toBeGreaterThan(0);
    for (const route of betterAuthRoutes) {
      expect(route, 'an allowlisted Better Auth route removes a second factor').not.toMatch(
        /two-factor\/(disable|remove|delete|reset|unenroll)/i,
      );
    }
    expect(isAllowedAuthPath(`${AUTH_BASE_PATH}/two-factor/disable`)).toBe(false);
  });

  it('No email-only removal of a second factor exists: an anonymous call to the second-factor disable route does not succeed', async () => {
    const response = await app.app.inject({
      method: 'POST',
      url: `${AUTH_BASE_PATH}/two-factor/disable`,
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
        'x-forwarded-for': randomIp(),
        ...csrfHeaders('POST'),
      },
      payload: JSON.stringify({ password: 'irrelevant-password-1!' }),
    });

    expect(response.statusCode).toBe(404);
  });
});
