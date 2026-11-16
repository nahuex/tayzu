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

/** The slice of the active span an operation may use: attributes known only after it ran. */
export interface IdentitySpanHandle {
  setAttributes(attributes: IdentityAttributes): void;
}

/** Expected errors carry a stable `AUTH_*` / `CATALOG_*` code; a driver's SQLSTATE never matches. */
const EXPECTED_ERROR_CODE = /^(AUTH|CATALOG)_[A-Z_]+$/;
const EXCEPTION_TYPE_PATTERN = /^[A-Za-z_$][\w$]*$/;
const MAX_EXCEPTION_TYPE_LENGTH = 64;

function expectedErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code } = error as { code?: unknown };
  return typeof code === 'string' && EXPECTED_ERROR_CODE.test(code) ? code : undefined;
}

/** The stack's call-site lines only: every message line (SQL, bind values) is dropped. */
function stacktraceWithoutMessage(error: unknown): string {
  const stack = error instanceof Error && typeof error.stack === 'string' ? error.stack : '';
  return stack
    .split('\n')
    .filter((line) => line.trim().startsWith('at '))
    .join('\n');
}

function exceptionType(error: unknown): string {
  const name = typeof error === 'object' && error !== null ? error.constructor.name : typeof error;
  return name.length <= MAX_EXCEPTION_TYPE_LENGTH && EXCEPTION_TYPE_PATTERN.test(name)
    ? name
    : 'unknown';
}

/**
 * Runs `fn` in a span and rethrows what it throws, unchanged. Span error rules (design,
 * Observability contract): an expected error sets `error.type` to its code and nothing
 * else; any other throw sets `error.type` `internal` and adds exactly one sanitized
 * `exception` event (type and call-site stack, never the message).
 */
export function withIdentitySpan<T>(
  name: string,
  attributes: IdentityAttributes,
  fn: (span: IdentitySpanHandle) => T | Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes: { ...attributes } }, async (span) => {
    try {
      return await fn({ setAttributes: (extra) => void span.setAttributes({ ...extra }) });
    } catch (error) {
      const code = expectedErrorCode(error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      if (code === undefined) {
        span.setAttribute('error.type', 'internal');
        span.addEvent('exception', {
          'exception.type': exceptionType(error),
          'exception.stacktrace': stacktraceWithoutMessage(error),
        });
      } else {
        span.setAttribute('error.type', code);
      }
      throw error;
    } finally {
      span.end();
    }
  });
}

const counters = new Map<string, Counter>();

/** The unit of each counter, as design.md's Metrics table declares it. */
const METRIC_UNITS: Readonly<Record<string, string>> = {
  'tayzu.identity.invitations': '{invitation}',
  'tayzu.identity.user_status_changes': '{change}',
  'tayzu.identity.service_accounts': '{account}',
  'tayzu.identity.credential_mutations': '{mutation}',
  'tayzu.identity.recovery_emails': '{event}',
  'tayzu.identity.mfa_resets': '{event}',
  'tayzu.identity.password_reset_requests': '{event}',
  'tayzu.identity.password_reset_confirms': '{event}',
};

export function recordIdentityMetric(
  name: string,
  value: number,
  attributes: IdentityAttributes,
): void {
  let counter = counters.get(name);
  if (counter === undefined) {
    counter = metrics
      .getMeter(INSTRUMENTATION_SCOPE_NAME, INSTRUMENTATION_SCOPE_VERSION)
      .createCounter(name, METRIC_UNITS[name] === undefined ? {} : { unit: METRIC_UNITS[name] });
    counters.set(name, counter);
  }
  counter.add(value, { ...attributes });
}
