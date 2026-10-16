/**
 * The request half of the password reset (`044` design D2 "Order of work, request route"):
 * strict parse, canonical address, eligibility, the mailer's admission, token issue for an
 * admitted request and the detached send. The caller answers the uniform `200` whatever
 * happened here; the outcome never reaches it.
 */
import { clientIpKey } from './client-ip-key.js';
import { canonicalEmail, isValidIdentityEmail } from './email-canonical.js';
import { IdentityInputError, parseIdentityInput, type InputSchema } from './parse-input.js';
import { buildPasswordResetLink } from './password-reset-link.js';
import type { RecoveryEligibilityChecker } from './recovery-eligibility.js';
import type { RecoveryMailer } from './recovery-mailer.js';
import type { ResetTokenStore } from './reset-token-store.js';

/** The longest address of RFC 5321. */
const MAX_EMAIL_LENGTH = 254;

const REQUEST_BODY_SCHEMA: InputSchema = {
  body: { email: { kind: 'string', maxLength: MAX_EMAIL_LENGTH } },
};

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
      const result = await options.eligibility.check(canonical);
      if (result.status !== 'eligible' || result.userId === undefined) return;
      const admission = await options.mailer.admitResetEmail({
        address: result.email,
        userId: result.userId,
        tenantIds: result.tenantIds ?? [],
        ipKey: clientIpKey(clientIp),
      });
      if (!admission.admitted) return;
      const { id, token } = await options.tokens.issue(result.userId);
      admission.send(buildPasswordResetLink({ baseUrl: options.linkBaseUrl, resetId: id, token }));
    },
  };
}
