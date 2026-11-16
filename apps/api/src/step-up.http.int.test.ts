/**
 * Task 14.4 of openspec/changes/archive/2026-10-14-043-identity-lifecycle-and-org-admin (spec
 * requirement "Every high-risk operation requires step-up"; design D10/D15 and
 * Resolved decisions Q43, Q49, Q51).
 *
 * Task 14.4 Verify: "`step-up.http.int.test.ts` covers "A hijacked admin session
 * without a fresh MFA cannot mint power" over the mounted server, a `password`
 * marker satisfying the guard only for a user with no enrolled factor, a session
 * with an `ssoSid` being sent to the Visma Connect re-authorization instead of a
 * local verification, and an admin without an enrolled factor getting
 * `AUTH_STEP_UP_REQUIRED` on any `/v1` call (an invited admin starts blocked until
 * they enrol)."
 *
 * Scenarios (verbatim from the spec):
 * - "A hijacked admin session without a fresh MFA cannot mint power": GIVEN an
 *   admin session without a fresh MFA verification; WHEN it invites an `admin`,
 *   creates a user, creates a service account or creates a credential; THEN each
 *   fails with `AUTH_STEP_UP_REQUIRED` over HTTP and nothing is created.
 * - "The step-up honors the factor and the identity provider": GIVEN a user with
 *   an enrolled second factor holding only a password step-up marker, and a
 *   session that carries an SSO session id; WHEN each calls a high-risk route;
 *   THEN the first fails with `AUTH_STEP_UP_REQUIRED`, and the second is sent to
 *   the identity provider's re-authorization instead of a local verification.
 * - "An admin without an enrolled factor is blocked": GIVEN an admin, invited or
 *   not, who has not enrolled a second factor; WHEN they call any `/v1` route;
 *   THEN it fails with `AUTH_STEP_UP_REQUIRED` until they enrol.
 *
 * ## Harness
 *
 * The production bootstrap (`createAppFromEnv`) with `MOUNT_IDENTITY_ROUTES=true`
 * and the `VISMA_CONNECT_*` variables pointing at the local OIDC stub, over the
 * harness pools (as in `step-up-sso-http.int.test.ts`). Every request is a Fastify
 * injection with a fresh random `x-forwarded-for`. The high-risk routes are read
 * from the committed `openapi/identity.openapi.json` (every operation carrying
 * `x-tayzu-risk: high`), so a new one is covered without editing this file.
 * "A password marker" is written the real way: Better Auth's `POST /verify-password`
 * after the MFA marker of the session is deleted.
 *
 * ## Production symbols expected
 *
 * None new: `MOUNT_IDENTITY_ROUTES` (`./bootstrap.js`, task 14.3) and the step-up
 * interceptor of `./server.js`. The test is expected to fail only on missing
 * behavior, if any.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  bootstrapTestTenant,
  createAdminUser,
  signInAdminUser,
  testAppPool,
  type BootstrappedTenant,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { startOidcStub, type OidcStub } from '../../../packages/auth/src/__fixtures__/oidc-stub.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { csrfHeaders } from './__fixtures__/csrf.js';
import { enrollTotp, sessionTokenOfCookie, signInWithTotp } from './__fixtures__/fresh-mfa.js';
import { harnessPools, type HarnessPools } from './__fixtures__/pools.js';

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
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

interface Route {
  readonly method: Method;
  readonly path: string;
}

interface Answer {
  readonly status: number;
  readonly code: unknown;
  readonly data: unknown;
}

interface AccountApiSurface {
  addMember(args: {
    body: { userId: string; organizationId: string; role: 'member' | 'admin' };
  }): Promise<unknown>;
}

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

/** Every operation of the committed identity document that carries `x-tayzu-risk: high`. */
function highRiskRoutes(): readonly Route[] {
  const document = JSON.parse(
    readFileSync(join(repoRoot, 'openapi', 'identity.openapi.json'), 'utf8'),
  ) as { paths: Record<string, Record<string, Record<string, unknown>>> };
  return Object.entries(document.paths).flatMap(([path, operations]) =>
    Object.entries(operations)
      .filter(([, operation]) => operation['x-tayzu-risk'] === 'high')
      .map(([method]) => ({ method: method.toUpperCase() as Method, path })),
  );
}

/** A concrete URL for a templated path: the `{user}` identifier is an email, the rest ids. */
function concrete(path: string): string {
  return path.replace(/\{([^}]+)\}/g, (_match, name: string) =>
    name === 'user' ? `nobody-${randomUUID().slice(0, 8)}@example.test` : randomUUID(),
  );
}

describe('step-up over HTTP with the switch on (task 14.4, spec "Every high-risk operation requires step-up")', () => {
  let app: App;
  let pools: HarnessPools;
  let stub: OidcStub;
  let account: AccountApiSurface;
  let routes: readonly Route[];

  beforeAll(async () => {
    pools = await harnessPools();
    state.pools.set('app', pools.appPool);
    state.pools.set('auth', pools.authPool);
    stub = await startOidcStub();
    app = await createAppFromEnv({
      DATABASE_URL: 'postgres://tayzu_app:pw@127.0.0.1:1/tayzu?sslmode=verify-full',
      AUTH_DATABASE_URL: 'postgres://tayzu_auth:pw@127.0.0.1:1/tayzu?sslmode=verify-full',
      BETTER_AUTH_SECRET: TEST_SECRET,
      CERBOS_ADDRESS: 'localhost:3593',
      ALLOWED_ORIGINS: ORIGIN,
      MOUNT_IDENTITY_ROUTES: 'true',
      PASSWORD_RESET_LINK_BASE_URL: ORIGIN,
      IDENTITY_TOKEN_HMAC_SECRET: 'wiring-hmac-test-only-secret-0123456789-abcdef',
      VISMA_CONNECT_DISCOVERY_URL: stub.discoveryUrl,
      VISMA_CONNECT_CLIENT_ID: stub.clientId,
      VISMA_CONNECT_CLIENT_SECRET: stub.clientSecret,
    });
    account = app.auth.api as AccountApiSurface;
    routes = highRiskRoutes();
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await stub.close();
    state.pools.clear();
  }, 60_000);

  async function newAdminTenant(): Promise<BootstrappedTenant> {
    return await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: 'Step Up Http Admin',
      email: `step-up-http-${randomUUID()}@example.test`,
      password: TEST_PASSWORD,
      organizationName: 'Step Up Http Org',
      organizationSlug: `step-up-http-${randomUUID()}`,
      ip: randomIp(),
    });
  }

  /** The admin enrolls TOTP and signs in through a TOTP challenge: a session with a fresh MFA marker. */
  async function enrolledAdmin(): Promise<BootstrappedTenant & { totpSecret: string }> {
    const tenant = await newAdminTenant();
    const totpSecret = await enrollTotp(app, {
      password: TEST_PASSWORD,
      enrollmentCookie: tenant.cookie,
    });
    const cookie = await signInWithTotp(app, {
      email: tenant.email,
      password: TEST_PASSWORD,
      secret: totpSecret,
      origin: ORIGIN,
    });
    return { ...tenant, cookie, totpSecret };
  }

  async function dropMarker(cookie: string): Promise<void> {
    await pools.authPool.query('delete from auth.verification where identifier = $1', [
      `step-up-verified:${sessionTokenOfCookie(cookie)}`,
    ]);
  }

  async function markerOf(cookie: string): Promise<string | null> {
    const result = await pools.authPool.query<{ value: string }>(
      'select value from auth.verification where identifier = $1',
      [`step-up-verified:${sessionTokenOfCookie(cookie)}`],
    );
    return result.rows[0]?.value ?? null;
  }

  async function request(
    cookie: string,
    method: Method,
    url: string,
    body?: Record<string, unknown>,
  ): Promise<Answer> {
    const response = await app.app.inject({
      method,
      url,
      headers: {
        cookie,
        origin: ORIGIN,
        'x-forwarded-for': randomIp(),
        ...csrfHeaders(method),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    let parsed: { code?: unknown; data?: unknown } = {};
    try {
      parsed = response.json<{ code?: unknown; data?: unknown }>();
    } catch {
      // A non-JSON body leaves code and data undefined, which fails the assertions.
    }
    return { status: response.statusCode, code: parsed.code, data: parsed.data };
  }

  /** A password re-entry through Better Auth's real route: writes a `password` marker (Q49). */
  async function reenterPassword(cookie: string): Promise<void> {
    const response = await app.app.inject({
      method: 'POST',
      url: '/api/auth/verify-password',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': randomIp(),
        origin: ORIGIN,
        host: 'localhost:3000',
        cookie,
      },
      payload: JSON.stringify({ password: TEST_PASSWORD }),
    });
    expect(response.statusCode, response.body).toBe(200);
  }

  /** A user of `organizationId` with the given organization role and no MFA factor, signed in. */
  async function unenrolledUserOf(
    organizationId: string,
    role: 'member' | 'admin',
  ): Promise<{ cookie: string; email: string }> {
    const created = await createAdminUser(app.auth, {
      name: `Step Up Http ${role}`,
      email: `step-up-http-${role}-${randomUUID()}@example.test`,
      password: TEST_PASSWORD,
    });
    await account.addMember({ body: { userId: created.userId, organizationId, role } });
    const signedIn = await signInAdminUser(app.auth, {
      email: created.email,
      password: TEST_PASSWORD,
      ip: randomIp(),
    });
    return { cookie: signedIn.cookie, email: created.email };
  }

  async function count(sql: string, params: readonly unknown[]): Promise<number> {
    const result = await pools.authPool.query<{ n: string }>(sql, [...params]);
    return Number(result.rows[0]?.n ?? '0');
  }

  async function snapshot(
    tenantId: string,
  ): Promise<{ invitations: number; entities: number; keys: number; members: number }> {
    return {
      invitations: await count(
        'select count(*) as n from auth.invitation where organization_id = $1',
        [tenantId],
      ),
      entities: await count('select count(*) as n from catalog_entity where tenant_id = $1', [
        tenantId,
      ]),
      keys: await count('select count(*) as n from auth.apikey where reference_id = $1', [
        tenantId,
      ]),
      members: await count('select count(*) as n from auth.member where organization_id = $1', [
        tenantId,
      ]),
    };
  }

  it('the committed identity document has high-risk routes to exercise', () => {
    expect(routes.length).toBeGreaterThanOrEqual(10);
  });

  it('A hijacked admin session without a fresh MFA cannot mint power: invite an admin, create a user, a service account and a credential each fail with AUTH_STEP_UP_REQUIRED and nothing is created', async () => {
    // GIVEN an admin session without a fresh MFA verification (enrolled, marker gone).
    const admin = await enrolledAdmin();
    await dropMarker(admin.cookie);
    expect(await markerOf(admin.cookie), 'precondition: no fresh marker').toBeNull();
    const before = await snapshot(admin.organizationId);

    // WHEN it invites an admin, creates a user, creates a service account or a credential...
    const attempts: readonly { name: string; method: Method; url: string; body: object }[] = [
      {
        name: 'invite an admin',
        method: 'POST',
        url: '/v1/users/invitations',
        body: { email: `hijack-invite-${randomUUID()}@example.test`, role: 'admin' },
      },
      {
        name: 'create a user',
        method: 'POST',
        url: '/v1/users',
        body: {
          email: `hijack-user-${randomUUID()}@example.test`,
          name: 'Hijack User',
          role: 'admin',
        },
      },
      {
        name: 'create a service account',
        method: 'POST',
        url: '/v1/service-accounts',
        body: { identifier: `svc-hijack-${randomUUID().slice(0, 8)}` },
      },
      {
        name: 'create a credential',
        method: 'POST',
        url: '/v1/credentials',
        body: { name: 'hijack-key', kind: 'integration' },
      },
    ];
    for (const attempt of attempts) {
      const answer = await request(
        admin.cookie,
        attempt.method,
        attempt.url,
        attempt.body as Record<string, unknown>,
      );
      // THEN each fails with AUTH_STEP_UP_REQUIRED over HTTP...
      expect(answer.status, attempt.name).toBe(403);
      expect(answer.code, attempt.name).toBe('AUTH_STEP_UP_REQUIRED');
    }

    // ...and nothing is created.
    expect(await snapshot(admin.organizationId)).toEqual(before);
  }, 120_000);

  it('A hijacked admin session without a fresh MFA gets AUTH_STEP_UP_REQUIRED on every high-risk route of the document', async () => {
    const admin = await enrolledAdmin();
    await dropMarker(admin.cookie);
    const before = await snapshot(admin.organizationId);

    for (const route of routes) {
      const body = route.method === 'GET' || route.method === 'DELETE' ? undefined : {};
      const answer = await request(admin.cookie, route.method, concrete(route.path), body);
      expect(answer.status, `${route.method} ${route.path}`).toBe(403);
      expect(answer.code, `${route.method} ${route.path}`).toBe('AUTH_STEP_UP_REQUIRED');
    }

    expect(await snapshot(admin.organizationId)).toEqual(before);
  }, 120_000);

  it('The step-up honors the factor: an MFA-enrolled admin holding only a password marker gets AUTH_STEP_UP_REQUIRED', async () => {
    // GIVEN a user with an enrolled second factor holding only a password step-up marker.
    const admin = await enrolledAdmin();
    await dropMarker(admin.cookie);
    await reenterPassword(admin.cookie);
    expect(await markerOf(admin.cookie), 'precondition: a password marker only').toBe('password');
    const before = await snapshot(admin.organizationId);

    // WHEN it calls a high-risk route THEN it fails with AUTH_STEP_UP_REQUIRED.
    const answer = await request(admin.cookie, 'POST', '/v1/users/invitations', {
      email: `password-only-${randomUUID()}@example.test`,
      role: 'member',
    });
    expect(answer.status).toBe(403);
    expect(answer.code).toBe('AUTH_STEP_UP_REQUIRED');
    expect(await snapshot(admin.organizationId)).toEqual(before);
  }, 120_000);

  it('A password marker satisfies the guard for a user with no enrolled factor: AUTH_STEP_UP_REQUIRED before the re-entry, a different answer after it', async () => {
    // A member (no factor) reaches the guard on /v1; the high-risk route is then refused by
    // authorization (AUTH_FORBIDDEN) once the guard is satisfied, which tells the two apart.
    const admin = await newAdminTenant();
    const member = await unenrolledUserOf(admin.organizationId, 'member');
    const invite = (): Promise<Answer> =>
      request(member.cookie, 'POST', '/v1/users/invitations', {
        email: `password-marker-${randomUUID()}@example.test`,
        role: 'member',
      });

    // GIVEN no marker at all: the guard refuses.
    const before = await invite();
    expect(before.status).toBe(403);
    expect(before.code).toBe('AUTH_STEP_UP_REQUIRED');

    // WHEN the user re-enters their password (a `password` marker is written)...
    await reenterPassword(member.cookie);
    expect(await markerOf(member.cookie)).toBe('password');

    // THEN the guard is satisfied: the request goes on to authorization, which refuses a member.
    const after = await invite();
    expect(after.code, 'the step-up guard no longer refuses').not.toBe('AUTH_STEP_UP_REQUIRED');
    expect(after.code).toBe('AUTH_FORBIDDEN');
    expect(after.status).toBe(403);
  }, 120_000);

  it('A session with an ssoSid is sent to the Visma Connect re-authorization instead of a local verification', async () => {
    // GIVEN an enrolled admin whose session carries an SSO session id, with a fresh local MFA marker.
    const admin = await enrolledAdmin();
    await pools.authPool.query('update auth.session set sso_sid = $1 where user_id = $2', [
      `sid-${randomUUID()}`,
      admin.userId,
    ]);
    expect(await markerOf(admin.cookie), 'precondition: a fresh local MFA marker').toBe('mfa');
    const before = await snapshot(admin.organizationId);

    // WHEN it calls a high-risk route.
    const answer = await request(admin.cookie, 'POST', '/v1/users/invitations', {
      email: `sso-sid-${randomUUID()}@example.test`,
      role: 'member',
    });

    // THEN it is refused and sent to the identity provider's re-authorization; the local marker is not consulted.
    expect(answer.status).toBe(403);
    expect(answer.code).toBe('AUTH_STEP_UP_REQUIRED');
    const reauthorizationUrl = (answer.data as { reauthorizationUrl?: unknown } | undefined)
      ?.reauthorizationUrl;
    expect(typeof reauthorizationUrl).toBe('string');
    const url = new URL(reauthorizationUrl as string);
    expect(url.origin, 'the (stub) Visma Connect').toBe(stub.issuer);
    expect(url.searchParams.get('prompt')).toBe('login');
    expect(url.searchParams.get('acr_values')).toBe('urn:idp:vismaconnect:mfa');
    expect(await snapshot(admin.organizationId)).toEqual(before);
  }, 120_000);

  it('An admin without an enrolled factor gets AUTH_STEP_UP_REQUIRED on any /v1 call', async () => {
    // GIVEN an admin who has not enrolled a second factor (the bootstrap admin).
    const admin = await newAdminTenant();

    // WHEN they call any /v1 route (a read, a low-risk write, a high-risk write, an unknown path).
    const calls: readonly { method: Method; url: string; body?: Record<string, unknown> }[] = [
      { method: 'GET', url: '/v1/blueprints' },
      { method: 'GET', url: '/v1/credentials' },
      {
        method: 'POST',
        url: '/v1/users/invitations',
        body: { email: 'x@example.test', role: 'member' },
      },
      { method: 'GET', url: `/v1/unknown-${randomUUID().slice(0, 8)}` },
    ];
    for (const call of calls) {
      const answer = await request(admin.cookie, call.method, call.url, call.body);
      // THEN it fails with AUTH_STEP_UP_REQUIRED.
      expect(answer.status, `${call.method} ${call.url}`).toBe(403);
      expect(answer.code, `${call.method} ${call.url}`).toBe('AUTH_STEP_UP_REQUIRED');
    }
  }, 120_000);

  it('An invited admin starts blocked until they enrol: AUTH_STEP_UP_REQUIRED on /v1 before enrolment, the gate lifted after', async () => {
    const owner = await newAdminTenant();
    const invited = await unenrolledUserOf(owner.organizationId, 'admin');

    const blocked = await request(invited.cookie, 'GET', '/v1/blueprints');
    expect(blocked.status).toBe(403);
    expect(blocked.code).toBe('AUTH_STEP_UP_REQUIRED');

    // They enrol a factor and sign in through the challenge: the gate no longer blocks.
    const secret = await enrollTotp(app, {
      password: TEST_PASSWORD,
      enrollmentCookie: invited.cookie,
    });
    const cookie = await signInWithTotp(app, {
      email: invited.email,
      password: TEST_PASSWORD,
      secret,
      origin: ORIGIN,
    });
    const allowed = await request(cookie, 'GET', '/v1/blueprints');
    expect(allowed.status).toBe(200);
  }, 120_000);
});
