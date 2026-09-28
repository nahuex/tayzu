/**
 * Integration tests for task 8.10 (openspec/changes/archive/2026-09-28-001-catalog-core, design
 * D3, D9, D11; spec "Actor attribution and change events").
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
 * ## Why this file needs the telemetry harness
 *
 * Only the "Delegated agent write records the principal" scenario inspects a
 * log record (`catalog.audit.mutation`'s `tayzu.actor.on_behalf_of.*`
 * attributes); every other test in this file reads `EntityService`/
 * `BlueprintService` return values, thrown errors, and raw
 * `catalog_change_event` rows. The harness is still registered once, at
 * module-load time, for the whole file (import-order rule, design D1 --
 * same as `blueprints.int.test.ts`), since it is harmless for the tests that
 * do not use it.
 */
import { runMigrations } from '@tayzu/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// Import order is load-bearing: see the module doc comment above (design D1).
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
import {
  countChangeEventsForTenant,
  selectChangeEventActors,
} from './__fixtures__/entity-b-test-helpers.js';
import { finishedLogRecords } from './__fixtures__/telemetry-assertions.js';
import type { CatalogContext } from '../domain/context.js';
import type { CatalogErrorCode } from '../domain/errors.js';
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

type ActorKind = 'user' | 'agent' | 'integration';
const ACTOR_KINDS: readonly ActorKind[] = ['user', 'agent', 'integration'];

function actorFor(kind: ActorKind): CatalogContext['actor'] {
  return { type: kind, id: `${kind}-1` };
}

function ctxFor(tenantId: string, kind: ActorKind): CatalogContext {
  return { tenantId, actor: actorFor(kind) };
}

interface MutationSucceedResult {
  readonly createdBy?: CatalogContext['actor'];
  readonly updatedBy?: CatalogContext['actor'];
}

interface MutationCase {
  readonly name: string;
  /** The `resource_identifier` every mutation in this case eventually targets. */
  readonly resourceIdentifier: string;
  readonly action: 'created' | 'updated' | 'status_updated' | 'deleted';
  readonly succeed: (c: CatalogContext) => Promise<MutationSucceedResult>;
  /** Prepares everything the failing call needs *except* the failure itself, so the test can snapshot the tenant's change-event count right before it. */
  readonly setupForFailure: (c: CatalogContext) => Promise<void>;
  readonly fail: (c: CatalogContext) => Promise<unknown>;
  readonly failureCode: CatalogErrorCode;
}

describe('actor parity and the audit trail (task 8.10; spec "Actor attribution and change events")', () => {
  let db: TestDb;
  let pool: TestDb['$client'];
  let harness: TelemetryTestHarness;
  let blueprintService: BlueprintService;
  let entityService: EntityService;

  beforeAll(async () => {
    db = connect(databaseUrl());
    pool = db.$client;
    await runMigrations(pool);
    harness = registeredHarness();
    blueprintService = createBlueprintService({ pool });
    entityService = createEntityService({ pool });
  }, 60_000);

  afterEach(async () => {
    await harness.reset();
  });

  afterAll(async () => {
    await endQuietly(pool);
  }, 60_000);

  it('Agent and human writes are attributed identically', async () => {
    const tenantId = randomTenantId();
    await blueprintService.create(ctxFor(tenantId, 'user'), {
      identifier: 'svc',
      title: { en: 'svc' },
      schema: { properties: {}, required: [] },
    });

    const userCtx = ctxFor(tenantId, 'user');
    const agentCtx = ctxFor(tenantId, 'agent');

    const a = await entityService.upsert(userCtx, {
      blueprint: 'svc',
      identifier: 'a',
      title: 'a',
      mode: 'replace',
    });
    const b = await entityService.upsert(agentCtx, {
      blueprint: 'svc',
      identifier: 'b',
      title: 'b',
      mode: 'replace',
    });

    expect(a.updatedBy).toEqual({ type: 'user', id: 'user-1' });
    expect(b.updatedBy).toEqual({ type: 'agent', id: 'agent-1' });

    const eventsA = await selectChangeEventActors(db, tenantId, 'a');
    const eventsB = await selectChangeEventActors(db, tenantId, 'b');
    expect(eventsA[eventsA.length - 1]?.actor_type).toBe('user');
    expect(eventsA[eventsA.length - 1]?.actor_id).toBe('user-1');
    expect(eventsB[eventsB.length - 1]?.actor_type).toBe('agent');
    expect(eventsB[eventsB.length - 1]?.actor_id).toBe('agent-1');
  });

  describe.each(ACTOR_KINDS)('every mutation behaves the same for actor type %s', (kind) => {
    /**
     * Built fresh per actor kind (and lazily reads `blueprintService`/
     * `entityService` through closures, not parameters, so it works whether
     * built at collection time or at run time: only the *invocation* of
     * `succeed`/`fail`/`setupForFailure` -- always during a running test,
     * after `beforeAll` -- ever touches those services).
     */
    function mutationCases(): readonly MutationCase[] {
      const emptySchema = { properties: {}, required: [] } as const;
      return [
        {
          name: 'blueprint.create',
          resourceIdentifier: 'bp',
          action: 'created',
          succeed: async (c) => {
            const output = await blueprintService.create(c, {
              identifier: 'bp',
              title: { en: 'bp' },
              schema: emptySchema,
            });
            return { createdBy: output.createdBy, updatedBy: output.updatedBy };
          },
          setupForFailure: async () => {
            /* nothing to prepare: the failure is the create call itself */
          },
          fail: (c) =>
            blueprintService.create(c, {
              identifier: 'bp',
              title: {},
              schema: emptySchema,
            }),
          failureCode: 'CATALOG_VALIDATION_FAILED',
        },
        {
          name: 'blueprint.update',
          resourceIdentifier: 'bp',
          action: 'updated',
          succeed: async (c) => {
            await blueprintService.create(c, {
              identifier: 'bp',
              title: { en: 'bp' },
              schema: emptySchema,
            });
            const output = await blueprintService.update(c, {
              identifier: 'bp',
              title: { en: 'bp updated' },
              schema: emptySchema,
            });
            return { updatedBy: output.updatedBy };
          },
          setupForFailure: async (c) => {
            await blueprintService.create(c, {
              identifier: 'bp',
              title: { en: 'bp' },
              schema: emptySchema,
            });
          },
          fail: (c) =>
            blueprintService.update(c, {
              identifier: 'bp',
              title: { en: 'bp' },
              schema: { properties: {}, required: ['missing'] },
            }),
          failureCode: 'CATALOG_VALIDATION_FAILED',
        },
        {
          name: 'blueprint.delete',
          resourceIdentifier: 'bp',
          action: 'deleted',
          succeed: async (c) => {
            await blueprintService.create(c, {
              identifier: 'bp',
              title: { en: 'bp' },
              schema: emptySchema,
            });
            await blueprintService.delete(c, { identifier: 'bp' });
            return {};
          },
          setupForFailure: async () => {
            /* nothing to prepare: 'missing-bp' never exists */
          },
          fail: (c) => blueprintService.delete(c, { identifier: 'missing-bp' }),
          failureCode: 'CATALOG_NOT_FOUND',
        },
        {
          name: 'entity.create',
          resourceIdentifier: 'e1',
          action: 'created',
          succeed: async (c) => {
            await blueprintService.create(c, {
              identifier: 'svc',
              title: { en: 'svc' },
              schema: emptySchema,
            });
            const output = await entityService.create(c, {
              blueprint: 'svc',
              identifier: 'e1',
              title: 'e1',
            });
            return { createdBy: output.createdBy, updatedBy: output.updatedBy };
          },
          setupForFailure: async (c) => {
            await blueprintService.create(c, {
              identifier: 'svc',
              title: { en: 'svc' },
              schema: emptySchema,
            });
          },
          fail: (c) =>
            entityService.create(c, {
              blueprint: 'svc',
              identifier: 'e1',
              title: 'e1',
              spec: { properties: { extra: 'not declared' } },
            }),
          failureCode: 'CATALOG_VALIDATION_FAILED',
        },
        {
          name: 'entity.upsert',
          resourceIdentifier: 'e1',
          action: 'created',
          succeed: async (c) => {
            await blueprintService.create(c, {
              identifier: 'svc',
              title: { en: 'svc' },
              schema: emptySchema,
            });
            const output = await entityService.upsert(c, {
              blueprint: 'svc',
              identifier: 'e1',
              title: 'e1',
              mode: 'replace',
            });
            return { createdBy: output.createdBy, updatedBy: output.updatedBy };
          },
          setupForFailure: async (c) => {
            await blueprintService.create(c, {
              identifier: 'svc',
              title: { en: 'svc' },
              schema: emptySchema,
            });
          },
          fail: (c) =>
            entityService.upsert(c, {
              blueprint: 'svc',
              identifier: 'e1',
              title: 'e1',
              mode: 'replace',
              spec: { properties: { extra: 'not declared' } },
            }),
          failureCode: 'CATALOG_VALIDATION_FAILED',
        },
        {
          name: 'entity.writeStatus',
          resourceIdentifier: 'e1',
          action: 'status_updated',
          succeed: async (c) => {
            await blueprintService.create(c, {
              identifier: 'svc',
              title: { en: 'svc' },
              schema: emptySchema,
              statusSchema: {
                properties: { health: { type: 'string', title: { en: 'Health' } } },
                required: [],
              },
            });
            await entityService.create(c, { blueprint: 'svc', identifier: 'e1', title: 'e1' });
            const output = await entityService.writeStatus(c, {
              blueprint: 'svc',
              identifier: 'e1',
              properties: { health: 'ok' },
              observedGeneration: 1,
              source: 'monitor',
            });
            return { updatedBy: output.updatedBy };
          },
          setupForFailure: async (c) => {
            await blueprintService.create(c, {
              identifier: 'svc',
              title: { en: 'svc' },
              schema: emptySchema,
            });
            await entityService.create(c, { blueprint: 'svc', identifier: 'e1', title: 'e1' });
          },
          fail: (c) =>
            entityService.writeStatus(c, {
              blueprint: 'svc',
              identifier: 'e1',
              observedGeneration: 5, // > the entity's current generation (1)
              source: 'monitor',
            }),
          failureCode: 'CATALOG_VALIDATION_FAILED',
        },
        {
          name: 'entity.delete',
          resourceIdentifier: 'e1',
          action: 'deleted',
          succeed: async (c) => {
            await blueprintService.create(c, {
              identifier: 'svc',
              title: { en: 'svc' },
              schema: emptySchema,
            });
            await entityService.create(c, { blueprint: 'svc', identifier: 'e1', title: 'e1' });
            await entityService.delete(c, { blueprint: 'svc', identifier: 'e1' });
            return {};
          },
          setupForFailure: async (c) => {
            await blueprintService.create(c, {
              identifier: 'svc',
              title: { en: 'svc' },
              schema: emptySchema,
            });
          },
          fail: (c) => entityService.delete(c, { blueprint: 'svc', identifier: 'missing' }),
          failureCode: 'CATALOG_NOT_FOUND',
        },
      ];
    }

    it.each(mutationCases().map((testCase) => [testCase.name, testCase] as const))(
      '%s succeeds and is attributed to the actor',
      async (_name, testCase) => {
        const tenantId = randomTenantId();
        const c = ctxFor(tenantId, kind);
        const actor = actorFor(kind);

        const result = await testCase.succeed(c);
        if (result.createdBy) expect(result.createdBy).toEqual(actor);
        if (result.updatedBy) expect(result.updatedBy).toEqual(actor);

        const events = await selectChangeEventActors(db, tenantId, testCase.resourceIdentifier);
        const last = events[events.length - 1];
        expect(last?.action).toBe(testCase.action);
        expect(last?.actor_type).toBe(kind);
        expect(last?.actor_id).toBe(actor.id);
        expect(last?.on_behalf_of_type).toBeNull();
      },
    );

    it.each(mutationCases().map((testCase) => [testCase.name, testCase] as const))(
      '%s fails the same way for every actor type, and appends nothing',
      async (_name, testCase) => {
        const tenantId = randomTenantId();
        const c = ctxFor(tenantId, kind);

        await testCase.setupForFailure(c);
        const before = await countChangeEventsForTenant(db, tenantId);

        await expectCatalogErrorCode(testCase.fail(c), testCase.failureCode);

        const after = await countChangeEventsForTenant(db, tenantId);
        expect(after).toBe(before);
      },
    );
  });

  it('Change events record resulting values', async () => {
    const tenantId = randomTenantId();
    const c = ctxFor(tenantId, 'user');
    await blueprintService.create(c, {
      identifier: 'svc',
      title: { en: 'svc' },
      schema: { properties: { tier: { type: 'string', title: { en: 'Tier' } } }, required: [] },
    });
    await entityService.create(c, {
      blueprint: 'svc',
      identifier: 'payments',
      title: 'Payments',
      spec: { properties: { tier: 'gold' } },
    });
    await entityService.upsert(c, {
      blueprint: 'svc',
      identifier: 'payments',
      title: 'Payments',
      mode: 'merge',
      spec: { properties: { tier: 'silver' } },
    });
    await entityService.delete(c, { blueprint: 'svc', identifier: 'payments' });

    const events = await selectChangeEvents(db, tenantId, 'payments');
    expect(events.map((event) => event.action)).toEqual(['created', 'updated', 'deleted']);

    const created = events[0]?.snapshot as { spec: { properties: { tier: string } } };
    expect(created.spec.properties.tier).toBe('gold');

    const updated = events[1]?.snapshot as { spec: { properties: { tier: string } } };
    expect(updated.spec.properties.tier).toBe('silver');

    const deleted = events[2]?.snapshot as { spec: { properties: { tier: string } } };
    expect(deleted.spec.properties.tier).toBe('silver');
  });

  it('Delegated agent write records the principal', async () => {
    const tenantId = randomTenantId();
    await blueprintService.create(ctxFor(tenantId, 'user'), {
      identifier: 'svc',
      title: { en: 'svc' },
      schema: { properties: {}, required: [] },
    });

    const delegatedCtx: CatalogContext = {
      tenantId,
      actor: { type: 'agent', id: 'ag1', onBehalfOf: { type: 'user', id: 'u1' } },
    };

    const output = await entityService.upsert(delegatedCtx, {
      blueprint: 'svc',
      identifier: 'delegated-e',
      title: 'Delegated',
      mode: 'replace',
    });

    expect(output.updatedBy).toEqual({
      type: 'agent',
      id: 'ag1',
      onBehalfOf: { type: 'user', id: 'u1' },
    });

    const events = await selectChangeEventActors(db, tenantId, 'delegated-e');
    const last = events[events.length - 1];
    expect(last?.actor_type).toBe('agent');
    expect(last?.actor_id).toBe('ag1');
    expect(last?.on_behalf_of_type).toBe('user');
    expect(last?.on_behalf_of_id).toBe('u1');

    await harness.forceFlush();
    const auditLogs = finishedLogRecords(harness.logExporter, 'catalog.audit.mutation');
    const matching = auditLogs.find(
      (record) => record.attributes['tayzu.catalog.resource.identifier'] === 'delegated-e',
    );
    expect(matching).toBeDefined();
    expect(matching?.attributes['tayzu.actor.on_behalf_of.type']).toBe('user');
    expect(matching?.attributes['tayzu.actor.on_behalf_of.id']).toBe('u1');
  });

  it('Failed mutation appends nothing', async () => {
    const tenantId = randomTenantId();
    const c = ctxFor(tenantId, 'user');
    await blueprintService.create(c, {
      identifier: 'svc',
      title: { en: 'svc' },
      schema: { properties: {}, required: [] },
    });

    const before = await countChangeEventsForTenant(db, tenantId);

    await expectCatalogErrorCode(
      entityService.create(c, {
        blueprint: 'svc',
        identifier: 'bad',
        title: 'bad',
        spec: { properties: { extra: 'not declared' } },
      }),
      'CATALOG_VALIDATION_FAILED',
    );

    const after = await countChangeEventsForTenant(db, tenantId);
    expect(after).toBe(before);
  });
});
