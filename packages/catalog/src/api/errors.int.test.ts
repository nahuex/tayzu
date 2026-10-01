/**
 * Integration tests for task 9.2 (openspec/changes/archive/2026-09-28-001-catalog-core, design
 * D3, D11; spec "Published API contract").
 *
 * ## Module under test and assumed API
 *
 * `./errors.ts` does not exist yet (red phase). This test assumes the
 * following exported shape, consumed by `./router.ts` (task 9.1) to convert
 * whatever a service operation throws (a `CatalogError`, or -- for the
 * "unexpected database error" scenario -- the raw, unmapped value
 * `../service/pipeline.ts` step 5 rethrows unchanged) into the public,
 * caller-facing error every procedure surfaces:
 *
 * ```ts
 * // ./errors.ts
 * import type { CatalogErrorCode } from '../domain/errors.js';
 *
 * // design D11's error-code -> HTTP table, verbatim.
 * export const CATALOG_ERROR_HTTP_STATUS: Readonly<Record<CatalogErrorCode, number>>;
 *
 * export const INTERNAL_ERROR_CODE: string;    // e.g. 'INTERNAL'
 * export const INTERNAL_ERROR_STATUS: number;  // 500
 * // A fixed, generic string -- never derived from the thrown value in any way
 * // (design D11: "Unknown errors become a generic INTERNAL with no message
 * // detail").
 * export const INTERNAL_ERROR_MESSAGE: string;
 *
 * // `CatalogError` -> `new ORPCError(error.code, { status:
 * // CATALOG_ERROR_HTTP_STATUS[error.code], message: error.message, data: {
 * // issues: error.issues, details: error.details } })`. Anything else (an
 * // `instanceof CatalogError` check that is `false`) -> `new
 * // ORPCError(INTERNAL_ERROR_CODE, { status: INTERNAL_ERROR_STATUS, message:
 * // INTERNAL_ERROR_MESSAGE })`, reading *nothing* off the original value --
 * // not its `.message`, not its `.stack`, not any other own property. The
 * // pipeline (`../service/pipeline.ts`) has already recorded the sanitized
 * // exception on the active span before this function ever runs (design D3
 * // step 5); this function's only job is to keep it off the value the caller
 * // receives.
 * export function toApiError(error: unknown): ORPCError<string, unknown>;
 * ```
 *
 * `./router.ts`'s handlers (task 9.1) are assumed to call `toApiError` on
 * every caught error before rethrowing, so a caller of
 * `createRouterClient(...)` -- exactly as this test does -- receives the
 * `ORPCError` itself (in-process, no HTTP (de)serialization exists yet;
 * design D2), with `.code`, `.status`, `.message` and `.data` readable
 * directly.
 *
 * ## Why this test connects, calls and asserts the way it does
 *
 * Every `CATALOG_*` scenario below reuses a real Postgres-backed router
 * (same pattern as `./router.int.test.ts`) rather than a mock service, so
 * the mapping is proven against the actual error each real operation raises,
 * not against a fabricated stand-in. The "unexpected database error"
 * scenario forces a genuine, unmapped driver failure -- ending the
 * connection pool before the call, so `pg`'s own `Pool.connect()` rejects
 * with a plain `Error` that is not a `CatalogError` -- which is the same
 * "unknown error" class `pipeline.int.test.ts`'s own `'db_error'` dummy-mode
 * test already exercises at the pipeline level (there, with a forced unique
 * violation). This test only proves the *API layer* does not undo that
 * sanitization when it builds the response, and that the span the pipeline
 * already annotated is still there -- it does not re-prove the pipeline's
 * own sanitization logic.
 */
import { ADMIN_PRINCIPAL, authz } from '../service/__fixtures__/authz-test-helpers.js';
import { runMigrations } from '@tayzu/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// Import order is load-bearing: see `./router.int.test.ts`'s identical note (design D1).
import {
  registration,
  type TelemetryTestHarness,
} from '../service/__fixtures__/registered-harness.js';
import {
  connect,
  connectAsOwner,
  databaseUrl,
  endQuietly,
  randomTenantId,
  type TestDb,
} from '../service/__fixtures__/blueprint-test-helpers.js';
import { onlySpan } from '../service/__fixtures__/telemetry-assertions.js';
import type { CatalogContext } from '../domain/context.js';
import type { CatalogErrorCode } from '../domain/errors.js';
import { createBlueprintService, type BlueprintService } from '../service/blueprints.js';
import { createEntityService, type EntityService } from '../service/entities.js';
import { createCatalogRouter } from './router.js';
import { CATALOG_ERROR_HTTP_STATUS, INTERNAL_ERROR_CODE, INTERNAL_ERROR_STATUS } from './errors.js';
import { createRouterClient } from '@orpc/server';

function registeredHarness(): TelemetryTestHarness {
  if ('error' in registration) {
    throw new Error(
      `createTelemetryTestHarness() failed while the test module graph loaded: ${String(registration.error)}`,
      { cause: registration.error },
    );
  }
  return registration.harness;
}

const DEFAULT_ACTOR: CatalogContext['actor'] = { type: 'user', id: 'user-1' };

function ctx(tenantId: string, actor: CatalogContext['actor'] = DEFAULT_ACTOR): CatalogContext {
  return { tenantId, actor, principal: ADMIN_PRINCIPAL };
}

/** The shape every thrown value from a router call is assumed to have (`ORPCError`, design D2/D11). */
interface ApiErrorLike {
  readonly code: string;
  readonly status: number;
  readonly message: string;
  readonly data?: {
    readonly issues?: readonly { path: string; message: string }[];
    readonly details?: Record<string, unknown>;
  };
}

/** Never passes silently on a resolved promise (mirrors `expectCatalogErrorCode`). */
async function expectApiError(promise: Promise<unknown>): Promise<ApiErrorLike> {
  const thrown: unknown = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(thrown, 'expected the call to reject, but it resolved').toBeDefined();
  return thrown as ApiErrorLike;
}

/** design D11's error-code -> HTTP table, hardcoded here so the assertion does not depend on `./errors.js` getting its own table right. */
const EXPECTED_STATUS_BY_CODE: Record<CatalogErrorCode, number> = {
  CATALOG_CONTEXT_REQUIRED: 401,
  CATALOG_RESERVED_IDENTIFIER: 403,
  CATALOG_NOT_FOUND: 404,
  CATALOG_ALREADY_EXISTS: 409,
  CATALOG_VERSION_CONFLICT: 409,
  CATALOG_SCHEMA_INCOMPATIBLE: 409,
  CATALOG_VALIDATION_FAILED: 400,
  CATALOG_REFERENCE_VIOLATION: 422,
  CATALOG_LIMIT_EXCEEDED: 422,
};

describe('catalog API error mapping (design D3, D11; task 9.2)', () => {
  let pool: TestDb['$client'];
  let harness: TelemetryTestHarness;
  let blueprints: BlueprintService;
  let entities: EntityService;
  let client: ReturnType<
    typeof createRouterClient<ReturnType<typeof createCatalogRouter>, Record<string, unknown>>
  >;

  beforeAll(async () => {
    // Migrations need the owner connection: tayzu_app has no DDL privilege
    // (task 6.3, design D6 Q1a). No raw introspection follows in this file,
    // so the owner connection is closed right after migrating.
    const ownerDb = connectAsOwner(databaseUrl());
    await runMigrations(ownerDb.$client);
    await endQuietly(ownerDb.$client);
    // The router under test runs through the real tenant_isolation RLS
    // policy, exactly like production.
    const db = connect(databaseUrl());
    pool = db.$client;
    harness = registeredHarness();
    blueprints = createBlueprintService({ pool, authz });
    entities = createEntityService({ pool, authz });
    const router = createCatalogRouter({ blueprints, entities });
    client = createRouterClient(router, { context: (raw: Record<string, unknown>) => raw });
  }, 60_000);

  afterEach(async () => {
    await harness.reset();
  });

  afterAll(async () => {
    await harness.shutdown();
    await endQuietly(pool);
  }, 60_000);

  it('the design D11 module table matches the spec exactly', () => {
    expect(CATALOG_ERROR_HTTP_STATUS).toEqual(EXPECTED_STATUS_BY_CODE);
  });

  describe('each CATALOG_* code maps to its design D11 HTTP status', () => {
    it('CATALOG_CONTEXT_REQUIRED -> 401', async () => {
      // No `tenantId` at all: an invalid, host-supplied raw context.
      const error = await expectApiError(client.blueprints.list({}, { context: {} }));
      expect(error.code).toBe('CATALOG_CONTEXT_REQUIRED');
      expect(error.status).toBe(401);
      expect(error.status).toBe(EXPECTED_STATUS_BY_CODE.CATALOG_CONTEXT_REQUIRED);
    });

    it('CATALOG_RESERVED_IDENTIFIER -> 403', async () => {
      const tenantId = randomTenantId();
      const error = await expectApiError(
        client.blueprints.create(
          {
            identifier: '_reserved',
            title: { en: 'Reserved' },
            schema: { properties: {}, required: [] },
          },
          { context: ctx(tenantId) },
        ),
      );
      expect(error.code).toBe('CATALOG_RESERVED_IDENTIFIER');
      expect(error.status).toBe(EXPECTED_STATUS_BY_CODE.CATALOG_RESERVED_IDENTIFIER);
    });

    it('CATALOG_NOT_FOUND -> 404', async () => {
      const tenantId = randomTenantId();
      const error = await expectApiError(
        client.blueprints.get({ identifier: 'missing' }, { context: ctx(tenantId) }),
      );
      expect(error.code).toBe('CATALOG_NOT_FOUND');
      expect(error.status).toBe(EXPECTED_STATUS_BY_CODE.CATALOG_NOT_FOUND);
    });

    it('CATALOG_ALREADY_EXISTS -> 409', async () => {
      const tenantId = randomTenantId();
      const input = {
        identifier: 'dup',
        title: { en: 'Dup' },
        schema: { properties: {}, required: [] },
      };
      await client.blueprints.create(input, { context: ctx(tenantId) });
      const error = await expectApiError(
        client.blueprints.create(input, { context: ctx(tenantId) }),
      );
      expect(error.code).toBe('CATALOG_ALREADY_EXISTS');
      expect(error.status).toBe(EXPECTED_STATUS_BY_CODE.CATALOG_ALREADY_EXISTS);
    });

    it('CATALOG_VERSION_CONFLICT -> 409', async () => {
      const tenantId = randomTenantId();
      const input = {
        identifier: 'stale',
        title: { en: 'Stale' },
        schema: { properties: {}, required: [] },
      };
      await client.blueprints.create(input, { context: ctx(tenantId) });
      const error = await expectApiError(
        client.blueprints.update({ ...input, expectedVersion: 999 }, { context: ctx(tenantId) }),
      );
      expect(error.code).toBe('CATALOG_VERSION_CONFLICT');
      expect(error.status).toBe(EXPECTED_STATUS_BY_CODE.CATALOG_VERSION_CONFLICT);
    });

    it('CATALOG_SCHEMA_INCOMPATIBLE -> 409', async () => {
      const tenantId = randomTenantId();
      const input = {
        identifier: 'incompatible',
        title: { en: 'Incompatible' },
        schema: {
          properties: { language: { type: 'string' as const, title: { en: 'Language' } } },
          required: [],
        },
      };
      await client.blueprints.create(input, { context: ctx(tenantId) });
      await client.entities.create(
        {
          blueprint: 'incompatible',
          identifier: 'e1',
          title: 'E1',
          spec: { properties: { language: 'go' } },
        },
        { context: ctx(tenantId) },
      );
      const error = await expectApiError(
        client.blueprints.update(
          { ...input, schema: { properties: {}, required: [] }, expectedVersion: 1 },
          { context: ctx(tenantId) },
        ),
      );
      expect(error.code).toBe('CATALOG_SCHEMA_INCOMPATIBLE');
      expect(error.status).toBe(EXPECTED_STATUS_BY_CODE.CATALOG_SCHEMA_INCOMPATIBLE);
    });

    it('CATALOG_VALIDATION_FAILED -> 400', async () => {
      const tenantId = randomTenantId();
      const error = await expectApiError(
        client.blueprints.create(
          { identifier: '1bad', title: { en: 'Bad' }, schema: { properties: {}, required: [] } },
          { context: ctx(tenantId) },
        ),
      );
      expect(error.code).toBe('CATALOG_VALIDATION_FAILED');
      expect(error.status).toBe(EXPECTED_STATUS_BY_CODE.CATALOG_VALIDATION_FAILED);
    });

    it('CATALOG_REFERENCE_VIOLATION -> 422', async () => {
      const tenantId = randomTenantId();
      const error = await expectApiError(
        client.blueprints.create(
          {
            identifier: 'orphan',
            title: { en: 'Orphan' },
            schema: { properties: {}, required: [] },
            relations: { owner: { title: { en: 'Owner' }, target: 'nonexistent' } },
          },
          { context: ctx(tenantId) },
        ),
      );
      expect(error.code).toBe('CATALOG_REFERENCE_VIOLATION');
      expect(error.status).toBe(EXPECTED_STATUS_BY_CODE.CATALOG_REFERENCE_VIOLATION);
    });

    it('CATALOG_LIMIT_EXCEEDED -> 422', async () => {
      const tenantId = randomTenantId();
      const error = await expectApiError(
        client.blueprints.list({ pageSize: 501 }, { context: ctx(tenantId) }),
      );
      expect(error.code).toBe('CATALOG_LIMIT_EXCEEDED');
      expect(error.status).toBe(EXPECTED_STATUS_BY_CODE.CATALOG_LIMIT_EXCEEDED);
    });
  });

  describe('Internal errors are not leaked (spec "Published API contract")', () => {
    it('a simulated database failure reaches the caller as a generic internal error, with the exception recorded only on the span', async () => {
      const tenantId = randomTenantId();

      // A dedicated pool, ended *before* any query -- a genuine, unmapped
      // driver failure (not a `CatalogError`), independent of the suite's
      // own shared `pool`.
      const brokenDb = connect(databaseUrl());
      const brokenPool = brokenDb.$client;
      await brokenPool.end();

      const brokenBlueprints = createBlueprintService({ pool: brokenPool, authz });
      const brokenEntities = createEntityService({ pool: brokenPool, authz });
      const brokenRouter = createCatalogRouter({
        blueprints: brokenBlueprints,
        entities: brokenEntities,
      });
      const brokenClient = createRouterClient(brokenRouter, {
        context: (raw: Record<string, unknown>) => raw,
      });

      const error = await expectApiError(
        brokenClient.blueprints.list({ pageSize: 10 }, { context: ctx(tenantId) }),
      );

      // The caller sees a generic, fixed error: no SQL text, no stack trace,
      // no fragment of the driver's own message (design D11).
      expect(error.code).toBe(INTERNAL_ERROR_CODE);
      expect(error.status).toBe(INTERNAL_ERROR_STATUS);
      expect(error.status).toBe(500);
      expect(error.message.toLowerCase()).not.toContain('pool');
      expect(error.message).not.toContain('\n');
      expect(error.message).not.toContain('at ');
      expect(error.data).toBeUndefined();

      // The operation's own span still holds the sanitized exception (design
      // D3 step 5, unchanged by the API layer).
      const span = onlySpan(harness.spanExporter, 'catalog.blueprint.list');
      const exceptionEvents = span.events.filter((event) => event.name === 'exception');
      expect(exceptionEvents).toHaveLength(1);
      const exceptionAttributes = exceptionEvents[0]?.attributes ?? {};
      expect(typeof exceptionAttributes['exception.type']).toBe('string');
      expect(typeof exceptionAttributes['exception.stacktrace']).toBe('string');
      expect(String(exceptionAttributes['exception.stacktrace']).toLowerCase()).not.toContain(
        'duplicate key',
      );
    });
  });
});
