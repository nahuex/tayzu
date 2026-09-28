/**
 * The catalog's OpenTelemetry instruments: the tracer, the logger and the
 * meter instruments `service/pipeline.ts` needs (tasks 6.2, 6.3). Obtained
 * once, at import time, through the OTel **API** only (design.md,
 * "Instrumentation scope"): the catalog depends on `@opentelemetry/api` and
 * `@opentelemetry/api-logs` only, never an SDK package. The SDK and its
 * exporters are configured by the host app, or by
 * `@tayzu/observability`'s test harness in tests.
 *
 * Design D1, "Import order": the OTel metrics API has no proxy meter
 * provider, so a module that imports this one (transitively, `pipeline.ts`)
 * must itself be imported only after a telemetry harness has registered, or
 * every instrument below is a permanent no-op. See
 * `src/service/__fixtures__/registered-harness.ts`.
 *
 * Only the instruments task 6.2/6.3's pipeline needs live here today. Later
 * tasks (7.x, 8.x) add the remaining `./contract.ts` metrics as their own
 * operations start emitting them.
 */
import { metrics, trace } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';

import { INSTRUMENTATION_SCOPE_NAME } from './contract.js';

/** Matches `package.json`'s `version` field (design.md, "Instrumentation scope"). */
export const INSTRUMENTATION_SCOPE_VERSION = '0.0.0';

export const tracer = trace.getTracer(INSTRUMENTATION_SCOPE_NAME, INSTRUMENTATION_SCOPE_VERSION);
export const logger = logs.getLogger(INSTRUMENTATION_SCOPE_NAME, INSTRUMENTATION_SCOPE_VERSION);

const meter = metrics.getMeter(INSTRUMENTATION_SCOPE_NAME, INSTRUMENTATION_SCOPE_VERSION);

/** design.md, Metrics table: "Latency, throughput, and error rate per operation (RED)". */
export const operationDurationHistogram = meter.createHistogram(
  'tayzu.catalog.operation.duration',
  {
    unit: 's',
  },
);

/** design.md, Metrics table: "Security signal: callers without a valid context (SEC03, SEC16)". */
export const contextRejectionsCounter = meter.createCounter('tayzu.catalog.context.rejections', {
  unit: '{rejection}',
});

/** design.md, Metrics table: "Client-quality and misuse signal (SEC06)". */
export const validationFailuresCounter = meter.createCounter('tayzu.catalog.validation.failures', {
  unit: '{failure}',
});

/** design.md, Metrics table: "Schema churn" (task 7.x). */
export const blueprintMutationsCounter = meter.createCounter('tayzu.catalog.blueprint.mutations', {
  unit: '{mutation}',
});

/** design.md, Metrics table: "Write volume by blueprint and actor type" (task 8.x). */
export const entityMutationsCounter = meter.createCounter('tayzu.catalog.entity.mutations', {
  unit: '{mutation}',
});

/** design.md, Metrics table: "Cache effectiveness" (task 4.8's validator-cache wiring). */
export const schemaCacheLookupsCounter = meter.createCounter('tayzu.catalog.schema.cache.lookups', {
  unit: '{lookup}',
});

/** design.md, Metrics table: "Compile cost" (task 4.8's validator-cache wiring). */
export const schemaCompileDurationHistogram = meter.createHistogram(
  'tayzu.catalog.schema.compile.duration',
  {
    unit: 's',
  },
);
