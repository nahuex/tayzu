/**
 * The fixed invitation email (`043` design D5). Only the link and the expiry text
 * are interpolated: no organization name, inviter name or other tenant free text.
 */
import type { EmailTemplate } from './sender.js';

type InvitationTemplate = Extract<EmailTemplate, { kind: 'InvitationEmail' }>;

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

const SUBJECT = 'You have been invited to join Tayzu';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Renders the invitation with exactly one clickable link and no other URL. */
export function renderInvitationEmail(template: InvitationTemplate): RenderedEmail {
  const link = template.link;
  const expiry = template.expiryText;

  const html =
    '<!doctype html><html><body>' +
    '<p>You have been invited to join Tayzu.</p>' +
    `<p><a href="${escapeHtml(link)}">Accept the invitation</a></p>` +
    `<p>This invitation expires in ${escapeHtml(expiry)}.</p>` +
    '<p>If you were not expecting it, you can ignore this email.</p>' +
    '</body></html>';

  const text = [
    'You have been invited to join Tayzu.',
    '',
    'Accept the invitation:',
    link,
    '',
    `This invitation expires in ${expiry}.`,
    'If you were not expecting it, you can ignore this email.',
    '',
  ].join('\n');

  return { subject: SUBJECT, html, text };
}
