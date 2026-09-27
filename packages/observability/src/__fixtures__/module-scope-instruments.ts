/**
 * Models a production telemetry module such as
 * `@tayzu/catalog/src/telemetry` (design D1): it obtains its tracer, a counter
 * and its logger once, at import time, through the OTel **API** only, and
 * keeps them for the life of the module graph. It never touches the SDK or an
 * exporter.
 */
import { metrics, trace } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';

/** The instrumentation scope of the module-scope instruments. */
export const MODULE_SCOPE = {
  name: '@tayzu/observability-module-scope-fixture',
  version: '0.0.1',
} as const;

/**
 * The attribute that tells apart the signals of one phase of a test (for
 * example before and after `reset()`) on spans, counter data points and log
 * records alike.
 */
export const PHASE_ATTRIBUTE = 'tayzu.test.phase';

export const MODULE_SCOPE_SIGNALS = {
  span: 'tayzu.harness_test.module_scope',
  counter: 'tayzu.harness_test.module_scope.count',
  event: 'tayzu.harness_test.module_scope.event',
} as const;

const tracer = trace.getTracer(MODULE_SCOPE.name, MODULE_SCOPE.version);
const counter = metrics
  .getMeter(MODULE_SCOPE.name, MODULE_SCOPE.version)
  .createCounter(MODULE_SCOPE_SIGNALS.counter, { unit: '{call}' });
const logger = logs.getLogger(MODULE_SCOPE.name, MODULE_SCOPE.version);

/**
 * Emits one span, one counter increment of 1 and one log record through the
 * instruments created at import time, each tagged with `phase`.
 */
export function emitModuleScopeSignals(phase: string): void {
  const attributes = { [PHASE_ATTRIBUTE]: phase };
  tracer.startSpan(MODULE_SCOPE_SIGNALS.span, { attributes }).end();
  counter.add(1, attributes);
  logger.emit({
    eventName: MODULE_SCOPE_SIGNALS.event,
    severityNumber: SeverityNumber.INFO,
    attributes,
  });
}
