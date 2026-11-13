/**
 * Task 11.2 of openspec/changes/044-password-reset-and-account-recovery (design D12, Resolved
 * decisions Q14, Q15, Q16): the break-glass command `apps/api/scripts/recover-admin-mfa.ts`.
 *
 * Scenarios of `specs/password-reset-and-account-recovery/spec.md`, requirement "Operator recovery
 * covers every target the admin operation does not":
 *
 * - "The operator resets the last admin's factor": GIVEN an organization whose only admin lost the
 *   authenticator and the backup codes; WHEN the operator runs the command for that admin with an
 *   approver; THEN the admin's factor is gone, their sessions are revoked, they are marked for
 *   re-enrolment, they receive the MFA-reset notice, and `catalog.audit.mfa_reset` is logged with
 *   the operator's id and the approver's id.
 * - "The command refuses a user outside the organization": WHEN the operator names a user who is
 *   not a member of the organization; THEN the command fails, changes nothing and prints no
 *   account detail.
 * - "The command requires a second approver": WHEN the command runs with no approver, or with the
 *   operator's own id as the approver; THEN it fails before any database or email work and changes
 *   nothing.
 * - "The operator resets a member of several tenants": GIVEN a member of two organizations whose
 *   admin was refused by the admin operation; WHEN the operator runs the command for that member
 *   with an approver; THEN the factor is gone, the member's sessions in both organizations are
 *   revoked, and the notice is sent.
 * - "A squatter enrolled a factor on an account created for my address": GIVEN an account on which
 *   a squatter signed in with the known password and enrolled a TOTP factor; WHEN the victim
 *   requests a reset link before the run, the operator runs the command for that member with an
 *   approver, and the victim confirms with the link at once; THEN the squatter's factor and
 *   sessions are gone, the victim completes the reset with the link alone, and the old password no
 *   longer signs in.
 * - "A squatter who re-enrols in the window is removed by a repeat run": GIVEN the state after the
 *   command ran, and the squatter signs in with the old password before the victim confirms; WHEN
 *   the squatter's session calls a `/v1` route and then enrols a TOTP factor, and the victim's
 *   confirmation then asks for a factor; THEN the `/v1` call is rejected as a missing context, the
 *   confirmation answers `AUTH_STEP_UP_REQUIRED`, and a second run of the command followed at once
 *   by the victim's confirmation completes the reset.
 *
 * ## Production symbols expected
 *
 * ```ts
 * // apps/api/scripts/recover-admin-mfa.ts
 * export interface RecoverAdminMfaOptions {
 *   // Read through loadScriptConfig('recover-admin-mfa', env): no BETTER_AUTH_SECRET, no
 *   // DATABASE_URL, no CERBOS_ADDRESS. The tests never set those three.
 *   readonly env: Readonly<Record<string, string | undefined>>;
 *   // The command line after the script name: --organization-slug <slug> --email <address>
 *   // --approver <opaque id> (node:util parseArgs).
 *   readonly args: readonly string[];
 *   // The tayzu_auth pool (the host built it; the run function does not end it).
 *   readonly authPool: Pool;
 *   // Test seam: the sender behind the notice adapter. Defaults to createEmailSender(env slice).
 *   readonly sender?: EmailSender;
 * }
 * export interface RecoverAdminMfaResult {
 *   readonly userId: string;
 *   readonly sessionsRevoked: number;
 *   readonly notice: 'sent' | 'suppressed' | 'failed';
 * }
 * // The run function handed to runScript: it validates the approver against OPERATOR_ID_PATTERN
 * // and against the operator id before any pool or sender use, resolves the organization by slug
 * // and the user by email, requires membership, then calls createMfaResetService(...).resetOperator
 * // with the notice adapter. It prints nothing (the completion line is task 11.3's, in main()).
 * export function recoverAdminMfa(options: RecoverAdminMfaOptions): Promise<RecoverAdminMfaResult>;
 * ```
 *
 * If the real names differ, the adaptation is `runCommand` below, in one place.
 *
 * Harness: the shared test database. Every organization, user, slug, email and id is random per
 * test, the command touches only the user it is given, and the HTTP flows use the real server
 * (`createApp`, injected requests) with `auth.handler`-style requests carrying a fresh random
 * `x-forwarded-for` so no limiter interferes.
 */
// Load-bearing import order (design D1): the telemetry harness registers before anything that
// loads `@tayzu/auth` creates its logger.
import {
  linkLogEvents,
  registration,
  type TelemetryTestHarness,
} from './__fixtures__/link-telemetry.js';
import { randomInt, randomUUID } from 'node:crypto';

import { createRecordingEmailSender, type EmailSender } from '@tayzu/auth';
import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  bootstrapTestTenant,
  signInAdminUser,
  testAppPool,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { recoverAdminMfa, type RecoverAdminMfaResult } from '../scripts/recover-admin-mfa.js';
import { enrollTotp } from './__fixtures__/fresh-mfa.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createApp, type App } from './server.js';

const ORIGIN = 'https://app.tayzu.test';
const LINK_BASE_URL = 'https://app.tayzu.test';
const HMAC_SECRET = 'recover-admin-mfa-test-only-secret-0123456789-abcdef';
const REQUEST_PATH = '/v1/auth/password-reset/request';
const CONFIRM_PATH = '/v1/auth/password-reset/confirm';
const AUTH_BASE_URL = 'http://localhost:3000/api/auth';
const NEW_PASSWORD = 'Another-Perfectly-Fine-Passphrase-77!';
const AUDIT_EVENT = 'catalog.audit.mfa_reset';

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

type QueryFunction = (...args: unknown[]) => unknown;

/** Wraps a pool (and the clients it hands out) so that every use is counted. */
function countUses(pool: Pool, onUse: () => void): Pool {
  const spyOnClient = (client: PoolClient): PoolClient =>
    new Proxy(client, {
      get(target, property): unknown {
        const value: unknown = Reflect.get(target, property, target);
        if (property === 'query') {
          return (...args: unknown[]): unknown => {
            onUse();
            return (value as QueryFunction).apply(target, args);
          };
        }
        return typeof value === 'function' ? (value as QueryFunction).bind(target) : value;
      },
    });
  return new Proxy(pool, {
    get(target, property): unknown {
      const value: unknown = Reflect.get(target, property, target);
      if (property === 'query') {
        return (...args: unknown[]): unknown => {
          onUse();
          return (value as QueryFunction).apply(target, args);
        };
      }
      if (property === 'connect') {
        return async (): Promise<PoolClient> => {
          onUse();
          return spyOnClient(await target.connect());
        };
      }
      return typeof value === 'function' ? (value as QueryFunction).bind(target) : value;
    },
  });
}

describe('The recover-admin-mfa command (task 11.2, design D12)', () => {
  let harness: TelemetryTestHarness;
  let authPool: Pool;
  let app: App;
  let appSender: ReturnType<typeof createRecordingEmailSender>;
  const operatorId = `op-${randomUUID()}`;

  beforeAll(async () => {
    if ('error' in registration) {
      throw new Error(`createTelemetryTestHarness() failed: ${String(registration.error)}`, {
        cause: registration.error,
      });
    }
    harness = registration.harness;
    const pools = await harnessPools();
    authPool = pools.authPool;
    appSender = createRecordingEmailSender();
    const email = {
      sender: appSender,
      invitationLinkBaseUrl: LINK_BASE_URL,
      passwordResetLinkBaseUrl: LINK_BASE_URL,
      passwordResetMinResponseMs: 0,
      disabledTenantIds: [] as string[],
      killSwitch: false,
      recipientKeySecret: HMAC_SECRET,
      tenantCap: { max: 1000, windowSeconds: 3600 },
      recipientCap: { max: 1000, windowSeconds: 86_400 },
      passwordResetGlobalCap: { max: 100_000, windowSeconds: 3600 },
      accountCreatedNoticeGlobalCap: { max: 100_000, windowSeconds: 86_400 },
    };
    app = await createApp({
      appPool: pools.appPool,
      authPool: pools.authPool,
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ORIGIN],
      mountIdentityRoutes: true,
      identityTokenHmacSecret: HMAC_SECRET,
      ...{ email },
    });
  }, 60_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
  }, 60_000);

  // ---- the adaptation point --------------------------------------------------------------

  function commandEnv(): Record<string, string> {
    return {
      AUTH_DATABASE_URL: process.env.DATABASE_URL ?? '',
      TAYZU_OPERATOR_ID: operatorId,
      EMAIL_PROVIDER: 'none',
    };
  }

  function runCommand(input: {
    readonly pool?: Pool;
    readonly sender: EmailSender;
    readonly organizationSlug: string;
    readonly email: string;
    readonly approver?: string;
  }): Promise<RecoverAdminMfaResult> {
    return recoverAdminMfa({
      env: commandEnv(),
      args: [
        '--organization-slug',
        input.organizationSlug,
        '--email',
        input.email,
        ...(input.approver === undefined ? [] : ['--approver', input.approver]),
      ],
      authPool: input.pool ?? authPool,
      sender: input.sender,
    });
  }

  const newApprover = (): string => `appr-${randomUUID()}`;

  function silenceOutput(): { readonly printed: () => string } {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    return {
      printed: () => JSON.stringify([log, error, stdout, stderr].map((spy) => spy.mock.calls)),
    };
  }

  // ---- seeds (SQL, like mfa-reset.int.test.ts) -------------------------------------------

  interface Seeded {
    readonly tenantId: string;
    readonly slug: string;
    readonly userId: string;
    readonly email: string;
    readonly sessionIds: readonly string[];
  }

  async function seedTenant(): Promise<{ id: string; slug: string }> {
    const id = `org-${randomUUID()}`;
    const slug = `recover-${randomUUID()}`;
    await authPool.query(
      'insert into auth.organization (id, name, slug, created_at) values ($1, $2, $3, now())',
      [id, 'Org', slug],
    );
    return { id, slug };
  }

  async function seedUser(): Promise<{ id: string; email: string }> {
    const id = `usr-${randomUUID()}`;
    const email = `recover-${randomUUID()}@example.test`;
    await authPool.query(
      'insert into auth."user" (id, name, email, email_verified, created_at, updated_at, two_factor_enabled) values ($1, $2, $3, true, now(), now(), true)',
      [id, 'User', email],
    );
    return { id, email };
  }

  async function seedMember(tenantId: string, userId: string, role: string): Promise<void> {
    await authPool.query(
      'insert into auth.member (id, organization_id, user_id, role, created_at) values ($1, $2, $3, $4, now())',
      [`mem-${randomUUID()}`, tenantId, userId, role],
    );
  }

  async function seedTwoFactor(userId: string): Promise<void> {
    const id = `tf-${randomUUID()}`;
    await authPool.query(
      `insert into auth.two_factor (id, secret, backup_codes, user_id, verified, failed_verification_count)
       values ($1, $2, $3, $4, true, 0)`,
      [id, `enc-secret-${id}`, `enc-codes-${id}`, userId],
    );
  }

  async function seedSession(userId: string, tenantId: string | null): Promise<string> {
    const id = `ses-${randomUUID()}`;
    await authPool.query(
      `insert into auth.session (id, expires_at, token, created_at, updated_at, user_id, active_organization_id)
       values ($1, now() + interval '1 day', $2, now(), now(), $3, $4)`,
      [id, `tok-${randomUUID()}`, userId, tenantId],
    );
    return id;
  }

  /** A user with a second factor and one session in each given tenant, a member of each with `role`. */
  async function seedTarget(role: string, tenantCount = 1): Promise<Seeded & { all: Seeded[] }> {
    const user = await seedUser();
    await seedTwoFactor(user.id);
    const all: Seeded[] = [];
    for (let index = 0; index < tenantCount; index += 1) {
      const tenant = await seedTenant();
      await seedMember(tenant.id, user.id, role);
      const sessionId = await seedSession(user.id, tenant.id);
      all.push({
        tenantId: tenant.id,
        slug: tenant.slug,
        userId: user.id,
        email: user.email,
        sessionIds: [sessionId],
      });
    }
    const first = all[0] as Seeded;
    return { ...first, all };
  }

  // ---- reads -----------------------------------------------------------------------------

  async function count(sql: string, params: unknown[]): Promise<number> {
    const result = await authPool.query<{ n: string }>(`select count(*) as n ${sql}`, params);
    return Number(result.rows[0]?.n);
  }

  const twoFactorRows = (userId: string): Promise<number> =>
    count('from auth.two_factor where user_id = $1', [userId]);
  const sessionRows = (userId: string): Promise<number> =>
    count('from auth.session where user_id = $1', [userId]);
  const markerRows = (userId: string): Promise<number> =>
    count('from auth.verification where identifier = $1', [`mfa-reenrol:${userId}`]);

  async function twoFactorEnabled(userId: string): Promise<boolean | null> {
    const result = await authPool.query<{ two_factor_enabled: boolean | null }>(
      'select two_factor_enabled from auth."user" where id = $1',
      [userId],
    );
    return result.rows[0]?.two_factor_enabled ?? null;
  }

  async function expectUntouched(target: Seeded, sessions: number): Promise<void> {
    expect(await twoFactorRows(target.userId), 'the factor is still there').toBe(1);
    expect(await twoFactorEnabled(target.userId), 'the flag is still set').toBe(true);
    expect(await sessionRows(target.userId), 'the sessions are still there').toBe(sessions);
    expect(await markerRows(target.userId), 'no marker was written').toBe(0);
  }

  function noticesTo(sender: ReturnType<typeof createRecordingEmailSender>, address: string) {
    return sender.sent.filter((message) => message.to === address);
  }

  // ---- scenarios -------------------------------------------------------------------------

  describe('The operator resets the last admin’s factor', () => {
    it('removes the factor, revokes the sessions, marks re-enrolment, sends the MfaResetNotice and logs the audit event with the operator and the approver', async () => {
      silenceOutput();
      const admin = await seedTarget('admin');
      await seedSession(admin.userId, null);
      const sender = createRecordingEmailSender();
      const approver = newApprover();
      expect(await sessionRows(admin.userId), 'precondition').toBe(2);

      const result = await runCommand({
        sender,
        organizationSlug: admin.slug,
        email: admin.email,
        approver,
      });

      expect(result).toEqual({ userId: admin.userId, sessionsRevoked: 2, notice: 'sent' });
      expect(await twoFactorRows(admin.userId), 'the factor is gone').toBe(0);
      expect(await twoFactorEnabled(admin.userId), 'the flag is cleared').toBe(false);
      expect(await sessionRows(admin.userId), 'the sessions are revoked').toBe(0);
      expect(await markerRows(admin.userId), 'marked for re-enrolment').toBe(1);
      expect(noticesTo(sender, admin.email)).toEqual([
        { to: admin.email, template: { kind: 'MfaResetNotice' } },
      ]);
      expect(sender.sent, 'exactly one email, to the admin').toHaveLength(1);

      const audit = (await linkLogEvents(harness, AUDIT_EVENT)).filter(
        (record) => record.attributes['tayzu.identity.user.id'] === admin.userId,
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]?.attributes).toMatchObject({
        'tayzu.identity.operator.id': operatorId,
        'tayzu.identity.approver.id': approver,
        'tayzu.identity.user.id': admin.userId,
        'tayzu.tenant.id': admin.tenantId,
      });
      expect(audit[0]?.attributes).not.toHaveProperty('tayzu.actor.id');
      expect(JSON.stringify(audit[0]?.attributes)).not.toContain(admin.email);
    }, 60_000);
  });

  describe('The command refuses a user outside the organization', () => {
    it('fails, changes nothing, sends nothing and prints no account detail', async () => {
      const output = silenceOutput();
      const target = await seedTarget('member');
      const elsewhere = await seedTenant();
      const sender = createRecordingEmailSender();

      const failure = await runCommand({
        sender,
        organizationSlug: elsewhere.slug,
        email: target.email,
        approver: newApprover(),
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure, 'the command fails').toBeInstanceOf(Error);
      const message = failure instanceof Error ? failure.message : '';
      expect(message).not.toContain(target.email);
      expect(message).not.toContain(target.userId);
      expect(message).not.toContain(target.tenantId);
      await expectUntouched(target, 1);
      expect(sender.sent).toHaveLength(0);
      expect(output.printed()).not.toContain(target.email);
      expect(output.printed()).not.toContain(target.userId);
    }, 60_000);

    it('fails the same way for an unknown organization', async () => {
      const output = silenceOutput();
      const target = await seedTarget('member');
      const sender = createRecordingEmailSender();

      await expect(
        runCommand({
          sender,
          organizationSlug: `no-such-${randomUUID()}`,
          email: target.email,
          approver: newApprover(),
        }),
      ).rejects.toBeInstanceOf(Error);

      await expectUntouched(target, 1);
      expect(sender.sent).toHaveLength(0);
      expect(output.printed()).not.toContain(target.email);
    }, 60_000);
  });

  describe('The command requires a second approver', () => {
    async function expectRefusedBeforeAnyWork(approver: string | undefined): Promise<void> {
      silenceOutput();
      const target = await seedTarget('admin');
      const sender = createRecordingEmailSender();
      let uses = 0;
      const pool = countUses(authPool, () => {
        uses += 1;
      });

      await expect(
        runCommand({
          pool,
          sender,
          organizationSlug: target.slug,
          email: target.email,
          ...(approver === undefined ? {} : { approver }),
        }),
      ).rejects.toBeInstanceOf(Error);

      expect(uses, 'no database work').toBe(0);
      expect(sender.sent, 'no email work').toHaveLength(0);
      await expectUntouched(target, 1);
    }

    it('with no approver it fails before any database or email work and changes nothing', async () => {
      await expectRefusedBeforeAnyWork(undefined);
    }, 60_000);

    it('with the operator’s own id as the approver it fails before any database or email work and changes nothing', async () => {
      await expectRefusedBeforeAnyWork(operatorId);
    }, 60_000);

    it('with an approver that is not of the operator id’s form (an address) it fails before any database or email work', async () => {
      await expectRefusedBeforeAnyWork('approver@example.test');
    }, 60_000);
  });

  describe('The operator resets a member of several tenants', () => {
    it('removes the factor, revokes the sessions in both organizations and sends the notice', async () => {
      silenceOutput();
      const member = await seedTarget('member', 2);
      const sender = createRecordingEmailSender();
      expect(await sessionRows(member.userId), 'precondition').toBe(2);

      const result = await runCommand({
        sender,
        organizationSlug: member.slug,
        email: member.email,
        approver: newApprover(),
      });

      expect(result).toEqual({ userId: member.userId, sessionsRevoked: 2, notice: 'sent' });
      expect(await twoFactorRows(member.userId), 'the factor is gone').toBe(0);
      expect(await twoFactorEnabled(member.userId)).toBe(false);
      expect(await sessionRows(member.userId), 'the sessions of both organizations are gone').toBe(
        0,
      );
      expect(await markerRows(member.userId)).toBe(1);
      expect(noticesTo(sender, member.email)).toEqual([
        { to: member.email, template: { kind: 'MfaResetNotice' } },
      ]);
    }, 60_000);
  });

  // ---- the squatter scenarios (HTTP, the real server) -----------------------------------

  interface Answer {
    readonly status: number;
    readonly body: unknown;
  }

  async function postJson(path: string, payload: Record<string, unknown>): Promise<Answer> {
    const response = await app.app.inject({
      method: 'POST',
      url: path,
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        'x-csrf-token': 'orpc',
        'x-forwarded-for': randomIp(),
      },
      payload: JSON.stringify(payload),
    });
    let body: unknown;
    try {
      body = response.json();
    } catch {
      body = response.body;
    }
    return { status: response.statusCode, body };
  }

  async function signInStatus(email: string, password: string): Promise<number> {
    const handler = (app.auth as unknown as { handler: (request: Request) => Promise<Response> })
      .handler;
    const response = await handler(
      new Request(`${AUTH_BASE_URL}/sign-in/email`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': randomIp(),
          origin: 'http://localhost:3000',
        },
        body: JSON.stringify({ email, password }),
      }),
    );
    return response.status;
  }

  /** An account whose password is the squatter's knowledge, and a TOTP factor the squatter enrolled. */
  async function squattedAccount(): Promise<{
    email: string;
    userId: string;
    slug: string;
    tenantId: string;
  }> {
    const suffix = randomUUID();
    const email = `squat-${suffix}@example.test`;
    const slug = `squat-${suffix}`;
    const tenant = await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: 'Squatted Member',
      email,
      password: TEST_PASSWORD,
      organizationName: `Squat Org ${suffix}`,
      organizationSlug: slug,
      ip: randomIp(),
    });
    await enrollTotp(app, { password: TEST_PASSWORD, enrollmentCookie: tenant.cookie });
    expect(await twoFactorRows(tenant.userId), 'precondition: the squatter enrolled').toBe(1);
    return { email, userId: tenant.userId, slug, tenantId: tenant.organizationId };
  }

  /** The victim requests the link; the emailed id and token are read from the app's sender. */
  async function victimRequestsLink(address: string): Promise<{ id: string; token: string }> {
    const answer = await postJson(REQUEST_PATH, { email: address });
    expect(answer.status).toBe(200);
    await vi.waitFor(() => {
      expect(
        appSender.sent.filter(
          (message) => message.to === address && message.template.kind === 'PasswordResetEmail',
        ),
      ).toHaveLength(1);
    });
    const message = appSender.sent.find(
      (entry) => entry.to === address && entry.template.kind === 'PasswordResetEmail',
    );
    if (message?.template.kind !== 'PasswordResetEmail') throw new Error('no reset email');
    const fragment = new URLSearchParams(new URL(message.template.link).hash.slice(1));
    return { id: fragment.get('reset') ?? '', token: fragment.get('token') ?? '' };
  }

  function confirm(link: { id: string; token: string }): Promise<Answer> {
    return postJson(CONFIRM_PATH, { ...link, newPassword: NEW_PASSWORD });
  }

  describe('A squatter enrolled a factor on an account created for my address', () => {
    it('the victim requests the link, the operator runs the command, and the link alone completes the reset: the squatter’s factor and sessions are gone and the old password no longer signs in', async () => {
      silenceOutput();
      const account = await squattedAccount();
      const link = await victimRequestsLink(account.email);
      expect(await sessionRows(account.userId), 'precondition: the squatter has a session').toBe(1);
      const cliSender = createRecordingEmailSender();

      const result = await runCommand({
        sender: cliSender,
        organizationSlug: account.slug,
        email: account.email,
        approver: newApprover(),
      });

      expect(result.userId).toBe(account.userId);
      expect(result.sessionsRevoked).toBe(1);
      expect(await twoFactorRows(account.userId), 'the squatter’s factor is gone').toBe(0);
      expect(await sessionRows(account.userId), 'the squatter’s session is gone').toBe(0);

      const completed = await confirm(link);
      expect(completed.status).toBe(200);
      expect(completed.body).toEqual({ completed: true });

      expect(await sessionRows(account.userId), 'no squatter session exists').toBe(0);
      expect(
        await signInStatus(account.email, TEST_PASSWORD),
        'the old password',
      ).toBeGreaterThanOrEqual(400);
      expect(await signInStatus(account.email, NEW_PASSWORD), 'the new password').toBe(200);
    }, 120_000);
  });

  describe('A squatter who re-enrols in the window is removed by a repeat run', () => {
    it('the squatter’s /v1 call is a missing context, the confirmation asks for a factor, and a second run followed at once by the confirmation completes the reset', async () => {
      silenceOutput();
      const account = await squattedAccount();
      const link = await victimRequestsLink(account.email);
      const approver = newApprover();
      const firstSender = createRecordingEmailSender();

      await runCommand({
        sender: firstSender,
        organizationSlug: account.slug,
        email: account.email,
        approver,
      });
      expect(await twoFactorRows(account.userId)).toBe(0);

      // The squatter signs in with the old password in the window: confined to enrolment.
      const squatter = await signInAdminUser(app.auth, {
        email: account.email,
        password: TEST_PASSWORD,
        ip: randomIp(),
      });
      const v1 = await app.app.inject({
        method: 'GET',
        url: '/v1/blueprints',
        headers: { cookie: squatter.cookie },
      });
      expect(v1.statusCode).toBeGreaterThanOrEqual(400);
      expect(v1.statusCode).toBeLessThan(500);
      expect(v1.json()).toMatchObject({ code: 'CATALOG_CONTEXT_REQUIRED' });

      await enrollTotp(app, { password: TEST_PASSWORD, enrollmentCookie: squatter.cookie });
      expect(await twoFactorRows(account.userId), 'the squatter re-enrolled').toBe(1);

      const asked = await confirm(link);
      expect(asked.status).toBe(403);
      expect(asked.body).toMatchObject({ code: 'AUTH_STEP_UP_REQUIRED' });

      const secondSender = createRecordingEmailSender();
      const second = await runCommand({
        sender: secondSender,
        organizationSlug: account.slug,
        email: account.email,
        approver,
      });
      expect(second.userId).toBe(account.userId);
      expect(await twoFactorRows(account.userId), 'the repeat run removed the factor').toBe(0);
      expect(await sessionRows(account.userId), 'and the squatter’s session').toBe(0);

      const completed = await confirm(link);
      expect(completed.status).toBe(200);
      expect(completed.body).toEqual({ completed: true });
      expect(
        await signInStatus(account.email, TEST_PASSWORD),
        'the old password',
      ).toBeGreaterThanOrEqual(400);
      expect(await signInStatus(account.email, NEW_PASSWORD), 'the new password').toBe(200);
    }, 120_000);
  });
});
