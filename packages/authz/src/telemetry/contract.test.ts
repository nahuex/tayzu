/**
 * Task 13.1 (openspec/changes/002-auth-and-rbac/tasks.md): `contract.ts` is
 * the executable mirror of design.md's "Observability contract" section
 * (spans, metrics, log events, sampling exemption, forbidden attributes).
 * This test transcribes every row of those tables and asserts `contract.ts`
 * states exactly the same: no more, no fewer names, and the same attribute
 * sets, instrument types, units and severities. Same pattern as 001's
 * `packages/catalog/src/telemetry/contract.test.ts`.
 *
 * ## Module under test and assumed API
 *
 * `./contract.ts` does not exist yet (red phase). Expected exports, with the
 * same shapes as `@tayzu/catalog`'s contract (minus the operation-span
 * `kind`, which design.md's 002 tables do not carry):
 *
 * ```ts
 * export interface SpanContract {
 *   readonly name: string;
 *   readonly requiredAttributes: readonly string[];
 *   readonly conditionalAttributes: readonly string[];
 * }
 * export const SPANS: readonly SpanContract[];
 *
 * export interface MetricContract {
 *   readonly name: string;
 *   readonly instrumentType: 'counter' | 'histogram';
 *   readonly unit: string;
 *   readonly attributes: readonly string[]; // the complete allowed set
 * }
 * export const METRICS: readonly MetricContract[];
 *
 * export interface LogEventContract {
 *   readonly name: string;
 *   readonly severity: 'INFO' | 'WARN' | 'ERROR';
 *   readonly attributes: readonly string[]; // conditional ones included
 * }
 * export const LOG_EVENTS: readonly LogEventContract[];
 *
 * // design.md, "Sampling exemption": every log event above.
 * export const SAMPLING_EXEMPT_SIGNALS: readonly string[];
 *
 * // design.md, "Forbidden on any signal" (attribute keys that must never appear).
 * ```
 *
 * The shared keys (`tayzu.tenant.id`, `tayzu.actor.type`, `tayzu.actor.id`)
 * must come from `@tayzu/observability/semconv` inside `contract.ts`. This
 * test compares against the literal values, so it does not itself need that
 * dependency. NOTE for the implementer: `packages/authz/package.json` does
 * not yet list `@tayzu/observability` (`workspace:*`), which `contract.ts`
 * needs.
 */
import { describe, expect, it } from 'vitest';

import {
  LOG_EVENTS,
  METRICS,
  SAMPLING_EXEMPT_SIGNALS,
  SPANS,
  type LogEventContract,
  type MetricContract,
  type SpanContract,
} from './contract.js';

const TENANT = 'tayzu.tenant.id';
const ACTOR_TYPE = 'tayzu.actor.type';
const ACTOR_ID = 'tayzu.actor.id';
const KIND = 'tayzu.authz.resource.kind';
const ACTION = 'tayzu.authz.action';
const CRED_KIND = 'tayzu.auth.credential.kind';
const METHOD = 'tayzu.auth.method';
const AUTH_EVENT = 'tayzu.auth.event';
const LINK_ACTOR = 'tayzu.auth.link.actor';
const LOGOUT_OUTCOME = 'tayzu.auth.backchannel_logout.outcome';
const FAILURE_REASON = 'tayzu.auth.failure_reason';
const RATE_SCOPE = 'tayzu.auth.rate_limit.scope';
const OPERATION = 'tayzu.catalog.operation';

/** design.md, "Observability contract" -> Spans table, transcribed verbatim. */
const DESIGN_SPANS: readonly SpanContract[] = [
  {
    name: 'authz.check',
    requiredAttributes: [KIND, ACTION],
    conditionalAttributes: ['tayzu.authz.cerbos.call_id'],
  },
  {
    name: 'authz.plan',
    requiredAttributes: [KIND],
    conditionalAttributes: ['tayzu.authz.plan.kind'],
  },
  {
    name: 'auth.token.exchange',
    requiredAttributes: [CRED_KIND],
    conditionalAttributes: [],
  },
  {
    name: 'auth.session.step_up_check',
    requiredAttributes: [METHOD],
    conditionalAttributes: ['tayzu.auth.step_up.fresh'],
  },
  {
    name: 'auth.sso.callback',
    requiredAttributes: [METHOD],
    conditionalAttributes: ['tayzu.auth.sso.outcome'],
  },
  {
    name: 'auth.backchannel_logout.received',
    requiredAttributes: [],
    conditionalAttributes: [LOGOUT_OUTCOME],
  },
];

/** design.md, "Observability contract" -> Metrics table, transcribed verbatim. */
const DESIGN_METRICS: readonly MetricContract[] = [
  {
    name: 'tayzu.authz.decisions',
    instrumentType: 'counter',
    unit: '{decision}',
    attributes: [TENANT, KIND, ACTION, 'tayzu.authz.decision'],
  },
  {
    name: 'tayzu.authz.check.duration',
    instrumentType: 'histogram',
    unit: 's',
    attributes: [KIND],
  },
  {
    name: 'tayzu.auth.session.events',
    instrumentType: 'counter',
    unit: '{event}',
    attributes: [AUTH_EVENT],
  },
  {
    name: 'tayzu.auth.mfa.events',
    instrumentType: 'counter',
    unit: '{event}',
    attributes: [AUTH_EVENT],
  },
  {
    name: 'tayzu.auth.step_up.required',
    instrumentType: 'counter',
    unit: '{event}',
    attributes: [OPERATION],
  },
  {
    name: 'tayzu.auth.token.exchanges',
    instrumentType: 'counter',
    unit: '{exchange}',
    attributes: [CRED_KIND, 'tayzu.auth.exchange.outcome'],
  },
  {
    name: 'tayzu.auth.rate_limit.events',
    instrumentType: 'counter',
    unit: '{event}',
    attributes: [RATE_SCOPE],
  },
  {
    name: 'tayzu.auth.token.revocation_checks',
    instrumentType: 'counter',
    unit: '{check}',
    attributes: [CRED_KIND, 'tayzu.auth.revocation.result'],
  },
  {
    name: 'tayzu.auth.sso.events',
    instrumentType: 'counter',
    unit: '{event}',
    attributes: [AUTH_EVENT],
  },
  {
    name: 'tayzu.auth.account_link.events',
    instrumentType: 'counter',
    unit: '{event}',
    attributes: [AUTH_EVENT, LINK_ACTOR],
  },
  {
    name: 'tayzu.auth.backchannel_logout.events',
    instrumentType: 'counter',
    unit: '{event}',
    attributes: [LOGOUT_OUTCOME],
  },
];

/** design.md, "Observability contract" -> Log events table, transcribed verbatim. */
const DESIGN_LOG_EVENTS: readonly LogEventContract[] = [
  { name: 'auth.security.login_succeeded', severity: 'INFO', attributes: [ACTOR_ID, TENANT] },
  { name: 'auth.security.login_failed', severity: 'WARN', attributes: [FAILURE_REASON] },
  {
    name: 'auth.security.session_revoked',
    severity: 'INFO',
    attributes: [TENANT, ACTOR_ID, 'tayzu.auth.revocation.reason'],
  },
  {
    name: 'catalog.security.authz_denied',
    severity: 'WARN',
    attributes: [TENANT, ACTOR_TYPE, ACTOR_ID, KIND, ACTION],
  },
  {
    name: 'auth.security.step_up_required',
    severity: 'WARN',
    attributes: [TENANT, ACTOR_ID, OPERATION],
  },
  { name: 'auth.security.token_exchange_failed', severity: 'WARN', attributes: [CRED_KIND] },
  { name: 'auth.security.rate_limited', severity: 'WARN', attributes: [RATE_SCOPE] },
  {
    name: 'auth.security.revoked_token_rejected',
    severity: 'WARN',
    attributes: [TENANT, CRED_KIND],
  },
  { name: 'auth.security.sso_sign_in_failed', severity: 'WARN', attributes: [FAILURE_REASON] },
  {
    name: 'auth.security.account_linked',
    severity: 'INFO',
    attributes: [TENANT, ACTOR_ID, LINK_ACTOR],
  },
  {
    name: 'auth.security.account_unlinked',
    severity: 'INFO',
    attributes: [TENANT, ACTOR_ID, LINK_ACTOR],
  },
  {
    name: 'auth.security.step_up_insufficient',
    severity: 'WARN',
    attributes: [TENANT, ACTOR_ID, METHOD],
  },
  {
    name: 'auth.security.backchannel_logout_received',
    severity: 'INFO',
    attributes: [LOGOUT_OUTCOME],
  },
  {
    name: 'auth.internal_error',
    severity: 'ERROR',
    attributes: ['error.type', 'db.response.status_code'],
  },
];

/**
 * design.md, "Forbidden on any signal" (002 additions): attribute keys that
 * would carry an IP, email, Visma Connect sub/sid, or a token/secret/code.
 */
const FORBIDDEN_KEY_FRAGMENTS = [
  'ip',
  'email',
  '.sub',
  '.sid',
  'session.id',
  'token.value',
  'id_token',
  'access_token',
  'logout_token',
  'secret',
  'totp',
  'backup_code',
];

function byName<T extends { readonly name: string }>(entries: readonly T[]): Map<string, T> {
  return new Map(entries.map((entry) => [entry.name, entry]));
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

describe('authz telemetry/contract.ts mirrors design.md, "Observability contract" (task 13.1)', () => {
  describe('Spans', () => {
    it('declares exactly the 6 spans design.md names, no more and no fewer', () => {
      expect(sorted(SPANS.map((span) => span.name))).toEqual(
        sorted(DESIGN_SPANS.map((span) => span.name)),
      );
    });

    it.each(DESIGN_SPANS.map((span) => [span.name, span] as const))(
      "span %s has design.md's exact required and conditional attributes",
      (name, expected) => {
        const actual = byName(SPANS).get(name);
        expect(actual, `contract.ts must declare span ${name}`).toBeDefined();
        expect(sorted(actual?.requiredAttributes ?? [])).toEqual(
          sorted(expected.requiredAttributes),
        );
        expect(sorted(actual?.conditionalAttributes ?? [])).toEqual(
          sorted(expected.conditionalAttributes),
        );
      },
    );
  });

  describe('Metrics', () => {
    it('declares exactly the 11 metrics design.md names, no more and no fewer', () => {
      expect(sorted(METRICS.map((metric) => metric.name))).toEqual(
        sorted(DESIGN_METRICS.map((metric) => metric.name)),
      );
    });

    it.each(DESIGN_METRICS.map((metric) => [metric.name, metric] as const))(
      "metric %s has design.md's exact instrument type, unit and complete allowed attribute set",
      (name, expected) => {
        const actual = byName(METRICS).get(name);
        expect(actual, `contract.ts must declare metric ${name}`).toBeDefined();
        expect(actual?.instrumentType).toBe(expected.instrumentType);
        expect(actual?.unit).toBe(expected.unit);
        expect(sorted(actual?.attributes ?? [])).toEqual(sorted(expected.attributes));
      },
    );

    it('never lets a metric carry an actor id, credential id, IP, email, sub or sid (cardinality budget)', () => {
      for (const metric of METRICS) {
        expect(metric.attributes).not.toContain(ACTOR_ID);
        for (const attribute of metric.attributes) {
          for (const fragment of ['ip', 'email', '.sub', '.sid', 'credential.id']) {
            expect(attribute.split(/[._]/)).not.toContain(fragment.replace('.', ''));
          }
        }
      }
    });
  });

  describe('Log events', () => {
    it('declares exactly the 14 log events design.md names, no more and no fewer', () => {
      expect(sorted(LOG_EVENTS.map((event) => event.name))).toEqual(
        sorted(DESIGN_LOG_EVENTS.map((event) => event.name)),
      );
    });

    it.each(DESIGN_LOG_EVENTS.map((event) => [event.name, event] as const))(
      "log event %s has design.md's exact severity and attributes",
      (name, expected) => {
        const actual = byName(LOG_EVENTS).get(name);
        expect(actual, `contract.ts must declare log event ${name}`).toBeDefined();
        expect(actual?.severity).toBe(expected.severity);
        expect(sorted(actual?.attributes ?? [])).toEqual(sorted(expected.attributes));
      },
    );

    it('no span, metric or log event declares an attribute the design forbids on any signal', () => {
      const all = [
        ...SPANS.flatMap((s) => [...s.requiredAttributes, ...s.conditionalAttributes]),
        ...METRICS.flatMap((m) => m.attributes),
        ...LOG_EVENTS.flatMap((e) => e.attributes),
      ];
      expect(all.length).toBeGreaterThan(0);
      for (const attribute of all) {
        const segments = attribute.split(/[._]/);
        for (const fragment of FORBIDDEN_KEY_FRAGMENTS) {
          const token = fragment.replace(/^\./, '');
          if (!token.includes('.')) {
            expect(segments, `${attribute} contains forbidden ${token}`).not.toContain(token);
          }
        }
      }
    });
  });

  describe('Sampling exemption (design.md, "Sampling exemption")', () => {
    it('exempts every 002 log event from sampling and filter/drop rules', () => {
      for (const event of DESIGN_LOG_EVENTS) {
        expect(SAMPLING_EXEMPT_SIGNALS).toContain(event.name);
      }
    });
  });
});

/**
 * Task 27.4 (design Q76, "Observability contract" -> Log events): the
 * `auth.internal_error` row, transcribed verbatim:
 * `| auth.internal_error | ERROR | error.type; db.response.status_code
 * (SQLSTATE) when present |`. `otel-smoke-check` reads this module, so
 * declaring the name here is what makes it "know" the new name.
 */
describe('auth.internal_error is declared (task 27.4, design Q76)', () => {
  it('declares auth.internal_error: ERROR, error.type and db.response.status_code', () => {
    const actual = LOG_EVENTS.find((event) => event.name === 'auth.internal_error');
    expect(actual?.severity).toBe('ERROR');
    expect(sorted(actual?.attributes ?? [])).toEqual(
      sorted(['error.type', 'db.response.status_code']),
    );
  });
});
