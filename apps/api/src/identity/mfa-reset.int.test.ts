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
import type { Pool } from 'pg';

import { MARKER_EXPIRES_AT_SENTINEL } from '@tayzu/auth';

import { harnessPools } from '../__fixtures__/pools.js';
import { renderMfaResetNotice } from '../../../../packages/auth/src/identity/email/recovery-notice-templates.js';
import { formatResetTokenValue } from '../../../../packages/auth/src/identity/reset-token-value.js';
import {
  createMfaResetService,
  type MfaResetReason,
  type MfaResetResult,
  type MfaResetService,
  type NoticeOutcome,
  type RecoveryNoticePort,
} from './mfa-reset.js';

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
});
