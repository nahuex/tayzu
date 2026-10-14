/**
 * The one gate that sends invitation emails (`043` design D5, Resolved decision Q80).
 * A tenant on `EMAIL_DISABLED_TENANT_IDS` has its email suppressed before any cap is
 * consumed; nothing reaches the sender, the operation is not blocked, and the event
 * carries the tenant and the template, never an address.
 */
import {
  AuthRateLimitedError,
  emitIdentityEvent,
  recordIdentityMetric,
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

/** The shortest cap window, one hour (Q61). */
const INVITATION_RETRY_AFTER_SECONDS = 3600;

const TEMPLATE_NAMES: Record<EmailTemplate['kind'], string> = {
  InvitationEmail: 'invitation',
  AdminAcceptedNotice: 'admin_accepted',
};

export function createEmailTenantGate(deps: {
  readonly disabledTenantIds: readonly string[];
  readonly capStore: EmailCapStore;
  readonly sender: EmailSender;
  /** The HMAC secret of the recipient key (6.7b); required, so the recipient cap never skips. */
  readonly recipientKeySecret: string;
  /** `INVITATION_EMAIL_KILL_SWITCH` (6.8): when on, every send is refused before any cap. */
  readonly killSwitch?: boolean;
}): EmailTenantGate {
  // Q147 (O-5): fail closed at construction; the type cannot rule out `undefined` at runtime.
  if (
    (deps.recipientKeySecret as string | undefined) === undefined ||
    deps.recipientKeySecret === ''
  ) {
    throw new Error('The email tenant gate requires a recipient key secret.');
  }
  const recipientKeySecret = deps.recipientKeySecret;
  const disabled = new Set(deps.disabledTenantIds);
  function emitLimited(scope: 'tenant' | 'recipient' | 'global', tenantId: string) {
    emitIdentityEvent({
      name: 'catalog.security.invitation_rate_limited',
      severity: 'WARN',
      attributes: {
        'tayzu.tenant.id': tenantId,
        'tayzu.identity.invitation.limit_scope': scope,
      },
    });
    recordIdentityMetric('tayzu.identity.invitations', 1, {
      'tayzu.tenant.id': tenantId,
      'tayzu.identity.invitation.mutation': 'rate_limited',
    });
  }
  async function consumeCap(scope: 'tenant' | 'recipient', key: string, tenantId: string) {
    try {
      await deps.capStore.consume(scope, key);
    } catch (error) {
      if (error instanceof AuthRateLimitedError) {
        emitLimited(scope, tenantId);
        // Every bucket answers with the same window, so the header does not reveal which tripped.
        throw new AuthRateLimitedError(INVITATION_RETRY_AFTER_SECONDS);
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
      if (deps.killSwitch === true) {
        emitLimited('global', tenantId);
        throw new AuthRateLimitedError(INVITATION_RETRY_AFTER_SECONDS);
      }
      await consumeCap('tenant', tenantId, tenantId);
      await consumeCap('recipient', recipientKey(to, recipientKeySecret), tenantId);
      await deps.sender.send(to, template);
    },
  };
}
