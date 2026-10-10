/**
 * The recipient-domain allowlist wrapper (`043` design D5, Resolved decisions Q67 and Q99).
 * A recipient off the list is refused like a provider failure and logged without any address.
 * Canonicalizing the address before the comparison is task 7.10's.
 */
import { emitIdentityEvent } from '../../telemetry/identity-telemetry.js';
import { EmailProviderError } from './azure-communication-email.js';
import type { EmailSender, EmailTemplate } from './sender.js';

const TEMPLATE_NAMES: Record<EmailTemplate['kind'], string> = {
  InvitationEmail: 'invitation',
  AdminAcceptedNotice: 'admin_accepted',
};

export function createAllowlistEmailSender(
  inner: EmailSender,
  allowedDomains: readonly string[],
): EmailSender {
  const allowed = new Set(allowedDomains);
  return {
    async send(to, template) {
      const domain = to.slice(to.lastIndexOf('@') + 1);
      if (!to.includes('@') || !allowed.has(domain)) {
        emitIdentityEvent({
          name: 'catalog.security.email_recipient_blocked',
          severity: 'WARN',
          attributes: { 'tayzu.identity.email.template': TEMPLATE_NAMES[template.kind] },
        });
        throw new EmailProviderError();
      }
      await inner.send(to, template);
    },
  };
}
