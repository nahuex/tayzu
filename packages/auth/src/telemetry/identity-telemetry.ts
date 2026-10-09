/**
 * The helpers through which `apps/api` creates every identity log event, span
 * and counter (043, task 2.0c). `apps/api` has no `@opentelemetry/api`
 * dependency, so they run over this package's tracer, logger and meter.
 * Callers pass identifiers only: no emails, IPs, secrets or tenant free text.
 */
import { metrics, SpanStatusCode, type Counter } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';

import { INSTRUMENTATION_SCOPE_NAME } from './contract.js';
import { INSTRUMENTATION_SCOPE_VERSION, logger, tracer } from './instruments.js';

export type IdentityAttributes = Readonly<Record<string, string | number | boolean>>;
export type IdentitySeverity = 'INFO' | 'WARN' | 'ERROR';

const SEVERITY_NUMBERS: Readonly<Record<IdentitySeverity, SeverityNumber>> = {
  INFO: SeverityNumber.INFO,
  WARN: SeverityNumber.WARN,
  ERROR: SeverityNumber.ERROR,
};

export function emitIdentityEvent(event: {
  readonly name: string;
  readonly severity: IdentitySeverity;
  readonly attributes: IdentityAttributes;
}): void {
  logger.emit({
    eventName: event.name,
    severityNumber: SEVERITY_NUMBERS[event.severity],
    severityText: event.severity,
    attributes: { ...event.attributes },
  });
}

/** Runs `fn` in a span; a throw or rejection is recorded on it and rethrown unchanged. */
export function withIdentitySpan<T>(
  name: string,
  attributes: IdentityAttributes,
  fn: () => T | Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes: { ...attributes } }, async (span) => {
    try {
      return await fn();
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error('unknown error'));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

const counters = new Map<string, Counter>();

export function recordIdentityMetric(
  name: string,
  value: number,
  attributes: IdentityAttributes,
): void {
  let counter = counters.get(name);
  if (counter === undefined) {
    counter = metrics
      .getMeter(INSTRUMENTATION_SCOPE_NAME, INSTRUMENTATION_SCOPE_VERSION)
      .createCounter(name);
    counters.set(name, counter);
  }
  counter.add(value, { ...attributes });
}
