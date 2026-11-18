/**
 * The fixed org-deletion notice (`045` design D5, Resolved decision Q27). Only the purge
 * date is interpolated: no link, no address, no organization, actor or tenant free text.
 */
import { escapeHtml } from './invitation-email-template.js';
import type { RenderedEmail } from './invitation-email-template.js';
import type { EmailTemplate } from './sender.js';

type OrgDeletionTemplate = Extract<EmailTemplate, { kind: 'OrgDeletionNotice' }>;

/** Fixed, and never carries the purge date. */
const SUBJECT = 'Your Tayzu organization is scheduled for deletion';

const OPENING = 'An administrator requested the deletion of your Tayzu organization.';
const ACCESS = 'Access to the organization has been revoked.';
const CLOSING =
  'If you did not expect this, contact the other administrators of your organization or the platform operator before that date.';

/** Renders the notice; reads only `purgeDate` from the template. */
export function renderOrgDeletionNotice(template: OrgDeletionTemplate): RenderedEmail {
  const purgeDate = template.purgeDate;
  const purgeLine = (date: string): string => `Its data will be permanently deleted on ${date}.`;

  const html =
    '<!doctype html><html><body>' +
    `<p>${OPENING}</p>` +
    `<p>${ACCESS}</p>` +
    `<p>${purgeLine(escapeHtml(purgeDate))}</p>` +
    `<p>${CLOSING}</p>` +
    '</body></html>';

  const text = [OPENING, ACCESS, purgeLine(purgeDate), CLOSING, ''].join('\n');

  return { subject: SUBJECT, html, text };
}
