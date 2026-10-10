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
 * `Config` gains the tenant cap default (30 per 3600 s) following `limitWithDefaults`.
 */
// Load-bearing import order (design D1): the telemetry harness registers before
// anything that loads `@tayzu/auth` creates its logger.
import { registration, type TelemetryTestHarness } from '../__fixtures__/link-telemetry.js';
import { randomUUID } from 'node:crypto';

import { AuthRateLimitedError, createRecordingEmailSender, type EmailTemplate } from '@tayzu/auth';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createEmailTenantGate } from './email-tenant-gate.js';
import { createInMemoryEmailCapStore } from './invitation-caps.js';

const EVENT = 'catalog.security.invitation_rate_limited';
const RECIPIENT_LOCAL = 'marker-recipient';
const RECIPIENT = `${RECIPIENT_LOCAL}@example.test`;
const TOKEN = 'marker-token-7f3a9c';
const LINK = `https://app.example.test/accept-invitation#invitation=marker-id-1&token=${TOKEN}`;
const INVITATION: EmailTemplate = { kind: 'InvitationEmail', link: LINK, expiryText: '48 hours' };
const TENANT_CAP = { max: 30, windowSeconds: 3600 };

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
    const capStore = createInMemoryEmailCapStore({ tenant: TENANT_CAP });
    // invite and resend are two services over the one gate and the one store
    const invite = createEmailTenantGate({ disabledTenantIds: [], capStore, sender });
    const resend = createEmailTenantGate({ disabledTenantIds: [], capStore, sender });
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
      capStore: createInMemoryEmailCapStore({ tenant: TENANT_CAP }),
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
