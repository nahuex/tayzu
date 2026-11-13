/**
 * Task 5.2 of openspec/changes/044-password-reset-and-account-recovery (design D4, Resolved
 * decision Q4).
 *
 * Scenarios (specs/password-reset-and-account-recovery/spec.md, requirement "Only a
 * recoverable account receives a reset email"):
 *
 * - "An SSO-only user gets no password through a reset"        (eligibility level)
 * - "A user linked to Visma Connect with a local password can reset" (eligibility level)
 * - "Disabled everywhere is not recoverable, disabled somewhere is"
 * - "The address is canonicalized"
 *
 * Plus cases for a banned user, a user with no membership, an unknown address and a
 * membership with no `_user` row.
 *
 * ## Production symbols expected (none exists yet)
 *
 * ```ts
 * // apps/api/src/identity/recovery-eligibility.ts
 * export type RecoveryEligibilityStatus =
 *   | 'eligible' | 'unknown_address' | 'no_credential_account'
 *   | 'banned' | 'disabled_everywhere' | 'no_membership';
 * export interface RecoveryEligibility {
 *   readonly status: RecoveryEligibilityStatus;
 *   // The canonical form of the address that every lookup used.
 *   readonly email: string;
 *   // Present when status is 'eligible': the Better Auth user id and the tenant ids of ALL
 *   // the user's memberships (the mailer's tenant checks), in any order.
 *   readonly userId?: string;
 *   readonly tenantIds?: readonly string[];
 * }
 * export interface RecoveryEligibilityChecker {
 *   check: (rawEmail: string) => Promise<RecoveryEligibility>;
 * }
 * export function createRecoveryEligibility(options: {
 *   authPool: Pool;                                   // read through createAuthRepository
 *   userSync: Pick<UserSyncAdapter, 'readStatus'>;    // ./user-sync-adapter.js
 * }): RecoveryEligibilityChecker;
 * ```
 *
 * `readStatus` is called per membership tenant with the canonical email. The tests use a
 * recording stub for it and the real auth-schema repository over the shared test database;
 * every test seeds fresh random tenants, users and emails, and scans no whole table.
 */
import { randomUUID } from 'node:crypto';

import type { UserStatus } from '@tayzu/auth';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';

import { harnessPools } from '../__fixtures__/pools.js';
import { createRecoveryEligibility } from './recovery-eligibility.js';
import type { RecoveryEligibilityChecker } from './recovery-eligibility.js';

describe('recovery eligibility (task 5.2)', () => {
  let authPool: Pool;
  let checker: RecoveryEligibilityChecker;
  const statuses = new Map<string, UserStatus>();
  const calls: { tenantId: string; email: string }[] = [];

  beforeAll(async () => {
    ({ authPool } = await harnessPools());
    checker = createRecoveryEligibility({
      authPool,
      userSync: {
        readStatus: ({ tenantId, email }) => {
          calls.push({ tenantId, email });
          return Promise.resolve(statuses.get(`${tenantId}|${email}`) ?? null);
        },
      },
    });
  }, 60_000);

  async function seedTenant(): Promise<string> {
    const id = `org-${randomUUID()}`;
    await authPool.query(
      'insert into auth.organization (id, name, slug, created_at) values ($1, $2, $3, now())',
      [id, 'Org', `slug-${id}`],
    );
    return id;
  }

  async function seedUser(email: string): Promise<string> {
    const id = `usr-${randomUUID()}`;
    await authPool.query(
      'insert into auth."user" (id, name, email, email_verified, created_at, updated_at) values ($1, $2, $3, true, now(), now())',
      [id, 'User', email],
    );
    return id;
  }

  async function seedAccount(userId: string, providerId: string): Promise<void> {
    await authPool.query(
      `insert into auth.account (id, account_id, provider_id, user_id, created_at, updated_at)
       values ($1, $2, $3, $4, now(), now())`,
      [`acc-${randomUUID()}`, `${providerId}-${randomUUID()}`, providerId, userId],
    );
  }

  async function seedMember(tenantId: string, userId: string): Promise<void> {
    await authPool.query(
      `insert into auth.member (id, organization_id, user_id, role, created_at)
       values ($1, $2, $3, 'member', now())`,
      [`mem-${randomUUID()}`, tenantId, userId],
    );
  }

  function freshEmail(): string {
    return `u-${randomUUID()}@example.test`;
  }

  /** A credential user who is a member of one tenant per given status (null: no `_user` row). */
  async function seedRecoverable(
    email: string,
    tenantStatuses: readonly (UserStatus | null)[],
  ): Promise<{ userId: string; tenantIds: string[] }> {
    const userId = await seedUser(email);
    await seedAccount(userId, 'credential');
    const tenantIds: string[] = [];
    for (const status of tenantStatuses) {
      const tenantId = await seedTenant();
      await seedMember(tenantId, userId);
      if (status !== null) statuses.set(`${tenantId}|${email}`, status);
      tenantIds.push(tenantId);
    }
    return { userId, tenantIds };
  }

  it('An SSO-only user gets no password through a reset', async () => {
    const email = freshEmail();
    const userId = await seedUser(email);
    await seedAccount(userId, 'visma-connect');
    const tenantId = await seedTenant();
    await seedMember(tenantId, userId);
    statuses.set(`${tenantId}|${email}`, 'Active');

    const result = await checker.check(email);

    expect(result.status).toBe('no_credential_account');
    expect(result.userId).toBeUndefined();
  });

  it('A user linked to Visma Connect with a local password can reset', async () => {
    const email = freshEmail();
    const userId = await seedUser(email);
    await seedAccount(userId, 'visma-connect');
    await seedAccount(userId, 'credential');
    const tenantId = await seedTenant();
    await seedMember(tenantId, userId);
    statuses.set(`${tenantId}|${email}`, 'Active');

    const result = await checker.check(email);

    expect(result.status).toBe('eligible');
    expect(result.userId).toBe(userId);
    expect(result.tenantIds).toEqual([tenantId]);
  });

  it('Disabled everywhere is not recoverable, disabled somewhere is', async () => {
    const everywhereEmail = freshEmail();
    await seedRecoverable(everywhereEmail, ['Disabled', 'Disabled']);
    const somewhereEmail = freshEmail();
    const somewhere = await seedRecoverable(somewhereEmail, ['Disabled', 'Active']);

    const everywhere = await checker.check(everywhereEmail);
    const partly = await checker.check(somewhereEmail);

    expect(everywhere.status).toBe('disabled_everywhere');
    expect(everywhere.userId).toBeUndefined();
    expect(partly.status).toBe('eligible');
    expect(partly.userId).toBe(somewhere.userId);
    expect([...(partly.tenantIds ?? [])].sort()).toEqual([...somewhere.tenantIds].sort());
  });

  it('a membership with no _user row does not count, and an Invited or Staged one does', async () => {
    const noRowEmail = freshEmail();
    await seedRecoverable(noRowEmail, [null, 'Disabled']);
    const withActiveEmail = freshEmail();
    await seedRecoverable(withActiveEmail, [null, 'Active']);
    const invitedEmail = freshEmail();
    await seedRecoverable(invitedEmail, ['Invited']);

    expect((await checker.check(noRowEmail)).status).toBe('disabled_everywhere');
    expect((await checker.check(withActiveEmail)).status).toBe('eligible');
    expect((await checker.check(invitedEmail)).status).toBe('eligible');
  });

  it('The address is canonicalized', async () => {
    const local = `Known-${randomUUID()}`;
    const canonical = `${local.toLowerCase()}@example.com`;
    const { userId, tenantIds } = await seedRecoverable(canonical, ['Active']);
    calls.length = 0;

    const result = await checker.check(`  ${local}@Example.COM `);

    expect(result.status).toBe('eligible');
    expect(result.userId).toBe(userId);
    expect(result.email).toBe(canonical);
    expect(calls).toEqual([{ tenantId: tenantIds[0], email: canonical }]);
  });

  it('The address is put in NFC before the lookup', async () => {
    const decomposed = `café-${randomUUID()}@example.test`;
    const composed = decomposed.normalize('NFC');
    const { userId } = await seedRecoverable(composed, ['Active']);

    const result = await checker.check(decomposed);

    expect(result.status).toBe('eligible');
    expect(result.userId).toBe(userId);
    expect(result.email).toBe(composed);
  });

  it('a banned user is banned, not eligible', async () => {
    const email = freshEmail();
    const { userId } = await seedRecoverable(email, ['Active']);
    await authPool.query('update auth."user" set banned = true where id = $1', [userId]);

    const result = await checker.check(email);

    expect(result.status).toBe('banned');
    expect(result.userId).toBeUndefined();
  });

  it('a user with no membership is no_membership', async () => {
    const email = freshEmail();
    const userId = await seedUser(email);
    await seedAccount(userId, 'credential');

    const result = await checker.check(email);

    expect(result.status).toBe('no_membership');
    expect(result.userId).toBeUndefined();
  });

  it('an unknown address is unknown_address and reads no status', async () => {
    calls.length = 0;

    const result = await checker.check(freshEmail());

    expect(result.status).toBe('unknown_address');
    expect(result.userId).toBeUndefined();
    expect(calls).toEqual([]);
  });
});
