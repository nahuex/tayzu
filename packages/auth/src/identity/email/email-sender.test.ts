import { describe, expect, it } from 'vitest';

import { createRecordingEmailSender, InvalidRecipientError, validateRecipient } from './sender.js';
import type { EmailTemplate } from './sender.js';

/**
 * `043` task 6.1 (design D5): the `EmailSender` port, its recipient validator and
 * the recording fake. Scenario: "Injection through the invited address is
 * impossible".
 */

const LINK = 'https://app.example.test/accept-invitation#invitation=abc&token=def';
const EXPIRY = '48 hours';

const invitation: EmailTemplate = {
  kind: 'InvitationEmail',
  link: LINK,
  expiryText: EXPIRY,
};

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

const REJECTED: readonly (readonly [string, string])[] = [
  ['a line feed', 'victim@example.com\nBcc: attacker@example.com'],
  ['a carriage return', 'victim@example.com\rBcc: attacker@example.com'],
  ['a CRLF', 'victim@example.com\r\nSubject: pwned'],
  ['a display name', 'Victim <victim@example.com>'],
  ['a quoted display name', '"Victim" <victim@example.com>'],
  ['a comma list separator', 'a@example.com,b@example.com'],
  ['a semicolon list separator', 'a@example.com;b@example.com'],
  ['a space-separated list', 'a@example.com b@example.com'],
  ['more than 254 characters', `${'a'.repeat(250)}@example.com`],
  ['an empty string', ''],
  ['no at sign', 'not-an-address'],
];

describe('validateRecipient: Injection through the invited address is impossible', () => {
  it.each(REJECTED)('rejects an address with %s', (_label, address) => {
    expect(thrownBy(() => validateRecipient(address))).toBeInstanceOf(InvalidRecipientError);
  });

  it('accepts a single plain address and returns it unchanged', () => {
    expect(validateRecipient('person@example.com')).toBe('person@example.com');
  });

  it('accepts an address of exactly 254 characters', () => {
    const local = 'a'.repeat(64);
    const domain = `${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.com`;
    const address = `${local}@${domain}`;
    expect(address).toHaveLength(254);
    expect(validateRecipient(address)).toBe(address);
  });

  it('rejects an address of 255 characters', () => {
    const local = 'a'.repeat(64);
    const domain = `${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(58)}.com`;
    const address = `${local}@${domain}`;
    expect(address).toHaveLength(255);
    expect(thrownBy(() => validateRecipient(address))).toBeInstanceOf(InvalidRecipientError);
  });

  it('does not echo the rejected address in the error message', () => {
    const error = thrownBy(() =>
      validateRecipient('victim@example.com\nBcc: attacker@example.com'),
    );
    expect(error).toBeInstanceOf(InvalidRecipientError);
    const message = (error as Error).message;
    expect(message).not.toContain('victim');
    expect(message).not.toContain('attacker');
  });
});

describe('recording email sender', () => {
  it('records to, link and expiry text of a sent invitation', async () => {
    const sender = createRecordingEmailSender();
    await sender.send('person@example.com', invitation);

    expect(sender.sent).toHaveLength(1);
    const [message] = sender.sent;
    expect(message?.to).toBe('person@example.com');
    expect(message?.template).toEqual({
      kind: 'InvitationEmail',
      link: LINK,
      expiryText: EXPIRY,
    });
  });

  it('records a notice template without a link', async () => {
    const sender = createRecordingEmailSender();
    await sender.send('admin@example.com', { kind: 'AdminAcceptedNotice' });

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.template).toEqual({ kind: 'AdminAcceptedNotice' });
  });

  it('records messages in order, one entry per send', async () => {
    const sender = createRecordingEmailSender();
    await sender.send('a@example.com', invitation);
    await sender.send('b@example.com', invitation);

    expect(sender.sent.map((message) => message.to)).toEqual(['a@example.com', 'b@example.com']);
  });

  it('applies the recipient validator: an injected address is refused and nothing is recorded', async () => {
    const sender = createRecordingEmailSender();
    for (const [, address] of REJECTED) {
      await expect(sender.send(address, invitation)).rejects.toBeInstanceOf(InvalidRecipientError);
    }
    expect(sender.sent).toHaveLength(0);
  });

  it('exposes no CC, BCC or attachment field on a recorded message', async () => {
    const sender = createRecordingEmailSender();
    await sender.send('person@example.com', invitation);

    const keys = Object.keys(sender.sent[0] ?? {}).sort();
    expect(keys).toEqual(['template', 'to']);
  });
});
