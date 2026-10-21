/**
 * Task 12.2 of openspec/changes/044-password-reset-and-account-recovery (design D15 "Observability
 * contract": spans, metrics, log events and closed value sets; D2 "Order of work, confirm route";
 * D5 and D10).
 *
 * Scenario (verbatim, `specs/password-reset-and-account-recovery/spec.md`, requirement "Recovery
 * operations are logged and exported without sensitive data"):
 *
 * #### Scenario: Declared telemetry is emitted
 * - WHEN each operation of this capability runs once, successfully and with each denial reason,
 *   under an in-memory exporter
 * - THEN every declared span, metric and log event is observed with its required attributes
 *
 * Task 12.2 Verify: that scenario for the request route (each suppression reason), the confirm route
 * (each denial reason and each confirm outcome, a rejection before the factor step carrying no
 * `tayzu.identity.reset.mfa`) and the MFA reset (admin and operator forms, each refusal reason).
 *
 * ## Harness
 *
 * The real server (`createApp`, injected requests, never a listener) over the in-memory telemetry
 * harness; one request or operation per case, with `harness.reset()` before it, so the signals read
 * afterwards are that operation's. Every request carries a fresh random `x-forwarded-for`, `Origin`
 * and `x-csrf-token: orpc`. Every seeded value (emails, slugs, ids, IPs) is random per run. The
 * global reset-email bucket has one constant key shared by every test file: every app here gets a
 * roomy cap for it except the one app whose subject is `global_cap`.
 *
 * ## What is and is not asserted (the design leaves these open, so they are not pinned)
 *
 * - `tayzu.identity.user.id` is conditional on `password_reset_denied` and on
 *   `recovery_email_suppressed`: it is asserted absent only where the design says so (an unknown
 *   address, a token that matched no row) and present only where the account is known.
 * - The request outcome of `provider_failure` and `token_issue_failure` (decided after admission) and
 *   the denial reason of an enrolled user's request without a factor are not asserted.
 * - `tayzu.identity.reset.mfa` on the confirm span is asserted present on a completion and absent on
 *   a rejection before the factor step; it is not asserted on a refusal after that step.
 * - `tenant_cap` belongs to the account-created notice, which the request route cannot produce.
 * - The mapping of denial reasons to confirm outcomes follows the value sets of D15:
 *   `rejected` (malformed_request, csrf_rejected, origin_rejected, not_found, expired,
 *   token_mismatch, not_eligible, consume_conflict, attempts_exhausted), `factor_required`
 *   (factor_invalid, factor_state_inconsistent), `policy_refused` (policy_violation, breached) and
 *   `breach_check_unavailable`. `attempts_exhausted` is the fifth failure that burns the token.
 *
 * ## Production symbols expected
 *
 * - The request route (`server.ts`, `identity/password-reset-request.ts`) runs in a span
 *   `identity.password_reset.request`, records `tayzu.identity.password_reset_requests` with
 *   `tayzu.identity.reset.request_outcome` (`issued`, `ineligible`, `suppressed`), emits
 *   `catalog.audit.password_reset_requested` (with the user id) only when a token was issued, and
 *   emits `catalog.security.recovery_email_suppressed` with the template `password_reset` and
 *   the reason for `unknown_address`, `no_credential_account`, `banned`, `disabled_everywhere` and
 *   `no_membership` too (the mailer already emits the admission reasons).
 * - The recovery mailer records `tayzu.identity.recovery_emails` with outcome `sent` after a
 *   successful send (reset email and notices), not only `failed`.
 * - The confirm route runs in a span `identity.password_reset.confirm`, sets
 *   `tayzu.identity.reset.mfa` (`not_enrolled`, `totp`, `backup_code`) once the factor step ran,
 *   records `tayzu.identity.password_reset_confirms` with `tayzu.identity.reset.confirm_outcome`,
 *   emits `catalog.security.password_reset_denied` with `tayzu.identity.reset.denial_reason` for
 *   every refusal and `catalog.audit.password_reset_completed` (user id, `reset.mfa`,
 *   `sessions.revoked` as an integer) on a completion.
 * - The MFA reset service already emits its signals (`identity/mfa-reset.ts`): those cases are
 *   expected to pass on arrival.
 */
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';

import { registration, type TelemetryTestHarness } from './__fixtures__/link-telemetry.js';

import { createRecordingEmailSender } from '@tayzu/auth';
import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bootstrapTestTenant,
  seedUserRow,
  testAppPool,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { enrollTotp, signInWithTotp } from './__fixtures__/fresh-mfa.js';
import { harnessPools, type HarnessPools } from './__fixtures__/pools.js';
import { createMfaResetService, type MfaResetService } from './identity/mfa-reset.js';
import { createResetTokenStore } from './identity/reset-token-store.js';
import { createWithUserLock } from './identity/user-lock.js';
import { createApp, type App } from './server.js';

const ORIGIN = 'https://app.tayzu.test';
const LINK_BASE_URL = 'https://app.tayzu.test';
const REQUEST_PATH = '/v1/auth/password-reset/request';
const CONFIRM_PATH = '/v1/auth/password-reset/confirm';
const HMAC_SECRET = 'reset-events-test-only-secret-0123456789-abcdef';
const NEW_PASSWORD = 'Another-Perfectly-Fine-Passphrase-77!';

const SPAN_REQUEST = 'identity.password_reset.request';
const SPAN_CONFIRM = 'identity.password_reset.confirm';
const SPAN_MFA_RESET = 'identity.mfa.reset';
const METRIC_REQUESTS = 'tayzu.identity.password_reset_requests';
const METRIC_CONFIRMS = 'tayzu.identity.password_reset_confirms';
const METRIC_MFA_RESETS = 'tayzu.identity.mfa_resets';
const METRIC_EMAILS = 'tayzu.identity.recovery_emails';
const EVENT_REQUESTED = 'catalog.audit.password_reset_requested';
const EVENT_COMPLETED = 'catalog.audit.password_reset_completed';
const EVENT_MFA_RESET = 'catalog.audit.mfa_reset';
const EVENT_DENIED = 'catalog.security.password_reset_denied';
const EVENT_SUPPRESSED = 'catalog.security.recovery_email_suppressed';
const EVENT_SELF_DENIED = 'catalog.security.self_mfa_reset_denied';
const EVENT_CONFLICT = 'catalog.security.identity_conflict_refused';

const USER_ID = 'tayzu.identity.user.id';
const TENANT = 'tayzu.tenant.id';
const ACTOR_ID = 'tayzu.actor.id';
const OPERATOR_ID = 'tayzu.identity.operator.id';
const APPROVER_ID = 'tayzu.identity.approver.id';
const RESET_MFA = 'tayzu.identity.reset.mfa';
const REQUEST_OUTCOME = 'tayzu.identity.reset.request_outcome';
const CONFIRM_OUTCOME = 'tayzu.identity.reset.confirm_outcome';
const DENIAL_REASON = 'tayzu.identity.reset.denial_reason';
const SUPPRESSION = 'tayzu.identity.recovery.suppression';
const EMAIL_TEMPLATE = 'tayzu.identity.email.template';
const EMAIL_OUTCOME = 'tayzu.identity.email.outcome';
const SESSIONS_REVOKED = 'tayzu.identity.sessions.revoked';
const MFA_RESET_PATH = 'tayzu.identity.mfa_reset.path';
const MFA_RESET_REASON = 'tayzu.identity.mfa_reset.reason';
const CONFLICT_REASON = 'tayzu.identity.conflict.reason';

type Attributes = Readonly<Record<string, unknown>>;
type QueryFunction = (...args: unknown[]) => unknown;

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

function randomId(): string {
  return randomBytes(16).toString('base64url');
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function statementText(first: unknown): string {
  if (typeof first === 'string') return first;
  if (typeof first === 'object' && first !== null && 'text' in first) {
    return typeof first.text === 'string' ? first.text : '';
  }
  return '';
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
}

interface Signals {
  readonly spans: readonly Attributes[];
  readonly logs: readonly { readonly name: string; readonly attributes: Attributes }[];
  readonly points: readonly {
    readonly name: string;
    readonly attributes: Attributes;
    readonly value: number;
  }[];
}

describe('Declared telemetry is emitted (task 12.2)', () => {
  let harness: TelemetryTestHarness;
  let pools: HarnessPools;
  let authPool: Pool;
  const apps: App[] = [];
  let open: App;
  let openSender: ReturnType<typeof createRecordingEmailSender>;
  let failTokenInsert = false;
  let consumeConflictFor: string | undefined;

  const roomy = { max: 100_000, windowSeconds: 3600 };

  /** Fails the reset token's insert while `failTokenInsert` is on, and makes the consume of the
   *  armed token find nothing (another completion "won") by deleting the row first. */
  function instrumentedPool(pool: Pool): Pool {
    const run = async (target: Pool | PoolClient, args: unknown[]): Promise<unknown> => {
      const sql = statementText(args[0]);
      if (failTokenInsert && /insert\s+into\s+auth\.verification/i.test(sql)) {
        throw new Error('token store unavailable');
      }
      if (
        consumeConflictFor !== undefined &&
        /^\s*delete from auth\.verification where identifier = \$1\s*$/i.test(sql) &&
        Array.isArray(args[1]) &&
        args[1][0] === `password-reset:${consumeConflictFor}`
      ) {
        consumeConflictFor = undefined;
        await pool.query('delete from auth.verification where identifier = $1', args[1]);
      }
      return (target.query as QueryFunction).apply(target, args);
    };
    const wrapClient = (client: PoolClient): PoolClient =>
      new Proxy(client, {
        get(target, property): unknown {
          const value: unknown = Reflect.get(target, property, target);
          if (property === 'query') return (...args: unknown[]): unknown => run(target, args);
          return typeof value === 'function' ? (value as QueryFunction).bind(target) : value;
        },
      });
    return new Proxy(pool, {
      get(target, property): unknown {
        const value: unknown = Reflect.get(target, property, target);
        if (property === 'query') return (...args: unknown[]): unknown => run(target, args);
        if (property === 'connect') {
          return async (): Promise<PoolClient> => wrapClient(await target.connect());
        }
        return typeof value === 'function' ? (value as QueryFunction).bind(target) : value;
      },
    });
  }

  async function makeApp(
    sender: { send: (to: string, template: never) => Promise<void> },
    overrides: Record<string, unknown> = {},
    pool: Pool = authPool,
  ): Promise<App> {
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
      passwordResetGlobalCap: { max: 1_000_000, windowSeconds: 3600 },
      ...overrides,
    };
    const app = await createApp({
      appPool: pools.appPool,
      authPool: pool,
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
    stubCleanRangeService();
  }, 120_000);

  beforeEach(async () => {
    failTokenInsert = false;
    consumeConflictFor = undefined;
    stubCleanRangeService();
    await harness.reset();
  });

  afterEach(() => {
    failTokenInsert = false;
    consumeConflictFor = undefined;
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    for (const app of apps) await app.close();
  }, 60_000);

  // ---- reading the signals ---------------------------------------------------------------

  async function signals(): Promise<Signals> {
    await harness.forceFlush();
    const spans = harness.spanExporter.getFinishedSpans().map((span) => ({
      ...span.attributes,
      __name: span.name,
    }));
    const logs = [...harness.logExporter.getFinishedLogRecords()].map((record) => ({
      name: record.eventName ?? '',
      attributes: { ...record.attributes },
    }));
    const points: { name: string; attributes: Attributes; value: number }[] = [];
    for (const resourceMetrics of harness.metricExporter.getMetrics()) {
      for (const scopeMetrics of resourceMetrics.scopeMetrics) {
        for (const metric of scopeMetrics.metrics) {
          for (const point of metric.dataPoints) {
            const value: unknown = point.value;
            if (typeof value === 'number') {
              points.push({
                name: metric.descriptor.name,
                attributes: { ...point.attributes },
                value,
              });
            }
          }
        }
      }
    }
    return { spans, logs, points };
  }

  function spansNamed(all: Signals, name: string): Attributes[] {
    return all.spans.filter((span) => span['__name'] === name);
  }

  function eventsNamed(all: Signals, name: string): Attributes[] {
    return all.logs.filter((record) => record.name === name).map((record) => record.attributes);
  }

  function counted(all: Signals, name: string, where: Attributes): number {
    return all.points
      .filter(
        (point) =>
          point.name === name &&
          Object.entries(where).every(([key, value]) => point.attributes[key] === value),
      )
      .reduce((sum, point) => sum + point.value, 0);
  }

  /** The one event of `name`, failing with a readable message otherwise. */
  function onlyEvent(all: Signals, name: string): Attributes {
    const found = eventsNamed(all, name);
    expect(found, `exactly one "${name}"`).toHaveLength(1);
    const [first] = found;
    if (first === undefined) throw new Error('unreachable');
    return first;
  }

  function onlySpan(all: Signals, name: string): Attributes {
    const found = spansNamed(all, name);
    expect(found, `exactly one "${name}" span`).toHaveLength(1);
    const [first] = found;
    if (first === undefined) throw new Error('unreachable');
    return first;
  }

  // ---- accounts --------------------------------------------------------------------------

  async function createAccount(
    status: 'Active' | 'Disabled' = 'Active',
  ): Promise<{ email: string; userId: string; tenantId: string; cookie: string }> {
    const suffix = randomUUID();
    const email = `events044-${suffix}@example.test`;
    const tenant = await bootstrapTestTenant(open.auth, {
      pool: testAppPool(),
      name: 'Events 044 User',
      email,
      password: TEST_PASSWORD,
      organizationName: `Events 044 Org ${suffix}`,
      organizationSlug: `events044-${suffix}`,
      ip: randomIp(),
      ...(status === 'Disabled' ? { writeUserRow: false } : {}),
    });
    if (status === 'Disabled') {
      await seedUserRow(testAppPool(), {
        tenantId: tenant.organizationId,
        email,
        name: 'Events 044 User',
        status,
        portRole: 'admin',
      });
      const client = await testAppPool().connect();
      try {
        await client.query('begin');
        await client.query(`select set_config('app.tenant_id', $1, true)`, [tenant.organizationId]);
        await client.query(
          `update catalog_entity
              set spec_properties = jsonb_set(spec_properties, '{status}', '"Disabled"')
            where tenant_id = $1 and identifier = $2`,
          [tenant.organizationId, email],
        );
        await client.query('commit');
      } finally {
        client.release();
      }
    }
    return {
      email,
      userId: tenant.userId,
      tenantId: tenant.organizationId,
      cookie: tenant.cookie,
    };
  }

  function store() {
    return createResetTokenStore({ authPool, withUserLock: createWithUserLock(authPool) });
  }

  // ---- the request route -----------------------------------------------------------------

  async function postRequest(app: App, email: string, ip: string = randomIp()): Promise<Answer> {
    const response = await app.app.inject({
      method: 'POST',
      url: REQUEST_PATH,
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        'x-csrf-token': 'orpc',
        'x-forwarded-for': ip,
      },
      payload: JSON.stringify({ email }),
    });
    return { status: response.statusCode, body: response.json() };
  }

  function sentTo(sender: ReturnType<typeof createRecordingEmailSender>, address: string): number {
    return sender.sent.filter((message) => message.to === address).length;
  }

  describe('The request route', () => {
    it('an issued request: the span, the issued counter, the audit event with the user id and a sent reset email', async () => {
      const account = await createAccount();
      await harness.reset();

      const answer = await postRequest(open, account.email);
      expect(answer.status).toBe(200);
      await vi.waitFor(() => {
        expect(sentTo(openSender, account.email)).toBe(1);
      });
      const all = await signals();

      onlySpan(all, SPAN_REQUEST);
      expect(counted(all, METRIC_REQUESTS, { [REQUEST_OUTCOME]: 'issued' })).toBe(1);
      expect(onlyEvent(all, EVENT_REQUESTED)).toMatchObject({ [USER_ID]: account.userId });
      expect(eventsNamed(all, EVENT_SUPPRESSED)).toEqual([]);
      expect(
        counted(all, METRIC_EMAILS, {
          [EMAIL_TEMPLATE]: 'password_reset',
          [EMAIL_OUTCOME]: 'sent',
        }),
      ).toBe(1);
    }, 60_000);

    it('an unknown address: the span, the ineligible counter and a suppression with the reason unknown_address, no user id on any signal and no audit event', async () => {
      const answer = await postRequest(open, `ghost-${randomUUID()}@example.test`);
      expect(answer.status).toBe(200);
      const all = await signals();

      const span = onlySpan(all, SPAN_REQUEST);
      expect(span).not.toHaveProperty(USER_ID);
      expect(counted(all, METRIC_REQUESTS, { [REQUEST_OUTCOME]: 'ineligible' })).toBe(1);
      const suppressed = onlyEvent(all, EVENT_SUPPRESSED);
      expect(suppressed).toMatchObject({
        [EMAIL_TEMPLATE]: 'password_reset',
        [SUPPRESSION]: 'unknown_address',
      });
      expect(suppressed).not.toHaveProperty(USER_ID);
      expect(eventsNamed(all, EVENT_REQUESTED)).toEqual([]);
      const withUserId = all.logs.filter((record) => USER_ID in record.attributes);
      expect(withUserId, 'no log record of this request carries a user id').toEqual([]);
    });

    describe('each ineligible state records the ineligible counter and its suppression reason', () => {
      const cases: readonly {
        readonly reason: string;
        readonly prepare: (account: { userId: string; tenantId: string }) => Promise<void>;
        readonly status?: 'Disabled';
      }[] = [
        {
          reason: 'no_credential_account',
          prepare: async (account) => {
            await authPool.query(
              `delete from auth.account where user_id = $1 and provider_id = 'credential'`,
              [account.userId],
            );
            await authPool.query(
              `insert into auth.account (id, account_id, provider_id, user_id, created_at, updated_at)
               values ($1, $2, 'visma-connect', $3, now(), now())`,
              [`acc-${randomUUID()}`, `sso-${randomUUID()}`, account.userId],
            );
          },
        },
        {
          reason: 'banned',
          prepare: async (account) => {
            await authPool.query('update auth."user" set banned = true where id = $1', [
              account.userId,
            ]);
          },
        },
        { reason: 'disabled_everywhere', status: 'Disabled', prepare: () => Promise.resolve() },
        {
          reason: 'no_membership',
          prepare: async (account) => {
            await authPool.query('delete from auth.member where user_id = $1', [account.userId]);
          },
        },
      ];

      for (const { reason, prepare, status } of cases) {
        it(
          reason,
          async () => {
            const account = await createAccount(status ?? 'Active');
            await prepare(account);
            await harness.reset();

            const answer = await postRequest(open, account.email);
            expect(answer.status).toBe(200);
            await new Promise((resolve) => setTimeout(resolve, 100));
            const all = await signals();

            onlySpan(all, SPAN_REQUEST);
            expect(counted(all, METRIC_REQUESTS, { [REQUEST_OUTCOME]: 'ineligible' })).toBe(1);
            expect(onlyEvent(all, EVENT_SUPPRESSED)).toMatchObject({
              [EMAIL_TEMPLATE]: 'password_reset',
              [SUPPRESSION]: reason,
            });
            expect(eventsNamed(all, EVENT_REQUESTED)).toEqual([]);
            expect(sentTo(openSender, account.email)).toBe(0);
          },
          60_000,
        );
      }
    });

    describe('each admission refusal records the suppressed counter and its reason, with the user id', () => {
      async function expectSuppressed(
        app: App,
        account: { email: string; userId: string },
        reason: string,
        sender: ReturnType<typeof createRecordingEmailSender>,
        ip?: string,
      ): Promise<void> {
        await harness.reset();
        // The sender's record is cumulative: the refused request must add nothing to it.
        const sentBefore = sentTo(sender, account.email);
        const answer = await postRequest(app, account.email, ip);
        expect(answer.status).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, 100));
        const all = await signals();

        onlySpan(all, SPAN_REQUEST);
        expect(counted(all, METRIC_REQUESTS, { [REQUEST_OUTCOME]: 'suppressed' })).toBe(1);
        expect(
          counted(all, METRIC_EMAILS, {
            [EMAIL_TEMPLATE]: 'password_reset',
            [EMAIL_OUTCOME]: 'suppressed',
          }),
          'a suppressed reset email is counted with the outcome suppressed',
        ).toBe(1);
        expect(onlyEvent(all, EVENT_SUPPRESSED)).toMatchObject({
          [EMAIL_TEMPLATE]: 'password_reset',
          [SUPPRESSION]: reason,
          [USER_ID]: account.userId,
        });
        expect(eventsNamed(all, EVENT_REQUESTED)).toEqual([]);
        expect(sentTo(sender, account.email)).toBe(sentBefore);
      }

      it('kill_switch', async () => {
        const sender = createRecordingEmailSender();
        const app = await makeApp(sender, { killSwitch: true });
        const account = await createAccount();
        await expectSuppressed(app, account, 'kill_switch', sender);
      }, 120_000);

      it('recipient_domain_blocked', async () => {
        const sender = createRecordingEmailSender();
        const app = await makeApp(sender, { recipientDomainAllowlist: ['allowed.example'] });
        const account = await createAccount();
        await expectSuppressed(app, account, 'recipient_domain_blocked', sender);
      }, 120_000);

      it('tenants_email_disabled', async () => {
        const account = await createAccount();
        const sender = createRecordingEmailSender();
        const app = await makeApp(sender, { disabledTenantIds: [account.tenantId] });
        await expectSuppressed(app, account, 'tenants_email_disabled', sender);
      }, 120_000);

      it('recipient_cap', async () => {
        const sender = createRecordingEmailSender();
        const app = await makeApp(sender, {
          passwordResetRecipientCap: { max: 1, windowSeconds: 3600 },
        });
        const account = await createAccount();
        expect((await postRequest(app, account.email)).status).toBe(200);
        await vi.waitFor(() => {
          expect(sentTo(sender, account.email)).toBe(1);
        });
        await expectSuppressed(app, account, 'recipient_cap', sender);
        expect(sentTo(sender, account.email)).toBe(1);
      }, 120_000);

      it('ip_cap', async () => {
        const sender = createRecordingEmailSender();
        const app = await makeApp(sender, {
          passwordResetIpCap: { max: 1, windowSeconds: 3600 },
        });
        const ip = randomIp();
        const first = await createAccount();
        const second = await createAccount();
        expect((await postRequest(app, first.email, ip)).status).toBe(200);
        await vi.waitFor(() => {
          expect(sentTo(sender, first.email)).toBe(1);
        });
        await expectSuppressed(app, second, 'ip_cap', sender, ip);
      }, 120_000);

      it('global_cap', async () => {
        const sender = createRecordingEmailSender();
        // The global bucket has one constant key shared by every test file: with a cap of one, the
        // first request either takes the only slot or finds it taken, and the second is refused.
        const app = await makeApp(sender, {
          passwordResetGlobalCap: { max: 1, windowSeconds: 3600 },
        });
        const first = await createAccount();
        const second = await createAccount();
        expect((await postRequest(app, first.email)).status).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, 100));
        await expectSuppressed(app, second, 'global_cap', sender);
      }, 120_000);

      it('provider_failure: the token was issued and the send failed; the failed counter and the reason, no address', async () => {
        const failing = {
          send: (to: string): Promise<void> => Promise.reject(new Error(`provider rejected ${to}`)),
        };
        const app = await makeApp(failing);
        const account = await createAccount();
        await harness.reset();

        const answer = await postRequest(app, account.email);
        expect(answer.status).toBe(200);
        await vi.waitFor(async () => {
          const all = await signals();
          expect(
            eventsNamed(all, EVENT_SUPPRESSED).filter(
              (event) => event[SUPPRESSION] === 'provider_failure',
            ),
          ).toHaveLength(1);
        });
        const all = await signals();

        onlySpan(all, SPAN_REQUEST);
        expect(onlyEvent(all, EVENT_SUPPRESSED)).toMatchObject({
          [EMAIL_TEMPLATE]: 'password_reset',
          [SUPPRESSION]: 'provider_failure',
          [USER_ID]: account.userId,
        });
        expect(
          counted(all, METRIC_EMAILS, {
            [EMAIL_TEMPLATE]: 'password_reset',
            [EMAIL_OUTCOME]: 'failed',
          }),
        ).toBe(1);
        expect(JSON.stringify(all.logs)).not.toContain(account.email);
      }, 120_000);

      it('token_issue_failure: the token store fails after admission', async () => {
        const sender = createRecordingEmailSender();
        const app = await makeApp(sender, {}, instrumentedPool(authPool));
        const account = await createAccount();
        await harness.reset();

        failTokenInsert = true;
        const answer = await postRequest(app, account.email);
        failTokenInsert = false;
        expect(answer.status).toBe(200);
        const all = await signals();

        onlySpan(all, SPAN_REQUEST);
        expect(onlyEvent(all, EVENT_SUPPRESSED)).toMatchObject({
          [EMAIL_TEMPLATE]: 'password_reset',
          [SUPPRESSION]: 'token_issue_failure',
          [USER_ID]: account.userId,
        });
        expect(eventsNamed(all, EVENT_REQUESTED)).toEqual([]);
        expect(sentTo(sender, account.email)).toBe(0);
      }, 120_000);
    });
  });

  // ---- the confirm route -----------------------------------------------------------------

  async function postConfirmRaw(
    payload: string,
    headers: Record<string, string> = {
      origin: ORIGIN,
      'x-csrf-token': 'orpc',
    },
  ): Promise<Answer> {
    const response = await open.app.inject({
      method: 'POST',
      url: CONFIRM_PATH,
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': randomIp(),
        ...headers,
      },
      payload,
    });
    let body: unknown;
    try {
      body = response.json();
    } catch {
      body = response.body;
    }
    return { status: response.statusCode, body };
  }

  function postConfirm(
    fields: Record<string, unknown>,
    headers?: Record<string, string>,
    app: App = open,
  ): Promise<Answer> {
    const payload = JSON.stringify({ newPassword: NEW_PASSWORD, ...fields });
    if (app === open) return postConfirmRaw(payload, headers);
    return app.app
      .inject({
        method: 'POST',
        url: CONFIRM_PATH,
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': randomIp(),
          origin: ORIGIN,
          'x-csrf-token': 'orpc',
        },
        payload,
      })
      .then((response) => ({ status: response.statusCode, body: response.json() }));
  }

  /** One refusal: the denial event with its reason, the outcome counter, and the span. */
  function expectDenied(
    all: Signals,
    expected: {
      readonly reason: string;
      readonly outcome: string;
      readonly beforeFactorStep: boolean;
      readonly userId?: string;
      readonly noUserId?: boolean;
    },
  ): void {
    const denied = onlyEvent(all, EVENT_DENIED);
    expect(denied).toMatchObject({ [DENIAL_REASON]: expected.reason });
    if (expected.userId !== undefined) expect(denied).toMatchObject({ [USER_ID]: expected.userId });
    if (expected.noUserId === true) expect(denied).not.toHaveProperty(USER_ID);
    expect(counted(all, METRIC_CONFIRMS, { [CONFIRM_OUTCOME]: expected.outcome })).toBe(1);
    const span = onlySpan(all, SPAN_CONFIRM);
    if (expected.beforeFactorStep) {
      expect(span, 'a rejection before the factor step carries no reset.mfa').not.toHaveProperty(
        RESET_MFA,
      );
    }
    expect(eventsNamed(all, EVENT_COMPLETED), 'a refusal is not a completion').toEqual([]);
  }

  describe('The confirm route: each denial reason', () => {
    it('malformed_request: an unknown field', async () => {
      const answer = await postConfirmRaw(
        JSON.stringify({
          id: randomId(),
          token: randomToken(),
          newPassword: NEW_PASSWORD,
          extra: 1,
        }),
      );
      expect(answer.status).toBe(400);
      expectDenied(await signals(), {
        reason: 'malformed_request',
        outcome: 'rejected',
        beforeFactorStep: true,
        noUserId: true,
      });
    });

    it('csrf_rejected: a request without the x-csrf-token header', async () => {
      const account = await createAccount();
      const issued = await store().issue(account.userId);
      await harness.reset();

      const answer = await postConfirm({ id: issued.id, token: issued.token }, { origin: ORIGIN });

      expect(answer.status).toBe(404);
      expectDenied(await signals(), {
        reason: 'csrf_rejected',
        outcome: 'rejected',
        beforeFactorStep: true,
        noUserId: true,
      });
    });

    it('origin_rejected: an Origin that is not allowed', async () => {
      const account = await createAccount();
      const issued = await store().issue(account.userId);
      await harness.reset();

      const answer = await postConfirm(
        { id: issued.id, token: issued.token },
        { origin: 'https://evil.example', 'x-csrf-token': 'orpc' },
      );

      expect(answer.status).toBe(404);
      expectDenied(await signals(), {
        reason: 'origin_rejected',
        outcome: 'rejected',
        beforeFactorStep: true,
        noUserId: true,
      });
    });

    it('not_found: an unknown id carries no user id', async () => {
      const answer = await postConfirm({ id: randomId(), token: randomToken() });
      expect(answer.status).toBe(404);
      expectDenied(await signals(), {
        reason: 'not_found',
        outcome: 'rejected',
        beforeFactorStep: true,
        noUserId: true,
      });
    });

    it('expired: a token past its expiry', async () => {
      const account = await createAccount();
      const issued = await store().issue(account.userId);
      await authPool.query(
        `update auth.verification set expires_at = now() - interval '1 second' where identifier = $1`,
        [`password-reset:${issued.id}`],
      );
      await harness.reset();

      const answer = await postConfirm({ id: issued.id, token: issued.token });

      expect(answer.status).toBe(404);
      expectDenied(await signals(), {
        reason: 'expired',
        outcome: 'rejected',
        beforeFactorStep: true,
      });
    });

    it('token_mismatch: a wrong token for a real id', async () => {
      const account = await createAccount();
      const issued = await store().issue(account.userId);
      await harness.reset();

      const answer = await postConfirm({ id: issued.id, token: randomToken() });

      expect(answer.status).toBe(404);
      expectDenied(await signals(), {
        reason: 'token_mismatch',
        outcome: 'rejected',
        beforeFactorStep: true,
      });
    });

    it('not_eligible: the account of a valid token is banned, and the account is named', async () => {
      const account = await createAccount();
      const issued = await store().issue(account.userId);
      await authPool.query('update auth."user" set banned = true where id = $1', [account.userId]);
      await harness.reset();

      const answer = await postConfirm({ id: issued.id, token: issued.token });

      expect(answer.status).toBe(404);
      expectDenied(await signals(), {
        reason: 'not_eligible',
        outcome: 'rejected',
        beforeFactorStep: true,
        userId: account.userId,
      });
    });

    it('policy_violation: a weak password is refused and named by its rule only', async () => {
      const account = await createAccount();
      const issued = await store().issue(account.userId);
      await harness.reset();

      const answer = await postConfirm({
        id: issued.id,
        token: issued.token,
        newPassword: 'Short-1!',
      });

      expect(answer.status).toBe(400);
      const all = await signals();
      expectDenied(all, {
        reason: 'policy_violation',
        outcome: 'policy_refused',
        beforeFactorStep: false,
        userId: account.userId,
      });
      expect(JSON.stringify(all.logs)).not.toContain('Short-1!');
    });

    it('breached: a password found in the range service is refused', async () => {
      const account = await createAccount();
      const issued = await store().issue(account.userId);
      const hash = createHash('sha1').update(NEW_PASSWORD).digest('hex').toUpperCase();
      vi.stubGlobal('fetch', (input: string | URL | Request): Promise<Response> => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const prefix = new URL(url).pathname.split('/').pop() ?? '';
        const lines = ['0000000000000000000000000000000000A:3'];
        if (hash.startsWith(prefix)) lines.push(`${hash.slice(5)}:42`);
        return Promise.resolve(new Response(lines.join('\r\n'), { status: 200 }));
      });
      await harness.reset();

      const answer = await postConfirm({ id: issued.id, token: issued.token });

      expect(answer.status).toBe(400);
      expectDenied(await signals(), {
        reason: 'breached',
        outcome: 'policy_refused',
        beforeFactorStep: false,
        userId: account.userId,
      });
    });

    it('breach_check_unavailable: the range service is down', async () => {
      const account = await createAccount();
      const issued = await store().issue(account.userId);
      vi.stubGlobal('fetch', (): Promise<Response> => {
        return Promise.reject(new TypeError('fetch failed'));
      });
      await harness.reset();

      const answer = await postConfirm({ id: issued.id, token: issued.token });

      expect(answer.status).toBe(500);
      expectDenied(await signals(), {
        reason: 'breach_check_unavailable',
        outcome: 'breach_check_unavailable',
        beforeFactorStep: false,
        userId: account.userId,
      });
    });

    it('consume_conflict: another completion consumed the token between the lock and the consume', async () => {
      const app = await makeApp(createRecordingEmailSender(), {}, instrumentedPool(authPool));
      const account = await createAccount();
      const issued = await store().issue(account.userId);
      consumeConflictFor = issued.id;
      await harness.reset();

      const answer = await postConfirm({ id: issued.id, token: issued.token }, undefined, app);

      expect(consumeConflictFor, 'the conflict was injected').toBeUndefined();
      expect(answer.status).toBe(404);
      expectDenied(await signals(), {
        reason: 'consume_conflict',
        outcome: 'rejected',
        beforeFactorStep: false,
        userId: account.userId,
      });
    }, 120_000);
  });

  /** A user with TOTP enrolled through Better Auth itself; `secret` yields real codes. */
  async function createEnrolled(): Promise<{
    email: string;
    userId: string;
    secret: string;
    cookie: string;
  }> {
    const account = await createAccount();
    const secret = await enrollTotp(open, {
      password: TEST_PASSWORD,
      enrollmentCookie: account.cookie,
    });
    return { email: account.email, userId: account.userId, secret, cookie: account.cookie };
  }

  async function currentCode(secret: string): Promise<string> {
    const api = open.auth.api as {
      generateTOTP(args: { body: { secret: string } }): Promise<{ code: string }>;
    };
    return (await api.generateTOTP({ body: { secret } })).code;
  }

  describe('The confirm route: the factor step', () => {
    const WRONG_FACTOR = { kind: 'totp', code: '12345a' } as const;

    it('factor_invalid: a wrong code answers AUTH_STEP_UP_REQUIRED and the factor_required outcome', async () => {
      const user = await createEnrolled();
      const issued = await store().issue(user.userId);
      await harness.reset();

      const answer = await postConfirm({
        id: issued.id,
        token: issued.token,
        factor: WRONG_FACTOR,
      });

      expect(answer.status).toBe(403);
      const all = await signals();
      expectDenied(all, {
        reason: 'factor_invalid',
        outcome: 'factor_required',
        beforeFactorStep: false,
        userId: user.userId,
      });
      // D15: reset.mfa is "set once the factor step has run": a wrong TOTP ran it.
      expect(
        onlySpan(all, SPAN_CONFIRM),
        'a confirm refused at the factor step carries the factor kind',
      ).toMatchObject({ [RESET_MFA]: 'totp' });
    }, 60_000);

    it('factor_required: an enrolled user who sends no factor gets the factor_required outcome and a denial naming the user', async () => {
      const user = await createEnrolled();
      const issued = await store().issue(user.userId);
      await harness.reset();

      const answer = await postConfirm({ id: issued.id, token: issued.token });

      expect(answer.status).toBe(403);
      const all = await signals();
      expect(counted(all, METRIC_CONFIRMS, { [CONFIRM_OUTCOME]: 'factor_required' })).toBe(1);
      expect(onlyEvent(all, EVENT_DENIED)).toMatchObject({ [USER_ID]: user.userId });
      onlySpan(all, SPAN_CONFIRM);
    }, 60_000);

    it('factor_state_inconsistent: the flag is on and no verified row exists', async () => {
      const account = await createAccount();
      await authPool.query('update auth."user" set two_factor_enabled = true where id = $1', [
        account.userId,
      ]);
      const issued = await store().issue(account.userId);
      await harness.reset();

      const answer = await postConfirm({ id: issued.id, token: issued.token });

      expect(answer.status).toBe(403);
      expectDenied(await signals(), {
        reason: 'factor_state_inconsistent',
        outcome: 'factor_required',
        beforeFactorStep: false,
        userId: account.userId,
      });
    });

    it('attempts_exhausted: four wrong factors are factor_invalid and the fifth, which burns the token, is attempts_exhausted', async () => {
      const user = await createEnrolled();
      const issued = await store().issue(user.userId);

      for (let attempt = 1; attempt <= 4; attempt += 1) {
        await harness.reset();
        const answer = await postConfirm({
          id: issued.id,
          token: issued.token,
          factor: WRONG_FACTOR,
        });
        expect(answer.status).toBe(403);
        expectDenied(await signals(), {
          reason: 'factor_invalid',
          outcome: 'factor_required',
          beforeFactorStep: false,
          userId: user.userId,
        });
      }

      await harness.reset();
      const fifth = await postConfirm({ id: issued.id, token: issued.token, factor: WRONG_FACTOR });
      expect(fifth.status).toBe(403);
      const all = await signals();
      const reasons = eventsNamed(all, EVENT_DENIED).map((event) => event[DENIAL_REASON]);
      expect(reasons, 'the burning failure is reported as attempts_exhausted').toContain(
        'attempts_exhausted',
      );
      for (const event of eventsNamed(all, EVENT_DENIED)) {
        expect(event).toMatchObject({ [USER_ID]: user.userId });
      }
      expect(counted(all, METRIC_CONFIRMS, { [CONFIRM_OUTCOME]: 'factor_required' })).toBe(1);
      onlySpan(all, SPAN_CONFIRM);
    }, 120_000);
  });

  describe('The confirm route: each confirm outcome', () => {
    async function sessionCount(userId: string): Promise<number> {
      const result = await authPool.query<{ n: string }>(
        'select count(*) as n from auth.session where user_id = $1',
        [userId],
      );
      return Number(result.rows[0]?.n);
    }

    function expectCompleted(
      all: Signals,
      userId: string,
      mfa: string,
      sessionsBefore: number,
    ): void {
      expect(counted(all, METRIC_CONFIRMS, { [CONFIRM_OUTCOME]: 'completed' })).toBe(1);
      expect(onlySpan(all, SPAN_CONFIRM)).toMatchObject({ [RESET_MFA]: mfa });
      const completed = onlyEvent(all, EVENT_COMPLETED);
      expect(completed).toMatchObject({ [USER_ID]: userId, [RESET_MFA]: mfa });
      expect(Number.isInteger(completed[SESSIONS_REVOKED])).toBe(true);
      expect(completed[SESSIONS_REVOKED]).toBe(sessionsBefore);
      expect(eventsNamed(all, EVENT_DENIED), 'a completion is not a denial').toEqual([]);
    }

    it('completed, not_enrolled: the audit event counts the revoked sessions and the notice is counted as sent', async () => {
      const account = await createAccount();
      const issued = await store().issue(account.userId);
      const before = await sessionCount(account.userId);
      expect(before, 'precondition: the account has a live session').toBeGreaterThan(0);
      await harness.reset();

      const answer = await postConfirm({ id: issued.id, token: issued.token });

      expect(answer.status).toBe(200);
      const all = await signals();
      expectCompleted(all, account.userId, 'not_enrolled', before);
      expect(
        counted(all, METRIC_EMAILS, {
          [EMAIL_TEMPLATE]: 'password_changed',
          [EMAIL_OUTCOME]: 'sent',
        }),
      ).toBe(1);
    }, 60_000);

    it('completed, totp: a correct code', async () => {
      const user = await createEnrolled();
      const issued = await store().issue(user.userId);
      const before = await sessionCount(user.userId);
      await harness.reset();

      const answer = await postConfirm({
        id: issued.id,
        token: issued.token,
        factor: { kind: 'totp', code: await currentCode(user.secret) },
      });

      expect(answer.status).toBe(200);
      expectCompleted(await signals(), user.userId, 'totp', before);
    }, 60_000);

    it('completed, backup_code: an unused backup code', async () => {
      const user = await createEnrolled();
      const cookie = await signInWithTotp(open, {
        email: user.email,
        password: TEST_PASSWORD,
        secret: user.secret,
        origin: 'http://localhost:3000',
      });
      const generated = await (
        open.auth.api as {
          generateBackupCodes(args: {
            body: { password: string };
            headers: Headers;
          }): Promise<{ backupCodes: string[] }>;
        }
      ).generateBackupCodes({
        body: { password: TEST_PASSWORD },
        headers: new Headers({ cookie }),
      });
      const [code] = generated.backupCodes;
      expect(code, 'precondition: a backup code exists').toBeDefined();
      const issued = await store().issue(user.userId);
      const before = await sessionCount(user.userId);
      await harness.reset();

      const answer = await postConfirm({
        id: issued.id,
        token: issued.token,
        factor: { kind: 'backup_code', code: code ?? '' },
      });

      expect(answer.status).toBe(200);
      expectCompleted(await signals(), user.userId, 'backup_code', before);
    }, 60_000);
  });

  // ---- the MFA reset ---------------------------------------------------------------------

  describe('The MFA reset', () => {
    let service: MfaResetService;

    beforeAll(() => {
      service = createMfaResetService({
        authPool,
        notices: { send: () => Promise.resolve('sent' as const) },
      });
    });

    async function seedTenant(): Promise<string> {
      const id = `org-${randomUUID()}`;
      await authPool.query(
        'insert into auth.organization (id, name, slug, created_at) values ($1, $2, $3, now())',
        [id, 'Org', `slug-${id}`],
      );
      return id;
    }

    async function seedMember(
      tenantId: string,
      options: { role?: string; factor?: boolean; userId?: string } = {},
    ): Promise<string> {
      const userId = options.userId ?? `usr-${randomUUID()}`;
      const factor = options.factor ?? true;
      if (options.userId === undefined) {
        await authPool.query(
          `insert into auth."user" (id, name, email, email_verified, created_at, updated_at, two_factor_enabled)
           values ($1, 'User', $2, true, now(), now(), $3)`,
          [userId, `events044-m-${randomUUID()}@example.test`, factor],
        );
        if (factor) {
          const id = `tf-${randomUUID()}`;
          await authPool.query(
            `insert into auth.two_factor (id, secret, backup_codes, user_id, verified, failed_verification_count)
             values ($1, $2, $3, $4, true, 0)`,
            [id, `enc-secret-${id}`, `enc-codes-${id}`, userId],
          );
        }
        await authPool.query(
          `insert into auth.session (id, expires_at, token, created_at, updated_at, user_id, active_organization_id)
           values ($1, now() + interval '1 day', $2, now(), now(), $3, $4)`,
          [`ses-${randomUUID()}`, `tok-${randomUUID()}`, userId, tenantId],
        );
      }
      await authPool.query(
        'insert into auth.member (id, organization_id, user_id, role, created_at) values ($1, $2, $3, $4, now())',
        [`mem-${randomUUID()}`, tenantId, userId, options.role ?? 'member'],
      );
      return userId;
    }

    it('the admin form: the span, the counter and the audit event with the admin form attributes', async () => {
      const tenantId = await seedTenant();
      const userId = await seedMember(tenantId);
      const actorId = `adm-${randomUUID()}`;
      await harness.reset();

      const result = await service.resetAdmin({
        tenantId,
        actorId,
        userId,
        reason: 'lost_both_factors',
      });

      const all = await signals();
      expect(onlySpan(all, SPAN_MFA_RESET)).toMatchObject({ [MFA_RESET_PATH]: 'admin' });
      expect(
        counted(all, METRIC_MFA_RESETS, { [TENANT]: tenantId, [MFA_RESET_PATH]: 'admin' }),
      ).toBe(1);
      const audit = onlyEvent(all, EVENT_MFA_RESET);
      expect(audit).toMatchObject({
        [TENANT]: tenantId,
        [ACTOR_ID]: actorId,
        [USER_ID]: userId,
        [MFA_RESET_REASON]: 'lost_both_factors',
        [SESSIONS_REVOKED]: result.sessionsRevoked,
      });
      expect(audit).not.toHaveProperty(OPERATOR_ID);
      expect(audit).not.toHaveProperty(APPROVER_ID);
    }, 60_000);

    it('the operator form: the span, the counter and the audit event with the operator form attributes', async () => {
      const tenantId = await seedTenant();
      const userId = await seedMember(tenantId, { role: 'owner' });
      const operatorId = `gh:${String(randomInt(1_000_000, 9_999_999))}`;
      const approverId = `gh:${String(randomInt(1_000_000, 9_999_999))}`;
      await harness.reset();

      const result = await service.resetOperator({ tenantId, operatorId, approverId, userId });

      const all = await signals();
      expect(onlySpan(all, SPAN_MFA_RESET)).toMatchObject({ [MFA_RESET_PATH]: 'operator' });
      expect(
        counted(all, METRIC_MFA_RESETS, { [TENANT]: tenantId, [MFA_RESET_PATH]: 'operator' }),
      ).toBe(1);
      const audit = onlyEvent(all, EVENT_MFA_RESET);
      expect(audit).toMatchObject({
        [TENANT]: tenantId,
        [OPERATOR_ID]: operatorId,
        [APPROVER_ID]: approverId,
        [USER_ID]: userId,
        [SESSIONS_REVOKED]: result.sessionsRevoked,
      });
      expect(audit).not.toHaveProperty(ACTOR_ID);
      expect(audit).not.toHaveProperty(MFA_RESET_REASON);
    }, 60_000);

    const refusals: readonly {
      readonly reason: string;
      readonly seed: (tenantId: string) => Promise<string>;
    }[] = [
      {
        reason: 'no_enrolled_factor',
        seed: (tenantId) => seedMember(tenantId, { factor: false }),
      },
      {
        reason: 'target_in_other_tenant',
        seed: async (tenantId) => {
          const userId = await seedMember(tenantId);
          await seedMember(await seedTenant(), { userId });
          return userId;
        },
      },
      {
        reason: 'target_is_admin_or_owner',
        seed: (tenantId) => seedMember(tenantId, { role: 'admin' }),
      },
    ];

    for (const { reason, seed } of refusals) {
      it(`refusal ${reason}: one identity_conflict_refused event with the tenant, the admin, the target and the reason, and no reset`, async () => {
        const tenantId = await seedTenant();
        const userId = await seed(tenantId);
        const actorId = `adm-${randomUUID()}`;
        await harness.reset();

        await expect(
          service.resetAdmin({ tenantId, actorId, userId, reason: 'device_replaced' }),
        ).rejects.toBeDefined();

        const all = await signals();
        expect(onlyEvent(all, EVENT_CONFLICT)).toMatchObject({
          [TENANT]: tenantId,
          [ACTOR_ID]: actorId,
          [CONFLICT_REASON]: reason,
          [USER_ID]: userId,
        });
        expect(eventsNamed(all, EVENT_SELF_DENIED)).toEqual([]);
        expect(eventsNamed(all, EVENT_MFA_RESET), 'a refusal is not a reset').toEqual([]);
      }, 60_000);
    }

    it('refusal self-target: one self_mfa_reset_denied event with the tenant and the admin, and no reset', async () => {
      const tenantId = await seedTenant();
      const userId = await seedMember(tenantId);
      await harness.reset();

      await expect(
        service.resetAdmin({ tenantId, actorId: userId, userId, reason: 'device_replaced' }),
      ).rejects.toBeDefined();

      const all = await signals();
      expect(onlyEvent(all, EVENT_SELF_DENIED)).toMatchObject({
        [TENANT]: tenantId,
        [ACTOR_ID]: userId,
      });
      expect(eventsNamed(all, EVENT_CONFLICT)).toEqual([]);
      expect(eventsNamed(all, EVENT_MFA_RESET), 'a refusal is not a reset').toEqual([]);
    }, 60_000);
  });
});
