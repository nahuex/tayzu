import { afterEach, describe, expect, it, vi } from 'vitest';

// The module under test. Does not exist yet.
import { createNonSendingEmailSender } from './non-sending-sender.js';
import type { EmailTemplate } from './sender.js';

/**
 * `043` task 6.5 (design D5, SEC11): the non-sending `EmailSender` used by CI,
 * DAST and demo tenants discards the message and records nothing about it: it
 * neither retains nor logs the message, the link or the token.
 *
 * Production symbol expected: `createNonSendingEmailSender(): EmailSender` in
 * `packages/auth/src/identity/email/non-sending-sender.ts`.
 */

const RECIPIENT = 'marker-recipient@example.com';
const TOKEN = 'marker-token-7f3a9c';
const LINK = `https://app.example.test/accept-invitation#invitation=marker-id-1&token=${TOKEN}`;
const TEMPLATE: EmailTemplate = { kind: 'InvitationEmail', link: LINK, expiryText: '48 hours' };

describe('the non-sending sender (043 task 6.5)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts a message and resolves without a value', async () => {
    await expect(createNonSendingEmailSender().send(RECIPIENT, TEMPLATE)).resolves.toBeUndefined();
  });

  it('retains nothing: no state of the sender contains the address, the link or the token', async () => {
    const sender = createNonSendingEmailSender();

    await sender.send(RECIPIENT, TEMPLATE);
    await sender.send(RECIPIENT, { kind: 'AdminAcceptedNotice' });

    expect(Object.keys(sender)).toEqual(['send']);
    const everything = JSON.stringify(Object.getOwnPropertyNames(sender)) + JSON.stringify(sender);
    for (const secret of [RECIPIENT, LINK, TOKEN, 'marker-id-1']) {
      expect(everything).not.toContain(secret);
    }
    expect('sent' in sender).toBe(false);
  });

  it('logs nothing: no console method and no stream receives the message, the link or the token', async () => {
    const calls: unknown[][] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        calls.push(args);
      });
    }
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      calls.push([chunk]);
      return true;
    });
    const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      calls.push([chunk]);
      return true;
    });

    await createNonSendingEmailSender().send(RECIPIENT, TEMPLATE);

    expect(out).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});
