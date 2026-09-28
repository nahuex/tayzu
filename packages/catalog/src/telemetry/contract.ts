/**
 * Task 6.1 (openspec/changes/archive/2026-09-28-001-catalog-core/tasks.md): the executable
 * mirror of design.md's "Observability contract" section. This is the single
 * source of every span, metric, log event, SLI and sampling-exemption name
 * the catalog declares: `otel-smoke-check` (task 10.x) and the
 * `observability-auditor` subagent both check the running system against
 * these names, and nothing outside this module invents a new one.
 *
 * This module is pure data: it creates no tracer, meter or logger (that is
 * `./instruments.ts`), so importing it never pulls the OTel SDK into the
 * catalog, even through `@tayzu/observability`'s `./semconv` subpath, which
 * itself has no imports.
 */
import { sharedAttributeKeys } from '@tayzu/observability/semconv';

/** design.md, "Instrumentation scope": tracer and meter name. */
export const INSTRUMENTATION_SCOPE_NAME = '@tayzu/catalog';

/**
 * design.md, "Common attributes": the four attributes every *operation* span
 * carries, in addition to each span's own required and conditional
 * attributes.
 */
export const COMMON_OPERATION_SPAN_ATTRIBUTES: readonly string[] = [
  sharedAttributeKeys.tenantId,
  sharedAttributeKeys.actorType,
  sharedAttributeKeys.actorId,
  'tayzu.catalog.operation',
];

/** `'operation'`: one per catalog operation. `'child'`: a nested span within one. */
export type SpanKind = 'operation' | 'child';

export interface SpanContract {
  readonly name: string;
  readonly kind: SpanKind;
  /** In addition to `COMMON_OPERATION_SPAN_ATTRIBUTES` for an `'operation'` span. */
  readonly requiredAttributes: readonly string[];
  readonly conditionalAttributes: readonly string[];
}

/** design.md, "Observability contract" -> Spans table. */
export const SPANS: readonly SpanContract[] = [
  {
    name: 'catalog.blueprint.create',
    kind: 'operation',
    requiredAttributes: ['tayzu.catalog.blueprint.identifier'],
    conditionalAttributes: [],
  },
  {
    name: 'catalog.blueprint.get',
    kind: 'operation',
    requiredAttributes: ['tayzu.catalog.blueprint.identifier'],
    conditionalAttributes: [],
  },
  {
    name: 'catalog.blueprint.list',
    kind: 'operation',
    requiredAttributes: ['tayzu.catalog.page.size'],
    conditionalAttributes: ['tayzu.catalog.result.count'],
  },
  {
    name: 'catalog.blueprint.update',
    kind: 'operation',
    requiredAttributes: ['tayzu.catalog.blueprint.identifier'],
    conditionalAttributes: ['tayzu.catalog.compatibility.violation.count'],
  },
  {
    name: 'catalog.blueprint.delete',
    kind: 'operation',
    requiredAttributes: ['tayzu.catalog.blueprint.identifier'],
    conditionalAttributes: [],
  },
  {
    name: 'catalog.entity.create',
    kind: 'operation',
    requiredAttributes: ['tayzu.catalog.blueprint.identifier', 'tayzu.catalog.entity.identifier'],
    conditionalAttributes: ['tayzu.catalog.relation.target.count'],
  },
  {
    name: 'catalog.entity.upsert',
    kind: 'operation',
    requiredAttributes: [
      'tayzu.catalog.blueprint.identifier',
      'tayzu.catalog.entity.identifier',
      'tayzu.catalog.upsert.mode',
    ],
    conditionalAttributes: ['tayzu.catalog.mutation'],
  },
  {
    name: 'catalog.entity.get',
    kind: 'operation',
    requiredAttributes: ['tayzu.catalog.blueprint.identifier', 'tayzu.catalog.entity.identifier'],
    conditionalAttributes: [],
  },
  {
    name: 'catalog.entity.list',
    kind: 'operation',
    requiredAttributes: ['tayzu.catalog.blueprint.identifier', 'tayzu.catalog.page.size'],
    conditionalAttributes: ['tayzu.catalog.result.count'],
  },
  {
    name: 'catalog.entity.delete',
    kind: 'operation',
    requiredAttributes: [
      'tayzu.catalog.blueprint.identifier',
      'tayzu.catalog.entity.identifier',
      'tayzu.catalog.detach_references',
    ],
    conditionalAttributes: ['tayzu.catalog.detached.count'],
  },
  {
    name: 'catalog.entity.status.write',
    kind: 'operation',
    requiredAttributes: [
      'tayzu.catalog.blueprint.identifier',
      'tayzu.catalog.entity.identifier',
      'tayzu.catalog.status.source',
    ],
    conditionalAttributes: ['tayzu.catalog.relation.target.count'],
  },
  {
    name: 'catalog.entity.related.list',
    kind: 'operation',
    requiredAttributes: [
      'tayzu.catalog.blueprint.identifier',
      'tayzu.catalog.entity.identifier',
      'tayzu.catalog.related.direction',
      'tayzu.catalog.related.scope',
    ],
    conditionalAttributes: ['tayzu.catalog.result.count'],
  },
  {
    name: 'catalog.schema.compile',
    kind: 'child',
    requiredAttributes: ['tayzu.catalog.blueprint.identifier', 'tayzu.catalog.blueprint.version'],
    conditionalAttributes: [],
  },
  {
    name: 'catalog.blueprint.compatibility_check',
    kind: 'child',
    requiredAttributes: [
      'tayzu.catalog.blueprint.identifier',
      'tayzu.catalog.compatibility.entities_checked',
    ],
    conditionalAttributes: ['tayzu.catalog.compatibility.violation.count'],
  },
  {
    name: 'catalog.entity.validate',
    kind: 'child',
    requiredAttributes: ['tayzu.catalog.blueprint.identifier'],
    conditionalAttributes: ['tayzu.catalog.validation.issue.count'],
  },
  {
    name: 'catalog.relations.resolve',
    kind: 'child',
    requiredAttributes: ['tayzu.catalog.relation.target.count'],
    conditionalAttributes: ['tayzu.catalog.relation.missing.count'],
  },
];

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
    name: 'tayzu.catalog.operation.duration',
    instrumentType: 'histogram',
    unit: 's',
    attributes: [
      'tayzu.catalog.operation',
      'tayzu.catalog.outcome',
      'error.type',
      sharedAttributeKeys.tenantId,
      sharedAttributeKeys.actorType,
    ],
  },
  {
    name: 'tayzu.catalog.entity.mutations',
    instrumentType: 'counter',
    unit: '{mutation}',
    attributes: [
      sharedAttributeKeys.tenantId,
      'tayzu.catalog.blueprint.identifier',
      'tayzu.catalog.mutation',
      sharedAttributeKeys.actorType,
    ],
  },
  {
    name: 'tayzu.catalog.blueprint.mutations',
    instrumentType: 'counter',
    unit: '{mutation}',
    attributes: [
      sharedAttributeKeys.tenantId,
      'tayzu.catalog.mutation',
      sharedAttributeKeys.actorType,
    ],
  },
  {
    name: 'tayzu.catalog.validation.failures',
    instrumentType: 'counter',
    unit: '{failure}',
    attributes: [sharedAttributeKeys.tenantId, 'tayzu.catalog.operation', 'error.type'],
  },
  {
    name: 'tayzu.catalog.context.rejections',
    instrumentType: 'counter',
    unit: '{rejection}',
    attributes: ['tayzu.catalog.operation', 'tayzu.catalog.context.reason'],
  },
  {
    name: 'tayzu.catalog.schema.cache.lookups',
    instrumentType: 'counter',
    unit: '{lookup}',
    attributes: ['tayzu.cache.result'],
  },
  {
    name: 'tayzu.catalog.schema.compile.duration',
    instrumentType: 'histogram',
    unit: 's',
    attributes: [],
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
    name: 'catalog.audit.mutation',
    severity: 'INFO',
    attributes: [
      sharedAttributeKeys.tenantId,
      sharedAttributeKeys.actorType,
      sharedAttributeKeys.actorId,
      sharedAttributeKeys.actorOnBehalfOfType,
      sharedAttributeKeys.actorOnBehalfOfId,
      'tayzu.catalog.mutation',
      'tayzu.catalog.resource.kind',
      'tayzu.catalog.blueprint.identifier',
      'tayzu.catalog.resource.identifier',
      'tayzu.catalog.version',
      'tayzu.catalog.change_event.seq',
    ],
  },
  {
    name: 'catalog.security.context_rejected',
    severity: 'WARN',
    attributes: ['tayzu.catalog.operation', 'tayzu.catalog.context.reason'],
  },
  {
    name: 'catalog.security.reserved_identifier_denied',
    severity: 'WARN',
    attributes: [
      sharedAttributeKeys.tenantId,
      sharedAttributeKeys.actorType,
      sharedAttributeKeys.actorId,
      'tayzu.catalog.blueprint.identifier',
    ],
  },
  {
    name: 'catalog.internal_error',
    severity: 'ERROR',
    attributes: [
      'tayzu.catalog.operation',
      'exception.type',
      'db.response.status_code',
      'tayzu.db.constraint',
      'exception.stacktrace',
    ],
  },
];

export interface SliDefinition {
  readonly metric: string;
  readonly dimensions: readonly string[];
  /** The design's own wording, transcribed verbatim (markdown code spans removed). */
  readonly definition: string;
}

/** design.md, "SLIs". Both are derived from `tayzu.catalog.operation.duration`; no new instrument. */
export const SLIS: { readonly availability: SliDefinition; readonly latency: SliDefinition } = {
  availability: {
    metric: 'tayzu.catalog.operation.duration',
    dimensions: ['tayzu.catalog.operation', sharedAttributeKeys.tenantId],
    definition:
      'the share of operations whose tayzu.catalog.outcome is not server_error. ' +
      'client_error counts as available, because it is the catalog correctly rejecting bad input.',
  },
  latency: {
    metric: 'tayzu.catalog.operation.duration',
    dimensions: ['tayzu.catalog.operation', sharedAttributeKeys.tenantId],
    definition: 'p99 of tayzu.catalog.operation.duration for successful operations.',
  },
};

/**
 * design.md, "Sampling exemption": `catalog.audit.mutation`, both
 * `catalog.security.*` events, and the two counters T5b alerts on MUST be
 * exempt from sampling and from filter or drop rules in any downstream
 * telemetry pipeline. `catalog.internal_error` is deliberately not named
 * here (it is not part of design.md's sampling-exemption paragraph).
 */
export const SAMPLING_EXEMPT_SIGNALS: readonly string[] = [
  'catalog.audit.mutation',
  'catalog.security.context_rejected',
  'catalog.security.reserved_identifier_denied',
  'tayzu.catalog.context.rejections',
  'tayzu.catalog.validation.failures',
];
