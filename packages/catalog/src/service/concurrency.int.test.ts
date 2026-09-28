/**
 * Integration tests for task 8.9 (openspec/changes/archive/2026-09-28-001-catalog-core, design
 * D3, D5, D7; spec "Safe blueprint schema evolution", "Entity shape with spec
 * and status"). Design D7: "Entity writes lock their blueprint row FOR
 * SHARE. Entity writes lock their blueprint row FOR SHARE. ... Entity writes
 * lock their blueprint row FOR SHARE. As a result, an entity write can never
 * interleave with a schema change and commit against a stale schema."
 *
 * ## Module under test and assumed API (identical across every file this
 * batch, tasks 8.6-8.10, writes: `entities-delete.int.test.ts`,
 * `entity-related.int.test.ts`, `isolation-entities.int.test.ts`,
 * `concurrency.int.test.ts`, `actor-parity.int.test.ts`)
 *
 * `./entities.ts` does not exist yet (red phase). This test assumes the
 * following exported shape, mirroring `./blueprints.ts`'s own shape (design
 * D3: every operation is built with `defineCatalogOperation`, `./pipeline.js`,
 * so context validation, the tenant transaction, error mapping and telemetry
 * are the same for every catalog operation and every actor type):
 *
 * ```ts
 * export interface EntitySpecWriteInput {
 *   readonly properties?: Record<string, unknown>;
 *   // A key's value of `null` removes it (`merge` mode only; design D9,
 *   // domain/apply-write.js).
 *   readonly relations?: Record<string, string | readonly string[] | null>;
 * }
 *
 * export interface CreateEntityInput {
 *   readonly blueprint: string;         // blueprint identifier
 *   readonly identifier: string;        // entity identifier (domain/identifiers.js)
 *   readonly title: string;             // plain string, 1-256 chars, not localized
 *   readonly icon?: string;
 *   readonly spec?: EntitySpecWriteInput;
 * }
 *
 * export type UpsertEntityInput = CreateEntityInput & {
 *   readonly mode: 'replace' | 'merge';
 *   readonly expectedVersion?: number;
 * };
 *
 * export interface WriteEntityStatusInput {
 *   readonly blueprint: string;
 *   readonly identifier: string;
 *   readonly properties?: Record<string, unknown>;
 *   readonly relations?: Record<string, string | readonly string[]>;
 *   readonly observedGeneration: number;
 *   readonly source: string;            // status.source pattern (spec Conventions)
 * }
 *
 * export interface GetEntityInput { readonly blueprint: string; readonly identifier: string }
 * export interface ListEntitiesInput { readonly blueprint: string; readonly pageSize?: number; readonly cursor?: string }
 * export interface ListEntitiesOutput { readonly items: readonly EntityOutput[]; readonly cursor?: string }
 * export interface DeleteEntityInput {
 *   readonly blueprint: string;
 *   readonly identifier: string;
 *   readonly detachReferences?: boolean;  // default false
 * }
 *
 * export type RelatedDirection = 'forward' | 'backward';
 * export type RelatedScopeFilter = 'spec' | 'status' | 'both';  // default 'both'
 * export interface ListRelatedEntitiesInput {
 *   readonly blueprint: string;
 *   readonly identifier: string;
 *   readonly direction: RelatedDirection;
 *   readonly scope?: RelatedScopeFilter;
 *   readonly pageSize?: number;
 *   readonly cursor?: string;
 * }
 * export interface RelatedEntitySummary {
 *   readonly blueprint: string;
 *   readonly identifier: string;
 *   readonly title: string;
 * }
 * export interface RelatedEntityItem {
 *   readonly relation: string;
 *   readonly scope: 'spec' | 'status';
 *   // Forward: the traversal root's own blueprint. Backward: the referrer's
 *   // (source) blueprint -- spec "Related entities traversal": "grouped by
 *   // source blueprint and relation".
 *   readonly sourceBlueprint: string;
 *   // Forward: the relation's target. Backward: the referrer itself.
 *   readonly entity: RelatedEntitySummary;
 * }
 * export interface ListRelatedEntitiesOutput {
 *   readonly items: readonly RelatedEntityItem[];
 *   readonly cursor?: string;
 * }
 *
 * export interface EntityStatusOutput {
 *   readonly properties: Record<string, unknown>;
 *   readonly relations: Record<string, string | readonly string[]>;
 *   readonly observedGeneration: number;
 *   readonly observedAt: string;        // ISO 8601, "Z" suffix
 *   readonly source: string;
 * }
 *
 * // Assembled the same way `./blueprints.ts` assembles `BlueprintOutput`'s
 * // relations: `spec.relations`/`status.relations` are read back from
 * // `catalog_entity_relation` edges (design D4, ADR-0009), keyed by scope,
 * // never stored inside the `spec`/`status` jsonb columns themselves.
 * export interface EntityOutput {
 *   readonly blueprint: string;
 *   readonly identifier: string;
 *   readonly title: string;
 *   readonly icon?: string;
 *   readonly spec: {
 *     readonly properties: Record<string, unknown>;
 *     readonly relations: Record<string, string | readonly string[]>;
 *   };
 *   readonly status: EntityStatusOutput | null;
 *   readonly generation: number;
 *   readonly version: number;
 *   readonly createdAt: string;
 *   readonly createdBy: CatalogContext['actor'];
 *   readonly updatedAt: string;
 *   readonly updatedBy: CatalogContext['actor'];
 * }
 * export type UpsertEntityOutput = EntityOutput & { readonly outcome: 'created' | 'updated' | 'unchanged' };
 *
 * export interface CreateEntityServiceOptions {
 *   readonly pool: Pool;               // 'pg', same as createBlueprintService's own option
 *   readonly limits?: CatalogLimits;   // domain/limits.js; defaults to defaultCatalogLimits
 * }
 *
 * export interface EntityService {
 *   readonly create: (rawContext: unknown, input: CreateEntityInput) => Promise<EntityOutput>;
 *   readonly upsert: (rawContext: unknown, input: UpsertEntityInput) => Promise<UpsertEntityOutput>;
 *   readonly writeStatus: (rawContext: unknown, input: WriteEntityStatusInput) => Promise<EntityOutput>;
 *   readonly get: (rawContext: unknown, input: GetEntityInput) => Promise<EntityOutput>;
 *   readonly list: (rawContext: unknown, input: ListEntitiesInput) => Promise<ListEntitiesOutput>;
 *   // Returns void (mirrors `BlueprintService['delete']`); a successful
 *   // detach's affected referrers are only observable through their own
 *   // `get`, `version`/`generation`, and their `updated` change events, not
 *   // through this return value.
 *   readonly delete: (rawContext: unknown, input: DeleteEntityInput) => Promise<void>;
 *   readonly listRelated: (rawContext: unknown, input: ListRelatedEntitiesInput) => Promise<ListRelatedEntitiesOutput>;
 * }
 *
 * export function createEntityService(options: CreateEntityServiceOptions): EntityService;
 * ```
 *
 * Each of the seven functions is `defineCatalogOperation({ name: 'entity.<verb>', pool, handler })`
 * (design D3): span `catalog.entity.<verb>` (`catalog.entity.related.list`
 * for `listRelated`) with the common attributes plus
 * `tayzu.catalog.blueprint.identifier`/`tayzu.catalog.entity.identifier`
 * (design.md, Spans table). `create`, `upsert`, `writeStatus` and `delete`
 * validate spec/status relations with a `catalog.relations.resolve` child
 * span (`tayzu.catalog.relation.target.count`, and
 * `tayzu.catalog.relation.missing.count` when any target does not exist --
 * `CATALOG_REFERENCE_VIOLATION`) and an entity-property validation child span
 * `catalog.entity.validate`. A successful mutation's handler result carries
 * an `audit` (`./pipeline.js`'s `CatalogMutationAudit`, `resourceKind:
 * 'entity'`), so the pipeline emits `catalog.audit.mutation` and appends the
 * change event with a `snapshot` of `{ title, icon, spec, status }` (the last
 * state for a delete) in the same transaction (design D9, R13; spec "Actor
 * attribution and change events"). Every mutation also increments
 * `tayzu.catalog.entity.mutations` (design.md, Metrics table) with
 * `tayzu.tenant.id`, `tayzu.catalog.blueprint.identifier`,
 * `tayzu.catalog.mutation` (`'created'|'updated'|'status_updated'|'deleted'|'detached'`)
 * and `tayzu.actor.type`.
 *
 * Reserved identifiers (spec "Reserved system identifiers"): `create`,
 * `upsert`, `writeStatus` and `delete` on an entity of a `_`-prefixed
 * blueprint call `assertReservedAccess(blueprintIdentifier, 'entity_write',
 * ctx.actor)` (domain/reserved.js) exactly like `./blueprints.ts` does for
 * `'blueprint_write'`, and get the same `CATALOG_RESERVED_IDENTIFIER` /
 * `catalog.security.reserved_identifier_denied` WARN-log treatment. Reads
 * (`get`, `list`, `listRelated`) are never restricted.
 *
 * `create` fails with `CATALOG_NOT_FOUND` when `blueprint` does not exist in
 * the tenant (spec "Entity of a missing blueprint": looked up the same way
 * `./blueprints.ts`'s `get` looks up a blueprint, never surfaced as a foreign
 * key violation), and with `CATALOG_ALREADY_EXISTS` on
 * `catalog_entity_tenant_blueprint_identifier_uq` (design D9's
 * constraint-name mapping, mirroring `./blueprints.ts`'s
 * `throwMappedCreateError`). Every write locks the target blueprint row
 * **`FOR SHARE`** (`blueprints-repository.ts`'s `selectBlueprintRow`, called
 * with a `{ forShare: true }` option alongside its existing `{ forUpdate:
 * true } `; design D7: "Entity writes lock their blueprint row FOR SHARE
 * ... As a result, an entity write can never interleave with a schema change
 * and commit against a stale schema", the property task 8.9 exercises
 * directly with two real connections).
 *
 * `spec.relations`/`status.relations` are validated for shape with
 * `domain/relation-values.js`'s `validateRelationValues` (scope `'spec'` for
 * `create`/`upsert`, `'status'` for `writeStatus`, `required` enforced only
 * for `'spec'`), then every target identifier is resolved to an entity of
 * the relation's target blueprint **in the same tenant** -- a target from
 * another tenant is indistinguishable from a missing one, both
 * `CATALOG_REFERENCE_VIOLATION` (spec "Tenant data isolation", "Cross-tenant
 * relation target is rejected"). `writeStatus` additionally rejects
 * `observedGeneration` greater than the entity's current `generation`, and a
 * non-empty `properties` when the blueprint has no `statusSchema`, both
 * `CATALOG_VALIDATION_FAILED`.
 *
 * `delete` without `detachReferences` fails with `CATALOG_REFERENCE_VIOLATION`
 * when any **spec** edge targets the entity, `error.details['referrers']`
 * holding up to 10 referring entity identifiers (mirroring
 * `./blueprints.ts`'s own `details.violations` naming convention for a
 * similar "list up to N offending identifiers" shape). `status`-scope edges
 * never block a delete: they are always removed in the same transaction, and
 * each affected referrer gets a new `version` (not `generation`) and its own
 * `status_updated` change event. `delete` with `detachReferences: true`
 * additionally fails, with nothing changed, if any referrer holds the entity
 * through a `required` relation; more than
 * `limits.detach.maxReferrers` (1000) referrers fails with
 * `CATALOG_LIMIT_EXCEEDED` naming `'detach.maxReferrers'` in
 * `error.details['limit']` (the same `details.limit` convention
 * `domain/blueprint-definition.js` and `domain/relation-values.js` already
 * use) -- checked before touching any referrer row. Otherwise every optional
 * referrer's edge to the entity is removed, and that referrer gets a new
 * `version` and `generation` and its own `updated` change event, all in the
 * same transaction as the entity's own `deleted` event (spec "Detach on
 * delete records every affected entity").
 *
 * `listRelated` reads `catalog_entity_relation` edges in the requested
 * `direction` (`target_entity_id = <this entity>` for `'backward'`,
 * `source_entity_id = <this entity>` for `'forward'`), filtered by `scope`
 * when given, and never crosses tenants (every query filters by
 * `tenant_id`). `list` and `listRelated` both sort ascending with keyset
 * pagination (design D10) exactly like `./blueprints.ts`'s `list`.
 *
 * Every function's `rawContext` is parsed the same way for every actor type
 * (design D3: "There is no second entry point"): the full actor-parity
 * matrix (task 8.10) is the guard that no mutation ever special-cases
 * `user`, `agent` or `integration`.
 *
 * ## The barrier, in detail
 *
 * Postgres's lock manager is anti-starvation FIFO for a single row's
 * conflicting lock requests: a later request is never granted ahead of an
 * earlier, still-queued *conflicting* request, even when the later one would
 * individually be compatible with whatever is currently held. Both scenarios
 * below exploit exactly that guarantee to make the winner of the race
 * deterministic, with no arbitrary `sleep`:
 *
 * 1. A dedicated controller connection (`acquireBlueprintRowLock`,
 *    `./__fixtures__/entity-b-test-helpers.js`) takes `FOR UPDATE` on the
 *    blueprint row first, which blocks *both* `blueprints.update`'s own `FOR
 *    UPDATE` and `entities.create`'s `FOR SHARE` (design D7).
 * 2. The test starts one of the two real service calls, then polls
 *    (`waitForBlueprintRowWaiters`) until `pg_locks` shows exactly one
 *    backend queued on that specific row (`blueprintRowLocation`'s `page`/
 *    `tuple`, not a bare `relation = 'catalog_blueprint'` filter, so this
 *    never confuses another int test file's unrelated blueprint-row lock
 *    activity for this test's own barrier -- integration test files can run
 *    concurrently against the same `DATABASE_URL` database, design D12).
 * 3. The test starts the second call and waits for two queued waiters, so
 *    both are provably *behind* the controller before either can make
 *    progress, in the order the test itself chose to start them.
 * 4. The controller releases (`release()`, a `COMMIT` of its own read-only
 *    transaction). Whichever request queued first is granted first; the
 *    second is granted only once the first request's own transaction
 *    commits or rolls back.
 */
import { runMigrations } from '@tayzu/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  connect,
  databaseUrl,
  endQuietly,
  expectCatalogErrorCode,
  randomTenantId,
  type TestDb,
} from './__fixtures__/blueprint-test-helpers.js';
import {
  acquireBlueprintRowLock,
  blueprintRowLocation,
  waitForBlueprintRowWaiters,
} from './__fixtures__/entity-b-test-helpers.js';
import { createBlueprintService, type BlueprintService } from './blueprints.js';
import { createEntityService, type EntityService } from './entities.js';
import type { CatalogContext } from '../domain/context.js';

const DEFAULT_ACTOR: CatalogContext['actor'] = { type: 'user', id: 'user-1' };

function ctx(tenantId: string): CatalogContext {
  return { tenantId, actor: DEFAULT_ACTOR };
}

const TIER_ONLY_SCHEMA = {
  properties: { tier: { type: 'string', title: { en: 'Tier' } } },
  required: [],
} as const;

describe('entity write racing a blueprint update (task 8.9; design D7)', () => {
  let db: TestDb;
  let pool: TestDb['$client'];
  let blueprintService: BlueprintService;
  let entityService: EntityService;

  beforeAll(async () => {
    db = connect(databaseUrl());
    pool = db.$client;
    await runMigrations(pool);
    blueprintService = createBlueprintService({ pool });
    entityService = createEntityService({ pool });
  }, 60_000);

  afterAll(async () => {
    await endQuietly(pool);
  }, 60_000);

  it('commits the entity write against the new schema when the blueprint update wins the lock race', async () => {
    const tenantId = randomTenantId();
    const c = ctx(tenantId);
    await blueprintService.create(c, {
      identifier: 'service',
      title: { en: 'service' },
      schema: TIER_ONLY_SCHEMA,
    });
    const location = await blueprintRowLocation(db, tenantId, 'service');

    const controller = await acquireBlueprintRowLock(pool, tenantId, 'service', 'update');

    // Queues first: blueprints.update's own internal `FOR UPDATE`.
    const updatePromise = blueprintService.update(c, {
      identifier: 'service',
      title: { en: 'service' },
      schema: {
        properties: {
          tier: { type: 'string', title: { en: 'Tier' } },
          region: { type: 'string', title: { en: 'Region' }, default: 'us' },
        },
        required: [],
      },
    });
    await waitForBlueprintRowWaiters(db, location, 1);

    // Queues second: entities.create's own internal `FOR SHARE`.
    const createPromise = entityService.create(c, {
      blueprint: 'service',
      identifier: 'payments',
      title: 'Payments',
      spec: { properties: { tier: 'gold' } },
    });
    await waitForBlueprintRowWaiters(db, location, 2);

    await controller.release();

    const updated = await updatePromise;
    expect(updated.version).toBe(2);

    const created = await createPromise;
    // The entity write only proceeded after the update committed, so it was
    // validated against (and defaulted from) the *new* schema.
    expect(created.spec.properties).toEqual({ tier: 'gold', region: 'us' });

    const stillCurrent = await blueprintService.get(c, { identifier: 'service' });
    expect(stillCurrent.version).toBe(2);
  });

  it('never persists an invalid entity: the entity write wins the lock race, and the later-incompatible update is rejected', async () => {
    const tenantId = randomTenantId();
    const c = ctx(tenantId);
    await blueprintService.create(c, {
      identifier: 'service',
      title: { en: 'service' },
      schema: TIER_ONLY_SCHEMA,
    });
    const location = await blueprintRowLocation(db, tenantId, 'service');

    const controller = await acquireBlueprintRowLock(pool, tenantId, 'service', 'update');

    // Queues first: entities.create's own internal `FOR SHARE`.
    const createPromise = entityService.create(c, {
      blueprint: 'service',
      identifier: 'billing',
      title: 'Billing',
      spec: { properties: { tier: 'silver' } },
    });
    await waitForBlueprintRowWaiters(db, location, 1);

    // Queues second: blueprints.update's own internal `FOR UPDATE`, adding a
    // required property the about-to-be-created `billing` entity has no
    // value for.
    const updatePromise = blueprintService.update(c, {
      identifier: 'service',
      title: { en: 'service' },
      schema: {
        properties: {
          tier: { type: 'string', title: { en: 'Tier' } },
          region: { type: 'string', title: { en: 'Region' } },
        },
        required: ['region'],
      },
    });
    await waitForBlueprintRowWaiters(db, location, 2);

    await controller.release();

    const created = await createPromise;
    expect(created.spec.properties).toEqual({ tier: 'silver' });

    const updateError = await expectCatalogErrorCode(updatePromise, 'CATALOG_SCHEMA_INCOMPATIBLE');
    const violations = updateError.details?.['violations'] as readonly { entityIdentifier: string }[] | undefined;
    expect(violations?.map((violation) => violation.entityIdentifier)).toEqual(['billing']);

    // Nothing changed: the blueprint stayed at its previous version, and the
    // entity that committed under it is still valid under the (unchanged)
    // current schema.
    const stillCurrent = await blueprintService.get(c, { identifier: 'service' });
    expect(stillCurrent.version).toBe(1);
    const stillBilling = await entityService.get(c, { blueprint: 'service', identifier: 'billing' });
    expect(stillBilling.spec.properties).toEqual({ tier: 'silver' });
  });
});
