/**
 * Integration tests for task 11.2's VCDM pre-assessment gap: the spec
 * Conventions' "Default limits" table row `| Pagination cursor | 512
 * characters |`, together with design D8's "Limits are checked before any
 * expensive work (schema compilation or database writes)".
 *
 * `domain/pagination.ts`'s `decodeCursor` and `entities.ts`'s own
 * `decodeRelatedCursor` never consult `CatalogLimits['cursor']['maxLength']`
 * at all -- `decodeCursor` does not even take a `limits` parameter, and
 * `decodeRelatedCursor` ignores the one the caller (`entities.ts`'s
 * `listRelated` handler) has in scope. Both go straight to
 * `Buffer.from(cursor, 'base64url')` / `JSON.parse`, for a cursor of any
 * length, and report a malformed result as `CATALOG_VALIDATION_FAILED`
 * regardless of why it was malformed.
 *
 * `blueprints.ts`'s `list`, `entities.ts`'s `list` and `entities.ts`'s
 * `listRelated` all decode `input.cursor` *before* touching the database
 * (right after the page-size limit check, before `findBlueprintIdByIdentifier`
 * ever runs), so an over-length cursor is exercised without needing any
 * blueprint or entity to exist first.
 *
 * A 513-character cursor MUST fail with `CATALOG_LIMIT_EXCEEDED` naming the
 * cursor limit (spec Conventions, "Error codes": "operations fail with one
 * of the stable codes ... Validation errors carry a list of ... issues";
 * design D8: exceeding a limit "-> `CATALOG_LIMIT_EXCEEDED` naming the
 * limit"). Today it instead falls straight through to `decodeCursor`/
 * `decodeRelatedCursor`, which -- for a garbage, non-base64url-JSON payload
 * -- rejects it as a malformed cursor, `CATALOG_VALIDATION_FAILED`, the
 * wrong code.
 *
 * A 512-character cursor (at the limit, so a future length check must let it
 * through) that is equally malformed MUST still fail, but with
 * `CATALOG_VALIDATION_FAILED` (an invalid cursor, not an oversized one) --
 * proving the length check runs *before* decoding rather than instead of it.
 * Both the 512- and the 513-character cursor below share the exact same
 * malformed content (`'a'.repeat(n)`), so the *only* variable between them is
 * length: today, with no length check at all, both already report
 * `CATALOG_VALIDATION_FAILED` (the 512-character case already matches the
 * spec; the 513-character case does not).
 *
 * Same connection, harness and helper-reuse pattern as
 * `blueprints.int.test.ts` and `entities.int.test.ts`.
 * `./__fixtures__/registered-harness.js` is imported first for the same
 * import-order reason as every other int test in this package (design D1).
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
  type TestDb,
} from './__fixtures__/blueprint-test-helpers.js';
import { ctx } from './__fixtures__/entity-a-test-helpers.js';
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

/** spec Conventions, "Default limits": "Pagination cursor | 512 characters". */
const CURSOR_MAX_LENGTH = 512;
/** Malformed (not valid base64url-encoded JSON), but its only relevant property here is its length. */
const cursorOfLength = (length: number): string => 'a'.repeat(length);

describe('Pagination cursor length limit is checked before decoding (spec Conventions, "Default limits"; design D8; task 11.2)', () => {
  let pool: TestDb['$client'];
  let harness: TelemetryTestHarness;
  let blueprints: BlueprintService;
  let entities: EntityService;

  beforeAll(async () => {
    const db = connect(databaseUrl());
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

  describe('blueprints.list', () => {
    it('rejects a 513-character cursor with CATALOG_LIMIT_EXCEEDED naming the cursor limit', async () => {
      const tenantId = randomTenantId();
      const error = await expectCatalogErrorCode(
        blueprints.list(ctx(tenantId), { cursor: cursorOfLength(CURSOR_MAX_LENGTH + 1) }),
        'CATALOG_LIMIT_EXCEEDED',
      );
      expect(error.details?.['limit']).toBe('cursor.maxLength');
    });

    it('rejects a 512-character (well-formed-length but invalid) cursor with CATALOG_VALIDATION_FAILED', async () => {
      const tenantId = randomTenantId();
      await expectCatalogErrorCode(
        blueprints.list(ctx(tenantId), { cursor: cursorOfLength(CURSOR_MAX_LENGTH) }),
        'CATALOG_VALIDATION_FAILED',
      );
    });
  });

  describe('entities.list', () => {
    it('rejects a 513-character cursor with CATALOG_LIMIT_EXCEEDED naming the cursor limit', async () => {
      const tenantId = randomTenantId();
      const error = await expectCatalogErrorCode(
        entities.list(ctx(tenantId), { blueprint: 'service', cursor: cursorOfLength(CURSOR_MAX_LENGTH + 1) }),
        'CATALOG_LIMIT_EXCEEDED',
      );
      expect(error.details?.['limit']).toBe('cursor.maxLength');
    });

    it('rejects a 512-character (well-formed-length but invalid) cursor with CATALOG_VALIDATION_FAILED', async () => {
      const tenantId = randomTenantId();
      await expectCatalogErrorCode(
        entities.list(ctx(tenantId), { blueprint: 'service', cursor: cursorOfLength(CURSOR_MAX_LENGTH) }),
        'CATALOG_VALIDATION_FAILED',
      );
    });
  });

  describe('entities.listRelated', () => {
    it('rejects a 513-character cursor with CATALOG_LIMIT_EXCEEDED naming the cursor limit', async () => {
      const tenantId = randomTenantId();
      const error = await expectCatalogErrorCode(
        entities.listRelated(ctx(tenantId), {
          blueprint: 'service',
          identifier: 'svc-1',
          direction: 'forward',
          cursor: cursorOfLength(CURSOR_MAX_LENGTH + 1),
        }),
        'CATALOG_LIMIT_EXCEEDED',
      );
      expect(error.details?.['limit']).toBe('cursor.maxLength');
    });

    it('rejects a 512-character (well-formed-length but invalid) cursor with CATALOG_VALIDATION_FAILED', async () => {
      const tenantId = randomTenantId();
      await expectCatalogErrorCode(
        entities.listRelated(ctx(tenantId), {
          blueprint: 'service',
          identifier: 'svc-1',
          direction: 'forward',
          cursor: cursorOfLength(CURSOR_MAX_LENGTH),
        }),
        'CATALOG_VALIDATION_FAILED',
      );
    });
  });
});
