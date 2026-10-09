/**
 * Task 6.1 (openspec/changes/archive/2026-09-28-001-catalog-core/tasks.md), second half:
 * `telemetry/contract.ts` is the executable mirror of design.md's
 * "Observability contract" section -- "a single source of names and
 * attributes" that `otel-smoke-check` (task 10.x) and the
 * `observability-auditor` subagent both check against. This test transcribes
 * every span, metric, log event, SLI and sampling-exemption entry from that
 * section of `design.md` (as it stood at the time this test was written) and
 * asserts that `contract.ts` states exactly the same thing: no more, no
 * fewer names, and the same attribute sets, instrument types and units. If
 * `design.md` changes, this test (and `contract.ts`) must change with it --
 * that is the point of the "machine-checked, not just documented" contract.
 *
 * ## Module under test and assumed API
 *
 * `./contract.ts` does not exist yet (red phase). This test assumes the
 * following exported shape, the minimum design.md's tables need to be
 * represented losslessly:
 *
 * ```ts
 * export const INSTRUMENTATION_SCOPE_NAME = '@tayzu/catalog';
 *
 * export const COMMON_OPERATION_SPAN_ATTRIBUTES: readonly string[]; // on every *operation* span
 *
 * export type SpanKind = 'operation' | 'child';
 *
 * export interface SpanContract {
 *   readonly name: string;
 *   readonly kind: SpanKind;
 *   readonly requiredAttributes: readonly string[];    // in addition to the common ones, for 'operation' spans
 *   readonly conditionalAttributes: readonly string[];
 * }
 *
 * export const SPANS: readonly SpanContract[];
 *
 * export type MetricInstrumentType = 'counter' | 'histogram';
 *
 * export interface MetricContract {
 *   readonly name: string;
 *   readonly instrumentType: MetricInstrumentType;
 *   readonly unit: string;
 *   readonly attributes: readonly string[];            // the *complete* allowed set (design.md's cardinality guard)
 * }
 *
 * export const METRICS: readonly MetricContract[];
 *
 * export type LogSeverity = 'INFO' | 'WARN' | 'ERROR';
 *
 * export interface LogEventContract {
 *   readonly name: string;
 *   readonly severity: LogSeverity;
 *   readonly attributes: readonly string[];
 * }
 *
 * export const LOG_EVENTS: readonly LogEventContract[];
 *
 * export interface SliDefinition {
 *   readonly metric: string;
 *   readonly dimensions: readonly string[];
 *   readonly definition: string;             // the design's own wording, transcribed verbatim (markdown code
 *                                             // spans removed)
 * }
 *
 * export const SLIS: { readonly availability: SliDefinition; readonly latency: SliDefinition };
 *
 * // catalog.audit.mutation, both catalog.security.* events, and the two
 * // counters T5b alerts on (design.md, "Sampling exemption").
 * export const SAMPLING_EXEMPT_SIGNALS: readonly string[];
 * ```
 *
 * `contract.ts` imports `sharedAttributeKeys` from `@tayzu/observability`
 * (`packages/observability/src/semconv.ts`, task 6.1's other half) for the
 * four cross-capability keys in `COMMON_OPERATION_SPAN_ATTRIBUTES`, rather
 * than repeating their literal strings: this test checks that by comparing
 * `contract.ts`'s tenant-key value against `semconv.ts`'s directly.
 */
import { sharedAttributeKeys } from '@tayzu/observability';
import { describe, expect, it } from 'vitest';

import {
  COMMON_OPERATION_SPAN_ATTRIBUTES,
  INSTRUMENTATION_SCOPE_NAME,
  LOG_EVENTS,
  METRICS,
  SAMPLING_EXEMPT_SIGNALS,
  SLIS,
  SPANS,
  USER_ENTITY_IDENTIFIER_PLACEHOLDER,
  type LogEventContract,
  type MetricContract,
  type SpanContract,
} from './contract.js';

/** Design.md, "Observability contract" -> the 16 spans table, transcribed verbatim. */
const DESIGN_SPANS: readonly SpanContract[] = [
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

/** Design.md, "Observability contract" -> Metrics table, transcribed verbatim. */
const DESIGN_METRICS: readonly MetricContract[] = [
  {
    name: 'tayzu.catalog.operation.duration',
    instrumentType: 'histogram',
    unit: 's',
    attributes: [
      'tayzu.catalog.operation',
      'tayzu.catalog.outcome',
      'error.type',
      'tayzu.tenant.id',
      'tayzu.actor.type',
    ],
  },
  {
    name: 'tayzu.catalog.entity.mutations',
    instrumentType: 'counter',
    unit: '{mutation}',
    attributes: [
      'tayzu.tenant.id',
      'tayzu.catalog.blueprint.identifier',
      'tayzu.catalog.mutation',
      'tayzu.actor.type',
    ],
  },
  {
    name: 'tayzu.catalog.blueprint.mutations',
    instrumentType: 'counter',
    unit: '{mutation}',
    attributes: ['tayzu.tenant.id', 'tayzu.catalog.mutation', 'tayzu.actor.type'],
  },
  {
    name: 'tayzu.catalog.validation.failures',
    instrumentType: 'counter',
    unit: '{failure}',
    attributes: ['tayzu.tenant.id', 'tayzu.catalog.operation', 'error.type'],
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

/** Design.md, "Observability contract" -> Log events table, transcribed verbatim. */
const DESIGN_LOG_EVENTS: readonly LogEventContract[] = [
  {
    name: 'catalog.audit.mutation',
    severity: 'INFO',
    attributes: [
      'tayzu.tenant.id',
      'tayzu.actor.type',
      'tayzu.actor.id',
      'tayzu.actor.on_behalf_of.type',
      'tayzu.actor.on_behalf_of.id',
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
      'tayzu.tenant.id',
      'tayzu.actor.type',
      'tayzu.actor.id',
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

/** Design.md, "Sampling exemption". */
const DESIGN_SAMPLING_EXEMPT_SIGNALS: readonly string[] = [
  'catalog.audit.mutation',
  'catalog.security.context_rejected',
  'catalog.security.reserved_identifier_denied',
  'tayzu.catalog.context.rejections',
  'tayzu.catalog.validation.failures',
];

function byName<T extends { readonly name: string }>(entries: readonly T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const entry of entries) {
    map.set(entry.name, entry);
  }
  return map;
}

function sortedAttributes(attributes: readonly string[]): string[] {
  return [...attributes].sort();
}

describe('telemetry/contract.ts mirrors design.md, "Observability contract" (task 6.1)', () => {
  it('imports the shared attribute keys from @tayzu/observability rather than redefining them', () => {
    expect(sharedAttributeKeys.tenantId).toBe('tayzu.tenant.id');
    expect(COMMON_OPERATION_SPAN_ATTRIBUTES).toContain(sharedAttributeKeys.tenantId);
    expect(COMMON_OPERATION_SPAN_ATTRIBUTES).toContain(sharedAttributeKeys.actorType);
    expect(COMMON_OPERATION_SPAN_ATTRIBUTES).toContain(sharedAttributeKeys.actorId);
  });

  it('declares the instrumentation scope name @tayzu/catalog (design.md, "Instrumentation scope")', () => {
    expect(INSTRUMENTATION_SCOPE_NAME).toBe('@tayzu/catalog');
  });

  it('declares the four common attributes every operation span carries, and no more', () => {
    expect(sortedAttributes(COMMON_OPERATION_SPAN_ATTRIBUTES)).toEqual(
      sortedAttributes([
        sharedAttributeKeys.tenantId,
        sharedAttributeKeys.actorType,
        sharedAttributeKeys.actorId,
        'tayzu.catalog.operation',
      ]),
    );
  });

  describe('Spans', () => {
    it('declares exactly the 16 spans design.md names, no more and no fewer', () => {
      expect(SPANS.map((span) => span.name).sort()).toEqual(
        DESIGN_SPANS.map((span) => span.name).sort(),
      );
    });

    it.each(DESIGN_SPANS.map((span) => [span.name, span] as const))(
      "span %s has design.md's exact kind, required and conditional attributes",
      (name, expected) => {
        const actual = byName(SPANS).get(name);
        expect(actual, `contract.ts must declare span ${name}`).toBeDefined();
        expect(actual?.kind).toBe(expected.kind);
        expect(sortedAttributes(actual?.requiredAttributes ?? [])).toEqual(
          sortedAttributes(expected.requiredAttributes),
        );
        expect(sortedAttributes(actual?.conditionalAttributes ?? [])).toEqual(
          sortedAttributes(expected.conditionalAttributes),
        );
      },
    );
  });

  describe('Metrics', () => {
    it('declares exactly the 7 metrics design.md names, no more and no fewer', () => {
      expect(METRICS.map((metric) => metric.name).sort()).toEqual(
        DESIGN_METRICS.map((metric) => metric.name).sort(),
      );
    });

    it.each(DESIGN_METRICS.map((metric) => [metric.name, metric] as const))(
      "metric %s has design.md's exact instrument type, unit and complete allowed attribute set",
      (name, expected) => {
        const actual = byName(METRICS).get(name);
        expect(actual, `contract.ts must declare metric ${name}`).toBeDefined();
        expect(actual?.instrumentType).toBe(expected.instrumentType);
        expect(actual?.unit).toBe(expected.unit);
        expect(sortedAttributes(actual?.attributes ?? [])).toEqual(
          sortedAttributes(expected.attributes),
        );
      },
    );

    it('never lets the operation.duration histogram (or any metric) carry an entity identifier or actor ID attribute (cardinality budget)', () => {
      for (const metric of METRICS) {
        expect(metric.attributes).not.toContain('tayzu.catalog.entity.identifier');
        expect(metric.attributes).not.toContain('tayzu.actor.id');
      }
    });
  });

  describe('Log events', () => {
    it('declares exactly the 4 log events design.md names, no more and no fewer', () => {
      expect(LOG_EVENTS.map((event) => event.name).sort()).toEqual(
        DESIGN_LOG_EVENTS.map((event) => event.name).sort(),
      );
    });

    it.each(DESIGN_LOG_EVENTS.map((event) => [event.name, event] as const))(
      "log event %s has design.md's exact severity and attributes",
      (name, expected) => {
        const actual = byName(LOG_EVENTS).get(name);
        expect(actual, `contract.ts must declare log event ${name}`).toBeDefined();
        expect(actual?.severity).toBe(expected.severity);
        expect(sortedAttributes(actual?.attributes ?? [])).toEqual(
          sortedAttributes(expected.attributes),
        );
      },
    );
  });

  describe('SLIs (design.md, "SLIs")', () => {
    it("derives availability from tayzu.catalog.operation.duration, per operation and tenant, with the design's exact definition", () => {
      expect(SLIS.availability.metric).toBe('tayzu.catalog.operation.duration');
      expect(sortedAttributes(SLIS.availability.dimensions)).toEqual(
        sortedAttributes(['tayzu.catalog.operation', 'tayzu.tenant.id']),
      );
      expect(SLIS.availability.definition).toBe(
        'the share of operations whose tayzu.catalog.outcome is not server_error. ' +
          'client_error counts as available, because it is the catalog correctly rejecting bad input.',
      );
    });

    it("derives latency (p99) from tayzu.catalog.operation.duration for successful operations, with the design's exact definition", () => {
      expect(SLIS.latency.metric).toBe('tayzu.catalog.operation.duration');
      expect(sortedAttributes(SLIS.latency.dimensions)).toEqual(
        sortedAttributes(['tayzu.catalog.operation', 'tayzu.tenant.id']),
      );
      expect(SLIS.latency.definition).toBe(
        'p99 of tayzu.catalog.operation.duration for successful operations.',
      );
    });
  });

  describe('Sampling exemption (design.md, "Sampling exemption")', () => {
    it('exempts catalog.audit.mutation, both catalog.security.* events, and the two counters T5b alerts on -- and nothing else', () => {
      expect(SAMPLING_EXEMPT_SIGNALS.slice().sort()).toEqual(
        DESIGN_SAMPLING_EXEMPT_SIGNALS.slice().sort(),
      );
    });

    it("never exempts catalog.internal_error (it is not named in design.md's sampling-exemption paragraph)", () => {
      expect(SAMPLING_EXEMPT_SIGNALS).not.toContain('catalog.internal_error');
    });
  });

  // Task 4.1d of openspec/changes/043-identity-lifecycle-and-org-admin (Resolved
  // decisions Q107, Q113, Q119): a `_user` identifier is the member's email, so the
  // entity spans, the audit event and the Cerbos resource id carry one fixed
  // placeholder instead. The placeholder is exported by this module under the
  // name `USER_ENTITY_IDENTIFIER_PLACEHOLDER` (a non-empty string, never an email).
  describe('`_user` identifier placeholder (043 task 4.1d; Q107, Q113, Q119)', () => {
    it('exports one fixed, non-empty placeholder that cannot be an email address', () => {
      expect(typeof USER_ENTITY_IDENTIFIER_PLACEHOLDER).toBe('string');
      expect(USER_ENTITY_IDENTIFIER_PLACEHOLDER.length).toBeGreaterThan(0);
      expect(USER_ENTITY_IDENTIFIER_PLACEHOLDER).not.toContain('@');
    });

    it.each([
      'catalog.entity.create',
      'catalog.entity.upsert',
      'catalog.entity.get',
      'catalog.entity.delete',
      'catalog.entity.status.write',
      'catalog.entity.related.list',
    ])('span %s still declares tayzu.catalog.entity.identifier as a required attribute', (name) => {
      const span = byName(SPANS).get(name);
      expect(span, `contract.ts must declare span ${name}`).toBeDefined();
      expect(span?.requiredAttributes).toContain('tayzu.catalog.entity.identifier');
    });

    it('catalog.audit.mutation still declares tayzu.catalog.resource.identifier', () => {
      const event = byName(LOG_EVENTS).get('catalog.audit.mutation');
      expect(event?.attributes).toContain('tayzu.catalog.resource.identifier');
    });
  });
});
