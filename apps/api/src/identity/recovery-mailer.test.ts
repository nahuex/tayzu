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
