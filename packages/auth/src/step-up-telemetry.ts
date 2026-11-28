/**
 * The step-up audit events (002 design Q77; 003 design D11, Q27 B2 and Q29):
 * `auth.security.step_up_succeeded` for a local TOTP step-up or a completed
 * Visma Connect re-authorization, and `auth.security.reauthorization_failed`
 * for a failed re-authorization callback. Identifiers and bounded values
 * only: no code, state, token, `sid`, `sub`, claim or email reaches either.
 */
import { SeverityNumber } from '@opentelemetry/api-logs';
import { sharedAttributeKeys } from '@tayzu/observability/semconv';

import { logger } from './telemetry/instruments.js';

/** The `tayzu.auth.method` value of a successful step-up. */
export type StepUpMethod = 'local' | 'visma_connect';

/**
 * Why a re-authorization callback failed (`tayzu.auth.reauthorization.reason`);
 * `session_mismatch` is a callback without the initiating session's cookie (048 design D6).
 */
export type ReauthorizationFailureReason = 'invalid_state' | 'exchange_failed' | 'session_mismatch';

/** 002 design.md, Log events table (Q77): `auth.security.step_up_succeeded`. */
export function emitStepUpSucceeded(params: {
  readonly actorId: string;
  readonly tenantId?: string;
  readonly method: StepUpMethod;
}): void {
  const attributes: Record<string, string> = {
    [sharedAttributeKeys.actorId]: params.actorId,
    'tayzu.auth.method': params.method,
  };
  if (params.tenantId !== undefined) {
    attributes[sharedAttributeKeys.tenantId] = params.tenantId;
  }
  logger.emit({
    eventName: 'auth.security.step_up_succeeded',
    severityNumber: SeverityNumber.INFO,
    attributes,
  });
}

/**
 * 003 design.md, Log events table (Q29): `auth.security.reauthorization_failed`.
 * It carries no tenant, because an unknown or expired state is bound to none.
 */
export function emitReauthorizationFailed(reason: ReauthorizationFailureReason): void {
  logger.emit({
    eventName: 'auth.security.reauthorization_failed',
    severityNumber: SeverityNumber.WARN,
    attributes: { 'tayzu.auth.reauthorization.reason': reason },
  });
}
