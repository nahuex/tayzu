/**
 * Integration tests for task 7.4 (openspec/changes/archive/2026-09-28-001-catalog-core, design
 * D7, D9; spec "Safe blueprint schema evolution"). See
 * `blueprints.int.test.ts` for `./blueprints.js`'s full assumed API
 * (`createBlueprintService`, `BlueprintService`, `CreateBlueprintInput` /
 * `UpdateBlueprintInput`, `BlueprintOutput`); this file only adds the shape
 * of a `CATALOG_SCHEMA_INCOMPATIBLE` error's `details`, which design D7
 * needs and `blueprints.int.test.ts` never triggers:
 *
 * ```ts
 * // Mirrors domain/compatibility.js's own CompatibilityViolation exactly
 * // (checkCompatibility(newDefinition, entities) already returns exactly
 * // this shape per violation; the service is assumed to pass it through
 * // verbatim into the CatalogError it throws).
 * interface SchemaIncompatibleDetails {
 *   readonly violations: readonly {
 *     readonly entityIdentifier: string;
 *     readonly issues: readonly { readonly path: string; readonly message: string }[];
 *   }[];
 * }
 * ```
 *
 * `update` is assumed to run design D7's steps: lock the blueprint row `FOR
 * UPDATE`, compile the proposed validator, stream the blueprint's entities
 * (assembling their relations), and run `checkCompatibility` (see
 * `domain/compatibility.ts`) against the *proposed* definition before
 * committing anything. On incompatibility, the blueprint row is left
 * unchanged (still its previous `version` and `schema`) and no change event
 * is appended. `checkCompatibility` is wrapped in a child span
 * `catalog.blueprint.compatibility_check` (design.md, Spans table):
 * `tayzu.catalog.blueprint.identifier`, `tayzu.catalog.compatibility.entities_checked`
 * (required, the number of entities actually validated), and
 * `tayzu.catalog.compatibility.violation.count` (conditional: present only
 * when at least one violation was found).
 *
 * Entities are seeded with raw parameterized SQL directly into
 * `catalog_entity` (`./__fixtures__/blueprint-test-helpers.js`'s
 * `seedEntity`), exactly like `blueprints.int.test.ts` does for task 7.5:
 * entity *operations* (task 8.x) do not exist yet.
 */
import { ADMIN_PRINCIPAL, authz } from './__fixtures__/authz-test-helpers.js';
import { runMigrations } from '@tayzu/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// Import order is load-bearing: see `blueprints.int.test.ts`'s module doc
// comment (design D1, "Import order").
import { registration, type TelemetryTestHarness } from './__fixtures__/registered-harness.js';
import {
  blueprintRowId,
  connect,
  connectAsOwner,
  databaseUrl,
  endQuietly,
  expectCatalogErrorCode,
  randomTenantId,
  seedEntity,
  selectEntitySpecs,
  type TestDb,
} from './__fixtures__/blueprint-test-helpers.js';
import { onlySpan } from './__fixtures__/telemetry-assertions.js';
import type { CatalogContext } from '../domain/context.js';
import {
  createBlueprintService,
  type BlueprintService,
  type CreateBlueprintInput,
} from './blueprints.js';

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

const LANGUAGE_ONLY_SCHEMA = {
  properties: { language: { type: 'string', title: { en: 'Language' } } },
  required: [],
} as const;

interface SchemaIncompatibleViolation {
  readonly entityIdentifier: string;
}

describe('blueprints.update: safe schema evolution (task 7.4; design D7; spec "Safe blueprint schema evolution")', () => {
  let db: TestDb;
  let pool: TestDb['$client'];
  let harness: TelemetryTestHarness;
  let service: BlueprintService;

  beforeAll(async () => {
    // Raw seeding/introspection only (blueprintRowId, seedEntity,
    // selectEntitySpecs below run outside withTenantTransaction, with no
    // app.tenant_id session setting): the owner connection bypasses RLS,
    // task 6.3, design D6 Q1a.
    db = connectAsOwner(databaseUrl());
    await runMigrations(db.$client);
    // The service under test runs through the real tenant_isolation RLS
    // policy, exactly like production.
    pool = connect(databaseUrl()).$client;
    harness = registeredHarness();
    service = createBlueprintService({ pool, authz });
  }, 60_000);

  afterEach(async () => {
    await harness.reset();
  });

  afterAll(async () => {
    await harness.shutdown();
    await endQuietly(pool);
    await endQuietly(db.$client);
  }, 60_000);

  it('Adding an optional property is compatible', async () => {
    const tenantId = randomTenantId();
    const c = ctx(tenantId);
    await service.create(c, blueprintInput('service', { schema: LANGUAGE_ONLY_SCHEMA }));
    const blueprintId = await blueprintRowId(db, tenantId, 'service');

    const seededIdentifiers = ['e0', 'e1', 'e2', 'e3', 'e4'];
    for (const identifier of seededIdentifiers) {
      await seedEntity(db, tenantId, blueprintId, identifier, {
        specProperties: { language: 'go' },
      });
    }
    const before = await selectEntitySpecs(db, tenantId, blueprintId);
    expect(before).toHaveLength(5);

    const updated = await service.update(c, {
      identifier: 'service',
      title: { en: 'service' },
      schema: {
        properties: {
          language: { type: 'string', title: { en: 'Language' } },
          tier: { type: 'string', title: { en: 'Tier' } },
        },
        required: [],
      },
    });

    expect(updated.version).toBe(2);
    expect(Object.keys(updated.schema.properties).sort()).toEqual(['language', 'tier']);

    // "the existing entities are unchanged": the seeded rows are not
    // rewritten by a compatible update.
    const after = await selectEntitySpecs(db, tenantId, blueprintId);
    expect(after).toEqual(before);

    await harness.forceFlush();
    const span = onlySpan(harness.spanExporter, 'catalog.blueprint.compatibility_check');
    expect(span.attributes['tayzu.catalog.blueprint.identifier']).toBe('service');
    expect(span.attributes['tayzu.catalog.compatibility.entities_checked']).toBe(5);
    expect(
      span.attributes['tayzu.catalog.compatibility.violation.count'],
      'no violation.count attribute when the update is compatible',
    ).toBeUndefined();
  });

  it('Adding a required property without values is incompatible', async () => {
    const tenantId = randomTenantId();
    const c = ctx(tenantId);
    await service.create(c, blueprintInput('service', { schema: LANGUAGE_ONLY_SCHEMA }));
    const blueprintId = await blueprintRowId(db, tenantId, 'service');
    await seedEntity(db, tenantId, blueprintId, 'e1', { specProperties: { language: 'go' } });
    await seedEntity(db, tenantId, blueprintId, 'e2', { specProperties: { language: 'rust' } });

    const error = await expectCatalogErrorCode(
      service.update(c, {
        identifier: 'service',
        title: { en: 'service' },
        schema: {
          properties: {
            language: { type: 'string', title: { en: 'Language' } },
            tier: { type: 'string', title: { en: 'Tier' } },
          },
          required: ['tier'],
        },
      }),
      'CATALOG_SCHEMA_INCOMPATIBLE',
    );

    const violations = error.details?.['violations'] as
      readonly SchemaIncompatibleViolation[] | undefined;
    expect(violations?.map((violation) => violation.entityIdentifier).sort()).toEqual(['e1', 'e2']);

    // "the blueprint stays at its previous version"
    const stillCurrent = await service.get(c, { identifier: 'service' });
    expect(stillCurrent.version).toBe(1);
    expect(stillCurrent.schema.required).toEqual([]);
    expect(Object.keys(stillCurrent.schema.properties)).toEqual(['language']);

    await harness.forceFlush();
    const span = onlySpan(harness.spanExporter, 'catalog.blueprint.compatibility_check');
    expect(span.attributes['tayzu.catalog.blueprint.identifier']).toBe('service');
    expect(span.attributes['tayzu.catalog.compatibility.entities_checked']).toBe(2);
    expect(span.attributes['tayzu.catalog.compatibility.violation.count']).toBe(2);
  });

  it('Removing a property that has values is incompatible', async () => {
    const tenantId = randomTenantId();
    const c = ctx(tenantId);
    await service.create(c, blueprintInput('service', { schema: LANGUAGE_ONLY_SCHEMA }));
    const blueprintId = await blueprintRowId(db, tenantId, 'service');
    await seedEntity(db, tenantId, blueprintId, 'payments', { specProperties: { language: 'go' } });

    const error = await expectCatalogErrorCode(
      service.update(c, {
        identifier: 'service',
        title: { en: 'service' },
        schema: { properties: {}, required: [] },
      }),
      'CATALOG_SCHEMA_INCOMPATIBLE',
    );

    const violations = error.details?.['violations'] as
      readonly SchemaIncompatibleViolation[] | undefined;
    expect(violations?.map((violation) => violation.entityIdentifier)).toEqual(['payments']);
  });

  it('Stale expected version', async () => {
    const tenantId = randomTenantId();
    const c = ctx(tenantId);
    await service.create(c, blueprintInput('service'));
    await service.update(c, {
      identifier: 'service',
      title: { en: 'service' },
      schema: { properties: {}, required: [] },
    }); // version 2
    const atVersionThree = await service.update(c, {
      identifier: 'service',
      title: { en: 'service' },
      schema: { properties: {}, required: [] },
    }); // version 3
    expect(atVersionThree.version).toBe(3);

    await expectCatalogErrorCode(
      service.update(c, {
        identifier: 'service',
        title: { en: 'service' },
        schema: { properties: {}, required: [] },
        expectedVersion: 2,
      }),
      'CATALOG_VERSION_CONFLICT',
    );
  });
});
