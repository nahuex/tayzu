/**
 * The one way a notice email is sent (`043` design D5 "Notice emails", Resolved decisions
 * Q53, Q58, Q101). The tenant list comes first, then the kill switch, the per-tenant notice
 * cap and the notices' own per-recipient bucket. At most 20 recipients, the longest-standing
 * members, are notified, and `send` never throws into its caller. A suppressed or truncated
 * notice is logged with the reason and a count, never an address. The template name of every
 * event is derived from the kind (`045` design D5).
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

/** The templates the dispatcher sends: `043`'s admin notice and `045`'s deletion notice. */
export type NoticeTemplate = Extract<
  EmailTemplate,
  { kind: 'AdminAcceptedNotice' | 'OrgDeletionNotice' }
>;

export interface NoticeDispatcher {
  send(input: {
    readonly tenantId: string;
    readonly template: NoticeTemplate;
    readonly recipients: readonly NoticeRecipient[];
    /**
     * Called once per recipient whose email the provider refused, or once when the dispatch
     * itself failed; never for a suppression. It must not throw; if it does, the error
     * is swallowed like any other, so `send` still never throws.
     */
    readonly onSendFailure?: () => void;
  }): Promise<void>;
}

const MAX_RECIPIENTS = 20;

/** The telemetry name of each template (`tayzu.identity.notice.template`). */
const TEMPLATE_NAMES = {
  AdminAcceptedNotice: 'admin_accepted',
  OrgDeletionNotice: 'org_deletion',
} as const satisfies Record<NoticeTemplate['kind'], string>;

/** Tells the caller a send failed; the callback's own failure is swallowed too. */
function reportFailure(onSendFailure: (() => void) | undefined): void {
  try {
    onSendFailure?.();
  } catch {
    // The callback is the caller's; it never turns into a throw from `send`.
  }
}

type Suppression = 'global' | 'tenant' | 'recipient' | 'truncated';

export function createNoticeDispatcher(deps: {
  readonly disabledTenantIds: readonly string[];
  readonly capStore: EmailCapStore;
  readonly sender: EmailSender;
  readonly recipientKeySecret: string;
  readonly killSwitch?: boolean;
}): NoticeDispatcher {
  const disabled = new Set(deps.disabledTenantIds);

  function emitSuppressed(
    tenantId: string,
    templateName: string,
    suppression: Suppression,
    dropped: number,
  ) {
    if (dropped === 0) return;
    emitIdentityEvent({
      name: 'catalog.security.notice_suppressed',
      severity: 'WARN',
      attributes: {
        'tayzu.tenant.id': tenantId,
        'tayzu.identity.notice.template': templateName,
        'tayzu.identity.notice.suppression': suppression,
        'tayzu.identity.notice.dropped': dropped,
      },
    });
  }

  async function dispatch(input: Parameters<NoticeDispatcher['send']>[0]) {
    const { tenantId, template, onSendFailure } = input;
    const templateName = TEMPLATE_NAMES[template.kind];
    if (disabled.has(tenantId)) {
      emitIdentityEvent({
        name: 'catalog.security.email_tenant_blocked',
        severity: 'WARN',
        attributes: {
          'tayzu.tenant.id': tenantId,
          'tayzu.identity.email.template': templateName,
        },
      });
      return;
    }
    const ordered = [...input.recipients].sort(
      (a, b) => a.memberSince.getTime() - b.memberSince.getTime(),
    );
    const selected = ordered.slice(0, MAX_RECIPIENTS);
    emitSuppressed(tenantId, templateName, 'truncated', ordered.length - selected.length);
    if (deps.killSwitch === true) {
      emitSuppressed(tenantId, templateName, 'global', selected.length);
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
        // A failing provider never reaches the caller of the notice, only its callback.
        reportFailure(onSendFailure);
      }
    }
    emitSuppressed(tenantId, templateName, 'tenant', tenantDropped);
    emitSuppressed(tenantId, templateName, 'recipient', recipientDropped);
  }

  return {
    async send(input) {
      try {
        await dispatch(input);
      } catch {
        // Fail quiet: a notice must never break the operation that triggered it.
        reportFailure(input.onSendFailure);
      }
    },
  };
}
