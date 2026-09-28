/**
 * Shared test helpers for the blueprint-operation integration tests (tasks
 * 7.1-7.6, openspec/changes/archive/2026-09-28-001-catalog-core): `blueprints.int.test.ts`,
 * `blueprints-update.int.test.ts` and `isolation-blueprints.int.test.ts`. Not
 * a test file itself (no assertions run at import time), only connection,
 * seeding and error-assertion helpers.
 *
 * Entity rows are seeded with raw parameterized SQL directly into
 * `catalog_entity`, exactly like `persistence/db-isolation.int.test.ts`
 * already does for the same table (design D4's six tables, task 5.1):
 * entity *operations* (task 8.x) do not exist yet, but blueprint update
 * (task 7.4, design D7) and delete (task 7.5) both need pre-existing
 * entities to validate their compatibility and reference-violation rules
 * against.
 */
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { expect } from 'vitest';

import { isCatalogError, type CatalogError, type CatalogErrorCode } from '../../domain/errors.js';

/** Same fail-fast pattern as every other int test file in this package. */
export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim() === '') {
    throw new Error(
      'DATABASE_URL is not set: the int project global setup should have stopped this run.',
    );
  }
  return url;
}

export function connect(url: string): ReturnType<typeof drizzle> {
  return drizzle(url);
}

export type TestDb = ReturnType<typeof connect>;

/**
 * Ends a pool or client that is about to be torn down, with an 'error'
 * listener attached first (same rationale as `pipeline.int.test.ts` and
 * `persistence/db-isolation.int.test.ts`: a stray teardown-time event from
 * another int file's scratch database must never become an unhandled
 * 'error' event on this file's own connection).
 */
export async function endQuietly(closeable: {
  on(event: 'error', listener: (error: unknown) => void): unknown;
  end(): Promise<void>;
}): Promise<void> {
  closeable.on('error', () => {
    // Expected only during teardown; nothing left to report it to.
  });
  await closeable.end();
}

export function randomTenantId(): string {
  return `t${randomUUID().replaceAll('-', '')}`;
}

export function randomSuffix(): string {
  return randomUUID().replaceAll('-', '').slice(0, 8);
}

/**
 * Asserts that `promise` rejects with a `CatalogError` of exactly `code`,
 * and returns that error so a test can inspect `issues`/`details` further.
 * Never passes silently on a resolved promise: the "expected to reject"
 * assertion fails with an explicit message instead.
 */
export async function expectCatalogErrorCode(
  promise: Promise<unknown>,
  code: CatalogErrorCode,
): Promise<CatalogError> {
  const thrown: unknown = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(
    thrown,
    `expected the operation to reject with ${code}, but it did not reject`,
  ).toBeDefined();
  expect(isCatalogError(thrown), `expected a CatalogError, got ${String(thrown)}`).toBe(true);
  if (!isCatalogError(thrown)) {
    throw new Error('unreachable: isCatalogError was just asserted true');
  }
  expect(thrown.code).toBe(code);
  return thrown;
}

/**
 * The internal `catalog_blueprint.id` (uuid) for `identifier`, needed to
 * seed rows in tables that reference a blueprint by uuid rather than its
 * public identifier. The blueprint service (`./blueprints.js`) never
 * exposes this internal id, by design (design D11: the public shape has no
 * database-internal fields).
 */
export async function blueprintRowId(
  db: TestDb,
  tenantId: string,
  identifier: string,
): Promise<string> {
  const result = await db.execute<{ id: string }>(sql`
    select id from catalog_blueprint where tenant_id = ${tenantId} and identifier = ${identifier}
  `);
  const row = result.rows[0];
  if (!row) {
    throw new Error(`no catalog_blueprint row for tenant ${tenantId}, identifier ${identifier}`);
  }
  return row.id;
}

export interface SeedEntityOptions {
  readonly specProperties?: Record<string, unknown>;
}

/**
 * Seeds one `catalog_entity` row directly (entity operations, task 8.x, do
 * not exist yet). Returns the row's internal `id`.
 */
export async function seedEntity(
  db: TestDb,
  tenantId: string,
  blueprintId: string,
  identifier: string,
  options: SeedEntityOptions = {},
): Promise<string> {
  const entityId = randomUUID();
  const specProperties = JSON.stringify(options.specProperties ?? {});
  await db.execute(sql`
    insert into catalog_entity
      (id, tenant_id, blueprint_id, identifier, title, spec_properties, generation, version,
       created_at, created_by_type, created_by_id, updated_at, updated_by_type, updated_by_id)
    values
      (${entityId}, ${tenantId}, ${blueprintId}, ${identifier}, ${identifier}, ${specProperties}::jsonb, 1, 1,
       now(), 'system', 'sys', now(), 'system', 'sys')
  `);
  return entityId;
}

// A type literal (not an interface), so it satisfies `db.execute`'s
// `TRow extends Record<string, unknown>` constraint (TypeScript's implicit
// index signature applies to object type literals, not interfaces; see the
// same note in `persistence/change-events.int.test.ts` and
// `schema-hardening.int.test.ts`).
export type EntitySpecRow = {
  readonly identifier: string;
  readonly spec_properties: unknown;
  readonly version: number;
};

/** Every seeded entity row of one blueprint, ordered by identifier, for a before/after comparison. */
export async function selectEntitySpecs(
  db: TestDb,
  tenantId: string,
  blueprintId: string,
): Promise<EntitySpecRow[]> {
  const result = await db.execute<EntitySpecRow>(sql`
    select identifier, spec_properties, version
    from catalog_entity
    where tenant_id = ${tenantId} and blueprint_id = ${blueprintId}
    order by identifier
  `);
  return result.rows;
}

// A type literal, for the same reason as `EntitySpecRow` above.
export type ChangeEventRow = {
  readonly action: string;
  readonly resource_kind: string;
  readonly snapshot: unknown;
};

/** Every `catalog_change_event` row for one resource, ordered by `seq` (spec "Actor attribution and change events"). */
export async function selectChangeEvents(
  db: TestDb,
  tenantId: string,
  resourceIdentifier: string,
): Promise<ChangeEventRow[]> {
  const result = await db.execute<ChangeEventRow>(sql`
    select action, resource_kind, snapshot
    from catalog_change_event
    where tenant_id = ${tenantId} and resource_identifier = ${resourceIdentifier}
    order by seq
  `);
  return result.rows;
}
