/**
 * Task 14.9 of openspec/changes/043-identity-lifecycle-and-org-admin (Resolved decision Q45:
 * every identity procedure is built with the mandatory authorization wrapper, so the matrix
 * proves the wrapper's outcome for every route over HTTP).
 *
 * Task 14.9 Verify: "`identity-authorization-matrix.http.int.test.ts` runs the matrix over the
 * mounted server and fails when a procedure of the router is missing from it, with the
 * admin-allowed case of `serviceAccounts.create` and `serviceAccounts.delete` asserted by name."
 *
 * ## The matrix
 *
 * For each of the thirteen oRPC routes: the admin (with a fresh step-up) is allowed (2xx); a
 * `member` session gets 403 `AUTH_FORBIDDEN`; a machine `member` token (an integration credential
 * and a service account) gets 403; an unauthenticated call gets 401; and, for a route with a path
 * target, a target of another tenant gets exactly the unknown-target answer (404
 * `CATALOG_NOT_FOUND`, same body).
 *
 * ## Built from the router's own procedure list
 *
 * The routes come from `generateIdentityOpenApiDocument` (it walks `createIdentityRouter`'s
 * procedures, as `mount-gate.int.test.ts` does), keyed by `operationId`. The completeness test
 * fails when a procedure of the router has no entry in `MATRIX`, and when `MATRIX` names a
 * procedure the router no longer has.
 *
 * ## Harness
 *
 * `createApp` with the identity routes mounted over the harness pools (same wiring as
 * `cross-tenant.http.int.test.ts`), driven by Fastify injection with a fresh random
 * `x-forwarded-for` per request. Each route gets fresh tenants, an MFA-enrolled admin each, a
 * member session, and two machine bearer tokens.
 *
 * ## Production symbols expected
 *
 * None new: `createApp` options `mountIdentityRoutes` and `identity` (`./server.js`),
 * `generateIdentityOpenApiDocument` (`./identity-openapi.js`). The behavior already exists; these
 * tests are expected to pass on arrival (a regression guard).
 */
import { randomInt, randomUUID } from 'node:crypto';

import { createRecordingEmailSender } from '@tayzu/auth';
import { createMachineCredential } from '@tayzu/auth/machine-credentials';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bootstrapTestTenant,
  createAdminUser,
  signInAdminUser,
  testAppPool,
  type BootstrappedTenant,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { csrfHeaders } from './__fixtures__/csrf.js';
import { enrolledAdminSession, freshMfaSessionCookie } from './__fixtures__/fresh-mfa.js';
import { harnessPools, type HarnessPools } from './__fixtures__/pools.js';
import { createEmailTenantGate } from './identity/email-tenant-gate.js';
import { createInMemoryEmailCapStore } from './identity/invitation-caps.js';
import { generateIdentityOpenApiDocument } from './identity-openapi.js';
import { createApp, type App } from './server.js';

const ORIGIN = 'https://app.tayzu.test';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

interface AccountApiSurface {
  addMember(args: {
    body: { userId: string; organizationId: string; role: 'member' | 'admin' };
  }): Promise<unknown>;
}

interface Answer {
  readonly status: number;
  readonly body: string;
  readonly code: unknown;
  readonly json: Record<string, unknown>;
}

interface RouteRequest {
  readonly method: Method;
  readonly url: string;
  readonly body?: Record<string, unknown>;
}

/** The credentials a request is sent with: a session cookie, a bearer token, or nothing. */
type Caller =
  | { readonly kind: 'cookie'; readonly cookie: string }
  | { readonly kind: 'bearer'; readonly token: string }
  | { readonly kind: 'anonymous' };

interface Fixtures {
  readonly t1: BootstrappedTenant;
  readonly t2: BootstrappedTenant;
  readonly memberCookie: string;
  readonly integrationToken: string;
  readonly serviceAccountToken: string;
}

interface MatrixEntry {
  /** The admin's own request: valid, and allowed for an admin of `t1`. */
  readonly request: (admin: BootstrappedTenant) => Promise<RouteRequest>;
  /** For a route with a path target: the request aimed at `t2`'s target, and at an unknown one. */
  readonly target?: {
    readonly foreign: (other: BootstrappedTenant) => Promise<RouteRequest>;
    readonly unknown: () => RouteRequest;
  };
}

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

describe('the identity authorization matrix over HTTP (task 14.9)', () => {
  let app: App;
  let pools: HarnessPools;
  let routeIds: readonly string[];

  beforeAll(async () => {
    pools = await harnessPools();
    const sender = createRecordingEmailSender();
    app = await createApp({
      ...pools,
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ORIGIN],
      ...{
        mountIdentityRoutes: true,
        identity: {
          emailGate: createEmailTenantGate({
            disabledTenantIds: [],
            recipientKeySecret: TEST_SECRET,
            capStore: createInMemoryEmailCapStore({
              tenant: { max: 1000, windowSeconds: 3600 },
              recipient: { max: 1000, windowSeconds: 3600 },
            }),
            sender,
          }),
          invitationLinkBaseUrl: ORIGIN,
        },
      },
    });
    const document = (await generateIdentityOpenApiDocument()) as {
      paths: Record<string, Record<string, { operationId?: string }>>;
    };
    routeIds = Object.values(document.paths)
      .flatMap((operations) => Object.values(operations))
      .map((operation) => operation.operationId)
      .filter((id): id is string => typeof id === 'string');
  }, 60_000);

  afterAll(async () => {
    await app.close();
  }, 60_000);

  // ---- Harness ------------------------------------------------------------------------------

  async function freshAdmin(label: string): Promise<BootstrappedTenant> {
    const suffix = randomUUID();
    const tenant = await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: `Matrix Http ${label}`,
      email: `matrix-http-${label}-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Matrix Http ${label} ${suffix}`,
      organizationSlug: `matrix-http-${label}-${suffix}`,
      ip: randomIp(),
    });
    return await enrolledAdminSession(app, tenant, { password: TEST_PASSWORD, origin: ORIGIN });
  }

  async function addMemberTo(
    admin: BootstrappedTenant,
    label: string,
  ): Promise<{ email: string; userId: string }> {
    const created = await createAdminUser(app.auth, {
      name: `Matrix Http ${label}`,
      email: `matrix-http-${label}-${randomUUID()}@example.test`,
      password: TEST_PASSWORD,
    });
    await (app.auth.api as AccountApiSurface).addMember({
      body: { userId: created.userId, organizationId: admin.organizationId, role: 'member' },
    });
    return created;
  }

  async function send(caller: Caller, request: RouteRequest): Promise<Answer> {
    const authHeaders: Record<string, string> =
      caller.kind === 'cookie'
        ? { cookie: caller.cookie, origin: ORIGIN }
        : caller.kind === 'bearer'
          ? { authorization: `Bearer ${caller.token}` }
          : {};
    const response = await app.app.inject({
      method: request.method,
      url: request.url,
      headers: {
        ...authHeaders,
        'x-forwarded-for': randomIp(),
        ...csrfHeaders(request.method),
        ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(request.body === undefined ? {} : { payload: JSON.stringify(request.body) }),
    });
    let json: Record<string, unknown> = {};
    try {
      json = response.json<Record<string, unknown>>();
    } catch {
      // A non-JSON body leaves the object empty.
    }
    return { status: response.statusCode, body: response.body, code: json['code'], json };
  }

  async function adminCall(
    admin: BootstrappedTenant,
    method: Method,
    url: string,
    body?: Record<string, unknown>,
  ): Promise<Answer> {
    const answer = await send(
      { kind: 'cookie', cookie: admin.cookie },
      { method, url, ...(body === undefined ? {} : { body }) },
    );
    expect(answer.status, `${method} ${url}: ${answer.body}`).toBeGreaterThanOrEqual(200);
    expect(answer.status, `${method} ${url}: ${answer.body}`).toBeLessThan(300);
    return answer;
  }

  async function invite(admin: BootstrappedTenant): Promise<string> {
    const answer = await adminCall(admin, 'POST', '/v1/users/invitations', {
      email: `matrix-http-invitee-${randomUUID()}@example.test`,
      role: 'member',
    });
    const id = answer.json['invitationId'];
    if (typeof id !== 'string') throw new Error(`no invitationId in ${answer.body}`);
    return id;
  }

  async function createServiceAccount(
    admin: BootstrappedTenant,
  ): Promise<{ identifier: string; clientId: string; clientSecret: string }> {
    const identifier = `svc-mx-${randomUUID().slice(0, 8)}`;
    const answer = await adminCall(admin, 'POST', '/v1/service-accounts', { identifier });
    const { clientId, clientSecret } = answer.json;
    if (typeof clientId !== 'string' || typeof clientSecret !== 'string') {
      throw new Error(`no service account credential in ${answer.body}`);
    }
    return { identifier, clientId, clientSecret };
  }

  async function createCredentialId(admin: BootstrappedTenant): Promise<string> {
    const answer = await adminCall(admin, 'POST', '/v1/credentials', {
      name: 'Matrix credential',
      kind: 'integration',
    });
    const id = answer.json['id'];
    if (typeof id !== 'string') throw new Error(`no credential id in ${answer.body}`);
    return id;
  }

  async function exchangeToken(clientId: string, clientSecret: string): Promise<string> {
    const response = await app.app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        'x-forwarded-for': randomIp(),
        ...csrfHeaders('POST'),
      },
      payload: JSON.stringify({ clientId, clientSecret }),
    });
    expect(response.statusCode, response.body).toBe(200);
    const token = response.json<{ accessToken?: unknown }>().accessToken;
    if (typeof token !== 'string') throw new Error('no access token');
    return token;
  }

  async function buildFixtures(): Promise<Fixtures> {
    const t1 = await freshAdmin('t1');
    const t2 = await freshAdmin('t2');
    const member = await addMemberTo(t1, 'session-member');
    const signedIn = await signInAdminUser(app.auth, {
      email: member.email,
      password: TEST_PASSWORD,
      ip: randomIp(),
    });
    const integration = await createMachineCredential(app.auth, {
      userId: t1.userId,
      organizationId: t1.organizationId,
      name: 'Matrix integration',
      actorKind: 'integration',
    });
    const serviceAccount = await createServiceAccount(t1);
    return {
      t1,
      t2,
      // The member holds a fresh MFA verification too, so the step-up guard is satisfied and the
      // denial under test is the authorization check itself.
      memberCookie: await freshMfaSessionCookie(app, {
        email: member.email,
        password: TEST_PASSWORD,
        enrollmentCookie: signedIn.cookie,
        origin: ORIGIN,
      }),
      integrationToken: await exchangeToken(integration.id, integration.secret),
      serviceAccountToken: await exchangeToken(
        serviceAccount.clientId,
        serviceAccount.clientSecret,
      ),
    };
  }

  // ---- The matrix: one entry per procedure of the router -------------------------------------

  const MATRIX: Readonly<Record<string, MatrixEntry>> = {
    'identity.users.create': {
      request: () =>
        Promise.resolve({
          method: 'POST',
          url: '/v1/users',
          body: {
            email: `matrix-http-created-${randomUUID()}@example.test`,
            name: 'Matrix Created',
            role: 'member',
          },
        }),
    },
    'identity.users.invite': {
      request: () =>
        Promise.resolve({
          method: 'POST',
          url: '/v1/users/invitations',
          body: { email: `matrix-http-invite-${randomUUID()}@example.test`, role: 'member' },
        }),
    },
    'identity.users.cancelInvitation': {
      request: async (admin) => ({
        method: 'POST',
        url: `/v1/users/invitations/${await invite(admin)}/cancel`,
      }),
      target: {
        foreign: async (other) => ({
          method: 'POST',
          url: `/v1/users/invitations/${await invite(other)}/cancel`,
        }),
        unknown: () => ({ method: 'POST', url: `/v1/users/invitations/${randomUUID()}/cancel` }),
      },
    },
    'identity.users.resendInvitation': {
      request: async (admin) => ({
        method: 'POST',
        url: `/v1/users/invitations/${await invite(admin)}/resend`,
      }),
      target: {
        foreign: async (other) => ({
          method: 'POST',
          url: `/v1/users/invitations/${await invite(other)}/resend`,
        }),
        unknown: () => ({ method: 'POST', url: `/v1/users/invitations/${randomUUID()}/resend` }),
      },
    },
    'identity.users.linkSsoAccount': {
      request: async (admin) => ({
        method: 'POST',
        url: `/v1/users/${(await addMemberTo(admin, 'link')).email}/sso-account`,
        body: { subject: `sub-${randomUUID()}` },
      }),
      target: {
        foreign: async (other) => ({
          method: 'POST',
          url: `/v1/users/${(await addMemberTo(other, 'link')).email}/sso-account`,
          body: { subject: `sub-${randomUUID()}` },
        }),
        unknown: () => ({
          method: 'POST',
          url: `/v1/users/nobody-${randomUUID()}@example.test/sso-account`,
          body: { subject: `sub-${randomUUID()}` },
        }),
      },
    },
    'identity.users.setStatus': {
      request: async (admin) => ({
        method: 'PUT',
        url: `/v1/users/${(await addMemberTo(admin, 'status')).email}/status`,
        body: { status: 'Disabled' },
      }),
      target: {
        foreign: async (other) => ({
          method: 'PUT',
          url: `/v1/users/${(await addMemberTo(other, 'status')).email}/status`,
          body: { status: 'Disabled' },
        }),
        unknown: () => ({
          method: 'PUT',
          url: `/v1/users/nobody-${randomUUID()}@example.test/status`,
          body: { status: 'Disabled' },
        }),
      },
    },
    'identity.users.unlinkSsoAccount': {
      request: async (admin) => ({
        method: 'DELETE',
        url: `/v1/users/${(await addMemberTo(admin, 'unlink')).email}/sso-account`,
      }),
      target: {
        foreign: async (other) => ({
          method: 'DELETE',
          url: `/v1/users/${(await addMemberTo(other, 'unlink')).email}/sso-account`,
        }),
        unknown: () => ({
          method: 'DELETE',
          url: `/v1/users/nobody-${randomUUID()}@example.test/sso-account`,
        }),
      },
    },
    'identity.credentials.create': {
      request: () =>
        Promise.resolve({
          method: 'POST',
          url: '/v1/credentials',
          body: { name: 'Matrix created', kind: 'integration' },
        }),
    },
    'identity.credentials.list': {
      request: () => Promise.resolve({ method: 'GET', url: '/v1/credentials' }),
    },
    'identity.credentials.rotate': {
      request: async (admin) => ({
        method: 'POST',
        url: `/v1/credentials/${await createCredentialId(admin)}/rotate`,
      }),
      target: {
        foreign: async (other) => ({
          method: 'POST',
          url: `/v1/credentials/${await createCredentialId(other)}/rotate`,
        }),
        unknown: () => ({ method: 'POST', url: `/v1/credentials/${randomUUID()}/rotate` }),
      },
    },
    'identity.credentials.revoke': {
      request: async (admin) => ({
        method: 'POST',
        url: `/v1/credentials/${await createCredentialId(admin)}/revoke`,
      }),
      target: {
        foreign: async (other) => ({
          method: 'POST',
          url: `/v1/credentials/${await createCredentialId(other)}/revoke`,
        }),
        unknown: () => ({ method: 'POST', url: `/v1/credentials/${randomUUID()}/revoke` }),
      },
    },
    'identity.serviceAccounts.create': {
      request: () =>
        Promise.resolve({
          method: 'POST',
          url: '/v1/service-accounts',
          body: { identifier: `svc-mx-${randomUUID().slice(0, 8)}` },
        }),
    },
    'identity.serviceAccounts.delete': {
      request: async (admin) => ({
        method: 'DELETE',
        url: `/v1/service-accounts/${(await createServiceAccount(admin)).identifier}`,
      }),
      target: {
        foreign: async (other) => ({
          method: 'DELETE',
          url: `/v1/service-accounts/${(await createServiceAccount(other)).identifier}`,
        }),
        unknown: () => ({
          method: 'DELETE',
          url: `/v1/service-accounts/svc-nobody-${randomUUID().slice(0, 8)}`,
        }),
      },
    },
  };

  // ---- Completeness --------------------------------------------------------------------------

  it('lists the thirteen router procedures, and every one has an entry in the matrix', () => {
    expect(routeIds, 'the router has thirteen procedures').toHaveLength(13);
    const missing = routeIds.filter((id) => !(id in MATRIX));
    expect(missing, 'procedures of the router missing from the matrix').toEqual([]);
    const stale = Object.keys(MATRIX).filter((id) => !routeIds.includes(id));
    expect(stale, 'matrix entries for procedures the router does not have').toEqual([]);
  });

  // ---- The matrix, per route -----------------------------------------------------------------

  describe.each(Object.entries(MATRIX))('%s', (id, entry) => {
    let fixtures: Fixtures;

    beforeAll(async () => {
      fixtures = await buildFixtures();
    }, 180_000);

    it(`${id}: the admin with a fresh step-up is allowed`, async () => {
      const request = await entry.request(fixtures.t1);
      const answer = await send({ kind: 'cookie', cookie: fixtures.t1.cookie }, request);
      expect(answer.status, answer.body).toBeGreaterThanOrEqual(200);
      expect(answer.status, answer.body).toBeLessThan(300);
    }, 120_000);

    it(`${id}: a member session gets AUTH_FORBIDDEN 403`, async () => {
      const request = await entry.request(fixtures.t1);
      const answer = await send({ kind: 'cookie', cookie: fixtures.memberCookie }, request);
      expect(answer.status, answer.body).toBe(403);
      expect(answer.code).toBe('AUTH_FORBIDDEN');
    }, 120_000);

    it(`${id}: a machine member token of an integration credential gets 403`, async () => {
      const request = await entry.request(fixtures.t1);
      const answer = await send({ kind: 'bearer', token: fixtures.integrationToken }, request);
      expect(answer.status, answer.body).toBe(403);
      expect(answer.code).toBe('AUTH_FORBIDDEN');
    }, 120_000);

    it(`${id}: a machine member token of a service account gets 403`, async () => {
      const request = await entry.request(fixtures.t1);
      const answer = await send({ kind: 'bearer', token: fixtures.serviceAccountToken }, request);
      expect(answer.status, answer.body).toBe(403);
      expect(answer.code).toBe('AUTH_FORBIDDEN');
    }, 120_000);

    it(`${id}: an unauthenticated call gets 401`, async () => {
      const request = await entry.request(fixtures.t1);
      const answer = await send({ kind: 'anonymous' }, request);
      expect(answer.status, answer.body).toBe(401);
    }, 120_000);

    if (entry.target !== undefined) {
      const { foreign, unknown } = entry.target;
      it(`${id}: a target of another tenant gets the same 404 as an unknown one`, async () => {
        const asForeign = await send(
          { kind: 'cookie', cookie: fixtures.t1.cookie },
          await foreign(fixtures.t2),
        );
        const asUnknown = await send({ kind: 'cookie', cookie: fixtures.t1.cookie }, unknown());
        expect(asUnknown.status, asUnknown.body).toBe(404);
        expect(asUnknown.code).toBe('CATALOG_NOT_FOUND');
        expect(asForeign.status, asForeign.body).toBe(404);
        expect(asForeign.code).toBe('CATALOG_NOT_FOUND');
        expect(asForeign.body, 'same body as the unknown target').toBe(asUnknown.body);
      }, 120_000);
    }
  });

  // ---- Service-account routes, by name (5.3b2) -----------------------------------------------

  it('serviceAccounts.create and serviceAccounts.delete are allowed for an admin: the first, target-less check does not deny', async () => {
    const admin = await freshAdmin('sa');
    const identifier = `svc-mx-${randomUUID().slice(0, 8)}`;

    const created = await send(
      { kind: 'cookie', cookie: admin.cookie },
      { method: 'POST', url: '/v1/service-accounts', body: { identifier } },
    );
    expect(created.status, created.body).toBeGreaterThanOrEqual(200);
    expect(created.status, created.body).toBeLessThan(300);
    expect(created.code).not.toBe('AUTH_FORBIDDEN');

    const deleted = await send(
      { kind: 'cookie', cookie: admin.cookie },
      { method: 'DELETE', url: `/v1/service-accounts/${identifier}` },
    );
    expect(deleted.status, deleted.body).toBeGreaterThanOrEqual(200);
    expect(deleted.status, deleted.body).toBeLessThan(300);
    expect(deleted.code).not.toBe('AUTH_FORBIDDEN');
  }, 120_000);
});
