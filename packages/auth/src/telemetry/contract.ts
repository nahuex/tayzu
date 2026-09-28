/**
 * Task 2.4 (openspec/changes/002-auth-and-rbac/design.md, "Observability
 * contract"): the executable mirror of the design's auth-related spans,
 * metrics and log events, following the same pattern
 * `packages/catalog/src/telemetry/contract.ts` established for 001. Only the
 * names this task's own signals need are declared here; later tasks (2.5
 * onward) extend this file as their own operations start emitting.
 *
 * This module is pure data: it creates no tracer, meter or logger (that is
 * `./instruments.ts`), so importing it never pulls the OTel SDK into
 * `@tayzu/auth`, even through `@tayzu/observability`'s `./semconv` subpath,
 * which itself has no imports.
 */
import { sharedAttributeKeys } from '@tayzu/observability/semconv';

/** design.md, "Observability contract": tracer, meter and logger name. */
export const INSTRUMENTATION_SCOPE_NAME = '@tayzu/auth';

export type MetricInstrumentType = 'counter' | 'histogram';

export interface MetricContract {
  readonly name: string;
  readonly instrumentType: MetricInstrumentType;
  readonly unit: string;
  /** The *complete* allowed set (design.md's cardinality guard): no other key may appear. */
  readonly attributes: readonly string[];
}

/** design.md, "Observability contract" -> Metrics table. */
export const METRICS: readonly MetricContract[] = [
  {
    name: 'tayzu.auth.session.events',
    instrumentType: 'counter',
    unit: '{event}',
    attributes: ['tayzu.auth.event'],
  },
  {
    name: 'tayzu.auth.rate_limit.events',
    instrumentType: 'counter',
    unit: '{event}',
    attributes: ['tayzu.auth.rate_limit.scope'],
  },
];

export type LogSeverity = 'INFO' | 'WARN' | 'ERROR';

export interface LogEventContract {
  readonly name: string;
  readonly severity: LogSeverity;
  readonly attributes: readonly string[];
}

/** design.md, "Observability contract" -> Log events table. */
export const LOG_EVENTS: readonly LogEventContract[] = [
  {
    name: 'auth.security.login_succeeded',
    severity: 'INFO',
    attributes: [sharedAttributeKeys.tenantId, sharedAttributeKeys.actorId],
  },
  {
    name: 'auth.security.login_failed',
    severity: 'WARN',
    attributes: ['tayzu.auth.failure_reason'],
  },
  {
    name: 'auth.security.rate_limited',
    severity: 'WARN',
    attributes: ['tayzu.auth.rate_limit.scope'],
  },
];

/**
 * design.md, "Sampling exemption": every `auth.security.*` event is exempt
 * from sampling and from filter or drop rules in any downstream telemetry
 * pipeline, the same rule 001's own `catalog.security.*` events follow.
 */
export const SAMPLING_EXEMPT_SIGNALS: readonly string[] = [
  'auth.security.login_succeeded',
  'auth.security.login_failed',
  'auth.security.rate_limited',
];
