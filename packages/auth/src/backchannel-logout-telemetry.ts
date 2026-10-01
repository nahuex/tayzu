/**
 * The back-channel logout signals (task 22.4, design D26): the
 * `auth.backchannel_logout.received` span and the
 * `tayzu.auth.backchannel_logout.events` counter and the
 * `auth.security.backchannel_logout_received` log event. Both carry only the closed
 * outcome attribute: no `sub`, `sid`, token, email or IP ever reaches a signal.
 */
import { SpanStatusCode } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';

import { backchannelLogoutEventsCounter, logger, tracer } from './telemetry/instruments.js';

export type BackchannelLogoutOutcome = 'revoked' | 'replay' | 'invalid' | 'no_match';

const OUTCOME_ATTRIBUTE = 'tayzu.auth.backchannel_logout.outcome';

/**
 * Runs one back-channel logout request inside its span and counts its outcome.
 * A thrown error is recorded as the `invalid` outcome (fail closed) and rethrown.
 */
export async function withBackchannelLogoutTelemetry(
  handle: () => Promise<BackchannelLogoutOutcome>,
): Promise<BackchannelLogoutOutcome> {
  return tracer.startActiveSpan('auth.backchannel_logout.received', async (span) => {
    let outcome: BackchannelLogoutOutcome = 'invalid';
    try {
      outcome = await handle();
      return outcome;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.setAttribute(OUTCOME_ATTRIBUTE, outcome);
      backchannelLogoutEventsCounter.add(1, { [OUTCOME_ATTRIBUTE]: outcome });
      logger.emit({
        eventName: 'auth.security.backchannel_logout_received',
        severityNumber: SeverityNumber.INFO,
        attributes: { [OUTCOME_ATTRIBUTE]: outcome },
      });
      span.end();
    }
  });
}
