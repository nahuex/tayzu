/**
 * The account-linking audit signals (task 20.4, design D24): the
 * `auth.security.account_linked` / `account_unlinked` log events and the
 * `tayzu.auth.account_link.events` counter. Identifiers only: no `sub`, email
 * or IP ever reaches a signal.
 */
import { SeverityNumber } from '@opentelemetry/api-logs';
import { sharedAttributeKeys } from '@tayzu/observability/semconv';

import { accountLinkEventsCounter, logger } from './telemetry/instruments.js';

export type AccountLinkActor = 'self' | 'admin';

const LINK_ACTOR_ATTRIBUTE = 'tayzu.auth.link.actor';

export function emitAccountLinkEvent(
  event: 'linked' | 'unlinked',
  actor: AccountLinkActor,
  params: { readonly actorId: string; readonly tenantId?: string },
): void {
  const attributes: Record<string, string> = {
    [sharedAttributeKeys.actorId]: params.actorId,
    [LINK_ACTOR_ATTRIBUTE]: actor,
  };
  if (params.tenantId !== undefined) {
    attributes[sharedAttributeKeys.tenantId] = params.tenantId;
  }
  logger.emit({
    eventName: `auth.security.account_${event}`,
    severityNumber: SeverityNumber.INFO,
    severityText: 'INFO',
    attributes,
  });
  accountLinkEventsCounter.add(1, { 'tayzu.auth.event': event, [LINK_ACTOR_ATTRIBUTE]: actor });
}
