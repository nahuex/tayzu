/**
 * Integration tests for task 8.3 (openspec/changes/archive/2026-09-28-001-catalog-core, design
 * D3, D9, D11; spec "Entity create and upsert semantics", "Status is written
 * only through the status operation" (the "Spec changes do not touch status"
 * scenario only), "Actor attribution and change events", "Telemetry
 * contract").
 *
 * ## Module under test and assumed API
 *
 * `./entities.ts` does not exist yet (red phase). This test assumes the
 * following exported shape, mirroring `./blueprints.ts`'s own shape and
 * built out of `defineCatalogOperation` (design D3, `./pipeline.ts`) so every
 * entity operation gets context validation, the tenant transaction, error
 * mapping and telemetry the same way as every other catalog operation:
 *
 * ```ts
 * export interface EntitySpecInput {
 *   readonly properties?: Record<string, unknown>;
 *   readonly relations?: Record<string, unknown>;  // identifier -> string | string[]
 * }
 * export interface CreateEntityInput {
 *   readonly blueprint: string;
 *   readonly identifier: string;
 *   readonly title: string;              // plain string, not localized (spec "Entity shape with spec and status")
 *   readonly icon?: string;
 *   readonly spec?: EntitySpecInput;
 * }
 * export type UpsertEntityMode = 'replace' | 'merge';
 * export type UpsertEntityInput = CreateEntityInput & {
 *   readonly mode: UpsertEntityMode;
 *   readonly expectedVersion?: number;
 * };
 * export type UpsertOutcome = 'created' | 'updated' | 'unchanged';
 * export type UpsertEntityOutput = EntityOutput & { readonly outcome: UpsertOutcome };
 *
 * export interface WriteEntityStatusInput {
 *   readonly blueprint: string;
 *   readonly identifier: string;
 *   readonly properties?: Record<string, unknown>;
 *   readonly relations?: Record<string, unknown>;
 *   readonly observedGeneration: number;
 *   readonly source: string;             // property/relation identifier pattern (spec Conventions)
 * }
 *
 * export interface GetEntityInput { readonly blueprint: string; readonly identifier: string }
 * export interface DeleteEntityInput {
 *   readonly blueprint: string; readonly identifier: string; readonly detachReferences?: boolean;
 * }
 * export interface ListEntitiesInput { readonly blueprint: string; readonly pageSize?: number; readonly cursor?: string }
 * export interface ListEntitiesOutput { readonly items: readonly EntityOutput[]; readonly cursor?: string }
 *
 * export type RelatedDirection = 'forward' | 'backward';
 * export type RelatedScope = 'spec' | 'status';
 * export interface ListRelatedInput {
 *   readonly blueprint: string; readonly identifier: string; readonly direction: RelatedDirection;
 *   readonly scope?: RelatedScope;      // default both (spec "Related entities traversal")
 *   readonly pageSize?: number; readonly cursor?: string;
 * }
 * export interface RelatedEntityItem {
 *   readonly scope: RelatedScope; readonly relation: string; readonly blueprint: string; readonly identifier: string;
 * }
 * export interface ListRelatedOutput { readonly items: readonly RelatedEntityItem[]; readonly cursor?: string }
 *
 * export interface EntityStatusOutput {
 *   readonly properties: Record<string, unknown>;
 *   readonly relations: Record<string, string | string[]>;
 *   readonly observedGeneration: number;
 *   readonly observedAt: string;         // ISO 8601, "Z" suffix
 *   readonly source: string;
 * }
 * export interface EntityOutput {
 *   readonly blueprint: string;
 *   readonly identifier: string;
 *   readonly title: string;
 *   readonly icon?: string;
 *   readonly spec: { readonly properties: Record<string, unknown>; readonly relations: Record<string, string | string[]> };
 *   readonly status: EntityStatusOutput | null;
 *   readonly generation: number;
 *   readonly version: number;
 *   readonly createdAt: string;
 *   readonly createdBy: CatalogContext['actor'];
 *   readonly updatedAt: string;
 *   readonly updatedBy: CatalogContext['actor'];
 * }
 *
 * export interface CreateEntityServiceOptions { readonly pool: Pool; readonly limits?: CatalogLimits }
 * export interface EntityService {
 *   readonly create: (rawContext: unknown, input: CreateEntityInput) => Promise<EntityOutput>;
 *   readonly upsert: (rawContext: unknown, input: UpsertEntityInput) => Promise<UpsertEntityOutput>;
 *   readonly writeStatus: (rawContext: unknown, input: WriteEntityStatusInput) => Promise<EntityOutput>;
 *   readonly get: (rawContext: unknown, input: GetEntityInput) => Promise<EntityOutput>;
 *   readonly list: (rawContext: unknown, input: ListEntitiesInput) => Promise<ListEntitiesOutput>;
 *   readonly delete: (rawContext: unknown, input: DeleteEntityInput) => Promise<void>;
 *   readonly listRelated: (rawContext: unknown, input: ListRelatedInput) => Promise<ListRelatedOutput>;
 * }
 * export function createEntityService(options: CreateEntityServiceOptions): EntityService;
 * ```
 *
 * Each of the seven functions is `defineCatalogOperation({ name: 'entity.<verb>', pool, handler })`
 * (design D3): span `catalog.entity.<verb>` with the common attributes plus
 * `tayzu.catalog.blueprint.identifier` and `tayzu.catalog.entity.identifier`
 * (design.md, Spans table). `create`, `upsert` and `writeStatus` validate
 * `spec.properties`/`status.properties` with a child span
 * `catalog.entity.validate` (`domain/entity-validator.js`'s
 * `compileEntityValidator`, default path `/spec/properties`, or
 * `/status/properties` for `writeStatus`) and validate relation *shape* with
 * `domain/relation-values.js`'s `validateRelationValues` (`/spec/relations`
 * or `/status/relations`). Every relation *value* is then resolved to an
 * existing target entity with a child span `catalog.relations.resolve`
 * (design.md: `tayzu.catalog.relation.target.count` always,
 * `tayzu.catalog.relation.missing.count` only when at least one target is
 * missing): a batched lookup scoped to the context's tenant and the
 * relation's declared target blueprint, so a target that exists but belongs
 * to the wrong blueprint, or to another tenant, is reported exactly like a
 * nonexistent one. Any missing target fails the whole operation with
 * `CATALOG_REFERENCE_VIOLATION`, `issues: [{ path:
 * '/spec/relations/<name>', message }]` and `details: { relation: '<name>',
 * missing: ['<id>', ...] }` (spec "Entity relations and referential
 * integrity": "naming the relation and the missing identifiers") --
 * *before* any row is written, exactly like `blueprints.ts`'s own
 * `resolveRelationTargets`. A successful mutation's handler result carries an
 * `audit` (`resourceKind: 'entity'`), and every mutation increments
 * `tayzu.catalog.entity.mutations` (design.md, Metrics table) with
 * `tayzu.tenant.id`, `tayzu.catalog.blueprint.identifier`,
 * `tayzu.catalog.mutation` (`'created'|'updated'|'status_updated'|'deleted'|
 * 'detached'` -- never `'unchanged'`, which the metric's own attribute enum
 * excludes) and `tayzu.actor.type`.
 *
 * `create` fails with `CATALOG_NOT_FOUND` when `blueprint` does not exist in
 * the tenant (spec "Entity of a missing blueprint"), with
 * `CATALOG_ALREADY_EXISTS` on `catalog_entity_tenant_blueprint_identifier_uq`
 * (a genuine unique violation: there is no read-then-insert race, design D9),
 * and with `CATALOG_RESERVED_IDENTIFIER` (via `domain/reserved.js`'s
 * `assertReservedAccess(blueprint, 'entity_write', ctx.actor)`, plus the WARN
 * log `catalog.security.reserved_identifier_denied`, exactly like
 * `blueprints.ts`'s own `denyIfReserved`) when `blueprint` starts with `_`
 * and the actor is not `system`.
 *
 * As defense in depth (design D9: "23503 on the edge target, blueprint or
 * relation-definition FKs -> CATALOG_REFERENCE_VIOLATION; anything else ->
 * INTERNAL"), the edge insert's error is *also* mapped by constraint name --
 * `catalog_entity_relation_target_fk`, `catalog_entity_blueprint_fk`,
 * `catalog_entity_relation_relation_definition_fk` all map to
 * `CATALOG_REFERENCE_VIOLATION`, anything else propagates unchanged for the
 * pipeline's own generic "unknown error -> INTERNAL" step (design D3 step 5)
 * to handle. Because relation targets are always resolved by query *before*
 * any row is written (the paragraph above), and an entity write holds its
 * blueprint row `FOR SHARE` for the whole transaction (design D7, which
 * blocks a concurrent `blueprints.update` from ever removing the relation
 * definition an in-flight create is using), this defense-in-depth FK path
 * cannot be forced through a legitimate, single-connection call: the
 * "known constraint -> CATALOG_REFERENCE_VIOLATION" case below is exercised
 * through the *observably identical* wrong-blueprint-target scenario the
 * paragraph above describes (a real referential-integrity rejection, whether
 * the underlying enforcement is the resolve query or the FK), and the
 * "unknown constraint -> INTERNAL" case is forced deterministically, with no
 * concurrency, by pre-seeding a colliding `catalog_change_event` row
 * (`./__fixtures__/entity-a-test-helpers.js`'s `seedChangeEventSeqCollision`)
 * so the operation's own (unmapped) change-event insert is what actually
 * fails.
 *
 * `upsert` computes the next spec with `domain/apply-write.js`'s
 * `applyWrite(current, input, mode)`, applies defaults
 * (`domain/entity-validator.js`), and compares canonical JSON
 * (`domain/canonical.js`) of `title`, `icon` and `spec` against the current
 * row to decide `outcome`: `unchanged` writes neither bump `version`/
 * `generation` nor append a change event nor touch `status`, exactly per
 * design D9. `writeStatus` replaces the whole observed snapshot (`status_*`
 * columns and `scope = 'status'` edges only, `spec` untouched), sets
 * `observedAt` to the server's UTC time, and rejects `observedGeneration`
 * greater than the entity's current `generation`, and any non-empty
 * `status.properties` when the blueprint has no `statusSchema`, both with
 * `CATALOG_VALIDATION_FAILED`.
 *
 * `list` sorts by `identifier` ascending with keyset pagination (design
 * D10), exactly like `blueprints.ts`'s own `list`, scoped to one
 * `blueprint` within the tenant.
 *
 * ## Why this test connects, seeds and asserts the way it does
 *
 * Same raw-`Pool`-against-`DATABASE_URL` connection pattern, and the same
 * `./__fixtures__/registered-harness.js` import-order requirement, as
 * `blueprints.int.test.ts` and `pipeline.int.test.ts`. Every blueprint a test
 * needs is created through the real `createBlueprintService` (`./blueprints.js`,
 * tasks 7.1-7.6), never through raw SQL: entities always attach to a real,
 * already-validated blueprint. `./__fixtures__/entity-a-test-helpers.js`
 * adds only what `./__fixtures__/blueprint-test-helpers.js` does not already
 * provide: `ctx`/`DEFAULT_ACTOR`, the `blueprintInput`/`entityInput`
 * builders, and `seedChangeEventSeqCollision` (used once, for the "unknown
 * constraint" case above).
 */
import { runMigrations } from '@tayzu/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// Import order is load-bearing: see the module doc comment above.
import { registration, type TelemetryTestHarness } from './__fixtures__/registered-harness.js';
import {
  connect,
  databaseUrl,
  endQuietly,
  expectCatalogErrorCode,
  randomTenantId,
  selectChangeEvents,
  type TestDb,
} from './__fixtures__/blueprint-test-helpers.js';
import { blueprintInput, ctx, entityInput } from './__fixtures__/entity-a-test-helpers.js';
import { sumDataPoints } from './__fixtures__/telemetry-assertions.js';
import { createBlueprintService, type BlueprintService } from './blueprints.js';
import { createEntityService, type EntityService } from './entities.js';

function registeredHarness(): TelemetryTestHarness {
  if ('error' in registration) {
    throw new Error(
      `createTelemetryTestHarness() failed while the test module graph loaded: ${String(registration.error)}`,
      { cause: registration.error },
    );
  }
  return registration.harness;
}

const SERVICE_BLUEPRINT_WITH_LANGUAGE_AND_TIER = blueprintInput('service', {
  schema: {
    properties: {
      language: { type: 'string', title: { en: 'Language' } },
      tier: { type: 'string', title: { en: 'Tier' } },
    },
    required: [],
  },
});

describe('entities.upsert (service; design D3, D9, D11; task 8.3)', () => {
  let db: TestDb;
  let pool: TestDb['$client'];
  let harness: TelemetryTestHarness;
  let blueprints: BlueprintService;
  let entities: EntityService;

  beforeAll(async () => {
    db = connect(databaseUrl());
    pool = db.$client;
    await runMigrations(pool);
    harness = registeredHarness();
    blueprints = createBlueprintService({ pool });
    entities = createEntityService({ pool });
  }, 60_000);

  afterEach(async () => {
    await harness.reset();
  });

  afterAll(async () => {
    await harness.shutdown();
    await endQuietly(pool);
  }, 60_000);

  it('Upsert creates then replaces', async () => {
    const tenantId = randomTenantId();
    const c = ctx(tenantId);
    await blueprints.create(c, SERVICE_BLUEPRINT_WITH_LANGUAGE_AND_TIER);

    const created = await entities.upsert(
      c,
      entityInput('service', 'payments', { mode: 'replace', spec: { properties: { language: 'go', tier: 'gold' } } }),
    );
    expect(created.outcome).toBe('created');
    expect(created.generation).toBe(1);

    const updated = await entities.upsert(
      c,
      entityInput('service', 'payments', { mode: 'replace', spec: { properties: { language: 'rust' } } }),
    );

    expect(updated.outcome).toBe('updated');
    expect(updated.generation).toBe(2);
    expect(updated.spec.properties).toEqual({ language: 'rust' });
  });

  it('Merge keeps unspecified keys', async () => {
    const tenantId = randomTenantId();
    const c = ctx(tenantId);
    await blueprints.create(c, SERVICE_BLUEPRINT_WITH_LANGUAGE_AND_TIER);
    await entities.upsert(
      c,
      entityInput('service', 'payments', { mode: 'replace', spec: { properties: { language: 'go', tier: 'gold' } } }),
    );

    const result = await entities.upsert(
      c,
      entityInput('service', 'payments', { mode: 'merge', spec: { properties: { tier: 'silver' } } }),
    );

    expect(result.spec.properties).toEqual({ language: 'go', tier: 'silver' });
  });

  it('Merge with null removes a value', async () => {
    const tenantId = randomTenantId();
    const c = ctx(tenantId);
    await blueprints.create(c, SERVICE_BLUEPRINT_WITH_LANGUAGE_AND_TIER);
    await entities.upsert(
      c,
      entityInput('service', 'payments', { mode: 'replace', spec: { properties: { tier: 'gold' } } }),
    );

    const result = await entities.upsert(
      c,
      entityInput('service', 'payments', { mode: 'merge', spec: { properties: { tier: null } } }),
    );

    expect(Object.prototype.hasOwnProperty.call(result.spec.properties, 'tier')).toBe(false);
  });

  it('Idempotent upsert is unchanged: no event, no version bump', async () => {
    const tenantId = randomTenantId();
    const c = ctx(tenantId);
    await blueprints.create(c, SERVICE_BLUEPRINT_WITH_LANGUAGE_AND_TIER);
    await entities.upsert(
      c,
      entityInput('service', 'payments', { mode: 'replace', spec: { properties: { language: 'go' } } }),
    );
    const atVersion2 = await entities.upsert(
      c,
      entityInput('service', 'payments', {
        mode: 'replace',
        title: 'payments',
        spec: { properties: { language: 'rust' } },
      }),
    );
    expect(atVersion2.version).toBe(2);
    const eventsBefore = await selectChangeEvents(db, tenantId, 'payments');

    const result = await entities.upsert(
      c,
      entityInput('service', 'payments', {
        mode: 'replace',
        title: 'payments',
        spec: { properties: { language: 'rust' } },
      }),
    );

    expect(result.outcome).toBe('unchanged');
    expect(result.version).toBe(2);
    const eventsAfter = await selectChangeEvents(db, tenantId, 'payments');
    expect(eventsAfter).toHaveLength(eventsBefore.length);
  });

  it('expectedVersion conflict fails with CATALOG_VERSION_CONFLICT', async () => {
    const tenantId = randomTenantId();
    const c = ctx(tenantId);
    await blueprints.create(c, SERVICE_BLUEPRINT_WITH_LANGUAGE_AND_TIER);
    await entities.upsert(c, entityInput('service', 'payments', { mode: 'replace' }));

    await expectCatalogErrorCode(
      entities.upsert(c, entityInput('service', 'payments', { mode: 'replace', expectedVersion: 99 })),
      'CATALOG_VERSION_CONFLICT',
    );
  });

  it('Spec changes do not touch status', async () => {
    const tenantId = randomTenantId();
    const c = ctx(tenantId);
    await blueprints.create(
      c,
      blueprintInput('service', {
        schema: { properties: { language: { type: 'string', title: { en: 'Language' } } }, required: [] },
        statusSchema: {
          properties: { lastDeployAt: { type: 'string', format: 'date-time', title: { en: 'Last deploy' } } },
          required: [],
        },
      }),
    );
    await entities.upsert(
      c,
      entityInput('service', 'payments', { mode: 'replace', spec: { properties: { language: 'go' } } }),
    );
    await entities.writeStatus(ctx(tenantId, { type: 'integration', id: 'github' }), {
      blueprint: 'service',
      identifier: 'payments',
      properties: { lastDeployAt: '2026-09-01T10:00:00Z' },
      observedGeneration: 1,
      source: 'github',
    });

    const beforeGeneration = (await entities.get(c, { blueprint: 'service', identifier: 'payments' })).generation;
    const statusBefore = (await entities.get(c, { blueprint: 'service', identifier: 'payments' })).status;

    const result = await entities.upsert(
      c,
      entityInput('service', 'payments', { mode: 'replace', spec: { properties: { language: 'rust' } } }),
    );

    expect(result.generation).toBe(beforeGeneration + 1);
    expect(result.status).toEqual(statusBefore);
  });

  it('records tayzu.catalog.entity.mutations for created and updated, never for unchanged', async () => {
    const tenantId = randomTenantId();
    const c = ctx(tenantId);
    await blueprints.create(c, SERVICE_BLUEPRINT_WITH_LANGUAGE_AND_TIER);

    await entities.upsert(c, entityInput('service', 'payments', { mode: 'replace', spec: { properties: { language: 'go' } } }));
    await entities.upsert(c, entityInput('service', 'payments', { mode: 'replace', spec: { properties: { language: 'rust' } } }));
    await entities.upsert(c, entityInput('service', 'payments', { mode: 'replace', spec: { properties: { language: 'rust' } } }));
    await harness.forceFlush();

    const points = sumDataPoints(harness.metricExporter, 'tayzu.catalog.entity.mutations').filter(
      (point) => point.attributes['tayzu.tenant.id'] === tenantId,
    );
    const mutations = points.map((point) => point.attributes['tayzu.catalog.mutation']).sort();
    expect(mutations).toEqual(['created', 'updated']);
  });
});
