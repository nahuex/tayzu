/**
 * Chooses the `EmailSender` the configuration wires (`043` design D5, Q67, Q96):
 * the recording fake under test when no provider is set, the non-sending sender
 * for `none`, and the Azure Communication Services adapter for `acs`.
 */
import {
  createAzureCommunicationEmailSender,
  createNonSendingEmailSender,
  createRecordingEmailSender,
  parseAzureEmailConfig,
  type EmailSender,
} from '@tayzu/auth';

import type { Config } from './config.js';

export function createEmailSender(config: Config): EmailSender {
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
