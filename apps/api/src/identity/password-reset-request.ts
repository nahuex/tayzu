/**
 * The request half of the password reset (`044` design D2 "Order of work, request route"):
 * strict parse, canonical address, eligibility, the mailer's admission, token issue for an
 * admitted request and the detached send. The caller answers the uniform `200` whatever
 * happened here; the outcome never reaches it.
 */
import { emitIdentityEvent, recordIdentityMetric } from '@tayzu/auth';

import { clientIpKey } from './client-ip-key.js';
import { canonicalEmail, isValidIdentityEmail } from './email-canonical.js';
import { IdentityInputError, parseIdentityInput, type InputSchema } from './parse-input.js';
import { buildPasswordResetLink } from './password-reset-link.js';
import type { RecoveryEligibility, RecoveryEligibilityChecker } from './recovery-eligibility.js';
import type { RecoveryMailer, ResetEmailAdmission } from './recovery-mailer.js';
import type { ResetTokenStore } from './reset-token-store.js';

/** The longest address of RFC 5321. */
const MAX_EMAIL_LENGTH = 254;

const REQUEST_BODY_SCHEMA: InputSchema = {
  body: { email: { kind: 'string', maxLength: MAX_EMAIL_LENGTH } },
};

type RequestOutcome = 'issued' | 'ineligible' | 'suppressed';

function recordOutcome(outcome: RequestOutcome): void {
  recordIdentityMetric('tayzu.identity.password_reset_requests', 1, {
    'tayzu.identity.reset.request_outcome': outcome,
  });
}

/**
 * A dependency of the request failed before any token was issued (design D4 "Dependency
 * failures", Q35): the request counts as `suppressed` and the caller still gets the uniform
 * answer. The caught error is dropped on purpose; only the closed reason leaves the flow.
 * Pass the user id only when the account is known and eligible (the admission failed).
 */
function suppressForDependencyFailure(userId?: string): void {
  emitIdentityEvent({
    name: 'catalog.security.recovery_email_suppressed',
    severity: 'WARN',
    attributes: {
      'tayzu.identity.email.template': 'password_reset',
      'tayzu.identity.recovery.suppression': 'dependency_failure',
      ...(userId === undefined ? {} : { 'tayzu.identity.user.id': userId }),
    },
  });
  recordOutcome('suppressed');
}

export interface PasswordResetRequestFlow {
  /** Throws `CATALOG_VALIDATION_FAILED` for a malformed body, before any lookup. */
  handle(input: { readonly body: unknown; readonly clientIp: string }): Promise<void>;
}

export function createPasswordResetRequestFlow(options: {
  readonly eligibility: RecoveryEligibilityChecker;
  readonly mailer: RecoveryMailer;
  readonly tokens: ResetTokenStore;
  readonly linkBaseUrl: string;
}): PasswordResetRequestFlow {
  return {
    async handle({ body, clientIp }) {
      const { email: raw } = parseIdentityInput(REQUEST_BODY_SCHEMA, { body }).body as {
        email: string;
      };
      const canonical = canonicalEmail(raw);
      if (!isValidIdentityEmail(canonical)) throw new IdentityInputError();
      let result: RecoveryEligibility;
      try {
        result = await options.eligibility.check(canonical);
      } catch {
        // No user id: the failed read may be one that runs for an unknown address too.
        suppressForDependencyFailure();
        return;
      }
      if (result.status !== 'eligible' || result.userId === undefined) {
        // No user id: the signal must not tell a known address from an unknown one.
        emitIdentityEvent({
          name: 'catalog.security.recovery_email_suppressed',
          severity: 'WARN',
          attributes: {
            'tayzu.identity.email.template': 'password_reset',
            'tayzu.identity.recovery.suppression': result.status,
          },
        });
        recordOutcome('ineligible');
        return;
      }
      const ipKey = clientIpKey(clientIp);
      let admission: ResetEmailAdmission;
      try {
        admission = await options.mailer.admitResetEmail({
          address: result.email,
          userId: result.userId,
          tenantIds: result.tenantIds ?? [],
          ipKey,
        });
      } catch {
        // A cap refusal returns normally, so whatever throws here is the cap store failing.
        suppressForDependencyFailure(result.userId);
        return;
      }
      if (!admission.admitted) {
        recordOutcome('suppressed');
        return;
      }
      let issued: { id: string; token: string };
      try {
        issued = await options.tokens.issue(result.userId);
      } catch {
        admission.tokenIssueFailed();
        recordOutcome('suppressed');
        return;
      }
      emitIdentityEvent({
        name: 'catalog.audit.password_reset_requested',
        severity: 'INFO',
        attributes: { 'tayzu.identity.user.id': result.userId },
      });
      recordOutcome('issued');
      admission.send(
        buildPasswordResetLink({
          baseUrl: options.linkBaseUrl,
          resetId: issued.id,
          token: issued.token,
        }),
      );
    },
  };
}
