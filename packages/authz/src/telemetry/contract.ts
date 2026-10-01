/**
 * Task 13.1 (openspec/changes/002-auth-and-rbac/tasks.md): the executable
 * mirror of design.md's "Observability contract" section for 002. It is pure
 * data (no tracer, meter or logger), so importing it never pulls the OTel SDK
 * in. `otel-smoke-check` and the `observability-auditor` subagent check the
 * running system against these names; nothing else invents a new one.
 */
import { sharedAttributeKeys } from '@tayzu/observability/semconv';

const TENANT = sharedAttributeKeys.tenantId;
const ACTOR_TYPE = sharedAttributeKeys.actorType;
const ACTOR_ID = sharedAttributeKeys.actorId;
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

export interface SpanContract {
  readonly name: string;
  readonly requiredAttributes: readonly string[];
  readonly conditionalAttributes: readonly string[];
}

/** design.md, "Observability contract" -> Spans table. */
export const SPANS: readonly SpanContract[] = [
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
  { name: 'auth.token.exchange', requiredAttributes: [CRED_KIND], conditionalAttributes: [] },
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

export interface MetricContract {
  readonly name: string;
  readonly instrumentType: 'counter' | 'histogram';
  readonly unit: string;
  /** The complete allowed attribute set: nothing else may be recorded. */
  readonly attributes: readonly string[];
}

/** design.md, "Observability contract" -> Metrics table. */
export const METRICS: readonly MetricContract[] = [
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

export interface LogEventContract {
  readonly name: string;
  readonly severity: 'INFO' | 'WARN' | 'ERROR';
  /** Conditional attributes included. */
  readonly attributes: readonly string[];
}

/** design.md, "Observability contract" -> Log events table. */
export const LOG_EVENTS: readonly LogEventContract[] = [
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
 * design.md, "Sampling exemption": every 002 log event is exempt from
 * sampling and from filter or drop rules in any downstream pipeline.
 */
export const SAMPLING_EXEMPT_SIGNALS: readonly string[] = LOG_EVENTS.map((event) => event.name);
