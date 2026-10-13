/**
 * Task 14.3 of openspec/changes/043-identity-lifecycle-and-org-admin (spec
 * requirement "Identity routes are unreachable until mounted"; design D15).
 *
 * Task 14.3 Verify (the part of this file): "`mount-gate.int.test.ts` covers
 * "Routes answer like an unknown path while the switch is off" for both callers
 * and "No route is registered outside the switch" by enumerating the Fastify route
 * table **and** the router's procedures".
 *
 * Scenarios (verbatim from the spec):
 * - "Routes answer like an unknown path while the switch is off": GIVEN the switch
 *   is off, which is the default; WHEN any identity route (including the public
 *   accept route) is called, with and without authentication; THEN each answers
 *   exactly as an unknown `/v1` path does.
 * - "No route is registered outside the switch": WHEN the Fastify route table and
 *   the router's procedures are enumerated; THEN every identity and credential
 *   route is registered or reachable only behind the switch.
 *
 * ## Harness
 *
 * `createApp` over the real pools, Cerbos and Better Auth, driven with
 * `app.app.inject`. Two apps: one with the switch left at its default (off) and
 * one with it on, the control that proves the same requests do reach the routes
 * when it is on. The thirteen procedures are the router's own list, read from
 * `generateIdentityOpenApiDocument` (it walks `createIdentityRouter`'s procedures),
 * so a new procedure is covered without editing this file; the fourteenth route is
 * the plain accept route. The authenticated caller is an MFA-enrolled admin with a
 * fresh verification (so the catch-all's enrollment gate lets it through). The
 * baseline is an unknown `/v1` path with the same method and caller.
 *
 * ## Production symbols expected
 *
 * - `CreateAppOptions.mountIdentityRoutes?: boolean` (`./server.js`), default off.
 *   Off: the accept route is not registered and the identity procedures are not in
 *   the router handed to the `OpenAPIHandler`. On: both exist. (The test passes it
 *   through a spread so that this file type-checks before the option exists.)
 */
import { randomInt, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bootstrapTestTenant,
  testAppPool,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { csrfHeaders } from './__fixtures__/csrf.js';
import { freshMfaSessionCookie } from './__fixtures__/fresh-mfa.js';
import { harnessPools } from './__fixtures__/pools.js';
import { generateIdentityOpenApiDocument } from './identity-openapi.js';
import { createApp, type App } from './server.js';

const ORIGIN = 'https://app.tayzu.test';
const TEST_PASSWORD = 'correct horse battery staple';
const ACCEPT_PATH = '/v1/auth/invitations/accept';
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

interface Route {
  readonly method: Method;
  readonly path: string;
}

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

/** The thirteen oRPC routes, from the router's own procedures, plus the plain accept route. */
async function fourteenRoutes(): Promise<readonly Route[]> {
  const document = (await generateIdentityOpenApiDocument()) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const procedures = Object.entries(document.paths).flatMap(([path, operations]) =>
    Object.keys(operations).map((method) => ({ method: method.toUpperCase() as Method, path })),
  );
  return [...procedures, { method: 'POST', path: ACCEPT_PATH }];
}

/** A concrete URL for a templated path: the `{user}` identifier is an email, the rest ids. */
function concrete(path: string): string {
  return path.replace(/\{([^}]+)\}/g, (_match, name: string) =>
    name === 'user' ? 'nobody@example.test' : randomUUID(),
  );
}

describe('the identity routes are unreachable until mounted (task 14.3, design D15)', () => {
  let off: App;
  let on: App;
  let routes: readonly Route[];
  let cookie: string;

  beforeAll(async () => {
    const pools = await harnessPools();
    const base = {
      ...pools,
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ORIGIN],
    };
    // The switch is not passed at all: off is the default.
    off = await createApp(base);
    // Spread so this file type-checks before `CreateAppOptions.mountIdentityRoutes` exists.
    on = await createApp({ ...base, ...{ mountIdentityRoutes: true } });
    routes = await fourteenRoutes();

    const suffix = randomUUID();
    const tenant = await bootstrapTestTenant(off.auth, {
      pool: testAppPool(),
      name: 'Mount Gate Admin',
      email: `mount-gate-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Mount Gate Org ${suffix}`,
      organizationSlug: `mount-gate-${suffix}`,
      ip: randomIp(),
    });
    cookie = await freshMfaSessionCookie(off, {
      email: tenant.email,
      password: TEST_PASSWORD,
      enrollmentCookie: tenant.cookie,
      origin: ORIGIN,
    });
  }, 60_000);

  afterAll(async () => {
    await off.close();
    await on.close();
  }, 60_000);

  async function call(
    app: App,
    method: Method,
    url: string,
    caller: 'anonymous' | 'authenticated',
  ): Promise<Answer> {
    const response = await app.app.inject({
      method,
      url,
      headers: {
        origin: ORIGIN,
        'x-forwarded-for': randomIp(),
        ...(caller === 'authenticated' ? { cookie } : {}),
        ...csrfHeaders(method),
        ...(method === 'GET' || method === 'DELETE' ? {} : { 'content-type': 'application/json' }),
      },
      ...(method === 'GET' || method === 'DELETE' ? {} : { payload: '{}' }),
    });
    let body: unknown;
    try {
      body = response.json();
    } catch {
      body = response.body;
    }
    return { status: response.statusCode, body };
  }

  it('lists the thirteen router procedures and the accept route as the fourteen routes', () => {
    expect(routes).toHaveLength(14);
    expect(routes.filter((route) => route.path !== ACCEPT_PATH)).toHaveLength(13);
  });

  it('Routes answer like an unknown path while the switch is off: unauthenticated, 401 CATALOG_CONTEXT_REQUIRED', async () => {
    for (const route of routes) {
      const unknown = await call(
        off,
        route.method,
        `/v1/unknown-${randomUUID().slice(0, 8)}`,
        'anonymous',
      );
      expect(unknown.status, 'the baseline of an unknown path').toBe(401);
      expect(unknown.body).toMatchObject({ code: 'CATALOG_CONTEXT_REQUIRED' });

      const answer = await call(off, route.method, concrete(route.path), 'anonymous');
      expect(answer, `${route.method} ${route.path}`).toEqual(unknown);
    }
  }, 120_000);

  it('Routes answer like an unknown path while the switch is off: authenticated, the router 404', async () => {
    for (const route of routes) {
      const unknown = await call(
        off,
        route.method,
        `/v1/unknown-${randomUUID().slice(0, 8)}`,
        'authenticated',
      );
      expect(unknown.status, 'the baseline of an unknown path').toBe(404);

      const answer = await call(off, route.method, concrete(route.path), 'authenticated');
      expect(answer, `${route.method} ${route.path}`).toEqual(unknown);
    }
  }, 120_000);

  it('No route is registered outside the switch: the Fastify route table has no accept route while off and has it while on', () => {
    expect(off.app.hasRoute({ method: 'POST', url: ACCEPT_PATH })).toBe(false);
    expect(on.app.hasRoute({ method: 'POST', url: ACCEPT_PATH })).toBe(true);

    expect(off.app.printRoutes({ commonPrefix: false })).not.toContain('invitations');
    expect(on.app.printRoutes({ commonPrefix: false })).toContain('invitations');
  });

  it('No route is registered outside the switch: no router procedure is reachable while off, and every one is while on', async () => {
    for (const route of routes.filter((candidate) => candidate.path !== ACCEPT_PATH)) {
      const url = concrete(route.path);
      const closed = await call(off, route.method, url, 'authenticated');
      expect(closed.body, `off: ${route.method} ${route.path}`).toMatchObject({
        code: 'NOT_FOUND',
      });

      // The control: with the switch on, the same request is matched by the router, so
      // whatever it answers, it is not the unknown-path answer.
      const open = await call(on, route.method, url, 'authenticated');
      expect(open.body, `on: ${route.method} ${route.path}`).not.toMatchObject({
        code: 'NOT_FOUND',
      });
    }
  }, 120_000);
});
