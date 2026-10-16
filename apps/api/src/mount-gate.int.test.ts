/**
 * Task 14.3 of openspec/changes/archive/2026-10-14-043-identity-lifecycle-and-org-admin (spec
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

import { createRecordingEmailSender } from '@tayzu/auth';
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
const HMAC_SECRET = 'mount-gate-hmac-test-only-secret-0123456789-abcdef';
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
    on = await createApp({
      ...base,
      ...{ mountIdentityRoutes: true, identityTokenHmacSecret: HMAC_SECRET },
    });
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

/**
 * Task 16.11c (Resolved decision Q147; VCDM O-5): with the mount switch on, `createApp`
 * refuses to start without `IDENTITY_TOKEN_HMAC_SECRET`, in every environment (the test
 * harness included), so the recipient cap and the notices are never silently skipped.
 *
 * Production symbol expected (`./server.js`): `CreateAppOptions.identityTokenHmacSecret?:
 * string`, the secret of the recipient key. With `mountIdentityRoutes: true`, `createApp`
 * rejects when neither it nor `email.recipientKeySecret` is set (or the one given is
 * empty). With the switch off, the secret stays optional. (Passed through a spread so
 * this file type-checks before the option exists.)
 */
describe('createApp refuses to mount the identity routes without a secret (task 16.11c, Q147)', () => {
  async function base() {
    const pools = await harnessPools();
    return {
      ...pools,
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ORIGIN],
    };
  }

  /** The error `createApp` rejects with, or `undefined` when it started (the app is closed). */
  async function startError(options: Parameters<typeof createApp>[0]): Promise<unknown> {
    try {
      await (await createApp(options)).close();
      return undefined;
    } catch (error) {
      return error;
    }
  }

  it('the start fails with the switch on and no IDENTITY_TOKEN_HMAC_SECRET', async () => {
    const options = { ...(await base()), ...{ mountIdentityRoutes: true } };
    const error = await startError(options);
    expect(error, 'createApp must refuse to start').toBeInstanceOf(Error);
    expect((error as Error).message).toContain('IDENTITY_TOKEN_HMAC_SECRET');
  }, 60_000);

  it('the start fails with the switch on and an empty IDENTITY_TOKEN_HMAC_SECRET', async () => {
    const options = {
      ...(await base()),
      ...{ mountIdentityRoutes: true, identityTokenHmacSecret: '' },
    };
    const error = await startError(options);
    expect(error, 'createApp must refuse to start').toBeInstanceOf(Error);
    expect((error as Error).message).toContain('IDENTITY_TOKEN_HMAC_SECRET');
  }, 60_000);

  it('the start succeeds with the switch on and a secret', async () => {
    const app = await createApp({
      ...(await base()),
      ...{ mountIdentityRoutes: true, identityTokenHmacSecret: HMAC_SECRET },
    });
    await app.close();
  }, 60_000);

  it('the start succeeds with the switch off and no secret', async () => {
    const app = await createApp(await base());
    await app.close();
  }, 60_000);
});

/**
 * Task 6.1 of openspec/changes/044-password-reset-and-account-recovery, scenario "Off by
 * default" for the request route (spec requirement "The reset routes are public, API-only and
 * behind the mount switch").
 *
 * - GIVEN `MOUNT_IDENTITY_ROUTES` is unset
 * - WHEN either reset route is called, with or without authentication
 * - THEN it answers exactly as an unknown `/v1` path does
 *
 * Only `POST /v1/auth/password-reset/request` exists at this task (the confirm route joins in 8.3).
 * The control is the same request against an app with the switch on, which answers the uniform
 * `200 { "accepted": true }`.
 *
 * Production symbols expected: as in `password-reset-request.http.int.test.ts` (the route, and
 * `CreateAppOptions.email.passwordResetLinkBaseUrl`, passed here through a variable).
 */
describe('the password reset request route is unreachable until mounted (044 task 6.1)', () => {
  const REQUEST_PATH = '/v1/auth/password-reset/request';
  let off: App;
  let on: App;
  let cookie: string;

  beforeAll(async () => {
    const pools = await harnessPools();
    const base = {
      ...pools,
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ORIGIN],
    };
    const email = {
      sender: createRecordingEmailSender(),
      invitationLinkBaseUrl: ORIGIN,
      passwordResetLinkBaseUrl: ORIGIN,
      disabledTenantIds: [] as string[],
      killSwitch: false,
      recipientKeySecret: HMAC_SECRET,
      tenantCap: { max: 1000, windowSeconds: 3600 },
      recipientCap: { max: 1000, windowSeconds: 86_400 },
    };
    off = await createApp({ ...base, ...{ email } });
    on = await createApp({
      ...base,
      mountIdentityRoutes: true,
      identityTokenHmacSecret: HMAC_SECRET,
      ...{ email },
    });

    const suffix = randomUUID();
    const tenant = await bootstrapTestTenant(off.auth, {
      pool: testAppPool(),
      name: 'Reset Gate Admin',
      email: `reset-gate-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Reset Gate Org ${suffix}`,
      organizationSlug: `reset-gate-${suffix}`,
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

  async function post(
    app: App,
    url: string,
    caller: 'anonymous' | 'authenticated',
  ): Promise<Answer> {
    const response = await app.app.inject({
      method: 'POST',
      url,
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
        'x-forwarded-for': randomIp(),
        ...(caller === 'authenticated' ? { cookie } : {}),
        ...csrfHeaders('POST'),
      },
      payload: JSON.stringify({ email: `nobody-${randomUUID()}@example.test` }),
    });
    let body: unknown;
    try {
      body = response.json();
    } catch {
      body = response.body;
    }
    return { status: response.statusCode, body };
  }

  it('Off by default: unauthenticated, the request route answers as an unknown /v1 path does (401 CATALOG_CONTEXT_REQUIRED)', async () => {
    const unknown = await post(off, `/v1/unknown-${randomUUID().slice(0, 8)}`, 'anonymous');
    expect(unknown.status).toBe(401);
    expect(unknown.body).toMatchObject({ code: 'CATALOG_CONTEXT_REQUIRED' });

    const answer = await post(off, REQUEST_PATH, 'anonymous');

    expect(answer).toEqual(unknown);
  });

  it('Off by default: authenticated, the request route answers as an unknown /v1 path does (the router 404)', async () => {
    const unknown = await post(off, `/v1/unknown-${randomUUID().slice(0, 8)}`, 'authenticated');
    expect(unknown.status).toBe(404);

    const answer = await post(off, REQUEST_PATH, 'authenticated');

    expect(answer).toEqual(unknown);
  });

  it('Off by default: the Fastify route table has no request route while off and has it while on', async () => {
    expect(off.app.hasRoute({ method: 'POST', url: REQUEST_PATH })).toBe(false);
    expect(on.app.hasRoute({ method: 'POST', url: REQUEST_PATH })).toBe(true);

    // The control: with the switch on, the same anonymous request reaches the route.
    const answer = await post(on, REQUEST_PATH, 'anonymous');
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ accepted: true });
  });
});
