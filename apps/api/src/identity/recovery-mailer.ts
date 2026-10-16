/**
 * The mailer of the anonymous reset email (`044` design D5, "The email path of an anonymous
 * reset"), first half: the controls that need no counter, in order (kill switch, recipient
 * domain allowlist, every tenant of the user on the disabled list). A refusal returns normally,
 * is logged once as `catalog.security.recovery_email_suppressed` and returns no send handle.
 * An admission returns a detached `send(link)`; the mailer tracks in-flight sends for `drain()`.
 * No signal carries an address or a link.
 */
import {
  AuthRateLimitedError,
  emitIdentityEvent,
  isRecipientDomainAllowed,
  recordIdentityMetric,
  type EmailSender,
} from '@tayzu/auth';

import type { EmailCapStore } from './email-tenant-gate.js';
import { recipientKey } from './recipient-key.js';

export type ResetEmailAdmission =
  | { readonly admitted: false }
  | {
      readonly admitted: true;
      /** Starts the detached send and returns at once; a failure is swallowed and counted. */
      send(link: string): void;
    };

export interface RecoveryMailer {
  admitResetEmail(input: {
    /** Canonical. */
    readonly address: string;
    readonly userId: string;
    /** Every membership tenant of the user. */
    readonly tenantIds: readonly string[];
    /** The normalized key of `client-ip-key.ts`. */
    readonly ipKey: string;
  }): Promise<ResetEmailAdmission>;
  /** Resolves when every started send has settled. */
  drain(): Promise<void>;
}

const TEMPLATE_NAME = 'password_reset';
const EXPIRY_TEXT = '30 minutes';

type Suppression =
  | 'kill_switch'
  | 'recipient_domain_blocked'
  | 'tenants_email_disabled'
  | 'recipient_cap'
  | 'ip_cap'
  | 'global_cap'
  | 'provider_failure';

/** The one constant key of the global bucket. */
const GLOBAL_KEY = 'global';

export function createRecoveryMailer(deps: {
  readonly disabledTenantIds: readonly string[];
  readonly capStore: EmailCapStore;
  readonly sender: EmailSender;
  readonly recipientKeySecret: string;
  readonly killSwitch?: boolean;
  /** Undefined: no allowlist is applied. Defined, even empty: it decides. */
  readonly recipientDomainAllowlist?: readonly string[];
}): RecoveryMailer {
  const disabled = new Set(deps.disabledTenantIds);
  const inFlight = new Set<Promise<void>>();

  function suppressed(suppression: Suppression, userId: string): void {
    emitIdentityEvent({
      name: 'catalog.security.recovery_email_suppressed',
      severity: 'WARN',
      attributes: {
        'tayzu.identity.email.template': TEMPLATE_NAME,
        'tayzu.identity.recovery.suppression': suppression,
        'tayzu.identity.user.id': userId,
      },
    });
  }

  function refuse(suppression: Suppression, userId: string): ResetEmailAdmission {
    suppressed(suppression, userId);
    return { admitted: false };
  }

  return {
    admitResetEmail(input) {
      if (deps.killSwitch === true) {
        return Promise.resolve(refuse('kill_switch', input.userId));
      }
      if (
        deps.recipientDomainAllowlist !== undefined &&
        !isRecipientDomainAllowed(input.address, deps.recipientDomainAllowlist)
      ) {
        emitIdentityEvent({
          name: 'catalog.security.email_recipient_blocked',
          severity: 'WARN',
          attributes: { 'tayzu.identity.email.template': TEMPLATE_NAME },
        });
        return Promise.resolve(refuse('recipient_domain_blocked', input.userId));
      }
      if (input.tenantIds.every((tenantId) => disabled.has(tenantId))) {
        return Promise.resolve(refuse('tenants_email_disabled', input.userId));
      }
      return admitThroughCaps(input);
    },
    async drain() {
      await Promise.all([...inFlight]);
    },
  };

  /** Recipient, then IP, then global: a narrower refusal consumes no wider bucket. */
  async function admitThroughCaps(input: {
    readonly address: string;
    readonly userId: string;
    readonly ipKey: string;
  }): Promise<ResetEmailAdmission> {
    const caps: readonly (readonly [string, string, Suppression])[] = [
      ['reset_recipient', recipientKey(input.address, deps.recipientKeySecret), 'recipient_cap'],
      ['reset_ip', input.ipKey, 'ip_cap'],
      ['reset_global', GLOBAL_KEY, 'global_cap'],
    ];
    for (const [scope, key, suppression] of caps) {
      try {
        await deps.capStore.consume(scope, key);
      } catch (error) {
        if (error instanceof AuthRateLimitedError) return refuse(suppression, input.userId);
        throw error;
      }
    }
    return {
      admitted: true,
      send(link: string): void {
        const delivery = deps.sender
          .send(input.address, { kind: 'PasswordResetEmail', link, expiryText: EXPIRY_TEXT })
          .catch(() => {
            recordIdentityMetric('tayzu.identity.recovery_emails', 1, {
              'tayzu.identity.email.template': TEMPLATE_NAME,
              'tayzu.identity.email.outcome': 'failed',
            });
            suppressed('provider_failure', input.userId);
          })
          .finally(() => {
            inFlight.delete(delivery);
          });
        inFlight.add(delivery);
      },
    };
  }
}
