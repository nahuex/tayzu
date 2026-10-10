/**
 * The fixed admin-accepted notice (`043` design D5, Resolved decision Q39). It takes no
 * value: no link, no organization, actor or invitee free text.
 */
import type { RenderedEmail } from './invitation-email-template.js';
import type { EmailTemplate } from './sender.js';

type AdminAcceptedNoticeTemplate = Extract<EmailTemplate, { kind: 'AdminAcceptedNotice' }>;

const SUBJECT = 'A new administrator joined your Tayzu organization';
const LINES = [
  'A new administrator accepted an invitation to your Tayzu organization.',
  'If you were not expecting this, review the administrators of your organization in Tayzu.',
] as const;

const HTML =
  '<!doctype html><html><body>' + LINES.map((line) => `<p>${line}</p>`).join('') + '</body></html>';
const TEXT = [...LINES, ''].join('\n');

/** Renders the notice. The template carries no data, so the output is a constant. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the template is deliberately never read
export function renderAdminAcceptedNotice(_template: AdminAcceptedNoticeTemplate): RenderedEmail {
  return { subject: SUBJECT, html: HTML, text: TEXT };
}
