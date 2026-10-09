/**
 * Integration tests for task 8.6 (openspec/changes/archive/2026-09-28-001-catalog-core, design
 * D3-D5, D9-D11; spec "Entity read, list and delete", "Actor attribution and
 * change events").
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
 * None of task 8.6's scenarios name a span, metric or log attribute (unlike
 * task 8.1-8.4's, which do): every assertion below reads `EntityService`'s
 * own return values, thrown errors, or raw `catalog_entity`/
 * `catalog_change_event` rows. This mirrors `isolation-blueprints.int.test.ts`'s
 * own reasoning for skipping `./__fixtures__/registered-harness.js`.
 */
import { ADMIN_PRINCIPAL, authz } from './__fixtures__/authz-test-helpers.js';
import { runMigrations } from '@tayzu/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  blueprintRowId,
  connect,
  connectAsOwner,
  databaseUrl,
  endQuietly,
  expectCatalogErrorCode,
  randomTenantId,
  selectChangeEvents,
  type TestDb,
} from './__fixtures__/blueprint-test-helpers.js';
import {
  entityRowId,
  relationDefinitionRowId,
  seedManyReferrers,
  selectChangeEventActors,
} from './__fixtures__/entity-b-test-helpers.js';
import { redactingAuthz } from './__fixtures__/redaction-authz.js';
import {
  createBlueprintService,
  type BlueprintService,
  type CreateBlueprintInput,
} from './blueprints.js';
import { createEntityService, type CreateEntityInput, type EntityService } from './entities.js';
import type { CatalogContext } from '../domain/context.js';

const DEFAULT_ACTOR: CatalogContext['actor'] = { type: 'user', id: 'user-1' };

function ctx(tenantId: string, actor: CatalogContext['actor'] = DEFAULT_ACTOR): CatalogContext {
  return { tenantId, actor, principal: ADMIN_PRINCIPAL };
}

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

function entityInput(
  blueprint: string,
  identifier: string,
  overrides: Partial<CreateEntityInput> = {},
): CreateEntityInput {
  return {
    blueprint,
    identifier,
    title: identifier,
    ...overrides,
  };
}

/** Sums up to `bigint`, for adjacent-`seq` assertions ("in the same transaction"). */
function seqOf(row: { readonly seq: string }): bigint {
  return BigInt(row.seq);
}

/** The last element of a non-empty array, without a banned `!` non-null assertion. */
function last<T>(items: readonly T[]): T {
  const item = items[items.length - 1];
  if (item === undefined) {
    throw new Error('unreachable: expected at least one element');
  }
  return item;
}

describe('entities.delete (task 8.6; spec "Entity read, list and delete", "Actor attribution and change events")', () => {
  let db: TestDb;
  let pool: TestDb['$client'];
  let blueprintService: BlueprintService;
  let entityService: EntityService;

  beforeAll(async () => {
    // Raw seeding/introspection only (seedManyReferrers, blueprintRowId,
    // entityRowId, selectChangeEvents/selectChangeEventActors below run
    // outside withTenantTransaction, with no app.tenant_id session setting):
    // the owner connection bypasses RLS, task 6.3, design D6 Q1a.
    db = connectAsOwner(databaseUrl());
    await runMigrations(db.$client);
    // The services under test run through the real tenant_isolation RLS
    // policy, exactly like production.
    pool = connect(databaseUrl()).$client;
    blueprintService = createBlueprintService({ pool, authz });
    entityService = createEntityService({ pool, authz });
  }, 60_000);

  afterAll(async () => {
    await endQuietly(pool);
    await endQuietly(db.$client);
  }, 60_000);

  it('Delete an unreferenced entity', async () => {
    const tenantId = randomTenantId();
    const c = ctx(tenantId);
    await blueprintService.create(c, blueprintInput('app'));
    await entityService.create(c, entityInput('app', 'sandbox-svc'));

    await entityService.delete(c, { blueprint: 'app', identifier: 'sandbox-svc' });

    await expectCatalogErrorCode(
      entityService.get(c, { blueprint: 'app', identifier: 'sandbox-svc' }),
      'CATALOG_NOT_FOUND',
    );
  });

  it('Delete a referenced entity is rejected by default', async () => {
    const tenantId = randomTenantId();
    const c = ctx(tenantId);
    await blueprintService.create(c, blueprintInput('team'));
    await blueprintService.create(
      c,
      blueprintInput('service', {
        relations: {
          owner: { title: { en: 'Owner' }, target: 'team', many: false, required: false },
        },
      }),
    );
    await entityService.create(c, entityInput('team', 'team-a'));
    await entityService.create(
      c,
      entityInput('service', 'payments', { spec: { relations: { owner: 'team-a' } } }),
    );

    const error = await expectCatalogErrorCode(
      entityService.delete(c, { blueprint: 'team', identifier: 'team-a' }),
      'CATALOG_REFERENCE_VIOLATION',
    );
    const referrers = error.details?.['referrers'] as readonly string[] | undefined;
    expect(referrers).toContain('payments');

    // Nothing was removed: the referenced entity is unaffected.
    const stillThere = await entityService.get(c, { blueprint: 'team', identifier: 'team-a' });
    expect(stillThere.identifier).toBe('team-a');
  });

  it('Detach optional references on delete', async () => {
    const tenantId = randomTenantId();
    const c = ctx(tenantId);
    await blueprintService.create(
      c,
      blueprintInput('service', {
        relations: {
          dependsOn: {
            title: { en: 'Depends on' },
            target: 'service',
            many: true,
            required: false,
          },
        },
      }),
    );
    await entityService.create(c, entityInput('service', 'ledger'));
    await entityService.create(c, entityInput('service', 'auth'));
    const beforePayments = await entityService.create(
      c,
      entityInput('service', 'payments', {
        spec: { relations: { dependsOn: ['ledger', 'auth'] } },
      }),
    );
    expect(beforePayments.version).toBe(1);
    expect(beforePayments.generation).toBe(1);

    await entityService.delete(c, {
      blueprint: 'service',
      identifier: 'ledger',
      detachReferences: true,
    });

    await expectCatalogErrorCode(
      entityService.get(c, { blueprint: 'service', identifier: 'ledger' }),
      'CATALOG_NOT_FOUND',
    );
    const afterPayments = await entityService.get(c, {
      blueprint: 'service',
      identifier: 'payments',
    });
    expect(afterPayments.spec.relations['dependsOn']).toEqual(['auth']);
    // "each modified referrer gets a new version and generation"
    expect(afterPayments.version).toBe(2);
    expect(afterPayments.generation).toBe(2);
  });

  it('Required references block detach', async () => {
    const tenantId = randomTenantId();
    const c = ctx(tenantId);
    await blueprintService.create(c, blueprintInput('team'));
    await blueprintService.create(
      c,
      blueprintInput('service', {
        relations: {
          owner: { title: { en: 'Owner' }, target: 'team', many: false, required: true },
        },
      }),
    );
    await entityService.create(c, entityInput('team', 'team-a'));
    await entityService.create(
      c,
      entityInput('service', 'payments', { spec: { relations: { owner: 'team-a' } } }),
    );

    await expectCatalogErrorCode(
      entityService.delete(c, { blueprint: 'team', identifier: 'team-a', detachReferences: true }),
      'CATALOG_REFERENCE_VIOLATION',
    );

    const stillTeamA = await entityService.get(c, { blueprint: 'team', identifier: 'team-a' });
    expect(stillTeamA.identifier).toBe('team-a');
    const stillPayments = await entityService.get(c, {
      blueprint: 'service',
      identifier: 'payments',
    });
    expect(stillPayments.spec.relations['owner']).toBe('team-a');
    expect(stillPayments.version).toBe(1);
  });

  it('Detach on delete records every affected entity', async () => {
    const tenantId = randomTenantId();
    const c = ctx(tenantId);
    await blueprintService.create(
      c,
      blueprintInput('service', {
        relations: {
          dependsOn: {
            title: { en: 'Depends on' },
            target: 'service',
            many: true,
            required: false,
          },
        },
      }),
    );
    await entityService.create(c, entityInput('service', 'ledger'));
    await entityService.create(
      c,
      entityInput('service', 'payments', { spec: { relations: { dependsOn: ['ledger'] } } }),
    );

    await entityService.delete(c, {
      blueprint: 'service',
      identifier: 'ledger',
      detachReferences: true,
    });

    const ledgerEvents = await selectChangeEvents(db, tenantId, 'ledger');
    expect(ledgerEvents.map((event) => event.action)).toEqual(['created', 'deleted']);
    const paymentsEvents = await selectChangeEvents(db, tenantId, 'payments');
    expect(paymentsEvents.map((event) => event.action)).toEqual(['created', 'updated']);

    // "in the same transaction": the two events from the delete step
    // (ledger's `deleted` and payments' `updated`) are adjacent in the
    // tenant's gap-free sequence, with nothing else interleaved.
    const ledgerActorRows = await selectChangeEventActors(db, tenantId, 'ledger');
    const paymentsActorRows = await selectChangeEventActors(db, tenantId, 'payments');
    const deletedSeq = seqOf(last(ledgerActorRows));
    const updatedSeq = seqOf(last(paymentsActorRows));
    const diff = deletedSeq > updatedSeq ? deletedSeq - updatedSeq : updatedSeq - deletedSeq;
    expect(diff).toBe(1n);
  });

  it('Observed references never block delete', async () => {
    const tenantId = randomTenantId();
    const c = ctx(tenantId);
    await blueprintService.create(
      c,
      blueprintInput('service', {
        relations: {
          dependsOn: {
            title: { en: 'Depends on' },
            target: 'service',
            many: true,
            required: false,
          },
        },
      }),
    );
    await entityService.create(c, entityInput('service', 'ledger'));
    const created = await entityService.create(c, entityInput('service', 'payments'));
    expect(created.status).toBeNull();

    await entityService.writeStatus(c, {
      blueprint: 'service',
      identifier: 'payments',
      relations: { dependsOn: ['ledger'] },
      observedGeneration: 1,
      source: 'github',
    });

    await entityService.delete(c, { blueprint: 'service', identifier: 'ledger' });

    await expectCatalogErrorCode(
      entityService.get(c, { blueprint: 'service', identifier: 'ledger' }),
      'CATALOG_NOT_FOUND',
    );
    const afterPayments = await entityService.get(c, {
      blueprint: 'service',
      identifier: 'payments',
    });
    expect(afterPayments.status?.relations['dependsOn'] ?? []).not.toContain('ledger');
    // "each affected referrer gets a new version (not generation) and a
    // status_updated change event"
    expect(afterPayments.generation).toBe(1);
    expect(afterPayments.version).toBe(3); // created (1) -> status write (2) -> status_updated from the delete (3)

    const paymentsEvents = await selectChangeEvents(db, tenantId, 'payments');
    expect(paymentsEvents.map((event) => event.action)).toEqual([
      'created',
      'status_updated',
      'status_updated',
    ]);
  });

  it('detachReferences fails with CATALOG_LIMIT_EXCEEDED naming detach.maxReferrers beyond 1000 referrers', async () => {
    const tenantId = randomTenantId();
    const c = ctx(tenantId);
    await blueprintService.create(c, blueprintInput('target'));
    await blueprintService.create(
      c,
      blueprintInput('ref', {
        relations: {
          points: { title: { en: 'Points to' }, target: 'target', many: false, required: false },
        },
      }),
    );
    const victim = await entityService.create(c, entityInput('target', 'victim'));
    expect(victim.identifier).toBe('victim');

    const targetBlueprintId = await blueprintRowId(db, tenantId, 'target');
    const refBlueprintId = await blueprintRowId(db, tenantId, 'ref');

    const victimEntityId = await entityRowId(db, tenantId, targetBlueprintId, 'victim');
    const relationDefinitionId = await relationDefinitionRowId(
      db,
      tenantId,
      refBlueprintId,
      'points',
    );
    await seedManyReferrers(
      db,
      tenantId,
      refBlueprintId,
      relationDefinitionId,
      victimEntityId,
      1001,
    );

    const error = await expectCatalogErrorCode(
      entityService.delete(c, {
        blueprint: 'target',
        identifier: 'victim',
        detachReferences: true,
      }),
      'CATALOG_LIMIT_EXCEEDED',
    );
    expect(error.details?.['limit']).toBe('detach.maxReferrers');

    const stillThere = await entityService.get(c, { blueprint: 'target', identifier: 'victim' });
    expect(stillThere.identifier).toBe('victim');
  });

  it('Delete-blocking referrers the caller cannot read are redacted to a count', async () => {
    // GIVEN `team-a` is referenced by 1 entity the caller can read and 4 the
    // caller cannot read (task 10.3, design D12)
    const hidden = ['hidden-1', 'hidden-2', 'hidden-3', 'hidden-4'];
    const seed = async (required: boolean): Promise<CatalogContext> => {
      const tenantId = randomTenantId();
      const c = ctx(tenantId);
      await blueprintService.create(c, blueprintInput('team'));
      await blueprintService.create(
        c,
        blueprintInput('service', {
          relations: {
            owner: { title: { en: 'Owner' }, target: 'team', many: false, required },
          },
        }),
      );
      await entityService.create(c, entityInput('team', 'team-a'));
      for (const identifier of ['visible-1', ...hidden]) {
        await entityService.create(
          c,
          entityInput('service', identifier, { spec: { relations: { owner: 'team-a' } } }),
        );
      }
      return c;
    };
    const expectRedacted = (
      error: { readonly message: string; readonly issues?: unknown; readonly details?: unknown },
      details: Readonly<Record<string, unknown>> | undefined,
    ): void => {
      // THEN the error names the readable referrer and reports "+4 not visible"
      expect(details?.['referrers']).toEqual(['visible-1']);
      expect(details?.['notVisible']).toBe(4);
      // AND no unreadable identifier leaks anywhere in the error
      const serialized = JSON.stringify({
        message: error.message,
        issues: error.issues,
        details: error.details,
      });
      for (const identifier of hidden) {
        expect(serialized).not.toContain(identifier);
      }
    };

    // WHEN `team-a` is deleted without `detachReferences`
    const c = await seed(false);
    // Candidates come ordered by identifier (hidden-1..4, visible-1), so the
    // readable referrer `visible-1` is position 4; `team-a` is the single
    // identifier-keyed check of the deleted entity itself (Q119, Q130).
    const readableSet = new Set(['4', 'team-a']);
    const positions = ['0', '1', '2', '3', '4'];
    const expectPositionalBatch = (ids: readonly string[] | undefined): void => {
      // Rewritten (Q119, Q130; stricter): the ids are positions and no
      // candidate identifier is in the request.
      expect(ids).toEqual(positions);
      for (const identifier of ['visible-1', ...hidden]) {
        expect(JSON.stringify(ids)).not.toContain(identifier);
      }
    };
    const spy = redactingAuthz(readableSet);
    const redacting = createEntityService({ pool, authz: spy.client });
    const error = await expectCatalogErrorCode(
      redacting.delete(c, { blueprint: 'team', identifier: 'team-a' }),
      'CATALOG_REFERENCE_VIOLATION',
    );
    expectRedacted(error, error.details);

    // AND the redaction was one batch check over the candidates, in this tenant
    // (the operation's own check on `team-a` is a single-resource batch,
    // answered readable by the fixture's set; it is not the redaction batch)
    const redactionBatches = spy.batches.filter((batch) => batch.ids.length > 1);
    expect(redactionBatches).toHaveLength(1);
    expectPositionalBatch(redactionBatches[0]?.ids);
    expect(new Set(redactionBatches[0]?.attrTenantIds)).toEqual(new Set([c.tenantId]));

    // AND the entity is still there
    expect((await entityService.get(c, { blueprint: 'team', identifier: 'team-a' })).version).toBe(
      1,
    );

    // The `detachReferences` case (task 10.3): required referrers still block
    // the delete, and the error is redacted the same way.
    const cRequired = await seed(true);
    const detachSpy = redactingAuthz(readableSet);
    const detaching = createEntityService({ pool, authz: detachSpy.client });
    const detachError = await expectCatalogErrorCode(
      detaching.delete(cRequired, {
        blueprint: 'team',
        identifier: 'team-a',
        detachReferences: true,
      }),
      'CATALOG_REFERENCE_VIOLATION',
    );
    expectRedacted(detachError, detachError.details);
    const detachBatches = detachSpy.batches.filter((batch) => batch.ids.length > 1);
    expect(detachBatches).toHaveLength(1);
    expectPositionalBatch(detachBatches[0]?.ids);
  });
});
