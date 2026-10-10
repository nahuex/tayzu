import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';
// The module under test. Does not exist yet.
import { createEmailSender } from './email-sender.js';

/**
 * `043` task 6.5 (design D5, Q67, Q96): which `EmailSender` the configuration
 * wires. The test configuration selects the recording fake; the DAST
 * configuration (`EMAIL_PROVIDER=none`, no `NODE_ENV`) selects the non-sending
 * sender, which keeps nothing.
 *
 * Production symbol expected: `createEmailSender(config: Config): EmailSender`
 * in `apps/api/src/email-sender.ts`. With `config.emailProvider` undefined (test
 * only) it returns the recording fake of `@tayzu/auth` (it exposes `sent`); with
 * `'none'` it returns the non-sending sender (it exposes no `sent`). The `acs`
 * branch is covered by 6.4 and 6.5b.
 */

const RECIPIENT = 'marker-recipient@example.com';
const TEMPLATE = {
  kind: 'InvitationEmail',
  link: 'https://app.example.test/accept-invitation#invitation=abc&token=def',
  expiryText: '48 hours',
} as const;

function env(overrides: Record<string, string | undefined>): Record<string, string | undefined> {
  return {
    DATABASE_URL: 'postgres://tayzu_app:pw@db.invalid:5432/tayzu?sslmode=verify-full',
    AUTH_DATABASE_URL: 'postgres://tayzu_auth:pw@db.invalid:5432/tayzu?sslmode=verify-full',
    BETTER_AUTH_SECRET: 'email-sender-test-only-secret-0123456789-abcdef',
    CERBOS_ADDRESS: 'localhost:3593',
    ALLOWED_ORIGINS: 'https://app.tayzu.test',
    INVITATION_LINK_BASE_URL: 'https://app.tayzu.test',
    BETTER_AUTH_URL: 'https://api.tayzu.test',
    ...overrides,
  };
}

describe('email sender selection (043 task 6.5)', () => {
  it('the test configuration selects the recording fake', async () => {
    const sender = createEmailSender(loadConfig(env({ NODE_ENV: 'test' })));

    await sender.send(RECIPIENT, TEMPLATE);

    const recorded = (sender as unknown as { sent?: readonly { to: string }[] }).sent;
    expect(recorded?.map((message) => message.to)).toEqual([RECIPIENT]);
  });

  it('the DAST configuration (EMAIL_PROVIDER=none, no NODE_ENV test) selects the non-sending sender', async () => {
    const sender = createEmailSender(
      loadConfig(env({ NODE_ENV: 'production', EMAIL_PROVIDER: 'none' })),
    );

    await expect(sender.send(RECIPIENT, TEMPLATE)).resolves.toBeUndefined();

    expect('sent' in sender, 'the non-sending sender records nothing').toBe(false);
  });

  it('EMAIL_PROVIDER=none under NODE_ENV=test also selects the non-sending sender', async () => {
    const sender = createEmailSender(loadConfig(env({ NODE_ENV: 'test', EMAIL_PROVIDER: 'none' })));

    await sender.send(RECIPIENT, TEMPLATE);

    expect('sent' in sender).toBe(false);
  });
});
