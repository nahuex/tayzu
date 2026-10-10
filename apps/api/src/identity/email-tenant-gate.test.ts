/**
 * `043` task 6.5c (design D5, Resolved decision Q80): the one gate that sends
 * invitation emails (7.3 and 7.7) honors `EMAIL_DISABLED_TENANT_IDS`. For a listed
 * tenant the email is suppressed before any cap is consumed, nothing reaches the
 * sender, the operation is not blocked, and `catalog.security.email_tenant_blocked`
 * is logged with the tenant and the template and no address. The notice case is 6.12's.
 *
 * ## Production symbols expected
 *
 * ```ts
 * // apps/api/src/identity/email-tenant-gate.ts (does not exist yet)
 * export interface EmailCapStore {
 *   // The port of the caps of 6.6 to 6.8 and 6.10; the gate consumes a bucket
 *   // through it, and only for a tenant that is not listed.
 *   consume(scope: string, key: string): Promise<void>;
 * }
 * export interface EmailTenantGate {
 *   send(input: {
 *     readonly tenantId: string;
 *     readonly to: string;
 *     readonly template: EmailTemplate; // from '@tayzu/auth'
 *   }): Promise<void>; // resolves normally for a suppressed email
 * }
 * export function createEmailTenantGate(deps: {
 *   readonly disabledTenantIds: readonly string[]; // Config.emailDisabledTenantIds
 *   readonly capStore: EmailCapStore;
 *   readonly sender: EmailSender; // from '@tayzu/auth'
 * }): EmailTenantGate;
 * ```
 *
 * The event is `catalog.security.email_tenant_blocked` (WARN) with the attributes
 * `tayzu.tenant.id` and `tayzu.identity.email.template` (`invitation` for
 * `InvitationEmail`), emitted through `emitIdentityEvent`.
 * `Config.emailDisabledTenantIds` is covered in `config.test.ts`.
 */
// Load-bearing import order (design D1): the telemetry harness registers before
// anything that loads `@tayzu/auth` creates its logger.
import { registration, type TelemetryTestHarness } from '../__fixtures__/link-telemetry.js';
import { randomUUID } from 'node:crypto';

import { createRecordingEmailSender, type EmailTemplate } from '@tayzu/auth';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createEmailTenantGate, type EmailCapStore } from './email-tenant-gate.js';

const EVENT = 'catalog.security.email_tenant_blocked';
const RECIPIENT_LOCAL = 'marker-recipient';
const RECIPIENT = `${RECIPIENT_LOCAL}@example.test`;
const TOKEN = 'marker-token-7f3a9c';
const LINK = `https://app.example.test/accept-invitation#invitation=marker-id-1&token=${TOKEN}`;
const INVITATION: EmailTemplate = { kind: 'InvitationEmail', link: LINK, expiryText: '48 hours' };

interface RecordingCapStore extends EmailCapStore {
  readonly consumed: { readonly scope: string; readonly key: string }[];
}

function recordingCapStore(): RecordingCapStore {
  const consumed: RecordingCapStore['consumed'] = [];
  return {
    consumed,
    consume(scope, key) {
      consumed.push({ scope, key });
      return Promise.resolve();
    },
  };
}

function tenantId(): string {
  return `tenant-${randomUUID()}`;
}

let harness: TelemetryTestHarness;

beforeAll(() => {
  if ('error' in registration) {
    throw new Error(`createTelemetryTestHarness() failed: ${String(registration.error)}`, {
      cause: registration.error,
    });
  }
  harness = registration.harness;
});

beforeEach(async () => {
  await harness.reset();
});

async function blockedEvents() {
  await harness.forceFlush();
  return harness.logExporter.getFinishedLogRecords().filter((record) => record.eventName === EVENT);
}

describe('the email tenant gate (043 task 6.5c, Q80)', () => {
  it("a listed tenant's invitation email never reaches the sender and consumes no bucket", async () => {
    const listed = tenantId();
    const sender = createRecordingEmailSender();
    const capStore = recordingCapStore();
    const gate = createEmailTenantGate({
      disabledTenantIds: [tenantId(), listed],
      capStore,
      sender,
    });

    await gate.send({ tenantId: listed, to: RECIPIENT, template: INVITATION });

    expect(sender.sent).toHaveLength(0);
    expect(capStore.consumed).toHaveLength(0);
  });

  it("an unlisted tenant's email reaches the sender", async () => {
    const sender = createRecordingEmailSender();
    const gate = createEmailTenantGate({
      disabledTenantIds: [tenantId()],
      capStore: recordingCapStore(),
      sender,
    });
    const unlisted = tenantId();

    await gate.send({ tenantId: unlisted, to: RECIPIENT, template: INVITATION });

    expect(sender.sent).toEqual([{ to: RECIPIENT, template: INVITATION }]);
    expect(await blockedEvents()).toHaveLength(0);
  });

  it('an empty list suppresses nothing', async () => {
    const sender = createRecordingEmailSender();
    const gate = createEmailTenantGate({
      disabledTenantIds: [],
      capStore: recordingCapStore(),
      sender,
    });

    await gate.send({ tenantId: tenantId(), to: RECIPIENT, template: INVITATION });

    expect(sender.sent).toHaveLength(1);
  });

  it('the tenant list matches exactly, never by prefix or case', async () => {
    const sender = createRecordingEmailSender();
    const listed = `Demo-${randomUUID()}`;
    const gate = createEmailTenantGate({
      disabledTenantIds: [listed],
      capStore: recordingCapStore(),
      sender,
    });

    await gate.send({ tenantId: `${listed}-2`, to: RECIPIENT, template: INVITATION });
    await gate.send({ tenantId: listed.toLowerCase(), to: RECIPIENT, template: INVITATION });

    expect(sender.sent).toHaveLength(2);
  });

  it('logs the blocked event with the tenant and the template and no address', async () => {
    const listed = tenantId();
    const gate = createEmailTenantGate({
      disabledTenantIds: [listed],
      capStore: recordingCapStore(),
      sender: createRecordingEmailSender(),
    });

    await gate.send({ tenantId: listed, to: RECIPIENT, template: INVITATION });

    const records = await blockedEvents();
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record?.severityText).toBe('WARN');
    expect(record?.attributes['tayzu.tenant.id']).toBe(listed);
    expect(record?.attributes['tayzu.identity.email.template']).toBe('invitation');
    const serialized = JSON.stringify([record?.attributes, record?.body]);
    for (const secret of [RECIPIENT, RECIPIENT_LOCAL, 'example.test', TOKEN, LINK]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('the gate returns normally for a listed tenant: the operation is not blocked', async () => {
    const listed = tenantId();
    const gate = createEmailTenantGate({
      disabledTenantIds: [listed],
      capStore: recordingCapStore(),
      sender: createRecordingEmailSender(),
    });

    await expect(
      gate.send({ tenantId: listed, to: RECIPIENT, template: INVITATION }),
    ).resolves.toBeUndefined();
  });
});
