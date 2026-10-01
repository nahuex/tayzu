/**
 * Integration tests for tasks 6.2 and 6.3 (openspec/changes/archive/2026-09-28-001-catalog-core,
 * design D3, D5, D9, D11; spec "Tenant context is mandatory and fails
 * closed", "Actor attribution and change events", "Telemetry contract").
 *
 * ## Module under test and assumed API
 *
 * `./pipeline.ts` does not exist yet (red phase). This test assumes the
 * following exported shape, the minimum design D3's operation-pipeline steps
 * need:
 *
 * ```ts
 * export interface CatalogMutationAudit {
 *   readonly mutation: 'created' | 'updated' | 'status_updated' | 'deleted' | 'detached';
 *   readonly resourceKind: 'blueprint' | 'entity';
 *   readonly blueprintIdentifier: string;
 *   readonly resourceIdentifier: string;
 *   readonly version: number;
 *   readonly changeEventSeq: bigint;
 * }
 *
 * export interface CatalogOperationResult<Output> {
 *   readonly output: Output;
 *   // Present only when the handler performed a successful mutation. The
 *   // pipeline emits `catalog.audit.mutation` (design.md, log events table)
 *   // for it, after the transaction commits, and never for a case with no
 *   // `audit`.
 *   readonly audit?: CatalogMutationAudit;
 * }
 *
 * export interface CatalogOperationHandlerParams<Input> {
 *   readonly ctx: CatalogContext;   // the *parsed* context (domain/context.js)
 *   readonly client: PoolClient;    // from withTenantTransaction (@tayzu/db, design D5); already
 *                                   // has app.tenant_id and statement_timeout set for this transaction
 *   readonly input: Input;
 * }
 *
 * export type CatalogOperationHandler<Input, Output> = (
 *   params: CatalogOperationHandlerParams<Input>,
 * ) => Promise<CatalogOperationResult<Output>>;
 *
 * export interface DefineCatalogOperationOptions<Input, Output> {
 *   readonly name: string;   // e.g. 'entity.upsert' -> span 'catalog.entity.upsert',
 *                            // attribute tayzu.catalog.operation = 'entity.upsert'
 *   readonly pool: Pool;     // the production connection pool this operation runs against
 *   readonly handler: CatalogOperationHandler<Input, Output>;
 * }
 *
 * // The runtime flow (design D3):
 * //   1. parseCatalogContext(rawContext) (domain/context.js). On failure: count
 * //      tayzu.catalog.context.rejections (attributes: tayzu.catalog.operation,
 * //      tayzu.catalog.context.reason), emit the WARN log
 * //      catalog.security.context_rejected with the same two attributes, and
 * //      rethrow the CatalogError CATALOG_CONTEXT_REQUIRED. No span is started,
 * //      and the handler never runs: this step happens *before* step 2.
 * //   2. Start span `catalog.<name>` (tracer name @tayzu/catalog) with the
 * //      common attributes tayzu.tenant.id, tayzu.actor.type, tayzu.actor.id,
 * //      tayzu.catalog.operation = name, and make it the active span for the
 * //      rest of the operation (so a handler can call
 * //      trace.getActiveSpan()?.spanContext().traceId, exactly as
 * //      `appendChangeEvent`'s `traceId` field expects, design D9 / R13).
 * //   3. Run withTenantTransaction(pool, ctx, (client) => handler({ ctx, client, input }))
 * //      (@tayzu/db, design D5).
 * //   4. On a thrown CatalogError: span status ERROR, attribute
 * //      `error.type` = the error's `code`, **no** `exception` event, no
 * //      `status.message` (the error's own `.message` must never reach the
 * //      span). Histogram outcome `client_error`.
 * //   5. On any other thrown value (an "unknown" error, for example a raw `pg`
 * //      error): span status ERROR, attribute `error.type` = `'internal'`, and
 * //      exactly one `exception` event carrying *only*
 * //      `exception.type` (the thrown value's `constructor.name`, e.g.
 * //      `'DatabaseError'` for a raw `pg` error -- never `.message`),
 * //      `db.response.status_code` (the driver's SQLSTATE `.code`, when
 * //      present), `tayzu.db.constraint` (the driver's `.constraint`, when
 * //      present), and `exception.stacktrace` (the thrown value's `.stack`
 * //      with its first line -- the message line -- removed). The ERROR-level
 * //      log `catalog.internal_error` is emitted with
 * //      `tayzu.catalog.operation` plus the same four sanitized attributes.
 * //      Histogram outcome `server_error`. The pipeline does not fabricate a
 * //      `CATALOG_*` code for this case: whatever the handler (or
 * //      `withTenantTransaction`) threw propagates to the caller unchanged, so
 * //      `isCatalogError(...)` is `false` on it (a later layer, task 9.2's API,
 * //      is what turns *any* non-`CatalogError` into the generic public 500
 * //      response).
 * //   6. On success: histogram outcome `success`. If the handler's result
 * //      carries `audit`, emit `catalog.audit.mutation` (INFO) after the
 * //      transaction commits, with `tayzu.tenant.id`, `tayzu.actor.type`,
 * //      `tayzu.actor.id`, `tayzu.actor.on_behalf_of.type` and
 * //      `.on_behalf_of.id` (omitted entirely, not just `null`, when the actor
 * //      has no delegate), `tayzu.catalog.mutation`,
 * //      `tayzu.catalog.resource.kind`, `tayzu.catalog.blueprint.identifier`,
 * //      `tayzu.catalog.resource.identifier`, `tayzu.catalog.version` and
 * //      `tayzu.catalog.change_event.seq` (design.md, log events table).
 * //   7. In every case, record `tayzu.catalog.operation.duration` (histogram,
 * //      seconds) with `tayzu.catalog.operation`, `tayzu.catalog.outcome`,
 * //      `error.type` (only on error), `tayzu.tenant.id` and
 * //      `tayzu.actor.type`.
 * export function defineCatalogOperation<Input, Output>(
 *   options: DefineCatalogOperationOptions<Input, Output>,
 * ): (rawContext: unknown, input: Input) => Promise<Output>;
 * ```
 *
 * The dummy operation this file defines never appears in
 * `telemetry/contract.ts` (task 6.1): the pipeline itself does not validate
 * `name` against the contract (that is `otel-smoke-check`'s job, task 10.x),
 * so a synthetic name is enough to exercise every pipeline behavior in
 * isolation.
 *
 * ## Why this test connects, and orders its imports, the way it does
 *
 * Same raw-`Pool`-against-`DATABASE_URL` pattern as the other int tests in
 * this package (for example `change-events.int.test.ts`), since this
 * exercises real transactions, a real unique-constraint violation, and the
 * real `catalog_change_event` table `appendChangeEvent` (task 5.4) already
 * writes to.
 *
 * The telemetry harness is registered by `./__fixtures__/registered-harness.js`,
 * whose import must appear before `./pipeline.js`'s: `pipeline.ts` (and the
 * `telemetry/contract.ts` module it is expected to use) create their tracer,
 * meter instruments and logger once, at import time (design D1), and the OTel
 * metrics API has no proxy meter provider -- an instrument obtained before
 * registration never emits again, harness or no harness. ES module semantics
 * evaluate a module's imports, in source order, before its own top-level code
 * runs, so with the fixture imported first, `createTelemetryTestHarness()`
 * inside it has already registered by the time `pipeline.ts` is evaluated
 * (see `@tayzu/observability/src/harness.test.ts`'s identical pattern and its
 * own note on import order).
 */
import { ADMIN_PRINCIPAL, authz, testAuthorization } from './__fixtures__/authz-test-helpers.js';
import { randomUUID } from 'node:crypto';

import type { Attributes } from '@opentelemetry/api';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { runMigrations } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// Import order is load-bearing: see the module doc comment above.
import { registration, type TelemetryTestHarness } from './__fixtures__/registered-harness.js';
import type { CatalogContext } from '../domain/context.js';
import { CatalogError, isCatalogError } from '../domain/errors.js';
import { appendChangeEvent } from '../persistence/change-events.js';
import {
  defineCatalogOperation,
  type CatalogMutationAudit,
  type CatalogOperationResult,
} from './pipeline.js';

/**
 * `@opentelemetry/sdk-trace-base`, `sdk-metrics` and `sdk-logs` types,
 * derived structurally from `TelemetryTestHarness` (`@tayzu/observability`)
 * rather than imported directly: `@tayzu/catalog` does not declare those
 * three packages as its own dependency (only `@tayzu/observability` does,
 * per that package's CLAUDE.md, "This is the only workspace package that
 * depends on the OTel SDK"). Deriving the types this way still gets the real
 * shapes -- TypeScript resolves them from within `@tayzu/observability`'s own
 * module-resolution context, where they are a direct dependency -- without
 * this file ever writing `from '@opentelemetry/sdk-*'` itself.
 */
type InMemorySpanExporterLike = TelemetryTestHarness['spanExporter'];
type ReadableSpanLike = ReturnType<InMemorySpanExporterLike['getFinishedSpans']>[number];
type InMemoryMetricExporterLike = TelemetryTestHarness['metricExporter'];
type InMemoryLogRecordExporterLike = TelemetryTestHarness['logExporter'];
type ReadableLogRecordLike = ReturnType<
  InMemoryLogRecordExporterLike['getFinishedLogRecords']
>[number];

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim() === '') {
    throw new Error(
      'DATABASE_URL is not set: the int project global setup should have stopped this run.',
    );
  }
  return url;
}

/**
 * Ends a pool that is about to be torn down, with an 'error' listener
 * attached first. Same pattern as the other int test files in this package
 * (see `change-events.int.test.ts` for the full rationale).
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

/**
 * Fixed literal role name (task 6.3, design D6 Resolved decision Q1a): never
 * interpolated, never built from input.
 */
const APP_ROLE_SET_STATEMENT = 'SET ROLE tayzu_app';

/**
 * Connects as `tayzu_app` (every later query on this pool runs under the
 * real `tenant_isolation` RLS policy, exactly like production), by queuing a
 * literal `SET ROLE` on every new physical connection ahead of any query a
 * caller sends on it (`pg` serializes queries on one connection). Same
 * pattern as `./__fixtures__/blueprint-test-helpers.js`'s own `connect()`;
 * duplicated locally rather than imported, matching this file's own existing
 * choice to build its own connection rather than depend on that fixture
 * module (see the `Db` type comment below).
 */
function connectAsApp(url: string): ReturnType<typeof drizzle> {
  const pool = new Pool({ connectionString: url });
  pool.on('connect', (client) => {
    void client.query(APP_ROLE_SET_STATEMENT).catch(() => {
      // A failure here surfaces as the real, catchable error below: the next
      // query queued on this same connection fails with a permission error
      // instead of silently running under the wrong (owner) identity.
    });
  });
  return drizzle(pool);
}

function randomResourceIdentifier(): string {
  return `dummy-${randomUUID().replaceAll('-', '').slice(0, 8)}`;
}

/** The harness `./__fixtures__/registered-harness.js` registered while the module graph loaded. */
function registeredHarness(): TelemetryTestHarness {
  if ('error' in registration) {
    throw new Error(
      `createTelemetryTestHarness() failed while the test module graph loaded: ${String(registration.error)}`,
      { cause: registration.error },
    );
  }
  return registration.harness;
}

function finishedSpans(exporter: InMemorySpanExporterLike, name: string): ReadableSpanLike[] {
  return exporter.getFinishedSpans().filter((span) => span.name === name);
}

/** Asserts exactly one span with `name` was captured, and returns it. */
function onlySpan(exporter: InMemorySpanExporterLike, name: string): ReadableSpanLike {
  const spans = finishedSpans(exporter, name);
  expect(spans, `expected exactly one span named ${name}`).toHaveLength(1);
  const [span] = spans;
  if (span === undefined) {
    throw new Error('unreachable: length was just asserted to be 1');
  }
  return span;
}

function finishedLogRecords(
  exporter: { getFinishedLogRecords(): readonly ReadableLogRecordLike[] },
  eventName: string,
): ReadableLogRecordLike[] {
  return [...exporter.getFinishedLogRecords()].filter((record) => record.eventName === eventName);
}

/**
 * `@opentelemetry/sdk-metrics`'s `DataPointType` enum values (`HISTOGRAM = 0`,
 * `SUM = 3`), inlined rather than imported: this package (`@tayzu/catalog`)
 * does not declare `@opentelemetry/sdk-metrics` as a dependency (only
 * `@tayzu/observability` does, per that package's CLAUDE.md, "This is the
 * only workspace package that depends on the OTel SDK"), and this enum is
 * part of the exporter's own stable, JSON-serializable data shape rather than
 * something that varies across SDK versions. `InMemoryMetricExporter` above
 * is imported with `import type` only, which `verbatimModuleSyntax` erases
 * before anything is resolved at runtime, so referencing its type here does
 * not require the dependency either.
 */
const METRIC_DATA_POINT_TYPE_SUM = 3;
const METRIC_DATA_POINT_TYPE_HISTOGRAM = 0;

interface CapturedSumPoint {
  readonly attributes: Attributes;
  readonly value: number;
}

/** Every SUM (counter) data point of `name`, across every export the exporter holds. */
function sumDataPoints(exporter: InMemoryMetricExporterLike, name: string): CapturedSumPoint[] {
  const points: CapturedSumPoint[] = [];
  for (const resourceMetrics of exporter.getMetrics()) {
    for (const scopeMetrics of resourceMetrics.scopeMetrics) {
      for (const metric of scopeMetrics.metrics) {
        // dataPointType's real enum type is intentionally not imported (see the comment
        // above); the numeric value it compares against is that same enum's own stable,
        // documented value.
        if (
          metric.descriptor.name === name &&
          // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
          metric.dataPointType === METRIC_DATA_POINT_TYPE_SUM
        ) {
          for (const dataPoint of metric.dataPoints) {
            points.push({ attributes: dataPoint.attributes, value: dataPoint.value });
          }
        }
      }
    }
  }
  return points;
}

interface CapturedHistogramPoint {
  readonly attributes: Attributes;
  readonly count: number;
}

/** Every HISTOGRAM data point of `name`, across every export the exporter holds. */
function histogramDataPoints(
  exporter: InMemoryMetricExporterLike,
  name: string,
): CapturedHistogramPoint[] {
  const points: CapturedHistogramPoint[] = [];
  for (const resourceMetrics of exporter.getMetrics()) {
    for (const scopeMetrics of resourceMetrics.scopeMetrics) {
      for (const metric of scopeMetrics.metrics) {
        // See the eslint-disable comment in sumDataPoints above.
        if (
          metric.descriptor.name === name &&
          // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
          metric.dataPointType === METRIC_DATA_POINT_TYPE_HISTOGRAM
        ) {
          for (const dataPoint of metric.dataPoints) {
            const value = dataPoint.value as { readonly count: number };
            points.push({ attributes: dataPoint.attributes, count: value.count });
          }
        }
      }
    }
  }
  return points;
}

const DUMMY_OPERATION_NAME = 'pipeline_test.dummy';
const DUMMY_SPAN_NAME = `catalog.${DUMMY_OPERATION_NAME}`;
const DUMMY_BLUEPRINT_IDENTIFIER = 'dummy-bp';

/** SQLSTATE for a unique-constraint violation, forced by the 'db_error' handler mode below. */
const UNIQUE_VIOLATION_SQLSTATE = '23505';
const VIOLATED_CONSTRAINT = 'catalog_tenant_sequence_pkey';

type DummyInput =
  | { readonly mode: 'success' }
  | { readonly mode: 'catalog_error' }
  | { readonly mode: 'db_error' }
  | { readonly mode: 'mutation'; readonly resourceIdentifier: string };

interface DummyOutput {
  readonly ok: true;
}

/**
 * `drizzle(url)`'s return type, not `pg.Pool` directly: `@tayzu/catalog` does
 * not declare `pg` as its own dependency (only `@tayzu/db` does), so this
 * file obtains the pool the same way `db-isolation.int.test.ts` and
 * `change-events.int.test.ts` obtain their `Db` -- through `drizzle-orm`,
 * which is a direct dependency here. `db.$client` is the underlying `pg.Pool`
 * (`drizzle-orm/node-postgres`'s `driver.d.ts`: given just a connection
 * string, `$client` is a `Pool`), structurally the same `Pool` type
 * `defineCatalogOperation`'s assumed `pool` option and `@tayzu/db`'s
 * `withTenantTransaction` expect.
 */
type Db = ReturnType<typeof drizzle>;

describe('defineCatalogOperation (design D3, D5, D9; tasks 6.2, 6.3)', () => {
  let db: Db;
  let pool: Db['$client'];
  let harness: TelemetryTestHarness;
  let handlerCalls: DummyInput[];
  let dummyOperation: (rawContext: unknown, input: DummyInput) => Promise<DummyOutput>;

  beforeAll(async () => {
    // Raw introspection only (the change-event trace_id check below runs
    // outside withTenantTransaction, with no app.tenant_id session setting):
    // the owner connection bypasses RLS, task 6.3, design D6 Q1a. It also
    // runs migrations: tayzu_app has no DDL privilege.
    db = drizzle(databaseUrl());
    await runMigrations(db.$client);
    // The pipeline under test runs through the real tenant_isolation RLS
    // policy, exactly like production.
    pool = connectAsApp(databaseUrl()).$client;
    harness = registeredHarness();

    handlerCalls = [];
    dummyOperation = defineCatalogOperation<DummyInput, DummyOutput>({
      name: DUMMY_OPERATION_NAME,
      pool,
      authz,
      authorization: testAuthorization,
      handler: async ({ ctx, client, input }): Promise<CatalogOperationResult<DummyOutput>> => {
        handlerCalls.push(input);

        switch (input.mode) {
          case 'success':
            return { output: { ok: true } };

          case 'catalog_error':
            throw new CatalogError(
              'CATALOG_VALIDATION_FAILED',
              'deliberate validation failure for the pipeline test',
            );

          case 'db_error': {
            // The first insert succeeds; the second, identical one violates
            // catalog_tenant_sequence_pkey (SQLSTATE 23505). This is a real,
            // unmapped `pg` error -- exactly the "unknown error" case design
            // D3 step 5 describes -- and its DETAIL field
            // ("Key (tenant_id)=(<value>) already exists.") really does embed
            // the tenant value, which is exactly what must never reach
            // telemetry (design D11; SSA B4).
            await client.query(
              'insert into catalog_tenant_sequence (tenant_id, last_seq) values ($1, 1)',
              [ctx.tenantId],
            );
            await client.query(
              'insert into catalog_tenant_sequence (tenant_id, last_seq) values ($1, 1)',
              [ctx.tenantId],
            );
            return { output: { ok: true } };
          }

          case 'mutation': {
            // The active span while the handler runs must be the operation
            // span the pipeline started (design D3 step 2), exactly as a real
            // operation would read it to stamp the change event (design D9,
            // R13: "the current trace ID when one exists").
            const traceId = trace.getActiveSpan()?.spanContext().traceId;
            const tx = drizzle(client);
            const changeEventSeq = await appendChangeEvent(tx, {
              tenantId: ctx.tenantId,
              actor: ctx.actor,
              action: 'created',
              resourceKind: 'entity',
              blueprintIdentifier: DUMMY_BLUEPRINT_IDENTIFIER,
              resourceIdentifier: input.resourceIdentifier,
              version: 1,
              changedFields: ['spec'],
              snapshot: { title: 'Dummy' },
              traceId,
            });
            const audit: CatalogMutationAudit = {
              mutation: 'created',
              resourceKind: 'entity',
              blueprintIdentifier: DUMMY_BLUEPRINT_IDENTIFIER,
              resourceIdentifier: input.resourceIdentifier,
              version: 1,
              changeEventSeq,
            };
            return { output: { ok: true }, audit };
          }
        }
      },
    });
  }, 60_000);

  afterEach(async () => {
    handlerCalls.length = 0;
    await harness.reset();
  });

  afterAll(async () => {
    await harness.shutdown();
    await endQuietly(pool);
    await endQuietly(db.$client);
  }, 60_000);

  describe('context validation (design D3 step 1; spec "Tenant context is mandatory and fails closed")', () => {
    it('rejects a context with no tenantId: CATALOG_CONTEXT_REQUIRED, context.rejections, the WARN log, no span, and the handler never runs', async () => {
      const rawContext = { actor: { type: 'user', id: 'user-1' } };

      const thrown = await dummyOperation(rawContext, { mode: 'success' }).catch(
        (error: unknown) => error,
      );

      expect(isCatalogError(thrown)).toBe(true);
      if (isCatalogError(thrown)) {
        expect(thrown.code).toBe('CATALOG_CONTEXT_REQUIRED');
        expect(thrown.details?.['reason']).toBe('missing_tenant');
      }
      expect(
        handlerCalls,
        'the handler must never run: no data may be read or written',
      ).toHaveLength(0);

      await harness.forceFlush();

      expect(
        finishedSpans(harness.spanExporter, DUMMY_SPAN_NAME),
        'no operation span is started on a context rejection (design D3: validation is step 1, the span is step 2)',
      ).toHaveLength(0);

      const rejections = sumDataPoints(harness.metricExporter, 'tayzu.catalog.context.rejections');
      expect(rejections).toHaveLength(1);
      expect(rejections[0]?.value).toBe(1);
      expect(rejections[0]?.attributes).toEqual({
        'tayzu.catalog.operation': DUMMY_OPERATION_NAME,
        'tayzu.catalog.context.reason': 'missing_tenant',
      });

      const logs = finishedLogRecords(harness.logExporter, 'catalog.security.context_rejected');
      expect(logs).toHaveLength(1);
      expect(logs[0]?.severityNumber).toBe(SeverityNumber.WARN);
      expect(logs[0]?.attributes).toEqual({
        'tayzu.catalog.operation': DUMMY_OPERATION_NAME,
        'tayzu.catalog.context.reason': 'missing_tenant',
      });
    });

    it('rejects an unknown actor type with reason invalid_actor, on the counter and the log alike', async () => {
      const rawContext = { tenantId: randomTenantId(), actor: { type: 'robot', id: 'x' } };

      const thrown = await dummyOperation(rawContext, { mode: 'success' }).catch(
        (error: unknown) => error,
      );

      expect(isCatalogError(thrown)).toBe(true);
      if (isCatalogError(thrown)) {
        expect(thrown.code).toBe('CATALOG_CONTEXT_REQUIRED');
        expect(thrown.details?.['reason']).toBe('invalid_actor');
      }
      expect(handlerCalls).toHaveLength(0);

      await harness.forceFlush();

      const rejections = sumDataPoints(harness.metricExporter, 'tayzu.catalog.context.rejections');
      expect(rejections).toHaveLength(1);
      expect(rejections[0]?.attributes).toEqual({
        'tayzu.catalog.operation': DUMMY_OPERATION_NAME,
        'tayzu.catalog.context.reason': 'invalid_actor',
      });

      const logs = finishedLogRecords(harness.logExporter, 'catalog.security.context_rejected');
      expect(logs).toHaveLength(1);
      expect(logs[0]?.attributes).toEqual({
        'tayzu.catalog.operation': DUMMY_OPERATION_NAME,
        'tayzu.catalog.context.reason': 'invalid_actor',
      });
    });
  });

  describe('successful operation (design D3 steps 2, 3, 6, 7)', () => {
    it('records the operation span with the common attributes, and operation.duration with outcome success and tayzu.actor.type', async () => {
      const tenantId = randomTenantId();
      const ctx: CatalogContext = {
        tenantId,
        actor: { type: 'user', id: 'user-1' },
        principal: ADMIN_PRINCIPAL,
      };

      const result = await dummyOperation(ctx, { mode: 'success' });
      expect(result).toEqual({ ok: true });
      expect(handlerCalls).toEqual([{ mode: 'success' }]);

      await harness.forceFlush();

      const span = onlySpan(harness.spanExporter, DUMMY_SPAN_NAME);
      expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
      expect(span.instrumentationScope.name).toBe('@tayzu/catalog');
      expect(span.attributes).toMatchObject({
        'tayzu.tenant.id': tenantId,
        'tayzu.actor.type': 'user',
        'tayzu.actor.id': 'user-1',
        'tayzu.catalog.operation': DUMMY_OPERATION_NAME,
      });

      const points = histogramDataPoints(
        harness.metricExporter,
        'tayzu.catalog.operation.duration',
      );
      expect(points).toHaveLength(1);
      expect(points[0]?.count).toBe(1);
      expect(points[0]?.attributes).toEqual({
        'tayzu.catalog.operation': DUMMY_OPERATION_NAME,
        'tayzu.catalog.outcome': 'success',
        'tayzu.tenant.id': tenantId,
        'tayzu.actor.type': 'user',
      });
    });
  });

  describe('CATALOG_* error (design D3 step 5; Observability contract, "Errors")', () => {
    it('ends the span with ERROR status, error.type = the code, no exception event and no leaked message, and outcome client_error', async () => {
      const tenantId = randomTenantId();
      const ctx: CatalogContext = {
        tenantId,
        actor: { type: 'agent', id: 'agent-1' },
        principal: ADMIN_PRINCIPAL,
      };

      const thrown = await dummyOperation(ctx, { mode: 'catalog_error' }).catch(
        (error: unknown) => error,
      );

      expect(isCatalogError(thrown)).toBe(true);
      if (isCatalogError(thrown)) {
        expect(thrown.code).toBe('CATALOG_VALIDATION_FAILED');
      }

      await harness.forceFlush();

      const span = onlySpan(harness.spanExporter, DUMMY_SPAN_NAME);
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(
        span.status.message,
        'the CatalogError message must never reach the span',
      ).toBeUndefined();
      expect(span.attributes['error.type']).toBe('CATALOG_VALIDATION_FAILED');
      expect(span.events.filter((event) => event.name === 'exception')).toHaveLength(0);

      const spanText = JSON.stringify({ attributes: span.attributes, events: span.events });
      expect(spanText).not.toContain('deliberate validation failure');

      const points = histogramDataPoints(
        harness.metricExporter,
        'tayzu.catalog.operation.duration',
      );
      expect(points).toHaveLength(1);
      expect(points[0]?.attributes).toMatchObject({
        'tayzu.catalog.operation': DUMMY_OPERATION_NAME,
        'tayzu.catalog.outcome': 'client_error',
        'error.type': 'CATALOG_VALIDATION_FAILED',
      });
    });
  });

  describe('unknown error: a forced DB error (design D3 step 5, D11; SSA B4)', () => {
    it('records a sanitized exception (type, SQLSTATE, constraint; no message, no detail; stack without its message line), outcome server_error, and catalog.internal_error, leaking neither the tenant value nor SQL text', async () => {
      const tenantId = randomTenantId();
      const ctx: CatalogContext = {
        tenantId,
        actor: { type: 'integration', id: 'integration-1' },
        principal: ADMIN_PRINCIPAL,
      };

      const thrown = await dummyOperation(ctx, { mode: 'db_error' }).catch(
        (error: unknown) => error,
      );

      expect(thrown, 'the operation must reject').toBeDefined();
      expect(
        isCatalogError(thrown),
        'an unknown error is not fabricated into a CatalogError by the pipeline',
      ).toBe(false);

      await harness.forceFlush();

      const span = onlySpan(harness.spanExporter, DUMMY_SPAN_NAME);
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.attributes['error.type']).toBe('internal');

      const exceptionEvents = span.events.filter((event) => event.name === 'exception');
      expect(exceptionEvents).toHaveLength(1);
      const exceptionAttributes = exceptionEvents[0]?.attributes ?? {};

      expect(Object.keys(exceptionAttributes).sort()).toEqual(
        [
          'db.response.status_code',
          'exception.stacktrace',
          'exception.type',
          'tayzu.db.constraint',
        ].sort(),
      );
      expect(exceptionAttributes['exception.type']).toBe('DatabaseError');
      expect(exceptionAttributes['db.response.status_code']).toBe(UNIQUE_VIOLATION_SQLSTATE);
      expect(exceptionAttributes['tayzu.db.constraint']).toBe(VIOLATED_CONSTRAINT);

      const stacktrace = exceptionAttributes['exception.stacktrace'];
      expect(typeof stacktrace).toBe('string');
      const stacktraceText = String(stacktrace);
      expect(stacktraceText.length).toBeGreaterThan(0);
      expect(stacktraceText.toLowerCase()).not.toContain('duplicate key value violates');
      expect(stacktraceText).not.toContain(tenantId);

      const points = histogramDataPoints(
        harness.metricExporter,
        'tayzu.catalog.operation.duration',
      );
      expect(points).toHaveLength(1);
      expect(points[0]?.attributes).toMatchObject({
        'tayzu.catalog.operation': DUMMY_OPERATION_NAME,
        'tayzu.catalog.outcome': 'server_error',
        'error.type': 'internal',
      });

      const logs = finishedLogRecords(harness.logExporter, 'catalog.internal_error');
      expect(logs).toHaveLength(1);
      const record = logs[0];
      expect(record?.severityNumber).toBe(SeverityNumber.ERROR);
      expect(record?.attributes).toEqual({
        'tayzu.catalog.operation': DUMMY_OPERATION_NAME,
        'exception.type': 'DatabaseError',
        'db.response.status_code': UNIQUE_VIOLATION_SQLSTATE,
        'tayzu.db.constraint': VIOLATED_CONSTRAINT,
        'exception.stacktrace': stacktrace,
      });

      // Marker-leak check (spec "Property values never reach telemetry"; design
      // D11, "The Postgres message, detail and where fields ... are
      // dropped"): the pg DETAIL field for this exact violation reads
      // `Key (tenant_id)=(<tenantId>) already exists.`, and the raw message
      // reads `duplicate key value violates unique constraint "...".`. Neither
      // phrase, nor the raw SQL text this handler issued, may appear in what
      // the span's exception event or the internal_error log actually carry
      // (already asserted above to have *exactly* the four sanitized keys),
      // checked here as a second, independent sweep of their serialized form.
      const sanitizedSignals = JSON.stringify({
        exceptionAttributes,
        logAttributes: record?.attributes,
        logBody: record?.body,
      });
      expect(sanitizedSignals).not.toContain(tenantId);
      expect(sanitizedSignals.toLowerCase()).not.toContain('already exists');
      expect(sanitizedSignals.toLowerCase()).not.toContain('duplicate key value violates');
      expect(sanitizedSignals.toLowerCase()).not.toContain('insert into');
    });
  });

  describe('successful mutation audit trail (design D9, R13; spec "Actor attribution and change events"; task 6.3)', () => {
    it("emits catalog.audit.mutation with the declared attributes, and the change event's trace_id equals the span's and the log record's trace id", async () => {
      const tenantId = randomTenantId();
      const resourceIdentifier = randomResourceIdentifier();
      const ctx: CatalogContext = {
        tenantId,
        actor: { type: 'agent', id: 'agent-1', onBehalfOf: { type: 'user', id: 'user-1' } },
        principal: ADMIN_PRINCIPAL,
      };

      const result = await dummyOperation(ctx, { mode: 'mutation', resourceIdentifier });
      expect(result).toEqual({ ok: true });

      await harness.forceFlush();

      const span = onlySpan(harness.spanExporter, DUMMY_SPAN_NAME);
      const traceId = span.spanContext().traceId;

      // Raw introspection on the owner connection: this runs outside
      // withTenantTransaction, with no app.tenant_id session setting, so the
      // tayzu_app pool above would see zero rows under RLS regardless of the
      // tenant_id filter (task 6.3, design D6 Q1a).
      const eventRows = await db.$client.query<{ trace_id: string | null; seq: string }>(
        'select trace_id, seq from catalog_change_event where tenant_id = $1 and resource_identifier = $2',
        [tenantId, resourceIdentifier],
      );
      expect(eventRows.rows, 'exactly one change event for this dummy mutation').toHaveLength(1);
      expect(
        eventRows.rows[0]?.trace_id,
        "the change event's trace_id must equal the operation span's trace id",
      ).toBe(traceId);
      const changeEventSeq = Number(eventRows.rows[0]?.seq);

      const logs = finishedLogRecords(harness.logExporter, 'catalog.audit.mutation');
      expect(logs).toHaveLength(1);
      const record = logs[0];
      expect(record?.severityNumber).toBe(SeverityNumber.INFO);
      expect(
        record?.spanContext?.traceId,
        "the OTel Logs API's automatic trace correlation must match the operation span",
      ).toBe(traceId);
      expect(record?.attributes).toEqual({
        'tayzu.tenant.id': tenantId,
        'tayzu.actor.type': 'agent',
        'tayzu.actor.id': 'agent-1',
        'tayzu.actor.on_behalf_of.type': 'user',
        'tayzu.actor.on_behalf_of.id': 'user-1',
        'tayzu.catalog.mutation': 'created',
        'tayzu.catalog.resource.kind': 'entity',
        'tayzu.catalog.blueprint.identifier': DUMMY_BLUEPRINT_IDENTIFIER,
        'tayzu.catalog.resource.identifier': resourceIdentifier,
        'tayzu.catalog.version': 1,
        'tayzu.catalog.change_event.seq': changeEventSeq,
      });
    });

    it('omits the on_behalf_of attributes entirely when the actor has no delegate', async () => {
      const tenantId = randomTenantId();
      const resourceIdentifier = randomResourceIdentifier();
      const ctx: CatalogContext = {
        tenantId,
        actor: { type: 'system', id: 'sys' },
        principal: ADMIN_PRINCIPAL,
      };

      await dummyOperation(ctx, { mode: 'mutation', resourceIdentifier });
      await harness.forceFlush();

      const logs = finishedLogRecords(harness.logExporter, 'catalog.audit.mutation');
      expect(logs).toHaveLength(1);
      const attributeKeys = Object.keys(logs[0]?.attributes ?? {});
      expect(attributeKeys).not.toContain('tayzu.actor.on_behalf_of.type');
      expect(attributeKeys).not.toContain('tayzu.actor.on_behalf_of.id');
    });
  });
});
