// Import order is load-bearing: the first import registers the harness while
// the module graph loads (as a Vitest setup file would), and the second one
// creates OTel instruments at import time (as a production module does).
import { registration, type TelemetryTestHarness } from './__fixtures__/registered-harness.js';
import {
  emitModuleScopeSignals,
  MODULE_SCOPE,
  MODULE_SCOPE_SIGNALS,
  PHASE_ATTRIBUTE,
} from './__fixtures__/module-scope-instruments.js';

import { setImmediate as nextMacrotask } from 'node:timers/promises';

import {
  context,
  createContextKey,
  metrics,
  propagation,
  SpanKind,
  trace,
} from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { InMemoryLogRecordExporter, type ReadableLogRecord } from '@opentelemetry/sdk-logs';
import {
  DataPointType,
  InMemoryMetricExporter,
  type ScopeMetrics,
  type SumMetricData,
} from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';

import { createTelemetryTestHarness } from './harness.js';
import * as entryPoint from './index.js';

/**
 * Task 1.4 (openspec/changes/archive/2026-09-28-001-catalog-core/tasks.md): the telemetry test
 * harness registers in-memory span, metric and log exporters on the global
 * OTel providers, with `reset()` and `shutdown()`. Tests emit through the
 * OTel **API**, exactly like production code, and never write to an exporter
 * directly: the harness must see what production emits.
 *
 * The harness contract these tests encode (tasks 6.2, 6.3 and 10.x use the
 * same surface):
 *
 * - `createTelemetryTestHarness()` registers synchronously and returns
 *   `spanExporter` (`InMemorySpanExporter`), `metricExporter`
 *   (`InMemoryMetricExporter`), `logExporter` (`InMemoryLogRecordExporter`),
 *   `pgInstrumentation` (`PgInstrumentation`), and the promise-returning
 *   `forceFlush()`, `reset()` and `shutdown()`.
 * - **One harness per module graph, registered before anything else loads.**
 *   Production modules create their instruments at import time (design D1),
 *   and the OTel metrics API has no proxy provider, so the harness is
 *   registered before those modules are imported: from a Vitest setup file
 *   or the first import of the test file (see
 *   `__fixtures__/registered-harness.ts`). The same order lets
 *   `@opentelemetry/instrumentation-pg` patch `pg` when `pg` loads. Test
 *   cases are isolated with `reset()`, not with new harnesses. Creating a
 *   second harness while one is registered throws (the OTel global setters
 *   only report it through `diag`), and leaves nothing behind.
 * - `reset()` empties the three exporters and discards whatever was emitted
 *   but not flushed. Nothing recorded before it is exported after it (a
 *   counter counts from zero again), and every instrument keeps capturing.
 * - `shutdown()` shuts the providers down, so nothing emitted afterwards
 *   reaches its exporters, even through instruments obtained while it was
 *   registered. It disables the pg instrumentation and releases the global
 *   tracer, meter and logger providers, context manager and propagator, so a
 *   new harness can register. Instruments obtained under an earlier harness
 *   are not expected to reach a later one.
 * - The pg instrumentation is enabled before `createTelemetryTestHarness()`
 *   returns, with `enhancedDatabaseReporting: false` (design.md,
 *   Observability contract, Spans: "The same configuration applies in the
 *   test harness"). This package does not depend on `pg`, so the check that
 *   a `select 1` through `@tayzu/db` yields a captured `pg.query:*` span
 *   without bind values belongs to `@tayzu/db`.
 */

/** The instrumentation scope of the signals that the tests obtain themselves. */
const SCOPE_NAME = '@tayzu/observability-harness-test';
const SCOPE_VERSION = '1.2.3';

interface SignalNames {
  readonly span: string;
  readonly counter: string;
  readonly event: string;
}

function signalNames(suffix: string): SignalNames {
  return {
    span: `tayzu.harness_test.${suffix}`,
    counter: `tayzu.harness_test.${suffix}.count`,
    event: `tayzu.harness_test.${suffix}.event`,
  };
}

/** Emits one span, one counter increment of 1 and one log record, tagged with `phase`. */
type Emit = (phase: string) => void;

/**
 * Obtains a tracer, a counter and a logger through the OTel API **now**, and
 * returns an emitter that keeps using those same instruments.
 */
function obtainInstruments(names: SignalNames): Emit {
  const tracer = trace.getTracer(SCOPE_NAME, SCOPE_VERSION);
  const counter = metrics.getMeter(SCOPE_NAME, SCOPE_VERSION).createCounter(names.counter);
  const logger = logs.getLogger(SCOPE_NAME, SCOPE_VERSION);
  return (phase) => {
    const attributes = { [PHASE_ATTRIBUTE]: phase };
    tracer.startSpan(names.span, { attributes }).end();
    counter.add(1, attributes);
    logger.emit({ eventName: names.event, severityNumber: SeverityNumber.INFO, attributes });
  };
}

function finishedSpans(exporter: InMemorySpanExporter, name: string): ReadableSpan[] {
  return exporter.getFinishedSpans().filter((span) => span.name === name);
}

function finishedLogRecords(
  exporter: InMemoryLogRecordExporter,
  eventName: string,
): ReadableLogRecord[] {
  return exporter.getFinishedLogRecords().filter((record) => record.eventName === eventName);
}

/** The phase of every captured span with this name, in export order. */
function spanPhases(exporter: InMemorySpanExporter, name: string): unknown[] {
  return finishedSpans(exporter, name).map((span) => span.attributes[PHASE_ATTRIBUTE]);
}

/** The phase of every captured log record with this event name, in export order. */
function logPhases(exporter: InMemoryLogRecordExporter, eventName: string): unknown[] {
  return finishedLogRecords(exporter, eventName).map(
    (record) => record.attributes[PHASE_ATTRIBUTE],
  );
}

interface CounterPoint {
  readonly phase: unknown;
  readonly value: number;
}

interface CapturedSum {
  readonly scope: ScopeMetrics['scope'];
  readonly metric: SumMetricData;
}

/** Every export of the named sum metric (a counter), in export order. */
function sumMetrics(exporter: InMemoryMetricExporter, name: string): CapturedSum[] {
  const found: CapturedSum[] = [];
  for (const resourceMetrics of exporter.getMetrics()) {
    for (const scopeMetrics of resourceMetrics.scopeMetrics) {
      for (const metric of scopeMetrics.metrics) {
        if (metric.descriptor.name === name && metric.dataPointType === DataPointType.SUM) {
          found.push({ scope: scopeMetrics.scope, metric });
        }
      }
    }
  }
  return found;
}

/**
 * Every data point of the named counter across **every** export the exporter
 * holds, in export order. A harness that exports an earlier recording again
 * (for example a running total from before `reset()`) shows up here as an
 * extra point or a larger value.
 */
function counterPoints(exporter: InMemoryMetricExporter, name: string): CounterPoint[] {
  return sumMetrics(exporter, name).flatMap(({ metric }) =>
    metric.dataPoints.map((dataPoint) => ({
      phase: dataPoint.attributes[PHASE_ATTRIBUTE],
      value: dataPoint.value,
    })),
  );
}

/** The name of every exported metric that carries at least one data point, across every export. */
function exportedMetricNames(exporter: InMemoryMetricExporter): string[] {
  const names: string[] = [];
  for (const resourceMetrics of exporter.getMetrics()) {
    for (const scopeMetrics of resourceMetrics.scopeMetrics) {
      for (const metric of scopeMetrics.metrics) {
        if (metric.dataPoints.length > 0) {
          names.push(metric.descriptor.name);
        }
      }
    }
  }
  return names;
}

function onlyItem<T>(items: readonly T[]): T {
  expect(items).toHaveLength(1);
  const [item] = items;
  if (item === undefined) {
    throw new Error('Expected exactly one captured item.');
  }
  return item;
}

function captureThrown(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to throw, but it returned normally.');
}

const PROBE_KEY = createContextKey('tayzu.harness_test.context_probe');

/** Whether a global context manager is active, so that `context.with()` propagates a value. */
function activeContextPropagates(): boolean {
  return context.with(
    context.active().setValue(PROBE_KEY, true),
    () => context.active().getValue(PROBE_KEY) === true,
  );
}

/**
 * Pushes out anything that is still wired to a harness after `shutdown()`.
 * A shut-down harness may refuse to flush: only what reaches its exporters
 * matters.
 */
async function flushAfterShutdown(harness: TelemetryTestHarness): Promise<void> {
  try {
    await harness.forceFlush();
  } catch {
    // Refusing to flush after shutdown() is acceptable.
  }
}

/** The harness that `__fixtures__/registered-harness.ts` registered while the module graph loaded. */
function registeredHarness(): TelemetryTestHarness {
  if ('error' in registration) {
    throw new Error(
      `createTelemetryTestHarness() failed while the test module graph loaded: ${String(registration.error)}`,
      { cause: registration.error },
    );
  }
  return registration.harness;
}

function isPgInstrumentation(value: unknown): value is PgInstrumentation {
  return value instanceof PgInstrumentation;
}

describe('createTelemetryTestHarness', () => {
  describe('one harness, registered before the test module graph loads', () => {
    afterEach(async () => {
      if ('harness' in registration) {
        await registration.harness.reset();
      }
    });

    it('registers while the module graph loads and returns in-memory span, metric and log exporters', () => {
      const harness = registeredHarness();

      expect(harness.spanExporter).toBeInstanceOf(InMemorySpanExporter);
      expect(harness.metricExporter).toBeInstanceOf(InMemoryMetricExporter);
      expect(harness.logExporter).toBeInstanceOf(InMemoryLogRecordExporter);
    });

    it('captures a span, a counter and a log record from instruments that a module created at import time', async () => {
      const harness = registeredHarness();

      emitModuleScopeSignals('captured');
      await harness.forceFlush();

      const span = onlyItem(finishedSpans(harness.spanExporter, MODULE_SCOPE_SIGNALS.span));
      expect(span.attributes).toEqual({ [PHASE_ATTRIBUTE]: 'captured' });
      expect(span.instrumentationScope).toMatchObject(MODULE_SCOPE);

      const [counter] = sumMetrics(harness.metricExporter, MODULE_SCOPE_SIGNALS.counter);
      expect(counter, `counter ${MODULE_SCOPE_SIGNALS.counter} was not captured`).toBeDefined();
      expect(counter?.scope).toMatchObject(MODULE_SCOPE);
      expect(counter?.metric.descriptor.unit).toBe('{call}');
      expect(counterPoints(harness.metricExporter, MODULE_SCOPE_SIGNALS.counter)).toEqual([
        { phase: 'captured', value: 1 },
      ]);

      const record = onlyItem(finishedLogRecords(harness.logExporter, MODULE_SCOPE_SIGNALS.event));
      expect(record.severityNumber).toBe(SeverityNumber.INFO);
      expect(record.attributes).toEqual({ [PHASE_ATTRIBUTE]: 'captured' });
      expect(record.instrumentationScope).toMatchObject(MODULE_SCOPE);
    });

    it('captures a span, a counter and a log record emitted through the OTel API', async () => {
      const harness = registeredHarness();
      const spanName = 'tayzu.harness_test.operation';
      const counterName = 'tayzu.harness_test.calls';
      const eventName = 'tayzu.harness_test.happened';

      trace
        .getTracer(SCOPE_NAME, SCOPE_VERSION)
        .startSpan(spanName, {
          kind: SpanKind.INTERNAL,
          attributes: { 'tayzu.test.signal': 'span' },
        })
        .end();
      metrics
        .getMeter(SCOPE_NAME, SCOPE_VERSION)
        .createCounter(counterName, { unit: '{call}' })
        .add(3, { 'tayzu.test.signal': 'counter' });
      logs.getLogger(SCOPE_NAME, SCOPE_VERSION).emit({
        eventName,
        severityNumber: SeverityNumber.INFO,
        severityText: 'INFO',
        body: 'harness log record',
        attributes: { 'tayzu.test.signal': 'log' },
      });

      await harness.forceFlush();

      const span = onlyItem(finishedSpans(harness.spanExporter, spanName));
      expect(span.kind).toBe(SpanKind.INTERNAL);
      expect(span.attributes).toEqual({ 'tayzu.test.signal': 'span' });
      expect(span.instrumentationScope.name).toBe(SCOPE_NAME);
      expect(span.instrumentationScope.version).toBe(SCOPE_VERSION);

      const [counter] = sumMetrics(harness.metricExporter, counterName);
      expect(counter, `counter ${counterName} was not captured`).toBeDefined();
      expect(counter?.scope.name).toBe(SCOPE_NAME);
      expect(counter?.scope.version).toBe(SCOPE_VERSION);
      expect(counter?.metric.descriptor.unit).toBe('{call}');
      expect(counter?.metric.isMonotonic).toBe(true);
      expect(counter?.metric.dataPoints).toHaveLength(1);
      expect(counter?.metric.dataPoints[0]?.value).toBe(3);
      expect(counter?.metric.dataPoints[0]?.attributes).toEqual({ 'tayzu.test.signal': 'counter' });

      const record = onlyItem(finishedLogRecords(harness.logExporter, eventName));
      expect(record.severityNumber).toBe(SeverityNumber.INFO);
      expect(record.severityText).toBe('INFO');
      expect(record.body).toBe('harness log record');
      expect(record.attributes).toEqual({ 'tayzu.test.signal': 'log' });
      expect(record.instrumentationScope.name).toBe(SCOPE_NAME);
      expect(record.instrumentationScope.version).toBe(SCOPE_VERSION);
    });

    it('carries the active trace and span IDs on a log record, across an await', async () => {
      const harness = registeredHarness();
      const spanName = 'tayzu.harness_test.correlated';
      const eventName = 'tayzu.harness_test.correlated.event';

      const activeSpanContext = await trace
        .getTracer(SCOPE_NAME, SCOPE_VERSION)
        .startActiveSpan(spanName, async (span) => {
          try {
            await nextMacrotask();
            logs.getLogger(SCOPE_NAME, SCOPE_VERSION).emit({
              eventName,
              severityNumber: SeverityNumber.INFO,
            });
            return span.spanContext();
          } finally {
            span.end();
          }
        });

      await harness.forceFlush();

      expect(trace.isSpanContextValid(activeSpanContext)).toBe(true);
      const span = onlyItem(finishedSpans(harness.spanExporter, spanName));
      expect(span.spanContext().traceId).toBe(activeSpanContext.traceId);
      const record = onlyItem(finishedLogRecords(harness.logExporter, eventName));
      expect(record.spanContext?.traceId).toBe(activeSpanContext.traceId);
      expect(record.spanContext?.spanId).toBe(activeSpanContext.spanId);
    });

    it('reset() isolates test cases: nothing recorded before it is exported again, and the module-scope instruments keep capturing', async () => {
      const harness = registeredHarness();

      emitModuleScopeSignals('before_reset');
      await harness.forceFlush();
      expect(spanPhases(harness.spanExporter, MODULE_SCOPE_SIGNALS.span)).toEqual(['before_reset']);
      expect(counterPoints(harness.metricExporter, MODULE_SCOPE_SIGNALS.counter)).toEqual([
        { phase: 'before_reset', value: 1 },
      ]);
      expect(logPhases(harness.logExporter, MODULE_SCOPE_SIGNALS.event)).toEqual(['before_reset']);

      await harness.reset();

      expect(harness.spanExporter.getFinishedSpans()).toEqual([]);
      expect(harness.metricExporter.getMetrics()).toEqual([]);
      expect(harness.logExporter.getFinishedLogRecords()).toEqual([]);

      // Nothing new is emitted: a flush must not bring back any earlier
      // signal, including the metric streams of the earlier tests in this file.
      await harness.forceFlush();
      expect(harness.spanExporter.getFinishedSpans()).toEqual([]);
      expect(exportedMetricNames(harness.metricExporter)).toEqual([]);
      expect(harness.logExporter.getFinishedLogRecords()).toEqual([]);

      // The instruments created at import time keep capturing, and the
      // counter counts from zero again.
      emitModuleScopeSignals('after_reset');
      await harness.forceFlush();
      expect(spanPhases(harness.spanExporter, MODULE_SCOPE_SIGNALS.span)).toEqual(['after_reset']);
      expect(exportedMetricNames(harness.metricExporter)).toEqual([MODULE_SCOPE_SIGNALS.counter]);
      expect(counterPoints(harness.metricExporter, MODULE_SCOPE_SIGNALS.counter)).toEqual([
        { phase: 'after_reset', value: 1 },
      ]);
      expect(logPhases(harness.logExporter, MODULE_SCOPE_SIGNALS.event)).toEqual(['after_reset']);
    });

    it('reset() discards signals that were emitted but not flushed before it', async () => {
      const harness = registeredHarness();

      emitModuleScopeSignals('unflushed');
      await harness.reset();

      await harness.forceFlush();
      expect(harness.spanExporter.getFinishedSpans()).toEqual([]);
      expect(exportedMetricNames(harness.metricExporter)).toEqual([]);
      expect(harness.logExporter.getFinishedLogRecords()).toEqual([]);

      emitModuleScopeSignals('flushed');
      await harness.forceFlush();
      expect(spanPhases(harness.spanExporter, MODULE_SCOPE_SIGNALS.span)).toEqual(['flushed']);
      expect(counterPoints(harness.metricExporter, MODULE_SCOPE_SIGNALS.counter)).toEqual([
        { phase: 'flushed', value: 1 },
      ]);
      expect(logPhases(harness.logExporter, MODULE_SCOPE_SIGNALS.event)).toEqual(['flushed']);
    });

    it('enables the pg instrumentation, with enhancedDatabaseReporting set to false, before createTelemetryTestHarness() returns', () => {
      const harness = registeredHarness();

      // Enabled on return, so a pg module loaded by any later import is patched.
      expect(registration).toHaveProperty('pgInstrumentationEnabledOnReturn', true);
      expect(harness.pgInstrumentation).toBeInstanceOf(PgInstrumentation);
      expect(harness.pgInstrumentation.isEnabled()).toBe(true);
      expect(harness.pgInstrumentation.getConfig().enhancedDatabaseReporting).toBe(false);
    });
  });

  describe('registration lifecycle', () => {
    const harnesses: TelemetryTestHarness[] = [];

    beforeAll(async () => {
      // These cases register harnesses of their own, so the harness that was
      // registered while the module graph loaded ends here.
      if ('harness' in registration) {
        await registration.harness.shutdown();
      }
    });

    afterEach(async () => {
      await Promise.all(harnesses.splice(0).map((harness) => harness.shutdown()));
    });

    /** Tracks a harness so that `afterEach` shuts it down if the test does not. */
    function tracked(harness: TelemetryTestHarness): TelemetryTestHarness {
      harnesses.push(harness);
      return harness;
    }

    async function shutdownTracked(harness: TelemetryTestHarness): Promise<void> {
      const index = harnesses.indexOf(harness);
      if (index !== -1) {
        harnesses.splice(index, 1);
      }
      await harness.shutdown();
    }

    it('refuses to register a second harness while one is registered, and the rejected attempt leaves nothing behind', async () => {
      const first = tracked(createTelemetryTestHarness());

      // Records every pg instrumentation that the attempt enables (a new
      // PgInstrumentation enables itself from its constructor by default).
      const enableSpy = vi.spyOn(PgInstrumentation.prototype, 'enable');
      onTestFinished(() => {
        enableSpy.mockRestore();
      });

      // If the call wrongly succeeds, the extra harness is tracked so that
      // afterEach shuts it down.
      const rejection = captureThrown(() => tracked(createTelemetryTestHarness()));
      const enabledDuringAttempt = [...enableSpy.mock.contexts];

      expect(rejection).toBeInstanceOf(Error);
      // A pg instrumentation that the rejected attempt enabled and left enabled
      // would patch pg a second time (duplicate pg spans in every later test).
      const leftEnabled = enabledDuringAttempt
        .filter(isPgInstrumentation)
        .filter((instance) => instance !== first.pgInstrumentation && instance.isEnabled());
      expect(leftEnabled).toHaveLength(0);
      expect(first.pgInstrumentation.isEnabled()).toBe(true);

      // The first harness keeps capturing, with log correlation intact.
      const stillFirst = signalNames('still_first');
      obtainInstruments(stillFirst)('still_first');
      const correlatedEvent = 'tayzu.harness_test.still_first.correlated';
      const activeSpanContext = trace
        .getTracer(SCOPE_NAME, SCOPE_VERSION)
        .startActiveSpan('tayzu.harness_test.still_first.active', (span) => {
          logs.getLogger(SCOPE_NAME, SCOPE_VERSION).emit({
            eventName: correlatedEvent,
            severityNumber: SeverityNumber.INFO,
          });
          span.end();
          return span.spanContext();
        });
      await first.forceFlush();

      expect(spanPhases(first.spanExporter, stillFirst.span)).toEqual(['still_first']);
      expect(counterPoints(first.metricExporter, stillFirst.counter)).toEqual([
        { phase: 'still_first', value: 1 },
      ]);
      expect(logPhases(first.logExporter, stillFirst.event)).toEqual(['still_first']);
      expect(trace.isSpanContextValid(activeSpanContext)).toBe(true);
      const record = onlyItem(finishedLogRecords(first.logExporter, correlatedEvent));
      expect(record.spanContext?.spanId).toBe(activeSpanContext.spanId);

      // Once the first harness shuts down, a new one registers and captures.
      await shutdownTracked(first);
      const next = tracked(createTelemetryTestHarness());
      const afterRejection = signalNames('after_rejection');
      obtainInstruments(afterRejection)('after_rejection');
      await next.forceFlush();

      expect(spanPhases(next.spanExporter, afterRejection.span)).toEqual(['after_rejection']);
      expect(counterPoints(next.metricExporter, afterRejection.counter)).toEqual([
        { phase: 'after_rejection', value: 1 },
      ]);
      expect(logPhases(next.logExporter, afterRejection.event)).toEqual(['after_rejection']);
    });

    it('shutdown() stops capture, even through instruments obtained while the harness was registered, and releases the global API', async () => {
      const harness = tracked(createTelemetryTestHarness());
      const names = signalNames('shutdown');
      const emitThroughHarness = obtainInstruments(names);

      emitThroughHarness('before_shutdown');
      await harness.forceFlush();
      expect(spanPhases(harness.spanExporter, names.span)).toEqual(['before_shutdown']);
      expect(counterPoints(harness.metricExporter, names.counter)).toEqual([
        { phase: 'before_shutdown', value: 1 },
      ]);
      expect(logPhases(harness.logExporter, names.event)).toEqual(['before_shutdown']);

      await shutdownTracked(harness);

      // The global API is released: no tracer provider, context manager,
      // propagator or pg patch of this harness stays active.
      expect(harness.pgInstrumentation.isEnabled()).toBe(false);
      const probe = trace
        .getTracer(SCOPE_NAME, SCOPE_VERSION)
        .startSpan('tayzu.harness_test.probe');
      expect(probe.isRecording()).toBe(false);
      probe.end();
      expect(activeContextPropagates()).toBe(false);
      expect(propagation.fields()).toEqual([]);

      // Nothing emitted after shutdown() reaches its exporters, neither
      // through the instruments obtained while it was registered nor through
      // instruments obtained afterwards.
      emitThroughHarness('after_shutdown');
      const obtainedAfterShutdown = signalNames('obtained_after_shutdown');
      obtainInstruments(obtainedAfterShutdown)('after_shutdown');
      await flushAfterShutdown(harness);

      expect(spanPhases(harness.spanExporter, names.span)).not.toContain('after_shutdown');
      expect(
        counterPoints(harness.metricExporter, names.counter).map((point) => point.phase),
      ).not.toContain('after_shutdown');
      expect(logPhases(harness.logExporter, names.event)).not.toContain('after_shutdown');
      expect(spanPhases(harness.spanExporter, obtainedAfterShutdown.span)).toEqual([]);
      expect(counterPoints(harness.metricExporter, obtainedAfterShutdown.counter)).toEqual([]);
      expect(logPhases(harness.logExporter, obtainedAfterShutdown.event)).toEqual([]);
    });

    it('after shutdown(), a new harness registers, activates its own context manager and captures signals from instruments obtained after it', async () => {
      const first = tracked(createTelemetryTestHarness());
      await shutdownTracked(first);

      const second = tracked(createTelemetryTestHarness());

      expect(activeContextPropagates()).toBe(true);
      const names = signalNames('second_harness');
      obtainInstruments(names)('second');
      const correlatedEvent = 'tayzu.harness_test.second_harness.correlated';
      const activeSpanContext = await trace
        .getTracer(SCOPE_NAME, SCOPE_VERSION)
        .startActiveSpan('tayzu.harness_test.second_harness.active', async (span) => {
          try {
            await nextMacrotask();
            logs.getLogger(SCOPE_NAME, SCOPE_VERSION).emit({
              eventName: correlatedEvent,
              severityNumber: SeverityNumber.INFO,
            });
            return span.spanContext();
          } finally {
            span.end();
          }
        });
      await second.forceFlush();

      expect(spanPhases(second.spanExporter, names.span)).toEqual(['second']);
      expect(counterPoints(second.metricExporter, names.counter)).toEqual([
        { phase: 'second', value: 1 },
      ]);
      expect(logPhases(second.logExporter, names.event)).toEqual(['second']);
      expect(trace.isSpanContextValid(activeSpanContext)).toBe(true);
      const record = onlyItem(finishedLogRecords(second.logExporter, correlatedEvent));
      expect(record.spanContext?.traceId).toBe(activeSpanContext.traceId);
      expect(record.spanContext?.spanId).toBe(activeSpanContext.spanId);

      expect(first.pgInstrumentation.isEnabled()).toBe(false);
      expect(second.pgInstrumentation).toBeInstanceOf(PgInstrumentation);
      expect(second.pgInstrumentation).not.toBe(first.pgInstrumentation);
      expect(second.pgInstrumentation.isEnabled()).toBe(true);
      expect(second.pgInstrumentation.getConfig().enhancedDatabaseReporting).toBe(false);
    });
  });

  it('is exported from the package entry point', () => {
    expect(entryPoint).toHaveProperty('createTelemetryTestHarness', createTelemetryTestHarness);
  });
});
