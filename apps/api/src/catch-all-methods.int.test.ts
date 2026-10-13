/**
 * Task 14.21 of openspec/changes/043-identity-lifecycle-and-org-admin (Resolved
 * decision Q141; allowlist of task 14.3b).
 *
 * Task 14.21 Verify: "`catch-all-methods.int.test.ts` covers an anonymous and an
 * authenticated `QUERY` on a `/v1` path answering Fastify's 404 without resolving a
 * context, every method that a route of the merged router declares being in the
 * catch-all's list (so a new method cannot be forgotten), and a CORS preflight on a
 * `/v1` path answering as before."
 *
 * ## Harness
 *
 * `createApp` with the identity switch on (so the merged router is complete), over the
 * real pools, Cerbos and Better Auth. The catch-all's method list is read with an
 * `onRoute` hook installed through the `configureApp` seam. The merged router's methods
 * are read from the two committed OpenAPI documents (`openapi/catalog.openapi.json` and
 * `openapi/identity.openapi.json`), which are generated from the routers' `.route`
 * declarations. "Fastify's 404" is Fastify's own not-found body (`statusCode`, `error`,
 * `message`), which differs from the catch-all's oRPC-shaped 404 and from the
 * catch-all's 401 `CATALOG_CONTEXT_REQUIRED`, so it proves no context was resolved.
 *
 * ## Production symbols expected
 *
 * - `app.all('/v1/*', ...)` in `./server.js` becomes a route with the explicit method
 *   list `GET`, `POST`, `PUT`, `PATCH`, `DELETE` (no `QUERY`; `HEAD` is derived by
 *   Fastify from `GET`).
 */
import { randomInt, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bootstrapTestTenant,
  testAppPool,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { enrolledAdminSession } from './__fixtures__/fresh-mfa.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createApp, type App } from './server.js';

const ORIGIN = 'https://app.tayzu.test';
const PASSWORD = 'correct horse battery staple';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface OpenApiDocument {
  readonly paths: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

interface NotFoundBody {
  readonly statusCode?: number;
  readonly error?: string;
  readonly message?: string;
  readonly code?: string;
}

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

function routerMethods(): Set<string> {
  const methods = new Set<string>();
  for (const name of ['catalog', 'identity']) {
    const document = JSON.parse(
      readFileSync(join(ROOT, 'openapi', `${name}.openapi.json`), 'utf8'),
    ) as OpenApiDocument;
    for (const operations of Object.values(document.paths)) {
      for (const method of Object.keys(operations)) {
        methods.add(method.toUpperCase());
      }
    }
  }
  return methods;
}

describe('the /v1/* catch-all accepts only the methods the merged router routes (task 14.21, Q141)', () => {
  const catchAllMethods = new Set<string>();
  let app: App;
  let cookie: string;

  beforeAll(async () => {
    const pools = await harnessPools();
    app = await createApp({
      ...pools,
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ORIGIN],
      mountIdentityRoutes: true,
      ...{
        configureApp: (instance: FastifyInstance): void => {
          instance.addHook('onRoute', (route) => {
            if (route.url !== '/v1/*') {
              return;
            }
            const methods: readonly string[] = Array.isArray(route.method)
              ? route.method
              : [route.method];
            for (const method of methods) {
              catchAllMethods.add(method.toUpperCase());
            }
          });
        },
      },
    });
    const suffix = randomUUID();
    const tenant = await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: 'Catch All User',
      email: `catch-all-${suffix}@example.test`,
      password: PASSWORD,
      organizationName: `Catch All Org ${suffix}`,
      organizationSlug: `catch-all-org-${suffix}`,
      ip: randomIp(),
    });
    ({ cookie } = await enrolledAdminSession(app, tenant, { password: PASSWORD, origin: ORIGIN }));
  }, 60_000);

  afterAll(async () => {
    await app.close();
  }, 60_000);

  function query(headers: Record<string, string>) {
    return app.app.inject({
      // Fastify 5 supports QUERY; the cast only widens the literal type of the test client.
      method: 'QUERY' as 'GET',
      url: '/v1/blueprints',
      // A bodiless QUERY is rejected by Fastify with 400 FST_ERR_ROUTE_MISSING_CONTENT_TYPE
      // before routing; a JSON body makes the request reach the router.
      headers: {
        origin: ORIGIN,
        'x-forwarded-for': randomIp(),
        'content-type': 'application/json',
        ...headers,
      },
      payload: '{}',
    });
  }

  function expectFastifyNotFound(response: { statusCode: number; json: () => unknown }): void {
    expect(response.statusCode).toBe(404);
    const body = response.json() as NotFoundBody;
    expect(body.statusCode).toBe(404);
    expect(body.error).toBe('Not Found');
    expect(body.message).toMatch(/not found/i);
    // Neither the catch-all's 401 nor its oRPC-shaped 404: no context was resolved.
    expect(body.code).toBeUndefined();
  }

  it('QUERY is not registered on the catch-all', () => {
    expect(catchAllMethods.has('QUERY')).toBe(false);
  });

  it('an anonymous QUERY on a /v1 path answers Fastify 404 without resolving a context', async () => {
    expectFastifyNotFound(await query({}));
  });

  it('an authenticated QUERY on a /v1 path answers Fastify 404 without resolving a context', async () => {
    expectFastifyNotFound(await query({ cookie }));
  });

  it('the catch-all lists exactly GET, POST, PUT, PATCH and DELETE (HEAD is derived from GET)', () => {
    const own = [...catchAllMethods].filter((method) => method !== 'HEAD').sort();
    expect(own).toEqual(['DELETE', 'GET', 'PATCH', 'POST', 'PUT']);
  });

  it('every method that a route of the merged router declares is in the catch-all list', () => {
    const declared = routerMethods();
    expect(declared.size).toBeGreaterThan(0);
    for (const method of declared) {
      expect(catchAllMethods.has(method), `${method} is declared by a route`).toBe(true);
    }
  });

  it('a CORS preflight on a /v1 path answers as before', async () => {
    const response = await app.app.inject({
      method: 'OPTIONS',
      url: '/v1/blueprints',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
        'x-forwarded-for': randomIp(),
      },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(200);
    expect(response.statusCode).toBeLessThan(300);
    expect(response.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(response.headers['access-control-allow-methods']).toBeDefined();
  });
});
