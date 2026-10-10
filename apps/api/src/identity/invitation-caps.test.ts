/**
 * `043` task 6.6 (design D5, Resolved decision Q15): a per-tenant cap of 30 invitation
 * emails per hour, shared by invite and resend, on a store interface (in memory in
 * tests). Exceeding it fails with `AUTH_RATE_LIMITED` (the `AuthRateLimitedError` of
 * 6.8b), sends nothing and logs `catalog.security.invitation_rate_limited` with scope
 * `tenant`. The recipient cap (6.7) and the kill switch (6.8) add their cases to this file.
 *
 * ## Production symbols expected
 *
 * ```ts
 * // apps/api/src/identity/invitation-caps.ts (does not exist yet)
 * export interface InvitationCapLimits {
 *   readonly tenant: { readonly max: number; readonly windowSeconds: number };
 * }
 * // An in-memory EmailCapStore (the port of email-tenant-gate.ts). `consume` rejects
 * // with AuthRateLimitedError once the tenant's bucket is full.
 * export function createInMemoryEmailCapStore(limits: InvitationCapLimits): EmailCapStore;
 * ```
 *
 * `createEmailTenantGate` (email-tenant-gate.ts) consumes the tenant bucket through its
 * `capStore` for a tenant that is not listed, BEFORE the sender is called, so a
 * rejection leaves the sender untouched; the rejection propagates to the caller. The
 * gate (or the store) emits `catalog.security.invitation_rate_limited` (WARN) with
 * `tayzu.tenant.id` and `tayzu.identity.invitation.limit_scope` = `tenant`, no address.
 * Invite and resend use the one gate, so they share the one bucket.
 * 6.7 additionally expects:
 *
 * ```ts
 * // InvitationCapLimits gains `recipient: { max: number; windowSeconds: number }` (3 / 86400).
 * // createEmailTenantGate deps gain `recipientKeySecret?: string`. When set, after the tenant
 * // bucket and before the sender, the gate calls capStore.consume('recipient',
 * //   recipientKey(to, recipientKeySecret)) (`to` is already canonical). The in-memory store
 * // supports scope 'recipient' (shared across tenants, one bucket per key) and rejects with
 * // AuthRateLimitedError when full. The gate emits invitation_rate_limited with
 * // limit_scope = 'recipient' (tenant id attribute, no address).
 * ```
 *
 * `Config` gains the tenant cap default (30 per 3600 s) following `limitWithDefaults`.
 */
// Load-bearing import order (design D1): the telemetry harness registers before
// anything that loads `@tayzu/auth` creates its logger.
import { registration, type TelemetryTestHarness } from '../__fixtures__/link-telemetry.js';
import { randomUUID } from 'node:crypto';

import { AuthRateLimitedError, createRecordingEmailSender, type EmailTemplate } from '@tayzu/auth';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createEmailTenantGate, type EmailCapStore } from './email-tenant-gate.js';
import { createInMemoryEmailCapStore } from './invitation-caps.js';
import { recipientKey } from './recipient-key.js';

const EVENT = 'catalog.security.invitation_rate_limited';
const RECIPIENT_LOCAL = 'marker-recipient';
const RECIPIENT = `${RECIPIENT_LOCAL}@example.test`;
const TOKEN = 'marker-token-7f3a9c';
const LINK = `https://app.example.test/accept-invitation#invitation=marker-id-1&token=${TOKEN}`;
const INVITATION: EmailTemplate = { kind: 'InvitationEmail', link: LINK, expiryText: '48 hours' };
const TENANT_CAP = { max: 30, windowSeconds: 3600 };
const RECIPIENT_CAP = { max: 3, windowSeconds: 86_400 };
const HMAC_SECRET = 'invitation-caps-test-only-secret-0123456789-abcdef';

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

async function limitedEvents() {
  await harness.forceFlush();
  return harness.logExporter.getFinishedLogRecords().filter((record) => record.eventName === EVENT);
}

describe('the per-tenant invitation cap (043 task 6.6, Q15)', () => {
  it('Exceeding the per-tenant cap blocks further invites', async () => {
    // GIVEN a tenant that has already created or resent 30 invitations in the current hour
    const tenant = tenantId();
    const sender = createRecordingEmailSender();
    const capStore = createInMemoryEmailCapStore({ tenant: TENANT_CAP, recipient: RECIPIENT_CAP });
    // invite and resend are two services over the one gate and the one store
    const invite = createEmailTenantGate({
      disabledTenantIds: [],
      capStore,
      sender,
      recipientKeySecret: HMAC_SECRET,
    });
    const resend = createEmailTenantGate({
      disabledTenantIds: [],
      capStore,
      sender,
      recipientKeySecret: HMAC_SECRET,
    });
    for (let i = 0; i < 20; i += 1) {
      await invite.send({
        tenantId: tenant,
        to: `invitee-${String(i)}@example.test`,
        template: INVITATION,
      });
    }
    for (let i = 20; i < 30; i += 1) {
      await resend.send({
        tenantId: tenant,
        to: `invitee-${String(i)}@example.test`,
        template: INVITATION,
      });
    }
    expect(sender.sent).toHaveLength(30);
    expect(await limitedEvents()).toHaveLength(0);

    // WHEN an admin attempts one more invite or resend
    const rejectedInvite = await invite
      .send({ tenantId: tenant, to: RECIPIENT, template: INVITATION })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    const rejectedResend = await resend
      .send({ tenantId: tenant, to: RECIPIENT, template: INVITATION })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // THEN the operation fails with AUTH_RATE_LIMITED
    for (const rejected of [rejectedInvite, rejectedResend]) {
      expect(rejected).toBeInstanceOf(AuthRateLimitedError);
      expect((rejected as AuthRateLimitedError).code).toBe('AUTH_RATE_LIMITED');
    }

    // AND no email is sent (the fake recorded no further call)
    expect(sender.sent).toHaveLength(30);

    // AND catalog.security.invitation_rate_limited is logged with scope tenant
    const records = await limitedEvents();
    expect(records.length).toBeGreaterThanOrEqual(1);
    for (const record of records) {
      expect(record.severityText).toBe('WARN');
      expect(record.attributes['tayzu.tenant.id']).toBe(tenant);
      expect(record.attributes['tayzu.identity.invitation.limit_scope']).toBe('tenant');
      const serialized = JSON.stringify([record.attributes, record.body]);
      for (const secret of [RECIPIENT, RECIPIENT_LOCAL, 'example.test', TOKEN, LINK]) {
        expect(serialized).not.toContain(secret);
      }
    }
  });

  it("one tenant's full bucket never blocks another tenant", async () => {
    const full = tenantId();
    const other = tenantId();
    const sender = createRecordingEmailSender();
    const gate = createEmailTenantGate({
      disabledTenantIds: [],
      recipientKeySecret: HMAC_SECRET,
      capStore: createInMemoryEmailCapStore({ tenant: TENANT_CAP, recipient: RECIPIENT_CAP }),
      sender,
    });
    for (let i = 0; i < 30; i += 1) {
      await gate.send({
        tenantId: full,
        to: `invitee-${String(i)}@example.test`,
        template: INVITATION,
      });
    }
    await expect(
      gate.send({ tenantId: full, to: RECIPIENT, template: INVITATION }),
    ).rejects.toBeInstanceOf(AuthRateLimitedError);

    await gate.send({ tenantId: other, to: RECIPIENT, template: INVITATION });

    expect(sender.sent).toHaveLength(31);
  });
});

describe('the per-recipient invitation cap (043 task 6.7, Q15, Q93)', () => {
  it('Exceeding the per-recipient cap blocks repeat invites across tenants', async () => {
    // GIVEN three invitations to the recipient in 24 hours from any tenants
    const sender = createRecordingEmailSender();
    const consumed: { scope: string; key: string }[] = [];
    const inner = createInMemoryEmailCapStore({ tenant: TENANT_CAP, recipient: RECIPIENT_CAP });
    const capStore: EmailCapStore = {
      async consume(scope, key) {
        consumed.push({ scope, key });
        await inner.consume(scope, key);
      },
    };
    const gate = createEmailTenantGate({
      disabledTenantIds: [],
      capStore,
      sender,
      recipientKeySecret: HMAC_SECRET,
    });
    for (let i = 0; i < 3; i += 1) {
      await gate.send({ tenantId: tenantId(), to: RECIPIENT, template: INVITATION });
    }
    expect(sender.sent).toHaveLength(3);
    expect(await limitedEvents()).toHaveLength(0);

    // WHEN another tenant invites the same recipient
    const attacker = tenantId();
    const rejected = await gate
      .send({ tenantId: attacker, to: RECIPIENT, template: INVITATION })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // THEN the operation fails with AUTH_RATE_LIMITED
    expect(rejected).toBeInstanceOf(AuthRateLimitedError);
    expect((rejected as AuthRateLimitedError).code).toBe('AUTH_RATE_LIMITED');

    // AND no email is sent
    expect(sender.sent).toHaveLength(3);

    // AND the event has scope recipient and no email address
    const records = await limitedEvents();
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record?.severityText).toBe('WARN');
    expect(record?.attributes['tayzu.identity.invitation.limit_scope']).toBe('recipient');
    const serialized = JSON.stringify([record?.attributes, record?.body]);
    for (const secret of [RECIPIENT, RECIPIENT_LOCAL, 'example.test', TOKEN, LINK, HMAC_SECRET]) {
      expect(serialized).not.toContain(secret);
    }

    // AND no address is in the key store: the keys are the HMAC of the address
    const recipientCalls = consumed.filter((call) => call.scope === 'recipient');
    expect(recipientCalls).toHaveLength(4);
    for (const call of recipientCalls) {
      expect(call.key).toBe(recipientKey(RECIPIENT, HMAC_SECRET));
    }
    for (const call of consumed) {
      expect(call.key).not.toContain(RECIPIENT);
      expect(call.key).not.toContain(RECIPIENT_LOCAL);
      expect(call.key).not.toContain('example.test');
    }
  });

  it('a different recipient is not blocked by a full recipient bucket', async () => {
    const sender = createRecordingEmailSender();
    const gate = createEmailTenantGate({
      disabledTenantIds: [],
      capStore: createInMemoryEmailCapStore({ tenant: TENANT_CAP, recipient: RECIPIENT_CAP }),
      sender,
      recipientKeySecret: HMAC_SECRET,
    });
    for (let i = 0; i < 3; i += 1) {
      await gate.send({ tenantId: tenantId(), to: RECIPIENT, template: INVITATION });
    }
    await gate.send({
      tenantId: tenantId(),
      to: 'someone-else@example.test',
      template: INVITATION,
    });
    expect(sender.sent).toHaveLength(4);
  });
});

/**
 * 043 task 6.8 additionally expects `createEmailTenantGate` deps to gain
 * `killSwitch?: boolean` (the parsed `INVITATION_EMAIL_KILL_SWITCH`; `Config` gains the
 * matching field). When true, `send` rejects with `AuthRateLimitedError` BEFORE any bucket
 * is consumed and before the sender, and emits `catalog.security.invitation_rate_limited`
 * with `tayzu.identity.invitation.limit_scope` = `global` and the tenant id, no address.
 */
describe('the global invitation kill switch (043 task 6.8, Q15)', () => {
  it('The global kill switch stops all invitation email', async () => {
    // GIVEN INVITATION_EMAIL_KILL_SWITCH is on
    const sender = createRecordingEmailSender();
    const consumed: { scope: string; key: string }[] = [];
    const inner = createInMemoryEmailCapStore({ tenant: TENANT_CAP, recipient: RECIPIENT_CAP });
    const capStore: EmailCapStore = {
      async consume(scope, key) {
        consumed.push({ scope, key });
        await inner.consume(scope, key);
      },
    };
    const invite = createEmailTenantGate({
      disabledTenantIds: [],
      capStore,
      sender,
      recipientKeySecret: HMAC_SECRET,
      killSwitch: true,
    });
    const resend = createEmailTenantGate({
      disabledTenantIds: [],
      capStore,
      sender,
      recipientKeySecret: HMAC_SECRET,
      killSwitch: true,
    });
    const tenant = tenantId();

    // WHEN any invite or resend is attempted
    const rejectedInvite = await invite
      .send({ tenantId: tenant, to: RECIPIENT, template: INVITATION })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    const rejectedResend = await resend
      .send({ tenantId: tenantId(), to: 'other@example.test', template: INVITATION })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // THEN it fails with AUTH_RATE_LIMITED
    for (const rejected of [rejectedInvite, rejectedResend]) {
      expect(rejected).toBeInstanceOf(AuthRateLimitedError);
      expect((rejected as AuthRateLimitedError).code).toBe('AUTH_RATE_LIMITED');
    }

    // AND no email is sent
    expect(sender.sent).toHaveLength(0);

    // AND the event carries scope global, the tenant and no address; no bucket was consumed
    expect(consumed).toHaveLength(0);
    const records = await limitedEvents();
    expect(records).toHaveLength(2);
    const [first] = records;
    expect(first?.severityText).toBe('WARN');
    expect(first?.attributes['tayzu.tenant.id']).toBe(tenant);
    for (const record of records) {
      expect(record.attributes['tayzu.identity.invitation.limit_scope']).toBe('global');
      const serialized = JSON.stringify([record.attributes, record.body]);
      for (const secret of [RECIPIENT, RECIPIENT_LOCAL, 'example.test', TOKEN, LINK, HMAC_SECRET]) {
        expect(serialized).not.toContain(secret);
      }
    }
  });

  it('with the kill switch off, invitation email is sent', async () => {
    const sender = createRecordingEmailSender();
    const gate = createEmailTenantGate({
      disabledTenantIds: [],
      capStore: createInMemoryEmailCapStore({ tenant: TENANT_CAP, recipient: RECIPIENT_CAP }),
      sender,
      recipientKeySecret: HMAC_SECRET,
      killSwitch: false,
    });
    await gate.send({ tenantId: tenantId(), to: RECIPIENT, template: INVITATION });
    expect(sender.sent).toHaveLength(1);
    expect(await limitedEvents()).toHaveLength(0);
  });
});
