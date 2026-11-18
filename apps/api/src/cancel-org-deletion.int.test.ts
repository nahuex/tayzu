/**
 * Task 7.1 of openspec/changes/045-org-deletion-and-data-retention (design D3, Resolved decisions
 * Q35, Q41, Q70 and Q79; migration `0013`): the reversal script
 * `apps/api/scripts/cancel-org-deletion.ts` (`pnpm --filter @tayzu/api identity:cancel-org-deletion`).
 *
 * Scenario "A platform operator reverses a pending deletion" (the 7.1 part; the audit event, the
 * metric and the later request are task 7.2's):
 * - GIVEN `t1` has a pending deletion
 * - WHEN a platform operator runs the reversal script
 * - THEN the marker is tombstoned (never deleted), [...] and the tenant's principals are accepted
 *   again
 *
 * Scenario "A reversal is refused once the purge has begun":
 * - GIVEN `t1` has a pending marker with a purge step recorded, or whose purge date has passed
 * - WHEN a platform operator runs the reversal script
 * - THEN it refuses, the marker is unchanged, `catalog.security.org_deletion_cancel_refused` is
 *   logged with the operator's opaque id and the reason, and the database refuses the same
 *   tombstone from the reversal role
 *
 * Task 7.1 adds: the refusal event with its reason for each of the four refusals (`invalid_tenant`,
 * `no_pending_marker`, `purge_begun`, `purge_date_passed`), with the tenant attribute only when the
 * tenant id passed its shape check, flushed before the script exits; no event for a missing
 * operator id, which fails at the configuration load; the row is still present as a tombstone;
 * the script's role cannot read or delete tenant data.
 *
 * ## Production symbols expected
 *
 * ```ts
 * // apps/api/scripts/cancel-org-deletion.ts
 * export type CancelRefusalReason =
 *   | 'invalid_tenant' | 'no_pending_marker' | 'purge_begun' | 'purge_date_passed';
 * export type CancelOrgDeletionResult =
 *   | { readonly outcome: 'cancelled' }
 *   | { readonly outcome: 'refused'; readonly reason: CancelRefusalReason };
 * export interface CancelOrgDeletionOptions {
 *   // The tenant to revive, exactly as the workflow handed it over: not yet shape-checked.
 *   readonly tenantId: string;
 *   // Defaults to process.env; read through loadScriptConfig('cancel-org-deletion', env), so the
 *   // operator id is TAYZU_OPERATOR_ID (never an argument) and the only database URL is
 *   // REVERSAL_DATABASE_URL. A missing or malformed operator id rejects with the loader's
 *   // FixedMessageError before any pool is built and before any event.
 *   readonly env?: Readonly<Record<string, string | undefined>>;
 *   // A pool the host already built; when given, main does not end it. When absent, main builds
 *   // one with createPool(config.REVERSAL_DATABASE_URL) (`@tayzu/db`) and ends it.
 *   readonly pool?: Pool;
 *   // Replaces startTelemetry(env); a test seam (forwarded to runScript).
 *   readonly telemetry?: Telemetry;
 * }
 * // Runs inside runScript('cancel-org-deletion', ..., { roles: [{ pool, roles:
 * // ['tayzu_deletion_admin'] }] }), which rejects with its fixed role message under any other
 * // role. A refusal resolves { outcome: 'refused', reason } after logging WARN
 * // catalog.security.org_deletion_cancel_refused (emitIdentityEvent) inside runScript, so the
 * // final flush exports it; the CLI turns a refusal into a non-zero exit status.
 * export function main(options: CancelOrgDeletionOptions): Promise<CancelOrgDeletionResult>;
 * ```
 *
 * ## How the script reaches `tayzu_deletion_admin` here
 *
 * As in `purge-job.int.test.ts`: the role has no password in the test cluster, so `createPool` of
 * `@tayzu/db` is mocked, the injected env carries a sentinel `REVERSAL_DATABASE_URL` (and other
 * sentinels for the other database URLs), and the mock hands back the harness's
 * `getDeletionAdminTestDatabase()` pool (`SET ROLE tayzu_deletion_admin` on every connection) for
 * the sentinel only. `DATABASE_URL` is never printed. Markers are seeded and read through the
 * owner pool. Every tenant id and operator id is random per test, and every telemetry assertion is
 * scoped to the test's operator id (or, with no operator id, to counts taken around the run).
 *
 * ## Why this fails right now
 *
 * `apps/api/scripts/cancel-org-deletion.ts` is the empty module of task 1.2: it exports no `main`.
 */
// Load-bearing import order (design D1 of `043`): the telemetry harness registers before anything
// that loads `@tayzu/auth` creates its logger.
import { registration, type TelemetryTestHarness } from './__fixtures__/link-telemetry.js';
import { randomInt, randomUUID } from 'node:crypto';

import { authSchema, createAuth, createTenantDeletionLookup } from '@tayzu/auth';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg, { type Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import {
  getDeletionAdminTestDatabase,
  getOwnerPool,
  getTestDatabase,
} from '../../../packages/db/src/harness.js';
import { main } from '../scripts/cancel-org-deletion.js';
import { createAuthRepository } from './identity/auth-repository.js';
import { DEFAULT_ORG_DELETION_WINDOW_DAYS, requestOrgDeletion } from './identity/org-deletion.js';
import type { Telemetry } from './telemetry.js';

const createPoolMock = vi.hoisted(() => vi.fn<(url: string) => Pool>());

vi.mock('@tayzu/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tayzu/db')>()),
  createPool: createPoolMock,
}));

const REFUSED_EVENT = 'catalog.security.org_deletion_cancel_refused';
const CANCELLED_EVENT = 'catalog.audit.org_deletion_cancelled';
const ROLE_MESSAGE = 'script database role is not one of its declared roles';

const REVERSAL_URL_SENTINEL =
  'postgres://tayzu_deletion_admin@reversal.invalid:5432/tayzu?sslmode=verify-full';
const PURGE_URL_SENTINEL = 'postgres://tayzu_purge@purge.invalid:5432/tayzu?sslmode=verify-full';
const APP_URL_SENTINEL = 'postgres://tayzu_app@app.invalid:5432/tayzu?sslmode=verify-full';
const AUTH_URL_SENTINEL = 'postgres://tayzu_auth@auth.invalid:5432/tayzu?sslmode=verify-full';

/** A fresh `gh:<numeric actor id>` (Q70), the shape the maintenance workflow derives. */
function randomOperatorId(): string {
  return `gh:${String(randomInt(1, 1_000_000_000_000))}`;
}

/** The script's environment; `operatorId: null` leaves `TAYZU_OPERATOR_ID` unset. */
function envFor(operatorId: string | null): Readonly<Record<string, string>> {
  return {
    REVERSAL_DATABASE_URL: REVERSAL_URL_SENTINEL,
    PURGE_DATABASE_URL: PURGE_URL_SENTINEL,
    DATABASE_URL: APP_URL_SENTINEL,
    AUTH_DATABASE_URL: AUTH_URL_SENTINEL,
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
    ...(operatorId === null ? {} : { TAYZU_OPERATOR_ID: operatorId }),
  };
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
// Pools.

/** `pool` as the script sees it: `end` leaves the shared harness pool open. */
function sharedPool(pool: Pool): Pool {
  return new Proxy(pool, {
    get(target, property): unknown {
      if (property === 'end') {
        return async (): Promise<void> => undefined;
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

async function deletionAdminPool(): Promise<Pool> {
  return (await getDeletionAdminTestDatabase()).pool;
}

/** The mock hands the given pool back for `REVERSAL_DATABASE_URL` only. */
function buildPoolsFrom(pool: Pool): void {
  createPoolMock.mockImplementation((url: string) => {
    if (url !== REVERSAL_URL_SENTINEL) {
      throw new Error('the reversal built a pool from a URL other than REVERSAL_DATABASE_URL');
    }
    return sharedPool(pool);
  });
}

// ---------------------------------------------------------------------------
// Markers, seeded and read through the owner pool.

type SeededMarker = 'pending' | 'purge_begun' | 'purge_date_passed' | 'cancelled' | 'none';

const SEED_SQL: Readonly<Record<Exclude<SeededMarker, 'none'>, string>> = {
  pending: `insert into tenant_deletion_marker (tenant_id, requested_at, purge_after, requested_by)
            values ($1, now(), now() + interval '10 days', $2)`,
  // Step 1 recorded, date still in the future.
  purge_begun: `insert into tenant_deletion_marker
                  (tenant_id, requested_at, purge_after, requested_by, catalog_purged_at)
                values ($1, now() - interval '1 day', now() + interval '9 days', $2,
                        now() - interval '1 hour')`,
  // No step recorded, date passed.
  purge_date_passed: `insert into tenant_deletion_marker
                        (tenant_id, requested_at, purge_after, requested_by)
                      values ($1, now() - interval '15 days', now() - interval '1 day', $2)`,
  // An earlier reversal's tombstone, and no pending marker.
  cancelled: `insert into tenant_deletion_marker
                (tenant_id, requested_at, purge_after, requested_by, state, cancelled_at,
                 cancelled_by)
              values ($1, now() - interval '2 days', now() + interval '8 days', $2, 'cancelled',
                      now() - interval '1 day', $3)`,
};

async function seedMarker(tenantId: string, marker: SeededMarker): Promise<void> {
  if (marker === 'none') return;
  const params =
    marker === 'cancelled'
      ? [tenantId, `usr-${randomUUID()}`, randomOperatorId()]
      : [tenantId, `usr-${randomUUID()}`];
  await (await getOwnerPool()).query(SEED_SQL[marker], params);
}

interface MarkerRow {
  readonly state: string;
  readonly requested_at: string;
  readonly purge_after: string;
  readonly requested_by: string;
  readonly catalog_purged_at: string | null;
  readonly auth_purged_at: string | null;
  readonly cancelled_at: string | null;
  readonly cancelled_by: string | null;
}

/** Every marker row of the tenant, every column, in a stable order. */
async function markerRows(tenantId: string): Promise<readonly MarkerRow[]> {
  const { rows } = await (
    await getOwnerPool()
  ).query<MarkerRow>(
    `select state, requested_at::text as requested_at, purge_after::text as purge_after,
            requested_by, catalog_purged_at::text as catalog_purged_at,
            auth_purged_at::text as auth_purged_at, cancelled_at::text as cancelled_at,
            cancelled_by
       from tenant_deletion_marker where tenant_id = $1
      order by requested_at, state`,
    [tenantId],
  );
  return rows;
}

async function ownerNow(): Promise<string> {
  const { rows } = await (
    await getOwnerPool()
  ).query<{ now: string }>('select clock_timestamp()::text as now');
  const [row] = rows;
  if (row === undefined) throw new Error('select clock_timestamp() returned no row');
  return row.now;
}

/** True when `at` lies between `from` and `to` (timestamptz text, compared by the database). */
async function isBetween(at: string, from: string, to: string): Promise<boolean> {
  const { rows } = await (
    await getOwnerPool()
  ).query<{ between: boolean }>(
    'select $1::timestamptz between $2::timestamptz and $3::timestamptz as between',
    [at, from, to],
  );
  return rows[0]?.between === true;
}

/**
 * The tenant-deletion lookup of `045` D4 (`@tayzu/auth`), the check the context resolver and the
 * token exchange make: `true` means the tenant's principals are rejected. A fresh lookup on each
 * call (the lookup itself has no cache; the resolver's 5-second cache is not involved).
 */
async function isClosed(tenantId: string): Promise<boolean> {
  const { pool } = await getTestDatabase();
  return await createTenantDeletionLookup(pool)(tenantId);
}

/** Malformed tenant ids this file seeded markers for, removed in `afterAll`. */
const malformedSeeded = new Set<string>();

// ---------------------------------------------------------------------------
// Telemetry.

interface Flush {
  /** `runScript`'s final flush, counted. */
  readonly telemetry: Telemetry;
  /** At each shutdown, the refusal records of the operator already exported. */
  readonly refusalsAtShutdown: number[];
}

function refusalRecords(harness: TelemetryTestHarness, operatorId: string) {
  return harness.logExporter
    .getFinishedLogRecords()
    .filter(
      (record) =>
        record.eventName === REFUSED_EVENT &&
        record.attributes['tayzu.identity.operator.id'] === operatorId,
    );
}

function flushingTelemetry(harness: TelemetryTestHarness, operatorId: string): Flush {
  const refusalsAtShutdown: number[] = [];
  return {
    refusalsAtShutdown,
    telemetry: {
      shutdown: async () => {
        await harness.forceFlush();
        refusalsAtShutdown.push(refusalRecords(harness, operatorId).length);
      },
    },
  };
}

/** Records of the reversal's two events, counted over the whole exporter. */
async function reversalEventCount(harness: TelemetryTestHarness): Promise<number> {
  await harness.forceFlush();
  return harness.logExporter
    .getFinishedLogRecords()
    .filter((record) => record.eventName === REFUSED_EVENT || record.eventName === CANCELLED_EVENT)
    .length;
}

/**
 * Exactly one WARN refusal record for the operator, with exactly the declared attributes:
 * `tenantId` present only when it passed its shape check (`undefined` here means absent).
 */
async function expectRefusalRecord(
  harness: TelemetryTestHarness,
  operatorId: string,
  reason: string,
  tenantId: string | undefined,
): Promise<void> {
  await harness.forceFlush();
  const records = refusalRecords(harness, operatorId);
  expect(records, `exactly one ${REFUSED_EVENT} for this operator`).toHaveLength(1);
  const [record] = records;
  expect(record?.severityText, 'the declared severity').toBe('WARN');
  expect(record?.attributes, 'exactly the declared attributes').toEqual({
    'tayzu.identity.operator.id': operatorId,
    'tayzu.identity.org_deletion.cancel_refusal': reason,
    ...(tenantId === undefined ? {} : { 'tayzu.tenant.id': tenantId }),
  });
  expect(record?.body, 'no body: no free text').toBeUndefined();
}

async function runReversal(
  tenantId: string,
  env: Readonly<Record<string, string>>,
  telemetry: Telemetry,
): Promise<{ readonly result?: unknown; readonly error?: unknown }> {
  return await main({ tenantId, env, telemetry }).then(
    (result: unknown) => ({ result }),
    (error: unknown) => ({ error }),
  );
}

// ---------------------------------------------------------------------------

describe('the reversal script cancel-org-deletion (task 7.1)', () => {
  beforeAll(async () => {
    await getOwnerPool();
    await getTestDatabase();
    await deletionAdminPool();
  }, 120_000);

  afterEach(() => {
    vi.restoreAllMocks();
    createPoolMock.mockReset();
  });

  afterAll(async () => {
    const owner = await getOwnerPool();
    for (const tenantId of malformedSeeded) {
      await owner.query('delete from tenant_deletion_marker where tenant_id = $1', [tenantId]);
    }
  });

  describe('A reversal is refused once the purge has begun', () => {
    it.each([
      { marker: 'purge_begun', reason: 'purge_begun', given: 'a purge step recorded' },
      {
        marker: 'purge_date_passed',
        reason: 'purge_date_passed',
        given: 'a purge date that has passed',
      },
    ] as const)(
      'a pending marker with $given: the script refuses with $reason, the marker is unchanged, the refusal is logged with the operator id, the tenant and the reason and flushed before exit, and the database refuses the same tombstone from the reversal role',
      async ({ marker, reason }) => {
        const harness = registeredHarness();
        const tenantId = `org-${randomUUID()}`;
        const operatorId = randomOperatorId();
        await seedMarker(tenantId, marker);
        const before = await markerRows(tenantId);
        expect(before, 'one pending marker seeded').toHaveLength(1);
        expect(await isClosed(tenantId), 'the tenant is closed before the run').toBe(true);
        buildPoolsFrom(await deletionAdminPool());
        const flush = flushingTelemetry(harness, operatorId);

        const { result, error } = await runReversal(tenantId, envFor(operatorId), flush.telemetry);

        expect(error, 'a refusal is a result, not a crash').toBeUndefined();
        expect(result, 'the script refuses with the reason').toEqual({
          outcome: 'refused',
          reason,
        });
        expect(createPoolMock.mock.calls, 'one pool, from REVERSAL_DATABASE_URL only').toEqual([
          [REVERSAL_URL_SENTINEL],
        ]);
        expect(await markerRows(tenantId), 'the marker is unchanged').toEqual(before);
        expect(await isClosed(tenantId), 'the tenant stays closed').toBe(true);
        expect(
          flush.refusalsAtShutdown,
          "runScript's final flush ran once, with the refusal already emitted",
        ).toEqual([1]);
        await expectRefusalRecord(harness, operatorId, reason, tenantId);

        // AND the database refuses the same tombstone from the reversal role.
        const tombstone = await (
          await deletionAdminPool()
        ).query(
          `update tenant_deletion_marker
              set state = 'cancelled', cancelled_at = now(), cancelled_by = $2
            where tenant_id = $1 and state = 'pending'`,
          [tenantId, operatorId],
        );
        expect(tombstone.rowCount, 'the reversal role tombstones no row').toBe(0);
        expect(await markerRows(tenantId), 'the marker is still unchanged').toEqual(before);
      },
    );
  });

  describe('every refusal logs catalog.security.org_deletion_cancel_refused with its reason', () => {
    it.each([
      { case: 'no marker at all', marker: 'none' },
      { case: 'only an earlier tombstone', marker: 'cancelled' },
    ] as const)(
      'no_pending_marker ($case): the script refuses, the refusal carries the operator id, the tenant and the reason, and nothing changes',
      async ({ marker }) => {
        const harness = registeredHarness();
        const tenantId = `org-${randomUUID()}`;
        const operatorId = randomOperatorId();
        await seedMarker(tenantId, marker);
        const before = await markerRows(tenantId);
        buildPoolsFrom(await deletionAdminPool());
        const flush = flushingTelemetry(harness, operatorId);

        const { result, error } = await runReversal(tenantId, envFor(operatorId), flush.telemetry);

        expect(error, 'a refusal is a result, not a crash').toBeUndefined();
        expect(result).toEqual({ outcome: 'refused', reason: 'no_pending_marker' });
        expect(await markerRows(tenantId), 'no marker is written or changed').toEqual(before);
        expect(await isClosed(tenantId), 'the tenant stays open').toBe(false);
        expect(flush.refusalsAtShutdown, 'flushed before the script exits').toEqual([1]);
        await expectRefusalRecord(harness, operatorId, 'no_pending_marker', tenantId);
      },
    );

    it.each([
      { case: 'characters outside the pattern', make: () => `org/${randomUUID()}'; --` },
      {
        case: 'longer than 64 characters',
        make: () => `t${randomUUID().replaceAll('-', '')}${'a'.repeat(32)}`,
      },
      { case: 'empty', make: () => '' },
    ])(
      'invalid_tenant ($case): the script refuses with no tenant attribute, the malformed id reaches no signal, and a marker stored under that id is unchanged',
      async ({ make }) => {
        const harness = registeredHarness();
        const tenantId = make();
        expect(/^[A-Za-z0-9_-]{1,64}$/.test(tenantId), 'the fixture is malformed').toBe(false);
        const operatorId = randomOperatorId();
        if (tenantId !== '') {
          // A pending marker stored under the malformed id: a script that skipped the shape check
          // would tombstone it.
          malformedSeeded.add(tenantId);
          await seedMarker(tenantId, 'pending');
        }
        const before = await markerRows(tenantId);
        buildPoolsFrom(await deletionAdminPool());
        const flush = flushingTelemetry(harness, operatorId);

        const { result, error } = await runReversal(tenantId, envFor(operatorId), flush.telemetry);

        expect(error, 'a refusal is a result, not a crash').toBeUndefined();
        expect(result).toEqual({ outcome: 'refused', reason: 'invalid_tenant' });
        expect(await markerRows(tenantId), 'the marker is unchanged').toEqual(before);
        expect(flush.refusalsAtShutdown, 'flushed before the script exits').toEqual([1]);
        await expectRefusalRecord(harness, operatorId, 'invalid_tenant', undefined);
        if (tenantId !== '') {
          const serialized = JSON.stringify(
            harness.logExporter
              .getFinishedLogRecords()
              .map((record) => ({ body: record.body, attributes: record.attributes })),
          );
          expect(serialized.includes(tenantId), 'the malformed id reaches no log record').toBe(
            false,
          );
        }
      },
    );
  });

  describe('the script refuses to run with no operator id, at the configuration load', () => {
    it.each([
      { case: 'unset', operatorId: null },
      { case: 'blank', operatorId: '   ' },
      { case: 'an email instead of an opaque id', operatorId: `ops-${randomUUID()}@example.test` },
    ])(
      'TAYZU_OPERATOR_ID $case: main rejects naming only the variable, builds no pool, emits no event, and the pending marker is unchanged',
      async ({ operatorId }) => {
        const harness = registeredHarness();
        const tenantId = `org-${randomUUID()}`;
        await seedMarker(tenantId, 'pending');
        const before = await markerRows(tenantId);
        buildPoolsFrom(await deletionAdminPool());
        const eventsBefore = await reversalEventCount(harness);
        const shutdowns: number[] = [];
        const telemetry: Telemetry = {
          shutdown: async () => {
            await harness.forceFlush();
            shutdowns.push(1);
          },
        };

        const { result, error } = await runReversal(tenantId, envFor(operatorId), telemetry);

        expect(result, 'the script does not run').toBeUndefined();
        expect(error).toBeInstanceOf(Error);
        const { message } = error as Error;
        expect(message, 'the error names the variable').toMatch(/TAYZU_OPERATOR_ID/);
        if (operatorId !== null && operatorId.trim() !== '') {
          expect(message.includes(operatorId), 'the error carries no value').toBe(false);
        }
        expect(message.includes(tenantId), 'the error carries no tenant').toBe(false);
        expect(createPoolMock, 'no pool is built').not.toHaveBeenCalled();
        expect(await reversalEventCount(harness), 'no reversal event is emitted').toBe(
          eventsBefore,
        );
        const tenantRecords = harness.logExporter
          .getFinishedLogRecords()
          .filter((record) => record.attributes['tayzu.tenant.id'] === tenantId);
        expect(tenantRecords, 'no record names the tenant').toEqual([]);
        expect(shutdowns.length, 'no telemetry was started, so none is flushed').toBe(0);
        expect(await markerRows(tenantId), 'the marker is unchanged').toEqual(before);
        expect(await isClosed(tenantId), 'the tenant stays closed').toBe(true);
      },
    );
  });

  describe('A platform operator reverses a pending deletion', () => {
    it("tombstones the pending marker with cancelled_at and the operator's id from the environment, keeps the row, runs only as tayzu_deletion_admin, logs no refusal, and the tenant's principals are accepted again", async () => {
      const harness = registeredHarness();
      const tenantId = `org-${randomUUID()}`;
      const operatorId = randomOperatorId();
      await seedMarker(tenantId, 'pending');
      const [before] = await markerRows(tenantId);
      if (before === undefined) throw new Error('the pending marker was not seeded');
      // GIVEN the tenant has a pending deletion: its principals are rejected.
      expect(await isClosed(tenantId), 'the pending tenant is closed before the run').toBe(true);
      const adminPool = await deletionAdminPool();
      await adminPool.query('select 1');
      buildPoolsFrom(adminPool);
      const flush = flushingTelemetry(harness, operatorId);
      const startedAt = await ownerNow();
      const queries = vi.spyOn(pg.Client.prototype, 'query');

      const { result, error } = await runReversal(tenantId, envFor(operatorId), flush.telemetry);

      const roles = await rolesOfQueriedClients(queries);
      const endedAt = await ownerNow();
      expect(error, 'the reversal succeeds').toBeUndefined();
      expect(result).toEqual({ outcome: 'cancelled' });
      expect(createPoolMock.mock.calls, 'one pool, from REVERSAL_DATABASE_URL only').toEqual([
        [REVERSAL_URL_SENTINEL],
      ]);
      expect(roles.length, 'the script ran its queries on a database connection').toBeGreaterThan(
        0,
      );
      expect(
        new Set(roles),
        'every connection the script queried runs as tayzu_deletion_admin',
      ).toEqual(new Set(['tayzu_deletion_admin']));
      expect(flush.refusalsAtShutdown, "runScript's final flush ran once, with no refusal").toEqual(
        [0],
      );

      // THEN the marker is tombstoned (never deleted): one row, `cancelled`, stamped with the
      // operator of the environment, every other column as it was.
      const after = await markerRows(tenantId);
      expect(after, 'the row is still present, and no other row is written').toHaveLength(1);
      const [tombstone] = after;
      expect(tombstone).toEqual({
        ...before,
        state: 'cancelled',
        cancelled_at: expect.any(String) as unknown,
        cancelled_by: operatorId,
      });
      expect(
        await isBetween(tombstone?.cancelled_at ?? '', startedAt, endedAt),
        'cancelled_at is the time of this run',
      ).toBe(true);

      // AND the tenant's principals are accepted again.
      expect(await isClosed(tenantId), 'the tenant is open after the reversal').toBe(false);
    });

    it('the script refuses to run as a role other than tayzu_deletion_admin (tayzu_app, which passes assertRuntimeRole), and the marker is unchanged', async () => {
      const harness = registeredHarness();
      const tenantId = `org-${randomUUID()}`;
      const operatorId = randomOperatorId();
      await seedMarker(tenantId, 'pending');
      const before = await markerRows(tenantId);
      buildPoolsFrom((await getTestDatabase()).pool);
      const flush = flushingTelemetry(harness, operatorId);

      const { result, error } = await runReversal(tenantId, envFor(operatorId), flush.telemetry);

      expect(result, 'the script does not run').toBeUndefined();
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message, 'the fixed role message').toBe(ROLE_MESSAGE);
      expect(await markerRows(tenantId), 'the marker is unchanged').toEqual(before);
      expect(await isClosed(tenantId), 'the tenant stays closed').toBe(true);
    });

    describe("the script's role cannot read or delete tenant data", () => {
      async function seedTenantData(tenantId: string): Promise<{ memberId: string }> {
        const owner = await getOwnerPool();
        await owner.query(
          'insert into auth.organization (id, name, slug, created_at) values ($1, $2, $3, now())',
          [tenantId, 'Org', `slug-${tenantId}`],
        );
        const userId = `user-${randomUUID()}`;
        await owner.query(
          `insert into auth."user" (id, name, email, email_verified, created_at, updated_at)
           values ($1, 'User', $2, true, now(), now())`,
          [userId, `${userId}@example.test`],
        );
        const memberId = `member-${randomUUID()}`;
        await owner.query(
          `insert into auth.member (id, organization_id, user_id, role, created_at)
           values ($1, $2, $3, 'member', now())`,
          [memberId, tenantId, userId],
        );
        const actorId = `actor-${randomUUID()}`;
        const blueprintId = randomUUID();
        await owner.query(
          `insert into catalog_blueprint
             (id, tenant_id, identifier, title, schema, version, created_at, created_by_type,
              created_by_id, updated_at, updated_by_type, updated_by_id)
           values ($1, $2, $3, '"Service"'::jsonb, '{}'::jsonb, 1, now(), 'user', $4,
                   now(), 'user', $4)`,
          [blueprintId, tenantId, `service-${randomUUID()}`, actorId],
        );
        await owner.query(
          `insert into catalog_entity
             (id, tenant_id, blueprint_id, identifier, title, spec_properties, generation, version,
              created_at, created_by_type, created_by_id, updated_at, updated_by_type,
              updated_by_id)
           values ($1, $2, $3, $4, $4, '{}'::jsonb, 1, 1, now(), 'user', $5, now(), 'user', $5)`,
          [randomUUID(), tenantId, blueprintId, `entity-${randomUUID()}`, actorId],
        );
        return { memberId };
      }

      async function ownerCounts(
        tenantId: string,
      ): Promise<{ entities: number; blueprints: number; members: number; markers: number }> {
        const { rows } = await (
          await getOwnerPool()
        ).query<{ entities: number; blueprints: number; members: number; markers: number }>(
          `select (select count(*)::int from catalog_entity where tenant_id = $1) as entities,
                  (select count(*)::int from catalog_blueprint where tenant_id = $1) as blueprints,
                  (select count(*)::int from auth.member where organization_id = $1) as members,
                  (select count(*)::int from tenant_deletion_marker where tenant_id = $1)
                    as markers`,
          [tenantId],
        );
        return rows[0] ?? { entities: -1, blueprints: -1, members: -1, markers: -1 };
      }

      it.each([
        { what: 'read catalog_entity', sql: 'select id from catalog_entity where tenant_id = $1' },
        {
          what: 'delete catalog_entity',
          sql: 'delete from catalog_entity where tenant_id = $1',
        },
        {
          what: 'read catalog_blueprint',
          sql: 'select id from catalog_blueprint where tenant_id = $1',
        },
        {
          what: 'delete catalog_change_event',
          sql: 'delete from catalog_change_event where tenant_id = $1',
        },
        {
          what: 'read auth.member',
          sql: 'select id from auth.member where organization_id = $1',
        },
        {
          what: 'delete auth.member',
          sql: 'delete from auth.member where organization_id = $1',
        },
        {
          what: 'delete auth.organization',
          sql: 'delete from auth.organization where id = $1',
        },
        {
          what: 'delete the tombstone itself',
          sql: 'delete from tenant_deletion_marker where tenant_id = $1',
        },
      ])(
        'after a reversal, tayzu_deletion_admin cannot $what: permission denied, and every row stays',
        async ({ sql }) => {
          const harness = registeredHarness();
          const tenantId = `org-${randomUUID()}`;
          const operatorId = randomOperatorId();
          await seedTenantData(tenantId);
          await seedMarker(tenantId, 'pending');
          buildPoolsFrom(await deletionAdminPool());
          const reversal = await runReversal(
            tenantId,
            envFor(operatorId),
            flushingTelemetry(harness, operatorId).telemetry,
          );
          expect(reversal.result, 'the reversal ran first').toEqual({ outcome: 'cancelled' });
          const counts = await ownerCounts(tenantId);
          expect(counts).toEqual({ entities: 1, blueprints: 1, members: 1, markers: 1 });

          const denied: unknown = await (await deletionAdminPool()).query(sql, [tenantId]).then(
            () => undefined,
            (reason: unknown) => reason,
          );

          expect(denied, 'the statement is refused').toBeDefined();
          expect((denied as { code?: unknown }).code, 'insufficient_privilege (42501)').toBe(
            '42501',
          );
          expect(await ownerCounts(tenantId), 'every row stays').toEqual(counts);
        },
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Task 7.2: the audit event, the metric and the later request.
//
// Scenario "A platform operator reverses a pending deletion" (the 7.2 part):
// - THEN [...] `catalog.audit.org_deletion_cancelled` is logged with the operator's opaque id
// - AND a later deletion request creates a new marker
//
// Design "Log events": `catalog.audit.org_deletion_cancelled`, INFO, attributes `tayzu.tenant.id`
// and `tayzu.identity.operator.id`. Design "Metrics": `tayzu.identity.org_deletions`, Counter,
// `{deletion}`, attribute `tayzu.identity.org_deletion.outcome` (`requested`|`completed`|
// `failed`|`cancelled`). "the organization's name, email and tokens are never attributes on any
// signal". Task 7.2: the event is flushed before the script exits (`043` task 2.0), with the
// operator's opaque id; the counter is incremented with outcome `cancelled`.
//
// The harness collects metrics with delta temporality, so a run's increments are the points of
// the exports appended after the run started. Tests of this file run sequentially, and every
// run starts from a flushed harness.

const DELETIONS_COUNTER = 'tayzu.identity.org_deletions';
const OUTCOME_ATTRIBUTE = 'tayzu.identity.org_deletion.outcome';
const REQUESTED_EVENT = 'catalog.audit.org_deletion_requested';
const REPEATED_EVENT = 'catalog.security.org_deletion_repeated';
/** `DataPointType.SUM` of `@opentelemetry/sdk-metrics`, not a dependency of this app. */
const METRIC_DATA_POINT_TYPE_SUM = 3;

interface CounterPoint {
  readonly unit: string;
  /** `DataPointType` of the export: `SUM` (3) for a counter. */
  readonly dataPointType: unknown;
  /** `isMonotonic` of a sum: `true` for a counter. */
  readonly monotonic: unknown;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly value: unknown;
}

/** Every point of `tayzu.identity.org_deletions` in the exports from index `fromExport` on. */
function deletionCounterPoints(
  harness: TelemetryTestHarness,
  fromExport: number,
): readonly CounterPoint[] {
  const points: CounterPoint[] = [];
  for (const resourceMetrics of harness.metricExporter.getMetrics().slice(fromExport)) {
    for (const scopeMetrics of resourceMetrics.scopeMetrics) {
      for (const metric of scopeMetrics.metrics) {
        if (metric.descriptor.name !== DELETIONS_COUNTER) continue;
        for (const point of metric.dataPoints) {
          points.push({
            unit: metric.descriptor.unit,
            dataPointType: metric.dataPointType,
            monotonic: 'isMonotonic' in metric ? metric.isMonotonic : undefined,
            attributes: point.attributes,
            value: point.value,
          });
        }
      }
    }
  }
  return points;
}

/** The `cancelled` increments exported from index `fromExport` on. */
function cancelledIncrements(harness: TelemetryTestHarness, fromExport: number): number {
  return deletionCounterPoints(harness, fromExport)
    .filter((point) => point.attributes[OUTCOME_ATTRIBUTE] === 'cancelled')
    .reduce((sum, point) => sum + (typeof point.value === 'number' ? point.value : Number.NaN), 0);
}

/** The cancellation records naming the tenant or the operator, over the whole exporter. */
function cancelledRecords(harness: TelemetryTestHarness, tenantId: string, operatorId: string) {
  return harness.logExporter
    .getFinishedLogRecords()
    .filter(
      (record) =>
        record.eventName === CANCELLED_EVENT &&
        (record.attributes['tayzu.tenant.id'] === tenantId ||
          record.attributes['tayzu.identity.operator.id'] === operatorId),
    );
}

interface AuditFlush {
  /** `runScript`'s final flush, observed. */
  readonly telemetry: Telemetry;
  /** The index of the first metric export of this run. */
  readonly fromExport: number;
  /** At each shutdown, the cancellation records of the tenant or operator already exported. */
  readonly cancelledAtShutdown: number[];
  /** At each shutdown, the `cancelled` increments of this run already exported. */
  readonly incrementsAtShutdown: number[];
}

/** Flushes whatever earlier tests left pending, then observes this run's final flush. */
async function auditFlushingTelemetry(
  harness: TelemetryTestHarness,
  tenantId: string,
  operatorId: string,
): Promise<AuditFlush> {
  await harness.forceFlush();
  const fromExport = harness.metricExporter.getMetrics().length;
  const cancelledAtShutdown: number[] = [];
  const incrementsAtShutdown: number[] = [];
  return {
    fromExport,
    cancelledAtShutdown,
    incrementsAtShutdown,
    telemetry: {
      shutdown: async () => {
        await harness.forceFlush();
        cancelledAtShutdown.push(cancelledRecords(harness, tenantId, operatorId).length);
        incrementsAtShutdown.push(cancelledIncrements(harness, fromExport));
      },
    },
  };
}

describe('the reversal script cancel-org-deletion (task 7.2)', () => {
  beforeAll(async () => {
    await getOwnerPool();
    await getTestDatabase();
    await deletionAdminPool();
  }, 120_000);

  afterEach(() => {
    vi.restoreAllMocks();
    createPoolMock.mockReset();
  });

  describe('A platform operator reverses a pending deletion', () => {
    it("logs catalog.audit.org_deletion_cancelled at INFO with exactly the tenant and the operator's opaque id from TAYZU_OPERATOR_ID, no email and no free text, flushed before main resolves", async () => {
      const harness = registeredHarness();
      const tenantId = `org-${randomUUID()}`;
      const operatorId = randomOperatorId();
      await seedMarker(tenantId, 'pending');
      buildPoolsFrom(await deletionAdminPool());
      const flush = await auditFlushingTelemetry(harness, tenantId, operatorId);

      const { result, error } = await runReversal(tenantId, envFor(operatorId), flush.telemetry);

      expect(error, 'the reversal succeeds').toBeUndefined();
      expect(result).toEqual({ outcome: 'cancelled' });
      expect(
        flush.cancelledAtShutdown,
        "runScript's final flush ran once, with the cancellation already emitted",
      ).toEqual([1]);

      await harness.forceFlush();
      const records = cancelledRecords(harness, tenantId, operatorId);
      expect(records, `exactly one ${CANCELLED_EVENT} for this tenant and operator`).toHaveLength(
        1,
      );
      const [record] = records;
      expect(record?.severityText, 'the declared severity').toBe('INFO');
      expect(record?.attributes, 'exactly the declared attributes').toEqual({
        'tayzu.tenant.id': tenantId,
        'tayzu.identity.operator.id': operatorId,
      });
      expect(record?.body, 'no body: no free text').toBeUndefined();
      const values = Object.values(record?.attributes ?? {}).map((value) => JSON.stringify(value));
      expect(
        values.filter((value) => value.includes('@')),
        'no attribute value is an email',
      ).toEqual([]);
    });

    it('increments tayzu.identity.org_deletions ({deletion}) by 1 with outcome cancelled and no other attribute, flushed before main resolves', async () => {
      const harness = registeredHarness();
      const tenantId = `org-${randomUUID()}`;
      const operatorId = randomOperatorId();
      await seedMarker(tenantId, 'pending');
      buildPoolsFrom(await deletionAdminPool());
      const flush = await auditFlushingTelemetry(harness, tenantId, operatorId);

      const { result, error } = await runReversal(tenantId, envFor(operatorId), flush.telemetry);

      expect(error, 'the reversal succeeds').toBeUndefined();
      expect(result).toEqual({ outcome: 'cancelled' });
      expect(
        flush.incrementsAtShutdown,
        "runScript's final flush ran once, with the increment already exported",
      ).toEqual([1]);

      await harness.forceFlush();
      expect(cancelledIncrements(harness, flush.fromExport), 'one cancelled deletion').toBe(1);
      const points = deletionCounterPoints(harness, flush.fromExport);
      expect(points.length, 'the counter was exported').toBeGreaterThan(0);
      for (const point of points) {
        expect(point.dataPointType, 'a sum (DataPointType.SUM)').toBe(METRIC_DATA_POINT_TYPE_SUM);
        expect(point.monotonic, 'a monotonic sum: a counter').toBe(true);
        expect(point.unit, 'the declared unit').toBe('{deletion}');
        expect(point.attributes, 'outcome cancelled is the only attribute').toEqual({
          [OUTCOME_ATTRIBUTE]: 'cancelled',
        });
      }
    });

    it.each([
      { case: 'no pending marker', marker: 'none', reason: 'no_pending_marker', valid: true },
      { case: 'a purge step recorded', marker: 'purge_begun', reason: 'purge_begun', valid: true },
      {
        case: 'a purge date that has passed',
        marker: 'purge_date_passed',
        reason: 'purge_date_passed',
        valid: true,
      },
      { case: 'a malformed tenant id', marker: 'none', reason: 'invalid_tenant', valid: false },
    ] as const)(
      'a refusal ($case) logs no catalog.audit.org_deletion_cancelled and no cancelled increment',
      async ({ marker, reason, valid }) => {
        const harness = registeredHarness();
        const tenantId = valid ? `org-${randomUUID()}` : `org/${randomUUID()}`;
        const operatorId = randomOperatorId();
        await seedMarker(tenantId, marker);
        buildPoolsFrom(await deletionAdminPool());
        const flush = await auditFlushingTelemetry(harness, tenantId, operatorId);

        const { result, error } = await runReversal(tenantId, envFor(operatorId), flush.telemetry);

        expect(error, 'a refusal is a result, not a crash').toBeUndefined();
        expect(result).toEqual({ outcome: 'refused', reason });
        await harness.forceFlush();
        expect(
          cancelledRecords(harness, tenantId, operatorId),
          `no ${CANCELLED_EVENT} for this tenant or operator`,
        ).toEqual([]);
        expect(cancelledIncrements(harness, flush.fromExport), 'no cancelled increment').toBe(0);
      },
    );

    it('AND a later deletion request creates a new marker: after the reversal, the request path inserts a new pending marker, logs it as a new request, closes the tenant again, and the tombstone stays', async () => {
      const harness = registeredHarness();
      const tenantId = `org-${randomUUID()}`;
      const operatorId = randomOperatorId();
      const adminId = `usr-${randomUUID()}`;
      await seedMarker(tenantId, 'pending');
      buildPoolsFrom(await deletionAdminPool());
      const reversal = await runReversal(
        tenantId,
        envFor(operatorId),
        flushingTelemetry(harness, operatorId).telemetry,
      );
      expect(reversal.result, 'the reversal ran first').toEqual({ outcome: 'cancelled' });
      const [tombstone, ...others] = await markerRows(tenantId);
      expect(others, 'one row after the reversal').toEqual([]);
      expect(tombstone?.state, 'the row is a tombstone').toBe('cancelled');
      expect(await isClosed(tenantId), 'the tenant is open after the reversal').toBe(false);

      // WHEN the deletion is requested again, through phase 1 of the request path.
      const authPool = await getOwnerPool();
      const cancelledInvitations: string[] = [];
      const requested = await requestOrgDeletion({
        tenantId,
        actorId: adminId,
        confirmation: tenantId,
        windowDays: DEFAULT_ORG_DELETION_WINDOW_DAYS,
        auth: createAuth({ db: drizzle(authPool, { schema: authSchema }), secret: TEST_SECRET }),
        appPool: (await getTestDatabase()).pool,
        authRepository: createAuthRepository(authPool),
        cancelInvitation: async (invitationId) => {
          cancelledInvitations.push(invitationId);
        },
      });

      // THEN two rows: the tombstone, unchanged, and a new pending marker of this request.
      const rows = await markerRows(tenantId);
      expect(rows, 'the tombstone and one new marker').toHaveLength(2);
      expect(rows.filter((row) => row.state === 'cancelled')).toEqual([tombstone]);
      const pending = rows.filter((row) => row.state === 'pending');
      expect(pending, 'one new pending marker').toEqual([
        {
          state: 'pending',
          requested_at: expect.any(String) as unknown,
          purge_after: expect.any(String) as unknown,
          requested_by: adminId,
          catalog_purged_at: null,
          auth_purged_at: null,
          cancelled_at: null,
          cancelled_by: null,
        },
      ]);
      expect(
        new Date(requested.purgeAfter).getTime(),
        "the request answers the new marker's date",
      ).toBe(new Date(pending[0]?.purge_after ?? '').getTime());
      expect(
        new Date(requested.purgeAfter).getTime(),
        "the new marker's date is not the tombstone's",
      ).not.toBe(new Date(tombstone?.purge_after ?? '').getTime());
      expect(await isClosed(tenantId), 'the tenant is closed again').toBe(true);

      await harness.forceFlush();
      const tenantEvents = harness.logExporter
        .getFinishedLogRecords()
        .filter((record) => record.attributes['tayzu.tenant.id'] === tenantId)
        .map((record) => record.eventName);
      expect(
        tenantEvents.filter((name) => name === REQUESTED_EVENT),
        'logged as a new request',
      ).toEqual([REQUESTED_EVENT]);
      expect(
        tenantEvents.filter((name) => name === REPEATED_EVENT),
        'not as a repeat of a pending one',
      ).toEqual([]);
    });
  });
});

/**
 * Asks `current_user` of every client that ran a query while `spy` was installed, after removing
 * the spy (the shape of `purge-job.int.test.ts`). A client that can no longer be asked (the script
 * ended it) reports `unverifiable`.
 */
async function rolesOfQueriedClients(spy: {
  mock: { contexts: unknown[] };
  mockRestore: () => void;
}): Promise<string[]> {
  const clients = new Set(spy.mock.contexts as pg.Client[]);
  spy.mockRestore();
  const roles: string[] = [];
  for (const client of clients) {
    try {
      const { rows } = await client.query<{ current_user: string }>('select current_user');
      roles.push(rows[0]?.current_user ?? 'unverifiable');
    } catch {
      roles.push('unverifiable');
    }
  }
  return roles;
}
