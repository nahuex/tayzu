/**
 * `043` task 6.12 (design D4 step 6 and "Notice emails", Resolved decisions Q53, Q58) and
 * 6.12b (Resolved decision Q101): the notice dispatcher is the only way a notice is sent.
 * It applies the tenant list of 6.5c before anything, then the global kill switch, the
 * per-tenant notice cap (scope `notice_tenant`) and the notices' own per-recipient bucket
 * (scope `notice_recipient`, keyed by the HMAC of 6.7b, not the invitation bucket), sends to
 * at most 20 recipients (the longest-standing administrators, `Disabled` ones included) and
 * never throws into its caller. A suppressed or truncated notice logs
 * `catalog.security.notice_suppressed`.
 *
 * ## Production symbols expected
 *
 * ```ts
 * // apps/api/src/identity/notices.ts (does not exist yet)
 * export interface NoticeRecipient {
 *   readonly email: string; // already canonical (7.10)
 *   readonly memberSince: Date; // membership creation; the dispatcher keeps the 20 oldest
 *   readonly status?: 'Active' | 'Disabled'; // never used to filter: Disabled ones are notified
 * }
 * export interface NoticeDispatcher {
 *   // Resolves normally in every case (suppression, truncation, a failing store or sender).
 *   send(input: {
 *     readonly tenantId: string;
 *     readonly template: Extract<EmailTemplate, { kind: 'AdminAcceptedNotice' }>;
 *     readonly recipients: readonly NoticeRecipient[]; // in any order
 *   }): Promise<void>;
 * }
 * export function createNoticeDispatcher(deps: {
 *   readonly disabledTenantIds: readonly string[]; // Config.emailDisabledTenantIds
 *   readonly capStore: EmailCapStore; // email-tenant-gate.ts; rejects with AuthRateLimitedError when full
 *   readonly sender: EmailSender;
 *   readonly recipientKeySecret: string; // IDENTITY_TOKEN_HMAC_SECRET
 *   readonly killSwitch?: boolean; // INVITATION_EMAIL_KILL_SWITCH
 * }): NoticeDispatcher;
 * ```
 *
 * Buckets: per email, `capStore.consume('notice_tenant', tenantId)` and
 * `capStore.consume('notice_recipient', recipientKey(email, secret))`, none of them for a
 * listed tenant or when the kill switch is on. The tenant list is checked first and logs
 * `catalog.security.email_tenant_blocked` with `tayzu.tenant.id` and
 * `tayzu.identity.email.template` = `admin_accepted`.
 *
 * Event `catalog.security.notice_suppressed` (WARN), one per reason that dropped at least
 * one email, with `tayzu.tenant.id`, `tayzu.identity.notice.template` = `admin_accepted`,
 * `tayzu.identity.notice.suppression` (`global` | `tenant` | `recipient` | `truncated`)
 * and `tayzu.identity.notice.dropped` (the number of emails dropped for that reason).
 *
 * `Config` gains `noticeTenantCap` (60 per 3600 s) in `config.test.ts`.
 */
// Load-bearing import order (design D1): the telemetry harness registers before
// anything that loads `@tayzu/auth` creates its logger.
import { registration, type TelemetryTestHarness } from '../__fixtures__/link-telemetry.js';
import { randomUUID } from 'node:crypto';

import {
  AuthRateLimitedError,
  createRecordingEmailSender,
  type EmailSender,
  type EmailTemplate,
} from '@tayzu/auth';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createEmailTenantGate, type EmailCapStore } from './email-tenant-gate.js';
import { createNoticeDispatcher, type NoticeRecipient } from './notices.js';
import { recipientKey } from './recipient-key.js';

const SUPPRESSED = 'catalog.security.notice_suppressed';
const BLOCKED = 'catalog.security.email_tenant_blocked';
const HMAC_SECRET = 'notices-test-only-secret-0123456789-abcdefghij';
const NOTICE: Extract<EmailTemplate, { kind: 'AdminAcceptedNotice' }> = {
  kind: 'AdminAcceptedNotice',
};
const INVITATION: EmailTemplate = {
  kind: 'InvitationEmail',
  link: 'https://app.example.test/accept-invitation#invitation=marker-id-1&token=marker-token',
  expiryText: '48 hours',
};

/** Fixed windows are irrelevant here: a bucket is full once `max` hits were consumed. */
const DEFAULT_LIMITS: Record<string, number> = {
  tenant: 30,
  recipient: 3,
  notice_tenant: 60,
  notice_recipient: 3,
};

interface FakeStore extends EmailCapStore {
  readonly consumed: { readonly scope: string; readonly key: string }[];
}

function fakeStore(limits: Record<string, number> = {}): FakeStore {
  const max = { ...DEFAULT_LIMITS, ...limits };
  const counts = new Map<string, number>();
  const consumed: FakeStore['consumed'] = [];
  return {
    consumed,
    consume(scope, key) {
      consumed.push({ scope, key });
      const limit = max[scope];
      if (limit === undefined) {
        return Promise.reject(new Error(`unexpected scope ${scope}`));
      }
      const id = `${scope}:${key}`;
      const count = counts.get(id) ?? 0;
      if (count >= limit) {
        return Promise.reject(new AuthRateLimitedError(3600));
      }
      counts.set(id, count + 1);
      return Promise.resolve();
    },
  };
}

function tenantId(): string {
  return `tenant-${randomUUID()}`;
}

function admin(index: number, extra: Partial<NoticeRecipient> = {}): NoticeRecipient {
  return {
    email: `admin-${String(index)}-${randomUUID()}@example.test`,
    memberSince: new Date(Date.UTC(2024, 0, 1 + index)),
    ...extra,
  };
}

function recipientsOf(sender: { readonly sent: readonly { readonly to: string }[] }): string[] {
  return sender.sent.map((message) => message.to);
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

async function eventsNamed(name: string) {
  await harness.forceFlush();
  return harness.logExporter.getFinishedLogRecords().filter((record) => record.eventName === name);
}

function expectNoAddress(
  records: readonly { readonly attributes: unknown; readonly body?: unknown }[],
  addresses: readonly string[],
) {
  for (const record of records) {
    const serialized = JSON.stringify([record.attributes, record.body]);
    for (const address of addresses) {
      expect(serialized).not.toContain(address);
      expect(serialized).not.toContain(address.split('@')[0] ?? address);
    }
    expect(serialized).not.toContain('example.test');
    expect(serialized).not.toContain(HMAC_SECRET);
  }
}

describe('The notices are under the kill switch and the caps (043 task 6.12, Q53)', () => {
  it('the kill switch on suppresses every notice with the reason global and consumes no bucket', async () => {
    const tenant = tenantId();
    const sender = createRecordingEmailSender();
    const store = fakeStore();
    const admins = [admin(1), admin(2), admin(3)];
    const dispatcher = createNoticeDispatcher({
      disabledTenantIds: [],
      capStore: store,
      sender,
      recipientKeySecret: HMAC_SECRET,
      killSwitch: true,
    });

    await expect(
      dispatcher.send({ tenantId: tenant, template: NOTICE, recipients: admins }),
    ).resolves.toBeUndefined();

    expect(sender.sent).toHaveLength(0);
    expect(store.consumed).toHaveLength(0);
    const records = await eventsNamed(SUPPRESSED);
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record?.severityText).toBe('WARN');
    expect(record?.attributes['tayzu.tenant.id']).toBe(tenant);
    expect(record?.attributes['tayzu.identity.notice.template']).toBe('admin_accepted');
    expect(record?.attributes['tayzu.identity.notice.suppression']).toBe('global');
    expect(record?.attributes['tayzu.identity.notice.dropped']).toBe(3);
    expectNoAddress(
      records,
      admins.map((a) => a.email),
    );
  });

  it('an exhausted per-tenant notice cap suppresses exactly the emails beyond it with the reason tenant', async () => {
    const tenant = tenantId();
    const sender = createRecordingEmailSender();
    const store = fakeStore({ notice_tenant: 2 });
    const admins = [admin(1), admin(2), admin(3)];
    const dispatcher = createNoticeDispatcher({
      disabledTenantIds: [],
      capStore: store,
      sender,
      recipientKeySecret: HMAC_SECRET,
    });

    await expect(
      dispatcher.send({ tenantId: tenant, template: NOTICE, recipients: admins }),
    ).resolves.toBeUndefined();

    // The cap counts emails, per tenant, in its own scope.
    expect(sender.sent).toHaveLength(2);
    expect(store.consumed.filter((c) => c.scope === 'notice_tenant')).toSatisfy(
      (calls: readonly { key: string }[]) => calls.every((call) => call.key === tenant),
    );
    const records = await eventsNamed(SUPPRESSED);
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record?.attributes['tayzu.tenant.id']).toBe(tenant);
    expect(record?.attributes['tayzu.identity.notice.template']).toBe('admin_accepted');
    expect(record?.attributes['tayzu.identity.notice.suppression']).toBe('tenant');
    expect(record?.attributes['tayzu.identity.notice.dropped']).toBe(1);
    expectNoAddress(
      records,
      admins.map((a) => a.email),
    );
  });

  it('a full per-recipient bucket suppresses exactly that recipient with the reason recipient', async () => {
    const tenant = tenantId();
    const sender = createRecordingEmailSender();
    const store = fakeStore();
    const [full, ok1, ok2] = [admin(1), admin(2), admin(3)] as [
      NoticeRecipient,
      NoticeRecipient,
      NoticeRecipient,
    ];
    // GIVEN the notice bucket of the first recipient is already full (3 notices)
    for (let i = 0; i < 3; i += 1) {
      await store.consume('notice_recipient', recipientKey(full.email, HMAC_SECRET));
    }
    store.consumed.length = 0;
    const dispatcher = createNoticeDispatcher({
      disabledTenantIds: [],
      capStore: store,
      sender,
      recipientKeySecret: HMAC_SECRET,
    });

    await expect(
      dispatcher.send({ tenantId: tenant, template: NOTICE, recipients: [full, ok1, ok2] }),
    ).resolves.toBeUndefined();

    expect(recipientsOf(sender).sort()).toEqual([ok1.email, ok2.email].sort());
    // AND the key is the HMAC of the address, never the address
    for (const call of store.consumed) {
      expect(call.key).not.toContain('example.test');
    }
    const records = await eventsNamed(SUPPRESSED);
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record?.attributes['tayzu.identity.notice.suppression']).toBe('recipient');
    expect(record?.attributes['tayzu.identity.notice.dropped']).toBe(1);
    expect(record?.attributes['tayzu.identity.notice.template']).toBe('admin_accepted');
    expectNoAddress(records, [full.email, ok1.email, ok2.email]);
  });

  it('a notice with no suppression logs no notice_suppressed event', async () => {
    const sender = createRecordingEmailSender();
    const dispatcher = createNoticeDispatcher({
      disabledTenantIds: [],
      capStore: fakeStore(),
      sender,
      recipientKeySecret: HMAC_SECRET,
    });

    await dispatcher.send({
      tenantId: tenantId(),
      template: NOTICE,
      recipients: [admin(1), admin(2)],
    });

    expect(sender.sent).toHaveLength(2);
    for (const message of sender.sent) {
      expect(message.template).toEqual(NOTICE);
    }
    expect(await eventsNamed(SUPPRESSED)).toHaveLength(0);
  });
});

describe('A notice goes to at most 20 recipients (043 task 6.12, Q53)', () => {
  it('25 admins: 20 emails to the longest-standing ones and a truncated event', async () => {
    const tenant = tenantId();
    const sender = createRecordingEmailSender();
    const admins = Array.from({ length: 25 }, (_, index) => admin(index));
    // the order given to the dispatcher is not the seniority order
    const shuffled = [...admins].reverse();
    const dispatcher = createNoticeDispatcher({
      disabledTenantIds: [],
      capStore: fakeStore(),
      sender,
      recipientKeySecret: HMAC_SECRET,
    });

    await expect(
      dispatcher.send({ tenantId: tenant, template: NOTICE, recipients: shuffled }),
    ).resolves.toBeUndefined();

    expect(sender.sent).toHaveLength(20);
    expect(recipientsOf(sender).sort()).toEqual(
      admins
        .slice(0, 20)
        .map((a) => a.email)
        .sort(),
    );
    const records = await eventsNamed(SUPPRESSED);
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record?.attributes['tayzu.tenant.id']).toBe(tenant);
    expect(record?.attributes['tayzu.identity.notice.template']).toBe('admin_accepted');
    expect(record?.attributes['tayzu.identity.notice.suppression']).toBe('truncated');
    expect(record?.attributes['tayzu.identity.notice.dropped']).toBe(5);
    expectNoAddress(
      records,
      admins.map((a) => a.email),
    );
  });

  it('exactly 20 administrators are all notified and nothing is truncated', async () => {
    const sender = createRecordingEmailSender();
    const dispatcher = createNoticeDispatcher({
      disabledTenantIds: [],
      capStore: fakeStore(),
      sender,
      recipientKeySecret: HMAC_SECRET,
    });

    await dispatcher.send({
      tenantId: tenantId(),
      template: NOTICE,
      recipients: Array.from({ length: 20 }, (_, index) => admin(index)),
    });

    expect(sender.sent).toHaveLength(20);
    expect(await eventsNamed(SUPPRESSED)).toHaveLength(0);
  });

  it('a Disabled administrator is among the recipients', async () => {
    const sender = createRecordingEmailSender();
    const disabled = admin(1, { status: 'Disabled' });
    const active = admin(2, { status: 'Active' });
    const dispatcher = createNoticeDispatcher({
      disabledTenantIds: [],
      capStore: fakeStore(),
      sender,
      recipientKeySecret: HMAC_SECRET,
    });

    await dispatcher.send({
      tenantId: tenantId(),
      template: NOTICE,
      recipients: [disabled, active],
    });

    expect(recipientsOf(sender).sort()).toEqual([disabled.email, active.email].sort());
  });
});

describe('The dispatcher never throws into its caller (043 task 6.12)', () => {
  it('a failing sender does not make send reject', async () => {
    const failing: EmailSender = {
      send: () => Promise.reject(new Error('provider down')),
    };
    const dispatcher = createNoticeDispatcher({
      disabledTenantIds: [],
      capStore: fakeStore(),
      sender: failing,
      recipientKeySecret: HMAC_SECRET,
    });

    await expect(
      dispatcher.send({ tenantId: tenantId(), template: NOTICE, recipients: [admin(1)] }),
    ).resolves.toBeUndefined();
  });

  it('a failing cap store does not make send reject', async () => {
    const broken: EmailCapStore = {
      consume: () => Promise.reject(new Error('database unavailable')),
    };
    const sender = createRecordingEmailSender();
    const dispatcher = createNoticeDispatcher({
      disabledTenantIds: [],
      capStore: broken,
      sender,
      recipientKeySecret: HMAC_SECRET,
    });

    await expect(
      dispatcher.send({ tenantId: tenantId(), template: NOTICE, recipients: [admin(1)] }),
    ).resolves.toBeUndefined();
  });

  it('suppression, a full cap and truncation all resolve normally', async () => {
    const dispatcher = createNoticeDispatcher({
      disabledTenantIds: [],
      capStore: fakeStore({ notice_tenant: 1 }),
      sender: createRecordingEmailSender(),
      recipientKeySecret: HMAC_SECRET,
    });

    await expect(
      dispatcher.send({
        tenantId: tenantId(),
        template: NOTICE,
        recipients: Array.from({ length: 25 }, (_, index) => admin(index)),
      }),
    ).resolves.toBeUndefined();
  });
});

describe('A notice of a tenant on the disabled list (043 task 6.12, 6.5c, Q80)', () => {
  it('is suppressed before any bucket is consumed, with nothing sent and email_tenant_blocked logged', async () => {
    const listed = tenantId();
    const sender = createRecordingEmailSender();
    const store = fakeStore();
    const admins = [admin(1), admin(2)];
    const dispatcher = createNoticeDispatcher({
      disabledTenantIds: [tenantId(), listed],
      capStore: store,
      sender,
      recipientKeySecret: HMAC_SECRET,
      // even with the kill switch on, the tenant list is applied first
      killSwitch: true,
    });

    await expect(
      dispatcher.send({ tenantId: listed, template: NOTICE, recipients: admins }),
    ).resolves.toBeUndefined();

    expect(sender.sent).toHaveLength(0);
    expect(store.consumed).toHaveLength(0);
    const records = await eventsNamed(BLOCKED);
    expect(records.length).toBeGreaterThanOrEqual(1);
    for (const record of records) {
      expect(record.severityText).toBe('WARN');
      expect(record.attributes['tayzu.tenant.id']).toBe(listed);
      expect(record.attributes['tayzu.identity.email.template']).toBe('admin_accepted');
    }
    expectNoAddress(
      records,
      admins.map((a) => a.email),
    );
  });

  it('an unlisted tenant still gets its notice', async () => {
    const sender = createRecordingEmailSender();
    const dispatcher = createNoticeDispatcher({
      disabledTenantIds: [tenantId()],
      capStore: fakeStore(),
      sender,
      recipientKeySecret: HMAC_SECRET,
    });

    await dispatcher.send({ tenantId: tenantId(), template: NOTICE, recipients: [admin(1)] });

    expect(sender.sent).toHaveLength(1);
    expect(await eventsNamed(BLOCKED)).toHaveLength(0);
  });
});

describe('Notices and invitations count in separate recipient buckets (043 task 6.12b, Q101)', () => {
  it('an exhausted invitation bucket does not suppress a notice, and an exhausted notice bucket suppresses with the reason recipient without blocking an invitation', async () => {
    // One shared store, as in production: the two scopes must still be counted apart.
    const store = fakeStore();
    const sender = createRecordingEmailSender();
    const gate = createEmailTenantGate({
      disabledTenantIds: [],
      capStore: store,
      sender,
      recipientKeySecret: HMAC_SECRET,
    });
    const dispatcher = createNoticeDispatcher({
      disabledTenantIds: [],
      capStore: store,
      sender,
      recipientKeySecret: HMAC_SECRET,
    });
    const first = admin(1);
    const second = admin(2);

    // GIVEN the first administrator has a full invitation bucket (three invitations from other tenants)
    for (let i = 0; i < 3; i += 1) {
      await gate.send({ tenantId: tenantId(), to: first.email, template: INVITATION });
    }
    await expect(
      gate.send({ tenantId: tenantId(), to: first.email, template: INVITATION }),
    ).rejects.toBeInstanceOf(AuthRateLimitedError);
    // AND the second one a full notice bucket (three notices from other tenants)
    for (let i = 0; i < 3; i += 1) {
      await dispatcher.send({ tenantId: tenantId(), template: NOTICE, recipients: [second] });
    }
    expect(sender.sent).toHaveLength(6);
    await harness.reset();
    const before = sender.sent.length;

    // WHEN an admin invitation is accepted in a tenant
    const tenant = tenantId();
    await dispatcher.send({ tenantId: tenant, template: NOTICE, recipients: [first, second] });

    // THEN the first administrator receives the notice, the second one's is suppressed
    const noticeMessages = sender.sent.slice(before);
    expect(noticeMessages).toEqual([{ to: first.email, template: NOTICE }]);
    const records = await eventsNamed(SUPPRESSED);
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record?.attributes['tayzu.tenant.id']).toBe(tenant);
    expect(record?.attributes['tayzu.identity.notice.suppression']).toBe('recipient');
    expect(record?.attributes['tayzu.identity.notice.dropped']).toBe(1);

    // AND another tenant's invitation of the second administrator is sent
    await gate.send({ tenantId: tenantId(), to: second.email, template: INVITATION });
    expect(sender.sent.at(-1)).toEqual({ to: second.email, template: INVITATION });
  });

  it('the notice bucket is keyed by the HMAC of the address in the scope notice_recipient', async () => {
    const store = fakeStore();
    const dispatcher = createNoticeDispatcher({
      disabledTenantIds: [],
      capStore: store,
      sender: createRecordingEmailSender(),
      recipientKeySecret: HMAC_SECRET,
    });
    const target = admin(1);

    await dispatcher.send({ tenantId: tenantId(), template: NOTICE, recipients: [target] });

    const calls = store.consumed.filter((call) => call.scope === 'notice_recipient');
    expect(calls).toEqual([
      { scope: 'notice_recipient', key: recipientKey(target.email, HMAC_SECRET) },
    ]);
    expect(store.consumed.some((call) => call.scope === 'recipient')).toBe(false);
  });
});
