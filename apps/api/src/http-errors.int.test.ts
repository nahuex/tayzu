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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Task 27.4: the telemetry harness registers while the module graph loads (design D1), so this
// import stays ahead of every import that loads `@tayzu/auth`.
import { registration, type TelemetryTestHarness } from './__fixtures__/link-telemetry.js';
import {
  bootstrapTestTenant,
  createAdminUser,
  type BootstrappedTenant,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { AuthInvalidCredentialsError, AuthStepUpError } from '../../../packages/auth/src/errors.js';
import { AuthorizationError } from '../../../packages/catalog/src/domain/errors.js';
import { startOidcStub, type OidcStub } from '../../../packages/auth/src/__fixtures__/oidc-stub.js';
import { errorMappingInterceptor, toOrpcError } from './error-mapping.js';
import { csrfHeaders } from './__fixtures__/csrf.js';
import { enrolledAdminSession, freshMfaSessionCookie } from './__fixtures__/fresh-mfa.js';
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
    // Q43: an unenrolled admin/owner is limited to MFA enrollment, so the acting admin is enrolled.
    const tenant = await enrolledAdminSession(app, await provisionTenant(app), {
      password: TEST_PASSWORD,
      origin: ALLOWED_ORIGIN,
    });
    cookie = tenant.cookie;
  }

  // High-risk routes (blueprints.update/delete, entities.delete) need a fresh MFA verification.
  async function freshTenantWithFreshMfa(): Promise<void> {
    const tenant = await provisionTenant(app);
    cookie = await freshMfaSessionCookie(app, {
      email: tenant.email,
      password: TEST_PASSWORD,
      enrollmentCookie: tenant.cookie,
      origin: ALLOWED_ORIGIN,
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

/**
 * Task 26.3 (design Q67, D11): `createApp` sets a Fastify error handler. An
 * error not already mapped answers `500` with `code: INTERNAL` and a fixed
 * message, never the thrown message.
 *
 * Verify: "a database failure on the admin-MFA gate and on the
 * re-authorization callback answering the generic body with no driver text."
 *
 * ## Harness
 *
 * - Admin-MFA gate: a real enrolled org owner (so `resolveContext` passes and
 *   the gate runs) calls `GET /v1/blueprints`. `auth.api.getSession` is spied:
 *   a baseline request counts how many calls one request makes, then the same
 *   request is repeated with the LAST call (the gate's own session read, after
 *   the resolver's) rejecting with a driver-style error.
 * - Re-authorization callback: `createApp` runs with `sso` pointing at the
 *   local OIDC stub and an `authPool` wrapped in a proxy whose `query`
 *   rejects with a driver-style error while a flag is set. The callback's
 *   first statement (consuming the `state` row) is then a database failure.
 *
 * ## Production symbols expected
 *
 * - `createApp` calls `app.setErrorHandler(...)`: any error that reaches
 *   Fastify unmapped answers `500`, body `{ defined: false, code: 'INTERNAL',
 *   status: 500, message: <the fixed message of toOrpcError(unknown)> }`, and
 *   nothing from the thrown error (message, SQL, driver fields) is in it.
 *
 * ## Why this fails right now
 *
 * Without the handler, Fastify's default answers `{ statusCode: 500, error:
 * 'Internal Server Error', message: <thrown message> }`: an assertion failure.
 */
describe('Unmapped errors answer a generic INTERNAL body (task 26.3, design Q67, D11)', () => {
  const DRIVER_TEXT =
    'connection terminated: relation "auth.verification" does not exist (host=db-secret.internal password=hunter2)';
  const FIXED_MESSAGE = toOrpcError(new Error('anything')).message;

  function driverError(): Error {
    return Object.assign(new Error(DRIVER_TEXT), {
      code: '42P01',
      severity: 'ERROR',
      routine: 'parserOpenTable',
    });
  }

  function expectGenericInternal(response: LightMyRequestResponse): void {
    expect(response.statusCode).toBe(500);
    const body = response.json<ErrorBody>();
    expect(body.code).toBe('INTERNAL');
    expect(body.status).toBe(500);
    expect(body.message).toBe(FIXED_MESSAGE);
    expect(body.data).toBeUndefined();
    for (const leaked of [
      'hunter2',
      'db-secret',
      'auth.verification',
      '42P01',
      'parserOpenTable',
    ]) {
      expect(response.body).not.toContain(leaked);
    }
  }

  describe('admin-MFA gate', () => {
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

    it('a database failure on the gate answers the generic INTERNAL body', async () => {
      const tenant = await enrolledAdminSession(app, await provisionTenant(app), {
        password: TEST_PASSWORD,
        origin: ALLOWED_ORIGIN,
      });
      const list = () =>
        app.app.inject({
          method: 'GET',
          url: '/v1/blueprints',
          headers: { cookie: tenant.cookie, origin: ALLOWED_ORIGIN },
        });

      const api = app.auth.api as {
        getSession(args: unknown): Promise<unknown>;
      };
      const original = api.getSession.bind(api);
      const spy = vi.spyOn(api, 'getSession');
      try {
        // Baseline: how many session reads one successful request makes.
        spy.mockImplementation((args) => original(args));
        const baseline = await list();
        expect(baseline.statusCode, 'precondition: the gated request succeeds').toBe(200);
        const callsPerRequest = spy.mock.calls.length;
        expect(callsPerRequest, 'precondition: the gate reads the session').toBeGreaterThan(1);

        // Same request, the last session read (the gate's) fails like a database outage.
        let call = 0;
        spy.mockImplementation((args) => {
          call += 1;
          return call === callsPerRequest ? Promise.reject(driverError()) : original(args);
        });
        const failed = await list();
        expect(call, 'the failing call was reached').toBe(callsPerRequest);
        expectGenericInternal(failed);
      } finally {
        spy.mockRestore();
      }
    }, 60_000);
  });

  describe('re-authorization callback', () => {
    let app: App;
    let stub: OidcStub;
    let failQueries = false;

    beforeAll(async () => {
      const pools = await harnessPools();
      const authPool = new Proxy(pools.authPool, {
        get(target, prop) {
          if (prop === 'query' && failQueries) {
            return () => Promise.reject(driverError());
          }
          const value: unknown = Reflect.get(target, prop, target);
          return typeof value === 'function'
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });
      stub = await startOidcStub();
      app = await createApp({
        appPool: pools.appPool,
        authPool,
        authSecret: TEST_SECRET,
        cerbosAddress: 'localhost:3593',
        allowedOrigins: [ALLOWED_ORIGIN],
        sso: {
          discoveryUrl: stub.discoveryUrl,
          clientId: stub.clientId,
          clientSecret: stub.clientSecret,
        },
      });
    }, 60_000);

    afterAll(async () => {
      failQueries = false;
      await app.close();
      await stub.close();
    }, 60_000);

    it('a database failure on the callback answers the generic INTERNAL body', async () => {
      failQueries = true;
      try {
        const response = await app.app.inject({
          method: 'GET',
          url: '/v1/auth/visma-connect/reauthorize/callback?code=some-code&state=some-state',
          headers: { 'x-forwarded-for': randomIp() },
        });
        expectGenericInternal(response);
      } finally {
        failQueries = false;
      }
    }, 60_000);
  });
});

/**
 * Task 27.4 (design Q76, "Observability contract" -> Log events): an unmapped
 * Better Auth or Fastify error emits one `auth.internal_error` log record
 * (ERROR) with only `error.type` and, when present, `db.response.status_code`
 * (the SQLSTATE). Never the message, stack text or a bind value.
 *
 * Verify: "a database failure emitting one record with no message, stack text
 * or bind value".
 *
 * ## Harness
 *
 * Same driver as the admin-MFA gate test above: a real enrolled owner calls
 * `GET /v1/blueprints`, and the gate's own `auth.api.getSession` read (the last
 * call of the request) rejects with a driver-style error carrying a message, a
 * stack, a bind value (`parameters`, `detail`) and a SQLSTATE.
 *
 * ## Production symbols expected
 *
 * - `createApp`'s Fastify error handler (and the Better Auth error path) emits
 *   the log event `auth.internal_error`, severity ERROR, exactly once per
 *   unmapped error, with attributes `error.type` (a non-empty string) and, only
 *   when the error carries a SQLSTATE, `db.response.status_code`.
 * - Declared in the telemetry contract (`packages/authz/src/telemetry/contract.ts`,
 *   consumed by `otel-smoke-check`): `{ name: 'auth.internal_error', severity:
 *   'ERROR', attributes: ['error.type', 'db.response.status_code'] }`.
 *
 * ## Why this fails right now
 *
 * No `auth.internal_error` record is emitted: an assertion failure on the
 * record count.
 */
describe('Unmapped errors emit a sanitized auth.internal_error (task 27.4, design Q76)', () => {
  const EVENT = 'auth.internal_error';
  const ERROR_TYPE_KEY = 'error.type';
  const SQLSTATE_KEY = 'db.response.status_code';
  const ERROR_SEVERITY_NUMBER = 17;
  const BIND_MARKER = `bind-marker-${randomUUID()}`;
  const STACK_FRAME = 'leakyFrameFunction';
  const MESSAGE_TEXT = 'duplicate key value violates unique constraint';
  const FORBIDDEN: readonly string[] = [
    BIND_MARKER,
    STACK_FRAME,
    MESSAGE_TEXT,
    'db-secret',
    'node_modules',
    '_bt_check_unique',
  ];

  function registeredHarness(): TelemetryTestHarness {
    if ('error' in registration) {
      throw new Error('the telemetry test harness failed to register', {
        cause: registration.error,
      });
    }
    return registration.harness;
  }

  function leakyError(sqlstate: string | undefined): Error {
    const error = new Error(`${MESSAGE_TEXT} (email)=(${BIND_MARKER}) host=db-secret.internal`);
    error.stack = `Error: ${error.message}\n    at ${STACK_FRAME} (/srv/node_modules/pg/lib/client.js:1:1)`;
    return Object.assign(error, {
      parameters: [BIND_MARKER],
      detail: `Key (email)=(${BIND_MARKER}) already exists.`,
      routine: '_bt_check_unique',
      ...(sqlstate === undefined ? {} : { code: sqlstate }),
    });
  }

  let app: App;
  let harness: TelemetryTestHarness;
  let cookie: string;

  beforeAll(async () => {
    harness = registeredHarness();
    app = await createApp({
      ...(await harnessPools()),
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ALLOWED_ORIGIN],
    });
    const tenant = await enrolledAdminSession(app, await provisionTenant(app), {
      password: TEST_PASSWORD,
      origin: ALLOWED_ORIGIN,
    });
    cookie = tenant.cookie;
  }, 60_000);

  afterAll(async () => {
    await app.close();
  }, 60_000);

  function list(): Promise<LightMyRequestResponse> {
    return app.app.inject({
      method: 'GET',
      url: '/v1/blueprints',
      headers: { cookie, origin: ALLOWED_ORIGIN },
    });
  }

  async function records() {
    await harness.forceFlush();
    return harness.logExporter
      .getFinishedLogRecords()
      .filter((record) => record.eventName === EVENT);
  }

  /** Runs one gated request whose gate session read fails with `error`; returns the new records. */
  async function failGateWith(error: Error) {
    const before: number = (await records()).length;
    const api = app.auth.api as { getSession(args: unknown): Promise<unknown> };
    const original = api.getSession.bind(api);
    const spy = vi.spyOn(api, 'getSession');
    try {
      spy.mockImplementation((args) => original(args));
      const baseline = await list();
      expect(baseline.statusCode, 'precondition: the gated request succeeds').toBe(200);
      const callsPerRequest: number = spy.mock.calls.length;
      expect((await records()).length, 'precondition: a successful request emits nothing').toBe(
        before,
      );

      let call = 0;
      spy.mockImplementation((args) => {
        call += 1;
        return call === callsPerRequest ? Promise.reject(error) : original(args);
      });
      const failed = await list();
      expect(failed.statusCode).toBe(500);
    } finally {
      spy.mockRestore();
    }
    return (await records()).slice(before);
  }

  it('a database failure emits exactly one ERROR record with only error.type and the SQLSTATE', async () => {
    const emitted = await failGateWith(leakyError('23505'));
    expect(emitted).toHaveLength(1);
    const record = emitted[0];
    expect(record?.severityNumber).toBe(ERROR_SEVERITY_NUMBER);
    expect(Object.keys(record?.attributes ?? {}).sort()).toEqual([SQLSTATE_KEY, ERROR_TYPE_KEY]);
    const errorType: unknown = record?.attributes[ERROR_TYPE_KEY];
    expect(typeof errorType).toBe('string');
    expect((errorType as string).length).toBeGreaterThan(0);
    expect(record?.attributes[SQLSTATE_KEY]).toBe('23505');
  }, 60_000);

  it('the record carries no message, stack text or bind value anywhere', async () => {
    const emitted = await failGateWith(leakyError('23505'));
    expect(emitted).toHaveLength(1);
    const serialized: string = JSON.stringify({
      body: emitted[0]?.body,
      attributes: emitted[0]?.attributes,
    });
    for (const forbidden of FORBIDDEN) {
      expect(serialized, `the record must not contain "${forbidden}"`).not.toContain(forbidden);
    }
  }, 60_000);

  it('an error without a SQLSTATE emits error.type alone', async () => {
    const emitted = await failGateWith(leakyError(undefined));
    expect(emitted).toHaveLength(1);
    expect(Object.keys(emitted[0]?.attributes ?? {})).toEqual([ERROR_TYPE_KEY]);
    expect(JSON.stringify(emitted[0]?.attributes)).not.toContain(BIND_MARKER);
  }, 60_000);

  it('a mapped client error (401 CATALOG_CONTEXT_REQUIRED) emits no auth.internal_error', async () => {
    const before: number = (await records()).length;
    const response = await app.app.inject({
      method: 'GET',
      url: '/v1/blueprints',
      headers: { origin: ALLOWED_ORIGIN },
    });
    expect(response.statusCode).toBe(401);
    expect((await records()).length).toBe(before);
  }, 60_000);
});
