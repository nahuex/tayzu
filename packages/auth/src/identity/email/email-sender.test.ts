import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { registration, type TelemetryTestHarness } from '../../__fixtures__/registered-harness.js';
import { EmailProviderError } from './azure-communication-email.js';
import { createNonSendingEmailSender } from './non-sending-sender.js';
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

/**
 * `044` task 3.1 (design D5, telemetry table): the five recovery kinds join the closed
 * `EmailTemplate` union and both `TEMPLATE_NAMES` tables.
 *
 * ## Production symbols expected
 *
 * `packages/auth/src/identity/email/sender.ts`: `EmailTemplate` gains
 * `{ kind: 'PasswordResetEmail'; link: string; expiryText: string }` and the four
 * link-less `{ kind: 'PasswordChangedNotice' | 'MfaChangedNotice' | 'MfaResetNotice' |
 * 'AccountCreatedNotice' }`.
 * `email-allowlist.ts` (and the tenant gate's table in `apps/api`) name them
 * `password_reset`, `password_changed`, `mfa_changed`, `mfa_reset`, `account_created`.
 */
const RESET_LINK = 'https://app.example.test/reset-password#reset=abc&token=def';
const FIVE: readonly (readonly [EmailTemplate, string])[] = [
  [{ kind: 'PasswordResetEmail', link: RESET_LINK, expiryText: '30 minutes' }, 'password_reset'],
  [{ kind: 'PasswordChangedNotice' }, 'password_changed'],
  [{ kind: 'MfaChangedNotice' }, 'mfa_changed'],
  [{ kind: 'MfaResetNotice' }, 'mfa_reset'],
  [{ kind: 'AccountCreatedNotice' }, 'account_created'],
];

describe('044 recovery email kinds', () => {
  let harness: TelemetryTestHarness;
  let allowlist: typeof import('./email-allowlist.js');

  beforeAll(async () => {
    if ('error' in registration) {
      throw new Error(`createTelemetryTestHarness() failed: ${String(registration.error)}`, {
        cause: registration.error,
      });
    }
    harness = registration.harness;
    allowlist = await import('./email-allowlist.js');
  });

  beforeEach(async () => {
    await harness.reset();
  });

  it("the recording sender, the non-sending sender and the allowlist wrapper accept each of the five kinds, and the allowlist wrapper's refusal log names each by its `tayzu.identity.email.template` value", async () => {
    const templates = FIVE.map(([template]) => template);

    const recording = createRecordingEmailSender();
    for (const template of templates) {
      await recording.send('person@allowed.example', template);
    }
    expect(recording.sent.map((message) => message.template)).toEqual(templates);

    const nonSending = createNonSendingEmailSender();
    for (const template of templates) {
      await expect(nonSending.send('person@allowed.example', template)).resolves.toBeUndefined();
    }

    const inner = createRecordingEmailSender();
    const permissive = allowlist.createAllowlistEmailSender(inner, ['allowed.example']);
    for (const template of templates) {
      await permissive.send('person@allowed.example', template);
    }
    expect(inner.sent.map((message) => message.template)).toEqual(templates);

    const refusing = allowlist.createAllowlistEmailSender(createRecordingEmailSender(), [
      'allowed.example',
    ]);
    for (const template of templates) {
      await expect(refusing.send('someone@blocked.example', template)).rejects.toBeInstanceOf(
        EmailProviderError,
      );
    }
    await harness.forceFlush();
    const records = harness.logExporter
      .getFinishedLogRecords()
      .filter((record) => record.eventName === 'catalog.security.email_recipient_blocked');
    expect(records.map((record) => record.attributes['tayzu.identity.email.template'])).toEqual(
      FIVE.map(([, name]) => name),
    );
  });
});
