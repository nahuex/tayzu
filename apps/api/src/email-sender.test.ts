import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Load-bearing import order: the telemetry harness registers before `@tayzu/auth` loads.
import { registration, type TelemetryTestHarness } from './__fixtures__/link-telemetry.js';
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

const acsCalls = vi.hoisted(() => [] as { recipients: { to: { address: string }[] } }[]);

// Only the provider's sender is replaced by a recording stub, so nothing leaves the process;
// the allowlist wrapper and everything else stay the real `@tayzu/auth` exports.
vi.mock('@tayzu/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tayzu/auth')>()),
  createAzureCommunicationEmailSender: () => ({
    send: (to: string) => {
      acsCalls.push({ recipients: { to: [{ address: to }] } });
      return Promise.resolve();
    },
  }),
}));

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
    IDENTITY_TOKEN_HMAC_SECRET: 'sender-hmac-test-only-secret-0123456789-abcdef',
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

describe('the recipient-domain allowlist wraps the real sender (043 task 14.14)', () => {
  const BLOCKED_EVENT = 'catalog.security.email_recipient_blocked';
  const ALLOWED_RECIPIENT = 'person@allowed.example';
  const BLOCKED_LOCAL = 'marker-recipient-14-14';
  const BLOCKED_DOMAIN = 'blocked-marker.example';
  let harness: TelemetryTestHarness;

  function acsConfig() {
    return loadConfig(
      env({
        NODE_ENV: 'production',
        EMAIL_PROVIDER: 'acs',
        ACS_CONNECTION_STRING: 'endpoint=https://acs.invalid/;accesskey=dGVzdA==',
        EMAIL_SENDER_ADDRESS: 'donotreply@allowed.example',
        EMAIL_RECIPIENT_DOMAIN_ALLOWLIST: 'allowed.example',
      }),
    );
  }

  beforeAll(() => {
    if ('error' in registration) {
      throw new Error(`createTelemetryTestHarness() failed: ${String(registration.error)}`, {
        cause: registration.error,
      });
    }
    harness = registration.harness;
  });

  beforeEach(async () => {
    acsCalls.length = 0;
    await harness.reset();
  });

  it('EMAIL_PROVIDER=acs with the allowlist refuses a recipient of another domain without reaching the provider, and logs the block with no address', async () => {
    const sender = createEmailSender(acsConfig());

    await expect(
      sender.send(`${BLOCKED_LOCAL}@${BLOCKED_DOMAIN}`, TEMPLATE),
    ).rejects.toBeInstanceOf(Error);

    expect(acsCalls, 'the provider is never reached').toHaveLength(0);
    await harness.forceFlush();
    const records = [...harness.logExporter.getFinishedLogRecords()].filter(
      (record) => record.eventName === BLOCKED_EVENT,
    );
    expect(records).toHaveLength(1);
    const logged = JSON.stringify({
      body: records[0]?.body,
      attributes: records[0]?.attributes,
    });
    expect(logged).not.toContain(BLOCKED_LOCAL);
    expect(logged).not.toContain(BLOCKED_DOMAIN);
  });

  it('EMAIL_PROVIDER=acs with the allowlist lets a recipient of an allowed domain reach the provider', async () => {
    const sender = createEmailSender(acsConfig());

    await sender.send(ALLOWED_RECIPIENT, TEMPLATE);

    expect(acsCalls.map((message) => message.recipients.to.map((to) => to.address))).toEqual([
      [ALLOWED_RECIPIENT],
    ]);
    await harness.forceFlush();
    const blocked = [...harness.logExporter.getFinishedLogRecords()].filter(
      (record) => record.eventName === BLOCKED_EVENT,
    );
    expect(blocked).toHaveLength(0);
  });
});
