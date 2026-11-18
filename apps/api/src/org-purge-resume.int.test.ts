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
import { runPurge } from '../scripts/purge-job.js';
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

/**
 * A due tenant (pending marker, step 1 not recorded) with an organization, a
 * user who belongs only to it (with a session), and `entities` catalog entities.
 */
async function seedDueTenant(entities: number): Promise<DueTenant> {
  const tenantId = `org-${randomUUID()}`;
  const slug = `slug-${tenantId}`;
  await ownerQuery(
    'insert into auth.organization (id, name, slug, created_at) values ($1, $2, $3, now())',
    [tenantId, 'Org', slug],
  );
  await ownerQuery(
    `insert into tenant_deletion_marker (tenant_id, requested_at, purge_after, requested_by)
     values ($1, now() - interval '15 days', now() - interval '1 day', $2)`,
    [tenantId, `actor-${randomUUID()}`],
  );
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
