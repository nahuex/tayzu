import { describe, expect, it } from 'vitest';

import { renderAdminAcceptedNotice } from './admin-accepted-notice-template.js';
import { createAzureCommunicationEmailSender } from './azure-communication-email.js';
import type { AcsEmailClient, AcsEmailMessage } from './azure-communication-email.js';
import { renderInvitationEmail } from './invitation-email-template.js';
import type { EmailTemplate } from './sender.js';

/**
 * `043` task 16.12i (design D5, task 6.11, Resolved decision Q149): the Azure sender
 * renders each template through the shared render function, so each body has one
 * definition. The ACS client is always a stub.
 */

const SENDER = 'DoNotReply@mail.tayzu.example';
const RECIPIENT = 'marker-recipient@example.com';

async function sentContent(template: EmailTemplate): Promise<AcsEmailMessage['content']> {
  const messages: AcsEmailMessage[] = [];
  const client: AcsEmailClient = {
    beginSend(message) {
      messages.push(message);
      return Promise.resolve({
        pollUntilDone: () => Promise.resolve({ id: 'op-1', status: 'Succeeded' }),
      });
    },
  };
  await createAzureCommunicationEmailSender({ client, senderAddress: SENDER }).send(
    RECIPIENT,
    template,
  );
  const [message] = messages;
  if (message === undefined) throw new Error('nothing was sent');
  return message.content;
}

describe('The Azure sender renders through the shared render functions', () => {
  it('the sent InvitationEmail body is the output of renderInvitationEmail', async () => {
    const template = {
      kind: 'InvitationEmail',
      link: 'https://app.example.test/accept-invitation#invitation=abc&token=def',
      expiryText: '7 days',
    } as const;
    const rendered = renderInvitationEmail(template);

    const content = await sentContent(template);

    expect(content.subject).toBe(rendered.subject);
    expect(content.plainText).toBe(rendered.text);
    expect(content.html).toBe(rendered.html);
  });

  it('the sent AdminAcceptedNotice body is the output of renderAdminAcceptedNotice', async () => {
    const template = { kind: 'AdminAcceptedNotice' } as const;
    const rendered = renderAdminAcceptedNotice(template);

    const content = await sentContent(template);

    expect(content.subject).toBe(rendered.subject);
    expect(content.plainText).toBe(rendered.text);
    expect(content.html).toBe(rendered.html);
  });
});
