/**
 * The one gate that sends invitation emails (`043` design D5, Resolved decision Q80).
 * A tenant on `EMAIL_DISABLED_TENANT_IDS` has its email suppressed before any cap is
 * consumed; nothing reaches the sender, the operation is not blocked, and the event
 * carries the tenant and the template, never an address.
 */
import {
  AuthRateLimitedError,
  emitIdentityEvent,
  type EmailSender,
  type EmailTemplate,
} from '@tayzu/auth';

import { recipientKey } from './recipient-key.js';

/** The port of the caps of 6.6 to 6.8 and 6.10. */
export interface EmailCapStore {
  consume(scope: string, key: string): Promise<void>;
}

export interface EmailTenantGate {
  send(input: {
    readonly tenantId: string;
    readonly to: string;
    readonly template: EmailTemplate;
  }): Promise<void>;
}

const TEMPLATE_NAMES: Record<EmailTemplate['kind'], string> = {
  InvitationEmail: 'invitation',
  AdminAcceptedNotice: 'admin_accepted',
};

export function createEmailTenantGate(deps: {
  readonly disabledTenantIds: readonly string[];
  readonly capStore: EmailCapStore;
  readonly sender: EmailSender;
  /** The HMAC secret of the recipient key (6.7b); the recipient cap runs only when set. */
  readonly recipientKeySecret?: string;
}): EmailTenantGate {
  const disabled = new Set(deps.disabledTenantIds);
  async function consumeCap(scope: 'tenant' | 'recipient', key: string, tenantId: string) {
    try {
      await deps.capStore.consume(scope, key);
    } catch (error) {
      if (error instanceof AuthRateLimitedError) {
        emitIdentityEvent({
          name: 'catalog.security.invitation_rate_limited',
          severity: 'WARN',
          attributes: {
            'tayzu.tenant.id': tenantId,
            'tayzu.identity.invitation.limit_scope': scope,
          },
        });
      }
      throw error;
    }
  }
  return {
    async send({ tenantId, to, template }) {
      if (disabled.has(tenantId)) {
        emitIdentityEvent({
          name: 'catalog.security.email_tenant_blocked',
          severity: 'WARN',
          attributes: {
            'tayzu.tenant.id': tenantId,
            'tayzu.identity.email.template': TEMPLATE_NAMES[template.kind],
          },
        });
        return;
      }
      await consumeCap('tenant', tenantId, tenantId);
      if (deps.recipientKeySecret !== undefined) {
        await consumeCap('recipient', recipientKey(to, deps.recipientKeySecret), tenantId);
      }
      await deps.sender.send(to, template);
    },
  };
}
