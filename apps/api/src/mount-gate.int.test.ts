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
 * when it is on. The fifteen procedures (`045` task 5.1 adds `identity.organization.delete`,
 * `DELETE /v1/organization`) are the router's own list, read from
 * `generateIdentityOpenApiDocument` (it walks `createIdentityRouter`'s procedures),
 * so a new procedure is covered without editing this file; the sixteenth route is
 * the plain accept route. The two plain password-reset routes of `044` are not in this
 * list: their own suites below cover them. The authenticated caller is an MFA-enrolled admin with a
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

import { OpenAPIHandler } from '@orpc/openapi/fastify';
import { createRecordingEmailSender, type AuthInstance } from '@tayzu/auth';
import type { CerbosClient } from '@tayzu/authz';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bootstrapTestTenant,
  testAppPool,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { csrfHeaders } from './__fixtures__/csrf.js';
import { testEmailOptions } from './__fixtures__/email-options.js';
import { freshMfaSessionCookie } from './__fixtures__/fresh-mfa.js';
import { harnessPools } from './__fixtures__/pools.js';
import type { AuthRepository } from './identity/auth-repository.js';
import { generateIdentityOpenApiDocument } from './identity-openapi.js';
import { createIdentityRouter } from './identity-router.js';
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

/** The fifteen oRPC routes, from the router's own procedures, plus the plain accept route. */
async function sixteenRoutes(): Promise<readonly Route[]> {
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
      ...{
        mountIdentityRoutes: true,
        identityTokenHmacSecret: HMAC_SECRET,
        // 044 N4: the switch needs the email path to start.
        email: testEmailOptions(),
      },
    });
    routes = await sixteenRoutes();

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

  it('lists the fifteen router procedures and the accept route as the sixteen routes', () => {
    expect(routes).toHaveLength(16);
    expect(routes.filter((route) => route.path !== ACCEPT_PATH)).toHaveLength(15);
    expect(routes, '045 task 5.1: the org-deletion request').toContainEqual({
      method: 'DELETE',
      path: '/v1/organization',
    });
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
      ...{
        mountIdentityRoutes: true,
        identityTokenHmacSecret: HMAC_SECRET,
        // 044 N4: the switch needs the email path to start.
        email: testEmailOptions(),
      },
    });
    await app.close();
  }, 60_000);

  it('the start succeeds with the switch off and no secret', async () => {
    const app = await createApp(await base());
    await app.close();
  }, 60_000);
});

/**
 * Fix cycle N4 under task 16.2 of openspec/changes/archive/2026-11-16-044-password-reset-and-account-recovery
 * (design D9 "Startup failure rules"; Resolved decision Q36 row N4; the precedent is `043` Q147
 * above). Spec requirement "The reset routes are public, API-only and behind the mount switch",
 * scenario "A direct start without the email options fails too" (verbatim):
 *
 * - WHEN `createApp` is called with the switch on and no email options at all
 * - THEN it fails naming `EMAIL_PROVIDER` and never a value, and with the switch off the email
 *   options stay optional
 *
 * Production behavior expected (`./server.js`): with `mountIdentityRoutes: true` and
 * `CreateAppOptions.email` omitted, `createApp` rejects with an error whose message names
 * `EMAIL_PROVIDER` and carries no configured value. The recipient key secret is given here, so
 * the Q147 rule (which runs first) is not what fails the start.
 */
describe('createApp refuses to mount the identity routes without the email path (044 task 16.2, N4)', () => {
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

  it('A direct start without the email options fails too: the start fails with the switch on and no email option, naming EMAIL_PROVIDER and no value', async () => {
    const options = {
      ...(await base()),
      mountIdentityRoutes: true,
      identityTokenHmacSecret: HMAC_SECRET,
    };

    const error = await startError(options);

    expect(error, 'createApp must refuse to start').toBeInstanceOf(Error);
    const { message } = error as Error;
    expect(message).toContain('EMAIL_PROVIDER');
    // Never a value: nothing the host configured appears in the message.
    for (const value of [HMAC_SECRET, TEST_SECRET, ORIGIN, options.cerbosAddress]) {
      expect(message).not.toContain(value);
    }
  }, 60_000);

  it('A direct start without the email options fails too: with the switch off the email option stays optional', async () => {
    // Off by default, and off explicitly; with and without the recipient key secret.
    expect(await startError(await base())).toBeUndefined();
    expect(
      await startError({
        ...(await base()),
        mountIdentityRoutes: false,
        identityTokenHmacSecret: HMAC_SECRET,
      }),
    ).toBeUndefined();
  }, 60_000);
});

/**
 * Task 6.1 of openspec/changes/archive/2026-11-16-044-password-reset-and-account-recovery, scenario "Off by
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

/**
 * Task 8.3 of openspec/changes/archive/2026-11-16-044-password-reset-and-account-recovery, scenario "Off by
 * default" for the confirm route (spec requirement "The reset routes are public, API-only and
 * behind the mount switch"), now covering both reset routes.
 *
 * - GIVEN `MOUNT_IDENTITY_ROUTES` is unset
 * - WHEN either reset route is called, with or without authentication
 * - THEN it answers exactly as an unknown `/v1` path does
 *
 * The control is a request against an app with the switch on, which reaches the route (the
 * uniform `404 CATALOG_NOT_FOUND` of an unknown token, which differs from an unknown `/v1` path
 * for an anonymous caller, whose answer is `401 CATALOG_CONTEXT_REQUIRED`).
 *
 * Production symbols expected: `POST /v1/auth/password-reset/confirm` registered in the
 * `mountIdentityRoutes` block of `createApp`.
 */
describe('the password reset routes are unreachable until mounted (044 task 8.3)', () => {
  const REQUEST_PATH = '/v1/auth/password-reset/request';
  const CONFIRM_PATH = '/v1/auth/password-reset/confirm';
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
      name: 'Reset Confirm Gate Admin',
      email: `reset-confirm-gate-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Reset Confirm Gate Org ${suffix}`,
      organizationSlug: `reset-confirm-gate-${suffix}`,
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
      payload: JSON.stringify({
        id: 'AAAAAAAAAAAAAAAAAAAAAA',
        token: 'A'.repeat(43),
        newPassword: 'Another-Perfectly-Fine-Passphrase-77!',
      }),
    });
    let body: unknown;
    try {
      body = response.json();
    } catch {
      body = response.body;
    }
    return { status: response.statusCode, body };
  }

  it('Off by default: unauthenticated, the confirm route answers as an unknown /v1 path does (401 CATALOG_CONTEXT_REQUIRED)', async () => {
    const unknown = await post(off, `/v1/unknown-${randomUUID().slice(0, 8)}`, 'anonymous');
    expect(unknown.status).toBe(401);
    expect(unknown.body).toMatchObject({ code: 'CATALOG_CONTEXT_REQUIRED' });

    const answer = await post(off, CONFIRM_PATH, 'anonymous');

    expect(answer).toEqual(unknown);
  });

  it('Off by default: authenticated, the confirm route answers as an unknown /v1 path does (the router 404)', async () => {
    const unknown = await post(off, `/v1/unknown-${randomUUID().slice(0, 8)}`, 'authenticated');
    expect(unknown.status).toBe(404);

    const answer = await post(off, CONFIRM_PATH, 'authenticated');

    expect(answer).toEqual(unknown);
  });

  it('Off by default: the Fastify route table has neither reset route while off and has both while on', async () => {
    expect(off.app.hasRoute({ method: 'POST', url: REQUEST_PATH })).toBe(false);
    expect(off.app.hasRoute({ method: 'POST', url: CONFIRM_PATH })).toBe(false);
    expect(on.app.hasRoute({ method: 'POST', url: REQUEST_PATH })).toBe(true);
    expect(on.app.hasRoute({ method: 'POST', url: CONFIRM_PATH })).toBe(true);

    // The control: with the switch on, the same anonymous request reaches the route.
    const answer = await post(on, CONFIRM_PATH, 'anonymous');
    expect(answer.status).toBe(404);
    expect(answer.body).toMatchObject({ code: 'CATALOG_NOT_FOUND' });
  });
});

/**
 * 044 task 10.5 (design D10: "behind the mount switch"): `POST /v1/users/{user}/mfa/reset` is
 * absent with the switch off (it answers as an unknown `/v1` path does, for both callers) and
 * matched by the router with the switch on. The control is that, with the switch on, the same
 * request is not the unknown-path answer.
 */
describe('the admin MFA reset route is unreachable until mounted (044 task 10.5)', () => {
  const RESET_PATH = '/v1/users/{user}/mfa/reset';
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
    off = await createApp(base);
    on = await createApp({
      ...base,
      ...{
        mountIdentityRoutes: true,
        identityTokenHmacSecret: HMAC_SECRET,
        // 044 N4: the switch needs the email path to start.
        email: testEmailOptions(),
      },
    });
    const suffix = randomUUID();
    const tenant = await bootstrapTestTenant(off.auth, {
      pool: testAppPool(),
      name: 'Mount Gate Reset Admin',
      email: `mount-gate-reset-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Mount Gate Reset Org ${suffix}`,
      organizationSlug: `mount-gate-reset-${suffix}`,
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

  async function post(app: App, url: string, authenticated: boolean): Promise<Answer> {
    const response = await app.app.inject({
      method: 'POST',
      url,
      headers: {
        origin: ORIGIN,
        'x-forwarded-for': randomIp(),
        ...(authenticated ? { cookie } : {}),
        ...csrfHeaders('POST'),
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ reason: 'device_replaced' }),
    });
    let body: unknown;
    try {
      body = response.json();
    } catch {
      body = response.body;
    }
    return { status: response.statusCode, body };
  }

  const resetUrl = (): string => concrete(RESET_PATH);

  it('`POST /v1/users/{user}/mfa/reset` is absent with the switch off: unauthenticated, as an unknown path', async () => {
    const unknown = await post(off, `/v1/unknown-${randomUUID().slice(0, 8)}`, false);
    expect(unknown.status).toBe(401);
    expect(unknown.body).toMatchObject({ code: 'CATALOG_CONTEXT_REQUIRED' });
    expect(await post(off, resetUrl(), false)).toEqual(unknown);
  }, 60_000);

  it('`POST /v1/users/{user}/mfa/reset` is absent with the switch off: authenticated, the router 404', async () => {
    const unknown = await post(off, `/v1/unknown-${randomUUID().slice(0, 8)}`, true);
    expect(unknown.status).toBe(404);
    expect(await post(off, resetUrl(), true)).toEqual(unknown);
  }, 60_000);

  it('`POST /v1/users/{user}/mfa/reset` is present with the switch on: not the unknown-path answer', async () => {
    const open = await post(on, resetUrl(), true);
    expect(open.body).not.toMatchObject({ code: 'NOT_FOUND' });
  }, 60_000);
});

/**
 * Task 8.3 of openspec/changes/archive/2026-11-18-045-org-deletion-and-data-retention (spec requirement "Org
 * deletion is requested through one confirmed, step-up gated route"; design D6; `043`'s task
 * 14.3 mount switch; Resolved decision Q166).
 *
 * Task 8.3 Verify (verbatim): "`mount-gate.int.test.ts` (extended) covers "The route does not
 * exist until mounted" for `DELETE /v1/organization`, and fails when the procedure is
 * registered outside the switch (a scratch registration)."
 *
 * Scenario "The route does not exist until mounted" (verbatim from the spec):
 * - GIVEN the mount switch is off, which is the default
 * - WHEN the route is called with and without authentication
 * - THEN each answers exactly as an unknown `/v1` path does
 *
 * ## Harness
 *
 * Three apps over the real pools, Cerbos and Better Auth: `off` (the switch not passed at all,
 * so the default), `on` (the switch on, with `testEmailOptions()` because `createApp` refuses
 * to mount the routes without the email path since `044`), the control that proves the same
 * request reaches the procedure, and `scratch`, the switch off as well, whose `configureApp`
 * seam registers the real `identity.organization.delete` procedure on `DELETE
 * /v1/organization` outside the switch (a scratch registration, like the scratch routes of
 * `route-auth-allowlist.int.test.ts`). The gate's checks are the functions `expectUnknownAnswer`
 * and `expectNoFastifyRoute`: the scenario cases run them against `off`, and the scratch case
 * shows that the same checks fail against `scratch`.
 *
 * Q166: task 5.1 already moved this file's pins (fifteen procedures, sixteen routes, and the
 * `DELETE /v1/organization` entry of the list) when it registered the procedure; this block
 * adds the scenario on top.
 *
 * ## Production symbols expected
 *
 * None new: `identity.organization.delete` (`createIdentityRouter`, task 5.1) and
 * `CreateAppOptions.mountIdentityRoutes` and `configureApp` (`043` tasks 14.3, 14.3b).
 */
describe('DELETE /v1/organization does not exist until mounted (045 task 8.3)', () => {
  const ORG_PATH = '/v1/organization';
  const ORG_ROUTE: Route = { method: 'DELETE', path: ORG_PATH };
  type Caller = 'anonymous' | 'authenticated';
  let off: App;
  let on: App;
  let scratch: App;
  let routes: readonly Route[];
  let operationId: unknown;
  let cookie: string;

  /** The real procedure, from the router built with inert stand-ins (never called here). */
  function orgDeletionProcedure() {
    return createIdentityRouter({
      auth: {} as AuthInstance,
      authz: {} as CerbosClient,
      authRepository: {} as AuthRepository,
      withUserLock: () => Promise.reject(new Error('scratch registration: inert')),
    }).identity.organization.delete;
  }

  /** The scratch registration: the procedure on its own route, outside the switch. */
  function registerOutsideTheSwitch(instance: FastifyInstance): void {
    const handler = new OpenAPIHandler({
      identity: { organization: { delete: orgDeletionProcedure() } },
    });
    instance.delete(ORG_PATH, async (request, reply) => {
      const result = await handler.handle(request, reply, { context: {} });
      if (!result.matched) {
        return reply.status(500).send({ code: 'SCRATCH_NOT_MATCHED' });
      }
      return undefined;
    });
  }

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
    on = await createApp({
      ...base,
      mountIdentityRoutes: true,
      identityTokenHmacSecret: HMAC_SECRET,
      // 044 N4: the switch needs the email path to start.
      email: testEmailOptions(),
    });
    // The switch is off here too: only the scratch registration reaches the procedure.
    scratch = await createApp({ ...base, configureApp: registerOutsideTheSwitch });

    routes = await sixteenRoutes();
    const document = (await generateIdentityOpenApiDocument()) as {
      paths: Record<string, Record<string, { operationId?: unknown } | undefined> | undefined>;
    };
    operationId = document.paths[ORG_PATH]?.['delete']?.operationId;

    const suffix = randomUUID();
    const tenant = await bootstrapTestTenant(off.auth, {
      pool: testAppPool(),
      name: 'Org Deletion Gate Admin',
      email: `org-deletion-gate-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Org Deletion Gate Org ${suffix}`,
      organizationSlug: `org-deletion-gate-${suffix}`,
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
    await scratch.close();
  }, 60_000);

  /** A `DELETE` with no body and no confirmation, so no call can ever request a deletion. */
  async function call(app: App, url: string, caller: Caller): Promise<Answer> {
    const response = await app.app.inject({
      method: 'DELETE',
      url,
      headers: {
        origin: ORIGIN,
        'x-forwarded-for': randomIp(),
        ...(caller === 'authenticated' ? { cookie } : {}),
        ...csrfHeaders('DELETE'),
      },
    });
    let body: unknown;
    try {
      body = response.json();
    } catch {
      body = response.body;
    }
    return { status: response.statusCode, body };
  }

  const unknownPath = (): string => `/v1/unknown-${randomUUID().slice(0, 8)}`;

  /** The gate's check: the route answers exactly as an unknown `/v1` path, same method and caller. */
  async function expectUnknownAnswer(app: App, caller: Caller): Promise<void> {
    const unknown = await call(app, unknownPath(), caller);
    const answer = await call(app, ORG_PATH, caller);
    expect(answer, `${caller}: DELETE ${ORG_PATH}`).toEqual(unknown);
  }

  /** The gate's check on the Fastify route table: no route of its own outside the switch. */
  function expectNoFastifyRoute(app: App): void {
    expect(app.app.hasRoute({ method: 'DELETE', url: ORG_PATH }), `route table: ${ORG_PATH}`).toBe(
      false,
    );
  }

  it('the route table and the procedure list the gate enumerates include DELETE /v1/organization', () => {
    expect(routes, 'the route table of the gate').toContainEqual(ORG_ROUTE);
    expect(
      routes.filter((route) => route.path !== ACCEPT_PATH),
      'the procedure list of the gate',
    ).toContainEqual(ORG_ROUTE);
    expect(operationId, 'the procedure behind the route').toBe('identity.organization.delete');
  });

  it('The route does not exist until mounted: unauthenticated, it answers as an unknown /v1 path does (401 CATALOG_CONTEXT_REQUIRED)', async () => {
    const unknown = await call(off, unknownPath(), 'anonymous');
    expect(unknown.status, 'the baseline of an unknown path').toBe(401);
    expect(unknown.body).toMatchObject({ code: 'CATALOG_CONTEXT_REQUIRED' });

    await expectUnknownAnswer(off, 'anonymous');
  }, 60_000);

  it('The route does not exist until mounted: authenticated, it answers as an unknown /v1 path does (the router 404)', async () => {
    const unknown = await call(off, unknownPath(), 'authenticated');
    expect(unknown.status, 'the baseline of an unknown path').toBe(404);
    expect(unknown.body).toMatchObject({ code: 'NOT_FOUND' });

    await expectUnknownAnswer(off, 'authenticated');
  }, 60_000);

  it('The route does not exist until mounted: the Fastify route table has no DELETE /v1/organization with the switch off', () => {
    expectNoFastifyRoute(off);
  });

  it('the control: with the switch on, the same authenticated request reaches the procedure', async () => {
    const unknown = await call(on, unknownPath(), 'authenticated');
    const open = await call(on, ORG_PATH, 'authenticated');

    expect(open).not.toEqual(unknown);
    expect(open.body).not.toMatchObject({ code: 'NOT_FOUND' });
  }, 60_000);

  it('the gate fails when the procedure is registered outside the switch (a scratch registration)', async () => {
    // The scratch app really serves the procedure with the switch off.
    const served = await call(scratch, ORG_PATH, 'authenticated');
    expect(served.body).not.toMatchObject({ code: 'NOT_FOUND' });

    // The very checks the scenario cases run against `off` fail against it.
    await expect(expectUnknownAnswer(scratch, 'authenticated')).rejects.toMatchObject({
      name: 'AssertionError',
    });
    expect(() => {
      expectNoFastifyRoute(scratch);
    }).toThrow(/route table/);
  }, 60_000);
});
