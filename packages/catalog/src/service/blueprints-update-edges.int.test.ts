/**
 * Regression tests for `blueprints.update` (design D7, D9; spec "Safe
 * blueprint schema evolution") driven through **real** entities and edges
 * created via the entity service (`./entities.ts`), not seeded with raw SQL
 * the way `blueprints-update.int.test.ts` does for task 7.4's original
 * (relation-free) scenarios. This file exists because `otel-smoke-check`
 * (task 10.1) exposed a production defect specific to blueprints that
 * already have an **in-use relation** (a relation with at least one edge):
 *
 * `blueprints.ts`'s `update` handler unconditionally does
 * `deleteRelationDefinitionsForSource` (a hard DELETE of every
 * `catalog_relation_definition` row for the blueprint) followed by
 * `writeRelationDefinitions` (fresh INSERTs, with brand-new row ids) on
 * *every* update, regardless of whether a relation actually changed. But
 * `catalog_entity_relation.relation_definition_id` is a foreign key to
 * `catalog_relation_definition.id` with `ON DELETE RESTRICT` (design D4,
 * migration `0000_catalog_core.sql`). So the moment any entity holds an edge
 * for a relation the update is keeping unchanged, that DELETE is rejected by
 * Postgres with a `23503` foreign-key violation on
 * `catalog_entity_relation_definition_fk` -- a raw, unmapped database error
 * (no `throwMappedXError` in `update` ever catches it) that the pipeline
 * turns into an opaque `internal` 500, instead of the compatible update the
 * spec requires ("Adding an optional property is compatible", generalized to
 * "keeping an in-use relation unchanged is compatible").
 *
 * Design D7's actual compatibility check (`domain/compatibility.ts`) always
 * runs, and rejects, *before* that DELETE: removing an in-use relation
 * (scenario b below) or changing its `target` while any entity holds a value
 * for it (scenario c) are both caught by `checkCompatibility` itself and
 * never reach the buggy DELETE at all. Only the *compatible* cases (a, and
 * d's compatible half) reach it -- which is exactly why they are the ones
 * this file expects to fail today.
 */
import { runMigrations } from '@tayzu/db';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// Import order is load-bearing: see `blueprints-update.int.test.ts` / `pipeline.int.test.ts`'s
// module doc comments (design D1, "Import order").
import { registration, type TelemetryTestHarness } from './__fixtures__/registered-harness.js';
import {
  connect,
  connectAsOwner,
  databaseUrl,
  endQuietly,
  expectCatalogErrorCode,
  randomTenantId,
  type TestDb,
} from './__fixtures__/blueprint-test-helpers.js';
import type { CatalogContext } from '../domain/context.js';
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

function testCtx(tenantId: string): CatalogContext {
  return { tenantId, actor: { type: 'user', id: 'user-1' } };
}

interface SchemaIncompatibleViolation {
  readonly entityIdentifier: string;
}

/**
 * Creates `team` (the relation target, with entities `team-a` and `team-b`)
 * and `widget` (with an optional, single-cardinality `owner` relation to
 * `team`), all through the real services -- never raw SQL, so every edge
 * this file asserts on is a real `catalog_entity_relation` row the entity
 * service itself wrote.
 */
async function setupTeamAndWidget(
  blueprints: BlueprintService,
  entities: EntityService,
  ctx: CatalogContext,
): Promise<void> {
  await blueprints.create(ctx, {
    identifier: 'team',
    title: { en: 'Team' },
    schema: { properties: {}, required: [] },
  });
  await entities.create(ctx, { blueprint: 'team', identifier: 'team-a', title: 'Team A' });
  await entities.create(ctx, { blueprint: 'team', identifier: 'team-b', title: 'Team B' });

  await blueprints.create(ctx, {
    identifier: 'widget',
    title: { en: 'Widget' },
    schema: { properties: {}, required: [] },
    relations: { owner: { title: { en: 'Owner' }, target: 'team', many: false, required: false } },
  });
}

/** Every `catalog_entity_relation` row's target, for one source entity's spec edges (a direct DB check, independent of the entity service's own read path). */
async function specEdgeTargets(
  db: TestDb,
  tenantId: string,
  sourceIdentifier: string,
): Promise<string[]> {
  const result = await db.execute<{ target_identifier: string }>(sql`
    select te.identifier as target_identifier
    from catalog_entity_relation cer
    join catalog_entity se on se.tenant_id = cer.tenant_id and se.id = cer.source_entity_id
    join catalog_entity te on te.tenant_id = cer.tenant_id and te.id = cer.target_entity_id
    where cer.tenant_id = ${tenantId} and se.identifier = ${sourceIdentifier} and cer.scope = 'spec'
    order by te.identifier
  `);
  return result.rows.map((row) => row.target_identifier);
}

describe('blueprints.update against real entities and edges (design D7, D9; spec "Safe blueprint schema evolution")', () => {
  let db: TestDb;
  let pool: TestDb['$client'];
  let harness: TelemetryTestHarness;
  let blueprints: BlueprintService;
  let entities: EntityService;

  beforeAll(async () => {
    // Raw introspection only (specEdgeTargets below runs outside
    // withTenantTransaction, with no app.tenant_id session setting): the
    // owner connection bypasses RLS, task 6.3, design D6 Q1a.
    db = connectAsOwner(databaseUrl());
    await runMigrations(db.$client);
    // The services under test run through the real tenant_isolation RLS
    // policy, exactly like production.
    pool = connect(databaseUrl()).$client;
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
    await endQuietly(db.$client);
  }, 60_000);

  describe('(a) an in-use relation kept unchanged', () => {
    it('only the title changes: succeeds, keeps the edge, and the entity still returns the relation', async () => {
      const tenantId = randomTenantId();
      const ctx = testCtx(tenantId);
      await setupTeamAndWidget(blueprints, entities, ctx);
      await entities.create(ctx, {
        blueprint: 'widget',
        identifier: 'widget-1',
        title: 'Widget One',
        spec: { relations: { owner: 'team-a' } },
      });

      const before = await blueprints.get(ctx, { identifier: 'widget' });
      expect(before.relations['owner']).toEqual({
        title: { en: 'Owner' },
        target: 'team',
        many: false,
        required: false,
      });
      expect(await specEdgeTargets(db, tenantId, 'widget-1')).toEqual(['team-a']);

      const updated = await blueprints.update(ctx, {
        identifier: 'widget',
        title: { en: 'Widget Renamed' },
        schema: { properties: {}, required: [] },
        relations: {
          owner: { title: { en: 'Owner' }, target: 'team', many: false, required: false },
        },
        expectedVersion: before.version,
      });

      expect(updated.version).toBe(before.version + 1);
      expect(updated.title).toEqual({ en: 'Widget Renamed' });
      expect(updated.relations['owner']).toEqual({
        title: { en: 'Owner' },
        target: 'team',
        many: false,
        required: false,
      });

      // "keeps every edge": both the entity service's own assembled read...
      const entity = await entities.get(ctx, { blueprint: 'widget', identifier: 'widget-1' });
      expect(entity.spec.relations['owner']).toBe('team-a');
      // ...and a direct check of the underlying catalog_entity_relation row.
      expect(await specEdgeTargets(db, tenantId, 'widget-1')).toEqual(['team-a']);
    });

    it('an unrelated optional property is added: succeeds, keeps the edge, and the entity still returns the relation', async () => {
      const tenantId = randomTenantId();
      const ctx = testCtx(tenantId);
      await setupTeamAndWidget(blueprints, entities, ctx);
      await entities.create(ctx, {
        blueprint: 'widget',
        identifier: 'widget-1',
        title: 'Widget One',
        spec: { relations: { owner: 'team-a' } },
      });

      const updated = await blueprints.update(ctx, {
        identifier: 'widget',
        title: { en: 'Widget' },
        schema: { properties: { note: { type: 'string', title: { en: 'Note' } } }, required: [] },
        relations: {
          owner: { title: { en: 'Owner' }, target: 'team', many: false, required: false },
        },
        expectedVersion: 1,
      });

      expect(updated.version).toBe(2);
      expect(Object.keys(updated.schema.properties)).toEqual(['note']);
      expect(updated.relations['owner']).toEqual({
        title: { en: 'Owner' },
        target: 'team',
        many: false,
        required: false,
      });

      const entity = await entities.get(ctx, { blueprint: 'widget', identifier: 'widget-1' });
      expect(entity.spec.relations['owner']).toBe('team-a');
      expect(await specEdgeTargets(db, tenantId, 'widget-1')).toEqual(['team-a']);
    });
  });

  describe('(b) removing an in-use relation', () => {
    it('fails with CATALOG_SCHEMA_INCOMPATIBLE listing the entities holding a value, and changes nothing', async () => {
      const tenantId = randomTenantId();
      const ctx = testCtx(tenantId);
      await setupTeamAndWidget(blueprints, entities, ctx);
      await entities.create(ctx, {
        blueprint: 'widget',
        identifier: 'widget-1',
        title: 'Widget One',
        spec: { relations: { owner: 'team-a' } },
      });

      const error = await expectCatalogErrorCode(
        blueprints.update(ctx, {
          identifier: 'widget',
          title: { en: 'Widget' },
          schema: { properties: {}, required: [] },
          relations: {},
          expectedVersion: 1,
        }),
        'CATALOG_SCHEMA_INCOMPATIBLE',
      );

      const violations = error.details?.['violations'] as
        readonly SchemaIncompatibleViolation[] | undefined;
      expect(violations?.map((violation) => violation.entityIdentifier)).toEqual(['widget-1']);

      const stillCurrent = await blueprints.get(ctx, { identifier: 'widget' });
      expect(stillCurrent.version).toBe(1);
      expect(Object.keys(stillCurrent.relations)).toEqual(['owner']);

      const entity = await entities.get(ctx, { blueprint: 'widget', identifier: 'widget-1' });
      expect(entity.spec.relations['owner']).toBe('team-a');
      expect(await specEdgeTargets(db, tenantId, 'widget-1')).toEqual(['team-a']);
    });
  });

  describe("(c) changing an in-use relation's target", () => {
    it('fails with CATALOG_SCHEMA_INCOMPATIBLE and leaves the relation targeting the original blueprint', async () => {
      const tenantId = randomTenantId();
      const ctx = testCtx(tenantId);
      await setupTeamAndWidget(blueprints, entities, ctx);
      await blueprints.create(ctx, {
        identifier: 'team2',
        title: { en: 'Team Two' },
        schema: { properties: {}, required: [] },
      });
      await entities.create(ctx, { blueprint: 'team2', identifier: 'team2-a', title: 'Team2 A' });
      await entities.create(ctx, {
        blueprint: 'widget',
        identifier: 'widget-1',
        title: 'Widget One',
        spec: { relations: { owner: 'team-a' } },
      });

      const error = await expectCatalogErrorCode(
        blueprints.update(ctx, {
          identifier: 'widget',
          title: { en: 'Widget' },
          schema: { properties: {}, required: [] },
          relations: {
            owner: { title: { en: 'Owner' }, target: 'team2', many: false, required: false },
          },
          expectedVersion: 1,
        }),
        'CATALOG_SCHEMA_INCOMPATIBLE',
      );

      const violations = error.details?.['violations'] as
        readonly SchemaIncompatibleViolation[] | undefined;
      expect(violations?.map((violation) => violation.entityIdentifier)).toEqual(['widget-1']);

      const stillCurrent = await blueprints.get(ctx, { identifier: 'widget' });
      expect(stillCurrent.version).toBe(1);
      expect(stillCurrent.relations['owner']?.target).toBe('team');

      const entity = await entities.get(ctx, { blueprint: 'widget', identifier: 'widget-1' });
      expect(entity.spec.relations['owner']).toBe('team-a');
    });
  });

  describe('(d) changing an in-use relation to required, validated against the existing values', () => {
    it('compatible: every entity already has a value, so the update succeeds and keeps the edges', async () => {
      const tenantId = randomTenantId();
      const ctx = testCtx(tenantId);
      await setupTeamAndWidget(blueprints, entities, ctx);
      await entities.create(ctx, {
        blueprint: 'widget',
        identifier: 'widget-1',
        title: 'Widget One',
        spec: { relations: { owner: 'team-a' } },
      });
      await entities.create(ctx, {
        blueprint: 'widget',
        identifier: 'widget-2',
        title: 'Widget Two',
        spec: { relations: { owner: 'team-b' } },
      });

      const updated = await blueprints.update(ctx, {
        identifier: 'widget',
        title: { en: 'Widget' },
        schema: { properties: {}, required: [] },
        relations: {
          owner: { title: { en: 'Owner' }, target: 'team', many: false, required: true },
        },
        expectedVersion: 1,
      });

      expect(updated.version).toBe(2);
      expect(updated.relations['owner']?.required).toBe(true);

      expect(await specEdgeTargets(db, tenantId, 'widget-1')).toEqual(['team-a']);
      expect(await specEdgeTargets(db, tenantId, 'widget-2')).toEqual(['team-b']);
      const entity1 = await entities.get(ctx, { blueprint: 'widget', identifier: 'widget-1' });
      expect(entity1.spec.relations['owner']).toBe('team-a');
    });

    it('incompatible: an entity has no value, so the update fails with CATALOG_SCHEMA_INCOMPATIBLE listing it', async () => {
      const tenantId = randomTenantId();
      const ctx = testCtx(tenantId);
      await setupTeamAndWidget(blueprints, entities, ctx);
      await entities.create(ctx, {
        blueprint: 'widget',
        identifier: 'widget-1',
        title: 'Widget One',
        spec: { relations: { owner: 'team-a' } },
      });
      await entities.create(ctx, {
        blueprint: 'widget',
        identifier: 'widget-2',
        title: 'Widget Two',
      });

      const error = await expectCatalogErrorCode(
        blueprints.update(ctx, {
          identifier: 'widget',
          title: { en: 'Widget' },
          schema: { properties: {}, required: [] },
          relations: {
            owner: { title: { en: 'Owner' }, target: 'team', many: false, required: true },
          },
          expectedVersion: 1,
        }),
        'CATALOG_SCHEMA_INCOMPATIBLE',
      );

      const violations = error.details?.['violations'] as
        readonly SchemaIncompatibleViolation[] | undefined;
      expect(violations?.map((violation) => violation.entityIdentifier)).toEqual(['widget-2']);

      const stillCurrent = await blueprints.get(ctx, { identifier: 'widget' });
      expect(stillCurrent.version).toBe(1);
      expect(stillCurrent.relations['owner']?.required).toBe(false);
    });
  });
});
