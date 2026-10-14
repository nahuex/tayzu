/**
 * The non-sending `EmailSender` (`043` design D5): CI, DAST and demo tenants wire it.
 * It discards the message and keeps or logs nothing about it.
 */
import type { EmailSender } from './sender.js';

export function createNonSendingEmailSender(): EmailSender {
  return {
    async send() {
      // Intentionally empty: the message, the link and the token are dropped.
    },
  };
}
