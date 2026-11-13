/**
 * The recipient-domain allowlist wrapper (`043` design D5, Resolved decisions Q67 and Q99).
 * A recipient off the list is refused like a provider failure and logged without any address.
 * The address is canonicalized (NFC, trimmed, lower-cased; the form of `apps/api`'s
 * `email-canonical.ts`, which this package cannot import) before the comparison.
 */
import { emitIdentityEvent } from '../../telemetry/identity-telemetry.js';
import { EmailProviderError } from './azure-communication-email.js';
import type { EmailSender, EmailTemplate } from './sender.js';

const TEMPLATE_NAMES: Record<EmailTemplate['kind'], string> = {
  InvitationEmail: 'invitation',
  AdminAcceptedNotice: 'admin_accepted',
  PasswordResetEmail: 'password_reset',
  PasswordChangedNotice: 'password_changed',
  MfaChangedNotice: 'mfa_changed',
  MfaResetNotice: 'mfa_reset',
  AccountCreatedNotice: 'account_created',
};

function canonicalRecipient(address: string): string {
  return address.normalize('NFC').trim().toLowerCase();
}

/**
 * The one allowlist test (`044` design D5): the sender wrapper and the reset mailer both use
 * it. An address without `@`, and any address against an empty list, is not allowed.
 */
export function isRecipientDomainAllowed(
  address: string,
  allowedDomains: readonly string[],
): boolean {
  const to = canonicalRecipient(address);
  if (!to.includes('@')) return false;
  return allowedDomains.includes(to.slice(to.lastIndexOf('@') + 1));
}

export function createAllowlistEmailSender(
  inner: EmailSender,
  allowedDomains: readonly string[],
): EmailSender {
  return {
    async send(rawTo, template) {
      const to = canonicalRecipient(rawTo);
      if (!isRecipientDomainAllowed(to, allowedDomains)) {
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
