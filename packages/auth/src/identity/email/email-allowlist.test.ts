/**
 * `043` task 6.5b (design D5, Resolved decisions Q67 and Q99): a wrapper around the
 * real sender refuses a recipient whose domain is not on the allowlist, treated
 * exactly like a provider failure (a sanitized `EmailProviderError`) and logged as
 * `catalog.security.email_recipient_blocked` with the template and no address.
 *
 * ## Production symbols expected
 *
 * `packages/auth/src/identity/email/email-allowlist.ts`:
 * - `createAllowlistEmailSender(inner: EmailSender, allowedDomains: readonly string[]):
 *   EmailSender`. A recipient whose domain (the text after the last `@`) is on the
 *   list reaches `inner.send` unchanged; any other never reaches it and the send
 *   rejects with `EmailProviderError` (from `./azure-communication-email.js`).
 *   The refusal emits `catalog.security.email_recipient_blocked` (WARN) through
 *   `emitIdentityEvent` with the attribute `tayzu.identity.email.template` =
 *   `invitation` (for `InvitationEmail`) or `admin_accepted` (for
 *   `AdminAcceptedNotice`), and no address, domain or link.
 *
 * Canonicalization of the address before comparison is task 7.10's case.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { registration, type TelemetryTestHarness } from '../../__fixtures__/registered-harness.js';
import { EmailProviderError } from './azure-communication-email.js';
import type { EmailSender, EmailTemplate } from './sender.js';

type AllowlistModule = typeof import('./email-allowlist.js');

const EVENT = 'catalog.security.email_recipient_blocked';
const ALLOWED_RECIPIENT = 'person@allowed.example';
const BLOCKED_LOCAL = 'marker-recipient';
const BLOCKED_DOMAIN = 'blocked-marker.example';
const BLOCKED_RECIPIENT = `${BLOCKED_LOCAL}@${BLOCKED_DOMAIN}`;
const TOKEN = 'marker-token-7f3a9c';
const LINK = `https://app.example.test/accept-invitation#invitation=marker-id-1&token=${TOKEN}`;
const INVITATION: EmailTemplate = { kind: 'InvitationEmail', link: LINK, expiryText: '48 hours' };
const NOTICE: EmailTemplate = { kind: 'AdminAcceptedNotice' };

let harness: TelemetryTestHarness;
let allowlist: AllowlistModule;

interface StubProvider extends EmailSender {
  readonly calls: { readonly to: string; readonly template: EmailTemplate }[];
}

function stubProvider(): StubProvider {
  const calls: StubProvider['calls'] = [];
  return {
    calls,
    send(to, template) {
      calls.push({ to, template });
      return Promise.resolve();
    },
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

beforeAll(async () => {
  if ('error' in registration) {
    throw new Error(`createTelemetryTestHarness() failed: ${String(registration.error)}`, {
      cause: registration.error,
    });
  }
  harness = registration.harness;
  allowlist = await import('./email-allowlist.js');
});

beforeEach(async () => {
  await harness.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the recipient-domain allowlist wrapper (043 task 6.5b)', () => {
  it('a recipient on the list reaches the stubbed provider unchanged', async () => {
    const provider = stubProvider();
    const sender = allowlist.createAllowlistEmailSender(provider, ['allowed.example']);

    await sender.send(ALLOWED_RECIPIENT, INVITATION);
    await sender.send(ALLOWED_RECIPIENT, NOTICE);

    expect(provider.calls).toEqual([
      { to: ALLOWED_RECIPIENT, template: INVITATION },
      { to: ALLOWED_RECIPIENT, template: NOTICE },
    ]);
    await harness.forceFlush();
    const blocked = harness.logExporter
      .getFinishedLogRecords()
      .filter((record) => record.eventName === EVENT);
    expect(blocked).toHaveLength(0);
  });

  it('a recipient written `Bob@Allowed.Example ` reaches the provider when `allowed.example` is on the list (task 7.10)', async () => {
    const provider = stubProvider();
    const sender = allowlist.createAllowlistEmailSender(provider, ['allowed.example']);

    await sender.send('Bob@Allowed.Example ', INVITATION);

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.template).toEqual(INVITATION);
    expect(provider.calls[0]?.to.trim().toLowerCase()).toBe('bob@allowed.example');
  });

  it('a recipient off the list never reaches the provider', async () => {
    const provider = stubProvider();
    const sender = allowlist.createAllowlistEmailSender(provider, ['allowed.example']);

    await rejectionOf(sender.send(BLOCKED_RECIPIENT, INVITATION));
    await rejectionOf(sender.send(BLOCKED_RECIPIENT, NOTICE));
    // A look-alike domain is not on the list either.
    await rejectionOf(sender.send('person@allowed.example.attacker.test', NOTICE));
    await rejectionOf(sender.send('person@sub.allowed.example', NOTICE));

    expect(provider.calls).toHaveLength(0);
  });

  it('the refusal is handled like a provider failure and is sanitized', async () => {
    const provider = stubProvider();
    const sender = allowlist.createAllowlistEmailSender(provider, ['allowed.example']);

    const error = await rejectionOf(sender.send(BLOCKED_RECIPIENT, INVITATION));

    expect(error).toBeInstanceOf(EmailProviderError);
    const text = everythingAbout(error);
    for (const secret of [BLOCKED_RECIPIENT, BLOCKED_LOCAL, BLOCKED_DOMAIN, TOKEN, LINK]) {
      expect(text).not.toContain(secret);
    }
    expect((error as Error).cause).toBeUndefined();
  });

  it('logs the blocked event with the template and no address', async () => {
    const provider = stubProvider();
    const sender = allowlist.createAllowlistEmailSender(provider, ['allowed.example']);

    await rejectionOf(sender.send(BLOCKED_RECIPIENT, INVITATION));
    await rejectionOf(sender.send(BLOCKED_RECIPIENT, NOTICE));
    await harness.forceFlush();

    const records = harness.logExporter
      .getFinishedLogRecords()
      .filter((record) => record.eventName === EVENT);
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.attributes['tayzu.identity.email.template'])).toEqual([
      'invitation',
      'admin_accepted',
    ]);
    for (const record of records) {
      expect(record.severityText).toBe('WARN');
      const serialized = JSON.stringify([record.attributes, record.body]);
      for (const secret of [BLOCKED_RECIPIENT, BLOCKED_LOCAL, BLOCKED_DOMAIN, TOKEN, LINK]) {
        expect(serialized).not.toContain(secret);
      }
    }
  });

  it('writes the address nowhere on the console while refusing', async () => {
    const spies = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'debug'),
    ];
    const sender = allowlist.createAllowlistEmailSender(stubProvider(), ['allowed.example']);

    await rejectionOf(sender.send(BLOCKED_RECIPIENT, INVITATION));

    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(BLOCKED_LOCAL);
    }
  });
});
