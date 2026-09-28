/**
 * The telemetry test harness (task 1.4, openspec/changes/archive/2026-09-28-001-catalog-core).
 *
 * `createTelemetryTestHarness()` registers in-memory span, metric and log
 * exporters on the global OTel providers, so that tests emit through the
 * OTel **API** — exactly like production code — and observe what production
 * emits, without ever writing to an exporter directly.
 *
 * ## Contract
 *
 * - **Single registration.** Only one harness may be registered at a time.
 *   `createTelemetryTestHarness()` registers a tracer provider, a meter
 *   provider, a logger provider and a context manager as the OTel globals,
 *   all synchronously. If any of the four is already registered (an earlier
 *   harness is still active), the call throws and leaves nothing behind: no
 *   provider it created stays reachable, and the pg instrumentation it would
 *   have enabled is never constructed. Call `shutdown()` on the previous
 *   harness first.
 * - **Import order.** Call this before any module that creates its
 *   instruments at import time (design D1), typically from a Vitest setup
 *   file or the first import of a test file. The OTel metrics API has no
 *   proxy meter provider: a `Meter` obtained before registration is a no-op
 *   forever, even after a harness registers later. The pg instrumentation is
 *   also constructed only after registration succeeds, so that it captures
 *   this harness's providers instead of whatever came before.
 * - **`reset()`** empties the three exporters, so nothing recorded before it
 *   is exported after it — a counter counts from zero again. It first force
 *   flushes (a counter increment is only visible to its exporter once
 *   collected), then clears the exporters, so anything emitted but not
 *   flushed before `reset()` is discarded rather than exported later. Every
 *   instrument obtained before `reset()` keeps capturing afterwards, because
 *   `reset()` never replaces a provider, only drains and clears its
 *   exporter.
 * - **`shutdown()`** shuts the tracer, meter and logger providers down,
 *   disables the pg instrumentation, and releases the OTel globals (the
 *   tracer, meter and logger providers, and the context manager), so a new
 *   harness can register. Nothing emitted afterwards reaches this harness's
 *   exporters, even through instruments obtained while it was registered:
 *   the underlying SDK objects refuse to export once shut down. Instruments
 *   obtained under an earlier harness never reach a later one.
 * - **Temporality.** Metrics are collected with delta temporality: each
 *   `forceFlush()` (direct or through `reset()`) reports only the activity
 *   recorded since the previous collection, which is what makes "a counter
 *   counts from zero again" after `reset()` possible.
 *
 * @see `packages/observability/CLAUDE.md` for the package-level summary of
 * this contract.
 */
import { context, metrics, trace } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

/**
 * Long enough that the metric reader's own collection timer never fires
 * during a test run: every collection goes through `forceFlush()` instead.
 */
const METRIC_COLLECTION_INTERVAL_MILLIS = 24 * 60 * 60 * 1000;

export interface TelemetryTestHarness {
  readonly spanExporter: InMemorySpanExporter;
  readonly metricExporter: InMemoryMetricExporter;
  readonly logExporter: InMemoryLogRecordExporter;
  /** Enabled, with `enhancedDatabaseReporting: false`, before this function returns. */
  readonly pgInstrumentation: PgInstrumentation;
  /** Collects and exports everything recorded so far. */
  forceFlush: () => Promise<void>;
  /** Empties the three exporters; every instrument keeps capturing afterwards. */
  reset: () => Promise<void>;
  /** Shuts the providers down and releases the OTel globals. */
  shutdown: () => Promise<void>;
}

/** Registers a telemetry test harness, or throws if one is already registered. */
export function createTelemetryTestHarness(): TelemetryTestHarness {
  const spanExporter = new InMemorySpanExporter();
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
  const logExporter = new InMemoryLogRecordExporter();

  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: METRIC_COLLECTION_INTERVAL_MILLIS,
  });
  const meterProvider = new MeterProvider({ readers: [metricReader] });
  const loggerProvider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({ exporter: logExporter })],
  });
  const contextManager = new AsyncLocalStorageContextManager().enable();

  const contextRegistered = context.setGlobalContextManager(contextManager);
  const traceRegistered = trace.setGlobalTracerProvider(tracerProvider);
  const metricsRegistered = metrics.setGlobalMeterProvider(meterProvider);
  // logs.setGlobalLoggerProvider() has no boolean return: it silently keeps
  // the existing provider and returns it instead of ours when one is
  // already registered.
  const logsRegistered = logs.setGlobalLoggerProvider(loggerProvider) === loggerProvider;

  if (!(contextRegistered && traceRegistered && metricsRegistered && logsRegistered)) {
    if (contextRegistered) {
      // Unregisters and disables our context manager in one call.
      context.disable();
    } else {
      contextManager.disable();
    }
    if (traceRegistered) {
      trace.disable();
    }
    if (metricsRegistered) {
      metrics.disable();
    }
    // logsRegistered is only true when the global truly became our
    // provider, so disabling it here can only ever remove what we set.
    if (logsRegistered) {
      logs.disable();
    }
    tracerProvider.shutdown().catch(() => undefined);
    meterProvider.shutdown().catch(() => undefined);
    loggerProvider.shutdown().catch(() => undefined);
    throw new Error(
      'createTelemetryTestHarness(): a telemetry test harness is already registered. ' +
        'Call shutdown() on it before creating another one.',
    );
  }

  // Constructed only now, so it captures this harness's tracer, meter and
  // logger: an instrumentation reads the globally registered providers once,
  // at construction time (the same "no proxy" rule as design D1).
  const pgInstrumentation = new PgInstrumentation({ enhancedDatabaseReporting: false });

  async function forceFlush(): Promise<void> {
    await Promise.all([
      tracerProvider.forceFlush(),
      meterProvider.forceFlush(),
      loggerProvider.forceFlush(),
    ]);
  }

  async function reset(): Promise<void> {
    // Collects (and, for spans and logs, exports) whatever is pending, so
    // that clearing the exporters right after also discards it, rather than
    // exporting it on some later flush.
    await forceFlush();
    spanExporter.reset();
    metricExporter.reset();
    logExporter.reset();
  }

  async function shutdown(): Promise<void> {
    pgInstrumentation.disable();
    // Unregister the OTel globals first, so a new harness can register
    // immediately; the providers below keep shutting down independently of
    // that.
    context.disable();
    trace.disable();
    metrics.disable();
    logs.disable();
    await Promise.all([
      tracerProvider.shutdown(),
      meterProvider.shutdown(),
      loggerProvider.shutdown(),
    ]);
  }

  return {
    spanExporter,
    metricExporter,
    logExporter,
    pgInstrumentation,
    forceFlush,
    reset,
    shutdown,
  };
}
