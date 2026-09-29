/**
 * Integration test for task 11.3 (design D13 "HTTP error-status parity";
 * `specs/catalog-core/spec.md` delta, "HTTP error status matches the declared
 * code").
 *
 * Task 11.3: "An `OpenAPIHandler`-level `clientInterceptors` entry converting
 * a thrown `CatalogError` into a real `ORPCError` carrying its `status`/
 * `code`/`data`. Verify: `http-errors.int.test.ts` covers 'HTTP error status
 * matches the declared code' for every `CATALOG_*` and `AUTH_*` code in the
 * design's mapping table."
 *
 * Scenario: "WHEN a catalog operation fails with `CATALOG_NOT_FOUND` and is
 * called over HTTP / THEN the HTTP response status is 404 and the body's
 * `code` is `CATALOG_NOT_FOUND`".
 *
 * The mapping table (spec Conventions + design D11, mirrored by
 * `CATALOG_ERROR_HTTP_STATUS` in `@tayzu/catalog`):
 *
 * | code                          | status |
 * |-------------------------------|--------|
 * | CATALOG_CONTEXT_REQUIRED      | 401    |
 * | CATALOG_VALIDATION_FAILED     | 400    |
 * | CATALOG_NOT_FOUND             | 404    |
 * | CATALOG_ALREADY_EXISTS        | 409    |
 * | CATALOG_VERSION_CONFLICT      | 409    |
 * | CATALOG_REFERENCE_VIOLATION   | 422    |
 * | CATALOG_SCHEMA_INCOMPATIBLE   | 409    |
 * | CATALOG_RESERVED_IDENTIFIER   | 403    |
 * | CATALOG_LIMIT_EXCEEDED        | 422    |
 * | AUTH_FORBIDDEN                | 403    |
 * | AUTH_STEP_UP_REQUIRED         | 403    |
 * | AUTH_INVALID_CREDENTIALS      | 401    |
 * | AUTH_RATE_LIMITED             | 429    |
 *
 * ## How each code is reached
 *
 * Every code that a real `/v1` operation can raise today is triggered over
 * real HTTP through `createApp` (session cookie, Cerbos, Postgres). Three
 * `AUTH_*` codes have no `/v1` route yet (`AUTH_STEP_UP_REQUIRED`: step-up is
 * not wired into the app; `AUTH_INVALID_CREDENTIALS`: `POST /v1/auth/token`
 * is not mounted; `AUTH_RATE_LIMITED`: 11.8/11.13). They are covered through
 * the exported interceptor itself, mounted on a scratch oRPC router whose
 * procedures throw the real error classes: the mapping is what task 11.3
 * builds, not those routes.
 *
 * ## Production symbols expected
 *
 * - `./error-mapping.js` (new, `apps/api/src`):
 *   - `toOrpcError(error: unknown): ORPCError<string, unknown>`: maps a
 *     thrown value with a table `code` to a real `ORPCError` carrying the
 *     table `status`, the `code`, its message, and (for a `CatalogError`)
 *     `data: { issues, details }`. Anything else becomes
 *     `ORPCError('INTERNAL', { status: 500, message: 'An internal error
 *     occurred' })`, reading nothing off the thrown value.
 *   - `errorMappingInterceptor`: the `clientInterceptors` entry
 *     (`async ({ next }) => { try { return await next(); } catch (e) { throw
 *     toOrpcError(e); } }`), registered by `createApp` on its
 *     `OpenAPIHandler`.
 * - `createApp` sends `resolveContext`'s early failure through `toOrpcError`
 *   too (same body shape and status as any other mapped error).
 *
 * ## Why this fails right now
 *
 * Without the interceptor, a thrown `CatalogError` reaches oRPC unmapped, so
 * the response is a generic 500 (`code: INTERNAL_SERVER_ERROR`), not 404 /
 * `CATALOG_NOT_FOUND`: an assertion failure over HTTP. The scratch-router
 * tests fail on the missing `./error-mapping.js` module (the module under
 * test).
 */
import { randomInt, randomUUID } from 'node:crypto';

import { os } from '@orpc/server';
import { OpenAPIHandler } from '@orpc/openapi/fastify';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bootstrapTestTenant,
  createAdminUser,
  type BootstrappedTenant,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { AuthInvalidCredentialsError, AuthStepUpError } from '../../../packages/auth/src/errors.js';
import { AuthorizationError } from '../../../packages/catalog/src/domain/errors.js';
import { errorMappingInterceptor, toOrpcError } from './error-mapping.js';
import { csrfHeaders } from './__fixtures__/csrf.js';
import { freshMfaSessionCookie } from './__fixtures__/fresh-mfa.js';
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

async function provisionTenant(app: App): Promise<BootstrappedTenant> {
  const suffix = randomUUID();
  return bootstrapTestTenant(app.auth, {
    name: 'HTTP Errors User',
    email: `errors-${suffix}@example.test`,
    password: TEST_PASSWORD,
    organizationName: `Errors Org ${suffix}`,
    organizationSlug: `errors-org-${suffix}`,
    ip: randomIp(),
  });
}

async function signInOverHttp(app: App, email: string): Promise<string> {
  const response = await app.app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': randomIp(),
      origin: ALLOWED_ORIGIN,
    },
    payload: JSON.stringify({ email, password: TEST_PASSWORD }),
  });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers['set-cookie'];
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie === undefined ? [] : [setCookie];
  return cookies.map((raw) => raw.split(';')[0]).join('; ');
}

interface ErrorBody {
  readonly code: string;
  readonly status: number;
  readonly message?: string;
  readonly data?: unknown;
}

function expectMapped(response: LightMyRequestResponse, status: number, code: string): void {
  expect(response.statusCode).toBe(status);
  const body = response.json<ErrorBody>();
  expect(body.code).toBe(code);
  expect(body.status).toBe(status);
}

const emptySchema = { properties: {}, required: [] };

describe('apps/api HTTP error status (task 11.3)', () => {
  let app: App;
  let cookie: string;

  function send(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) {
    return app.app.inject({
      method,
      url,
      headers: {
        cookie,
        origin: ALLOWED_ORIGIN,
        ...csrfHeaders(method),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  }

  async function createBlueprint(identifier: string, extra: Record<string, unknown> = {}) {
    const response = await send('POST', '/v1/blueprints', {
      identifier,
      title: { en: identifier },
      schema: emptySchema,
      ...extra,
    });
    expect(response.statusCode).toBe(200);
  }

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

  // Each test gets its own tenant, so blueprints never collide.
  async function freshTenant(): Promise<void> {
    const tenant = await provisionTenant(app);
    cookie = await signInOverHttp(app, tenant.email);
  }

  // High-risk routes (blueprints.update/delete, entities.delete) need a fresh MFA verification.
  async function freshTenantWithFreshMfa(): Promise<void> {
    const tenant = await provisionTenant(app);
    cookie = await freshMfaSessionCookie(app, {
      email: tenant.email,
      password: TEST_PASSWORD,
      enrollmentCookie: tenant.cookie,
    });
  }

  describe('HTTP error status matches the declared code', () => {
    it('CATALOG_NOT_FOUND -> 404 (the spec scenario)', async () => {
      await freshTenant();
      await createBlueprint('service');
      const response = await send('GET', '/v1/blueprints/service/entities/does-not-exist');
      expectMapped(response, 404, 'CATALOG_NOT_FOUND');
    }, 60_000);

    it('CATALOG_CONTEXT_REQUIRED -> 401 (no credential)', async () => {
      const response = await app.app.inject({
        method: 'GET',
        url: '/v1/blueprints',
        headers: { origin: ALLOWED_ORIGIN },
      });
      expectMapped(response, 401, 'CATALOG_CONTEXT_REQUIRED');
    }, 60_000);

    it('CATALOG_CONTEXT_REQUIRED early failure goes through the same mapping', async () => {
      const bogus = await app.app.inject({
        method: 'GET',
        url: '/v1/blueprints',
        headers: { cookie: 'better-auth.session_token=not-a-real-session', origin: ALLOWED_ORIGIN },
      });
      const none = await app.app.inject({
        method: 'GET',
        url: '/v1/blueprints',
        headers: { origin: ALLOWED_ORIGIN },
      });
      // The mapped body is the ORPCError JSON shape, identical for both causes.
      expectMapped(bogus, 401, 'CATALOG_CONTEXT_REQUIRED');
      expect(bogus.json<ErrorBody>()).toEqual(none.json<ErrorBody>());
      expect(bogus.json<{ defined: boolean }>().defined).toBe(false);
      expect(bogus.headers['content-type']).toMatch(/application\/json/);
    }, 60_000);

    it('CATALOG_VALIDATION_FAILED -> 400', async () => {
      await freshTenant();
      const response = await send('POST', '/v1/blueprints', {
        identifier: '1bad',
        title: { en: 'Bad' },
        schema: emptySchema,
      });
      expectMapped(response, 400, 'CATALOG_VALIDATION_FAILED');
    }, 60_000);

    it('CATALOG_ALREADY_EXISTS -> 409', async () => {
      await freshTenant();
      await createBlueprint('service');
      const response = await send('POST', '/v1/blueprints', {
        identifier: 'service',
        title: { en: 'service' },
        schema: emptySchema,
      });
      expectMapped(response, 409, 'CATALOG_ALREADY_EXISTS');
    }, 60_000);

    it('CATALOG_VERSION_CONFLICT -> 409', async () => {
      await freshTenantWithFreshMfa();
      await createBlueprint('service');
      const response = await send('PUT', '/v1/blueprints/service', {
        title: { en: 'service' },
        schema: emptySchema,
        expectedVersion: 99,
      });
      expectMapped(response, 409, 'CATALOG_VERSION_CONFLICT');
    }, 60_000);

    it('CATALOG_SCHEMA_INCOMPATIBLE -> 409', async () => {
      await freshTenantWithFreshMfa();
      const schema = {
        properties: { language: { type: 'string', title: { en: 'Language' } } },
        required: [],
      };
      await createBlueprint('service', { schema });
      const created = await send('POST', '/v1/blueprints/service/entities', {
        identifier: 'e1',
        title: 'E1',
        spec: { properties: { language: 'go' } },
      });
      expect(created.statusCode).toBe(200);
      const response = await send('PUT', '/v1/blueprints/service', {
        title: { en: 'service' },
        schema: emptySchema,
        expectedVersion: 1,
      });
      expectMapped(response, 409, 'CATALOG_SCHEMA_INCOMPATIBLE');
    }, 60_000);

    it('CATALOG_REFERENCE_VIOLATION -> 422', async () => {
      await freshTenant();
      const response = await send('POST', '/v1/blueprints', {
        identifier: 'orphan',
        title: { en: 'Orphan' },
        schema: emptySchema,
        relations: { owner: { title: { en: 'Owner' }, target: 'nonexistent' } },
      });
      expectMapped(response, 422, 'CATALOG_REFERENCE_VIOLATION');
    }, 60_000);

    it('CATALOG_RESERVED_IDENTIFIER -> 403', async () => {
      await freshTenant();
      const response = await send('POST', '/v1/blueprints', {
        identifier: '_workflow',
        title: { en: 'Workflow' },
        schema: emptySchema,
      });
      expectMapped(response, 403, 'CATALOG_RESERVED_IDENTIFIER');
    }, 60_000);

    it('CATALOG_LIMIT_EXCEEDED -> 422', async () => {
      await freshTenant();
      // 201 properties: over `CatalogLimits.blueprint.maxProperties` (200), checked before validation.
      const properties: Record<string, unknown> = {};
      for (let i = 0; i < 201; i += 1) {
        properties[`p${String(i)}`] = { type: 'string', title: { en: `P${String(i)}` } };
      }
      const response = await send('POST', '/v1/blueprints', {
        identifier: 'wide',
        title: { en: 'Wide' },
        schema: { properties, required: [] },
      });
      expectMapped(response, 422, 'CATALOG_LIMIT_EXCEEDED');
    }, 60_000);

    it('AUTH_FORBIDDEN -> 403 (a member cannot create a blueprint)', async () => {
      const tenant = await provisionTenant(app);
      const email = `member-${randomUUID()}@example.test`;
      const member = await createAdminUser(app.auth, {
        name: 'HTTP Errors Member',
        email,
        password: TEST_PASSWORD,
      });
      await (
        app.auth.api as {
          addMember(args: {
            body: { userId: string; organizationId: string; role: string };
          }): Promise<unknown>;
        }
      ).addMember({
        body: { userId: member.userId, organizationId: tenant.organizationId, role: 'member' },
      });
      cookie = await signInOverHttp(app, email);

      const response = await send('POST', '/v1/blueprints', {
        identifier: 'service',
        title: { en: 'service' },
        schema: emptySchema,
      });
      expectMapped(response, 403, 'AUTH_FORBIDDEN');
    }, 60_000);

    it('a CatalogError body carries its issues/details as data', async () => {
      await freshTenant();
      const response = await send('POST', '/v1/blueprints', {
        identifier: '1bad',
        title: { en: 'Bad' },
        schema: emptySchema,
      });
      const body = response.json<ErrorBody & { data: { issues?: unknown[] } }>();
      expect(Array.isArray(body.data.issues)).toBe(true);
    }, 60_000);
  });

  describe('AUTH_* codes without a /v1 route yet, through the interceptor itself', () => {
    class RateLimitedError extends Error {
      readonly code = 'AUTH_RATE_LIMITED';
      constructor() {
        super('Too many attempts. Try again later.');
      }
    }

    let scratch: FastifyInstance;

    beforeAll(async () => {
      const thrower = (make: () => Error) =>
        os.handler(() => {
          throw make();
        });
      const router = {
        stepUp: thrower(() => new AuthStepUpError()).route({
          method: 'GET',
          path: '/scratch/step-up',
        }),
        invalidCredentials: thrower(() => new AuthInvalidCredentialsError()).route({
          method: 'GET',
          path: '/scratch/invalid-credentials',
        }),
        rateLimited: thrower(() => new RateLimitedError()).route({
          method: 'GET',
          path: '/scratch/rate-limited',
        }),
        forbidden: thrower(() => new AuthorizationError()).route({
          method: 'GET',
          path: '/scratch/forbidden',
        }),
        internal: thrower(
          () => new Error('SELECT * FROM secret WHERE tenant = acme-corp password=hunter2'),
        ).route({ method: 'GET', path: '/scratch/internal' }),
      };
      const handler = new OpenAPIHandler(router, { clientInterceptors: [errorMappingInterceptor] });
      scratch = Fastify();
      scratch.addContentTypeParser('*', (_request, _payload, done) => {
        done(null, undefined);
      });
      scratch.all('/scratch/*', async (request, reply) => {
        await handler.handle(request, reply, { context: {} });
      });
      await scratch.ready();
    });

    afterAll(async () => {
      await scratch.close();
    });

    it('AUTH_STEP_UP_REQUIRED -> 403', async () => {
      const response = await scratch.inject({ method: 'GET', url: '/scratch/step-up' });
      expectMapped(response, 403, 'AUTH_STEP_UP_REQUIRED');
    });

    it('AUTH_INVALID_CREDENTIALS -> 401', async () => {
      const response = await scratch.inject({
        method: 'GET',
        url: '/scratch/invalid-credentials',
      });
      expectMapped(response, 401, 'AUTH_INVALID_CREDENTIALS');
    });

    it('AUTH_RATE_LIMITED -> 429', async () => {
      const response = await scratch.inject({ method: 'GET', url: '/scratch/rate-limited' });
      expectMapped(response, 429, 'AUTH_RATE_LIMITED');
    });

    it('AUTH_FORBIDDEN -> 403', async () => {
      const response = await scratch.inject({ method: 'GET', url: '/scratch/forbidden' });
      expectMapped(response, 403, 'AUTH_FORBIDDEN');
    });

    it('Internal errors stay sanitized: 500 INTERNAL with no message detail', async () => {
      const response = await scratch.inject({ method: 'GET', url: '/scratch/internal' });
      expectMapped(response, 500, 'INTERNAL');
      expect(response.body).not.toContain('SELECT');
      expect(response.body).not.toContain('acme-corp');
      expect(response.body).not.toContain('hunter2');
    });
  });

  describe('toOrpcError', () => {
    it('maps an unknown thrown value to a sanitized INTERNAL ORPCError', () => {
      const mapped = toOrpcError(new Error('password=hunter2'));
      expect(mapped.code).toBe('INTERNAL');
      expect(mapped.status).toBe(500);
      expect(mapped.message).not.toContain('hunter2');
    });

    it('maps AUTH_STEP_UP_REQUIRED and AUTH_INVALID_CREDENTIALS to their table status', () => {
      expect(toOrpcError(new AuthStepUpError()).status).toBe(403);
      expect(toOrpcError(new AuthInvalidCredentialsError()).status).toBe(401);
    });
  });
});
