/**
 * Integration test for task 6.4 of 045-org-deletion-and-data-retention: a
 * failed purge step logs `catalog.security.org_deletion_failed` with the step,
 * and the next run resumes without repeating a completed step (design D2,
 * "Observability", Resolved decision Q169). It covers the spec scenario:
 *
 * > #### Scenario: A failed purge step is visible and resumes
 * >
 * > - **GIVEN** the Better Auth step fails after the catalog step succeeded
 * > - **WHEN** the purge job runs again
 * > - **THEN** `catalog.security.org_deletion_failed` was logged for the failure, the
 * >   catalog step is not repeated, and the run completes the Better Auth step
 *
 * with a failure seam after step 1 (design "Failure seams ... after step 1 of
 * the purge"), plus a failure inside step 1, which logs the step `catalog`.
 * The declared log event is WARN with exactly `tayzu.tenant.id` and
 * `tayzu.identity.org_deletion.step` (`catalog` | `auth`), and no free text and
 * no error message. Q169: the completion record of a run that resumes after
 * step 1 was recorded earlier reports `entities_removed` 0.
 *
 * Behaviour this file pins for `runPurge`: a failed step of one tenant is
 * logged, the pass **continues with the next tenant** and `runPurge`
 * **resolves** (the WARN event is the visible signal, and the next run
 * resumes); the event is exported by `runScript`'s final flush.
 *
 * Expected production API (`apps/api/scripts/purge-job.ts`), the least
 * invasive seam: `runPurge` forwards per-step options to the existing steps
 * and their existing seams, with no new seam inside a step.
 *
 * ```ts
 * export interface RunPurgeOptions {
 *   readonly pool: Pool;
 *   readonly tenantIds?: readonly string[];
 *   readonly env?: RunScriptOptions['env'];
 *   readonly telemetry?: Telemetry;
 *   // Forwarded to every `purgeCatalogStep` call of the pass.
 *   readonly catalogOptions?: PurgeCatalogOptions;
 *   // Forwarded to every `purgeAuthStep` call of the pass; `runPurge` sets
 *   // `entitiesRemoved` from step 1 itself.
 *   readonly authOptions?: Omit<PurgeAuthOptions, 'entitiesRemoved'>;
 * }
 * // For each tenant: step 1, then step 2; a throw from either step emits
 * // `catalog.security.org_deletion_failed` (WARN, tenant and step only) and
 * // the pass moves on to the next tenant.
 * export function runPurge(options: RunPurgeOptions): Promise<unknown>;
 * ```
 *
 * Task 6.5 adds "A purge does not touch a tenant whose window has not passed"
 * and "A repeated purge is safe" (a repeated purge resolves, logs no
 * `org_deletion_failed` and deletes nothing), plus the tombstone of D2: the
 * marker remains, and its non-null columns are the tenant id, `state`, the
 * timestamps and `requested_by` (an opaque id, `NOT NULL` in `0012`).
 *
 * Seeding and every read go through the owner pool. Every id is random per
 * run, and every assertion is scoped to this file's tenants.
 */
// Load-bearing import order (design D1 of `043`): the telemetry harness registers before
// `../scripts/purge-job.js` (and anything it loads) obtains its logger.
import { registration, type TelemetryTestHarness } from './__fixtures__/link-telemetry.js';
import { randomBytes, randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { getOwnerPool, getPurgeTestDatabase } from '../../../packages/db/src/harness.js';
import { purgeAuthStep, purgeCatalogStep, runPurge } from '../scripts/purge-job.js';
import type { Telemetry } from './telemetry.js';

const FAILED_EVENT = 'catalog.security.org_deletion_failed';
const COMPLETED_EVENT = 'catalog.audit.org_deletion_completed';

async function purgePool(): Promise<Pool> {
  return (await getPurgeTestDatabase()).pool;
}

async function ownerQuery(statement: string, params: unknown[]): Promise<void> {
  const owner = await getOwnerPool();
  await owner.query(statement, params);
}

function registeredHarness(): TelemetryTestHarness {
  if ('error' in registration) {
    throw new Error(`createTelemetryTestHarness() failed: ${String(registration.error)}`, {
      cause: registration.error,
    });
  }
  return registration.harness;
}

// ---------------------------------------------------------------------------
// Seeding, through the owner pool (same shapes as `org-purge-auth.int.test.ts`).

type AuthTable = 'organization' | 'member' | 'user' | 'session';

interface DueTenant {
  readonly tenantId: string;
  readonly userId: string;
  readonly rows: readonly { readonly table: AuthTable; readonly id: string }[];
  /** Free text of the tenant: its slug and its user's email. */
  readonly freeText: readonly string[];
}

/** One blueprint and `count` entities of `tenantId`. */
async function seedCatalogEntities(tenantId: string, count: number): Promise<void> {
  const actorId = `actor-${randomUUID()}`;
  const blueprintId = randomUUID();
  await ownerQuery(
    `insert into catalog_blueprint
       (id, tenant_id, identifier, title, schema, version, created_at, created_by_type,
        created_by_id, updated_at, updated_by_type, updated_by_id)
     values ($1, $2, $3, '"Service"'::jsonb, '{}'::jsonb, 1, now(), 'user', $4,
             now(), 'user', $4)`,
    [blueprintId, tenantId, `service-${randomUUID()}`, actorId],
  );
  for (let index = 0; index < count; index += 1) {
    await ownerQuery(
      `insert into catalog_entity
         (id, tenant_id, blueprint_id, identifier, title, spec_properties, generation, version,
          created_at, created_by_type, created_by_id, updated_at, updated_by_type, updated_by_id)
       values ($1, $2, $3, $4, $4, '{}'::jsonb, 1, 1, now(), 'user', $5, now(), 'user', $5)`,
      [randomUUID(), tenantId, blueprintId, `entity-${randomUUID()}`, actorId],
    );
  }
}

/** `count` append-only `catalog_change_event` rows of `tenantId`. */
async function seedChangeEvents(tenantId: string, count: number): Promise<void> {
  for (let seq = 1; seq <= count; seq += 1) {
    await ownerQuery(
      `insert into catalog_change_event
         (tenant_id, seq, occurred_at, actor_type, actor_id, action, resource_kind,
          blueprint_identifier, resource_identifier, version, changed_fields, snapshot)
       values ($1, $2, now(), 'user', $3, 'created', 'entity', 'service', 'api', 1,
               '{}'::text[], '{}'::jsonb)`,
      [tenantId, seq, `actor-${randomUUID()}`],
    );
  }
}

/**
 * `due`: a pending marker whose window has passed (step 1 not recorded);
 * `future`: a pending marker whose purge date is in the future; `none`: no marker.
 */
type MarkerKind = 'due' | 'future' | 'none';

/**
 * A tenant with an organization, a user who belongs only to it (with a
 * session), `entities` catalog entities and, by default, a due marker.
 */
async function seedDueTenant(entities: number, marker: MarkerKind = 'due'): Promise<DueTenant> {
  const tenantId = `org-${randomUUID()}`;
  const slug = `slug-${tenantId}`;
  await ownerQuery(
    'insert into auth.organization (id, name, slug, created_at) values ($1, $2, $3, now())',
    [tenantId, 'Org', slug],
  );
  if (marker === 'due') {
    await ownerQuery(
      `insert into tenant_deletion_marker (tenant_id, requested_at, purge_after, requested_by)
       values ($1, now() - interval '15 days', now() - interval '1 day', $2)`,
      [tenantId, `actor-${randomUUID()}`],
    );
  } else if (marker === 'future') {
    await ownerQuery(
      `insert into tenant_deletion_marker (tenant_id, requested_at, purge_after, requested_by)
       values ($1, now(), now() + interval '10 days', $2)`,
      [tenantId, `actor-${randomUUID()}`],
    );
  }
  const userId = `user-${randomUUID()}`;
  const email = `${userId}@example.test`;
  await ownerQuery(
    `insert into auth."user" (id, name, email, email_verified, created_at, updated_at)
     values ($1, 'User', $2, true, now(), now())`,
    [userId, email],
  );
  const memberId = `member-${randomUUID()}`;
  await ownerQuery(
    `insert into auth.member (id, organization_id, user_id, role, created_at)
     values ($1, $2, $3, 'member', now())`,
    [memberId, tenantId, userId],
  );
  const sessionId = `session-${randomUUID()}`;
  await ownerQuery(
    `insert into auth.session (id, expires_at, token, created_at, updated_at, user_id, active_organization_id)
     values ($1, now() + interval '1 day', $2, now(), now(), $3, $4)`,
    [sessionId, randomBytes(24).toString('hex'), userId, tenantId],
  );
  await seedCatalogEntities(tenantId, entities);
  return {
    tenantId,
    userId,
    rows: [
      { table: 'organization', id: tenantId },
      { table: 'member', id: memberId },
      { table: 'user', id: userId },
      { table: 'session', id: sessionId },
    ],
    freeText: [slug, email],
  };
}

// ---------------------------------------------------------------------------
// Reads, through the owner pool.

async function presentAuthRows(tenant: DueTenant): Promise<AuthTable[]> {
  const owner = await getOwnerPool();
  const present: AuthTable[] = [];
  for (const { table, id } of tenant.rows) {
    // `table` is one of the fixed `AuthTable` literals.
    const { rows } = await owner.query<{ present: boolean }>(
      `select exists (select 1 from auth."${table}" where id = $1) as present`,
      [id],
    );
    if (rows[0]?.present === true) {
      present.push(table);
    }
  }
  return present;
}

async function entityCount(tenantId: string): Promise<number> {
  const owner = await getOwnerPool();
  const { rows } = await owner.query<{ count: number }>(
    'select count(*)::int as count from catalog_entity where tenant_id = $1',
    [tenantId],
  );
  return rows[0]?.count ?? -1;
}

/** `catalog_blueprint` or `catalog_change_event` rows of `tenantId`. */
async function catalogCount(
  table: 'catalog_blueprint' | 'catalog_change_event',
  tenantId: string,
): Promise<number> {
  const owner = await getOwnerPool();
  // `table` is one of the two fixed literals.
  const { rows } = await owner.query<{ count: number }>(
    `select count(*)::int as count from ${table} where tenant_id = $1`,
    [tenantId],
  );
  return rows[0]?.count ?? -1;
}

/**
 * A direct `DELETE` of the tenant's append-only rows as `tayzu_purge`: the
 * number of rows it deleted, or the SQLSTATE it raised.
 */
async function purgeRoleDeletesChangeEvents(tenantId: string): Promise<number | string> {
  try {
    const deleted = await (
      await purgePool()
    ).query('delete from catalog_change_event where tenant_id = $1', [tenantId]);
    return deleted.rowCount ?? 0;
  } catch (error) {
    return (error as { code?: string }).code ?? 'no-sqlstate';
  }
}

/** Every marker row of `tenantId`, whole, as JSON (timestamps as text). */
async function markerRows(tenantId: string): Promise<Record<string, unknown>[]> {
  const owner = await getOwnerPool();
  const { rows } = await owner.query<{ row: Record<string, unknown> }>(
    'select to_jsonb(m) as row from tenant_deletion_marker m where tenant_id = $1',
    [tenantId],
  );
  return rows.map(({ row }) => row);
}

interface Marker {
  readonly state: string;
  /** Text forms, so two reads compare at full microsecond precision. */
  readonly catalog_purged_at: string | null;
  readonly auth_purged_at: string | null;
}

async function readMarker(tenantId: string): Promise<Marker | undefined> {
  const owner = await getOwnerPool();
  const { rows } = await owner.query<Marker>(
    `select state::text as state,
            catalog_purged_at::text as catalog_purged_at,
            auth_purged_at::text as auth_purged_at
       from tenant_deletion_marker where tenant_id = $1`,
    [tenantId],
  );
  return rows[0];
}

function records(harness: TelemetryTestHarness, eventName: string, tenantId: string) {
  return harness.logExporter
    .getFinishedLogRecords()
    .filter(
      (record) =>
        record.eventName === eventName && record.attributes['tayzu.tenant.id'] === tenantId,
    );
}

/** A `Telemetry` whose shutdown (`runScript`'s final flush) counts the tenant's failure records. */
function flushingTelemetry(
  harness: TelemetryTestHarness,
  tenantId: string,
  atShutdown: number[],
): Telemetry {
  return {
    shutdown: async () => {
      await harness.forceFlush();
      atShutdown.push(records(harness, FAILED_EVENT, tenantId).length);
    },
  };
}

/** The error message of the seams: free text that must never reach the event. */
const SEAM_MESSAGE = `seam failure ${randomUUID()}`;

function expectFailedRecord(
  harness: TelemetryTestHarness,
  tenant: DueTenant,
  step: 'catalog' | 'auth',
): void {
  const failed = records(harness, FAILED_EVENT, tenant.tenantId);
  expect(failed, `exactly one ${FAILED_EVENT} for the failing tenant`).toHaveLength(1);
  const [record] = failed;
  expect(record?.severityText, 'the declared severity').toBe('WARN');
  expect(record?.attributes, 'exactly the declared attributes').toEqual({
    'tayzu.tenant.id': tenant.tenantId,
    'tayzu.identity.org_deletion.step': step,
  });
  expect(record?.body, 'no body: no free text and no error message').toBeUndefined();
  const serialized = JSON.stringify({ body: record?.body, attributes: record?.attributes });
  for (const text of [SEAM_MESSAGE, ...tenant.freeText]) {
    expect(serialized, 'no error message, organization slug or user email').not.toContain(text);
  }
}

function expectCompletedRecord(
  harness: TelemetryTestHarness,
  tenantId: string,
  entitiesRemoved: number,
): void {
  const completed = records(harness, COMPLETED_EVENT, tenantId);
  expect(completed, `exactly one ${COMPLETED_EVENT}`).toHaveLength(1);
  expect(completed[0]?.attributes).toEqual({
    'tayzu.tenant.id': tenantId,
    'tayzu.identity.org_deletion.entities_removed': entitiesRemoved,
  });
}

/** The healthy tenant run in the same pass after the failing one: fully purged. */
async function expectFullyPurged(
  harness: TelemetryTestHarness,
  tenant: DueTenant,
  entities: number,
): Promise<void> {
  expect((await readMarker(tenant.tenantId))?.state, 'the next tenant is purged').toBe('purged');
  expect(await presentAuthRows(tenant), "the next tenant's auth rows").toEqual([]);
  expect(await entityCount(tenant.tenantId), "the next tenant's entities").toBe(0);
  expectCompletedRecord(harness, tenant.tenantId, entities);
  expect(records(harness, FAILED_EVENT, tenant.tenantId), 'no failure for it').toHaveLength(0);
}

describe('A failed purge step is visible and resumes', () => {
  it('GIVEN the Better Auth step fails after the catalog step succeeded, WHEN the purge job runs again, THEN org_deletion_failed (step auth) was logged once, the catalog step is not repeated, and the run completes the Better Auth step with entities_removed 0 (Q169)', async () => {
    const harness = registeredHarness();
    const failing = await seedDueTenant(2);
    const next = await seedDueTenant(3);

    // First run: step 2 of `failing` throws through the existing seam of `purgeAuthStep`.
    const firstFlush: number[] = [];
    await expect(
      runPurge({
        pool: await purgePool(),
        tenantIds: [failing.tenantId, next.tenantId],
        telemetry: flushingTelemetry(harness, failing.tenantId, firstFlush),
        authOptions: {
          beforeUserDeleted: (userId) => {
            if (userId === failing.userId) {
              throw new Error(SEAM_MESSAGE);
            }
          },
        },
      }),
      'the failure of one tenant does not reject the pass',
    ).resolves.toBeUndefined();

    expect(firstFlush, "the failure is exported by runScript's final flush").toEqual([1]);
    expectFailedRecord(harness, failing, 'auth');
    const afterFirst = await readMarker(failing.tenantId);
    expect(afterFirst?.state, 'the failing tenant stays pending').toBe('pending');
    expect(afterFirst?.catalog_purged_at, 'step 1 is recorded').not.toBeNull();
    expect(afterFirst?.auth_purged_at, 'step 2 is not recorded').toBeNull();
    expect(await entityCount(failing.tenantId), 'step 1 removed the entities').toBe(0);
    expect(await presentAuthRows(failing), 'step 2 was interrupted before the user').toEqual([
      'organization',
      'member',
      'user',
      'session',
    ]);
    expect(records(harness, COMPLETED_EVENT, failing.tenantId), 'not completed').toHaveLength(0);
    await expectFullyPurged(harness, next, 3);

    // A canary entity: a repeated step 1 would delete it and count it.
    await seedCatalogEntities(failing.tenantId, 1);

    // WHEN the purge job runs again, with no seam.
    const secondFlush: number[] = [];
    await runPurge({
      pool: await purgePool(),
      tenantIds: [failing.tenantId],
      telemetry: flushingTelemetry(harness, failing.tenantId, secondFlush),
    });

    expect(secondFlush, 'no new failure in the second run').toEqual([1]);
    expectFailedRecord(harness, failing, 'auth');
    const afterSecond = await readMarker(failing.tenantId);
    expect(afterSecond?.catalog_purged_at, 'catalog_purged_at is unchanged').toBe(
      afterFirst?.catalog_purged_at,
    );
    expect(await entityCount(failing.tenantId), 'step 1 is not repeated').toBe(1);
    expect(afterSecond?.state, 'the marker is purged').toBe('purged');
    expect(afterSecond?.auth_purged_at, 'step 2 is recorded').not.toBeNull();
    expect(await presentAuthRows(failing), 'the run completes the Better Auth step').toEqual([]);
    expectCompletedRecord(harness, failing.tenantId, 0);
  });

  it('a failure inside the catalog step logs org_deletion_failed with step catalog, skips step 2 for that tenant, continues with the next tenant, and the next run resumes step 1', async () => {
    const harness = registeredHarness();
    const failing = await seedDueTenant(2);
    const next = await seedDueTenant(1);

    // First run: the first table delete of the pass (the failing tenant's) throws.
    let thrown = false;
    const firstFlush: number[] = [];
    await expect(
      runPurge({
        pool: await purgePool(),
        tenantIds: [failing.tenantId, next.tenantId],
        telemetry: flushingTelemetry(harness, failing.tenantId, firstFlush),
        catalogOptions: {
          afterTableDeleted: () => {
            if (!thrown) {
              thrown = true;
              throw new Error(SEAM_MESSAGE);
            }
          },
        },
      }),
      'the failure of one tenant does not reject the pass',
    ).resolves.toBeUndefined();

    expect(thrown, 'the seam fired').toBe(true);
    expect(firstFlush, "the failure is exported by runScript's final flush").toEqual([1]);
    expectFailedRecord(harness, failing, 'catalog');
    expect(await readMarker(failing.tenantId), 'no step is recorded').toMatchObject({
      state: 'pending',
      catalog_purged_at: null,
      auth_purged_at: null,
    });
    expect(await presentAuthRows(failing), 'step 2 did not run').toEqual([
      'organization',
      'member',
      'user',
      'session',
    ]);
    expect(records(harness, COMPLETED_EVENT, failing.tenantId), 'not completed').toHaveLength(0);
    await expectFullyPurged(harness, next, 1);

    // The next run resumes step 1 and completes both steps.
    const secondFlush: number[] = [];
    await runPurge({
      pool: await purgePool(),
      tenantIds: [failing.tenantId],
      telemetry: flushingTelemetry(harness, failing.tenantId, secondFlush),
    });

    expect(secondFlush, 'no new failure in the second run').toEqual([1]);
    expect((await readMarker(failing.tenantId))?.state).toBe('purged');
    expect(await entityCount(failing.tenantId)).toBe(0);
    expect(await presentAuthRows(failing)).toEqual([]);
    expectCompletedRecord(harness, failing.tenantId, 2);
  });
});

// ---------------------------------------------------------------------------
// Task 6.5.

/** What a tenant holds before the purge job runs, to compare after it. */
async function snapshotTenant(tenant: DueTenant) {
  return {
    auth: await presentAuthRows(tenant),
    entities: await entityCount(tenant.tenantId),
    blueprints: await catalogCount('catalog_blueprint', tenant.tenantId),
    changeEvents: await catalogCount('catalog_change_event', tenant.tenantId),
    markers: await markerRows(tenant.tenantId),
  };
}

describe('A purge does not touch a tenant whose window has not passed', () => {
  it('(guard) GIVEN t1 purge date is in the future and t2 has no marker, WHEN the purge job runs (runPurge and each step directly), THEN nothing of t1 or t2 is deleted, and the purge role is refused when it tries to delete the append-only rows of either', async () => {
    const t1 = await seedDueTenant(2, 'future');
    const t2 = await seedDueTenant(2, 'none');
    await seedChangeEvents(t1.tenantId, 2);
    await seedChangeEvents(t2.tenantId, 2);
    const before = [await snapshotTenant(t1), await snapshotTenant(t2)];
    expect(before[0]?.auth, 'seeded auth rows of t1').toHaveLength(4);
    expect(before[0]?.changeEvents, 'seeded append-only rows of t1').toBe(2);
    expect(before[1]?.markers, 't2 has no marker').toEqual([]);

    const pool = await purgePool();
    await runPurge({ pool, tenantIds: [t1.tenantId, t2.tenantId] });
    for (const { tenantId } of [t1, t2]) {
      // Failing closed or returning early are both allowed: only the rows are asserted.
      await purgeCatalogStep(pool, tenantId).catch(() => undefined);
      await purgeAuthStep(pool, tenantId).catch(() => undefined);
    }

    expect(await snapshotTenant(t1), 'nothing of t1 is deleted or changed').toEqual(before[0]);
    expect(await snapshotTenant(t2), 'nothing of t2 is deleted or changed').toEqual(before[1]);

    for (const tenant of [t1, t2]) {
      const outcome = await purgeRoleDeletesChangeEvents(tenant.tenantId);
      expect(
        [0, '42501', 'P0001'],
        'the purge role deletes no append-only row (no row, or refused)',
      ).toContain(outcome);
      expect(await catalogCount('catalog_change_event', tenant.tenantId)).toBe(2);
    }
  });
});

describe('A repeated purge is safe', () => {
  it('(guard) after a completed purge the marker remains as a tombstone whose non-null columns are only the tenant id, state, the timestamps and the opaque requester id', async () => {
    const t1 = await seedDueTenant(1);
    await runPurge({ pool: await purgePool(), tenantIds: [t1.tenantId] });

    const markers = await markerRows(t1.tenantId);
    expect(markers, 'the marker row remains, not deleted').toHaveLength(1);
    const [tombstone = {}] = markers;
    expect(tombstone['state']).toBe('purged');
    const nonNull = Object.keys(tombstone)
      .filter((column) => tombstone[column] !== null)
      .sort();
    expect(nonNull, 'tenant id, state, timestamps and the opaque requested_by only').toEqual([
      'auth_purged_at',
      'catalog_purged_at',
      'purge_after',
      'requested_at',
      'requested_by',
      'state',
      'tenant_id',
    ]);
  });

  it('GIVEN t1 was already purged, WHEN the purge job runs again, THEN it deletes nothing and does not fail (runPurge resolves, no org_deletion_failed, no second completion)', async () => {
    const harness = registeredHarness();
    const t1 = await seedDueTenant(2);
    await runPurge({ pool: await purgePool(), tenantIds: [t1.tenantId] });
    expect((await readMarker(t1.tenantId))?.state, 'GIVEN t1 was already purged').toBe('purged');
    expect(records(harness, FAILED_EVENT, t1.tenantId), 'the first purge did not fail').toEqual([]);

    // Canaries: rows a repeated purge would delete.
    await seedCatalogEntities(t1.tenantId, 1);
    await seedChangeEvents(t1.tenantId, 2);
    const before = await snapshotTenant(t1);

    const atShutdown: number[] = [];
    await expect(
      runPurge({
        pool: await purgePool(),
        tenantIds: [t1.tenantId],
        telemetry: flushingTelemetry(harness, t1.tenantId, atShutdown),
      }),
      'the repeated purge resolves',
    ).resolves.toBeUndefined();

    expect(atShutdown, 'no org_deletion_failed by the final flush').toEqual([0]);
    expect(records(harness, FAILED_EVENT, t1.tenantId), 'the repeated purge does not fail').toEqual(
      [],
    );
    expect(records(harness, COMPLETED_EVENT, t1.tenantId), 'no second completion').toHaveLength(1);
    expect(await snapshotTenant(t1), 'it deletes nothing and keeps the tombstone').toEqual(before);
  });
});
