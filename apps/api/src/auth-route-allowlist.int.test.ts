/**
 * Integration test for task 11.9 (design D18, D22, D23;
 * `specs/auth-and-rbac/spec.md`, requirement "Only an allowlisted set of
 * Better Auth routes is reachable over HTTP").
 *
 * Task 11.9: "A Fastify pre-handler allowlist for `/api/auth/*` (design D18):
 * Better Auth's native organization-membership-mutation routes
 * (`inviteMember`, `updateMemberRole`, `removeMember`, organization
 * create/delete) and every `apiKey` plugin management route return `404`;
 * every other allowlisted route (sign-in, sign-out, session read, two-factor
 * enroll/verify, `setActiveOrganization`, email verification) remains
 * reachable."
 *
 * Scenarios (quoted from the spec):
 * - "A native organization-mutation route is not reachable": WHEN a caller
 *   sends a request directly to Better Auth's native `inviteMember`,
 *   `updateMemberRole`, `removeMember`, or organization create/delete route
 *   THEN the response is `404`, identical to a request for a path that does
 *   not exist.
 * - "A native API-key management route is not reachable": WHEN a caller sends
 *   a request directly to a Better Auth `apiKey` plugin route for creating,
 *   listing, or revoking a key THEN the response is `404`.
 *
 * Also asserted (design D22, resolved decision Q16): `/sign-up/email` is NOT
 * allowlisted, so it is a plain `404` too, and any unlisted `/api/auth/*`
 * path is the same `404` as an unknown route.
 *
 * ## Why this fails right now
 *
 * `./server.ts` mounts `/api/auth/*` with no allowlist, so the blocked routes
 * reach Better Auth and answer `401`/`400`/`200`, not `404`. The
 * "reachable" tests are expected to already pass (behaviour preserved).
 *
 * ## Production symbols expected
 *
 * `createApp` (existing) gains the pre-handler; the allowlist itself is the
 * exported const in `packages/auth/src/http/allowed-routes.ts` (design D18),
 * consumed by task 11.10's drift test; this test does not import it, so it
 * asserts behaviour only.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bootstrapTestTenant,
  type BootstrappedTenant,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { startOidcStub, type OidcStub } from '../../../packages/auth/src/__fixtures__/oidc-stub.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createApp, type App } from './server.js';
import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';

const TEST_PASSWORD = 'correct horse battery staple';
const ALLOWED_ORIGIN = 'https://app.tayzu.test';

/** A fresh random IP per request so no rate limiter ever interferes. */
function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

interface Probe {
  readonly statusCode: number;
  readonly contentType: unknown;
  readonly body: string;
}

async function probe(
  app: App,
  method: 'GET' | 'POST',
  url: string,
  cookie?: string,
): Promise<Probe> {
  const response = await app.app.inject({
    method,
    url,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': randomIp(),
      origin: ALLOWED_ORIGIN,
      ...(cookie === undefined ? {} : { cookie }),
    },
    ...(method === 'POST' ? { payload: '{}' } : {}),
  });
  return {
    statusCode: response.statusCode,
    contentType: response.headers['content-type'],
    body: response.body,
  };
}

/** Removes the requested path from a body, so 404 bodies for different paths compare equal. */
function normalize(body: string, url: string): string {
  return body.split(url).join('<path>');
}

const NATIVE_ORGANIZATION_MUTATION_ROUTES = [
  '/api/auth/organization/invite-member',
  '/api/auth/organization/update-member-role',
  '/api/auth/organization/remove-member',
  '/api/auth/organization/create',
  '/api/auth/organization/delete',
] as const;

const NATIVE_API_KEY_ROUTES = [
  '/api/auth/api-key/create',
  '/api/auth/api-key/list',
  '/api/auth/api-key/delete',
] as const;

describe('apps/api /api/auth/* route allowlist (task 11.9)', () => {
  let app: App;
  let tenant: BootstrappedTenant;
  let cookie: string;

  beforeAll(async () => {
    app = await createApp({
      ...(await harnessPools()),
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ALLOWED_ORIGIN],
    });
    const suffix = randomUUID();
    tenant = await bootstrapTestTenant(app.auth, {
      name: 'Allowlist User',
      email: `allowlist-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Allowlist Org ${suffix}`,
      organizationSlug: `allowlist-org-${suffix}`,
      ip: randomIp(),
    });
    const signIn = await app.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': randomIp(),
        origin: ALLOWED_ORIGIN,
      },
      payload: JSON.stringify({ email: tenant.email, password: TEST_PASSWORD }),
    });
    expect(signIn.statusCode).toBe(200);
    const setCookie = signIn.headers['set-cookie'];
    const cookies = Array.isArray(setCookie)
      ? setCookie
      : setCookie === undefined
        ? []
        : [setCookie];
    cookie = cookies.map((raw) => raw.split(';')[0]).join('; ');
  }, 60_000);

  afterAll(async () => {
    await app.close();
  }, 60_000);

  it.each(NATIVE_ORGANIZATION_MUTATION_ROUTES)(
    'A native organization-mutation route is not reachable: %s is a plain 404 identical to an unknown path',
    async (url) => {
      const unknownUrl = '/api/auth/definitely-not-a-route-' + randomUUID();
      // Even a fully signed-in caller gets the same 404: the route is absent, not forbidden.
      for (const credential of [undefined, cookie]) {
        const blocked = await probe(app, 'POST', url, credential);
        const unknown = await probe(app, 'POST', unknownUrl, credential);

        expect(blocked.statusCode).toBe(404);
        expect(blocked.contentType).toEqual(unknown.contentType);
        expect(normalize(blocked.body, url)).toBe(normalize(unknown.body, unknownUrl));
      }
    },
    60_000,
  );

  it.each(NATIVE_API_KEY_ROUTES)(
    'A native API-key management route is not reachable: %s is a plain 404',
    async (url) => {
      for (const credential of [undefined, cookie]) {
        const blocked = await probe(app, 'POST', url, credential);
        expect(blocked.statusCode).toBe(404);
      }
      const listed = await probe(app, 'GET', '/api/auth/api-key/list', cookie);
      expect(listed.statusCode).toBe(404);
    },
    60_000,
  );

  it('GET /api/auth/jwks is reachable and returns public keys only (design D5)', async () => {
    const response = await probe(app, 'GET', '/api/auth/jwks');

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { keys?: Record<string, unknown>[] };
    expect(Array.isArray(body.keys)).toBe(true);
    expect((body.keys ?? []).length).toBeGreaterThan(0);
    // RFC 7517 private-key members must never be published.
    for (const key of body.keys ?? []) {
      for (const member of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k', 'privateKey']) {
        expect(key).not.toHaveProperty(member);
      }
      expect(key).toHaveProperty('kty');
    }
    expect(response.body).not.toMatch(/PRIVATE KEY/i);
  }, 60_000);

  it('Self sign-up is not allowlisted (Q16): /sign-up/email is a plain 404 like any unknown route', async () => {
    const url = '/api/auth/sign-up/email';
    const unknownUrl = '/api/auth/definitely-not-a-route-' + randomUUID();
    const blocked = await probe(app, 'POST', url);
    const unknown = await probe(app, 'POST', unknownUrl);

    expect(blocked.statusCode).toBe(404);
    expect(blocked.contentType).toEqual(unknown.contentType);
    expect(normalize(blocked.body, url)).toBe(normalize(unknown.body, unknownUrl));
  }, 60_000);

  it('An unlisted /api/auth/* path is the same 404 as a path that does not exist at all', async () => {
    const authUnknown = '/api/auth/unlisted-' + randomUUID();
    const elsewhere = '/unknown-' + randomUUID();
    const a = await probe(app, 'GET', authUnknown);
    const b = await probe(app, 'GET', elsewhere);

    expect(a.statusCode).toBe(404);
    expect(b.statusCode).toBe(404);
    expect(normalize(a.body, authUnknown)).toBe(normalize(b.body, elsewhere));
  }, 60_000);

  it.each([
    ['POST', '/api/auth/sign-in/email'],
    ['POST', '/api/auth/sign-out'],
    ['GET', '/api/auth/get-session'],
    ['POST', '/api/auth/two-factor/enable'],
    ['POST', '/api/auth/two-factor/verify-totp'],
    ['POST', '/api/auth/organization/set-active'],
    ['POST', '/api/auth/send-verification-email'],
    ['GET', '/api/auth/verify-email'],
    ['POST', '/api/auth/sign-in/social'],
    ['GET', '/api/auth/list-accounts'],
  ] as const)(
    'Every other allowlisted route remains reachable: %s %s is not a 404',
    async (method, url) => {
      const response = await probe(app, method, url, cookie);
      expect(response.statusCode).not.toBe(404);
    },
    60_000,
  );
});

describe('apps/api /api/auth/* allowlist: Visma Connect routes (task 19.3, design D23)', () => {
  let app: App;
  let stub: OidcStub;
  let cookie: string;

  beforeAll(async () => {
    stub = await startOidcStub();
    app = await createApp({
      ...(await harnessPools()),
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ALLOWED_ORIGIN],
      // Expected new production option (forwarded to createAuth's `sso`).
      sso: {
        discoveryUrl: stub.discoveryUrl,
        clientId: stub.clientId,
        clientSecret: stub.clientSecret,
      },
    });
    const suffix = randomUUID();
    const tenant = await bootstrapTestTenant(app.auth, {
      name: 'Sso Allowlist User',
      email: `sso-allowlist-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Sso Allowlist Org ${suffix}`,
      organizationSlug: `sso-allowlist-org-${suffix}`,
      ip: randomIp(),
    });
    const signIn = await app.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': randomIp(),
        origin: ALLOWED_ORIGIN,
      },
      payload: JSON.stringify({ email: tenant.email, password: TEST_PASSWORD }),
    });
    expect(signIn.statusCode).toBe(200);
    const setCookie = signIn.headers['set-cookie'];
    const cookies = Array.isArray(setCookie)
      ? setCookie
      : setCookie === undefined
        ? []
        : [setCookie];
    cookie = cookies.map((raw) => raw.split(';')[0]).join('; ');
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await stub.close();
  }, 60_000);

  it.each([
    ['POST', '/api/auth/sign-in/social'],
    ['GET', '/api/auth/callback/visma-connect'],
    ['POST', '/api/auth/callback/visma-connect'],
    ['POST', '/api/auth/link-social'],
    ['POST', '/api/auth/unlink-account'],
    ['GET', '/api/auth/list-accounts'],
  ] as const)(
    'The five Visma Connect routes remain reachable: %s %s is not a 404',
    async (method, url) => {
      const response = await probe(app, method, url, cookie);
      expect(response.statusCode).not.toBe(404);
    },
    60_000,
  );

  it('Visma Connect sign-in initiation reaches the local stub, not the real provider', async () => {
    const response = await app.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/social',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': randomIp(),
        origin: ALLOWED_ORIGIN,
      },
      payload: JSON.stringify({ provider: 'visma-connect', callbackURL: '/' }),
    });
    expect(response.statusCode).not.toBe(404);
    expect(response.body).toContain(stub.issuer);
  }, 60_000);

  it('Unlisted siblings of the Visma Connect routes stay a plain 404', async () => {
    const unknownUrl = '/api/auth/definitely-not-a-route-' + randomUUID();
    for (const url of [
      '/api/auth/callback/other-provider',
      '/api/auth/sign-in/oauth2',
      '/api/auth/oauth2/link',
    ]) {
      const blocked = await probe(app, 'POST', url, cookie);
      const unknown = await probe(app, 'POST', unknownUrl, cookie);
      expect(blocked.statusCode).toBe(404);
      expect(normalize(blocked.body, url)).toBe(normalize(unknown.body, unknownUrl));
    }
  }, 60_000);
});
