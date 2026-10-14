/**
 * Manual smoke check of the ACS email adapter against a real sandbox account.
 * Never run in CI. Usage (from the repository root):
 *
 *   ACS_CONNECTION_STRING=... EMAIL_SENDER_ADDRESS=... SMOKE_RECIPIENT=you@example.com \
 *     pnpm --filter @tayzu/auth exec tsx scripts/acs-email-smoke.ts
 *
 * Sends the fixed admin-accepted notice (no link) to SMOKE_RECIPIENT and prints only
 * "ok" or "failed".
 */
import {
  createAzureCommunicationEmailSender,
  parseAzureEmailConfig,
} from '../src/identity/email/azure-communication-email.js';

const recipient = process.env['SMOKE_RECIPIENT'];
if (recipient === undefined || recipient.length === 0) {
  console.error('SMOKE_RECIPIENT is required.');
  process.exit(1);
}

try {
  const config = parseAzureEmailConfig(process.env);
  await createAzureCommunicationEmailSender(config).send(recipient, {
    kind: 'AdminAcceptedNotice',
  });
  console.log('ok');
} catch {
  console.error('failed');
  process.exit(1);
}
