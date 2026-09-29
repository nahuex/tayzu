/**
 * Task 13.6 (openspec/changes/002-auth-and-rbac/tasks.md): reconcile
 * `@tayzu/auth`'s telemetry contract with `@tayzu/authz`'s (task 13.1, already
 * verified against design.md's "Observability contract" tables) and with the
 * design itself.
 *
 * `@tayzu/authz`'s contract is the whole 002 surface; `@tayzu/auth`'s is the
 * subset this package emits: every `auth.*` span, every `tayzu.auth.*` metric
 * and every `auth.security.*` log event (never `authz.*`, `tayzu.authz.*` or
 * `catalog.security.authz_denied`, which belong to `@tayzu/authz` and
 * `@tayzu/catalog`). The two must agree exactly on that subset.
 *
 * ## Production symbols expected from `./contract.js`
 *
 * - `SPANS` entries now use the same shape as authz's:
 *   `{ name, requiredAttributes, conditionalAttributes }` (today they carry a
 *   single `attributes` list that wrongly makes `tayzu.auth.step_up.fresh`,
 *   `tayzu.auth.sso.outcome` and the back-channel outcome look required).
 *   The `auth.backchannel_logout.received` span has no required attribute.
 * - `METRICS` gains `tayzu.auth.mfa.events`.
 * - `LOG_EVENTS` gains `auth.security.sso_sign_in_failed` and
 *   `auth.security.backchannel_logout_received`.
 * - `SAMPLING_EXEMPT_SIGNALS` lists every `LOG_EVENTS` name.
 *
 * The authz contract is imported by relative path, as `apps/api`'s
 * otel-smoke-check does: `@tayzu/auth` has no dependency on `@tayzu/authz`.
 */
import { describe, expect, it } from 'vitest';

import {
  LOG_EVENTS as AUTHZ_LOG_EVENTS,
  METRICS as AUTHZ_METRICS,
  SAMPLING_EXEMPT_SIGNALS as AUTHZ_SAMPLING_EXEMPT,
  SPANS as AUTHZ_SPANS,
} from '../../../authz/src/telemetry/contract.js';
import { LOG_EVENTS, METRICS, SAMPLING_EXEMPT_SIGNALS, SPANS } from './contract.js';

const TENANT = 'tayzu.tenant.id';
const ACTOR_ID = 'tayzu.actor.id';
const METHOD = 'tayzu.auth.method';
const FAILURE_REASON = 'tayzu.auth.failure_reason';
const LOGOUT_OUTCOME = 'tayzu.auth.backchannel_logout.outcome';

const sorted = (values: readonly string[] | undefined): string[] => [...(values ?? [])].sort();

const isAuthSpan = (name: string): boolean => name.startsWith('auth.');
const isAuthMetric = (name: string): boolean => name.startsWith('tayzu.auth.');
const isAuthLogEvent = (name: string): boolean => name.startsWith('auth.security.');

const authzAuthSpans = AUTHZ_SPANS.filter((span) => isAuthSpan(span.name));
const authzAuthMetrics = AUTHZ_METRICS.filter((metric) => isAuthMetric(metric.name));
const authzAuthLogEvents = AUTHZ_LOG_EVENTS.filter((event) => isAuthLogEvent(event.name));

describe('auth telemetry/contract.ts agrees with authz telemetry/contract.ts and design.md (task 13.6)', () => {
  describe('the two contracts agree with each other', () => {
    it('declares exactly the auth.* spans authz declares', () => {
      expect(sorted(SPANS.map((span) => span.name))).toEqual(
        sorted(authzAuthSpans.map((span) => span.name)),
      );
    });

    it.each(authzAuthSpans.map((span) => [span.name, span] as const))(
      'span %s has the same required and conditional attributes in both contracts',
      (name, expected) => {
        const actual = SPANS.find((span) => span.name === name) as
          | {
              requiredAttributes?: readonly string[];
              conditionalAttributes?: readonly string[];
            }
          | undefined;
        expect(actual, `@tayzu/auth's contract must declare span ${name}`).toBeDefined();
        expect(sorted(actual?.requiredAttributes)).toEqual(sorted(expected.requiredAttributes));
        expect(sorted(actual?.conditionalAttributes)).toEqual(
          sorted(expected.conditionalAttributes),
        );
      },
    );

    it('declares exactly the tayzu.auth.* metrics authz declares', () => {
      expect(sorted(METRICS.map((metric) => metric.name))).toEqual(
        sorted(authzAuthMetrics.map((metric) => metric.name)),
      );
    });

    it.each(authzAuthMetrics.map((metric) => [metric.name, metric] as const))(
      'metric %s has the same instrument type, unit and attribute set in both contracts',
      (name, expected) => {
        const actual = METRICS.find((metric) => metric.name === name);
        expect(actual, `@tayzu/auth's contract must declare metric ${name}`).toBeDefined();
        expect(actual?.instrumentType).toBe(expected.instrumentType);
        expect(actual?.unit).toBe(expected.unit);
        expect(sorted(actual?.attributes)).toEqual(sorted(expected.attributes));
      },
    );

    it('declares exactly the auth.security.* log events authz declares', () => {
      expect(sorted(LOG_EVENTS.map((event) => event.name))).toEqual(
        sorted(authzAuthLogEvents.map((event) => event.name)),
      );
    });

    it.each(authzAuthLogEvents.map((event) => [event.name, event] as const))(
      'log event %s has the same severity and attributes in both contracts',
      (name, expected) => {
        const actual = LOG_EVENTS.find((event) => event.name === name);
        expect(actual, `@tayzu/auth's contract must declare log event ${name}`).toBeDefined();
        expect(actual?.severity).toBe(expected.severity);
        expect(sorted(actual?.attributes)).toEqual(sorted(expected.attributes));
      },
    );

    it('exempts from sampling the same auth.security.* events in both contracts', () => {
      expect(sorted(SAMPLING_EXEMPT_SIGNALS)).toEqual(
        sorted(AUTHZ_SAMPLING_EXEMPT.filter(isAuthLogEvent)),
      );
    });

    it('never declares an authz.* or catalog.* signal (those belong to other packages)', () => {
      const names = [
        ...SPANS.map((span) => span.name),
        ...METRICS.map((metric) => metric.name),
        ...LOG_EVENTS.map((event) => event.name),
      ];
      for (const name of names) {
        expect(name).not.toMatch(/^(authz\.|tayzu\.authz\.|catalog\.)/);
      }
    });
  });

  describe('the signals design.md names that were missing', () => {
    it('declares auth.security.sso_sign_in_failed: WARN, tayzu.auth.failure_reason (design "Log events")', () => {
      const event = LOG_EVENTS.find((entry) => entry.name === 'auth.security.sso_sign_in_failed');
      expect(event).toBeDefined();
      expect(event?.severity).toBe('WARN');
      expect(sorted(event?.attributes)).toEqual([FAILURE_REASON]);
    });

    it('declares auth.security.backchannel_logout_received: INFO, tayzu.auth.backchannel_logout.outcome only (design "Log events")', () => {
      const event = LOG_EVENTS.find(
        (entry) => entry.name === 'auth.security.backchannel_logout_received',
      );
      expect(event).toBeDefined();
      expect(event?.severity).toBe('INFO');
      expect(sorted(event?.attributes)).toEqual([LOGOUT_OUTCOME]);
    });

    it('declares tayzu.auth.step_up.fresh as a conditional, not a required, attribute of auth.session.step_up_check (design "Spans")', () => {
      const span = SPANS.find((entry) => entry.name === 'auth.session.step_up_check') as
        | {
            requiredAttributes?: readonly string[];
            conditionalAttributes?: readonly string[];
          }
        | undefined;
      expect(span).toBeDefined();
      expect(sorted(span?.requiredAttributes)).toEqual([METHOD]);
      expect(sorted(span?.conditionalAttributes)).toEqual(['tayzu.auth.step_up.fresh']);
    });

    it('declares the auth.sso.callback and auth.backchannel_logout.received outcomes as conditional attributes (design "Spans")', () => {
      const callback = SPANS.find((entry) => entry.name === 'auth.sso.callback') as
        | { requiredAttributes?: readonly string[]; conditionalAttributes?: readonly string[] }
        | undefined;
      expect(sorted(callback?.requiredAttributes)).toEqual([METHOD]);
      expect(sorted(callback?.conditionalAttributes)).toEqual(['tayzu.auth.sso.outcome']);

      const logout = SPANS.find((entry) => entry.name === 'auth.backchannel_logout.received') as
        | { requiredAttributes?: readonly string[]; conditionalAttributes?: readonly string[] }
        | undefined;
      expect(sorted(logout?.requiredAttributes)).toEqual([]);
      expect(sorted(logout?.conditionalAttributes)).toEqual([LOGOUT_OUTCOME]);
    });

    it('declares tayzu.auth.mfa.events: counter, {event}, tayzu.auth.event (design "Metrics")', () => {
      const metric = METRICS.find((entry) => entry.name === 'tayzu.auth.mfa.events');
      expect(metric).toBeDefined();
      expect(metric?.instrumentType).toBe('counter');
      expect(metric?.unit).toBe('{event}');
      expect(sorted(metric?.attributes)).toEqual(['tayzu.auth.event']);
    });

    it('keeps the tenant and actor id keys on the audit log events design.md gives them', () => {
      for (const name of [
        'auth.security.login_succeeded',
        'auth.security.session_revoked',
        'auth.security.step_up_required',
        'auth.security.step_up_insufficient',
        'auth.security.account_linked',
        'auth.security.account_unlinked',
      ]) {
        const event = LOG_EVENTS.find((entry) => entry.name === name);
        expect(event?.attributes, name).toEqual(expect.arrayContaining([TENANT, ACTOR_ID]));
      }
    });
  });

  it('exempts every declared log event from sampling (design "Sampling exemption")', () => {
    for (const event of LOG_EVENTS) {
      expect(SAMPLING_EXEMPT_SIGNALS).toContain(event.name);
    }
  });
});
