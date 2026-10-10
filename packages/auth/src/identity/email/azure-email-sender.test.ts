import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createAzureCommunicationEmailSender,
  EmailProviderError,
  parseAzureEmailConfig,
} from './azure-communication-email.js';
import type { AcsEmailClient, AcsEmailMessage } from './azure-communication-email.js';
import { InvalidRecipientError } from './sender.js';

/**
 * `043` task 6.4 (design D5, Q28): the Azure Communication Services adapter.
 * No test here touches the network: the ACS client is always a stub.
 * Scenario: "The email provider's failure never leaks".
 */

const CONNECTION_STRING =
  'endpoint=https://acs-test.communication.azure.com/;accesskey=c2VjcmV0LWtleQ==';
const SENDER = 'DoNotReply@mail.tayzu.example';
const RECIPIENT = 'marker-recipient@example.com';
const LINK = 'https://app.example.test/accept-invitation#invitation=abc&token=def';

interface StubClient extends AcsEmailClient {
  readonly messages: AcsEmailMessage[];
}

/** A stub whose poller completes with a Succeeded result. */
function succeedingClient(): StubClient {
  const messages: AcsEmailMessage[] = [];
  return {
    messages,
    beginSend(message) {
      messages.push(message);
      return Promise.resolve({
        pollUntilDone: () => Promise.resolve({ id: 'op-1', status: 'Succeeded' }),
      });
    },
  };
}

function failingClient(error: unknown): AcsEmailClient {
  return {
    beginSend: () => Promise.reject(error instanceof Error ? error : new Error('unreachable')),
  };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

function everythingAbout(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    parts.push(current.name, current.message, current.stack ?? '');
    current = current.cause;
  }
  parts.push(JSON.stringify(error, Object.getOwnPropertyNames(error)));
  return parts.join('\n');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseAzureEmailConfig: construction and config parsing', () => {
  it('reads the connection string and sender address from the environment', () => {
    const config = parseAzureEmailConfig({
      ACS_CONNECTION_STRING: CONNECTION_STRING,
      EMAIL_SENDER_ADDRESS: SENDER,
    });
    expect(config.connectionString).toBe(CONNECTION_STRING);
    expect(config.senderAddress).toBe(SENDER);
  });

  it('fails closed when the connection string is missing or blank, without echoing anything', () => {
    for (const value of [undefined, '', '   ']) {
      const env = { ACS_CONNECTION_STRING: value, EMAIL_SENDER_ADDRESS: SENDER };
      expect(() => parseAzureEmailConfig(env)).toThrow();
    }
  });

  it('fails closed when the sender address is missing or blank', () => {
    for (const value of [undefined, '', '   ']) {
      const env = { ACS_CONNECTION_STRING: CONNECTION_STRING, EMAIL_SENDER_ADDRESS: value };
      expect(() => parseAzureEmailConfig(env)).toThrow();
    }
  });

  it('never puts the connection string in a configuration error', () => {
    const secret = 'accesskey=super-secret-value';
    let message = '';
    try {
      parseAzureEmailConfig({ ACS_CONNECTION_STRING: secret, EMAIL_SENDER_ADDRESS: '' });
    } catch (error) {
      message = everythingAbout(error);
    }
    expect(message).not.toContain('super-secret-value');
  });
});

describe('createAzureCommunicationEmailSender', () => {
  it('constructs without any network call and without sending anything', () => {
    const client = succeedingClient();
    const beginSend = vi.spyOn(client, 'beginSend');
    const sender = createAzureCommunicationEmailSender({ senderAddress: SENDER, client });
    expect(typeof sender.send).toBe('function');
    expect(beginSend).not.toHaveBeenCalled();
  });

  it('constructs from a connection string alone, with no network call', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const sender = createAzureCommunicationEmailSender({
      senderAddress: SENDER,
      connectionString: CONNECTION_STRING,
    });
    expect(typeof sender.send).toBe('function');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends the invitation with user-engagement tracking disabled', async () => {
    const client = succeedingClient();
    const sender = createAzureCommunicationEmailSender({ senderAddress: SENDER, client });
    await sender.send(RECIPIENT, { kind: 'InvitationEmail', link: LINK, expiryText: '48 hours' });

    expect(client.messages).toHaveLength(1);
    const message = client.messages[0];
    expect(message?.disableUserEngagementTracking).toBe(true);
  });

  it('sends with no Reply-To, in any form', async () => {
    const client = succeedingClient();
    const sender = createAzureCommunicationEmailSender({ senderAddress: SENDER, client });
    await sender.send(RECIPIENT, { kind: 'InvitationEmail', link: LINK, expiryText: '48 hours' });
    await sender.send(RECIPIENT, { kind: 'AdminAcceptedNotice' });

    expect(client.messages).toHaveLength(2);
    for (const message of client.messages) {
      expect(message.replyTo === undefined || message.replyTo.length === 0).toBe(true);
      const headerNames = Object.keys(message.headers ?? {}).map((name) => name.toLowerCase());
      expect(headerNames).not.toContain('reply-to');
    }
  });

  it('sends to exactly one recipient, with no CC, BCC or attachment', async () => {
    const client = succeedingClient();
    const sender = createAzureCommunicationEmailSender({ senderAddress: SENDER, client });
    await sender.send(RECIPIENT, { kind: 'InvitationEmail', link: LINK, expiryText: '48 hours' });

    const message = client.messages[0];
    expect(message?.senderAddress).toBe(SENDER);
    expect(message?.recipients.to).toEqual([{ address: RECIPIENT }]);
    expect(message?.recipients.cc ?? []).toHaveLength(0);
    expect(message?.recipients.bCC ?? []).toHaveLength(0);
    expect(message?.attachments ?? []).toHaveLength(0);
  });

  it('renders the fixed invitation template, with the link in both bodies and no tracking wrapper', async () => {
    const client = succeedingClient();
    const sender = createAzureCommunicationEmailSender({ senderAddress: SENDER, client });
    await sender.send(RECIPIENT, { kind: 'InvitationEmail', link: LINK, expiryText: '48 hours' });

    const content = client.messages[0]?.content;
    expect(content?.subject).toBe('You have been invited to join Tayzu');
    expect(content?.plainText).toContain(LINK);
    expect(content?.html).toContain('#invitation=abc&amp;token=def');
  });

  it('sends the admin-accepted notice with no link', async () => {
    const client = succeedingClient();
    const sender = createAzureCommunicationEmailSender({ senderAddress: SENDER, client });
    await sender.send(RECIPIENT, { kind: 'AdminAcceptedNotice' });

    const content = client.messages[0]?.content;
    expect(content?.subject.length).toBeGreaterThan(0);
    expect(`${content?.plainText ?? ''}${content?.html ?? ''}`).not.toMatch(/https?:\/\//);
  });

  it('refuses an injected recipient before calling the client', async () => {
    const client = succeedingClient();
    const sender = createAzureCommunicationEmailSender({ senderAddress: SENDER, client });
    const error = await rejectionOf(
      sender.send(`${RECIPIENT}\nBcc: attacker@example.com`, { kind: 'AdminAcceptedNotice' }),
    );
    expect(error).toBeInstanceOf(InvalidRecipientError);
    expect(client.messages).toHaveLength(0);
  });
});

describe("The email provider's failure never leaks", () => {
  it('sanitizes a send failure whose error contains the recipient address', async () => {
    const leaky = new Error(`Invalid recipient ${RECIPIENT}: mailbox unavailable`);
    const sender = createAzureCommunicationEmailSender({
      senderAddress: SENDER,
      client: failingClient(leaky),
    });

    const error = await rejectionOf(
      sender.send(RECIPIENT, { kind: 'InvitationEmail', link: LINK, expiryText: '48 hours' }),
    );

    expect(error).toBeInstanceOf(EmailProviderError);
    const text = everythingAbout(error);
    expect(text).not.toContain(RECIPIENT);
    expect(text).not.toContain('marker-recipient');
    expect(text).not.toContain('token=def');
    expect((error as Error).cause).toBeUndefined();
  });

  it('sanitizes a failure raised while polling for the result', async () => {
    const client: AcsEmailClient = {
      beginSend: () =>
        Promise.resolve({
          pollUntilDone: () => Promise.reject(new Error(`Delivery to ${RECIPIENT} failed`)),
        }),
    };
    const sender = createAzureCommunicationEmailSender({ senderAddress: SENDER, client });

    const error = await rejectionOf(sender.send(RECIPIENT, { kind: 'AdminAcceptedNotice' }));

    expect(error).toBeInstanceOf(EmailProviderError);
    expect(everythingAbout(error)).not.toContain('marker-recipient');
  });

  it('sanitizes a Failed result whose error details contain the recipient address', async () => {
    const client: AcsEmailClient = {
      beginSend: () =>
        Promise.resolve({
          pollUntilDone: () =>
            Promise.resolve({
              id: 'op-2',
              status: 'Failed',
              error: { code: 'BadRecipient', message: `Cannot deliver to ${RECIPIENT}` },
            }),
        }),
    };
    const sender = createAzureCommunicationEmailSender({ senderAddress: SENDER, client });

    const error = await rejectionOf(sender.send(RECIPIENT, { kind: 'AdminAcceptedNotice' }));

    expect(error).toBeInstanceOf(EmailProviderError);
    expect(everythingAbout(error)).not.toContain('marker-recipient');
  });

  it('writes the address nowhere on the console while failing', async () => {
    const spies = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'debug'),
    ];
    const sender = createAzureCommunicationEmailSender({
      senderAddress: SENDER,
      client: failingClient(new Error(`bounce for ${RECIPIENT}`)),
    });

    await rejectionOf(sender.send(RECIPIENT, { kind: 'AdminAcceptedNotice' }));

    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain('marker-recipient');
    }
  });
});
