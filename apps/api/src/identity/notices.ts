/**
 * The one way a notice email is sent (`043` design D5 "Notice emails", Resolved decisions
 * Q53, Q58, Q101). The tenant list comes first, then the kill switch, the per-tenant notice
 * cap and the notices' own per-recipient bucket. At most 20 recipients, the longest-standing
 * members, are notified, and `send` never throws into its caller. A suppressed or truncated
 * notice is logged with the reason and a count, never an address.
 */
import {
  AuthRateLimitedError,
  emitIdentityEvent,
  type EmailSender,
  type EmailTemplate,
} from '@tayzu/auth';

import type { EmailCapStore } from './email-tenant-gate.js';
import { recipientKey } from './recipient-key.js';

export interface NoticeRecipient {
  /** Already canonical. */
  readonly email: string;
  /** Membership creation; the dispatcher keeps the 20 oldest. */
  readonly memberSince: Date;
  /** Never used to filter: `Disabled` administrators are notified too. */
  readonly status?: 'Active' | 'Disabled';
}

export interface NoticeDispatcher {
  send(input: {
    readonly tenantId: string;
    readonly template: Extract<EmailTemplate, { kind: 'AdminAcceptedNotice' }>;
    readonly recipients: readonly NoticeRecipient[];
  }): Promise<void>;
}

const MAX_RECIPIENTS = 20;
const TEMPLATE_NAME = 'admin_accepted';

type Suppression = 'global' | 'tenant' | 'recipient' | 'truncated';

export function createNoticeDispatcher(deps: {
  readonly disabledTenantIds: readonly string[];
  readonly capStore: EmailCapStore;
  readonly sender: EmailSender;
  readonly recipientKeySecret: string;
  readonly killSwitch?: boolean;
}): NoticeDispatcher {
  const disabled = new Set(deps.disabledTenantIds);

  function emitSuppressed(tenantId: string, suppression: Suppression, dropped: number) {
    if (dropped === 0) return;
    emitIdentityEvent({
      name: 'catalog.security.notice_suppressed',
      severity: 'WARN',
      attributes: {
        'tayzu.tenant.id': tenantId,
        'tayzu.identity.notice.template': TEMPLATE_NAME,
        'tayzu.identity.notice.suppression': suppression,
        'tayzu.identity.notice.dropped': dropped,
      },
    });
  }

  async function dispatch(input: Parameters<NoticeDispatcher['send']>[0]) {
    const { tenantId, template } = input;
    if (disabled.has(tenantId)) {
      emitIdentityEvent({
        name: 'catalog.security.email_tenant_blocked',
        severity: 'WARN',
        attributes: {
          'tayzu.tenant.id': tenantId,
          'tayzu.identity.email.template': TEMPLATE_NAME,
        },
      });
      return;
    }
    const ordered = [...input.recipients].sort(
      (a, b) => a.memberSince.getTime() - b.memberSince.getTime(),
    );
    const selected = ordered.slice(0, MAX_RECIPIENTS);
    emitSuppressed(tenantId, 'truncated', ordered.length - selected.length);
    if (deps.killSwitch === true) {
      emitSuppressed(tenantId, 'global', selected.length);
      return;
    }
    let tenantDropped = 0;
    let recipientDropped = 0;
    for (const recipient of selected) {
      try {
        await deps.capStore.consume('notice_tenant', tenantId);
      } catch (error) {
        if (error instanceof AuthRateLimitedError) tenantDropped += 1;
        continue;
      }
      try {
        await deps.capStore.consume(
          'notice_recipient',
          recipientKey(recipient.email, deps.recipientKeySecret),
        );
      } catch (error) {
        if (error instanceof AuthRateLimitedError) recipientDropped += 1;
        continue;
      }
      try {
        await deps.sender.send(recipient.email, template);
      } catch {
        // A failing provider never reaches the caller of the notice.
      }
    }
    emitSuppressed(tenantId, 'tenant', tenantDropped);
    emitSuppressed(tenantId, 'recipient', recipientDropped);
  }

  return {
    async send(input) {
      try {
        await dispatch(input);
      } catch {
        // Fail quiet: a notice must never break the operation that triggered it.
      }
    },
  };
}
