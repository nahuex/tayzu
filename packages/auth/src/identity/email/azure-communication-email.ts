/**
 * The Azure Communication Services email adapter (`043` design D5, Q28).
 *
 * Tracking is disabled because a tracked link would be rewritten and would leak the
 * fragment token. No Reply-To is ever set. Every provider failure is replaced by a
 * fixed error: no address, message text or cause leaves this module.
 */
import { EmailClient } from '@azure/communication-email';

import { renderInvitationEmail } from './invitation-email-template.js';
import { validateRecipient } from './sender.js';
import type { EmailSender, EmailTemplate } from './sender.js';

/** The subset of the ACS message the adapter builds. */
export interface AcsEmailMessage {
  readonly senderAddress: string;
  readonly recipients: {
    readonly to: readonly { readonly address: string }[];
    readonly cc?: readonly { readonly address: string }[];
    readonly bCC?: readonly { readonly address: string }[];
  };
  readonly content: { readonly subject: string; readonly plainText: string; readonly html: string };
  readonly replyTo?: readonly { readonly address: string }[];
  readonly headers?: Readonly<Record<string, string>>;
  readonly attachments?: readonly unknown[];
  readonly disableUserEngagementTracking: boolean;
}

export interface AcsSendResult {
  readonly id?: string;
  readonly status?: string;
  readonly error?: unknown;
}

/** The subset of `EmailClient` the adapter uses, so tests can stub it. */
export interface AcsEmailClient {
  beginSend(message: AcsEmailMessage): Promise<{ pollUntilDone(): Promise<AcsSendResult> }>;
}

/** Raised for any provider failure. Fixed message, no cause. */
export class EmailProviderError extends Error {
  constructor() {
    super('The email provider failed to send the message.');
    this.name = 'EmailProviderError';
  }
}

export interface AzureEmailConfig {
  readonly connectionString: string;
  readonly senderAddress: string;
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required for the Azure email provider.`);
  }
  return value;
}

/** Reads the adapter configuration from the environment. Errors name only the variable. */
export function parseAzureEmailConfig(
  env: Readonly<Record<string, string | undefined>>,
): AzureEmailConfig {
  return {
    connectionString: required(env['ACS_CONNECTION_STRING'], 'ACS_CONNECTION_STRING'),
    senderAddress: required(env['EMAIL_SENDER_ADDRESS'], 'EMAIL_SENDER_ADDRESS'),
  };
}

export type AzureCommunicationEmailSenderOptions = { readonly senderAddress: string } & (
  | { readonly client: AcsEmailClient; readonly connectionString?: never }
  | { readonly connectionString: string; readonly client?: never }
);

const ADMIN_ACCEPTED_SUBJECT = 'An invitation to your Tayzu organization was accepted';
const ADMIN_ACCEPTED_TEXT = 'An invitation you sent for your Tayzu organization was accepted.\n';
const ADMIN_ACCEPTED_HTML =
  '<!doctype html><html><body><p>An invitation you sent for your Tayzu organization was accepted.</p></body></html>';

function content(template: EmailTemplate): AcsEmailMessage['content'] {
  if (template.kind === 'InvitationEmail') {
    const rendered = renderInvitationEmail(template);
    return { subject: rendered.subject, plainText: rendered.text, html: rendered.html };
  }
  return {
    subject: ADMIN_ACCEPTED_SUBJECT,
    plainText: ADMIN_ACCEPTED_TEXT,
    html: ADMIN_ACCEPTED_HTML,
  };
}

/** Wraps the real client; building it opens no connection. */
function fromEmailClient(connectionString: string): AcsEmailClient {
  const real = new EmailClient(connectionString);
  return {
    beginSend: (message) =>
      real.beginSend({
        senderAddress: message.senderAddress,
        recipients: { to: message.recipients.to.map(({ address }) => ({ address })) },
        content: message.content,
        disableUserEngagementTracking: message.disableUserEngagementTracking,
      }),
  };
}

export function createAzureCommunicationEmailSender(
  options: AzureCommunicationEmailSenderOptions,
): EmailSender {
  const client: AcsEmailClient = options.client ?? fromEmailClient(options.connectionString);
  const senderAddress = options.senderAddress;

  return {
    async send(to, template) {
      const recipient = validateRecipient(to);
      const message: AcsEmailMessage = {
        senderAddress,
        recipients: { to: [{ address: recipient }] },
        content: content(template),
        disableUserEngagementTracking: true,
      };
      try {
        const poller = await client.beginSend(message);
        const result = await poller.pollUntilDone();
        if (result.status !== 'Succeeded') {
          throw new Error('not succeeded');
        }
      } catch {
        throw new EmailProviderError();
      }
    },
  };
}
