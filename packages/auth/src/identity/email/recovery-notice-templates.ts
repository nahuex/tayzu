/**
 * The fixed recovery notices (`044` design D8, Resolved decisions Q16, Q21, Q30). Each takes no
 * value: no link, no address, no organization, actor or tenant free text.
 */
import type { RenderedEmail } from './invitation-email-template.js';
import type { EmailTemplate } from './sender.js';

/** Shared by the password-changed and MFA-reset notices (Q21, Q30). */
const REVIEW_LINE =
  'Review your service accounts, credentials and linked sign-ins, and revoke any you do not recognize.';

function constant(subject: string, lines: readonly string[]): RenderedEmail {
  return {
    subject,
    html:
      '<!doctype html><html><body>' +
      lines.map((line) => `<p>${line}</p>`).join('') +
      '</body></html>',
    text: [...lines, ''].join('\n'),
  };
}

const PASSWORD_CHANGED = constant('Your Tayzu password was changed', [
  'The password of your Tayzu account was changed.',
  REVIEW_LINE,
  'If you did not make this change, use the forgot-password page to set a new password.',
]);

const MFA_CHANGED = constant('Your Tayzu two-step verification was changed', [
  'The two-step verification of your Tayzu account was changed.',
  'If you did not make this change, use the forgot-password page to set a new password.',
]);

const MFA_RESET = constant('Your Tayzu two-step verification was reset', [
  'The two-step verification of your Tayzu account was reset.',
  REVIEW_LINE,
  'Set up two-step verification again the next time you sign in.',
]);

const ACCOUNT_CREATED = constant('A Tayzu account was created for this address', [
  'A Tayzu account was created for this address.',
  'If you did not expect this account, use the forgot-password page to set your own password.',
  'If a reset asks for a code you never set up, contact the platform operator.',
]);

type Renderer<K extends EmailTemplate['kind']> = (
  template: Extract<EmailTemplate, { kind: K }>,
) => RenderedEmail;

/** The renderers. A template carries no data, so each output is a constant. */
export const renderPasswordChangedNotice: Renderer<'PasswordChangedNotice'> = () =>
  PASSWORD_CHANGED;
export const renderMfaChangedNotice: Renderer<'MfaChangedNotice'> = () => MFA_CHANGED;
export const renderMfaResetNotice: Renderer<'MfaResetNotice'> = () => MFA_RESET;
export const renderAccountCreatedNotice: Renderer<'AccountCreatedNotice'> = () => ACCOUNT_CREATED;
