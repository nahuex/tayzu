/**
 * Integration test for the task 5.1 follow-up (design D3, D4; spec
 * Conventions "Catalog context" for actor types, and the "Actor attribution
 * and change events" requirement for actions and resource kinds), approved by
 * the human at Checkpoint 3.
 *
 * It applies `packages/db/migrations/` to a fresh, private scratch database
 * (the same scratch-database pattern as `schema.int.test.ts`, copied here
 * because that file is frozen) and asserts two kinds of hardening design D4
 * only implies but does not literally enumerate: `CHECK` constraints that
 * restrict enumerated text columns to the closed set the domain allows, and a
 * btree index that makes "the state of a resource at any past version can be
 * read from its events" (spec, "Change events record resulting values") an
 * index lookup instead of a sequential scan.
 *
 * Red phase: none of the constraints or the index below exist yet, so every
 * assertion fails because `pg_constraint`/`pg_indexes` finds nothing (or a
 * raw `INSERT` that should be rejected by SQLSTATE 23514 instead succeeds),
 * not because of a bug in this test.
 *
 * ## Constraint names asserted here
 *
 * - `catalog_change_event_actor_type_check`
 * - `catalog_change_event_on_behalf_of_type_check`
 * - `catalog_change_event_on_behalf_of_pair_check`
 * - `catalog_change_event_action_check`
 * - `catalog_change_event_resource_kind_check`
 * - `catalog_blueprint_created_by_type_check`
 * - `catalog_blueprint_updated_by_type_check`
 * - `catalog_entity_created_by_type_check`
 * - `catalog_entity_updated_by_type_check`
 *
 * ## Index asserted here
 *
 * - `catalog_change_event_resource_history_idx` on `catalog_change_event
 *   (tenant_id, blueprint_identifier, resource_identifier, seq)`, in that
 *   column order.
 */
import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { runMigrations } from '@tayzu/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// --- Scratch-database helpers, copied from schema.int.test.ts (frozen) ---

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

function scratchDatabaseUrl(name: string): string {
  const url = new URL(databaseUrl());
  url.pathname = `/${name}`;
  return url.href;
}

const SCRATCH_NAME_PATTERN = /^[a-z0-9_]+$/;

function scratchDatabaseName(): string {
  const name = `tayzu_catalog_schema_hardening_${randomUUID().replaceAll('-', '')}`;
  if (!SCRATCH_NAME_PATTERN.test(name)) {
    // Defensive: never interpolate a database name that is not restricted to
    // this safe character set into DDL text.
    throw new Error(`generated scratch database name is unsafe: ${name}`);
  }
  return name;
}

// A type literal (not an interface) so it satisfies `db.execute`'s
// `TRow extends Record<string, unknown>` constraint (TypeScript's implicit
// index signature applies to object type literals, not interfaces).
type ConstraintRow = {
  readonly name: string;
  readonly type: 'p' | 'u' | 'f' | 'c';
  readonly definition: string;
};

async function readConstraints(db: Db, table: string): Promise<ConstraintRow[]> {
  const result = await db.execute<ConstraintRow>(sql`
    select
      con.conname as name,
      con.contype as type,
      pg_get_constraintdef(con.oid) as definition
      from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = ${table}
     order by con.conname
  `);
  return result.rows;
}

function expectCheckConstraintExists(rows: readonly ConstraintRow[], name: string): void {
  const row = rows.find((candidate) => candidate.name === name);
  expect(row, `constraint "${name}" exists`).toBeDefined();
  expect(row?.type, `"${name}" is a CHECK constraint`).toBe('c');
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// PostgreSQL's SQLSTATE for a CHECK constraint violation (D4, D9).
const CHECK_VIOLATION_SQLSTATE = '23514';

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

// drizzle-orm wraps the driver's DatabaseError in a DrizzleQueryError (see
// drizzle-orm/errors.js): the real `code`/`constraint` from `pg` live on
// `error.cause`, not on the outer error. Unwrap `.cause` until an object
// with a string `code` is found, so this helper works whether the caller
// throws the raw driver error or a wrapper around it.
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

async function expectCheckViolation(
  db: Db,
  run: () => Promise<unknown>,
  constraintName: string,
): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught, `an invalid value for "${constraintName}" is rejected`).toBeDefined();
  const pgError = pgErrorOf(caught);
  expect(pgError.code, `SQLSTATE for "${constraintName}" violation`).toBe(CHECK_VIOLATION_SQLSTATE);
  expect(pgError.constraint, 'violated constraint name').toBe(constraintName);
}

// --- Fixture rows for the tables the checks live on ---

async function insertBlueprint(
  db: Db,
  overrides: { createdByType?: string; updatedByType?: string } = {},
): Promise<void> {
  const tenantId = `t${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const identifier = `bp${randomUUID().replaceAll('-', '').slice(0, 8)}`;
  await db.execute(sql`
    insert into catalog_blueprint
      (id, tenant_id, identifier, title, schema, version,
       created_at, created_by_type, created_by_id, updated_at, updated_by_type, updated_by_id)
    values
      (gen_random_uuid(), ${tenantId}, ${identifier}, '{}'::jsonb, '{}'::jsonb, 1,
       now(), ${overrides.createdByType ?? 'system'}, 'sys', now(), ${overrides.updatedByType ?? 'system'}, 'sys')
  `);
}

async function insertEntity(
  db: Db,
  overrides: { createdByType?: string; updatedByType?: string } = {},
): Promise<void> {
  const tenantId = `t${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const identifier = `e${randomUUID().replaceAll('-', '').slice(0, 8)}`;
  const blueprintId = randomUUID();
  await db.execute(sql`
    insert into catalog_blueprint
      (id, tenant_id, identifier, title, schema, version,
       created_at, created_by_type, created_by_id, updated_at, updated_by_type, updated_by_id)
    values
      (${blueprintId}, ${tenantId}, ${`bp${randomUUID().replaceAll('-', '').slice(0, 8)}`}, '{}'::jsonb, '{}'::jsonb, 1,
       now(), 'system', 'sys', now(), 'system', 'sys')
  `);
  await db.execute(sql`
    insert into catalog_entity
      (id, tenant_id, blueprint_id, identifier, title, spec_properties, generation, version,
       created_at, created_by_type, created_by_id, updated_at, updated_by_type, updated_by_id)
    values
      (gen_random_uuid(), ${tenantId}, ${blueprintId}, ${identifier}, 'e', '{}'::jsonb, 1, 1,
       now(), ${overrides.createdByType ?? 'system'}, 'sys', now(), ${overrides.updatedByType ?? 'system'}, 'sys')
  `);
}

async function insertChangeEvent(
  db: Db,
  overrides: {
    actorType?: string;
    onBehalfOfType?: string | null;
    onBehalfOfId?: string | null;
    action?: string;
    resourceKind?: string;
  } = {},
): Promise<void> {
  const tenantId = `t${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  await db.execute(sql`
    insert into catalog_change_event
      (tenant_id, seq, occurred_at, actor_type, actor_id, on_behalf_of_type, on_behalf_of_id,
       action, resource_kind, blueprint_identifier, resource_identifier, version, changed_fields, snapshot)
    values
      (${tenantId}, 1, now(), ${overrides.actorType ?? 'system'}, 'sys',
       ${overrides.onBehalfOfType ?? null}, ${overrides.onBehalfOfId ?? null},
       ${overrides.action ?? 'created'}, ${overrides.resourceKind ?? 'entity'},
       'bp', 'e1', 1, ARRAY[]::text[], '{}'::jsonb)
  `);
}

describe('schema hardening: enumerated-column CHECK constraints and the change-event resource-history index', () => {
  let admin: Db;
  let scratchName: string;
  let db: Db;

  beforeAll(async () => {
    admin = connect(databaseUrl());

    const privilege = await admin.execute<{ allowed: boolean }>(sql`
      select rolcreatedb or rolsuper as allowed from pg_roles where rolname = current_user
    `);
    if (privilege.rows[0]?.allowed !== true) {
      throw new Error(
        'The DATABASE_URL role needs the CREATEDB privilege: this test creates, and then drops, a private scratch database.',
      );
    }

    scratchName = scratchDatabaseName();
    await admin.execute(`create database ${scratchName}`);

    db = connect(scratchDatabaseUrl(scratchName));
    await runMigrations(db.$client);
    // gen_random_uuid() is used by fixtures above (pgcrypto, or PG13+ built-in
    // pg_catalog.gen_random_uuid()); PostgreSQL 16 provides it without an
    // extension.
  }, 60_000);

  afterAll(async () => {
    await db.$client.end();
    await admin.execute(`drop database if exists ${scratchName} with (force)`);
    await admin.$client.end();
  }, 60_000);

  describe('catalog_change_event.actor_type', () => {
    it('has a CHECK constraint restricting actor_type to user, agent, integration, system', async () => {
      const constraints = await readConstraints(db, 'catalog_change_event');
      expectCheckConstraintExists(constraints, 'catalog_change_event_actor_type_check');
      const definition = normalize(
        constraints.find((row) => row.name === 'catalog_change_event_actor_type_check')?.definition ?? '',
      );
      for (const value of ['user', 'agent', 'integration', 'system']) {
        expect(definition).toMatch(new RegExp(`'${value}'`));
      }
    });

    it.each(['user', 'agent', 'integration', 'system'])('accepts actor_type %s', async (actorType) => {
      await expect(insertChangeEvent(db, { actorType })).resolves.toBeUndefined();
    });

    it('rejects an invalid actor_type with SQLSTATE 23514', async () => {
      await expectCheckViolation(
        db,
        () => insertChangeEvent(db, { actorType: 'robot' }),
        'catalog_change_event_actor_type_check',
      );
    });
  });

  describe('catalog_change_event.on_behalf_of_type', () => {
    it('has a CHECK constraint restricting on_behalf_of_type to user, agent, integration, system, or NULL', async () => {
      const constraints = await readConstraints(db, 'catalog_change_event');
      expectCheckConstraintExists(constraints, 'catalog_change_event_on_behalf_of_type_check');
      const definition = normalize(
        constraints.find((row) => row.name === 'catalog_change_event_on_behalf_of_type_check')
          ?.definition ?? '',
      );
      for (const value of ['user', 'agent', 'integration', 'system']) {
        expect(definition).toMatch(new RegExp(`'${value}'`));
      }
    });

    it('accepts a NULL on_behalf_of_type (with on_behalf_of_id also NULL)', async () => {
      await expect(
        insertChangeEvent(db, { onBehalfOfType: null, onBehalfOfId: null }),
      ).resolves.toBeUndefined();
    });

    it.each(['user', 'agent', 'integration', 'system'])(
      'accepts on_behalf_of_type %s (with on_behalf_of_id set)',
      async (onBehalfOfType) => {
        await expect(
          insertChangeEvent(db, { onBehalfOfType, onBehalfOfId: 'delegate1' }),
        ).resolves.toBeUndefined();
      },
    );

    it('rejects an invalid on_behalf_of_type with SQLSTATE 23514', async () => {
      await expectCheckViolation(
        db,
        () => insertChangeEvent(db, { onBehalfOfType: 'robot', onBehalfOfId: 'delegate1' }),
        'catalog_change_event_on_behalf_of_type_check',
      );
    });
  });

  describe('catalog_change_event on_behalf_of_type/on_behalf_of_id pairing', () => {
    it('has a CHECK constraint requiring both NULL or both NOT NULL', async () => {
      const constraints = await readConstraints(db, 'catalog_change_event');
      expectCheckConstraintExists(constraints, 'catalog_change_event_on_behalf_of_pair_check');
    });

    it('rejects on_behalf_of_type set with on_behalf_of_id NULL', async () => {
      await expectCheckViolation(
        db,
        () => insertChangeEvent(db, { onBehalfOfType: 'user', onBehalfOfId: null }),
        'catalog_change_event_on_behalf_of_pair_check',
      );
    });

    it('rejects on_behalf_of_id set with on_behalf_of_type NULL', async () => {
      await expectCheckViolation(
        db,
        () => insertChangeEvent(db, { onBehalfOfType: null, onBehalfOfId: 'u1' }),
        'catalog_change_event_on_behalf_of_pair_check',
      );
    });
  });

  describe('catalog_change_event.action', () => {
    it('has a CHECK constraint restricting action to created, updated, status_updated, deleted', async () => {
      const constraints = await readConstraints(db, 'catalog_change_event');
      expectCheckConstraintExists(constraints, 'catalog_change_event_action_check');
      const definition = normalize(
        constraints.find((row) => row.name === 'catalog_change_event_action_check')?.definition ?? '',
      );
      for (const value of ['created', 'updated', 'status_updated', 'deleted']) {
        expect(definition).toMatch(new RegExp(`'${value}'`));
      }
    });

    it.each(['created', 'updated', 'status_updated', 'deleted'])('accepts action %s', async (action) => {
      await expect(insertChangeEvent(db, { action })).resolves.toBeUndefined();
    });

    it('rejects an invalid action with SQLSTATE 23514', async () => {
      await expectCheckViolation(
        db,
        () => insertChangeEvent(db, { action: 'archived' }),
        'catalog_change_event_action_check',
      );
    });
  });

  describe('catalog_change_event.resource_kind', () => {
    it('has a CHECK constraint restricting resource_kind to blueprint, entity', async () => {
      const constraints = await readConstraints(db, 'catalog_change_event');
      expectCheckConstraintExists(constraints, 'catalog_change_event_resource_kind_check');
      const definition = normalize(
        constraints.find((row) => row.name === 'catalog_change_event_resource_kind_check')?.definition ??
          '',
      );
      for (const value of ['blueprint', 'entity']) {
        expect(definition).toMatch(new RegExp(`'${value}'`));
      }
    });

    it.each(['blueprint', 'entity'])('accepts resource_kind %s', async (resourceKind) => {
      await expect(insertChangeEvent(db, { resourceKind })).resolves.toBeUndefined();
    });

    it('rejects an invalid resource_kind with SQLSTATE 23514', async () => {
      await expectCheckViolation(
        db,
        () => insertChangeEvent(db, { resourceKind: 'relation' }),
        'catalog_change_event_resource_kind_check',
      );
    });
  });

  describe('catalog_blueprint.created_by_type and updated_by_type', () => {
    it('has CHECK constraints restricting both to user, agent, integration, system', async () => {
      const constraints = await readConstraints(db, 'catalog_blueprint');
      expectCheckConstraintExists(constraints, 'catalog_blueprint_created_by_type_check');
      expectCheckConstraintExists(constraints, 'catalog_blueprint_updated_by_type_check');
      for (const name of ['catalog_blueprint_created_by_type_check', 'catalog_blueprint_updated_by_type_check']) {
        const definition = normalize(constraints.find((row) => row.name === name)?.definition ?? '');
        for (const value of ['user', 'agent', 'integration', 'system']) {
          expect(definition, `${name} allows '${value}'`).toMatch(new RegExp(`'${value}'`));
        }
      }
    });

    it.each(['user', 'agent', 'integration', 'system'])(
      'accepts created_by_type and updated_by_type %s',
      async (actorType) => {
        await expect(
          insertBlueprint(db, { createdByType: actorType, updatedByType: actorType }),
        ).resolves.toBeUndefined();
      },
    );

    it('rejects an invalid created_by_type with SQLSTATE 23514', async () => {
      await expectCheckViolation(
        db,
        () => insertBlueprint(db, { createdByType: 'robot' }),
        'catalog_blueprint_created_by_type_check',
      );
    });

    it('rejects an invalid updated_by_type with SQLSTATE 23514', async () => {
      await expectCheckViolation(
        db,
        () => insertBlueprint(db, { updatedByType: 'robot' }),
        'catalog_blueprint_updated_by_type_check',
      );
    });
  });

  describe('catalog_entity.created_by_type and updated_by_type', () => {
    it('has CHECK constraints restricting both to user, agent, integration, system', async () => {
      const constraints = await readConstraints(db, 'catalog_entity');
      expectCheckConstraintExists(constraints, 'catalog_entity_created_by_type_check');
      expectCheckConstraintExists(constraints, 'catalog_entity_updated_by_type_check');
      for (const name of ['catalog_entity_created_by_type_check', 'catalog_entity_updated_by_type_check']) {
        const definition = normalize(constraints.find((row) => row.name === name)?.definition ?? '');
        for (const value of ['user', 'agent', 'integration', 'system']) {
          expect(definition, `${name} allows '${value}'`).toMatch(new RegExp(`'${value}'`));
        }
      }
    });

    it.each(['user', 'agent', 'integration', 'system'])(
      'accepts created_by_type and updated_by_type %s',
      async (actorType) => {
        await expect(
          insertEntity(db, { createdByType: actorType, updatedByType: actorType }),
        ).resolves.toBeUndefined();
      },
    );

    it('rejects an invalid created_by_type with SQLSTATE 23514', async () => {
      await expectCheckViolation(
        db,
        () => insertEntity(db, { createdByType: 'robot' }),
        'catalog_entity_created_by_type_check',
      );
    });

    it('rejects an invalid updated_by_type with SQLSTATE 23514', async () => {
      await expectCheckViolation(
        db,
        () => insertEntity(db, { updatedByType: 'robot' }),
        'catalog_entity_updated_by_type_check',
      );
    });
  });

  describe('catalog_change_event_resource_history_idx', () => {
    it('is a btree index on catalog_change_event (tenant_id, blueprint_identifier, resource_identifier, seq)', async () => {
      const result = await db.execute<{ definition: string; method: string }>(sql`
        select indexdef as definition, am.amname as method
          from pg_indexes i
          join pg_class c on c.relname = i.indexname
          join pg_am am on am.oid = c.relam
         where i.schemaname = 'public'
           and i.tablename = 'catalog_change_event'
           and i.indexname = 'catalog_change_event_resource_history_idx'
      `);
      expect(
        result.rows.length,
        'catalog_change_event_resource_history_idx exists on catalog_change_event',
      ).toBe(1);
      const row = result.rows[0];
      expect(row?.method, 'catalog_change_event_resource_history_idx uses a btree').toBe('btree');
      expect(normalize(row?.definition ?? '')).toMatch(
        /\(tenant_id,\s*blueprint_identifier,\s*resource_identifier,\s*seq\)/i,
      );
    });
  });
});
