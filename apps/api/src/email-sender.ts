/**
 * Chooses the `EmailSender` the configuration wires (`043` design D5, Q67, Q96):
 * the recording fake under test when no provider is set, the non-sending sender
 * for `none`, and the Azure Communication Services adapter for `acs`.
 */
import {
  createAllowlistEmailSender,
  createAzureCommunicationEmailSender,
  createNonSendingEmailSender,
  createRecordingEmailSender,
  parseAzureEmailConfig,
  type EmailSender,
} from '@tayzu/auth';

import type { Config } from './config.js';

/** The four fields the sender reads, so a script needs no full `Config` (044 task 11.2). */
export type EmailSenderConfig = Pick<
  Config,
  'emailProvider' | 'acsConnectionString' | 'emailSenderAddress' | 'emailRecipientDomainAllowlist'
>;

export function createEmailSender(config: EmailSenderConfig): EmailSender {
  const sender = selectEmailSender(config);
  // The allowlist wraps the provider's sender whenever it is set, in any environment (Q99, Q138).
  return config.emailRecipientDomainAllowlist.length > 0
    ? createAllowlistEmailSender(sender, config.emailRecipientDomainAllowlist)
    : sender;
}

function selectEmailSender(config: EmailSenderConfig): EmailSender {
  switch (config.emailProvider) {
    case undefined:
      return createRecordingEmailSender();
    case 'none':
      return createNonSendingEmailSender();
    case 'acs':
      return createAzureCommunicationEmailSender(
        parseAzureEmailConfig({
          ACS_CONNECTION_STRING: config.acsConnectionString,
          EMAIL_SENDER_ADDRESS: config.emailSenderAddress,
        }),
      );
  }
}
