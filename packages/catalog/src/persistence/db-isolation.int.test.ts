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
import { runMigrations, withTenantTransaction } from '@tayzu/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Task 6.4 (design D6): the `tayzu_app`-role pool this package's own service
// tests already use, aliased so it never collides with this file's own,
// pre-existing `connect()` (the owner/`DATABASE_URL`-role connection above,
// used only for setup below, exactly as that helper's own module doc
// prescribes — task 6.3, design D6 Resolved decision Q1a).
import { connect as connectAppRole } from '../service/__fixtures__/blueprint-test-helpers.js';

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

/**
 * SQLSTATE Postgres raises for a privilege violation (design D6, task 6.4):
 * an `UPDATE`/`DELETE`/`TRUNCATE` the runtime role has no grant for, or a
 * `SET ROLE` to a role it is not a member of.
 */
const INSUFFICIENT_PRIVILEGE_SQLSTATE = '42501';

interface BlueprintFixture {
  readonly tenantId: string;
  readonly blueprintId: string;
  readonly identifier: string;
}

async function insertBlueprint(
  db: Db,
  tenantId: string,
  identifier: string,
): Promise<BlueprintFixture> {
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
    // Connects directly as the DATABASE_URL role (bypasses RLS: superuser in
    // CI, BYPASSRLS in the sandbox) for the raw, cross-tenant FK-violation
    // checks below — the same role @tayzu/db's own getOwnerPool() names (task
    // 6.3, design D6 Q1a), not reachable here across the package's export
    // boundary.
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
    expect(new Set(blueprintRows.rows.map((row) => row.tenant_id))).toEqual(
      new Set([tenantA, tenantB]),
    );
    for (const row of blueprintRows.rows) {
      expect(row.identifier).toBe(sharedBlueprintIdentifier);
    }

    const entityRows = await db.execute<{ tenant_id: string; identifier: string }>(sql`
      select tenant_id, identifier from catalog_entity where id in (${entityA.entityId}, ${entityB.entityId})
      order by tenant_id
    `);
    expect(entityRows.rows).toHaveLength(2);
    expect(new Set(entityRows.rows.map((row) => row.tenant_id))).toEqual(
      new Set([tenantA, tenantB]),
    );
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
    const relationDefinitionId = await insertRelationDefinition(
      db,
      blueprintA,
      blueprintA,
      'points-to',
    );

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
    expect(pgError.constraint, 'violated constraint name').toBe(
      'catalog_entity_relation_target_fk',
    );

    const edgeRows = await db.execute<{ target_entity_id: string }>(sql`
      select target_entity_id from catalog_entity_relation
       where tenant_id = ${tenantA} and source_entity_id = ${entityA.entityId}
    `);
    expect(edgeRows.rows, 'no edge row was persisted').toHaveLength(0);
  });
});

/**
 * Task 6.4 (design D6; spec "Tenant isolation is enforced by the database
 * independent of application code"). The two remaining 6.4 scenarios this
 * file's own Verify clause names, plus the negative-control assertion, all
 * exercised against the real, running database — no service layer, no mocked
 * Cerbos, nothing but Postgres's own privilege and RLS enforcement.
 *
 * `connectAppRole()` (imported above from this package's own
 * `service/__fixtures__/blueprint-test-helpers.ts`) is used for every
 * runtime-role check below: it runs `SET ROLE tayzu_app` on every connection
 * it opens, so `current_user` really is `tayzu_app`, exactly like production
 * (task 6.3, design D6 Resolved decision Q1a). The suite above's own `db`
 * (the raw `DATABASE_URL`/owner connection, bypassing RLS) is reused only for
 * the one setup step ("Runtime role cannot bypass row-level security" needs a
 * `t2` row seeded outside any tenant context) — never for a runtime-role
 * assertion itself.
 */
describe('Postgres-enforced isolation and privilege boundaries (task 6.4, design D6)', () => {
  let db: Db;

  beforeAll(async () => {
    // Same owner/raw connection the suite above already established
    // (bypasses RLS: superuser in CI, BYPASSRLS in the sandbox), reused here
    // only to seed the cross-tenant row the RLS-bypass scenario below reads
    // back against — never for a runtime-role assertion itself.
    db = connect(databaseUrl());
    await runMigrations(db.$client);
  }, 60_000);

  afterAll(async () => {
    await endQuietly(db.$client);
  }, 60_000);

  it('Runtime role cannot alter the change-event log', async () => {
    const appPool = connectAppRole(databaseUrl()).$client;
    try {
      for (const statement of [
        'update catalog_change_event set action = action where false',
        'delete from catalog_change_event where false',
        'truncate catalog_change_event',
      ]) {
        let caught: unknown;
        try {
          await appPool.query(statement);
        } catch (error) {
          caught = error;
        }
        expect(
          caught,
          `expected "${statement}" to be rejected on privilege grounds, but it did not raise`,
        ).toBeDefined();
        const pgError = pgErrorOf(caught);
        expect(pgError.code, `SQLSTATE for "${statement}"`).toBe(INSUFFICIENT_PRIVILEGE_SQLSTATE);
      }
    } finally {
      await endQuietly(appPool);
    }
  });

  it('Runtime role cannot bypass row-level security', async () => {
    const tenantA = randomTenantId();
    const tenantB = randomTenantId();
    // Setup only, through the owner connection: a row that belongs to tenant
    // B, seeded with no tenant context needed (the owner bypasses RLS).
    const blueprintB = await insertBlueprint(db, tenantB, 'other-tenant-blueprint');

    const appPool = connectAppRole(databaseUrl()).$client;
    try {
      // The runtime role, with app.tenant_id set to tenant A
      // (withTenantTransaction, production's own tenant seam, design D5),
      // running a query with no tenant_id predicate of its own: RLS alone
      // must be the thing filtering tenant B's row out.
      const rows = await withTenantTransaction(appPool, { tenantId: tenantA }, async (client) => {
        const result = await client.query<{ id: string }>('select id from catalog_blueprint');
        return result.rows;
      });

      expect(
        rows.some((row) => row.id === blueprintB.blueprintId),
        "tenant B's row must not be returned while app.tenant_id is set to tenant A, even with no tenant_id predicate of its own",
      ).toBe(false);
    } finally {
      await endQuietly(appPool);
    }
  });

  it('negative control: tayzu_migrator is reachable from no runtime code path', async () => {
    // tayzu_app (the role every production connection, and every runtime-role
    // check above, actually runs as) must hold no membership, direct or
    // indirect, in tayzu_migrator: that membership is the one thing that
    // would let a `SET ROLE`, or ordinary privilege inheritance, reach it from
    // a running application connection. 0006_catalog_role_grants.sql grants
    // tayzu_app nothing on tayzu_migrator, and no runtime code path this
    // package or `@tayzu/db`'s own production export (`./index.ts`) exposes
    // ever names tayzu_migrator at all.
    //
    // Checked as a plain `pg_has_role` catalog lookup, through the owner
    // connection (introspection, not a runtime-role action), rather than by
    // literally attempting `SET ROLE tayzu_migrator` from a live connection:
    // Postgres's own `SET ROLE` permission check is keyed to the
    // *session_user* of the physical connection (the login role that
    // authenticated it), not to whatever role a prior `SET ROLE` switched the
    // session to. Every connection this whole test run opens authenticates as
    // one shared sandbox/CI login role (`DATABASE_URL`), and `@tayzu/db`'s own
    // test-only harness bootstrap (`packages/db/src/harness.ts`, a distinct
    // package's test fixture, not reachable from this package — see
    // `service/__fixtures__/blueprint-test-helpers.ts`'s own module doc)
    // separately grants that shared login role membership in tayzu_migrator
    // for its own, unrelated purpose (running migrations as it). A literal
    // `SET ROLE tayzu_migrator` attempted here would therefore succeed for a
    // reason that has nothing to do with tayzu_app's own grants, and would
    // prove nothing about the production runtime role. The catalog-level
    // membership check below is independent of that test-harness detail: it
    // asks whether the role tayzu_app itself, not whichever login role
    // happens to be running this test, could ever assume tayzu_migrator.
    const result = await db.execute<{ is_member: boolean }>(sql`
      select pg_has_role('tayzu_app', 'tayzu_migrator', 'MEMBER') as is_member
    `);
    expect(
      result.rows[0]?.is_member,
      'tayzu_app must hold no membership, direct or indirect, in tayzu_migrator',
    ).toBe(false);
  });
});
