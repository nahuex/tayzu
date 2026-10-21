/**
 * Task 12.4 of openspec/changes/044-password-reset-and-account-recovery (design D15 "Observability
 * contract": "No signal carries an email, a token, a link, a password, a backup code, an IP ...; an
 * unknown address produces no identifier" and "Correlation for forensics").
 *
 * Scenarios (verbatim, `specs/password-reset-and-account-recovery/spec.md`):
 *
 * #### Scenario: No sensitive value reaches telemetry
 * - WHEN a reset is requested and completed for `marker-user@example.com` with a marker token and
 *   password
 * - THEN none of those strings appears in any exported span, metric, log attribute or response
 *
 * #### Scenario: The token never leaves the email
 * - WHEN a reset is requested and completed
 * - THEN neither the token nor the link appears in a response, a log record, a span or a metric
 *   attribute
 *
 * #### Scenario: An unknown address leaves no identifier
 * - WHEN a reset is requested for an address with no account
 * - THEN the only signals are counters and a suppression event with the reason `unknown_address`,
 *   carrying no user id
 *
 * #### Scenario: Audit and denial events carry the trace id
 * - WHEN a reset is completed, a confirm is denied and an MFA reset is performed
 * - THEN each of the audit and denial log records carries the trace id of its request or operation
 *
 * Task 12.4 Verify adds the case "a provider failure containing the recipient address leaks it
 * nowhere", and for "The token never leaves the email" the non-sending sender's record.
 *
 * ## Harness
 *
 * The real server (`createApp`, injected requests, never a listener) over the in-memory telemetry
 * harness, as `password-reset-events.int.test.ts` does. Every request carries a fresh random
 * `x-forwarded-for`, `Origin` and `x-csrf-token: orpc`. Every seeded value (emails, ids, IPs, the
 * marker password) is random per run. Every app gets roomy caps, so the shared global buckets never
 * interfere. The token and the link are read from the recording sender (the only place they are
 * allowed to be); the non-sending sender is wrapped so the test learns the token while the
 * non-sending sender itself is what is inspected afterwards.
 *
 * ## What is and is not asserted
 *
 * - "Anywhere" is the serialization of every exported span (name, attributes, events, status,
 *   links), every metric point (name, attributes) and every log record (event name, body,
 *   attributes), and of the response (status, headers, body).
 * - The reset id is a lookup key and part of the link, not a listed secret: only the token, the
 *   link (whole and in its fragment form) and, for the marker scenario, the address and the
 *   password are searched for.
 * - Trace correlation is asserted as: the audit or denial record has a valid non-zero trace id equal
 *   to the trace id of the span of its route or operation (the span names of design D15).
 *
 * ## Production symbols expected
 *
 * Nothing new: the signals of design D15 (`identity.password_reset.request`,
 * `identity.password_reset.confirm`, `identity.mfa.reset`, `catalog.audit.password_reset_requested`,
 * `catalog.audit.password_reset_completed`, `catalog.audit.mfa_reset`,
 * `catalog.security.password_reset_denied`, `catalog.security.recovery_email_suppressed`), emitted
 * inside the active span of the route or operation (`identity/mfa-reset.ts`, `server.ts`).
 */
import { randomBytes, randomInt, randomUUID } from 'node:crypto';

import { registration, type TelemetryTestHarness } from './__fixtures__/link-telemetry.js';

import { createNonSendingEmailSender, createRecordingEmailSender } from '@tayzu/auth';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bootstrapTestTenant,
  testAppPool,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { harnessPools, type HarnessPools } from './__fixtures__/pools.js';
import { createMfaResetService } from './identity/mfa-reset.js';
import { createResetTokenStore } from './identity/reset-token-store.js';
import { createWithUserLock } from './identity/user-lock.js';
import { createApp, type App } from './server.js';

const ORIGIN = 'https://app.tayzu.test';
const LINK_BASE_URL = 'https://app.tayzu.test';
const REQUEST_PATH = '/v1/auth/password-reset/request';
const CONFIRM_PATH = '/v1/auth/password-reset/confirm';
const HMAC_SECRET = 'recovery-telemetry-test-only-secret-0123456789-abcdef';

const SPAN_REQUEST = 'identity.password_reset.request';
const SPAN_CONFIRM = 'identity.password_reset.confirm';
const SPAN_MFA_RESET = 'identity.mfa.reset';
const EVENT_REQUESTED = 'catalog.audit.password_reset_requested';
const EVENT_COMPLETED = 'catalog.audit.password_reset_completed';
const EVENT_MFA_RESET = 'catalog.audit.mfa_reset';
const EVENT_DENIED = 'catalog.security.password_reset_denied';
const EVENT_SUPPRESSED = 'catalog.security.recovery_email_suppressed';

const USER_ID = 'tayzu.identity.user.id';
const SUPPRESSION = 'tayzu.identity.recovery.suppression';
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const ZERO_TRACE_ID = '0'.repeat(32);

type Attributes = Readonly<Record<string, unknown>>;

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function registeredHarness(): TelemetryTestHarness {
  if ('error' in registration) {
    throw new Error(
      `the telemetry test harness failed to register while the module graph loaded: ${String(registration.error)}`,
      { cause: registration.error },
    );
  }
  return registration.harness;
}

interface Answer {
  readonly status: number;
  readonly body: unknown;
  /** Status, headers and body: what a caller of the route can see. */
  readonly everything: string;
}

interface Signals {
  readonly spans: readonly {
    readonly name: string;
    readonly traceId: string;
    readonly attributes: Attributes;
  }[];
  readonly logs: readonly {
    readonly name: string;
    readonly traceId: string | undefined;
    readonly attributes: Attributes;
  }[];
  readonly points: readonly { readonly name: string; readonly attributes: Attributes }[];
  /** Every exported span, metric point and log record, serialized. */
  readonly serialized: string;
}

interface PasswordResetLink {
  readonly link: string;
  readonly id: string;
  readonly token: string;
}

describe('Recovery telemetry carries no sensitive data and correlates by trace id (task 12.4)', () => {
  let harness: TelemetryTestHarness;
  let pools: HarnessPools;
  let authPool: Pool;
  const apps: App[] = [];
  let open: App;
  let openSender: ReturnType<typeof createRecordingEmailSender>;

  const roomy = { max: 100_000, windowSeconds: 3600 };

  async function makeApp(sender: { send: (to: string, template: never) => Promise<void> }) {
    const email = {
      sender,
      invitationLinkBaseUrl: LINK_BASE_URL,
      passwordResetLinkBaseUrl: LINK_BASE_URL,
      passwordResetMinResponseMs: 0,
      disabledTenantIds: [] as string[],
      killSwitch: false,
      recipientKeySecret: HMAC_SECRET,
      tenantCap: roomy,
      recipientCap: { max: 100_000, windowSeconds: 86_400 },
      passwordResetRecipientCap: roomy,
      passwordResetIpCap: roomy,
      passwordResetGlobalCap: { max: 100_000, windowSeconds: 3600 },
      accountCreatedNoticeGlobalCap: { max: 100_000, windowSeconds: 86_400 },
    };
    const app = await createApp({
      appPool: pools.appPool,
      authPool,
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ORIGIN],
      mountIdentityRoutes: true,
      identityTokenHmacSecret: HMAC_SECRET,
      ...{ email },
    });
    apps.push(app);
    return app;
  }

  /** The range service reports nothing as breached (decoys only). */
  function stubCleanRangeService(): void {
    vi.stubGlobal('fetch', (): Promise<Response> => {
      return Promise.resolve(
        new Response('0000000000000000000000000000000000A:3\r\n', { status: 200 }),
      );
    });
  }

  beforeAll(async () => {
    harness = registeredHarness();
    pools = await harnessPools();
    authPool = pools.authPool;
    openSender = createRecordingEmailSender();
    open = await makeApp(openSender);
  }, 120_000);

  beforeEach(async () => {
    stubCleanRangeService();
    await harness.reset();
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    for (const app of apps) await app.close();
  }, 60_000);

  // ---- reading the signals ---------------------------------------------------------------

  async function signals(): Promise<Signals> {
    await harness.forceFlush();
    const spans = harness.spanExporter.getFinishedSpans().map((span) => ({
      name: span.name,
      traceId: span.spanContext().traceId,
      attributes: { ...span.attributes },
    }));
    const logRecords = [...harness.logExporter.getFinishedLogRecords()];
    const logs = logRecords.map((record) => ({
      name: record.eventName ?? '',
      traceId: record.spanContext?.traceId,
      attributes: { ...record.attributes },
    }));
    const points: { name: string; attributes: Attributes }[] = [];
    for (const resourceMetrics of harness.metricExporter.getMetrics()) {
      for (const scopeMetrics of resourceMetrics.scopeMetrics) {
        for (const metric of scopeMetrics.metrics) {
          for (const point of metric.dataPoints) {
            points.push({
              name: metric.descriptor.name,
              attributes: { ...point.attributes },
            });
          }
        }
      }
    }
    const serialized = JSON.stringify({
      spans: harness.spanExporter.getFinishedSpans().map((span) => ({
        name: span.name,
        attributes: span.attributes,
        events: span.events,
        status: span.status,
        links: span.links,
      })),
      points,
      logs: logRecords.map((record) => ({
        eventName: record.eventName,
        body: record.body,
        attributes: record.attributes,
      })),
    });
    return { spans, logs, points, serialized };
  }

  function eventsNamed(all: Signals, name: string): Attributes[] {
    return all.logs.filter((record) => record.name === name).map((record) => record.attributes);
  }

  function onlyLog(all: Signals, name: string): Signals['logs'][number] {
    const found = all.logs.filter((record) => record.name === name);
    expect(found, `exactly one "${name}"`).toHaveLength(1);
    const [first] = found;
    if (first === undefined) throw new Error('unreachable');
    return first;
  }

  function onlySpan(all: Signals, name: string): Signals['spans'][number] {
    const found = all.spans.filter((span) => span.name === name);
    expect(found, `exactly one "${name}" span`).toHaveLength(1);
    const [first] = found;
    if (first === undefined) throw new Error('unreachable');
    return first;
  }

  // ---- accounts and routes ---------------------------------------------------------------

  async function createAccount(
    email: string = `marker-user-${randomUUID()}@example.com`,
  ): Promise<{ email: string; userId: string }> {
    const suffix = randomUUID();
    const tenant = await bootstrapTestTenant(open.auth, {
      pool: testAppPool(),
      name: 'Recovery Telemetry User',
      email,
      password: TEST_PASSWORD,
      organizationName: `Recovery Telemetry Org ${suffix}`,
      organizationSlug: `recovtel-${suffix}`,
      ip: randomIp(),
    });
    return { email, userId: tenant.userId };
  }

  async function answerOf(response: Awaited<ReturnType<App['app']['inject']>>): Promise<Answer> {
    await Promise.resolve();
    let body: unknown;
    try {
      body = response.json();
    } catch {
      body = response.body;
    }
    return {
      status: response.statusCode,
      body,
      everything: JSON.stringify({
        status: response.statusCode,
        headers: response.headers,
        body: response.body,
      }),
    };
  }

  async function postRequest(app: App, email: string): Promise<Answer> {
    return answerOf(
      await app.app.inject({
        method: 'POST',
        url: REQUEST_PATH,
        headers: {
          'content-type': 'application/json',
          origin: ORIGIN,
          'x-csrf-token': 'orpc',
          'x-forwarded-for': randomIp(),
        },
        payload: JSON.stringify({ email }),
      }),
    );
  }

  async function postConfirm(
    app: App,
    fields: { id: string; token: string; newPassword: string },
  ): Promise<Answer> {
    return answerOf(
      await app.app.inject({
        method: 'POST',
        url: CONFIRM_PATH,
        headers: {
          'content-type': 'application/json',
          origin: ORIGIN,
          'x-csrf-token': 'orpc',
          'x-forwarded-for': randomIp(),
        },
        payload: JSON.stringify(fields),
      }),
    );
  }

  /** The reset links in the recording sender's record for `address`. */
  function linksTo(
    sender: ReturnType<typeof createRecordingEmailSender>,
    address: string,
  ): PasswordResetLink[] {
    const links: PasswordResetLink[] = [];
    for (const message of sender.sent) {
      if (message.to !== address || message.template.kind !== 'PasswordResetEmail') continue;
      const fragment = new URLSearchParams(new URL(message.template.link).hash.slice(1));
      links.push({
        link: message.template.link,
        id: fragment.get('reset') ?? '',
        token: fragment.get('token') ?? '',
      });
    }
    return links;
  }

  async function requestedLink(
    app: App,
    sender: ReturnType<typeof createRecordingEmailSender>,
    address: string,
  ): Promise<{ answer: Answer; link: PasswordResetLink }> {
    const answer = await postRequest(app, address);
    expect(answer.status).toBe(200);
    await vi.waitFor(() => {
      expect(linksTo(sender, address)).toHaveLength(1);
    });
    const [link] = linksTo(sender, address);
    if (link === undefined) throw new Error('unreachable');
    expect(link.token, 'precondition: the email carries a token').not.toBe('');
    return { answer, link };
  }

  function newPassword(): string {
    return `Marker-Passphrase-${randomBytes(6).toString('hex')}-Fine-77!`;
  }

  function expectNoneOf(where: string, haystack: string, needles: readonly string[]): void {
    for (const needle of needles) {
      expect(needle.length, 'a needle is never empty').toBeGreaterThan(0);
      expect(
        haystack.includes(needle),
        `${where} must not contain "${needle.slice(0, 12)}..."`,
      ).toBe(false);
    }
  }

  // ---- scenarios -------------------------------------------------------------------------

  it('No sensitive value reaches telemetry: the address, the token, the link and the password appear in no span, metric, log or response of a requested and completed reset', async () => {
    const address = `marker-user-${randomUUID()}@example.com`;
    const account = await createAccount(address);
    const password = newPassword();
    await harness.reset();

    const { answer: requested, link } = await requestedLink(open, openSender, account.email);
    const completed = await postConfirm(open, {
      id: link.id,
      token: link.token,
      newPassword: password,
    });
    expect(completed.status).toBe(200);
    const all = await signals();

    // The run did emit what the scenario is about, so an empty harness cannot pass vacuously.
    onlySpan(all, SPAN_REQUEST);
    onlySpan(all, SPAN_CONFIRM);
    onlyLog(all, EVENT_COMPLETED);

    const localPart = address.split('@')[0] ?? '';
    const markers = [
      address,
      localPart,
      link.token,
      link.link,
      `reset=${link.id}&token=${link.token}`,
      password,
    ];
    expectNoneOf('a span, metric or log record', all.serialized, markers);
    expectNoneOf('the request response', requested.everything, markers);
    expectNoneOf('the confirm response', completed.everything, markers);
  }, 120_000);

  it('The token never leaves the email: neither the token nor the link is in a response, a log record, a span or a metric attribute', async () => {
    const account = await createAccount();
    await harness.reset();

    const { answer: requested, link } = await requestedLink(open, openSender, account.email);
    const completed = await postConfirm(open, {
      id: link.id,
      token: link.token,
      newPassword: newPassword(),
    });
    expect(completed.status).toBe(200);
    const all = await signals();

    onlySpan(all, SPAN_REQUEST);
    onlySpan(all, SPAN_CONFIRM);
    const secrets = [link.token, link.link, `reset=${link.id}&token=${link.token}`];
    expectNoneOf('a span, metric or log record', all.serialized, secrets);
    expectNoneOf('the request response', requested.everything, secrets);
    expectNoneOf('the confirm response', completed.everything, secrets);
    for (const attributes of [
      ...all.spans.map((span) => span.attributes),
      ...all.points.map((point) => point.attributes),
      ...all.logs.map((record) => record.attributes),
    ]) {
      expectNoneOf('an attribute set', JSON.stringify(attributes), secrets);
    }
  }, 120_000);

  it('The token never leaves the email: the non-sending sender keeps neither the token nor the link', async () => {
    let learned: string[] = [];
    const nonSending = createNonSendingEmailSender();
    // Only the wrapper sees the message (to learn the token); `nonSending` is what is inspected.
    const tee = {
      send: (to: string, template: never): Promise<void> => {
        const link = (template as { link?: unknown }).link;
        if (typeof link === 'string') learned = [...learned, link];
        return nonSending.send(to, template);
      },
    };
    const app = await makeApp(tee);
    const account = await createAccount();
    await harness.reset();

    const requested = await postRequest(app, account.email);
    expect(requested.status).toBe(200);
    await vi.waitFor(() => {
      expect(learned).toHaveLength(1);
    });
    const [link] = learned;
    const fragment = new URLSearchParams(new URL(link ?? '').hash.slice(1));
    const token = fragment.get('token') ?? '';
    const id = fragment.get('reset') ?? '';
    expect(token, 'precondition: the discarded email carried a token').not.toBe('');

    const completed = await postConfirm(app, { id, token, newPassword: newPassword() });
    expect(completed.status).toBe(200);
    const all = await signals();

    const secrets = [token, link ?? '', `reset=${id}&token=${token}`];
    expect(Object.keys(nonSending), 'the non-sending sender holds no state').toEqual(['send']);
    expectNoneOf(
      'the non-sending sender record',
      JSON.stringify(nonSending, (_key, value: unknown) =>
        typeof value === 'function' ? value.toString() : value,
      ),
      secrets,
    );
    expectNoneOf('a span, metric or log record', all.serialized, secrets);
    expectNoneOf('the request response', requested.everything, secrets);
    expectNoneOf('the confirm response', completed.everything, secrets);
  }, 120_000);

  it('An unknown address leaves no identifier: only counters and one suppression event with the reason unknown_address, no user id on any signal', async () => {
    const address = `ghost-${randomUUID()}@example.com`;

    const answer = await postRequest(open, address);
    expect(answer.status).toBe(200);
    const all = await signals();

    expect(
      all.logs.map((record) => record.name),
      'the only log record is the suppression event',
    ).toEqual([EVENT_SUPPRESSED]);
    const suppressed = onlyLog(all, EVENT_SUPPRESSED);
    expect(suppressed.attributes).toMatchObject({ [SUPPRESSION]: 'unknown_address' });
    expect(suppressed.attributes).not.toHaveProperty(USER_ID);
    expect(eventsNamed(all, EVENT_REQUESTED), 'no audit event without a token').toEqual([]);

    expect(all.points.length, 'the counters were recorded').toBeGreaterThan(0);
    for (const point of all.points) {
      expect(point.attributes, `metric ${point.name} carries no user id`).not.toHaveProperty(
        USER_ID,
      );
    }
    for (const span of all.spans) {
      expect(span.attributes, `span ${span.name} carries no user id`).not.toHaveProperty(USER_ID);
    }
    expectNoneOf('a span, metric or log record', all.serialized, [
      address,
      address.split('@')[0] ?? '',
    ]);
  }, 60_000);

  describe('Audit and denial events carry the trace id', () => {
    function expectTraceOf(all: Signals, eventName: string, spanName: string): void {
      const record = onlyLog(all, eventName);
      const span = onlySpan(all, spanName);
      expect(record.traceId, `${eventName} carries a trace id`).toMatch(TRACE_ID_PATTERN);
      expect(record.traceId).not.toBe(ZERO_TRACE_ID);
      expect(record.traceId, `${eventName} carries the trace id of "${spanName}"`).toBe(
        span.traceId,
      );
    }

    it('a requested reset: the audit record carries the trace id of the request', async () => {
      const account = await createAccount();
      await harness.reset();

      await requestedLink(open, openSender, account.email);

      expectTraceOf(await signals(), EVENT_REQUESTED, SPAN_REQUEST);
    }, 60_000);

    it('a completed reset: the audit record carries the trace id of the confirm request', async () => {
      const account = await createAccount();
      const { link } = await requestedLink(open, openSender, account.email);
      await harness.reset();

      const completed = await postConfirm(open, {
        id: link.id,
        token: link.token,
        newPassword: newPassword(),
      });

      expect(completed.status).toBe(200);
      expectTraceOf(await signals(), EVENT_COMPLETED, SPAN_CONFIRM);
    }, 60_000);

    it('a denied confirm: the denial record carries the trace id of the confirm request', async () => {
      const account = await createAccount();
      const store = createResetTokenStore({
        authPool,
        withUserLock: createWithUserLock(authPool),
      });
      const issued = await store.issue(account.userId);
      await harness.reset();

      const denied = await postConfirm(open, {
        id: issued.id,
        token: randomToken(),
        newPassword: newPassword(),
      });

      expect(denied.status).toBe(404);
      expectTraceOf(await signals(), EVENT_DENIED, SPAN_CONFIRM);
    }, 60_000);

    describe('an MFA reset', () => {
      const service = (): ReturnType<typeof createMfaResetService> =>
        createMfaResetService({
          authPool,
          notices: { send: () => Promise.resolve('sent' as const) },
        });

      async function seedTarget(): Promise<{ tenantId: string; userId: string }> {
        const tenantId = `org-${randomUUID()}`;
        await authPool.query(
          'insert into auth.organization (id, name, slug, created_at) values ($1, $2, $3, now())',
          [tenantId, 'Org', `slug-${tenantId}`],
        );
        const userId = `usr-${randomUUID()}`;
        await authPool.query(
          `insert into auth."user" (id, name, email, email_verified, created_at, updated_at, two_factor_enabled)
           values ($1, 'User', $2, true, now(), now(), true)`,
          [userId, `recovtel-m-${randomUUID()}@example.test`],
        );
        const factorId = `tf-${randomUUID()}`;
        await authPool.query(
          `insert into auth.two_factor (id, secret, backup_codes, user_id, verified, failed_verification_count)
           values ($1, $2, $3, $4, true, 0)`,
          [factorId, `enc-secret-${factorId}`, `enc-codes-${factorId}`, userId],
        );
        await authPool.query(
          `insert into auth.member (id, organization_id, user_id, role, created_at)
           values ($1, $2, $3, 'member', now())`,
          [`mem-${randomUUID()}`, tenantId, userId],
        );
        return { tenantId, userId };
      }

      it('the admin form: the audit record carries the trace id of the operation', async () => {
        const { tenantId, userId } = await seedTarget();
        await harness.reset();

        await service().resetAdmin({
          tenantId,
          actorId: `adm-${randomUUID()}`,
          userId,
          reason: 'lost_both_factors',
        });

        expectTraceOf(await signals(), EVENT_MFA_RESET, SPAN_MFA_RESET);
      }, 60_000);

      it('the operator form: the audit record carries the trace id of the operation', async () => {
        const { tenantId, userId } = await seedTarget();
        await harness.reset();

        await service().resetOperator({
          tenantId,
          operatorId: `gh:${String(randomInt(1_000_000, 9_999_999))}`,
          approverId: `gh:${String(randomInt(1_000_000, 9_999_999))}`,
          userId,
        });

        expectTraceOf(await signals(), EVENT_MFA_RESET, SPAN_MFA_RESET);
      }, 60_000);
    });
  });

  it('a provider failure containing the recipient address leaks it nowhere', async () => {
    const failing = {
      send: (to: string): Promise<void> =>
        Promise.reject(
          new Error(`provider rejected ${to}`, { cause: new Error(`mailbox ${to} unavailable`) }),
        ),
    };
    const app = await makeApp(failing);
    const account = await createAccount();
    await harness.reset();

    const answer = await postRequest(app, account.email);
    expect(answer.status).toBe(200);
    await vi.waitFor(async () => {
      const seen = await signals();
      expect(
        eventsNamed(seen, EVENT_SUPPRESSED).filter(
          (event) => event[SUPPRESSION] === 'provider_failure',
        ),
      ).toHaveLength(1);
    });
    const all = await signals();

    const localPart = account.email.split('@')[0] ?? '';
    expectNoneOf('a span, metric or log record', all.serialized, [account.email, localPart]);
    expectNoneOf('the response', answer.everything, [account.email, localPart]);
    for (const span of all.spans) {
      expectNoneOf(`span ${span.name}`, JSON.stringify(span.attributes), [account.email]);
    }
  }, 120_000);
});
