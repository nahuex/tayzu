/**
 * Integration test for the task 11.3 `/security-review` finding:
 * `domain/safe-parse.ts`'s `walk` never advances `depth` for the array
 * branch, so a deeply nested array value never trips the nesting-depth
 * limit (spec Conventions, "Default limits": "Nesting depth of `object`
 * values | 16") and instead overflows the call stack
 * (`RangeError: Maximum call stack size exceeded`) -- see
 * `domain/safe-parse-arrays.test.ts` for the pure-unit coverage of
 * `parseSafeInput` itself.
 *
 * This file exercises the real, unguarded surface end to end:
 * `entities.ts`'s `create` handler calls `parseSafeEntityInput` (which wraps
 * `parseSafeInput`) on the raw input *before* `assertEntitySpecSize` or any
 * other limit check runs, so a small (a few KB), deeply nested array value
 * stored under an `object`-typed spec property reaches `parseSafeInput`
 * unfiltered by any earlier size check. The write MUST fail with
 * `CatalogError` `CATALOG_LIMIT_EXCEEDED`, exactly the way an equally deep
 * chain of nested plain objects already does, and MUST NOT crash the
 * request with an uncaught `RangeError` -- and it MUST persist nothing: no
 * entity row and no change event.
 *
 * Same connection, harness and helper-reuse pattern as
 * `unsafe-keys.int.test.ts` and `cursor-limit.int.test.ts`.
 * `./__fixtures__/registered-harness.js` is imported first for the same
 * import-order reason as every other int test in this package (design D1).
 */
import { authz } from './__fixtures__/authz-test-helpers.js';
import { runMigrations } from '@tayzu/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// Import order is load-bearing: see the module doc comment above.
import { registration, type TelemetryTestHarness } from './__fixtures__/registered-harness.js';
import {
  connect,
  connectAsOwner,
  databaseUrl,
  endQuietly,
  expectCatalogErrorCode,
  randomTenantId,
  selectChangeEvents,
  type TestDb,
} from './__fixtures__/blueprint-test-helpers.js';
import { blueprintInput, ctx, entityInput } from './__fixtures__/entity-a-test-helpers.js';
import {
  createBlueprintService,
  type BlueprintService,
  type CreateBlueprintInput,
} from './blueprints.js';
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

/** A blueprint with one `object`-typed spec property, no relations declared. */
function blueprintWithObjectProperty(identifier: string): CreateBlueprintInput {
  return blueprintInput(identifier, {
    schema: {
      properties: { metadata: { type: 'object', title: { en: 'Metadata' } } },
      required: [],
    },
  });
}

/**
 * Wraps `'leaf'` in `depth` nested one-element arrays, built with a loop
 * (never a recursive helper -- a recursive builder for 50000 levels would
 * itself overflow the stack before `entities.create` is ever called). The
 * serialized result is only a few KB, well under the 256 KiB entity-spec
 * size limit, so the array-nesting bug is what fails the write, not the
 * unrelated byte-size limit.
 */
function buildNestedArray(depth: number): unknown {
  let value: unknown = 'leaf';
  for (let i = 0; i < depth; i += 1) {
    value = [value];
  }
  return value;
}

describe('entities.create rejects a deeply nested array inside an object-typed property (spec Conventions, "Default limits"; design D8; task 11.3)', () => {
  let db: TestDb;
  let pool: TestDb['$client'];
  let harness: TelemetryTestHarness;
  let blueprints: BlueprintService;
  let entities: EntityService;

  beforeAll(async () => {
    // Raw introspection only (selectChangeEvents below runs outside
    // withTenantTransaction, with no app.tenant_id session setting): the
    // owner connection bypasses RLS, task 6.3, design D6 Q1a.
    db = connectAsOwner(databaseUrl());
    await runMigrations(db.$client);
    // The services under test run through the real tenant_isolation RLS
    // policy, exactly like production.
    pool = connect(databaseUrl()).$client;
    harness = registeredHarness();
    blueprints = createBlueprintService({ pool, authz });
    entities = createEntityService({ pool, authz });
  }, 60_000);

  afterEach(async () => {
    await harness.reset();
  });

  afterAll(async () => {
    await harness.shutdown();
    await endQuietly(pool);
    await endQuietly(db.$client);
  }, 60_000);

  it('fails with CATALOG_LIMIT_EXCEEDED for a 50000-level nested array under an object-typed property, and persists nothing', async () => {
    const tenantId = randomTenantId();
    const c = ctx(tenantId);
    await blueprints.create(c, blueprintWithObjectProperty('service'));

    const deeplyNestedArray = buildNestedArray(50_000);

    await expectCatalogErrorCode(
      entities.create(
        c,
        entityInput('service', 'svc-deep-array', {
          spec: { properties: { metadata: deeplyNestedArray }, relations: {} },
        }),
      ),
      'CATALOG_LIMIT_EXCEEDED',
    );

    await expectCatalogErrorCode(
      entities.get(c, { blueprint: 'service', identifier: 'svc-deep-array' }),
      'CATALOG_NOT_FOUND',
    );
    expect(await selectChangeEvents(db, tenantId, 'svc-deep-array')).toHaveLength(0);
  });
});
