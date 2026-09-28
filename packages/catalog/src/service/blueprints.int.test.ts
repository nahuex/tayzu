/**
 * Integration tests for tasks 7.1, 7.2, 7.3 and 7.5
 * (openspec/changes/archive/2026-09-28-001-catalog-core, design D3, D4, D7, D9, D10, D11; spec
 * "Blueprint definition", "Reserved system identifiers", "Relation
 * definitions", "Blueprint read and list", "Blueprint deletion", "Actor
 * attribution and change events", "Timestamps are UTC", "Telemetry
 * contract").
 *
 * ## Module under test and assumed API
 *
 * `./blueprints.ts` does not exist yet (red phase). This test assumes the
 * following exported shape, built out of `defineCatalogOperation` (design
 * D3, `./pipeline.ts`) so every blueprint operation gets context validation,
 * the tenant transaction, error mapping and telemetry the same way as every
 * other catalog operation:
 *
 * ```ts
 * export interface CreateBlueprintInput {
 *   readonly identifier: string;
 *   readonly title: Record<string, string>;                // LocalizedText, raw (domain/localized-text.js)
 *   readonly description?: Record<string, string>;
 *   readonly icon?: string;
 *   readonly schema: { readonly properties?: Record<string, unknown>; readonly required?: readonly string[] };
 *   readonly statusSchema?: { readonly properties?: Record<string, unknown>; readonly required?: readonly string[] };
 *   readonly relations?: Record<string, {
 *     readonly title: Record<string, string>;
 *     readonly target: string;
 *     readonly many?: boolean;      // default false
 *     readonly required?: boolean;  // default false
 *   }>;
 * }
 * export type UpdateBlueprintInput = CreateBlueprintInput & { readonly expectedVersion?: number };
 * export interface GetBlueprintInput { readonly identifier: string }
 * export interface DeleteBlueprintInput { readonly identifier: string }
 * export interface ListBlueprintsInput { readonly pageSize?: number; readonly cursor?: string }
 * export interface ListBlueprintsOutput { readonly items: readonly BlueprintOutput[]; readonly cursor?: string }
 *
 * // = ParsedBlueprintDefinition (domain/blueprint-definition.js) plus the
 * // server-managed fields (spec "Blueprint definition").
 * export interface BlueprintOutput {
 *   readonly identifier: string;
 *   readonly title: LocalizedText;                          // domain/localized-text.js
 *   readonly description?: LocalizedText;
 *   readonly icon?: string;
 *   readonly schema: ParsedPropertySchema;                  // domain/blueprint-definition.js
 *   readonly statusSchema?: ParsedPropertySchema;
 *   readonly relations: Record<string, RelationDefinition>; // domain/relation-definition.js
 *   readonly version: number;
 *   readonly createdAt: string;                             // ISO 8601, "Z" suffix (spec "Timestamps are UTC")
 *   readonly createdBy: CatalogContext['actor'];             // { type, id, onBehalfOf? } -- the context actor, verbatim
 *   readonly updatedAt: string;
 *   readonly updatedBy: CatalogContext['actor'];
 * }
 *
 * export interface CreateBlueprintServiceOptions {
 *   readonly pool: Pool;              // 'pg', the production connection pool -- same as defineCatalogOperation's own option
 *   readonly limits?: CatalogLimits;  // domain/limits.js; defaults to defaultCatalogLimits
 * }
 *
 * export interface BlueprintService {
 *   readonly create: (rawContext: unknown, input: CreateBlueprintInput) => Promise<BlueprintOutput>;
 *   readonly get: (rawContext: unknown, input: GetBlueprintInput) => Promise<BlueprintOutput>;
 *   readonly list: (rawContext: unknown, input: ListBlueprintsInput) => Promise<ListBlueprintsOutput>;
 *   readonly update: (rawContext: unknown, input: UpdateBlueprintInput) => Promise<BlueprintOutput>;
 *   readonly delete: (rawContext: unknown, input: DeleteBlueprintInput) => Promise<void>;
 * }
 *
 * export function createBlueprintService(options: CreateBlueprintServiceOptions): BlueprintService;
 * ```
 *
 * Each of the five functions is `defineCatalogOperation({ name: 'blueprint.<verb>', pool, handler })`
 * (design D3): span `catalog.blueprint.<verb>` with the common attributes
 * (`tayzu.tenant.id`, `tayzu.actor.type`, `tayzu.actor.id`,
 * `tayzu.catalog.operation`) plus `tayzu.catalog.blueprint.identifier`
 * (design.md, Spans table). A successful create/update/delete's handler
 * result carries an `audit` (`./pipeline.js`'s `CatalogMutationAudit`,
 * `resourceKind: 'blueprint'`), which is what makes the pipeline emit
 * `catalog.audit.mutation` and append the change event with a `snapshot` of
 * the resulting (for delete, the last) definition, in the same transaction
 * (design D9, R13; spec "Actor attribution and change events"). Every
 * mutation also increments `tayzu.catalog.blueprint.mutations` (design.md,
 * Metrics table) with `tayzu.tenant.id`, `tayzu.catalog.mutation`
 * (`'created'|'updated'|'deleted'`) and `tayzu.actor.type`.
 *
 * `create` and `update` meta-validate the input with
 * `parseBlueprintDefinition` (domain/blueprint-definition.js), then check
 * every relation's `target` exists in the tenant --
 * `CATALOG_REFERENCE_VIOLATION` when it does not, since
 * `parseBlueprintDefinition` never touches the database (its own doc
 * comment: "Relation target existence is never checked here"). `create`
 * fails with `CATALOG_ALREADY_EXISTS` on `catalog_blueprint_tenant_identifier_uq`.
 *
 * Reserved identifiers (design D3; spec "Reserved system identifiers"): a
 * non-`system` actor writing (`create`/`update`/`delete`) a `_`-prefixed
 * blueprint gets `CATALOG_RESERVED_IDENTIFIER` from `assertReservedAccess`
 * (domain/reserved.js), and the handler emits the WARN log
 * `catalog.security.reserved_identifier_denied` (design.md, Log events
 * table) with `tayzu.tenant.id`, `tayzu.actor.type`, `tayzu.actor.id`,
 * `tayzu.catalog.blueprint.identifier`, before throwing.
 *
 * `list` sorts by `identifier` ascending with keyset pagination (design
 * D10): an opaque cursor, `pageSize` capped at
 * `limits.pagination.maxPageSize` (500, default `defaultCatalogLimits`
 * unless `options.limits` overrides it) -- exceeding it is
 * `CATALOG_LIMIT_EXCEEDED` naming `pagination.maxPageSize` in
 * `error.details.limit` (the same `details.limit` naming convention
 * `domain/blueprint-definition.js` and `domain/relation-values.js` already
 * use) -- and a malformed cursor is `CATALOG_VALIDATION_FAILED`.
 *
 * `delete` fails with `CATALOG_REFERENCE_VIOLATION` when the blueprint has
 * any entity, or when another blueprint's relation targets it (spec
 * "Blueprint deletion"); it never mutates those tables' rows in that case.
 *
 * ## Why this test connects, seeds and asserts the way it does
 *
 * Same raw-`Pool`-against-`DATABASE_URL` connection pattern, and the same
 * `./__fixtures__/registered-harness.js` import-order requirement (design
 * D1: instruments are created once, at import time, so the harness must
 * register before `./blueprints.js` -- which is expected to import
 * `./pipeline.js` and transitively `../telemetry/instruments.js` -- is ever
 * imported), as `pipeline.int.test.ts`. Entities needed to exercise
 * blueprint deletion (task 7.5) are seeded with raw parameterized SQL
 * directly into `catalog_entity`
 * (`./__fixtures__/blueprint-test-helpers.js`'s `seedEntity`), exactly like
 * `persistence/db-isolation.int.test.ts` already does for the same table:
 * entity *operations* (task 8.x) do not exist yet, but the six D4 tables
 * (task 5.1) do.
 */
import { SpanStatusCode } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { runMigrations } from '@tayzu/db';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// Import order is load-bearing: see the module doc comment above.
import { registration, type TelemetryTestHarness } from './__fixtures__/registered-harness.js';
import {
  blueprintRowId,
  connect,
  databaseUrl,
  endQuietly,
  expectCatalogErrorCode,
  randomTenantId,
  seedEntity,
  type TestDb,
} from './__fixtures__/blueprint-test-helpers.js';
import {
  finishedLogRecords,
  onlySpan,
  sumDataPoints,
} from './__fixtures__/telemetry-assertions.js';
import type { CatalogContext } from '../domain/context.js';
import {
  createBlueprintService,
  type BlueprintOutput,
  type BlueprintService,
  type CreateBlueprintInput,
} from './blueprints.js';

/** The harness `./__fixtures__/registered-harness.js` registered while the module graph loaded. */
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
  return { tenantId, actor };
}

/** A minimal, valid blueprint input, with `overrides` shallow-merged on top. */
function blueprintInput(
  identifier: string,
  overrides: Partial<CreateBlueprintInput> = {},
): CreateBlueprintInput {
  return {
    identifier,
    title: { en: identifier },
    schema: { properties: {}, required: [] },
    ...overrides,
  };
}

describe('blueprint operations (service; design D3-D5, D9-D11; tasks 7.1, 7.2, 7.3, 7.5)', () => {
  let db: TestDb;
  let pool: TestDb['$client'];
  let harness: TelemetryTestHarness;
  let service: BlueprintService;

  beforeAll(async () => {
    db = connect(databaseUrl());
    pool = db.$client;
    await runMigrations(pool);
    harness = registeredHarness();
    service = createBlueprintService({ pool });
  }, 60_000);

  afterEach(async () => {
    await harness.reset();
  });

  afterAll(async () => {
    await harness.shutdown();
    await endQuietly(pool);
  }, 60_000);

  describe('blueprints.create (task 7.1)', () => {
    it('Create a blueprint with localized title', async () => {
      const tenantId = randomTenantId();
      const result = await service.create(
        ctx(tenantId),
        blueprintInput('service', {
          title: { en: 'Service', es: 'Servicio' },
          schema: {
            properties: { language: { type: 'string', title: { en: 'Language' } } },
            required: [],
          },
        }),
      );

      expect(result.version).toBe(1);
      expect(result.title).toEqual({ en: 'Service', es: 'Servicio' });
      expect(result.createdBy).toEqual(DEFAULT_ACTOR);
      expect(result.updatedBy).toEqual(DEFAULT_ACTOR);

      // spec "Actor attribution and change events": exactly one change event,
      // in the same transaction, with a snapshot of the resulting definition.
      const events = await db.execute<{
        action: string;
        resource_kind: string;
        snapshot: { identifier?: string };
      }>(
        sql`select action, resource_kind, snapshot from catalog_change_event
            where tenant_id = ${tenantId} and resource_identifier = 'service'`,
      );
      expect(events.rows).toHaveLength(1);
      expect(events.rows[0]?.action).toBe('created');
      expect(events.rows[0]?.resource_kind).toBe('blueprint');
      expect(events.rows[0]?.snapshot.identifier).toBe('service');
    });

    it('Duplicate blueprint identifier', async () => {
      const tenantId = randomTenantId();
      const c = ctx(tenantId);
      await service.create(c, blueprintInput('service'));

      await expectCatalogErrorCode(
        service.create(c, blueprintInput('service')),
        'CATALOG_ALREADY_EXISTS',
      );
    });

    it('Relation to an existing blueprint', async () => {
      const tenantId = randomTenantId();
      const c = ctx(tenantId);
      await service.create(c, blueprintInput('team'));

      const result = await service.create(
        c,
        blueprintInput('service', {
          relations: {
            owner: { title: { en: 'Owner' }, target: 'team', many: false, required: true },
          },
        }),
      );

      expect(result.relations['owner']).toEqual({
        title: { en: 'Owner' },
        target: 'team',
        many: false,
        required: true,
      });
    });

    it('Self relation', async () => {
      const tenantId = randomTenantId();
      const c = ctx(tenantId);

      const result = await service.create(
        c,
        blueprintInput('service', {
          relations: {
            dependsOn: { title: { en: 'Depends on' }, target: 'service', many: true },
          },
        }),
      );

      expect(result.relations['dependsOn']).toEqual({
        title: { en: 'Depends on' },
        target: 'service',
        many: true,
        required: false,
      });
    });

    it('Relation to a missing blueprint', async () => {
      const tenantId = randomTenantId();
      const c = ctx(tenantId);

      await expectCatalogErrorCode(
        service.create(
          c,
          blueprintInput('service', {
            relations: { owner: { title: { en: 'Owner' }, target: 'nonexistent' } },
          }),
        ),
        'CATALOG_REFERENCE_VIOLATION',
      );
    });

    it('Timestamps are returned in UTC', async () => {
      const tenantId = randomTenantId();
      const beforeMillis = Date.now();

      const result = await service.create(ctx(tenantId), blueprintInput('service'));

      const afterMillis = Date.now();
      expect(result.createdAt.endsWith('Z')).toBe(true);
      expect(result.updatedAt.endsWith('Z')).toBe(true);
      const createdAtMillis = Date.parse(result.createdAt);
      expect(createdAtMillis).toBeGreaterThanOrEqual(beforeMillis - 1000);
      expect(createdAtMillis).toBeLessThanOrEqual(afterMillis + 1000);
    });

    it('records the catalog.blueprint.create span and the blueprint.mutations counter', async () => {
      const tenantId = randomTenantId();
      await service.create(ctx(tenantId), blueprintInput('service'));
      await harness.forceFlush();

      const span = onlySpan(harness.spanExporter, 'catalog.blueprint.create');
      expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
      expect(span.instrumentationScope.name).toBe('@tayzu/catalog');
      expect(span.attributes).toMatchObject({
        'tayzu.tenant.id': tenantId,
        'tayzu.actor.type': 'user',
        'tayzu.actor.id': 'user-1',
        'tayzu.catalog.operation': 'blueprint.create',
        'tayzu.catalog.blueprint.identifier': 'service',
      });

      const points = sumDataPoints(harness.metricExporter, 'tayzu.catalog.blueprint.mutations');
      const matching = points.filter((point) => point.attributes['tayzu.tenant.id'] === tenantId);
      expect(matching).toHaveLength(1);
      expect(matching[0]?.value).toBe(1);
      expect(matching[0]?.attributes).toEqual({
        'tayzu.tenant.id': tenantId,
        'tayzu.catalog.mutation': 'created',
        'tayzu.actor.type': 'user',
      });
    });
  });

  describe('reserved identifiers (task 7.2; spec "Reserved system identifiers")', () => {
    it('Tenant cannot create a reserved blueprint (and the WARN log)', async () => {
      const tenantId = randomTenantId();

      await expectCatalogErrorCode(
        service.create(ctx(tenantId, DEFAULT_ACTOR), blueprintInput('_workflow')),
        'CATALOG_RESERVED_IDENTIFIER',
      );

      await harness.forceFlush();
      const logs = finishedLogRecords(
        harness.logExporter,
        'catalog.security.reserved_identifier_denied',
      );
      expect(logs).toHaveLength(1);
      expect(logs[0]?.severityNumber).toBe(SeverityNumber.WARN);
      expect(logs[0]?.attributes).toEqual({
        'tayzu.tenant.id': tenantId,
        'tayzu.actor.type': 'user',
        'tayzu.actor.id': 'user-1',
        'tayzu.catalog.blueprint.identifier': '_workflow',
      });
    });

    it('System actor can create a reserved blueprint', async () => {
      const tenantId = randomTenantId();

      const result = await service.create(
        ctx(tenantId, { type: 'system', id: 'sys' }),
        blueprintInput('_workflow'),
      );

      expect(result.identifier).toBe('_workflow');
    });
  });

  describe('blueprints.get and blueprints.list (task 7.3; design D10)', () => {
    it('List blueprints with pagination', async () => {
      const tenantId = randomTenantId();
      const c = ctx(tenantId);
      await service.create(c, blueprintInput('a'));
      await service.create(c, blueprintInput('b'));
      await service.create(c, blueprintInput('c'));

      const firstPage = await service.list(c, { pageSize: 2 });
      expect(firstPage.items.map((item: BlueprintOutput) => item.identifier)).toEqual(['a', 'b']);
      expect(firstPage.cursor).toBeDefined();

      const secondPage = await service.list(c, { pageSize: 2, cursor: firstPage.cursor });
      expect(secondPage.items.map((item: BlueprintOutput) => item.identifier)).toEqual(['c']);
      expect(secondPage.cursor).toBeUndefined();
    });

    it('fails with CATALOG_VALIDATION_FAILED on a malformed cursor', async () => {
      const tenantId = randomTenantId();

      await expectCatalogErrorCode(
        service.list(ctx(tenantId), { cursor: '%%%not-a-valid-cursor%%%' }),
        'CATALOG_VALIDATION_FAILED',
      );
    });

    it('rejects a page size over the 500 limit with CATALOG_LIMIT_EXCEEDED, naming the limit', async () => {
      const tenantId = randomTenantId();

      const error = await expectCatalogErrorCode(
        service.list(ctx(tenantId), { pageSize: 501 }),
        'CATALOG_LIMIT_EXCEEDED',
      );
      expect(error.details?.['limit']).toBe('pagination.maxPageSize');
    });
  });

  describe('blueprints.delete (task 7.5; spec "Blueprint deletion")', () => {
    it('Blueprint with entities cannot be deleted', async () => {
      const tenantId = randomTenantId();
      const c = ctx(tenantId);
      await service.create(c, blueprintInput('service'));
      const blueprintId = await blueprintRowId(db, tenantId, 'service');
      await seedEntity(db, tenantId, blueprintId, 'payments');

      await expectCatalogErrorCode(
        service.delete(c, { identifier: 'service' }),
        'CATALOG_REFERENCE_VIOLATION',
      );
    });

    it('Relation target blueprint cannot be deleted', async () => {
      const tenantId = randomTenantId();
      const c = ctx(tenantId);
      await service.create(c, blueprintInput('team'));
      await service.create(
        c,
        blueprintInput('service', {
          relations: { owner: { title: { en: 'Owner' }, target: 'team', required: true } },
        }),
      );

      await expectCatalogErrorCode(
        service.delete(c, { identifier: 'team' }),
        'CATALOG_REFERENCE_VIOLATION',
      );
    });

    it('Unused blueprint is deleted', async () => {
      const tenantId = randomTenantId();
      const c = ctx(tenantId);
      await service.create(c, blueprintInput('sandbox'));

      await service.delete(c, { identifier: 'sandbox' });

      await expectCatalogErrorCode(service.get(c, { identifier: 'sandbox' }), 'CATALOG_NOT_FOUND');
    });
  });
});
