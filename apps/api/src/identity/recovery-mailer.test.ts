/**
 * Task 5.3 of openspec/changes/044-password-reset-and-account-recovery (design D5, "The email
 * path of an anonymous reset"): `admitResetEmail`, first half. The controls that need no
 * counter run in this order: kill switch, recipient-domain allowlist, every tenant of the user
 * on the disabled list. A refusal returns normally, is logged once as
 * `catalog.security.recovery_email_suppressed` and returns no send handle. An admission returns
 * a detached `send(link)` that swallows and counts a failure, and the mailer tracks in-flight
 * sends and drains them.
 *
 * Scenarios (specs/password-reset-and-account-recovery/spec.md, requirement "The reset email is
 * sent through controls that never become an oracle"), at the mailer level:
 *
 * - "A demo login cannot send mail"
 * - "The kill switch and the allowlist apply"
 * - "A provider failure is invisible to the caller"
 *
 * ## Production symbols expected (none exists yet)
 *
 * ```ts
 * // apps/api/src/identity/recovery-mailer.ts
 * export type ResetEmailAdmission =
 *   | { readonly admitted: false }
 *   | {
 *       readonly admitted: true;
 *       // Starts the detached send of `PasswordResetEmail { link, expiryText: '30 minutes' }`
 *       // to the admitted address and returns at once (void). A rejection of the sender is
 *       // swallowed, counted and logged as `provider_failure`.
 *       send(link: string): void;
 *     };
 * export interface RecoveryMailer {
 *   admitResetEmail(input: {
 *     readonly address: string; // canonical
 *     readonly userId: string;
 *     readonly tenantIds: readonly string[]; // every membership tenant of the user
 *     readonly ipKey: string; // the normalized key of client-ip-key.ts
 *   }): Promise<ResetEmailAdmission>; // never rejects for a refusal
 *   drain(): Promise<void>; // resolves when every started send has settled
 * }
 * export function createRecoveryMailer(deps: {
 *   readonly disabledTenantIds: readonly string[];
 *   readonly capStore: EmailCapStore; // email-tenant-gate.ts
 *   readonly sender: EmailSender;
 *   readonly recipientKeySecret: string;
 *   readonly killSwitch?: boolean;
 *   // Domains of EMAIL_RECIPIENT_DOMAIN_ALLOWLIST. Undefined: no allowlist is applied.
 *   // Defined, even empty: `isRecipientDomainAllowed(address, list)` decides.
 *   readonly recipientDomainAllowlist?: readonly string[];
 * }): RecoveryMailer;
 * ```
 *
 * `isRecipientDomainAllowed(address, allowedDomains)` is exported from
 * `packages/auth/src/identity/email/email-allowlist.ts` and re-exported from `@tayzu/auth`.
 *
 * Telemetry: `catalog.security.recovery_email_suppressed` (WARN) with
 * `tayzu.identity.email.template` = `password_reset`, `tayzu.identity.recovery.suppression` (one
 * of `kill_switch`, `recipient_domain_blocked`, `tenants_email_disabled`, `provider_failure`) and
 * `tayzu.identity.user.id`; an allowlist refusal also emits
 * `catalog.security.email_recipient_blocked` with the template. A failed send adds one to the
 * counter `tayzu.identity.recovery_emails` with `tayzu.identity.email.outcome` = `failed`.
 * No signal carries an address.
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
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EmailCapStore } from './email-tenant-gate.js';
import { recipientKey } from './recipient-key.js';
import {
  createRecoveryMailer,
  type RecoveryMailer,
  type ResetEmailAdmission,
} from './recovery-mailer.js';

const SUPPRESSED = 'catalog.security.recovery_email_suppressed';
const BLOCKED = 'catalog.security.email_recipient_blocked';
const RECOVERY_EMAILS = 'tayzu.identity.recovery_emails';
const HMAC_SECRET = 'recovery-mailer-test-only-secret-0123456789-abcdef';
const LINK = 'https://app.example.test/reset-password#reset=marker-id-1&token=marker-token-7f3a';
const ALLOWED_DOMAIN = 'allowed.example';

interface FakeStore extends EmailCapStore {
  readonly consumed: { readonly scope: string; readonly key: string }[];
}

/** Every bucket has room; the caps are the subject of task 5.4. */
function roomyStore(): FakeStore {
  const consumed: FakeStore['consumed'] = [];
  return {
    consumed,
    consume(scope, key) {
      consumed.push({ scope, key });
      return Promise.resolve();
    },
  };
}

function fullStore(): EmailCapStore {
  return { consume: () => Promise.reject(new AuthRateLimitedError(3600)) };
}

function newAddress(domain = ALLOWED_DOMAIN): string {
  return `person-${randomUUID()}@${domain}`;
}

function newTenant(): string {
  return `tenant-${randomUUID()}`;
}

function input(
  overrides: Partial<{
    address: string;
    userId: string;
    tenantIds: readonly string[];
  }> = {},
) {
  return {
    address: newAddress(),
    userId: `user-${randomUUID()}`,
    tenantIds: [newTenant()],
    ipKey: '203.0.113.7',
    ...overrides,
  };
}

function admittedOf(
  admission: ResetEmailAdmission,
): Extract<ResetEmailAdmission, { admitted: true }> {
  if (!admission.admitted) {
    throw new Error('expected the request to be admitted');
  }
  return admission;
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

afterEach(() => {
  vi.restoreAllMocks();
});

async function eventsNamed(name: string) {
  await harness.forceFlush();
  return harness.logExporter.getFinishedLogRecords().filter((record) => record.eventName === name);
}

async function everySignal(): Promise<string> {
  await harness.forceFlush();
  return JSON.stringify([
    harness.logExporter.getFinishedLogRecords().map((r) => [r.eventName, r.attributes, r.body]),
    harness.metricExporter
      .getMetrics()
      .flatMap((m) => m.scopeMetrics)
      .flatMap((s) => s.metrics)
      .map((metric) => [metric.descriptor.name, metric.dataPoints.map((p) => p.attributes)]),
  ]);
}

function mailerWith(overrides: Partial<Parameters<typeof createRecoveryMailer>[0]> = {}): {
  mailer: RecoveryMailer;
  sender: ReturnType<typeof createRecordingEmailSender>;
  store: FakeStore;
} {
  const sender = createRecordingEmailSender();
  const store = roomyStore();
  const mailer = createRecoveryMailer({
    disabledTenantIds: [],
    capStore: store,
    sender,
    recipientKeySecret: HMAC_SECRET,
    ...overrides,
  });
  return { mailer, sender, store };
}

function deferred() {
  let resolve: () => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('Scenario: A demo login cannot send mail (044 task 5.3)', () => {
  it('a user whose only tenant is disabled is suppressed: nothing reaches the sender', async () => {
    const disabledTenant = newTenant();
    const { mailer, sender } = mailerWith({ disabledTenantIds: [disabledTenant] });
    const request = input({ tenantIds: [disabledTenant] });

    const admission = await mailer.admitResetEmail(request);
    await mailer.drain();

    expect(admission).toEqual({ admitted: false });
    expect(sender.sent).toHaveLength(0);
    const records = await eventsNamed(SUPPRESSED);
    expect(records).toHaveLength(1);
    expect(records[0]?.severityText).toBe('WARN');
    expect(records[0]?.attributes['tayzu.identity.email.template']).toBe('password_reset');
    expect(records[0]?.attributes['tayzu.identity.recovery.suppression']).toBe(
      'tenants_email_disabled',
    );
    expect(records[0]?.attributes['tayzu.identity.user.id']).toBe(request.userId);
    expect(await everySignal()).not.toContain(request.address);
  });

  it('every tenant of a user with several tenants on the list is suppressed too', async () => {
    const [a, b] = [newTenant(), newTenant()];
    const { mailer, sender } = mailerWith({ disabledTenantIds: [a, b] });

    const admission = await mailer.admitResetEmail(input({ tenantIds: [a, b] }));

    expect(admission.admitted).toBe(false);
    expect(sender.sent).toHaveLength(0);
  });

  it('one enabled tenant is enough: the request passes and the mail is sent', async () => {
    const disabledTenant = newTenant();
    const { mailer, sender } = mailerWith({ disabledTenantIds: [disabledTenant] });
    const request = input({ tenantIds: [disabledTenant, newTenant()] });

    const admission = admittedOf(await mailer.admitResetEmail(request));
    admission.send(LINK);
    await mailer.drain();

    expect(sender.sent).toEqual([
      {
        to: request.address,
        template: { kind: 'PasswordResetEmail', link: LINK, expiryText: '30 minutes' },
      },
    ]);
    expect(await eventsNamed(SUPPRESSED)).toHaveLength(0);
  });
});

describe('Scenario: The kill switch and the allowlist apply (044 task 5.3)', () => {
  it('the kill switch refuses with the reason kill_switch and sends nothing', async () => {
    const { mailer, sender } = mailerWith({ killSwitch: true });
    const request = input();

    const admission = await mailer.admitResetEmail(request);
    await mailer.drain();

    expect(admission).toEqual({ admitted: false });
    expect(sender.sent).toHaveLength(0);
    const records = await eventsNamed(SUPPRESSED);
    expect(records).toHaveLength(1);
    expect(records[0]?.attributes['tayzu.identity.recovery.suppression']).toBe('kill_switch');
    expect(records[0]?.attributes['tayzu.identity.email.template']).toBe('password_reset');
    expect(await eventsNamed(BLOCKED)).toHaveLength(0);
    expect(await everySignal()).not.toContain(request.address);
  });

  it('a recipient domain off the allowlist is refused with recipient_domain_blocked and both events', async () => {
    const { mailer, sender } = mailerWith({ recipientDomainAllowlist: [ALLOWED_DOMAIN] });
    const request = input({ address: newAddress('blocked-marker.example') });

    const admission = await mailer.admitResetEmail(request);
    await mailer.drain();

    expect(admission).toEqual({ admitted: false });
    expect(sender.sent).toHaveLength(0);
    const suppressed = await eventsNamed(SUPPRESSED);
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]?.attributes['tayzu.identity.recovery.suppression']).toBe(
      'recipient_domain_blocked',
    );
    const blocked = await eventsNamed(BLOCKED);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.attributes['tayzu.identity.email.template']).toBe('password_reset');
    const signals = await everySignal();
    expect(signals).not.toContain(request.address);
    expect(signals).not.toContain('blocked-marker');
  });

  it('a recipient on the allowlist (any case, with spaces) passes', async () => {
    const { mailer } = mailerWith({ recipientDomainAllowlist: [ALLOWED_DOMAIN] });

    const admission = await mailer.admitResetEmail(
      input({ address: ` Person@${ALLOWED_DOMAIN.toUpperCase()} ` }),
    );

    expect(admission.admitted).toBe(true);
  });

  it('an empty allowlist refuses every domain, like the wrapper', async () => {
    const { mailer } = mailerWith({ recipientDomainAllowlist: [] });

    expect((await mailer.admitResetEmail(input())).admitted).toBe(false);
  });
});

describe('Scenario: A provider failure is invisible to the caller (044 task 5.3)', () => {
  it('a sender that fails with the address in its error does not break the caller and leaks nowhere', async () => {
    const request = input();
    const failing: EmailSender = {
      send: (to) => Promise.reject(new Error(`provider refused ${to}`)),
    };
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn')];
    const { mailer } = mailerWith({ sender: failing });

    const admission = admittedOf(await mailer.admitResetEmail(request));
    const returned: unknown = admission.send(LINK);

    expect(returned).toBeUndefined();
    await expect(mailer.drain()).resolves.toBeUndefined();
    const records = await eventsNamed(SUPPRESSED);
    expect(records).toHaveLength(1);
    expect(records[0]?.attributes['tayzu.identity.recovery.suppression']).toBe('provider_failure');
    expect(records[0]?.attributes['tayzu.identity.email.template']).toBe('password_reset');
    expect(records[0]?.attributes['tayzu.identity.user.id']).toBe(request.userId);
    const signals = await everySignal();
    expect(signals).not.toContain(request.address);
    expect(signals).not.toContain(request.address.split('@')[0] ?? request.address);
    expect(signals).not.toContain(LINK);
    expect(signals).not.toContain('marker-token-7f3a');
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(request.address);
    }
  });

  it('a failed send is counted on tayzu.identity.recovery_emails with the outcome failed', async () => {
    const failing: EmailSender = { send: () => Promise.reject(new Error('down')) };
    const { mailer } = mailerWith({ sender: failing });

    admittedOf(await mailer.admitResetEmail(input())).send(LINK);
    await mailer.drain();
    await harness.forceFlush();

    const points: { readonly attributes: Readonly<Record<string, unknown>> }[] = [];
    for (const resourceMetrics of harness.metricExporter.getMetrics()) {
      for (const scopeMetrics of resourceMetrics.scopeMetrics) {
        for (const metric of scopeMetrics.metrics) {
          if (metric.descriptor.name === RECOVERY_EMAILS) {
            for (const point of metric.dataPoints) {
              points.push({ attributes: point.attributes });
            }
          }
        }
      }
    }
    expect(
      points.some(
        (point) =>
          point.attributes['tayzu.identity.email.outcome'] === 'failed' &&
          point.attributes['tayzu.identity.email.template'] === 'password_reset',
      ),
    ).toBe(true);
  });
});

describe('Cases of the admission (044 task 5.3)', () => {
  it('the order is kill switch, allowlist, tenants', async () => {
    const disabledTenant = newTenant();
    const request = input({
      address: newAddress('blocked-marker.example'),
      tenantIds: [disabledTenant],
    });
    const reasonWith = async (killSwitch: boolean, allowlist: readonly string[]) => {
      await harness.reset();
      const { mailer } = mailerWith({
        disabledTenantIds: [disabledTenant],
        killSwitch,
        recipientDomainAllowlist: allowlist,
      });
      const admission = await mailer.admitResetEmail(request);
      expect(admission.admitted).toBe(false);
      const records = await eventsNamed(SUPPRESSED);
      expect(records).toHaveLength(1);
      return records[0]?.attributes['tayzu.identity.recovery.suppression'];
    };

    // All three refuse: the first control in the order names the reason.
    expect(await reasonWith(true, [ALLOWED_DOMAIN])).toBe('kill_switch');
    // Kill switch off: the allowlist is next.
    expect(await reasonWith(false, [ALLOWED_DOMAIN])).toBe('recipient_domain_blocked');
    // The domain allowed: the tenants are last.
    expect(await reasonWith(false, ['blocked-marker.example'])).toBe('tenants_email_disabled');
  });

  it('a refused admission returns no send handle and throws nothing', async () => {
    const disabledTenant = newTenant();
    const refusing = [
      mailerWith({ killSwitch: true }),
      mailerWith({ recipientDomainAllowlist: [] }),
      mailerWith({ disabledTenantIds: [disabledTenant] }),
    ];

    for (const { mailer } of refusing) {
      const admission = await mailer.admitResetEmail(input({ tenantIds: [disabledTenant] }));
      expect(admission.admitted).toBe(false);
      expect('send' in admission).toBe(false);
    }
  });

  it('the controls that need no counter consume no bucket when they refuse', async () => {
    const disabledTenant = newTenant();
    const refusing = [
      mailerWith({ killSwitch: true }),
      mailerWith({ recipientDomainAllowlist: [] }),
      mailerWith({ disabledTenantIds: [disabledTenant] }),
    ];

    for (const { mailer, store } of refusing) {
      await mailer.admitResetEmail(input({ tenantIds: [disabledTenant] }));
      expect(store.consumed).toHaveLength(0);
    }
  });

  it('a refusal never rejects even when the cap store would throw', async () => {
    const { mailer } = mailerWith({ killSwitch: true, capStore: fullStore() });

    await expect(mailer.admitResetEmail(input())).resolves.toEqual({ admitted: false });
  });

  it('send is detached: it returns before a slow sender settles', async () => {
    const gate = deferred();
    const calls: { to: string; template: EmailTemplate }[] = [];
    const slow: EmailSender = {
      send: async (to, template) => {
        calls.push({ to, template });
        await gate.promise;
      },
    };
    const { mailer } = mailerWith({ sender: slow });

    const admission = admittedOf(await mailer.admitResetEmail(input()));
    const returned: unknown = admission.send(LINK);

    expect(returned).toBeUndefined();
    gate.resolve();
    await mailer.drain();
    expect(calls).toHaveLength(1);
  });

  it('drain() waits for an in-flight send', async () => {
    const gate = deferred();
    let sendStarted = false;
    const slow: EmailSender = {
      send: async () => {
        sendStarted = true;
        await gate.promise;
      },
    };
    const { mailer } = mailerWith({ sender: slow });
    admittedOf(await mailer.admitResetEmail(input())).send(LINK);
    await vi.waitFor(() => {
      expect(sendStarted).toBe(true);
    });

    let drained = false;
    const draining = mailer.drain().then(() => {
      drained = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(drained).toBe(false);

    gate.resolve();
    await draining;
    expect(drained).toBe(true);
  });

  it('drain() with nothing in flight resolves at once, and after a failing send too', async () => {
    const failing: EmailSender = { send: () => Promise.reject(new Error('down')) };
    const idle = mailerWith();
    const broken = mailerWith({ sender: failing });

    await expect(idle.mailer.drain()).resolves.toBeUndefined();
    admittedOf(await broken.mailer.admitResetEmail(input())).send(LINK);
    await expect(broken.mailer.drain()).resolves.toBeUndefined();
  });
});

/*
 * Task 5.4 (design D5, "Caps"): `admitResetEmail`, second half. After the controls that need no
 * counter, the caps run through the shared cap store, narrowest first: recipient (scope
 * `reset_recipient`, key = `recipientKey(address, secret)`), IP (scope `reset_ip`, key = the
 * normalized `ipKey` as given) and global (scope `reset_global`, one constant key). A refusal
 * (the store rejects with `AuthRateLimitedError`) returns `{ admitted: false }`, throws nothing and
 * is logged once as `catalog.security.recovery_email_suppressed` with the reason `recipient_cap`,
 * `ip_cap` or `global_cap`, the template and the user id, and no address.
 */
function storeRefusing(scope: string): FakeStore {
  const consumed: FakeStore['consumed'] = [];
  return {
    consumed,
    consume(consumedScope, key) {
      consumed.push({ scope: consumedScope, key });
      return consumedScope === scope
        ? Promise.reject(new AuthRateLimitedError(3600))
        : Promise.resolve();
    },
  };
}

describe('Scenario: A per-recipient cap is silent (044 task 5.4)', () => {
  it('a full recipient bucket sends nothing and logs recipient_cap with no address', async () => {
    const request = input();
    const { mailer, sender } = mailerWith({ capStore: storeRefusing('reset_recipient') });

    const admission = await mailer.admitResetEmail(request);
    await mailer.drain();

    expect(admission).toEqual({ admitted: false });
    expect('send' in admission).toBe(false);
    expect(sender.sent).toHaveLength(0);
    const records = await eventsNamed(SUPPRESSED);
    expect(records).toHaveLength(1);
    expect(records[0]?.severityText).toBe('WARN');
    expect(records[0]?.attributes['tayzu.identity.recovery.suppression']).toBe('recipient_cap');
    expect(records[0]?.attributes['tayzu.identity.email.template']).toBe('password_reset');
    expect(records[0]?.attributes['tayzu.identity.user.id']).toBe(request.userId);
    expect(await eventsNamed(BLOCKED)).toHaveLength(0);
    expect(await everySignal()).not.toContain(request.address);
  });

  it('the recipient bucket is keyed by the HMAC of the canonical address, never the address', async () => {
    const request = input();
    const { mailer, store } = mailerWith();

    await mailer.admitResetEmail(request);

    const recipient = store.consumed.filter((entry) => entry.scope === 'reset_recipient');
    expect(recipient).toEqual([
      { scope: 'reset_recipient', key: recipientKey(request.address, HMAC_SECRET) },
    ]);
    expect(recipient[0]?.key).not.toContain(request.address);
  });
});

describe('Scenario: A narrower refusal consumes no wider bucket (044 task 5.4)', () => {
  it('a recipient refusal consumes neither the IP nor the global bucket', async () => {
    const store = storeRefusing('reset_recipient');
    const { mailer, sender } = mailerWith({ capStore: store });

    const admission = await mailer.admitResetEmail(input());
    await mailer.drain();

    expect(admission.admitted).toBe(false);
    expect(sender.sent).toHaveLength(0);
    expect(store.consumed.map((entry) => entry.scope)).toEqual(['reset_recipient']);
  });

  it('an IP refusal consumes the recipient bucket but not the global one', async () => {
    const store = storeRefusing('reset_ip');
    const { mailer, sender } = mailerWith({ capStore: store });

    const admission = await mailer.admitResetEmail(input());
    await mailer.drain();

    expect(admission.admitted).toBe(false);
    expect(sender.sent).toHaveLength(0);
    expect(store.consumed.map((entry) => entry.scope)).toEqual(['reset_recipient', 'reset_ip']);
  });
});

describe('Cases of the caps (044 task 5.4)', () => {
  it('the order is recipient, IP, global', async () => {
    const { mailer, store } = mailerWith();

    const admission = await mailer.admitResetEmail(input());

    expect(admission.admitted).toBe(true);
    expect(store.consumed.map((entry) => entry.scope)).toEqual([
      'reset_recipient',
      'reset_ip',
      'reset_global',
    ]);
  });

  it('a global refusal has spent one recipient and one IP unit and mails nothing', async () => {
    const store = storeRefusing('reset_global');
    const { mailer, sender } = mailerWith({ capStore: store });

    const admission = await mailer.admitResetEmail(input());
    await mailer.drain();

    expect(admission.admitted).toBe(false);
    expect(sender.sent).toHaveLength(0);
    expect(store.consumed.map((entry) => entry.scope)).toEqual([
      'reset_recipient',
      'reset_ip',
      'reset_global',
    ]);
  });

  it('the global bucket is one constant key that is not the address or the IP', async () => {
    const { mailer, store } = mailerWith();
    const first = input({});
    const second = { ...input({}), ipKey: '198.51.100.9' };

    await mailer.admitResetEmail(first);
    await mailer.admitResetEmail(second);

    const keys = store.consumed
      .filter((entry) => entry.scope === 'reset_global')
      .map((entry) => entry.key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).not.toContain(first.address);
    expect(keys[0]).not.toContain(first.ipKey);
  });

  it('the IP bucket key is the normalized /64 form of 1.6 and never reaches a signal', async () => {
    const ipKey = '2001:db8:1:2::/64';
    const request = { ...input(), ipKey };
    for (const refusing of ['reset_ip', 'reset_global'] as const) {
      await harness.reset();
      const store = storeRefusing(refusing);
      const { mailer } = mailerWith({ capStore: store });

      await mailer.admitResetEmail(request);

      expect(store.consumed.filter((entry) => entry.scope === 'reset_ip')).toEqual([
        { scope: 'reset_ip', key: ipKey },
      ]);
      const signals = await everySignal();
      expect(signals).not.toContain('2001:db8');
      expect(signals).not.toContain(request.address);
    }
  });

  it('the suppressions are logged with recipient_cap, ip_cap and global_cap and no address', async () => {
    const cases = [
      ['reset_recipient', 'recipient_cap'],
      ['reset_ip', 'ip_cap'],
      ['reset_global', 'global_cap'],
    ] as const;
    for (const [scope, reason] of cases) {
      await harness.reset();
      const request = input();
      const { mailer } = mailerWith({ capStore: storeRefusing(scope) });

      const admission = await mailer.admitResetEmail(request);

      expect(admission).toEqual({ admitted: false });
      const records = await eventsNamed(SUPPRESSED);
      expect(records).toHaveLength(1);
      expect(records[0]?.attributes['tayzu.identity.recovery.suppression']).toBe(reason);
      expect(records[0]?.attributes['tayzu.identity.email.template']).toBe('password_reset');
      expect(records[0]?.attributes['tayzu.identity.user.id']).toBe(request.userId);
      const signals = await everySignal();
      expect(signals).not.toContain(request.address);
      expect(signals).not.toContain(request.ipKey);
    }
  });

  it('a request refused before the counters consumes no cap (kill switch, allowlist, tenants)', async () => {
    const { mailer, store } = mailerWith({ killSwitch: true });

    await mailer.admitResetEmail(input());

    expect(store.consumed).toHaveLength(0);
  });
});

/*
 * Task 5.5 (design D5 "Notices", D8): the mailer's notice path. A notice goes through the kill
 * switch, then the disabled-tenant list (suppressed when every tenant of the recipient is
 * disabled), then the `recovery_notice_recipient` cap (key = `recipientKey(address, secret)`),
 * then the send. It never throws into the operation that triggered it. A suppression is logged
 * once as `catalog.security.recovery_email_suppressed` with the template name and the reason.
 *
 * Scenarios (specs/password-reset-and-account-recovery/spec.md, requirements "Recovery notices
 * are fixed and carry no link" and "Recovery notices are capped and suppressible"), mailer level:
 *
 * - "A full notice bucket suppresses and logs"
 * - "A failing provider never breaks the operation"
 *
 * ## Production symbols expected (added to `RecoveryMailer`, apps/api/src/identity/recovery-mailer.ts)
 *
 * ```ts
 * export type RecoveryNoticeKind =
 *   | 'PasswordChangedNotice' | 'MfaChangedNotice' | 'MfaResetNotice' | 'AccountCreatedNotice';
 * interface RecoveryMailer {
 *   // Never rejects. Resolves once the notice was sent, suppressed or failed.
 *   sendNotice(input: {
 *     readonly kind: RecoveryNoticeKind; // the `kind` of the EmailTemplate, no other field
 *     readonly address: string; // canonical, read from the auth schema
 *     readonly userId: string;
 *     readonly tenantIds: readonly string[]; // every membership tenant of the user
 *   }): Promise<void>;
 * }
 * ```
 *
 * The template sent is exactly `{ kind }`. The telemetry template name is `password_changed`,
 * `mfa_changed`, `mfa_reset` or `account_created`. A failed send counts on
 * `tayzu.identity.recovery_emails` with the outcome `failed` and logs `provider_failure`.
 */
const NOTICE_SCOPE = 'recovery_notice_recipient';

function noticeInput(overrides: Partial<{ tenantIds: readonly string[] }> = {}) {
  return {
    kind: 'PasswordChangedNotice' as const,
    address: newAddress(),
    userId: `user-${randomUUID()}`,
    tenantIds: [newTenant()],
    ...overrides,
  };
}

describe('Scenario: A full notice bucket suppresses and logs (044 task 5.5)', () => {
  it('a full recipient notice bucket sends nothing, resolves, and logs recipient_cap with no address', async () => {
    const request = noticeInput();
    const { mailer, sender } = mailerWith({ capStore: storeRefusing(NOTICE_SCOPE) });

    await expect(mailer.sendNotice(request)).resolves.toBeUndefined();
    await mailer.drain();

    expect(sender.sent).toHaveLength(0);
    const records = await eventsNamed(SUPPRESSED);
    expect(records).toHaveLength(1);
    expect(records[0]?.severityText).toBe('WARN');
    expect(records[0]?.attributes['tayzu.identity.recovery.suppression']).toBe('recipient_cap');
    expect(records[0]?.attributes['tayzu.identity.email.template']).toBe('password_changed');
    expect(records[0]?.attributes['tayzu.identity.user.id']).toBe(request.userId);
    expect(await everySignal()).not.toContain(request.address);
  });

  it('the notice bucket is keyed by the HMAC of the address and no reset bucket is consumed', async () => {
    const request = noticeInput();
    const { mailer, sender, store } = mailerWith();

    await mailer.sendNotice(request);
    await mailer.drain();

    expect(store.consumed).toEqual([
      { scope: NOTICE_SCOPE, key: recipientKey(request.address, HMAC_SECRET) },
    ]);
    expect(sender.sent).toEqual([
      { to: request.address, template: { kind: 'PasswordChangedNotice' } },
    ]);
    expect(await eventsNamed(SUPPRESSED)).toHaveLength(0);
  });

  it('each notice kind is sent as its own link-less template and logs its own template name', async () => {
    const cases = [
      ['PasswordChangedNotice', 'password_changed'],
      ['MfaChangedNotice', 'mfa_changed'],
      ['MfaResetNotice', 'mfa_reset'],
      ['AccountCreatedNotice', 'account_created'],
    ] as const;
    for (const [kind, name] of cases) {
      await harness.reset();
      const request = {
        ...noticeInput(),
        kind,
        creatingTenantId: newTenant(),
      };
      const ok = mailerWith();
      await ok.mailer.sendNotice(request);
      await ok.mailer.drain();
      expect(ok.sender.sent).toEqual([{ to: request.address, template: { kind } }]);

      const full = mailerWith({ capStore: storeRefusing(NOTICE_SCOPE) });
      await full.mailer.sendNotice(request);
      const records = await eventsNamed(SUPPRESSED);
      expect(records).toHaveLength(1);
      expect(records[0]?.attributes['tayzu.identity.email.template']).toBe(name);
    }
  });
});

describe('Scenario: A failing provider never breaks the operation (notice level, 044 task 5.5)', () => {
  it('a sender that fails with the address in its error does not reject and leaks nowhere', async () => {
    const request = noticeInput();
    const failing: EmailSender = {
      send: (to) => Promise.reject(new Error(`provider refused ${to}`)),
    };
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn')];
    const { mailer } = mailerWith({ sender: failing });

    await expect(mailer.sendNotice(request)).resolves.toBeUndefined();
    await expect(mailer.drain()).resolves.toBeUndefined();

    const records = await eventsNamed(SUPPRESSED);
    expect(records).toHaveLength(1);
    expect(records[0]?.attributes['tayzu.identity.recovery.suppression']).toBe('provider_failure');
    expect(records[0]?.attributes['tayzu.identity.email.template']).toBe('password_changed');
    expect(records[0]?.attributes['tayzu.identity.user.id']).toBe(request.userId);
    const signals = await everySignal();
    expect(signals).not.toContain(request.address);
    expect(signals).not.toContain(request.address.split('@')[0] ?? request.address);
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(request.address);
    }
  });

  it('a failed notice is counted on tayzu.identity.recovery_emails with the outcome failed', async () => {
    const failing: EmailSender = { send: () => Promise.reject(new Error('down')) };
    const { mailer } = mailerWith({ sender: failing });

    await mailer.sendNotice({ ...noticeInput(), kind: 'MfaResetNotice' });
    await mailer.drain();
    await harness.forceFlush();

    const attributes: Readonly<Record<string, unknown>>[] = [];
    for (const resourceMetrics of harness.metricExporter.getMetrics()) {
      for (const scopeMetrics of resourceMetrics.scopeMetrics) {
        for (const metric of scopeMetrics.metrics) {
          if (metric.descriptor.name === RECOVERY_EMAILS) {
            for (const point of metric.dataPoints) attributes.push(point.attributes);
          }
        }
      }
    }
    expect(
      attributes.some(
        (a) =>
          a['tayzu.identity.email.outcome'] === 'failed' &&
          a['tayzu.identity.email.template'] === 'mfa_reset',
      ),
    ).toBe(true);
  });

  it('a cap store that fails for another reason does not reject and sends nothing', async () => {
    const broken: EmailCapStore = { consume: () => Promise.reject(new Error('database down')) };
    const { mailer, sender } = mailerWith({ capStore: broken });

    await expect(mailer.sendNotice(noticeInput())).resolves.toBeUndefined();
    await mailer.drain();

    expect(sender.sent).toHaveLength(0);
  });

  it('a synchronously throwing sender does not reject either', async () => {
    const throwing: EmailSender = {
      send: () => {
        throw new Error('sync failure');
      },
    };
    const { mailer } = mailerWith({ sender: throwing });

    await expect(mailer.sendNotice(noticeInput())).resolves.toBeUndefined();
    await expect(mailer.drain()).resolves.toBeUndefined();
  });
});

describe('Cases of the notice path (044 task 5.5)', () => {
  it('the kill switch suppresses with kill_switch and consumes no bucket', async () => {
    const request = noticeInput();
    const { mailer, sender, store } = mailerWith({ killSwitch: true });

    await expect(mailer.sendNotice(request)).resolves.toBeUndefined();
    await mailer.drain();

    expect(sender.sent).toHaveLength(0);
    expect(store.consumed).toHaveLength(0);
    const records = await eventsNamed(SUPPRESSED);
    expect(records).toHaveLength(1);
    expect(records[0]?.attributes['tayzu.identity.recovery.suppression']).toBe('kill_switch');
    expect(records[0]?.attributes['tayzu.identity.email.template']).toBe('password_changed');
    expect(await everySignal()).not.toContain(request.address);
  });

  it('every tenant disabled suppresses with tenants_email_disabled; one enabled tenant passes', async () => {
    const [a, b] = [newTenant(), newTenant()];
    const blocked = mailerWith({ disabledTenantIds: [a, b] });
    await blocked.mailer.sendNotice(noticeInput({ tenantIds: [a, b] }));
    await blocked.mailer.drain();

    expect(blocked.sender.sent).toHaveLength(0);
    expect(blocked.store.consumed).toHaveLength(0);
    const records = await eventsNamed(SUPPRESSED);
    expect(records).toHaveLength(1);
    expect(records[0]?.attributes['tayzu.identity.recovery.suppression']).toBe(
      'tenants_email_disabled',
    );

    const passing = mailerWith({ disabledTenantIds: [a] });
    await passing.mailer.sendNotice(noticeInput({ tenantIds: [a, b] }));
    await passing.mailer.drain();
    expect(passing.sender.sent).toHaveLength(1);
  });

  it('the order is kill switch, tenants, recipient cap', async () => {
    const disabledTenant = newTenant();
    const reasonWith = async (killSwitch: boolean, disabledTenantIds: readonly string[]) => {
      await harness.reset();
      const { mailer } = mailerWith({
        killSwitch,
        disabledTenantIds,
        capStore: storeRefusing(NOTICE_SCOPE),
      });
      await mailer.sendNotice(noticeInput({ tenantIds: [disabledTenant] }));
      const records = await eventsNamed(SUPPRESSED);
      expect(records).toHaveLength(1);
      return records[0]?.attributes['tayzu.identity.recovery.suppression'];
    };

    expect(await reasonWith(true, [disabledTenant])).toBe('kill_switch');
    expect(await reasonWith(false, [disabledTenant])).toBe('tenants_email_disabled');
    expect(await reasonWith(false, [])).toBe('recipient_cap');
  });

  it('a notice never consumes the reset buckets, and a reset admission never the notice one', async () => {
    const { mailer, store } = mailerWith();

    await mailer.sendNotice(noticeInput());
    expect(store.consumed.map((entry) => entry.scope)).toEqual([NOTICE_SCOPE]);

    store.consumed.length = 0;
    await mailer.admitResetEmail(input());
    expect(store.consumed.map((entry) => entry.scope)).not.toContain(NOTICE_SCOPE);
  });

  it('a full notice bucket does not stop a reset email to the same recipient', async () => {
    const request = input();
    const { mailer } = mailerWith({ capStore: storeRefusing(NOTICE_SCOPE) });

    const admission = await mailer.admitResetEmail(request);

    expect(admission.admitted).toBe(true);
  });
});

/*
 * Task 5.6 (design D5 "Notices", Q20): the account-created notice path. The kill switch, then the
 * disabled-tenant list, then the per-tenant cap of the CREATING tenant (scope
 * `account_created_tenant`, key = the creating tenant id), then the global cap (scope
 * `account_created_global`, one constant key), then the recipient cap
 * (`recovery_notice_recipient`), then the send. Never throws. Only the `AccountCreatedNotice` kind
 * consumes the two extra buckets.
 *
 * Scenario (specs/password-reset-and-account-recovery/spec.md, requirement "Recovery notices are
 * capped and suppressible"), mailer level:
 *
 * - "The account-created notice has its own tenant and global caps"
 *
 * ## Production symbols expected (a new field on `RecoveryMailer.sendNotice`'s input)
 *
 * ```ts
 * // apps/api/src/identity/recovery-mailer.ts
 * sendNotice(input: {
 *   ...existing fields;
 *   // The tenant of the admin that created the account: the key of the per-tenant cap. Read only
 *   // for kind `AccountCreatedNotice`; distinct from `tenantIds`, the recipient's memberships.
 *   readonly creatingTenantId?: string;
 * }): Promise<void>;
 * ```
 *
 * Suppression reasons: `tenant_cap` and `global_cap` (added to the `Suppression` union).
 */
const TENANT_SCOPE = 'account_created_tenant';
const GLOBAL_SCOPE = 'account_created_global';

function storeRefusingScopes(scopes: readonly string[]): FakeStore {
  const consumed: FakeStore['consumed'] = [];
  return {
    consumed,
    consume(consumedScope, key) {
      consumed.push({ scope: consumedScope, key });
      return scopes.includes(consumedScope)
        ? Promise.reject(new AuthRateLimitedError(3600))
        : Promise.resolve();
    },
  };
}

function accountCreatedInput(
  overrides: Partial<{ creatingTenantId: string; tenantIds: readonly string[] }> = {},
) {
  return {
    kind: 'AccountCreatedNotice' as const,
    address: newAddress(),
    userId: `user-${randomUUID()}`,
    tenantIds: [newTenant()],
    creatingTenantId: newTenant(),
    ...overrides,
  };
}

describe('Scenario: The account-created notice has its own tenant and global caps (044 task 5.6)', () => {
  it('a tenant at its cap sends nothing, resolves, and logs tenant_cap with no address', async () => {
    const request = accountCreatedInput();
    const { mailer, sender } = mailerWith({ capStore: storeRefusingScopes([TENANT_SCOPE]) });

    await expect(mailer.sendNotice(request)).resolves.toBeUndefined();
    await mailer.drain();

    expect(sender.sent).toHaveLength(0);
    const records = await eventsNamed(SUPPRESSED);
    expect(records).toHaveLength(1);
    expect(records[0]?.severityText).toBe('WARN');
    expect(records[0]?.attributes['tayzu.identity.recovery.suppression']).toBe('tenant_cap');
    expect(records[0]?.attributes['tayzu.identity.email.template']).toBe('account_created');
    expect(records[0]?.attributes['tayzu.identity.user.id']).toBe(request.userId);
    const signals = await everySignal();
    expect(signals).not.toContain(request.address);
    expect(signals).not.toContain(request.creatingTenantId);
  });

  it('a platform at its global cap sends nothing for another tenant and logs global_cap', async () => {
    const request = accountCreatedInput();
    const { mailer, sender } = mailerWith({ capStore: storeRefusingScopes([GLOBAL_SCOPE]) });

    await expect(mailer.sendNotice(request)).resolves.toBeUndefined();
    await mailer.drain();

    expect(sender.sent).toHaveLength(0);
    const records = await eventsNamed(SUPPRESSED);
    expect(records).toHaveLength(1);
    expect(records[0]?.attributes['tayzu.identity.recovery.suppression']).toBe('global_cap');
    expect(records[0]?.attributes['tayzu.identity.email.template']).toBe('account_created');
    expect(await everySignal()).not.toContain(request.address);
  });

  it('both creations succeed in sequence: tenant A is capped, then tenant B hits the global cap', async () => {
    const tenantA = newTenant();
    const tenantB = newTenant();
    const consumed: FakeStore['consumed'] = [];
    const store: FakeStore = {
      consumed,
      consume(scope, key) {
        consumed.push({ scope, key });
        const refuse = (scope === TENANT_SCOPE && key === tenantA) || scope === GLOBAL_SCOPE;
        return refuse ? Promise.reject(new AuthRateLimitedError(3600)) : Promise.resolve();
      },
    };
    const { mailer, sender } = mailerWith({ capStore: store });

    await expect(
      mailer.sendNotice(accountCreatedInput({ creatingTenantId: tenantA })),
    ).resolves.toBeUndefined();
    await expect(
      mailer.sendNotice(accountCreatedInput({ creatingTenantId: tenantB })),
    ).resolves.toBeUndefined();
    await mailer.drain();

    expect(sender.sent).toHaveLength(0);
    const reasons = (await eventsNamed(SUPPRESSED)).map(
      (record) => record.attributes['tayzu.identity.recovery.suppression'],
    );
    expect(reasons).toEqual(['tenant_cap', 'global_cap']);
  });
});

describe('Cases of the account-created notice path (044 task 5.6)', () => {
  it('the order is kill switch, tenants, tenant cap, global cap, recipient cap', async () => {
    const disabledTenant = newTenant();
    const reasonWith = async (
      killSwitch: boolean,
      disabledTenantIds: readonly string[],
      refusing: readonly string[],
    ) => {
      await harness.reset();
      const { mailer } = mailerWith({
        killSwitch,
        disabledTenantIds,
        capStore: storeRefusingScopes(refusing),
      });
      await mailer.sendNotice(accountCreatedInput({ tenantIds: [disabledTenant] }));
      const records = await eventsNamed(SUPPRESSED);
      expect(records).toHaveLength(1);
      return records[0]?.attributes['tayzu.identity.recovery.suppression'];
    };
    const all = [TENANT_SCOPE, GLOBAL_SCOPE, NOTICE_SCOPE];

    expect(await reasonWith(true, [disabledTenant], all)).toBe('kill_switch');
    expect(await reasonWith(false, [disabledTenant], all)).toBe('tenants_email_disabled');
    expect(await reasonWith(false, [], all)).toBe('tenant_cap');
    expect(await reasonWith(false, [], [GLOBAL_SCOPE, NOTICE_SCOPE])).toBe('global_cap');
    expect(await reasonWith(false, [], [NOTICE_SCOPE])).toBe('recipient_cap');
  });

  it('the buckets are consumed in the order tenant, global, recipient, keyed as designed', async () => {
    const request = accountCreatedInput();
    const { mailer, sender, store } = mailerWith();

    await mailer.sendNotice(request);
    await mailer.drain();

    expect(store.consumed.map((entry) => entry.scope)).toEqual([
      TENANT_SCOPE,
      GLOBAL_SCOPE,
      NOTICE_SCOPE,
    ]);
    expect(store.consumed[0]?.key).toBe(request.creatingTenantId);
    expect(store.consumed[2]?.key).toBe(recipientKey(request.address, HMAC_SECRET));
    expect(store.consumed[1]?.key).not.toContain(request.address);
    expect(store.consumed[1]?.key).not.toBe(request.creatingTenantId);
    expect(sender.sent).toEqual([
      { to: request.address, template: { kind: 'AccountCreatedNotice' } },
    ]);
    expect(await eventsNamed(SUPPRESSED)).toHaveLength(0);
  });

  it('the global bucket is one constant key across tenants', async () => {
    const { mailer, store } = mailerWith();

    await mailer.sendNotice(accountCreatedInput());
    await mailer.sendNotice(accountCreatedInput());

    const keys = store.consumed
      .filter((entry) => entry.scope === GLOBAL_SCOPE)
      .map((entry) => entry.key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('a tenant at its cap does not consume the global bucket', async () => {
    const store = storeRefusingScopes([TENANT_SCOPE]);
    const { mailer } = mailerWith({ capStore: store });

    await mailer.sendNotice(accountCreatedInput());

    expect(store.consumed.map((entry) => entry.scope)).toEqual([TENANT_SCOPE]);
  });

  it('the global cap refusing consumes no recipient bucket', async () => {
    const store = storeRefusingScopes([GLOBAL_SCOPE]);
    const { mailer } = mailerWith({ capStore: store });

    await mailer.sendNotice(accountCreatedInput());

    expect(store.consumed.map((entry) => entry.scope)).toEqual([TENANT_SCOPE, GLOBAL_SCOPE]);
  });

  it('the kill switch and all-tenants-disabled consume no account-created bucket', async () => {
    const disabledTenant = newTenant();
    const killed = mailerWith({ killSwitch: true });
    const disabled = mailerWith({ disabledTenantIds: [disabledTenant] });

    await killed.mailer.sendNotice(accountCreatedInput());
    await disabled.mailer.sendNotice(accountCreatedInput({ tenantIds: [disabledTenant] }));

    expect(killed.store.consumed).toHaveLength(0);
    expect(disabled.store.consumed).toHaveLength(0);
  });

  it('the other notice kinds never consume the account-created buckets', async () => {
    const { mailer, store } = mailerWith();

    await mailer.sendNotice({ ...accountCreatedInput(), kind: 'PasswordChangedNotice' });

    expect(store.consumed.map((entry) => entry.scope)).toEqual([NOTICE_SCOPE]);
  });

  it('the suppressions are logged with tenant_cap and global_cap and no address', async () => {
    const cases = [
      [TENANT_SCOPE, 'tenant_cap'],
      [GLOBAL_SCOPE, 'global_cap'],
    ] as const;
    for (const [scope, reason] of cases) {
      await harness.reset();
      const request = accountCreatedInput();
      const { mailer } = mailerWith({ capStore: storeRefusingScopes([scope]) });

      await mailer.sendNotice(request);

      const records = await eventsNamed(SUPPRESSED);
      expect(records).toHaveLength(1);
      expect(records[0]?.attributes['tayzu.identity.recovery.suppression']).toBe(reason);
      expect(records[0]?.attributes['tayzu.identity.email.template']).toBe('account_created');
      expect(records[0]?.attributes['tayzu.identity.user.id']).toBe(request.userId);
      const signals = await everySignal();
      expect(signals).not.toContain(request.address);
      expect(signals).not.toContain(request.creatingTenantId);
    }
  });

  it('a cap store failing for another reason never rejects and sends nothing', async () => {
    const broken: EmailCapStore = { consume: () => Promise.reject(new Error('database down')) };
    const { mailer, sender } = mailerWith({ capStore: broken });

    await expect(mailer.sendNotice(accountCreatedInput())).resolves.toBeUndefined();
    await mailer.drain();

    expect(sender.sent).toHaveLength(0);
  });
});
