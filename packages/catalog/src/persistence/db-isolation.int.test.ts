/**
 * Integration test for task 5.3 (design D4, D9; SSA finding "Composite FKs
 * that include tenant_id"). This is the database-level isolation guard: a
 * defense-in-depth layer that is independent of, and must hold even if, the
 * service layer (`persistence`/`service`) never gets written, or has a bug.
 *
 * It connects directly to the `DATABASE_URL` database used by the whole run
 * (no private scratch database: nothing here changes the schema, only rows,
 * and isolation is tenant-per-test per D12), applying `runMigrations` first
 * so the six D4 tables exist even if this is the only int file that runs.
 * Every insert below is a raw SQL statement through Drizzle's `sql` tag
 * (bind parameters only, `sql.raw` is banned by lint elsewhere in this
 * codebase and is not needed here), exactly like `schema.int.test.ts` and
 * `schema-hardening.int.test.ts` already do for the same tables.
 *
 * Red phase: `catalog_entity_relation_target_fk` (and the whole schema) is
 * already migrated (task 5.1 shipped it), so this file's raw-SQL assertions
 * do not fail on a missing table. This task's own Verify clause names no new
 * module to import; it is a pure integration/behavioral test of a constraint
 * that already exists in the migration. It is included in this batch because
 * `tasks.md` orders it right after 5.2 and before 5.4, and its two scenarios
 * are asserted directly against the running database with no production code
 * left to write.
 */
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { runMigrations } from '@tayzu/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim() === '') {
    throw new Error(
      'DATABASE_URL is not set: the int project global setup should have stopped this run.',
    );
  }
  return url;
}

function connect(url: string) {
  return drizzle(url);
}

type Db = ReturnType<typeof connect>;

/**
 * Ends a pool or client that is about to be torn down, with an 'error'
 * listener attached first. This file connects to the shared `DATABASE_URL`
 * database (no scratch database of its own to drop), but other int test
 * files in this same run do create and drop private scratch databases, and
 * `drop database ... with (force)` there can occasionally report SQLSTATE
 * 57P01 ("terminating connection due to administrator command") back to a
 * connection that is itself already mid-`.end()` (see
 * `schema-hardening.int.test.ts` for the mechanism). Without a listener, a
 * stray event like that on this file's own pool would be an unhandled
 * 'error' event, not something an assertion here could ever explain.
 */
async function endQuietly(closeable: {
  on(event: 'error', listener: (error: unknown) => void): unknown;
  end(): Promise<void>;
}): Promise<void> {
  closeable.on('error', () => {
    // Expected only during teardown; nothing left to report it to.
  });
  await closeable.end();
}

function randomTenantId(): string {
  return `t${randomUUID().replaceAll('-', '')}`;
}

interface PgError {
  readonly code?: string;
  readonly constraint?: string;
}

function hasStringCode(candidate: unknown): candidate is PgError {
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    'code' in candidate &&
    typeof (candidate as { code?: unknown }).code === 'string'
  );
}

// drizzle-orm wraps the driver's DatabaseError in a DrizzleQueryError: the
// real `code`/`constraint` from `pg` live on `error.cause`, not on the outer
// error. Unwrap `.cause` until an object with a string `code` is found (same
// approach as schema-hardening.int.test.ts).
function pgErrorOf(error: unknown): PgError {
  let candidate: unknown = error;
  while (candidate !== undefined && candidate !== null) {
    if (hasStringCode(candidate)) {
      return candidate;
    }
    candidate = candidate instanceof Error ? candidate.cause : undefined;
  }
  return {};
}

/** SQLSTATE for a foreign-key-constraint violation (design D9). */
const FK_VIOLATION_SQLSTATE = '23503';

interface BlueprintFixture {
  readonly tenantId: string;
  readonly blueprintId: string;
  readonly identifier: string;
}

async function insertBlueprint(db: Db, tenantId: string, identifier: string): Promise<BlueprintFixture> {
  const blueprintId = randomUUID();
  await db.execute(sql`
    insert into catalog_blueprint
      (id, tenant_id, identifier, title, schema, version,
       created_at, created_by_type, created_by_id, updated_at, updated_by_type, updated_by_id)
    values
      (${blueprintId}, ${tenantId}, ${identifier}, '{"en": "Title"}'::jsonb, '{}'::jsonb, 1,
       now(), 'system', 'sys', now(), 'system', 'sys')
  `);
  return { tenantId, blueprintId, identifier };
}

interface EntityFixture {
  readonly tenantId: string;
  readonly entityId: string;
  readonly identifier: string;
}

async function insertEntity(
  db: Db,
  blueprint: BlueprintFixture,
  identifier: string,
): Promise<EntityFixture> {
  const entityId = randomUUID();
  await db.execute(sql`
    insert into catalog_entity
      (id, tenant_id, blueprint_id, identifier, title, spec_properties, generation, version,
       created_at, created_by_type, created_by_id, updated_at, updated_by_type, updated_by_id)
    values
      (${entityId}, ${blueprint.tenantId}, ${blueprint.blueprintId}, ${identifier}, ${identifier}, '{}'::jsonb, 1, 1,
       now(), 'system', 'sys', now(), 'system', 'sys')
  `);
  return { tenantId: blueprint.tenantId, entityId, identifier };
}

async function insertRelationDefinition(
  db: Db,
  source: BlueprintFixture,
  target: BlueprintFixture,
  identifier: string,
): Promise<string> {
  const relationDefinitionId = randomUUID();
  await db.execute(sql`
    insert into catalog_relation_definition
      (id, tenant_id, source_blueprint_id, identifier, title, target_blueprint_id, many, required)
    values
      (${relationDefinitionId}, ${source.tenantId}, ${source.blueprintId}, ${identifier}, '{"en": "Rel"}'::jsonb,
       ${target.blueprintId}, false, false)
  `);
  return relationDefinitionId;
}

describe('database-level tenant isolation (design D4, D9): raw inserts, no service layer', () => {
  let db: Db;

  beforeAll(async () => {
    db = connect(databaseUrl());
    await runMigrations(db.$client);
  }, 60_000);

  afterAll(async () => {
    await endQuietly(db.$client);
  }, 60_000);

  it("creates two tenants' blueprints and entities with the same identifiers, with no collision", async () => {
    const tenantA = randomTenantId();
    const tenantB = randomTenantId();
    const sharedBlueprintIdentifier = 'app';
    const sharedEntityIdentifier = 'e1';

    const blueprintA = await insertBlueprint(db, tenantA, sharedBlueprintIdentifier);
    const blueprintB = await insertBlueprint(db, tenantB, sharedBlueprintIdentifier);
    const entityA = await insertEntity(db, blueprintA, sharedEntityIdentifier);
    const entityB = await insertEntity(db, blueprintB, sharedEntityIdentifier);

    const blueprintRows = await db.execute<{ tenant_id: string; identifier: string }>(sql`
      select tenant_id, identifier from catalog_blueprint where id in (${blueprintA.blueprintId}, ${blueprintB.blueprintId})
      order by tenant_id
    `);
    expect(blueprintRows.rows).toHaveLength(2);
    expect(new Set(blueprintRows.rows.map((row) => row.tenant_id))).toEqual(new Set([tenantA, tenantB]));
    for (const row of blueprintRows.rows) {
      expect(row.identifier).toBe(sharedBlueprintIdentifier);
    }

    const entityRows = await db.execute<{ tenant_id: string; identifier: string }>(sql`
      select tenant_id, identifier from catalog_entity where id in (${entityA.entityId}, ${entityB.entityId})
      order by tenant_id
    `);
    expect(entityRows.rows).toHaveLength(2);
    expect(new Set(entityRows.rows.map((row) => row.tenant_id))).toEqual(new Set([tenantA, tenantB]));
    for (const row of entityRows.rows) {
      expect(row.identifier).toBe(sharedEntityIdentifier);
    }
  });

  it('rejects a raw insert of a catalog_entity_relation edge whose target belongs to another tenant, with an FK violation on catalog_entity_relation_target_fk', async () => {
    const tenantA = randomTenantId();
    const tenantB = randomTenantId();

    const blueprintA = await insertBlueprint(db, tenantA, 'source-bp');
    const blueprintB = await insertBlueprint(db, tenantB, 'target-bp');
    const entityA = await insertEntity(db, blueprintA, 'source-entity');
    const entityB = await insertEntity(db, blueprintB, 'target-entity');
    const relationDefinitionId = await insertRelationDefinition(db, blueprintA, blueprintA, 'points-to');

    let caught: unknown;
    try {
      // The edge claims tenant A (matching its own source_entity_id and
      // relation_definition_id), but its target_entity_id belongs to tenant
      // B. The composite FK `(tenant_id, target_entity_id) -> catalog_entity
      // (tenant_id, id)` has no row `(tenantA, entityB.entityId)`, since
      // entityB's actual row is `(tenantB, entityB.entityId)`. This is exactly
      // the cross-tenant edge the composite FK exists to make impossible,
      // independent of any service-layer check (design D4, SEC03).
      await db.execute(sql`
        insert into catalog_entity_relation
          (tenant_id, source_entity_id, relation_definition_id, scope, target_entity_id, position)
        values
          (${tenantA}, ${entityA.entityId}, ${relationDefinitionId}, 'spec', ${entityB.entityId}, 0)
      `);
    } catch (error) {
      caught = error;
    }

    expect(caught, 'the cross-tenant edge insert must fail').toBeDefined();
    const pgError = pgErrorOf(caught);
    expect(pgError.code, 'SQLSTATE for the cross-tenant edge insert').toBe(FK_VIOLATION_SQLSTATE);
    expect(pgError.constraint, 'violated constraint name').toBe('catalog_entity_relation_target_fk');

    const edgeRows = await db.execute<{ target_entity_id: string }>(sql`
      select target_entity_id from catalog_entity_relation
       where tenant_id = ${tenantA} and source_entity_id = ${entityA.entityId}
    `);
    expect(edgeRows.rows, 'no edge row was persisted').toHaveLength(0);
  });
});
