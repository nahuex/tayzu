/**
 * Integration test for task 6.1 of 045-org-deletion-and-data-retention: purge
 * step 1, the catalog data (design D2 step 1, Resolved decisions Q158 and Q161),
 * run as `tayzu_purge` under migration `0013`'s policies. It covers the catalog
 * side of the spec scenario "Purge removes tenant data after the window":
 *
 * > - **GIVEN** `t1`'s purge date has passed
 * > - **WHEN** the purge job runs
 * > - **THEN** `t1`'s catalog entities, blueprints, relations, change events,
 * >   credential revocation rows, invitations, API keys, members and
 * >   organization row are gone
 *
 * (the invitations, API keys, members, organization row and the audit event of
 * the scenario's AND clause are step 2, tasks 6.2 and 6.3).
 *
 * Expected production API (the module the purge script is made of, task 6.6's
 * entry point imports it):
 *
 * ```ts
 * // apps/api/scripts/purge-job.ts
 * export type CatalogPurgeTable =
 *   | 'catalog_entity_relation' | 'catalog_entity' | 'catalog_relation_definition'
 *   | 'catalog_blueprint' | 'catalog_change_event' | 'catalog_tenant_sequence'
 *   | 'machine_credential_revocation';
 * export interface PurgeCatalogOptions {
 *   // Failure seam (design "Failure seams ... after step 1"): awaited after the
 *   // tenant's rows of `table` are deleted; a throw interrupts the step.
 *   readonly afterTableDeleted?: (table: CatalogPurgeTable) => void | Promise<void>;
 * }
 * export interface CatalogPurgeResult {
 *   // `tayzu.identity.org_deletion.entities_removed`: entities this run removed.
 *   readonly entitiesRemoved: number;
 * }
 * export function purgeCatalogStep(
 *   pool: Pool, // a `tayzu_purge` pool
 *   tenantId: string,
 *   options?: PurgeCatalogOptions,
 * ): Promise<CatalogPurgeResult>;
 * ```
 *
 * Step 1 deletes the tenant's rows of the seven tenant tables in an order that
 * respects the `RESTRICT` foreign keys, records `catalog_purged_at` on the
 * pending marker (and nothing else: `auth_purged_at` and `state = 'purged'` are
 * step 2's, Q161), is a no-op once recorded, and resumes after an interruption.
 *
 * Seeding goes through `tayzu_app` (the request role, under `app.tenant_id`)
 * and the markers through the owner pool, which alone can write a
 * `requested_at` in the past (a due marker). Reads go through the owner pool.
 * Every id is random per run; markers of other test files may be due in the
 * shared database, so every assertion is scoped to this file's tenant ids.
 */
import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import {
  getOwnerPool,
  getPurgeTestDatabase,
  getTestDatabase,
} from '../../../packages/db/src/harness.js';
import { purgeCatalogStep } from '../scripts/purge-job.js';

/** The seven tenant tables of `0013`, named one by one. */
const TENANT_TABLES = [
  'catalog_blueprint',
  'catalog_relation_definition',
  'catalog_entity',
  'catalog_entity_relation',
  'catalog_change_event',
  'catalog_tenant_sequence',
  'machine_credential_revocation',
] as const;

type TenantTable = (typeof TENANT_TABLES)[number];

/** Rows `seedTenantData` writes in each table. */
const SEEDED: Record<TenantTable, number> = {
  catalog_blueprint: 2,
  catalog_relation_definition: 1,
  catalog_entity: 3,
  catalog_entity_relation: 2,
  catalog_change_event: 3,
  catalog_tenant_sequence: 1,
  machine_credential_revocation: 2,
};

/**
 * The `RESTRICT` foreign keys of the schema, as `[referencing, referenced]`:
 * the referencing table's rows must be deleted before the referenced table's.
 */
const RESTRICT_EDGES: readonly (readonly [TenantTable, TenantTable])[] = [
  ['catalog_entity_relation', 'catalog_entity'],
  ['catalog_entity_relation', 'catalog_relation_definition'],
  ['catalog_entity', 'catalog_blueprint'],
  ['catalog_relation_definition', 'catalog_blueprint'],
];

function newTenantId(): string {
  return `tenant-${randomUUID()}`;
}

async function purgePool(): Promise<Pool> {
  return (await getPurgeTestDatabase()).pool;
}

/**
 * Seeds every tenant table through `tayzu_app`. Two blueprints, with a
 * relation definition from the first to the second, so that both the
 * definition's and the entity relations' `RESTRICT` targets are exercised.
 */
async function seedTenantData(tenantId: string): Promise<void> {
  const app = (await getTestDatabase()).pool;
  const actorId = `actor-${randomUUID()}`;
  const serviceId = randomUUID();
  const teamId = randomUUID();
  const definitionId = randomUUID();
  const [apiId, workerId, ownersId] = [randomUUID(), randomUUID(), randomUUID()];
  const client = await app.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    for (const [id, identifier] of [
      [serviceId, 'service'],
      [teamId, 'team'],
    ] as const) {
      await client.query(
        `insert into catalog_blueprint
           (id, tenant_id, identifier, title, schema, version, created_at, created_by_type,
            created_by_id, updated_at, updated_by_type, updated_by_id)
         values ($1, $2, $3, to_jsonb($3::text), '{}'::jsonb, 1, now(), 'user', $4,
                 now(), 'user', $4)`,
        [id, tenantId, identifier, actorId],
      );
    }
    await client.query(
      `insert into catalog_relation_definition
         (id, tenant_id, source_blueprint_id, identifier, title, target_blueprint_id, many, required)
       values ($1, $2, $3, 'owned_by', '"Owned by"'::jsonb, $4, false, false)`,
      [definitionId, tenantId, serviceId, teamId],
    );
    for (const [id, blueprintId, identifier] of [
      [apiId, serviceId, 'api'],
      [workerId, serviceId, 'worker'],
      [ownersId, teamId, 'owners'],
    ] as const) {
      await client.query(
        `insert into catalog_entity
           (id, tenant_id, blueprint_id, identifier, title, spec_properties, generation, version,
            created_at, created_by_type, created_by_id, updated_at, updated_by_type, updated_by_id)
         values ($1, $2, $3, $4, $4, '{}'::jsonb, 1, 1, now(), 'user', $5, now(), 'user', $5)`,
        [id, tenantId, blueprintId, identifier, actorId],
      );
    }
    for (const sourceId of [apiId, workerId]) {
      await client.query(
        `insert into catalog_entity_relation
           (tenant_id, source_entity_id, relation_definition_id, scope, target_entity_id, position)
         values ($1, $2, $3, 'spec', $4, 0)`,
        [tenantId, sourceId, definitionId, ownersId],
      );
    }
    for (const seq of [1, 2, 3]) {
      await client.query(
        `insert into catalog_change_event
           (tenant_id, seq, occurred_at, actor_type, actor_id, action, resource_kind,
            blueprint_identifier, resource_identifier, version, changed_fields, snapshot)
         values ($1, $2, now(), 'user', $3, 'created', 'entity', 'service', 'api', 1,
                 '{}'::text[], '{}'::jsonb)`,
        [tenantId, seq, actorId],
      );
    }
    await client.query('insert into catalog_tenant_sequence (tenant_id, last_seq) values ($1, 3)', [
      tenantId,
    ]);
    for (const credentialId of [randomUUID(), randomUUID()]) {
      await client.query(
        `insert into machine_credential_revocation (credential_id, revoked_at, tenant_id)
         values ($1, now(), $2)`,
        [credentialId, tenantId],
      );
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Writes a pending marker through the owner pool: due (`requested_at` fifteen
 * days ago, so `purge_after = requested_at + 14 days` has passed) or not due
 * (requested now, purge date fourteen days ahead).
 */
async function seedMarker(tenantId: string, due: boolean): Promise<void> {
  const owner = await getOwnerPool();
  await owner.query(
    `insert into tenant_deletion_marker (tenant_id, requested_at, purge_after, requested_by)
     values ($1,
             now() - make_interval(days => $2::int),
             now() - make_interval(days => $2::int) + make_interval(days => 14),
             $3)`,
    [tenantId, due ? 15 : 0, `actor-${randomUUID()}`],
  );
}

/** A due tenant and a not-due tenant, both with rows in every tenant table. */
async function seedTenants(): Promise<{ due: string; notDue: string }> {
  const due = newTenantId();
  const notDue = newTenantId();
  await seedTenantData(due);
  await seedTenantData(notDue);
  await seedMarker(due, true);
  await seedMarker(notDue, false);
  return { due, notDue };
}

async function ownerCount(table: TenantTable, tenantId: string): Promise<number> {
  const owner = await getOwnerPool();
  // `table` is one of the fixed `TENANT_TABLES` literals.
  const { rows } = await owner.query<{ count: number }>(
    `select count(*)::int as count from ${table} where tenant_id = $1`,
    [tenantId],
  );
  return rows[0]?.count ?? -1;
}

async function expectAllRowsGone(tenantId: string, label: string): Promise<void> {
  for (const table of TENANT_TABLES) {
    expect(await ownerCount(table, tenantId), `${label}: ${table} rows gone`).toBe(0);
  }
}

async function expectSeededRowsIntact(tenantId: string, label: string): Promise<void> {
  for (const table of TENANT_TABLES) {
    expect(await ownerCount(table, tenantId), `${label}: ${table} rows intact`).toBe(SEEDED[table]);
  }
}

interface MarkerRow {
  readonly state: string;
  /** Text form, so two reads compare at full microsecond precision. */
  readonly catalog_purged_at: string | null;
  readonly catalog_purged_recently: boolean | null;
  readonly auth_purged_at: string | null;
}

/** Every marker of `tenantId`, read through the owner pool. */
async function ownerMarkers(tenantId: string): Promise<MarkerRow[]> {
  const owner = await getOwnerPool();
  const { rows } = await owner.query<MarkerRow>(
    `select state::text as state,
            catalog_purged_at::text as catalog_purged_at,
            catalog_purged_at > now() - interval '5 minutes' as catalog_purged_recently,
            auth_purged_at::text as auth_purged_at
       from tenant_deletion_marker where tenant_id = $1`,
    [tenantId],
  );
  return rows;
}

/** The marker of `tenantId` after step 1: still pending, step 1 recorded by this run. */
async function expectCatalogStepRecorded(tenantId: string): Promise<string> {
  const markers = await ownerMarkers(tenantId);
  expect(markers).toHaveLength(1);
  const [marker] = markers;
  expect(marker).toMatchObject({
    state: 'pending',
    catalog_purged_recently: true,
    auth_purged_at: null,
  });
  expect(marker?.catalog_purged_at).not.toBeNull();
  return marker?.catalog_purged_at ?? '';
}

async function expectCatalogStepNotRecorded(tenantId: string): Promise<void> {
  expect(await ownerMarkers(tenantId)).toEqual([
    {
      state: 'pending',
      catalog_purged_at: null,
      catalog_purged_recently: null,
      auth_purged_at: null,
    },
  ]);
}

class SeamFailure extends Error {
  constructor() {
    super('failure seam: step 1 interrupted');
    this.name = 'SeamFailure';
  }
}

describe('Purge removes tenant data after the window (catalog side, step 1)', () => {
  it("deletes every catalog row of the due tenant and records catalog_purged_at, leaving a not-due tenant's rows", async () => {
    const { due, notDue } = await seedTenants();
    await expectSeededRowsIntact(due, 'due tenant before the purge');

    await purgeCatalogStep(await purgePool(), due);

    await expectAllRowsGone(due, 'due tenant');
    await expectCatalogStepRecorded(due);

    await expectSeededRowsIntact(notDue, 'not-due tenant');
    await expectCatalogStepNotRecorded(notDue);
  });

  it('reports the count of removed entities (entities_removed)', async () => {
    const { due } = await seedTenants();

    const result = await purgeCatalogStep(await purgePool(), due);

    expect(result.entitiesRemoved).toBe(SEEDED.catalog_entity);
  });

  it('deletes the tables in an order that respects the RESTRICT foreign keys', async () => {
    const { due } = await seedTenants();
    const order: string[] = [];

    await purgeCatalogStep(await purgePool(), due, {
      afterTableDeleted: (table: string) => {
        order.push(table);
      },
    });

    expect([...order].sort()).toEqual([...TENANT_TABLES].sort());
    for (const [referencing, referenced] of RESTRICT_EDGES) {
      expect(
        order.indexOf(referencing),
        `${referencing} is deleted before ${referenced}`,
      ).toBeLessThan(order.indexOf(referenced));
    }
    await expectAllRowsGone(due, 'due tenant');
  });

  it('is idempotent: a second run is a no-op and keeps the first catalog_purged_at', async () => {
    const { due, notDue } = await seedTenants();
    const pool = await purgePool();

    await purgeCatalogStep(pool, due);
    const first = await expectCatalogStepRecorded(due);

    const second = await purgeCatalogStep(pool, due);

    expect(second.entitiesRemoved).toBe(0);
    expect(await expectCatalogStepRecorded(due)).toBe(first);
    await expectAllRowsGone(due, 'due tenant after the second run');
    await expectSeededRowsIntact(notDue, 'not-due tenant after the second run');
  });

  it('resumes: a run interrupted after the first table completes on the next run', async () => {
    const { due, notDue } = await seedTenants();
    const pool = await purgePool();

    await expect(
      purgeCatalogStep(pool, due, {
        afterTableDeleted: (table: string) => {
          if (table === 'catalog_entity_relation') {
            throw new SeamFailure();
          }
        },
      }),
    ).rejects.toThrow();
    await expectCatalogStepNotRecorded(due);

    const resumed = await purgeCatalogStep(pool, due);

    expect(resumed.entitiesRemoved).toBe(SEEDED.catalog_entity);
    await expectAllRowsGone(due, 'due tenant after the resumed run');
    await expectCatalogStepRecorded(due);
    await expectSeededRowsIntact(notDue, 'not-due tenant');
  });

  it('resumes: a run interrupted half-way, after the blueprints, completes on the next run', async () => {
    const { due, notDue } = await seedTenants();
    const pool = await purgePool();

    await expect(
      purgeCatalogStep(pool, due, {
        afterTableDeleted: (table: string) => {
          if (table === 'catalog_blueprint') {
            throw new SeamFailure();
          }
        },
      }),
    ).rejects.toThrow();
    await expectCatalogStepNotRecorded(due);

    await purgeCatalogStep(pool, due);

    await expectAllRowsGone(due, 'due tenant after the resumed run');
    await expectCatalogStepRecorded(due);
    await expectSeededRowsIntact(notDue, 'not-due tenant');
  });
});
