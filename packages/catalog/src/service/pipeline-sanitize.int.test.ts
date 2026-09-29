/**
 * Regression test for `defineCatalogOperation`'s unknown-error sanitization
 * (`./pipeline.ts`, design D3 step 5, D11; Observability contract, "Errors";
 * spec "Property values never reach telemetry"). `pipeline.int.test.ts`'s own
 * `db_error` scenario forces a raw `pg` `DatabaseError` by calling
 * `client.query(...)` directly, so `code`/`constraint` sit right on the
 * thrown value. This file forces the *other* shape a database write actually
 * throws in production: every persistence function in this package issues
 * SQL through `tx.execute(sql\`...\`)` (`drizzle-orm`'s query builder), and
 * `drizzle-orm/pg-core/session.cjs`'s `queryWithCache` wraps *every* failure
 * from that path in its own `DrizzleQueryError`
 * (`new DrizzleQueryError(query, params, cause)`, `drizzle-orm/errors.cjs`),
 * whose:
 *
 * - `.message` (and therefore the first line(s) of `.stack`, since
 *   `Error.captureStackTrace` renders `${name}: ${message}` before the call
 *   frames) is exactly `Failed query: <sql>\nparams: <bind values>` -- **two**
 *   physical lines of SQL text and raw bind values, not one;
 * - `.cause` is the real, driver-level `pg` `DatabaseError`, which is where
 *   `.code` (SQLSTATE) and `.constraint` actually live -- never on the
 *   `DrizzleQueryError` itself.
 *
 * `persistence/db-errors.ts`'s own module doc comment already documents this
 * exact shape ("`code` ... and `constraint` may live on `error.cause` rather
 * than on the thrown value itself -- drizzle-orm wraps the underlying `pg`
 * `DatabaseError` in its own `DrizzleQueryError`") and its `pgErrorInfo`
 * unwraps `.cause` to find them, for the *mapped* (`CATALOG_*`) error path.
 * `pipeline.ts`'s `sanitizeUnknownError`, which runs for every *unmapped*
 * error, does not: it reads `code`/`constraint` directly off the top-level
 * thrown value with no `.cause` unwrapping, and its `stacktraceWithoutMessage`
 * strips only `stack`'s first physical line. Against a real
 * `DrizzleQueryError`, both defects fire at once: `db.response.status_code`
 * and `tayzu.db.constraint` end up `undefined` (silently dropped, `.cause`
 * never consulted), and `exception.stacktrace` keeps the *second* message
 * line (`params: <bind values>`) verbatim -- SQL parameter values, including
 * whatever marker they contain, leaking straight into telemetry, which is
 * exactly what design D11 and the spec forbid.
 *
 * This is forced without touching any production file: the dummy operation's
 * handler below issues the exact same `tx.execute(sql\`...\`)` shape every
 * repository in `persistence/` already uses (see `blueprints-repository.ts`'s
 * `insertBlueprintRow`), inserting the same `catalog_blueprint` row twice to
 * trigger a genuine `23505` on the real `catalog_blueprint_tenant_identifier_uq`
 * constraint -- a real, unmapped Postgres error, deterministically, with no
 * timing race.
 *
 * Same import-order rationale as `pipeline.int.test.ts` (design D1):
 * `./__fixtures__/registered-harness.js` must be the first same-package
 * import, before `./pipeline.js` creates its tracer, meter instruments and
 * logger at import time.
 */
import { randomUUID } from 'node:crypto';

import { SpanStatusCode } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { runMigrations } from '@tayzu/db';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Import order is load-bearing: see the module doc comment above.
import { registration, type TelemetryTestHarness } from './__fixtures__/registered-harness.js';
import {
  connect,
  connectAsOwner,
  databaseUrl,
  endQuietly,
  randomTenantId,
  type TestDb,
} from './__fixtures__/blueprint-test-helpers.js';
import { finishedLogRecords, finishedSpans } from './__fixtures__/telemetry-assertions.js';
import type { CatalogContext } from '../domain/context.js';
import { isCatalogError } from '../domain/errors.js';
import { defineCatalogOperation } from './pipeline.js';

/** Reads a log/span attribute known to be a string, without risking `no-base-to-string` on a wider `AttributeValue`/`AnyValue` union. */
function stringAttribute(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function registeredHarness(): TelemetryTestHarness {
  if ('error' in registration) {
    throw new Error(
      `createTelemetryTestHarness() failed while the test module graph loaded: ${String(registration.error)}`,
      { cause: registration.error },
    );
  }
  return registration.harness;
}

const DUMMY_OPERATION_NAME = 'pipeline_sanitize_test.dummy';
const DUMMY_SPAN_NAME = `catalog.${DUMMY_OPERATION_NAME}`;
const UNIQUE_VIOLATION_SQLSTATE = '23505';
const VIOLATED_CONSTRAINT = 'catalog_blueprint_tenant_identifier_uq';

/**
 * A bind-parameter marker that must never survive sanitization, spec
 * "Property values never reach telemetry"' own pattern (compare
 * `otel-smoke-check.int.test.ts`'s `secret-marker-123`): planted as the
 * duplicated blueprint's `identifier`, which `DrizzleQueryError`'s own
 * `params: ${params}` message line embeds verbatim.
 */
const MARKER = 'leak-marker-789';

interface DummyOutput {
  readonly ok: true;
}

describe('defineCatalogOperation: sanitizing a real DrizzleQueryError (design D3 step 5, D9, D11; persistence/db-errors.ts)', () => {
  let db: TestDb;
  let pool: TestDb['$client'];
  let harness: TelemetryTestHarness;
  let leakOperation: (rawContext: unknown, input: Record<string, never>) => Promise<DummyOutput>;

  beforeAll(async () => {
    // Only used to run migrations before the pipeline's own tenant
    // transaction runs (task 6.3, design D6 Q1a): tayzu_app has no DDL
    // privilege, so migrations must run as the owner.
    db = connectAsOwner(databaseUrl());
    await runMigrations(db.$client);
    // The pipeline under test runs through the real tenant_isolation RLS
    // policy, exactly like production.
    pool = connect(databaseUrl()).$client;
    harness = registeredHarness();

    leakOperation = defineCatalogOperation<Record<string, never>, DummyOutput>({
      name: DUMMY_OPERATION_NAME,
      pool,
      handler: async ({ ctx, client }) => {
        const tx = drizzle(client);
        const now = new Date();
        const title = JSON.stringify({ en: 'Marker' });
        const schema = JSON.stringify({ properties: {}, required: [] });

        const insertOnce = () =>
          tx.execute(sql`
            insert into catalog_blueprint
              (id, tenant_id, identifier, title, schema, version,
               created_at, created_by_type, created_by_id, updated_at, updated_by_type, updated_by_id)
            values
              (${randomUUID()}, ${ctx.tenantId}, ${MARKER}, ${title}::jsonb, ${schema}::jsonb, 1,
               ${now}, 'system', 'sys', ${now}, 'system', 'sys')
          `);

        // The first insert succeeds; the second, same (tenant_id, identifier)
        // pair violates catalog_blueprint_tenant_identifier_uq. Both go
        // through drizzle-orm's query-builder path (tx.execute(sql\`...\`)),
        // exactly like every persistence/*.ts function in this package, so
        // the rejection is a genuine DrizzleQueryError, never a raw pg error.
        await insertOnce();
        await insertOnce();

        return { output: { ok: true } };
      },
    });
  }, 60_000);

  afterAll(async () => {
    await harness.shutdown();
    await endQuietly(pool);
    await endQuietly(db.$client);
  }, 60_000);

  it('records only sanitized stack frames (no SQL, no "params:" line, no marker) in exception.stacktrace, and takes db.response.status_code / tayzu.db.constraint from the DrizzleQueryError.cause chain', async () => {
    const tenantId = randomTenantId();
    const ctx: CatalogContext = { tenantId, actor: { type: 'user', id: 'user-1' } };

    const thrown = await leakOperation(ctx, {}).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(thrown, 'the second, colliding insert must reject the operation').toBeDefined();
    expect(
      isCatalogError(thrown),
      'a real DrizzleQueryError must never be fabricated into a CatalogError by the pipeline',
    ).toBe(false);
    expect((thrown as { constructor: { name: string } }).constructor.name).toBe(
      'DrizzleQueryError',
    );

    await harness.forceFlush();

    const spans = finishedSpans(harness.spanExporter, DUMMY_SPAN_NAME);
    expect(spans).toHaveLength(1);
    const span = spans[0];
    if (span === undefined) throw new Error('unreachable: length was just asserted to be 1');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes['error.type']).toBe('internal');

    const exceptionEvents = span.events.filter((event) => event.name === 'exception');
    expect(exceptionEvents).toHaveLength(1);
    const attributes = exceptionEvents[0]?.attributes ?? {};

    // design.md, Spans table / D11: exactly these four sanitized keys --
    // db.response.status_code and tayzu.db.constraint must be present, read
    // from the real pg DatabaseError nested in DrizzleQueryError.cause,
    // exactly like persistence/db-errors.ts's own pgErrorInfo does for the
    // mapped-error path.
    expect(Object.keys(attributes).sort()).toEqual(
      [
        'db.response.status_code',
        'exception.stacktrace',
        'exception.type',
        'tayzu.db.constraint',
      ].sort(),
    );
    expect(attributes['exception.type']).toBe('DrizzleQueryError');
    expect(attributes['db.response.status_code']).toBe(UNIQUE_VIOLATION_SQLSTATE);
    expect(attributes['tayzu.db.constraint']).toBe(VIOLATED_CONSTRAINT);

    const stacktrace = stringAttribute(attributes['exception.stacktrace']);
    expect(stacktrace.length).toBeGreaterThan(0);
    expect(stacktrace).not.toContain(MARKER);
    expect(stacktrace.toLowerCase()).not.toContain('params:');
    expect(stacktrace.toLowerCase()).not.toContain('insert into');
    expect(stacktrace.toLowerCase()).not.toContain('failed query');

    // "only stack frames": every non-blank line, once trimmed, is a real
    // V8 call-site line ("    at ..."), never a leftover message line.
    const lines = stacktrace
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.startsWith('at '), `stacktrace line "${line}" is not a stack frame`).toBe(true);
    }

    const logs = finishedLogRecords(harness.logExporter, 'catalog.internal_error');
    expect(logs).toHaveLength(1);
    const record = logs[0];
    expect(record?.severityNumber).toBe(SeverityNumber.ERROR);
    expect(record?.attributes['db.response.status_code']).toBe(UNIQUE_VIOLATION_SQLSTATE);
    expect(record?.attributes['tayzu.db.constraint']).toBe(VIOLATED_CONSTRAINT);
    const logStacktrace = stringAttribute(record?.attributes['exception.stacktrace']);
    expect(logStacktrace).not.toContain(MARKER);
    expect(logStacktrace.toLowerCase()).not.toContain('params:');

    // A last, independent sweep across the whole serialized signal, same
    // pattern as otel-smoke-check.int.test.ts's own marker-leak check.
    const sanitizedSignals = JSON.stringify({
      spanEvent: attributes,
      logAttributes: record?.attributes,
    });
    expect(sanitizedSignals).not.toContain(MARKER);
  }, 60_000);
});
