/**
 * Integration tests for task 8.7 (openspec/changes/archive/2026-09-28-001-catalog-core, design
 * D3-D5, D9-D11; spec "Related entities traversal").
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
 * ## Why this file needs no telemetry harness
 *
 * Task 8.7's Verify clause names no span, metric or log attribute: both
 * scenarios only assert `listRelated`'s return value. Same reasoning as
 * `entities-delete.int.test.ts`.
 */
import { runMigrations } from '@tayzu/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connect, databaseUrl, endQuietly, randomTenantId, type TestDb } from './__fixtures__/blueprint-test-helpers.js';
import { createBlueprintService, type BlueprintService, type CreateBlueprintInput } from './blueprints.js';
import { createEntityService, type CreateEntityInput, type EntityService, type RelatedEntityItem } from './entities.js';
import type { CatalogContext } from '../domain/context.js';

const DEFAULT_ACTOR: CatalogContext['actor'] = { type: 'user', id: 'user-1' };

function ctx(tenantId: string, actor: CatalogContext['actor'] = DEFAULT_ACTOR): CatalogContext {
  return { tenantId, actor };
}

function blueprintInput(identifier: string, overrides: Partial<CreateBlueprintInput> = {}): CreateBlueprintInput {
  return {
    identifier,
    title: { en: identifier },
    schema: { properties: {}, required: [] },
    ...overrides,
  };
}

function entityInput(blueprint: string, identifier: string, overrides: Partial<CreateEntityInput> = {}): CreateEntityInput {
  return {
    blueprint,
    identifier,
    title: identifier,
    ...overrides,
  };
}

function findItem(
  items: readonly RelatedEntityItem[],
  identifier: string,
): RelatedEntityItem | undefined {
  return items.find((item) => item.entity.identifier === identifier);
}

describe('entities.listRelated (task 8.7; spec "Related entities traversal")', () => {
  let pool: TestDb['$client'];
  let blueprintService: BlueprintService;
  let entityService: EntityService;

  beforeAll(async () => {
    const db = connect(databaseUrl());
    pool = db.$client;
    await runMigrations(pool);
    blueprintService = createBlueprintService({ pool });
    entityService = createEntityService({ pool });
  }, 60_000);

  afterAll(async () => {
    await endQuietly(pool);
  }, 60_000);

  it('Forward and backward relations', async () => {
    const tenantId = randomTenantId();
    const c = ctx(tenantId);
    await blueprintService.create(c, blueprintInput('team'));
    await blueprintService.create(
      c,
      blueprintInput('service', {
        relations: { owner: { title: { en: 'Owner' }, target: 'team', many: false, required: false } },
      }),
    );
    await entityService.create(c, entityInput('team', 'team-a'));
    await entityService.create(c, entityInput('service', 'payments', { spec: { relations: { owner: 'team-a' } } }));
    await entityService.create(c, entityInput('service', 'billing', { spec: { relations: { owner: 'team-a' } } }));

    const backward = await entityService.listRelated(c, {
      blueprint: 'team',
      identifier: 'team-a',
      direction: 'backward',
    });
    const payments = findItem(backward.items, 'payments');
    const billing = findItem(backward.items, 'billing');
    expect(payments).toBeDefined();
    expect(billing).toBeDefined();
    expect(payments?.sourceBlueprint).toBe('service');
    expect(payments?.relation).toBe('owner');
    expect(billing?.sourceBlueprint).toBe('service');
    expect(billing?.relation).toBe('owner');

    const forward = await entityService.listRelated(c, {
      blueprint: 'service',
      identifier: 'payments',
      direction: 'forward',
    });
    const teamA = findItem(forward.items, 'team-a');
    expect(teamA).toBeDefined();
    expect(teamA?.relation).toBe('owner');
    expect(teamA?.scope).toBe('spec');
    expect(teamA?.entity.blueprint).toBe('team');
  });

  it('Traversal distinguishes desired and observed', async () => {
    const tenantId = randomTenantId();
    const c = ctx(tenantId);
    await blueprintService.create(
      c,
      blueprintInput('service', {
        relations: { dependsOn: { title: { en: 'Depends on' }, target: 'service', many: true, required: false } },
      }),
    );
    await entityService.create(c, entityInput('service', 'ledger'));
    await entityService.create(c, entityInput('service', 'auth'));
    await entityService.create(
      c,
      entityInput('service', 'payments', { spec: { relations: { dependsOn: ['ledger'] } } }),
    );
    await entityService.writeStatus(c, {
      blueprint: 'service',
      identifier: 'payments',
      relations: { dependsOn: ['auth'] },
      observedGeneration: 1,
      source: 'github',
    });

    const statusOnly = await entityService.listRelated(c, {
      blueprint: 'service',
      identifier: 'payments',
      direction: 'forward',
      scope: 'status',
    });

    expect(statusOnly.items).toHaveLength(1);
    expect(statusOnly.items[0]?.entity.identifier).toBe('auth');
    expect(statusOnly.items[0]?.scope).toBe('status');
  });
});
