/**
 * Integration test for task 10.3 of `044-password-reset-and-account-recovery` (design D10 "Effects",
 * D11, D12 "Secrets"; Resolved decisions Q15 and Q30): the MFA reset service shared by the admin
 * operation (10.5) and the operator CLI (11.x).
 *
 * Scenarios and cases (spec `password-reset-and-account-recovery`):
 *
 * - "An admin resets a member's lost factor" (service level): factor gone, sessions rejected,
 *   marker written, `MfaResetNotice` sent after the commit, `catalog.audit.mfa_reset` with the
 *   admin id, the reason code and the member's opaque id, one `session_revoked` event of reason
 *   `mfa_reset` per session, challenge and trust rows gone, `password-reset:` rows left alone,
 *   everything under the per-user lock;
 * - "An MFA reset leaves credentials and linked sign-ins, and the notice says to review them", in
 *   the admin form and in the operator form;
 * - the operator-form case "the operator form logs `tayzu.identity.operator.id` and
 *   `tayzu.identity.approver.id`";
 * - the case "the service is constructed with only a repository port and a notice port, and a fake
 *   notice port sees exactly one `MfaResetNotice` send and its outcome is returned".
 *
 * The refusal scenarios of the admin form are task 10.4's and are not tested here. The two new
 * repository functions are tested in `auth-repository.int.test.ts`.
 *
 * The last section is the fix cycle "N3 in-lock predicates" of task 16.2 (design D10 "The
 * predicates are read under the lock (Q36)"): the scenario "A change that lands while the reset
 * waits for the lock is seen", the case "the predicate reads of the admin form run on the lock's
 * connection" and the guard case "with a pool of one connection the admin reset completes".
 *
 * ## Production symbols expected
 *
 * ```ts
 * // apps/api/src/identity/mfa-reset.ts
 * export type MfaResetReason =
 *   'lost_both_factors' | 'device_replaced' | 'suspected_compromise' | 'identity_verified_request';
 * export type NoticeOutcome = 'sent' | 'suppressed' | 'failed';
 * export interface RecoveryNoticePort {
 *   // never throws
 *   send(kind: 'MfaResetNotice', userId: string): Promise<NoticeOutcome>;
 * }
 * export interface MfaResetResult {
 *   readonly sessionsRevoked: number;
 *   readonly notice: NoticeOutcome;
 * }
 * export interface MfaResetService {
 *   resetAdmin(input: {
 *     tenantId: string; actorId: string; userId: string; reason: MfaResetReason;
 *   }): Promise<MfaResetResult>;
 *   resetOperator(input: {
 *     tenantId: string; operatorId: string; approverId: string; userId: string;
 *   }): Promise<MfaResetResult>;
 * }
 * // The repository/SQL port is the `tayzu_auth` pool: the service builds `createAuthRepository`
 * // and `createWithUserLock` from it. No Better Auth instance, no mailer.
 * export function createMfaResetService(deps: {
 *   authPool: Pool;
 *   notices: RecoveryNoticePort;
 * }): MfaResetService;
 * ```
 *
 * If the real construction or method names differ, the adaptation is `buildService`,
 * `resetAsAdmin` and `resetAsOperator` below, in one place.
 *
 * Tenant-per-test isolation: each test seeds fresh random tenants, users and identifiers, and the
 * service touches only the rows of the user it is given, so the shared test database is safe.
 */
// Load-bearing import order (design D1): the telemetry harness registers before anything that
// loads `@tayzu/auth` creates its logger.
import {
  linkLogEvents,
  registration,
  type TelemetryTestHarness,
} from '../__fixtures__/link-telemetry.js';
import { randomUUID } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';

import { MARKER_EXPIRES_AT_SENTINEL } from '@tayzu/auth';

import { harnessPools } from '../__fixtures__/pools.js';
import { renderMfaResetNotice } from '../../../../packages/auth/src/identity/email/recovery-notice-templates.js';
import { formatResetTokenValue } from '../../../../packages/auth/src/identity/reset-token-value.js';
import { createAuthRepository } from './auth-repository.js';
import {
  createMfaResetService,
  type MfaResetReason,
  type MfaResetResult,
  type MfaResetService,
  type NoticeOutcome,
  type RecoveryNoticePort,
} from './mfa-reset.js';
import { createWithUserLock } from './user-lock.js';

const REVIEW_SENTENCE =
  'Review your service accounts, credentials and linked sign-ins, and revoke any you do not recognize.';
const AUDIT_EVENT = 'catalog.audit.mfa_reset';
const REVOKED_EVENT = 'auth.security.session_revoked';
const SENTINEL_ISO = MARKER_EXPIRES_AT_SENTINEL.toISOString();

interface Sent {
  readonly kind: string;
  readonly userId: string;
}

interface FakeNotices extends RecoveryNoticePort {
  readonly sent: Sent[];
}

describe('The MFA reset service (task 10.3)', () => {
  let harness: TelemetryTestHarness;
  let authPool: Pool;

  beforeAll(async () => {
    if ('error' in registration) {
      throw new Error(`createTelemetryTestHarness() failed: ${String(registration.error)}`, {
        cause: registration.error,
      });
    }
    harness = registration.harness;
    ({ authPool } = await harnessPools());
  }, 60_000);

  // ---- the adaptation points -------------------------------------------------------------

  function buildService(notices: RecoveryNoticePort): MfaResetService {
    return createMfaResetService({ authPool, notices });
  }

  function resetAsAdmin(
    service: MfaResetService,
    input: { tenantId: string; actorId: string; userId: string; reason: MfaResetReason },
  ): Promise<MfaResetResult> {
    return service.resetAdmin(input);
  }

  function resetAsOperator(
    service: MfaResetService,
    input: { tenantId: string; operatorId: string; approverId: string; userId: string },
  ): Promise<MfaResetResult> {
    return service.resetOperator(input);
  }

  // ---- seeds -----------------------------------------------------------------------------

  function fakeNotices(
    outcome: NoticeOutcome = 'sent',
    onSend?: (sent: Sent) => Promise<void>,
  ): FakeNotices {
    const sent: Sent[] = [];
    return {
      sent,
      async send(kind, userId) {
        const entry = { kind, userId };
        sent.push(entry);
        await onSend?.(entry);
        return outcome;
      },
    };
  }

  async function seedTenant(): Promise<string> {
    const id = `org-${randomUUID()}`;
    await authPool.query(
      'insert into auth.organization (id, name, slug, created_at) values ($1, $2, $3, now())',
      [id, 'Org', `slug-${id}`],
    );
    return id;
  }

  async function seedUser(): Promise<string> {
    const id = `usr-${randomUUID()}`;
    await authPool.query(
      'insert into auth."user" (id, name, email, email_verified, created_at, updated_at, two_factor_enabled) values ($1, $2, $3, true, now(), now(), true)',
      [id, 'User', `u-${randomUUID()}@example.test`],
    );
    return id;
  }

  async function seedMember(tenantId: string, userId: string, role: string): Promise<void> {
    await authPool.query(
      'insert into auth.member (id, organization_id, user_id, role, created_at) values ($1, $2, $3, $4, now())',
      [`mem-${randomUUID()}`, tenantId, userId, role],
    );
  }

  async function seedTwoFactor(userId: string): Promise<string> {
    const id = `tf-${randomUUID()}`;
    await authPool.query(
      `insert into auth.two_factor (id, secret, backup_codes, user_id, verified, failed_verification_count)
       values ($1, $2, $3, $4, true, 0)`,
      [id, `enc-secret-${id}`, `enc-codes-${id}`, userId],
    );
    return id;
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

  async function seedVerification(identifier: string, value: string): Promise<void> {
    await authPool.query(
      `insert into auth.verification (id, identifier, value, expires_at, created_at, updated_at)
       values ($1, $2, $3, now() + interval '10 minutes', now(), now())`,
      [randomUUID(), identifier, value],
    );
  }

  interface Target {
    readonly tenantId: string;
    readonly userId: string;
    readonly twoFactorId: string;
    readonly sessionIds: readonly string[];
  }

  /** A member of a fresh tenant with a factor and two sessions (one in the tenant, one in none). */
  async function seedTarget(role = 'member'): Promise<Target> {
    const tenantId = await seedTenant();
    const userId = await seedUser();
    await seedMember(tenantId, userId, role);
    const twoFactorId = await seedTwoFactor(userId);
    const sessionIds = [await seedSession(userId, tenantId), await seedSession(userId, null)];
    return { tenantId, userId, twoFactorId, sessionIds };
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

  async function twoFactorEnabled(userId: string): Promise<boolean | null> {
    const result = await authPool.query<{ two_factor_enabled: boolean | null }>(
      'select two_factor_enabled from auth."user" where id = $1',
      [userId],
    );
    return result.rows[0]?.two_factor_enabled ?? null;
  }

  async function markerRows(userId: string): Promise<{ value: string; expires_at: Date }[]> {
    const result = await authPool.query<{ value: string; expires_at: Date }>(
      'select value, expires_at from auth.verification where identifier = $1',
      [`mfa-reenrol:${userId}`],
    );
    return result.rows;
  }

  async function identifiersPresent(...identifiers: string[]): Promise<string[]> {
    const result = await authPool.query<{ identifier: string }>(
      'select identifier from auth.verification where identifier = any($1::text[]) order by identifier',
      [identifiers],
    );
    return result.rows.map((row) => row.identifier);
  }

  async function eventsFor(name: string, userId: string) {
    return (await linkLogEvents(harness, name)).filter(
      (record) =>
        record.attributes['tayzu.identity.user.id'] === userId ||
        record.attributes['tayzu.actor.id'] === userId,
    );
  }

  /** A credential, a service-account user and an SSO link, with a snapshot of their rows. */
  async function seedCredentialsAndLink(
    tenantId: string,
    userId: string,
  ): Promise<{ snapshot: () => Promise<string> }> {
    const serviceAccountId = `usr-${randomUUID()}`;
    await authPool.query(
      'insert into auth."user" (id, name, email, email_verified, created_at, updated_at) values ($1, $2, $3, true, now(), now())',
      [serviceAccountId, 'Service', `sa-${randomUUID()}@example.test`],
    );
    await seedMember(tenantId, serviceAccountId, 'member');
    const keyId = `key-${randomUUID()}`;
    await authPool.query(
      `insert into auth.apikey (id, name, reference_id, key, config_id, created_at, updated_at)
       values ($1, 'ci', $2, $3, 'machine-credential', now(), now())`,
      [keyId, tenantId, `hashed-${randomUUID()}`],
    );
    const accountId = `acc-${randomUUID()}`;
    await authPool.query(
      `insert into auth.account (id, account_id, provider_id, user_id, created_at, updated_at)
       values ($1, $2, 'visma-connect', $3, now(), now())`,
      [accountId, `sub-${randomUUID()}`, userId],
    );
    const snapshot = async (): Promise<string> => {
      const key = await authPool.query('select * from auth.apikey where id = $1', [keyId]);
      const account = await authPool.query('select * from auth.account where id = $1', [accountId]);
      const service = await authPool.query('select * from auth."user" where id = $1', [
        serviceAccountId,
      ]);
      const memberships = await authPool.query(
        'select * from auth.member where user_id = $1 order by id',
        [serviceAccountId],
      );
      return JSON.stringify([key.rows, account.rows, service.rows, memberships.rows]);
    };
    return { snapshot };
  }

  // ---- scenarios -------------------------------------------------------------------------

  describe('An admin resets a member’s lost factor', () => {
    it('removes the factor, clears the flag, writes the marker, revokes every session and the challenge rows, and leaves the reset links', async () => {
      const target = await seedTarget();
      const suffix = randomUUID();
      await seedVerification(`2fa-${suffix}`, target.userId);
      await seedVerification(`trust-device-${suffix}`, target.userId);
      const resetRow = `password-reset:${suffix}`;
      await seedVerification(
        resetRow,
        formatResetTokenValue({ digest: 'd'.repeat(43), userId: target.userId, failures: 0 }),
      );
      const other = await seedTarget();
      const otherChallenge = `2fa-other-${suffix}`;
      await seedVerification(otherChallenge, other.userId);
      expect(await twoFactorRows(target.userId), 'precondition').toBe(1);
      expect(await sessionRows(target.userId), 'precondition').toBe(2);

      const notices = fakeNotices();
      const result = await resetAsAdmin(buildService(notices), {
        tenantId: target.tenantId,
        actorId: `admin-${randomUUID()}`,
        userId: target.userId,
        reason: 'lost_both_factors',
      });

      expect(await twoFactorRows(target.userId), 'the factor is gone').toBe(0);
      expect(await twoFactorEnabled(target.userId), 'the flag is cleared').toBe(false);
      expect(await sessionRows(target.userId), 'every session is gone, whatever its tenant').toBe(
        0,
      );
      const marker = await markerRows(target.userId);
      expect(marker, 'the re-enrolment marker is written once').toHaveLength(1);
      expect(marker[0]?.expires_at.toISOString()).toBe(SENTINEL_ISO);
      expect(
        await identifiersPresent(
          `2fa-${suffix}`,
          `trust-device-${suffix}`,
          resetRow,
          otherChallenge,
        ),
        'challenge and trust rows go, reset links and other users rows stay',
      ).toEqual([resetRow, otherChallenge].sort());
      expect(result.sessionsRevoked).toBe(2);
      expect(await twoFactorRows(other.userId), 'another user is untouched').toBe(1);
      expect(await sessionRows(other.userId), 'another user is untouched').toBe(2);
      expect(await twoFactorEnabled(other.userId)).toBe(true);
    }, 30_000);

    it('sends exactly one MfaResetNotice to the member, after the commit', async () => {
      const target = await seedTarget();
      let seenAtSend:
        { factors: number; flag: boolean | null; markers: number; sessions: number } | undefined;
      const notices = fakeNotices('sent', async () => {
        // Another connection sees only committed rows.
        seenAtSend = {
          factors: await twoFactorRows(target.userId),
          flag: await twoFactorEnabled(target.userId),
          markers: (await markerRows(target.userId)).length,
          sessions: await sessionRows(target.userId),
        };
      });

      const result = await resetAsAdmin(buildService(notices), {
        tenantId: target.tenantId,
        actorId: `admin-${randomUUID()}`,
        userId: target.userId,
        reason: 'device_replaced',
      });

      expect(notices.sent).toEqual([{ kind: 'MfaResetNotice', userId: target.userId }]);
      expect(seenAtSend, 'the reset was committed when the notice went out').toEqual({
        factors: 0,
        flag: false,
        markers: 1,
        sessions: 0,
      });
      expect(result.notice).toBe('sent');
    }, 30_000);

    it('logs catalog.audit.mfa_reset with the admin id, the reason code and the member’s opaque id, and one session_revoked event of reason mfa_reset per session', async () => {
      const target = await seedTarget();
      const actorId = `admin-${randomUUID()}`;

      await resetAsAdmin(buildService(fakeNotices()), {
        tenantId: target.tenantId,
        actorId,
        userId: target.userId,
        reason: 'suspected_compromise',
      });

      const audit = await eventsFor(AUDIT_EVENT, target.userId);
      expect(audit).toHaveLength(1);
      expect(audit[0]?.attributes).toMatchObject({
        'tayzu.tenant.id': target.tenantId,
        'tayzu.actor.id': actorId,
        'tayzu.identity.user.id': target.userId,
        'tayzu.identity.mfa_reset.reason': 'suspected_compromise',
        'tayzu.identity.sessions.revoked': 2,
      });
      const serialized = JSON.stringify(audit[0]?.attributes);
      expect(serialized, 'no address in the event').not.toContain('@');
      expect(
        'tayzu.identity.operator.id' in (audit[0]?.attributes ?? {}),
        'the admin form carries no operator id',
      ).toBe(false);

      const revoked = (await linkLogEvents(harness, REVOKED_EVENT)).filter(
        (record) => record.attributes['tayzu.actor.id'] === target.userId,
      );
      expect(revoked, 'one event per deleted session').toHaveLength(2);
      for (const event of revoked) {
        expect(event.attributes['tayzu.auth.revocation.reason']).toBe('mfa_reset');
      }
      expect(
        revoked
          .map((event) => event.attributes['tayzu.tenant.id'])
          .filter((tenant) => tenant !== undefined),
        'the tenant of the session that has one; none for the other',
      ).toEqual([target.tenantId]);
    }, 30_000);

    it('runs under the per-user advisory lock', async () => {
      const target = await seedTarget();
      const holder = await authPool.connect();
      try {
        await holder.query('begin');
        await holder.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          target.userId,
        ]);

        let settled = false;
        const running = resetAsAdmin(buildService(fakeNotices()), {
          tenantId: target.tenantId,
          actorId: `admin-${randomUUID()}`,
          userId: target.userId,
          reason: 'lost_both_factors',
        }).finally(() => {
          settled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(settled, 'the reset waits for the lock').toBe(false);
        expect(await twoFactorRows(target.userId), 'nothing changed while it waits').toBe(1);

        await holder.query('commit');
        await running;
      } finally {
        await holder.query('rollback').catch(() => undefined);
        holder.release();
      }
      expect(await twoFactorRows(target.userId)).toBe(0);
    }, 30_000);
  });

  describe('An MFA reset leaves credentials and linked sign-ins, and the notice says to review them', () => {
    it('admin form: the link and the credential are unchanged and the MfaResetNotice carries the fixed review sentence', async () => {
      const target = await seedTarget();
      const { snapshot } = await seedCredentialsAndLink(target.tenantId, target.userId);
      const before = await snapshot();
      const notices = fakeNotices();

      await resetAsAdmin(buildService(notices), {
        tenantId: target.tenantId,
        actorId: `admin-${randomUUID()}`,
        userId: target.userId,
        reason: 'identity_verified_request',
      });

      expect(await snapshot(), 'credential, service account and SSO link are unchanged').toBe(
        before,
      );
      expect(notices.sent).toEqual([{ kind: 'MfaResetNotice', userId: target.userId }]);
      const rendered = renderMfaResetNotice({ kind: 'MfaResetNotice' });
      expect(rendered.text).toContain(REVIEW_SENTENCE);
      expect(rendered.html).toContain(REVIEW_SENTENCE);
    }, 30_000);

    it('operator form: the link and the credential are unchanged and the MfaResetNotice is the same fixed notice', async () => {
      const target = await seedTarget();
      const { snapshot } = await seedCredentialsAndLink(target.tenantId, target.userId);
      const before = await snapshot();
      const notices = fakeNotices();

      await resetAsOperator(buildService(notices), {
        tenantId: target.tenantId,
        operatorId: `op-${randomUUID()}`,
        approverId: `ap-${randomUUID()}`,
        userId: target.userId,
      });

      expect(await snapshot(), 'credential, service account and SSO link are unchanged').toBe(
        before,
      );
      expect(notices.sent).toEqual([{ kind: 'MfaResetNotice', userId: target.userId }]);
      expect(await twoFactorRows(target.userId), 'the reset itself happened').toBe(0);
    }, 30_000);
  });

  describe('The operator form', () => {
    it('the operator form logs tayzu.identity.operator.id and tayzu.identity.approver.id', async () => {
      const target = await seedTarget('admin');
      const operatorId = `op-${randomUUID()}`;
      const approverId = `ap-${randomUUID()}`;

      const result = await resetAsOperator(buildService(fakeNotices()), {
        tenantId: target.tenantId,
        operatorId,
        approverId,
        userId: target.userId,
      });

      expect(result.sessionsRevoked).toBe(2);
      expect(await twoFactorRows(target.userId)).toBe(0);
      expect(await twoFactorEnabled(target.userId)).toBe(false);
      expect(await markerRows(target.userId)).toHaveLength(1);
      expect(await sessionRows(target.userId)).toBe(0);

      const audit = await eventsFor(AUDIT_EVENT, target.userId);
      expect(audit).toHaveLength(1);
      expect(audit[0]?.attributes).toMatchObject({
        'tayzu.tenant.id': target.tenantId,
        'tayzu.identity.operator.id': operatorId,
        'tayzu.identity.approver.id': approverId,
        'tayzu.identity.user.id': target.userId,
        'tayzu.identity.sessions.revoked': 2,
      });
      expect(
        'tayzu.actor.id' in (audit[0]?.attributes ?? {}),
        'the operator form names no admin',
      ).toBe(false);
      expect(
        'tayzu.identity.mfa_reset.reason' in (audit[0]?.attributes ?? {}),
        'the operator form carries no reason code',
      ).toBe(false);
    }, 30_000);
  });

  describe('The notice port', () => {
    it('the service is constructed with only a repository port and a notice port, and a fake notice port sees exactly one MfaResetNotice send and its outcome is returned', async () => {
      for (const outcome of ['sent', 'suppressed', 'failed'] as const) {
        const target = await seedTarget();
        const notices = fakeNotices(outcome);
        // Exactly two dependencies: no Better Auth instance, no mailer, no sender.
        const service = createMfaResetService({ authPool, notices });

        const result = await service.resetAdmin({
          tenantId: target.tenantId,
          actorId: `admin-${randomUUID()}`,
          userId: target.userId,
          reason: 'lost_both_factors',
        });

        expect(notices.sent, outcome).toEqual([{ kind: 'MfaResetNotice', userId: target.userId }]);
        expect(result.notice, outcome).toBe(outcome);
        expect(await twoFactorRows(target.userId), `${outcome}: the reset stands`).toBe(0);
      }
    }, 60_000);

    it('the operator form sees exactly one MfaResetNotice send and its outcome is returned', async () => {
      for (const outcome of ['sent', 'suppressed', 'failed'] as const) {
        const target = await seedTarget();
        const notices = fakeNotices(outcome);

        const result = await resetAsOperator(buildService(notices), {
          tenantId: target.tenantId,
          operatorId: `op-${randomUUID()}`,
          approverId: `ap-${randomUUID()}`,
          userId: target.userId,
        });

        expect(notices.sent, outcome).toEqual([{ kind: 'MfaResetNotice', userId: target.userId }]);
        expect(result.notice, outcome).toBe(outcome);
      }
    }, 60_000);
  });

  // ---- task 10.4: the single refusal path of the admin form (design D10, Q12) ------------

  /** What a caller can see of a refusal: every own property, the name and the message. */
  function visible(error: Error): string {
    return JSON.stringify({
      name: error.name,
      message: error.message,
      own: Object.fromEntries(Object.entries(error)),
    });
  }

  /** Runs `fn`, expects it to throw, and returns the error (a success fails the assertion). */
  async function refusalOf(fn: () => Promise<unknown>): Promise<Error> {
    let thrown: unknown;
    let resolved = false;
    try {
      await fn();
      resolved = true;
    } catch (error) {
      thrown = error;
    }
    expect(resolved, 'the admin form refuses; it must not complete').toBe(false);
    expect(thrown).toBeInstanceOf(Error);
    return thrown as Error;
  }

  /** The admin form's call for a target, with a random acting admin unless one is given. */
  function adminCall(
    service: MfaResetService,
    target: { tenantId: string; userId: string },
    actorId = `admin-${randomUUID()}`,
  ): () => Promise<MfaResetResult> {
    return () =>
      resetAsAdmin(service, {
        tenantId: target.tenantId,
        actorId,
        userId: target.userId,
        reason: 'lost_both_factors',
      });
  }

  /** A member with sessions but no enrolled factor (flag off, no row). */
  async function seedNoFactorTarget(role = 'member'): Promise<Target> {
    const target = await seedTarget(role);
    await authPool.query('delete from auth.two_factor where user_id = $1', [target.userId]);
    await authPool.query('update auth."user" set two_factor_enabled = false where id = $1', [
      target.userId,
    ]);
    return target;
  }

  /** The same user also belongs to a second, fresh tenant. */
  async function addSecondTenant(userId: string): Promise<string> {
    const otherTenantId = await seedTenant();
    await seedMember(otherTenantId, userId, 'member');
    return otherTenantId;
  }

  interface Observed {
    readonly factors: number;
    readonly flag: boolean | null;
    readonly sessions: number;
    readonly markers: number;
    readonly memberships: number;
  }

  async function observe(userId: string): Promise<Observed> {
    return {
      factors: await twoFactorRows(userId),
      flag: await twoFactorEnabled(userId),
      sessions: await sessionRows(userId),
      markers: (await markerRows(userId)).length,
      memberships: await count('from auth.member where user_id = $1', [userId]),
    };
  }

  async function expectRefusedAndUnchanged(
    target: Target,
    notices: FakeNotices,
    run: () => Promise<unknown>,
  ): Promise<Error> {
    const before = await observe(target.userId);
    const error = await refusalOf(run);
    expect(await observe(target.userId), 'nothing changes').toEqual(before);
    expect(await markerRows(target.userId), 'no re-enrolment marker').toHaveLength(0);
    expect(notices.sent, 'no notice goes out').toEqual([]);
    expect(await eventsFor(AUDIT_EVENT, target.userId), 'no audit event of a reset').toHaveLength(
      0,
    );
    expect(
      (await linkLogEvents(harness, REVOKED_EVENT)).filter(
        (record) => record.attributes['tayzu.actor.id'] === target.userId,
      ),
      'no session is revoked',
    ).toHaveLength(0);
    return error;
  }

  /** The answer the caller gets, whatever the internal reason. */
  function expectValidationFailed(error: Error): void {
    expect((error as Error & { code?: unknown }).code).toBe('CATALOG_VALIDATION_FAILED');
  }

  /** Wraps the pool so that every statement the service sends is recorded, on any connection. */
  function countingPool(): { pool: Pool; statements: string[] } {
    const statements: string[] = [];
    type AnyFn = (...args: unknown[]) => unknown;
    const record = (first: unknown): void => {
      const text =
        typeof first === 'string' ? first : (first as { text?: string } | undefined)?.text;
      statements.push((text ?? '').replace(/\s+/g, ' ').trim());
    };
    const wrap = <T extends object>(subject: T): T =>
      new Proxy(subject, {
        get(target, property) {
          const value: unknown = Reflect.get(target, property, target);
          if (typeof value !== 'function') return value;
          const fn = value as AnyFn;
          if (property === 'query') {
            return (...args: unknown[]) => {
              record(args[0]);
              return fn.apply(target, args);
            };
          }
          if (property === 'connect') {
            return async (...args: unknown[]) => {
              const connected = await (fn.apply(target, args) as Promise<object | undefined>);
              return connected === undefined ? connected : wrap(connected);
            };
          }
          return fn.bind(target);
        },
      });
    return { pool: wrap(authPool), statements };
  }

  describe('A target with no second factor is refused', () => {
    it('answers CATALOG_VALIDATION_FAILED, changes nothing and logs no_enrolled_factor', async () => {
      const target = await seedNoFactorTarget();
      const actorId = `admin-${randomUUID()}`;
      const notices = fakeNotices();

      const error = await expectRefusedAndUnchanged(
        target,
        notices,
        adminCall(buildService(notices), target, actorId),
      );

      expectValidationFailed(error);
      const refused = await eventsFor('catalog.security.identity_conflict_refused', target.userId);
      expect(refused).toHaveLength(1);
      expect(refused[0]?.attributes).toMatchObject({
        'tayzu.tenant.id': target.tenantId,
        'tayzu.actor.id': actorId,
        'tayzu.identity.conflict.reason': 'no_enrolled_factor',
        'tayzu.identity.user.id': target.userId,
      });
    }, 30_000);
  });

  describe('A member of several tenants is refused', () => {
    it('answers CATALOG_VALIDATION_FAILED, changes nothing, logs target_in_other_tenant and does not reveal the other tenant', async () => {
      const target = await seedTarget();
      const otherTenantId = await addSecondTenant(target.userId);
      const actorId = `admin-${randomUUID()}`;
      const notices = fakeNotices();

      const error = await expectRefusedAndUnchanged(
        target,
        notices,
        adminCall(buildService(notices), target, actorId),
      );

      expectValidationFailed(error);
      expect(visible(error), 'the answer does not name the other tenant').not.toContain(
        otherTenantId,
      );
      const refused = await eventsFor('catalog.security.identity_conflict_refused', target.userId);
      expect(refused).toHaveLength(1);
      expect(refused[0]?.attributes).toMatchObject({
        'tayzu.tenant.id': target.tenantId,
        'tayzu.actor.id': actorId,
        'tayzu.identity.conflict.reason': 'target_in_other_tenant',
        'tayzu.identity.user.id': target.userId,
      });
      expect(await twoFactorRows(target.userId), 'the other tenant keeps the factor').toBe(1);
    }, 30_000);
  });

  describe('An admin or owner target is refused', () => {
    for (const role of ['admin', 'owner']) {
      it(`a ${role} target: CATALOG_VALIDATION_FAILED without the policy bundle, nothing changes, logs target_is_admin_or_owner`, async () => {
        const target = await seedTarget(role);
        const actorId = `admin-${randomUUID()}`;
        const notices = fakeNotices();

        const error = await expectRefusedAndUnchanged(
          target,
          notices,
          adminCall(buildService(notices), target, actorId),
        );

        expectValidationFailed(error);
        const refused = await eventsFor(
          'catalog.security.identity_conflict_refused',
          target.userId,
        );
        expect(refused).toHaveLength(1);
        expect(refused[0]?.attributes).toMatchObject({
          'tayzu.tenant.id': target.tenantId,
          'tayzu.actor.id': actorId,
          'tayzu.identity.conflict.reason': 'target_is_admin_or_owner',
          'tayzu.identity.user.id': target.userId,
        });
        expect(await twoFactorRows(target.userId), 'the factor stays').toBe(1);
      }, 30_000);
    }

    it('a composite role such as admin,owner is refused like an admin', async () => {
      const target = await seedTarget('admin,owner');
      const notices = fakeNotices();

      const error = await expectRefusedAndUnchanged(
        target,
        notices,
        adminCall(buildService(notices), target),
      );

      expectValidationFailed(error);
    }, 30_000);
  });

  describe('Self-target is refused', () => {
    it('answers CATALOG_VALIDATION_FAILED without the policy bundle, changes nothing and logs self_mfa_reset_denied with the tenant and the admin id', async () => {
      const target = await seedTarget('admin');
      const notices = fakeNotices();

      const error = await expectRefusedAndUnchanged(
        target,
        notices,
        adminCall(buildService(notices), target, target.userId),
      );

      expectValidationFailed(error);
      const denied = await eventsFor('catalog.security.self_mfa_reset_denied', target.userId);
      expect(denied).toHaveLength(1);
      expect(denied[0]?.attributes).toMatchObject({
        'tayzu.tenant.id': target.tenantId,
        'tayzu.actor.id': target.userId,
      });
      expect(await twoFactorRows(target.userId), 'the factor stays').toBe(1);
    }, 30_000);

    it('a member acting on their own account is refused too', async () => {
      const target = await seedTarget('member');
      const notices = fakeNotices();

      const error = await expectRefusedAndUnchanged(
        target,
        notices,
        adminCall(buildService(notices), target, target.userId),
      );

      expectValidationFailed(error);
      expect(await eventsFor('catalog.security.self_mfa_reset_denied', target.userId)).toHaveLength(
        1,
      );
    }, 30_000);
  });

  describe('The refusals are indistinguishable', () => {
    it('no factor, two tenants, and both give the same status, code, message and body bytes, each with its own internal reason, and nothing changes', async () => {
      const noFactor = await seedNoFactorTarget();
      const twoTenants = await seedTarget();
      await addSecondTenant(twoTenants.userId);
      const both = await seedNoFactorTarget();
      await addSecondTenant(both.userId);
      const notices = fakeNotices();
      const service = buildService(notices);

      const errors: Error[] = [];
      for (const target of [noFactor, twoTenants, both]) {
        errors.push(await expectRefusedAndUnchanged(target, notices, adminCall(service, target)));
      }

      const [first, second, third] = errors.map(visible);
      expect(second, 'two tenants reads like no factor').toBe(first);
      expect(third, 'both reads like no factor').toBe(first);
      for (const error of errors) {
        expectValidationFailed(error);
        expect(error.message).not.toMatch(/factor|tenant|organi[sz]ation|member|admin/i);
      }
      const statuses = new Set(
        errors.map((error) => (error as Error & { status?: unknown }).status),
      );
      expect(statuses.size, 'one status for all').toBe(1);

      const reasonOf = async (target: Target): Promise<unknown[]> =>
        (await eventsFor('catalog.security.identity_conflict_refused', target.userId)).map(
          (record) => record.attributes['tayzu.identity.conflict.reason'],
        );
      expect(await reasonOf(noFactor)).toEqual(['no_enrolled_factor']);
      expect(await reasonOf(twoTenants)).toEqual(['target_in_other_tenant']);
      const bothReasons = await reasonOf(both);
      expect(bothReasons, 'one internal record for the refusal').toHaveLength(1);
      expect(['no_enrolled_factor', 'target_in_other_tenant']).toContain(bothReasons[0]);
    }, 60_000);
  });

  describe('Every refusal reads every predicate', () => {
    it('a read-counting fake sees the same reads for no factor, other tenant, both, admin, owner and self, and none of them writes', async () => {
      const cases: { label: string; target: Target; self: boolean }[] = [];
      cases.push({ label: 'no factor', target: await seedNoFactorTarget(), self: false });
      const twoTenants = await seedTarget();
      await addSecondTenant(twoTenants.userId);
      cases.push({ label: 'other tenant', target: twoTenants, self: false });
      const both = await seedNoFactorTarget();
      await addSecondTenant(both.userId);
      cases.push({ label: 'both', target: both, self: false });
      cases.push({ label: 'admin', target: await seedTarget('admin'), self: false });
      cases.push({ label: 'owner', target: await seedTarget('owner'), self: false });
      cases.push({ label: 'self', target: await seedTarget('member'), self: true });

      const sequences = new Map<string, string[]>();
      for (const { label, target, self } of cases) {
        const { pool, statements } = countingPool();
        const service = createMfaResetService({ authPool: pool, notices: fakeNotices() });
        await refusalOf(adminCall(service, target, self ? target.userId : `admin-${randomUUID()}`));
        sequences.set(label, [...statements]);
      }

      const reference = sequences.get('no factor') ?? [];
      expect(reference.length, 'the refusal reads from the database').toBeGreaterThan(0);
      for (const [label, statements] of sequences) {
        expect(statements, `${label}: the same statements, in the same order`).toEqual(reference);
        expect(
          statements.filter((text) => /^\s*(insert|update|delete)\b/i.test(text)),
          `${label}: a refusal writes nothing`,
        ).toEqual([]);
      }
    }, 60_000);
  });

  describe('The operator path accepts what the admin form refuses', () => {
    for (const role of ['admin', 'owner']) {
      it(`the operator path accepts ${role === 'admin' ? 'an admin' : 'an owner'}`, async () => {
        const target = await seedTarget(role);
        const notices = fakeNotices();

        const result = await resetAsOperator(buildService(notices), {
          tenantId: target.tenantId,
          operatorId: `op-${randomUUID()}`,
          approverId: `ap-${randomUUID()}`,
          userId: target.userId,
        });

        expect(result.sessionsRevoked).toBe(2);
        expect(await twoFactorRows(target.userId)).toBe(0);
        expect(await twoFactorEnabled(target.userId)).toBe(false);
        expect(await markerRows(target.userId)).toHaveLength(1);
        expect(await sessionRows(target.userId)).toBe(0);
        expect(notices.sent).toEqual([{ kind: 'MfaResetNotice', userId: target.userId }]);
      }, 30_000);
    }

    it('the operator path accepts a member of several tenants and ends their sessions in all of them', async () => {
      const target = await seedTarget();
      const otherTenantId = await addSecondTenant(target.userId);
      await seedSession(target.userId, otherTenantId);
      const notices = fakeNotices();

      const result = await resetAsOperator(buildService(notices), {
        tenantId: target.tenantId,
        operatorId: `op-${randomUUID()}`,
        approverId: `ap-${randomUUID()}`,
        userId: target.userId,
      });

      expect(result.sessionsRevoked).toBe(3);
      expect(await twoFactorRows(target.userId)).toBe(0);
      expect(await twoFactorEnabled(target.userId)).toBe(false);
      expect(await markerRows(target.userId)).toHaveLength(1);
      expect(await sessionRows(target.userId)).toBe(0);
      expect(notices.sent).toEqual([{ kind: 'MfaResetNotice', userId: target.userId }]);
      expect(
        await eventsFor('catalog.security.identity_conflict_refused', target.userId),
        'no refusal is logged',
      ).toHaveLength(0);
    }, 30_000);
  });

  // ---- fix cycle of task 16.2 (N3): the predicates are read under the lock (D10, Q36) ----
  //
  // design.md D10, "The predicates are read under the lock (Q36)": "The admin path reads its
  // predicates inside the per-user lock, on the lock's connection, in the transaction that then
  // applies the effects, so the state a reset is decided on is the state it changes. A reset that
  // waited for the lock re-reads: if the factor was removed meanwhile (a second reset of the same
  // member), or the member joined another tenant or stopped being a plain member, it is refused
  // through the same single path and nothing changes (the transaction rolls back). The refusal's
  // log event and error are unchanged."
  //
  // Spec scenario "A change that lands while the reset waits for the lock is seen":
  // - GIVEN a member with a second factor, and another operation that holds that member's lock
  // - WHEN an admin calls the operation and, before the lock is released, the member's factor is
  //   removed, or the member becomes an admin, or the member joins another tenant
  // - THEN the answer is `CATALOG_VALIDATION_FAILED`, nothing changes, and no audit event or
  //   notice is produced
  //
  // The design leaves open whether a refusal runs inside the `identity.mfa.reset` span, so no case
  // here asserts that span on a refusal, present or absent.

  const REFUSED_EVENT = 'catalog.security.identity_conflict_refused';

  type Db = Pick<Pool, 'query'>;
  type AnyFn = (...args: unknown[]) => unknown;

  const normalized = (first: unknown): string => {
    const text = typeof first === 'string' ? first : (first as { text?: string } | undefined)?.text;
    return (text ?? '').replace(/\s+/g, ' ').trim();
  };

  /**
   * Everything a reset would change (factor rows, the flag, sessions, the marker) and the
   * memberships the predicates read, by id, on the connection given. No timestamp is selected.
   */
  async function stateOn(db: Db, userId: string): Promise<string> {
    const rows = async (sql: string, params: unknown[]): Promise<Record<string, unknown>[]> =>
      (await db.query<Record<string, unknown>>(sql, params)).rows;
    return JSON.stringify({
      factors: await rows(
        'select id, verified from auth.two_factor where user_id = $1 order by id',
        [userId],
      ),
      flag: await rows('select two_factor_enabled from auth."user" where id = $1', [userId]),
      sessions: await rows('select id from auth.session where user_id = $1 order by id', [userId]),
      markers: await rows('select identifier, value from auth.verification where identifier = $1', [
        `mfa-reenrol:${userId}`,
      ]),
      memberships: await rows(
        'select organization_id, role from auth.member where user_id = $1 order by organization_id',
        [userId],
      ),
    });
  }

  /** How many backends wait, not granted, for the advisory lock keyed by this user id. */
  function lockWaiters(userId: string): Promise<number> {
    return count(
      `from pg_locks
       where locktype = 'advisory' and granted = false and objsubid = 1
         and database = (select oid from pg_database where datname = current_database())
         and ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`,
      [userId],
    );
  }

  interface Settled {
    readonly completed: boolean;
    readonly error?: unknown;
  }

  /**
   * Another operation holds the member's lock (`createWithUserLock`, as production takes it). While
   * it is held the admin call starts and is not awaited; the holder waits until that call is
   * blocked on the advisory lock (`pg_locks`, not a delay), applies `change` on its own
   * transaction and commits, which lands the change and releases the lock at once. Returns how the
   * call settled and the state the change left, read on the holder's transaction.
   */
  async function changeWhileResetWaits(
    userId: string,
    call: () => Promise<unknown>,
    change: (tx: PoolClient) => Promise<void>,
  ): Promise<{ settled: Settled; left: string }> {
    const holdLock = createWithUserLock(authPool);
    const held = await holdLock(userId, async (tx) => {
      const progress = { settled: false };
      const outcome = call()
        .then(
          (): Settled => ({ completed: true }),
          (error: unknown): Settled => ({ completed: false, error }),
        )
        .finally(() => {
          progress.settled = true;
        });
      const deadline = Date.now() + 15_000;
      while ((await lockWaiters(userId)) === 0) {
        if (progress.settled) {
          throw new Error('the admin reset settled without waiting for the per-user lock');
        }
        if (Date.now() > deadline) {
          throw new Error('the admin reset never waited for the per-user lock');
        }
        // The pause between two polls of `pg_locks`; the condition, not the pause, synchronizes.
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await change(tx);
      return { outcome, left: await stateOn(tx, userId) };
    });
    return { settled: await held.outcome, left: held.left };
  }

  /**
   * The scenario for one concurrent change: the reset that waited is refused like any other
   * refusal, leaves the member exactly as the change left them, and produces no audit event, no
   * notice and no revoked session; the internal record carries `reason`.
   */
  async function expectLateChangeSeen(
    target: Target,
    change: (tx: PoolClient) => Promise<void>,
    reason: 'no_enrolled_factor' | 'target_is_admin_or_owner' | 'target_in_other_tenant',
    leftByTheChange: Observed,
  ): Promise<void> {
    // An ordinary refusal, with no lock contention: what "the same error" means.
    const ordinary = await refusalOf(
      adminCall(buildService(fakeNotices()), await seedNoFactorTarget()),
    );
    const actorId = `admin-${randomUUID()}`;
    const notices = fakeNotices();
    expect(await observe(target.userId), 'precondition: a plain member with a factor').toEqual({
      factors: 1,
      flag: true,
      sessions: 2,
      markers: 0,
      memberships: 1,
    });

    const { settled, left } = await changeWhileResetWaits(
      target.userId,
      adminCall(buildService(notices), target, actorId),
      change,
    );

    expect(
      settled.completed,
      'the reset that waited for the lock decides on the state it finds: it must not complete',
    ).toBe(false);
    expect(settled.error).toBeInstanceOf(Error);
    const error = settled.error as Error;
    expectValidationFailed(error);
    expect(error.message, 'the same message as the other refusals').toBe(ordinary.message);
    expect(visible(error), 'the same single error as the other refusals').toBe(visible(ordinary));

    expect(
      await stateOn(authPool, target.userId),
      'factor rows, the flag, sessions, the marker and memberships are as the change left them',
    ).toBe(left);
    expect(await observe(target.userId), 'nothing the reset would do happened').toEqual(
      leftByTheChange,
    );
    expect(await eventsFor(AUDIT_EVENT, target.userId), 'no audit event of a reset').toHaveLength(
      0,
    );
    expect(
      (await linkLogEvents(harness, REVOKED_EVENT)).filter(
        (record) => record.attributes['tayzu.actor.id'] === target.userId,
      ),
      'no session is revoked',
    ).toHaveLength(0);
    expect(notices.sent, 'the notice port saw no send').toEqual([]);

    const refused = await eventsFor(REFUSED_EVENT, target.userId);
    expect(refused, 'one internal record of the refusal').toHaveLength(1);
    expect(refused[0]?.attributes).toMatchObject({
      'tayzu.tenant.id': target.tenantId,
      'tayzu.actor.id': actorId,
      'tayzu.identity.conflict.reason': reason,
      'tayzu.identity.user.id': target.userId,
    });
  }

  describe('A change that lands while the reset waits for the lock is seen', () => {
    it('the member’s factor is removed: CATALOG_VALIDATION_FAILED, nothing changes, no audit event or notice, logs no_enrolled_factor', async () => {
      const target = await seedTarget();

      await expectLateChangeSeen(
        target,
        async (tx) => {
          // What a second reset of the same member does to the factor, and nothing else.
          await tx.query('delete from auth.two_factor where user_id = $1', [target.userId]);
          await tx.query('update auth."user" set two_factor_enabled = false where id = $1', [
            target.userId,
          ]);
        },
        'no_enrolled_factor',
        // The sessions stay and no marker is written: the refused reset did neither.
        { factors: 0, flag: false, sessions: 2, markers: 0, memberships: 1 },
      );
    }, 60_000);

    it('the member becomes an admin: CATALOG_VALIDATION_FAILED, nothing changes, no audit event or notice, logs target_is_admin_or_owner', async () => {
      const target = await seedTarget();

      await expectLateChangeSeen(
        target,
        async (tx) => {
          await tx.query(
            'update auth.member set role = $3 where organization_id = $1 and user_id = $2',
            [target.tenantId, target.userId, 'admin'],
          );
        },
        'target_is_admin_or_owner',
        { factors: 1, flag: true, sessions: 2, markers: 0, memberships: 1 },
      );

      const role = await authPool.query<{ role: string }>(
        'select role from auth.member where organization_id = $1 and user_id = $2',
        [target.tenantId, target.userId],
      );
      expect(
        role.rows.map((row) => row.role),
        'the promotion landed',
      ).toEqual(['admin']);
    }, 60_000);

    it('the member joins another tenant: CATALOG_VALIDATION_FAILED, nothing changes, no audit event or notice, logs target_in_other_tenant', async () => {
      const target = await seedTarget();
      const otherTenantId = await seedTenant();

      await expectLateChangeSeen(
        target,
        async (tx) => {
          await tx.query(
            'insert into auth.member (id, organization_id, user_id, role, created_at) values ($1, $2, $3, $4, now())',
            [`mem-${randomUUID()}`, otherTenantId, target.userId, 'member'],
          );
        },
        'target_in_other_tenant',
        { factors: 1, flag: true, sessions: 2, markers: 0, memberships: 2 },
      );

      expect(
        await count('from auth.member where organization_id = $1 and user_id = $2', [
          otherTenantId,
          target.userId,
        ]),
        'the second membership landed',
      ).toBe(1);
    }, 60_000);
  });

  describe('The predicates of the admin form are read under the lock (design D10, Q36)', () => {
    interface Probed {
      /** `'pool'` for `pool.query`; otherwise the ordinal of the client `pool.connect` gave. */
      readonly via: 'pool' | number;
      readonly text: string;
    }

    /** Wraps the pool so that a statement sent with `pool.query` is told from one sent on a client. */
    function probedPool(): { pool: Pool; seen: Probed[] } {
      const seen: Probed[] = [];
      let clients = 0;
      const probe = <T extends object>(subject: T, via: 'pool' | number): T =>
        new Proxy(subject, {
          get(target, property) {
            const value: unknown = Reflect.get(target, property, target);
            if (typeof value !== 'function') return value;
            const fn = value as AnyFn;
            if (property === 'query') {
              return (...args: unknown[]) => {
                seen.push({ via, text: normalized(args[0]) });
                return fn.apply(target, args);
              };
            }
            if (property === 'connect' && via === 'pool') {
              return async (...args: unknown[]) => {
                const connected = await (fn.apply(target, args) as Promise<object | undefined>);
                if (connected === undefined) return connected;
                clients += 1;
                return probe(connected, clients);
              };
            }
            return fn.bind(target);
          },
        });
      return { pool: probe(authPool, 'pool'), seen };
    }

    /**
     * The statements of the three predicate reads, as the repository itself sends them: the
     * two-factor state, the membership tenants and the member row. Taken from the repository, so
     * the case below depends on no SQL text of its own.
     */
    async function predicateStatements(
      target: Target,
    ): Promise<Record<'twoFactorState' | 'membershipTenants' | 'memberRow', string[]>> {
      const texts: string[] = [];
      const recorder = {
        query: (...args: unknown[]): unknown => {
          texts.push(normalized(args[0]));
          return (authPool.query as AnyFn).apply(authPool, args);
        },
      } as unknown as Pool;
      const repository = createAuthRepository(recorder);
      await repository.globalTwoFactorStateOf(target.userId);
      const twoFactorState = texts.splice(0);
      await repository.globalMembershipTenantsOf(target.userId);
      const membershipTenants = texts.splice(0);
      await repository.memberOf(target.tenantId, target.userId);
      const memberRow = texts.splice(0);
      return { twoFactorState, membershipTenants, memberRow };
    }

    const ON_THE_LOCK_CLIENT = 'on the client that took the lock, after the lock statement';

    it('the predicate reads of the admin form run on the lock’s connection', async () => {
      const allowed = await seedTarget();
      const refused = await seedTarget();
      await addSecondTenant(refused.userId);

      for (const { label, target, refusal } of [
        { label: 'a reset that goes through', target: allowed, refusal: false },
        { label: 'a refusal', target: refused, refusal: true },
      ]) {
        const reads = await predicateStatements(target);
        for (const [name, texts] of Object.entries(reads)) {
          expect(texts.length, `${label}: the ${name} read sends a statement`).toBeGreaterThan(0);
        }
        const { pool, seen } = probedPool();
        const call = adminCall(createMfaResetService({ authPool: pool, notices: fakeNotices() }), {
          tenantId: target.tenantId,
          userId: target.userId,
        });
        if (refusal) await refusalOf(call);
        else await call();

        const lockAt = seen.findIndex((statement) => /pg_advisory_xact_lock/.test(statement.text));
        const lockClient = seen[lockAt]?.via;
        expect(typeof lockClient, `${label}: the lock is taken on a connected client`).toBe(
          'number',
        );

        /** Where each occurrence of one predicate statement ran, without repeats. */
        const placesOf = (text: string): string[] => [
          ...new Set(
            seen.flatMap((statement, index) => {
              if (statement.text !== text) return [];
              if (statement.via === 'pool') return ['on pool.query'];
              if (statement.via !== lockClient) return ['on another client'];
              return [
                index > lockAt ? ON_THE_LOCK_CLIENT : 'on the client that took the lock, before it',
              ];
            }),
          ),
        ];
        const where = Object.fromEntries(
          Object.entries(reads).map(([name, texts]) => [name, texts.map(placesOf)]),
        );
        expect(where, `${label}: the three predicate reads, none of them on pool.query`).toEqual(
          Object.fromEntries(
            Object.entries(reads).map(([name, texts]) => [
              name,
              texts.map(() => [ON_THE_LOCK_CLIENT]),
            ]),
          ),
        );
        expect(
          seen.filter(
            (statement) =>
              statement.via === 'pool' && Object.values(reads).flat().includes(statement.text),
          ),
          `${label}: pool.query sees no predicate read`,
        ).toEqual([]);
      }
    }, 60_000);

    it('with a pool of one connection the admin reset completes', async () => {
      // A guard, green on arrival: today the predicates are read through the pool before the lock
      // is taken, so one connection is enough. It stays green only if the in-lock reads run on the
      // lock's connection: a read through `pool.query` while the lock's client is checked out
      // would wait for a second connection that a pool of one never has.
      const url = process.env['DATABASE_URL'];
      if (url === undefined || url.trim() === '') throw new Error('DATABASE_URL is not set');
      const single = new Pool({ connectionString: url, max: 1 });
      single.on('error', () => undefined);
      let timer: NodeJS.Timeout | undefined;
      try {
        const target = await seedTarget();
        const notices = fakeNotices();
        const service = createMfaResetService({ authPool: single, notices });

        const outcome = await Promise.race([
          adminCall(service, target)(),
          new Promise<'hung'>((resolve) => {
            timer = setTimeout(() => {
              resolve('hung');
            }, 20_000);
          }),
        ]);

        expect(outcome, 'the reset did not wait for a second connection').not.toBe('hung');
        if (outcome === 'hung') return;
        expect(single.totalCount, 'the pool never grew past one').toBeLessThanOrEqual(1);
        expect(outcome.sessionsRevoked).toBe(2);
        expect(await observe(target.userId), 'the reset happened').toEqual({
          factors: 0,
          flag: false,
          sessions: 0,
          markers: 1,
          memberships: 1,
        });
        expect(notices.sent).toEqual([{ kind: 'MfaResetNotice', userId: target.userId }]);
      } finally {
        clearTimeout(timer);
        const giveUp = new Promise<void>((resolve) => setTimeout(resolve, 5000));
        await Promise.race([single.end(), giveUp]);
      }
    }, 60_000);
  });
});
