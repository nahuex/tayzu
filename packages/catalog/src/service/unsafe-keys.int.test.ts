/**
 * Integration tests for task 11.2's VCDM pre-assessment gap: the spec
 * Conventions' "Unsafe keys" rule --
 *
 * > the keys `__proto__`, `constructor` and `prototype` are rejected with
 * > `CATALOG_VALIDATION_FAILED` in every key position of catalog input. This
 * > includes identifiers, property and relation keys, locale keys, and keys
 * > nested inside `object`-typed values.
 *
 * (spec "Unsafe keys are rejected") -- is fully unit-tested for the pure
 * helper `domain/safe-parse.ts`'s `parseSafeInput` (`domain/safe-parse.test.ts`),
 * but `parseSafeInput` is never imported by `./entities.ts`, `./blueprints.ts`
 * or `./pipeline.ts`: `grep -rn parseSafeInput src` outside `domain/` and its
 * own test returns nothing. The real write paths never call it, so the rule
 * is unenforced end to end through the actual services, exactly the "domain
 * helper exists but production code never calls it" shape a VCDM
 * pre-assessment looks for.
 *
 * This file exercises the two concrete unguarded surfaces the real services
 * leave open:
 *
 * - `domain/entity-validator.ts`'s Ajv schema for an `object`-typed property
 *   is bare `{ type: 'object' }` (ADR-0008: "Its keys and values are not
 *   validated beyond the size limit"), and its own `cloneAsNullPrototype`
 *   only rebuilds the *top-level* properties bag as null-prototype -- a key
 *   nested one level deeper inside an `object`-typed value is never walked,
 *   so `__proto__`/`constructor`/`prototype` nested inside such a value
 *   sails through create, upsert (replace and merge) and writeStatus
 *   entirely unvalidated.
 * - `domain/relation-values.ts`'s `validateRelationValues` decides whether a
 *   relation name is declared with `!(name in definitions)`, where
 *   `definitions` (built by `entities.ts`'s `loadEntityRelationDefinitions`)
 *   is a plain object literal, not a null-prototype one. `constructor` and
 *   `__proto__` are therefore always considered "declared" (`in` walks the
 *   prototype chain, and both names exist on `Object.prototype`), so a
 *   `spec.relations`/`status.relations` bag carrying either name as an own
 *   key is silently dropped instead of rejected with
 *   `CATALOG_VALIDATION_FAILED` (`prototype` is unaffected: plain objects
 *   inherit no such property, so that name is already rejected correctly).
 *
 * It also covers the still-open blueprint-definition surface the Conventions
 * text names explicitly ("property and relation keys"):
 * `domain/identifiers.ts`'s `parsePropertyIdentifier`/`parseRelationIdentifier`
 * check only the character-class pattern, never `UNSAFE_KEYS` -- unlike its
 * own `parseEntityIdentifier`, whose doc comment says identifiers are
 * "explicitly rejected when they equal an unsafe key, since the character
 * class alone would otherwise allow `__proto__`". `constructor` and
 * `prototype` are both valid `NAME_IDENTIFIER_PATTERN` matches (all-letter,
 * <=64 chars), so a blueprint can currently declare a schema property or a
 * relation literally named `constructor` or `prototype`.
 *
 * Every malicious payload that needs a literal `__proto__`/`constructor`/
 * `prototype` key as an *own* data property is built with `JSON.parse`,
 * which (unlike an object literal) never special-cases `__proto__`
 * (`domain/safe-parse.test.ts`'s own convention). A plain object literal
 * with a `constructor`/`prototype` key (for the blueprint-identifier tests
 * below) already creates a genuine own property -- only `__proto__` needs
 * the `JSON.parse` trick.
 *
 * Same connection, harness and helper-reuse pattern as `entities.int.test.ts`
 * and `entity-status.int.test.ts`: every blueprint is created through the
 * real `createBlueprintService`, every entity through the real
 * `createEntityService`, never raw SQL. `./__fixtures__/registered-harness.js`
 * is imported first for the same import-order reason as every other int test
 * in this package (design D1).
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
import { createBlueprintService, type BlueprintService, type CreateBlueprintInput } from './blueprints.js';
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

/** A blueprint with one `object`-typed spec property and one `object`-typed status property, no relations declared. */
function blueprintWithObjectProperties(identifier: string): CreateBlueprintInput {
  return blueprintInput(identifier, {
    schema: { properties: { metadata: { type: 'object', title: { en: 'Metadata' } } }, required: [] },
    statusSchema: { properties: { observed: { type: 'object', title: { en: 'Observed' } } }, required: [] },
  });
}

/** Asserts the global prototype was never polluted by the attempted write above. */
function expectNoGlobalPollution(): void {
  expect(Object.prototype).not.toHaveProperty('polluted');
  expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
}

describe('Unsafe keys are rejected through the real services (spec Conventions, "Unsafe keys"; task 11.2)', () => {
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
    // Defensive cleanup: if a buggy implementation under test really
    // polluted the global prototype, do not let it leak into other tests.
    delete (Object.prototype as Record<string, unknown>)['polluted'];
  });

  afterAll(async () => {
    await harness.shutdown();
    await endQuietly(pool);
  }, 60_000);

  describe('entities.create', () => {
    it('rejects a __proto__ key nested inside an object-typed spec property value, and persists nothing', async () => {
      const tenantId = randomTenantId();
      const c = ctx(tenantId);
      await blueprints.create(c, blueprintWithObjectProperties('service'));

      const maliciousProperties = JSON.parse(
        '{"metadata":{"a":{"__proto__":{"polluted":true}}}}',
      ) as Record<string, unknown>;

      await expectCatalogErrorCode(
        entities.create(c, entityInput('service', 'svc-proto', { spec: { properties: maliciousProperties, relations: {} } })),
        'CATALOG_VALIDATION_FAILED',
      );

      await expectCatalogErrorCode(entities.get(c, { blueprint: 'service', identifier: 'svc-proto' }), 'CATALOG_NOT_FOUND');
      expect(await selectChangeEvents(db, tenantId, 'svc-proto')).toHaveLength(0);
      expectNoGlobalPollution();
    });

    it('rejects a constructor key nested inside an object-typed spec property value, and persists nothing', async () => {
      const tenantId = randomTenantId();
      const c = ctx(tenantId);
      await blueprints.create(c, blueprintWithObjectProperties('service'));

      const maliciousProperties = JSON.parse(
        '{"metadata":{"a":{"constructor":{"polluted":true}}}}',
      ) as Record<string, unknown>;

      await expectCatalogErrorCode(
        entities.create(c, entityInput('service', 'svc-ctor', { spec: { properties: maliciousProperties, relations: {} } })),
        'CATALOG_VALIDATION_FAILED',
      );

      await expectCatalogErrorCode(entities.get(c, { blueprint: 'service', identifier: 'svc-ctor' }), 'CATALOG_NOT_FOUND');
      expect(await selectChangeEvents(db, tenantId, 'svc-ctor')).toHaveLength(0);
      expectNoGlobalPollution();
    });

    it('rejects a prototype key nested inside an object-typed spec property value, and persists nothing', async () => {
      const tenantId = randomTenantId();
      const c = ctx(tenantId);
      await blueprints.create(c, blueprintWithObjectProperties('service'));

      const maliciousProperties = JSON.parse(
        '{"metadata":{"a":{"prototype":{"polluted":true}}}}',
      ) as Record<string, unknown>;

      await expectCatalogErrorCode(
        entities.create(c, entityInput('service', 'svc-proto2', { spec: { properties: maliciousProperties, relations: {} } })),
        'CATALOG_VALIDATION_FAILED',
      );

      await expectCatalogErrorCode(entities.get(c, { blueprint: 'service', identifier: 'svc-proto2' }), 'CATALOG_NOT_FOUND');
      expect(await selectChangeEvents(db, tenantId, 'svc-proto2')).toHaveLength(0);
      expectNoGlobalPollution();
    });

    it('rejects a constructor key used directly as a spec.relations key, and persists nothing', async () => {
      const tenantId = randomTenantId();
      const c = ctx(tenantId);
      await blueprints.create(c, blueprintWithObjectProperties('service'));

      const maliciousRelations = JSON.parse('{"constructor":"does-not-exist"}') as Record<string, unknown>;

      await expectCatalogErrorCode(
        entities.create(c, entityInput('service', 'svc-rel-ctor', { spec: { properties: {}, relations: maliciousRelations } })),
        'CATALOG_VALIDATION_FAILED',
      );

      await expectCatalogErrorCode(entities.get(c, { blueprint: 'service', identifier: 'svc-rel-ctor' }), 'CATALOG_NOT_FOUND');
      expect(await selectChangeEvents(db, tenantId, 'svc-rel-ctor')).toHaveLength(0);
      expectNoGlobalPollution();
    });

    it('rejects a __proto__ key used directly as a spec.relations key, and persists nothing', async () => {
      const tenantId = randomTenantId();
      const c = ctx(tenantId);
      await blueprints.create(c, blueprintWithObjectProperties('service'));

      const maliciousRelations = JSON.parse('{"__proto__":"does-not-exist"}') as Record<string, unknown>;

      await expectCatalogErrorCode(
        entities.create(c, entityInput('service', 'svc-rel-proto', { spec: { properties: {}, relations: maliciousRelations } })),
        'CATALOG_VALIDATION_FAILED',
      );

      await expectCatalogErrorCode(entities.get(c, { blueprint: 'service', identifier: 'svc-rel-proto' }), 'CATALOG_NOT_FOUND');
      expect(await selectChangeEvents(db, tenantId, 'svc-rel-proto')).toHaveLength(0);
      expectNoGlobalPollution();
    });
  });

  describe('entities.upsert (replace)', () => {
    it('rejects a __proto__ key nested inside an object-typed spec property value, and leaves the entity unchanged', async () => {
      const tenantId = randomTenantId();
      const c = ctx(tenantId);
      await blueprints.create(c, blueprintWithObjectProperties('service'));
      const created = await entities.create(
        c,
        entityInput('service', 'svc-upsert-replace', { spec: { properties: { metadata: { safe: true } }, relations: {} } }),
      );

      const maliciousProperties = JSON.parse(
        '{"metadata":{"a":{"__proto__":{"polluted":true}}}}',
      ) as Record<string, unknown>;

      await expectCatalogErrorCode(
        entities.upsert(c, {
          ...entityInput('service', 'svc-upsert-replace'),
          mode: 'replace',
          spec: { properties: maliciousProperties, relations: {} },
        }),
        'CATALOG_VALIDATION_FAILED',
      );

      const after = await entities.get(c, { blueprint: 'service', identifier: 'svc-upsert-replace' });
      expect(after.version).toBe(created.version);
      expect(after.spec.properties).toEqual({ metadata: { safe: true } });
      expect(await selectChangeEvents(db, tenantId, 'svc-upsert-replace')).toHaveLength(1);
      expectNoGlobalPollution();
    });
  });

  describe('entities.upsert (merge)', () => {
    it('rejects a constructor key nested inside an object-typed spec property value, and leaves the entity unchanged', async () => {
      const tenantId = randomTenantId();
      const c = ctx(tenantId);
      await blueprints.create(c, blueprintWithObjectProperties('service'));
      const created = await entities.create(
        c,
        entityInput('service', 'svc-upsert-merge', { spec: { properties: { metadata: { safe: true } }, relations: {} } }),
      );

      const maliciousProperties = JSON.parse(
        '{"metadata":{"a":{"constructor":{"polluted":true}}}}',
      ) as Record<string, unknown>;

      await expectCatalogErrorCode(
        entities.upsert(c, {
          ...entityInput('service', 'svc-upsert-merge'),
          mode: 'merge',
          spec: { properties: maliciousProperties, relations: {} },
        }),
        'CATALOG_VALIDATION_FAILED',
      );

      const after = await entities.get(c, { blueprint: 'service', identifier: 'svc-upsert-merge' });
      expect(after.version).toBe(created.version);
      expect(after.spec.properties).toEqual({ metadata: { safe: true } });
      expect(await selectChangeEvents(db, tenantId, 'svc-upsert-merge')).toHaveLength(1);
      expectNoGlobalPollution();
    });
  });

  describe('entities.writeStatus', () => {
    it('rejects a prototype key nested inside an object-typed status property value, and leaves status unchanged', async () => {
      const tenantId = randomTenantId();
      const c = ctx(tenantId);
      await blueprints.create(c, blueprintWithObjectProperties('service'));
      const created = await entities.create(c, entityInput('service', 'svc-status-proto'));

      const maliciousStatusProperties = JSON.parse(
        '{"observed":{"a":{"prototype":{"polluted":true}}}}',
      ) as Record<string, unknown>;

      await expectCatalogErrorCode(
        entities.writeStatus(c, {
          blueprint: 'service',
          identifier: 'svc-status-proto',
          properties: maliciousStatusProperties,
          observedGeneration: 1,
          source: 'github',
        }),
        'CATALOG_VALIDATION_FAILED',
      );

      const after = await entities.get(c, { blueprint: 'service', identifier: 'svc-status-proto' });
      expect(after.status).toBeNull();
      expect(after.version).toBe(created.version);
      expect(await selectChangeEvents(db, tenantId, 'svc-status-proto')).toHaveLength(1);
      expectNoGlobalPollution();
    });

    it('rejects a constructor key used directly as a status.relations key, and leaves status unchanged', async () => {
      const tenantId = randomTenantId();
      const c = ctx(tenantId);
      await blueprints.create(c, blueprintWithObjectProperties('service'));
      const created = await entities.create(c, entityInput('service', 'svc-status-rel-ctor'));

      const maliciousStatusRelations = JSON.parse('{"constructor":"does-not-exist"}') as Record<string, unknown>;

      await expectCatalogErrorCode(
        entities.writeStatus(c, {
          blueprint: 'service',
          identifier: 'svc-status-rel-ctor',
          relations: maliciousStatusRelations,
          observedGeneration: 1,
          source: 'github',
        }),
        'CATALOG_VALIDATION_FAILED',
      );

      const after = await entities.get(c, { blueprint: 'service', identifier: 'svc-status-rel-ctor' });
      expect(after.status).toBeNull();
      expect(after.version).toBe(created.version);
      expect(await selectChangeEvents(db, tenantId, 'svc-status-rel-ctor')).toHaveLength(1);
      expectNoGlobalPollution();
    });
  });

  describe('blueprints.create: unsafe schema/relation identifiers', () => {
    it('rejects a schema property identifier equal to the unsafe key "constructor"', async () => {
      const tenantId = randomTenantId();
      const c = ctx(tenantId);
      const input = blueprintInput('service', {
        schema: { properties: { constructor: { type: 'string', title: { en: 'x' } } }, required: [] },
      });

      await expectCatalogErrorCode(blueprints.create(c, input), 'CATALOG_VALIDATION_FAILED');

      await expectCatalogErrorCode(blueprints.get(c, { identifier: 'service' }), 'CATALOG_NOT_FOUND');
      expect(await selectChangeEvents(db, tenantId, 'service')).toHaveLength(0);
      expectNoGlobalPollution();
    });

    it('rejects a relation identifier equal to the unsafe key "prototype"', async () => {
      const tenantId = randomTenantId();
      const c = ctx(tenantId);
      const input = blueprintInput('service', {
        relations: { prototype: { title: { en: 'x' }, target: 'service' } },
      });

      await expectCatalogErrorCode(blueprints.create(c, input), 'CATALOG_VALIDATION_FAILED');

      await expectCatalogErrorCode(blueprints.get(c, { identifier: 'service' }), 'CATALOG_NOT_FOUND');
      expect(await selectChangeEvents(db, tenantId, 'service')).toHaveLength(0);
      expectNoGlobalPollution();
    });
  });

  describe('blueprints.update: unsafe schema identifiers', () => {
    it('rejects a schema property identifier equal to the unsafe key "constructor", and leaves the blueprint unchanged', async () => {
      const tenantId = randomTenantId();
      const c = ctx(tenantId);
      const created = await blueprints.create(c, blueprintInput('service'));

      const badUpdate = blueprintInput('service', {
        schema: { properties: { constructor: { type: 'string', title: { en: 'x' } } }, required: [] },
      });

      await expectCatalogErrorCode(blueprints.update(c, badUpdate), 'CATALOG_VALIDATION_FAILED');

      const after = await blueprints.get(c, { identifier: 'service' });
      expect(after.version).toBe(created.version);
      expectNoGlobalPollution();
    });
  });
});
