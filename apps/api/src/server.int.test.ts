/**
 * Integration test for task 11.1 (design D13; `specs/auth-and-rbac/spec.md`,
 * "Session and tenant resolution").
 *
 * Task 11.1: "`apps/api`'s Fastify bootstrap mounts Better Auth's
 * `/api/auth/*` catch-all route and the catalog's `OpenAPIHandler` at
 * `/v1/*`, with `resolveContext` (groups 3, 5) wired as the handler's
 * `context` function. Verify: `server.int.test.ts` covers one full request
 * round trip for a representative procedure, authenticated by a real session
 * cookie."
 *
 * The task cites no new spec scenario of its own; it wires up the ones group
 * 3 already proved against `resolveContext` in isolation, this time over
 * HTTP ("Session cookie resolves a human context": "GIVEN a signed-in user
 * with an active organization / WHEN they call a catalog operation over HTTP
 * / THEN it runs with `actor.type` `user` and `tenantId` equal to their
 * active organization"; "Missing credential is rejected like a missing
 * context": "THEN it fails exactly as `CATALOG_CONTEXT_REQUIRED`").
 *
 * ## Assumed API of `./server.ts` (does not exist yet)
 *
 * ```ts
 * export interface CreateAppOptions {
 *   readonly databaseUrl: string;      // Postgres, from the host's env
 *   readonly authSecret: string;       // Better Auth's secret, from the host's env
 *   readonly cerbosAddress: string;    // e.g. 'localhost:3593', plaintext in tests
 *   readonly allowedOrigins: readonly string[];
 * }
 * export interface App {
 *   readonly app: FastifyInstance;     // never listening; tests use `app.inject`
 *   readonly auth: AuthInstance;       // the same instance mounted at /api/auth/*
 *   close(): Promise<void>;            // closes Fastify and every pool it opened
 * }
 * export function createApp(options: CreateAppOptions): Promise<App>;
 * ```
 *
 * `createApp` reads no environment itself (that is the process entry
 * point's job, root `CLAUDE.md`: configuration comes from explicit options or
 * env read in `apps/api` bootstrap); it must connect the catalog pool as
 * `tayzu_app` (RLS enforced), and wire `createContextResolver` from
 * `@tayzu/auth` as the only source of each request's `CatalogContext`.
 * Requests are driven with `app.inject`, so no port is ever opened.
 *
 * ## Why this fails right now
 *
 * `./server.js` does not exist, so every test fails while the module graph
 * loads with a `Cannot find module './server.js'` error. Every other import
 * (`fastify`, `vitest`, the `@tayzu/auth` admin-user fixture) exists.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bootstrapTestTenant,
  type BootstrappedTenant,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
// The module under test (task 11.1). Does not exist yet.
import { harnessPools } from './__fixtures__/pools.js';
import { createApp, type App } from './server.js';

const TEST_SECRET = 'api-int-test-only-secret-not-used-for-anything-real-0123456789';
const TEST_PASSWORD = 'correct horse battery staple';
const ALLOWED_ORIGIN = 'https://app.tayzu.test';

/** A fresh random IP per request so no rate limiter ever interferes. */
function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

interface Tenant extends BootstrappedTenant {
  readonly password: string;
}

async function provisionTenant(app: App): Promise<Tenant> {
  const suffix = randomUUID();
  const tenant = await bootstrapTestTenant(app.auth, {
    name: 'HTTP Round Trip User',
    email: `http-${suffix}@example.test`,
    password: TEST_PASSWORD,
    organizationName: `HTTP Org ${suffix}`,
    organizationSlug: `http-org-${suffix}`,
    ip: randomIp(),
  });
  return { ...tenant, password: TEST_PASSWORD };
}

/** Signs in through the mounted `/api/auth/*` route and returns a real `cookie` header value. */
async function signInOverHttp(app: App, email: string, password: string): Promise<string> {
  const response = await app.app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': randomIp(),
      origin: ALLOWED_ORIGIN,
    },
    payload: JSON.stringify({ email, password }),
  });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie === undefined ? [] : [setCookie];
  expect(cookies.length).toBeGreaterThan(0);
  return cookies.map((raw) => raw.split(';')[0]).join('; ');
}

interface BlueprintBody {
  readonly identifier: string;
  readonly version: number;
  readonly createdBy: { readonly type: string; readonly id: string };
}

interface ListBody {
  readonly items: readonly BlueprintBody[];
}

describe('apps/api Fastify bootstrap (task 11.1)', () => {
  let app: App;

  beforeAll(async () => {
    app = await createApp({
      ...(await harnessPools()),
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ALLOWED_ORIGIN],
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
  }, 60_000);

  it('Session cookie resolves a human context: a full round trip through /api/auth/* and /v1/*', async () => {
    const tenant = await provisionTenant(app);
    // GIVEN a signed-in user with an active organization, through the real mounted Better Auth route.
    const cookie = await signInOverHttp(app, tenant.email, tenant.password);

    // WHEN they call a catalog operation over HTTP (POST /v1/blueprints).
    const created = await app.app.inject({
      method: 'POST',
      url: '/v1/blueprints',
      headers: { cookie, 'content-type': 'application/json', origin: ALLOWED_ORIGIN },
      payload: JSON.stringify({
        identifier: 'service',
        title: { en: 'Service' },
        schema: { properties: {}, required: [] },
      }),
    });

    // THEN it runs with actor.type `user`, the resolved user id, and their tenant.
    expect(created.statusCode).toBe(200);
    const blueprint = created.json<BlueprintBody>();
    expect(blueprint.identifier).toBe('service');
    expect(blueprint.version).toBe(1);
    expect(blueprint.createdBy).toEqual({ type: 'user', id: tenant.userId });

    // AND it is readable back over HTTP within the same tenant.
    const listed = await app.app.inject({
      method: 'GET',
      url: '/v1/blueprints',
      headers: { cookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<ListBody>().items.map((item) => item.identifier)).toContain('service');
  }, 60_000);

  it("resolves tenantId from the session's active organization: another tenant's user never sees the blueprint", async () => {
    const first = await provisionTenant(app);
    const second = await provisionTenant(app);
    const firstCookie = await signInOverHttp(app, first.email, first.password);
    const secondCookie = await signInOverHttp(app, second.email, second.password);
    const identifier = `isolated-${randomUUID().slice(0, 8)}`;

    const created = await app.app.inject({
      method: 'POST',
      url: '/v1/blueprints',
      headers: { cookie: firstCookie, 'content-type': 'application/json', origin: ALLOWED_ORIGIN },
      payload: JSON.stringify({
        identifier,
        title: { en: 'Isolated' },
        schema: { properties: {}, required: [] },
      }),
    });
    expect(created.statusCode).toBe(200);

    const listed = await app.app.inject({
      method: 'GET',
      url: '/v1/blueprints',
      headers: {
        cookie: secondCookie,
        // Host-supplied context only: a client-supplied tenant hint must be ignored.
        'x-tenant-id': first.organizationId,
      },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<ListBody>().items.map((item) => item.identifier)).not.toContain(identifier);
  }, 60_000);

  it('Missing credential is rejected like a missing context: no cookie and no Authorization header fail as CATALOG_CONTEXT_REQUIRED', async () => {
    const response = await app.app.inject({ method: 'GET', url: '/v1/blueprints' });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ code: string }>().code).toBe('CATALOG_CONTEXT_REQUIRED');
  }, 60_000);
});

describe('createApp with host-injected pools (task 11.1 fix-up, design D6)', () => {
  it('uses the injected pools and leaves them open: the host owns their lifecycle', async () => {
    const pools = await harnessPools();
    const built = await createApp({
      ...pools,
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ALLOWED_ORIGIN],
    });
    // A request that touches the app pool (revocation lookup path) still fails closed as before.
    const response = await built.app.inject({ method: 'GET', url: '/v1/blueprints' });
    expect(response.statusCode).toBe(401);

    await built.close();

    // Closing the app must not end pools it did not build.
    await expect(pools.appPool.query('select 1 as one')).resolves.toBeDefined();
    await expect(pools.authPool.query('select 1 as one')).resolves.toBeDefined();
  }, 60_000);
});
