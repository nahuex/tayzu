/**
 * Task 2.0c (openspec/changes/043-identity-lifecycle-and-org-admin/tasks.md):
 * the helpers through which `apps/api` creates every identity log event, span
 * and counter, and the separate identity contract module (Resolved decision
 * Q74). `apps/api` has no `@opentelemetry/api` dependency, so the helpers
 * live in `@tayzu/auth` over its tracer, logger and meter.
 *
 * ## Production symbols expected
 *
 * `packages/auth/src/telemetry/identity-telemetry.ts`:
 * - `emitIdentityEvent({ name, severity, attributes })`: emits one log record
 *   with `eventName = name`, `severityText = severity` (`'INFO' | 'WARN' |
 *   'ERROR'`), the matching `severityNumber` and the given attributes.
 * - `withIdentitySpan(name, attributes, fn)`: runs `fn` (sync or async) inside
 *   a span of that name with those attributes; on a throw it records the
 *   exception and an ERROR status on the span, ends it, and rethrows the same
 *   error. Returns `fn`'s result otherwise.
 * - `recordIdentityMetric(name, value, attributes)`: adds `value` to a counter
 *   of that name on the `@tayzu/auth` meter (created on first use).
 *
 * `packages/auth/src/telemetry/identity-contract.ts`:
 * - `IDENTITY_SPANS`, `IDENTITY_METRICS`, `IDENTITY_LOG_EVENTS`: arrays, all
 *   empty for now (13.3 and 15.1 fill them).
 *
 * `packages/auth/src/index.ts` re-exports all six symbols.
 *
 * Design D1 import order: the harness registers first (static import order),
 * and the modules under test load afterwards.
 */
import { SpanStatusCode } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { registration, type TelemetryTestHarness } from '../__fixtures__/registered-harness.js';

const SCOPE = '@tayzu/auth';
const SUM_DATA_POINT_TYPE = 3;

type Telemetry = typeof import('./identity-telemetry.js');
type Contract = typeof import('./identity-contract.js');
type Index = typeof import('../index.js');

let harness: TelemetryTestHarness;
let telemetry: Telemetry;
let contract: Contract;
let index: Index;

beforeAll(async () => {
  if ('error' in registration) {
    throw new Error(`createTelemetryTestHarness() failed: ${String(registration.error)}`, {
      cause: registration.error,
    });
  }
  harness = registration.harness;
  telemetry = await import('./identity-telemetry.js');
  contract = await import('./identity-contract.js');
  index = await import('../index.js');
});

beforeEach(async () => {
  await harness.reset();
});

describe('identity telemetry helpers (task 2.0c)', () => {
  it('the event emitter exports a log record with the name, severity and attributes it is given, under the @tayzu/auth scope', async () => {
    telemetry.emitIdentityEvent({
      name: 'catalog.audit.test_identity_event',
      severity: 'WARN',
      attributes: { 'tayzu.tenant.id': 'tenant-a', 'tayzu.identity.user.id': 'user-1' },
    });
    await harness.forceFlush();

    const records = harness.logExporter
      .getFinishedLogRecords()
      .filter((record) => record.eventName === 'catalog.audit.test_identity_event');
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record?.severityText).toBe('WARN');
    expect(record?.severityNumber).toBe(SeverityNumber.WARN);
    expect(record?.attributes).toMatchObject({
      'tayzu.tenant.id': 'tenant-a',
      'tayzu.identity.user.id': 'user-1',
    });
    expect(record?.instrumentationScope.name).toBe(SCOPE);
  });

  it('the span helper records a thrown error on its span and rethrows it', async () => {
    const failure = new Error('boom');

    await expect(
      Promise.resolve().then(() =>
        telemetry.withIdentitySpan('identity.test.span', { 'tayzu.tenant.id': 'tenant-a' }, () => {
          throw failure;
        }),
      ),
    ).rejects.toBe(failure);
    await harness.forceFlush();

    const spans = harness.spanExporter
      .getFinishedSpans()
      .filter((span) => span.name === 'identity.test.span');
    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(span?.instrumentationScope.name).toBe(SCOPE);
    expect(span?.attributes['tayzu.tenant.id']).toBe('tenant-a');
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    const exceptions = span?.events.filter((event) => event.name === 'exception');
    expect(exceptions).toHaveLength(1);
    expect(exceptions?.[0]?.attributes?.['exception.message']).toBe('boom');
  });

  it('the span helper rethrows an error thrown asynchronously and records it too', async () => {
    const failure = new Error('async boom');

    await expect(
      telemetry.withIdentitySpan('identity.test.async_span', {}, async () => {
        await Promise.resolve();
        throw failure;
      }),
    ).rejects.toBe(failure);
    await harness.forceFlush();

    const span = harness.spanExporter
      .getFinishedSpans()
      .find((candidate) => candidate.name === 'identity.test.async_span');
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.events.some((event) => event.name === 'exception')).toBe(true);
  });

  it('the metric recorder adds to a counter under the @tayzu/auth scope', async () => {
    telemetry.recordIdentityMetric('tayzu.identity.test.events', 1, { 'tayzu.test.kind': 'a' });
    telemetry.recordIdentityMetric('tayzu.identity.test.events', 2, { 'tayzu.test.kind': 'a' });
    await harness.forceFlush();

    const found: { scope: string; value: number }[] = [];
    for (const resourceMetrics of harness.metricExporter.getMetrics()) {
      for (const scopeMetrics of resourceMetrics.scopeMetrics) {
        for (const metric of scopeMetrics.metrics) {
          if (metric.descriptor.name !== 'tayzu.identity.test.events') continue;
          expect(metric.dataPointType).toBe(SUM_DATA_POINT_TYPE);
          for (const point of metric.dataPoints) {
            if (point.attributes['tayzu.test.kind'] === 'a') {
              found.push({ scope: scopeMetrics.scope.name, value: point.value as number });
            }
          }
        }
      }
    }
    expect(found).toHaveLength(1);
    expect(found[0]).toEqual({ scope: SCOPE, value: 3 });
  });

  it('the package index exports the three helpers', () => {
    expect(index.emitIdentityEvent).toBe(telemetry.emitIdentityEvent);
    expect(index.withIdentitySpan).toBe(telemetry.withIdentitySpan);
    expect(index.recordIdentityMetric).toBe(telemetry.recordIdentityMetric);
  });
});

describe('identity contract module (task 2.0c, Resolved decision Q74)', () => {
  it('is importable from the package index with no name declared', () => {
    expect(index.IDENTITY_SPANS).toBe(contract.IDENTITY_SPANS);
    expect(index.IDENTITY_METRICS).toBe(contract.IDENTITY_METRICS);
    expect(index.IDENTITY_LOG_EVENTS).toBe(contract.IDENTITY_LOG_EVENTS);
    expect(index.IDENTITY_SPANS).toEqual([]);
    expect(index.IDENTITY_METRICS).toEqual([]);
    expect(index.IDENTITY_LOG_EVENTS).toEqual([]);
  });
});
