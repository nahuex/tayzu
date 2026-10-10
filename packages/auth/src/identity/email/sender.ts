/**
 * The outbound email sender port and its providers (`043` design D5).
 *
 * The port takes exactly one recipient and has no CC, BCC or attachment field.
 */

/** Maximum length of an email address (RFC 5321). */
const MAX_ADDRESS_LENGTH = 254;

/** One local part, one `@`, one domain: no whitespace, quotes, angle brackets or list separators. */
const PLAIN_ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;"]+$/;

/** The closed union of fixed templates; `045` adds `OrgDeletionNotice`. */
export type EmailTemplate =
  | { readonly kind: 'InvitationEmail'; readonly link: string; readonly expiryText: string }
  | { readonly kind: 'AdminAcceptedNotice' };

export interface EmailSender {
  send(to: string, template: EmailTemplate): Promise<void>;
}

/** Raised for an address that is not a single plain address. The message never echoes it. */
export class InvalidRecipientError extends Error {
  constructor() {
    super('The email recipient is not a single plain address.');
    this.name = 'InvalidRecipientError';
  }
}

/** Returns the address unchanged when it is a single plain address, else throws. */
export function validateRecipient(address: string): string {
  if (address.length === 0 || address.length > MAX_ADDRESS_LENGTH || !PLAIN_ADDRESS.test(address)) {
    throw new InvalidRecipientError();
  }
  return address;
}

export interface RecordedEmail {
  readonly to: string;
  readonly template: EmailTemplate;
}

export interface RecordingEmailSender extends EmailSender {
  readonly sent: readonly RecordedEmail[];
}

/** A fake that validates the recipient like a real sender and records each message. */
export function createRecordingEmailSender(): RecordingEmailSender {
  const sent: RecordedEmail[] = [];
  return {
    sent,
    // eslint-disable-next-line @typescript-eslint/require-await -- the port is async; the fake has nothing to await
    async send(to, template) {
      sent.push({ to: validateRecipient(to), template });
    },
  };
}
