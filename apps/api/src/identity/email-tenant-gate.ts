/**
 * The one gate that sends invitation emails (`043` design D5, Resolved decision Q80).
 * A tenant on `EMAIL_DISABLED_TENANT_IDS` has its email suppressed before any cap is
 * consumed; nothing reaches the sender, the operation is not blocked, and the event
 * carries the tenant and the template, never an address.
 */
import { emitIdentityEvent, type EmailSender, type EmailTemplate } from '@tayzu/auth';

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
}): EmailTenantGate {
  const disabled = new Set(deps.disabledTenantIds);
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
      await deps.sender.send(to, template);
    },
  };
}
