/**
 * The fixed password reset email (`044` design D8). Only the link and the expiry text
 * are interpolated: no organization name, user name or other tenant free text.
 */
import { escapeHtml, type RenderedEmail } from './invitation-email-template.js';
import type { EmailTemplate } from './sender.js';

type PasswordResetTemplate = Extract<EmailTemplate, { kind: 'PasswordResetEmail' }>;

const SUBJECT = 'Reset your Tayzu password';

/** Renders the reset email with exactly one clickable link and no other URL. */
export function renderPasswordResetEmail(template: PasswordResetTemplate): RenderedEmail {
  const link = template.link;
  const expiry = template.expiryText;

  const html =
    '<!doctype html><html><body>' +
    '<p>A password reset was requested for your Tayzu account.</p>' +
    `<p><a href="${escapeHtml(link)}">Reset your password</a></p>` +
    `<p>This link expires in ${escapeHtml(expiry)}.</p>` +
    '<p>If you did not request it, you can ignore this email.</p>' +
    '</body></html>';

  const text = [
    'A password reset was requested for your Tayzu account.',
    '',
    'Reset your password:',
    link,
    '',
    `This link expires in ${expiry}.`,
    'If you did not request it, you can ignore this email.',
    '',
  ].join('\n');

  return { subject: SUBJECT, html, text };
}
