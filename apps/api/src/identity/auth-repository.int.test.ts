/**
 * Integration test for task 5.1b of `043-identity-lifecycle-and-org-admin`
 * (design D14, Resolved decisions Q69 and Q123): `auth-repository.ts` is the only
 * module through which the identity code reads `apikey`, `invitation`, `member`,
 * `session`, `user` and `account`.
 *
 * Cases (one per clause of the task's Verify):
 *
 * - every tenant-keyed read returns only the rows of the tenant it is given, with a
 *   second tenant's rows seeded to match on every other field;
 * - a missing or empty `tenantId` throws; a call without one does not type-check;
 * - the `session` read filters by `activeOrganizationId`;
 * - the `member` delete removes the membership of the tenant it is given and leaves
 *   the same user's membership of a second tenant in place;
 * - the `session` delete removes only the sessions of the tenant it is given;
 * - `globalInvitationById`, `globalMembershipTenantsOf`, `globalAccountByKey` and
 *   `globalAccountsOf` behave as the task says;
 * - the global functions are the only ones without a `tenantId`.
 *
 * The invitation status write is task 8.3's and is not tested here. The
 * `account-linking.int.test.ts` requirement (the two readers serving the link
 * procedures) is a refactor check on an existing file and is not rewritten here.
 *
 * ## Production symbols expected
 *
 * ```ts
 * // apps/api/src/identity/auth-repository.ts
 * export interface AuthRepository {
 *   // tenant-keyed reads: the first argument is the tenantId, always required
 *   listApiKeys(tenantId: string, page: { limit: number; cursor?: string }):
 *     Promise<{ keys: ApiKeyRead[]; nextCursor?: string }>; // reaches the end (nextCursor undefined)
 *   apiKeyById(tenantId: string, keyId: string): Promise<ApiKeyRead | undefined>;
 *   invitationById(tenantId: string, invitationId: string): Promise<InvitationRead | undefined>;
 *   listMembers(tenantId: string): Promise<MemberRead[]>;
 *   memberOf(tenantId: string, userId: string): Promise<MemberRead | undefined>;
 *   userInTenant(tenantId: string, userId: string): Promise<UserRead | undefined>; // via `member`
 *   sessionsOf(tenantId: string, userId: string): Promise<SessionRead[]>; // activeOrganizationId
 *   // tenant-keyed writes
 *   deleteMember(tenantId: string, memberId: string): Promise<boolean>; // true when a row went
 *   deleteSessionsOf(tenantId: string, userId: string): Promise<number>; // rows deleted
 *   // global reads: the only functions without a tenantId, all named `global…`
 *   globalUserByEmail(email: string): Promise<UserRead | undefined>;
 *   globalUserById(userId: string): Promise<UserRead | undefined>;
 *   globalAccountByKey(providerId: string, accountId: string): Promise<AccountRead | undefined>;
 *   globalAccountsOf(userId: string): Promise<AccountRead[]>;
 *   globalInvitationById(invitationId: string): Promise<InvitationRead | undefined>;
 *   globalMembershipTenantsOf(userId: string): Promise<string[]>; // tenant ids only
 * }
 * export function createAuthRepository(authPool: Pool): AuthRepository;
 * ```
 *
 * Read shapes are plain objects: `ApiKeyRead` `{ id, name, referenceId }` (never the
 * hashed `key`), `InvitationRead` `{ id, organizationId, email, status }`,
 * `MemberRead` `{ id, organizationId, userId, role }`, `UserRead` `{ id, email }`,
 * `SessionRead` `{ id, userId, activeOrganizationId }`, `AccountRead`
 * `{ id, providerId, accountId, userId }`.
 *
 * Tenant-per-test isolation: each test seeds fresh random tenants, and the module
 * scans no whole table, so the shared test database is safe.
 */
import { randomUUID } from 'node:crypto';

import {
  MARKER_EXPIRES_AT_SENTINEL,
  MFA_REENROL_MARKER_VALUE,
  mfaReenrolMarkerIdentifier,
} from '@tayzu/auth';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { harnessPools } from '../__fixtures__/pools.js';
import { createAuthRepository, type AuthRepository } from './auth-repository.js';

const HASHED_KEY = 'hashed-key-material-must-never-be-selected';

describe('auth-repository', () => {
  let authPool: Pool;
  let repo: AuthRepository;

  beforeAll(async () => {
    ({ authPool } = await harnessPools());
    repo = createAuthRepository(authPool);
  }, 60_000);

  async function seedTenant(): Promise<string> {
    const id = `org-${randomUUID()}`;
    await authPool.query(
      'insert into auth.organization (id, name, slug, created_at) values ($1, $2, $3, now())',
      [id, 'Org', `slug-${id}`],
    );
    return id;
  }

  async function seedUser(email = `u-${randomUUID()}@example.test`): Promise<string> {
    const id = `usr-${randomUUID()}`;
    await authPool.query(
      'insert into auth."user" (id, name, email, email_verified, created_at, updated_at) values ($1, $2, $3, true, now(), now())',
      [id, 'User', email],
    );
    return id;
  }

  async function seedMember(tenantId: string, userId: string, role = 'member'): Promise<string> {
    const id = `mem-${randomUUID()}`;
    await authPool.query(
      'insert into auth.member (id, organization_id, user_id, role, created_at) values ($1, $2, $3, $4, now())',
      [id, tenantId, userId, role],
    );
    return id;
  }

  async function seedInvitation(
    tenantId: string,
    inviterId: string,
    email: string,
  ): Promise<string> {
    const id = `inv-${randomUUID()}`;
    await authPool.query(
      `insert into auth.invitation (id, organization_id, email, role, status, expires_at, created_at, inviter_id)
       values ($1, $2, $3, 'member', 'pending', now() + interval '1 day', now(), $4)`,
      [id, tenantId, email, inviterId],
    );
    return id;
  }

  async function seedApiKey(tenantId: string, name: string): Promise<string> {
    const id = `key-${randomUUID()}`;
    await authPool.query(
      `insert into auth.apikey (id, name, reference_id, key, config_id, created_at, updated_at)
       values ($1, $2, $3, $4, 'machine-credential', now(), now())`,
      [id, name, tenantId, HASHED_KEY],
    );
    return id;
  }

  async function seedSession(userId: string, activeOrganizationId: string | null): Promise<string> {
    const id = `ses-${randomUUID()}`;
    await authPool.query(
      `insert into auth.session (id, expires_at, token, created_at, updated_at, user_id, active_organization_id)
       values ($1, now() + interval '1 day', $2, now(), now(), $3, $4)`,
      [id, `tok-${randomUUID()}`, userId, activeOrganizationId],
    );
    return id;
  }

  async function seedAccount(
    userId: string,
    providerId: string,
    accountId: string,
  ): Promise<string> {
    const id = `acc-${randomUUID()}`;
    await authPool.query(
      `insert into auth.account (id, account_id, provider_id, user_id, created_at, updated_at)
       values ($1, $2, $3, $4, now(), now())`,
      [id, accountId, providerId, userId],
    );
    return id;
  }

  async function memberExists(memberId: string): Promise<boolean> {
    const result = await authPool.query('select 1 from auth.member where id = $1', [memberId]);
    return result.rowCount === 1;
  }

  async function sessionExists(sessionId: string): Promise<boolean> {
    const result = await authPool.query('select 1 from auth.session where id = $1', [sessionId]);
    return result.rowCount === 1;
  }

  it('returns only the api keys of the tenant it is given, never the hashed key, paged to the end', async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const keyA1 = await seedApiKey(tenantA, 'ci');
    const keyA2 = await seedApiKey(tenantA, 'deploy');
    const keyA3 = await seedApiKey(tenantA, 'ci-2');
    const keyB = await seedApiKey(tenantB, 'ci');

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < 10; pages += 1) {
      const page = await repo.listApiKeys(tenantA, {
        limit: 2,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      expect(page.keys.length).toBeLessThanOrEqual(2);
      seen.push(...page.keys.map((key) => key.id));
      for (const key of page.keys) {
        expect(key.referenceId).toBe(tenantA);
        expect(JSON.stringify(key)).not.toContain(HASHED_KEY);
        expect(Object.keys(key)).not.toContain('key');
      }
      cursor = page.nextCursor;
      if (cursor === undefined) break;
    }
    expect(cursor, 'the listing reaches the end').toBeUndefined();
    expect([...seen].sort()).toEqual([keyA1, keyA2, keyA3].sort());
    expect(seen).not.toContain(keyB);

    expect((await repo.apiKeyById(tenantA, keyA1))?.id).toBe(keyA1);
    expect(await repo.apiKeyById(tenantA, keyB)).toBeUndefined();
    expect((await repo.apiKeyById(tenantB, keyB))?.id).toBe(keyB);
  });

  it('returns only the invitation of the tenant it is given', async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const inviter = await seedUser();
    const email = `same-${randomUUID()}@example.test`;
    const invA = await seedInvitation(tenantA, inviter, email);
    const invB = await seedInvitation(tenantB, inviter, email);

    const read = await repo.invitationById(tenantA, invA);
    expect(read).toMatchObject({
      id: invA,
      organizationId: tenantA,
      email,
      status: 'pending',
    });
    expect(await repo.invitationById(tenantA, invB)).toBeUndefined();
    expect(await repo.invitationById(tenantB, invA)).toBeUndefined();
  });

  it('lists and looks up only the members of the tenant it is given', async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const shared = await seedUser();
    const onlyA = await seedUser();
    const onlyB = await seedUser();
    const sharedA = await seedMember(tenantA, shared, 'admin');
    const sharedB = await seedMember(tenantB, shared, 'admin');
    const memberA = await seedMember(tenantA, onlyA, 'admin');
    const memberB = await seedMember(tenantB, onlyB, 'admin');

    const listed = await repo.listMembers(tenantA);
    expect(listed.map((m) => m.id).sort()).toEqual([sharedA, memberA].sort());
    expect(listed.every((m) => m.organizationId === tenantA)).toBe(true);
    expect(listed.map((m) => m.id)).not.toContain(sharedB);
    expect(listed.map((m) => m.id)).not.toContain(memberB);

    expect((await repo.memberOf(tenantA, shared))?.id).toBe(sharedA);
    expect((await repo.memberOf(tenantB, shared))?.id).toBe(sharedB);
    expect(await repo.memberOf(tenantA, onlyB)).toBeUndefined();
  });

  it('userInTenant reads through a membership check', async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const inA = await seedUser();
    const inBoth = await seedUser();
    const inB = await seedUser();
    await seedMember(tenantA, inA);
    await seedMember(tenantA, inBoth);
    await seedMember(tenantB, inBoth);
    await seedMember(tenantB, inB);

    expect((await repo.userInTenant(tenantA, inA))?.id).toBe(inA);
    expect((await repo.userInTenant(tenantA, inBoth))?.id).toBe(inBoth);
    expect(await repo.userInTenant(tenantA, inB)).toBeUndefined();
    expect(await repo.userInTenant(tenantA, `usr-${randomUUID()}`)).toBeUndefined();
  });

  it('filters a session read by activeOrganizationId', async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const userId = await seedUser();
    const sessionA = await seedSession(userId, tenantA);
    const sessionB = await seedSession(userId, tenantB);
    const sessionNone = await seedSession(userId, null);

    const sessions = await repo.sessionsOf(tenantA, userId);
    expect(sessions.map((s) => s.id)).toEqual([sessionA]);
    expect(sessions[0]?.activeOrganizationId).toBe(tenantA);
    expect(sessions.map((s) => s.id)).not.toContain(sessionB);
    expect(sessions.map((s) => s.id)).not.toContain(sessionNone);
  });

  it('throws on a missing or empty tenantId', async () => {
    const userId = await seedUser();
    const call = (fn: (...args: never[]) => unknown, ...args: unknown[]): Promise<unknown> =>
      Promise.resolve().then(() => (fn as (...a: unknown[]) => unknown)(...args));

    for (const bad of ['', undefined, null]) {
      await expect(call(repo.listApiKeys, bad, { limit: 1 })).rejects.toThrow();
      await expect(call(repo.apiKeyById, bad, 'k')).rejects.toThrow();
      await expect(call(repo.invitationById, bad, 'i')).rejects.toThrow();
      await expect(call(repo.listMembers, bad)).rejects.toThrow();
      await expect(call(repo.memberOf, bad, userId)).rejects.toThrow();
      await expect(call(repo.userInTenant, bad, userId)).rejects.toThrow();
      await expect(call(repo.sessionsOf, bad, userId)).rejects.toThrow();
      await expect(call(repo.deleteMember, bad, 'm')).rejects.toThrow();
      await expect(call(repo.deleteSessionsOf, bad, userId)).rejects.toThrow();
    }
  });

  it('does not type-check a call without a tenantId', () => {
    // The functions are never run here: the test is about the compiler.
    const never = (): void => {
      // @ts-expect-error a tenant-keyed read requires the tenantId as its first argument
      void repo.listMembers();
      // @ts-expect-error the key id alone is not enough
      void repo.apiKeyById();
      // @ts-expect-error the tenantId cannot be skipped
      void repo.deleteSessionsOf();
    };
    expect(typeof never).toBe('function');
  });

  it('deletes the membership of the tenant it is given and leaves the same user in the other tenant', async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const userId = await seedUser();
    const memberA = await seedMember(tenantA, userId);
    const memberB = await seedMember(tenantB, userId);

    // The membership id of the other tenant is not deletable through this tenant.
    expect(await repo.deleteMember(tenantA, memberB)).toBe(false);
    expect(await memberExists(memberB)).toBe(true);

    expect(await repo.deleteMember(tenantA, memberA)).toBe(true);
    expect(await memberExists(memberA)).toBe(false);
    expect(await memberExists(memberB)).toBe(true);
  });

  it('deletes only the sessions of the tenant it is given', async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const userId = await seedUser();
    const otherUser = await seedUser();
    const a1 = await seedSession(userId, tenantA);
    const a2 = await seedSession(userId, tenantA);
    const b1 = await seedSession(userId, tenantB);
    const none = await seedSession(userId, null);
    const otherA = await seedSession(otherUser, tenantA);

    expect(await repo.deleteSessionsOf(tenantA, userId)).toBe(2);
    expect(await sessionExists(a1)).toBe(false);
    expect(await sessionExists(a2)).toBe(false);
    expect(await sessionExists(b1), 'a session of the second tenant survives').toBe(true);
    expect(await sessionExists(none)).toBe(true);
    expect(await sessionExists(otherA), "another user's session survives").toBe(true);
  });

  it('globalInvitationById returns an invitation of any tenant with its organizationId', async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const inviter = await seedUser();
    const invA = await seedInvitation(tenantA, inviter, `a-${randomUUID()}@example.test`);
    const invB = await seedInvitation(tenantB, inviter, `b-${randomUUID()}@example.test`);

    expect((await repo.globalInvitationById(invA))?.organizationId).toBe(tenantA);
    expect((await repo.globalInvitationById(invB))?.organizationId).toBe(tenantB);
    expect(await repo.globalInvitationById(`inv-${randomUUID()}`)).toBeUndefined();
  });

  it('globalMembershipTenantsOf returns the tenant ids of every membership and nothing else', async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const tenantC = await seedTenant();
    const userId = await seedUser();
    const other = await seedUser();
    await seedMember(tenantA, userId, 'admin');
    await seedMember(tenantB, userId);
    await seedMember(tenantC, other);

    const tenants = await repo.globalMembershipTenantsOf(userId);
    expect([...tenants].sort()).toEqual([tenantA, tenantB].sort());
    expect(tenants.every((t) => typeof t === 'string')).toBe(true);
    expect(await repo.globalMembershipTenantsOf(`usr-${randomUUID()}`)).toEqual([]);
  });

  it('globalAccountByKey returns the account of a provider key whatever the tenants of its user', async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const userId = await seedUser();
    await seedMember(tenantA, userId);
    await seedMember(tenantB, userId);
    const sub = `sub-${randomUUID()}`;
    const accountRowId = await seedAccount(userId, 'visma-connect', sub);

    const found = await repo.globalAccountByKey('visma-connect', sub);
    expect(found).toMatchObject({
      id: accountRowId,
      providerId: 'visma-connect',
      accountId: sub,
      userId,
    });
    expect(await repo.globalAccountByKey('visma-connect', `sub-${randomUUID()}`)).toBeUndefined();
    expect(await repo.globalAccountByKey('other-provider', sub)).toBeUndefined();
  });

  it('globalAccountsOf returns every account of the user and none of another user', async () => {
    const userId = await seedUser();
    const other = await seedUser();
    const a1 = await seedAccount(userId, 'credential', userId);
    const a2 = await seedAccount(userId, 'visma-connect', `sub-${randomUUID()}`);
    const foreign = await seedAccount(other, 'visma-connect', `sub-${randomUUID()}`);

    const accounts = await repo.globalAccountsOf(userId);
    expect(accounts.map((a) => a.id).sort()).toEqual([a1, a2].sort());
    expect(accounts.map((a) => a.id)).not.toContain(foreign);
    expect(accounts.every((a) => a.userId === userId)).toBe(true);
  });

  it('globalUserByEmail reads a user by email and nothing else is global without the prefix', async () => {
    const email = `g-${randomUUID()}@example.test`;
    const userId = await seedUser(email);
    expect((await repo.globalUserByEmail(email))?.id).toBe(userId);
    expect(await repo.globalUserByEmail(`none-${randomUUID()}@example.test`)).toBeUndefined();
  });

  /*
   * Task 5.1 of `044-password-reset-and-account-recovery` (design D4, D7 step 2).
   *
   * ## Production symbols expected
   *
   * ```ts
   * // apps/api/src/identity/auth-repository.ts, added to AuthRepository
   * globalUserBanned: (userId: string, db?: Pick<Pool, 'query'>) => Promise<boolean | undefined>;
   * // reads auth."user".banned only; `undefined` when there is no such user;
   * // a NULL column reads as false; with `db` the statement runs on that client.
   * ```
   */
  it('globalUserBanned: true for a banned user, false for an unbanned one, undefined for no user', async () => {
    const banned = await seedUser();
    const unbanned = await seedUser();
    const nullBanned = await seedUser();
    await authPool.query('update auth."user" set banned = true where id = $1', [banned]);
    await authPool.query('update auth."user" set banned = false where id = $1', [unbanned]);
    await authPool.query('update auth."user" set banned = null where id = $1', [nullBanned]);

    expect(await repo.globalUserBanned(banned)).toBe(true);
    expect(await repo.globalUserBanned(unbanned)).toBe(false);
    expect(await repo.globalUserBanned(nullBanned)).toBe(false);
    expect(await repo.globalUserBanned(`usr-${randomUUID()}`)).toBeUndefined();
  });

  it('globalUserBanned: with a db argument the statement runs on that client', async () => {
    const userId = await seedUser();
    const client = await authPool.connect();
    try {
      await client.query('begin');
      // Uncommitted: visible to this client only.
      await client.query('update auth."user" set banned = true where id = $1', [userId]);

      expect(await repo.globalUserBanned(userId, client)).toBe(true);
      expect(await repo.globalUserBanned(userId), 'the pool does not see it').toBe(false);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });

  /*
   * Task 8.2 of `044-password-reset-and-account-recovery` (design D6, D7 steps 1-3 and 10-11).
   *
   * ## Production symbols expected
   *
   * ```ts
   * // apps/api/src/identity/auth-repository.ts, added to AuthRepository. The design fixes
   * // only `globalTwoFactorStateOf`; the other names carry the 043 `global` prefix because
   * // they take no tenantId (the 'only the global functions' case lists them).
   * interface TwoFactorRowRead {
   *   id: string; secret: string; backupCodes: string; // the stored, encrypted columns
   *   verified: boolean;                               // NULL reads as true ("not false")
   *   failedVerificationCount: number;                 // NULL reads as 0
   *   lockedUntil: Date | null;
   * }
   * globalTwoFactorStateOf(userId, db?): Promise<{ twoFactorEnabled: boolean; rows: TwoFactorRowRead[] }>;
   *   // `twoFactorEnabled` is `user.two_factor_enabled` (NULL reads as false); `rows` are the
   *   // user's `two_factor` rows, ordered by id; both are raw facts, the route decides "enrolled".
   * globalRecordTwoFactorFailure(twoFactorId, db?): Promise<{ failedVerificationCount: number; lockedUntil: Date | null }>;
   *   // ONE atomic statement adding one (NULL counts as 0); once the new count is >= 10
   *   // it sets locked_until = now() + 900 seconds. The counter keeps counting past 10.
   * globalClearExpiredTwoFactorLock(twoFactorId, db?): Promise<boolean>;
   *   // where locked_until <= now(): counter 0 and locked_until NULL; true when a row changed.
   * globalResetTwoFactorFailures(twoFactorId, db?): Promise<void>; // counter 0, locked_until NULL
   * globalSpendBackupCode(twoFactorId, expectedBackupCodes, remainingBackupCodes, db?): Promise<boolean>;
   *   // compare-and-swap: sets backup_codes = remaining where id and backup_codes = expected;
   *   // true when exactly one row changed.
   * globalAccountsOf(userId, db?): Promise<AccountRead[]>; // gains the optional client
   * ```
   */
  async function seedTwoFactor(
    userId: string,
    overrides: {
      verified?: boolean | null;
      failed?: number | null;
      lockedUntilSql?: string;
      backupCodes?: string;
    } = {},
  ): Promise<string> {
    const id = `tf-${randomUUID()}`;
    await authPool.query(
      `insert into auth.two_factor (id, secret, backup_codes, user_id, verified, failed_verification_count, locked_until)
       values ($1, $2, $3, $4, $5, $6, ${overrides.lockedUntilSql ?? 'null'})`,
      [
        id,
        `enc-secret-${id}`,
        overrides.backupCodes ?? `enc-codes-${id}`,
        userId,
        overrides.verified === undefined ? true : overrides.verified,
        overrides.failed === undefined ? 0 : overrides.failed,
      ],
    );
    return id;
  }

  async function setTwoFactorFlag(userId: string, enabled: boolean | null): Promise<void> {
    await authPool.query('update auth."user" set two_factor_enabled = $2 where id = $1', [
      userId,
      enabled,
    ]);
  }

  async function twoFactorColumns(
    id: string,
  ): Promise<{ failed: number | null; lockedUntil: Date | null; backupCodes: string }> {
    const result = await authPool.query<{
      failed: number | null;
      locked_until: Date | null;
      backup_codes: string;
    }>(
      'select failed_verification_count as failed, locked_until, backup_codes from auth.two_factor where id = $1',
      [id],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('expected the two_factor row');
    return { failed: row.failed, lockedUntil: row.locked_until, backupCodes: row.backup_codes };
  }

  it('globalTwoFactorStateOf: enrolled-consistent, flag-only, row-only and unverified-row states are reported as such', async () => {
    const consistent = await seedUser();
    await setTwoFactorFlag(consistent, true);
    const consistentRow = await seedTwoFactor(consistent, { verified: true });

    const flagOnly = await seedUser();
    await setTwoFactorFlag(flagOnly, true);

    const rowOnly = await seedUser();
    await setTwoFactorFlag(rowOnly, false);
    const rowOnlyRow = await seedTwoFactor(rowOnly, { verified: true });

    const unverified = await seedUser();
    await setTwoFactorFlag(unverified, false);
    const unverifiedRow = await seedTwoFactor(unverified, { verified: false });

    const nothing = await seedUser();
    await setTwoFactorFlag(nothing, null);

    const a = await repo.globalTwoFactorStateOf(consistent);
    expect(a.twoFactorEnabled).toBe(true);
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]).toMatchObject({
      id: consistentRow,
      secret: `enc-secret-${consistentRow}`,
      backupCodes: `enc-codes-${consistentRow}`,
      verified: true,
      failedVerificationCount: 0,
      lockedUntil: null,
    });

    const b = await repo.globalTwoFactorStateOf(flagOnly);
    expect(b.twoFactorEnabled).toBe(true);
    expect(b.rows).toEqual([]);

    const c = await repo.globalTwoFactorStateOf(rowOnly);
    expect(c.twoFactorEnabled).toBe(false);
    expect(c.rows.map((r) => [r.id, r.verified])).toEqual([[rowOnlyRow, true]]);

    const d = await repo.globalTwoFactorStateOf(unverified);
    expect(d.twoFactorEnabled).toBe(false);
    expect(d.rows.map((r) => [r.id, r.verified])).toEqual([[unverifiedRow, false]]);

    const e = await repo.globalTwoFactorStateOf(nothing);
    expect(e.twoFactorEnabled).toBe(false);
    expect(e.rows).toEqual([]);
  });

  it('globalTwoFactorStateOf: reports the counter and the lock, and reads only the rows of the user', async () => {
    const userId = await seedUser();
    const other = await seedUser();
    await setTwoFactorFlag(userId, true);
    const own = await seedTwoFactor(userId, {
      failed: 3,
      lockedUntilSql: "now() + interval '10 minutes'",
    });
    await seedTwoFactor(other);

    const state = await repo.globalTwoFactorStateOf(userId);
    expect(state.rows.map((r) => r.id)).toEqual([own]);
    expect(state.rows[0]?.failedVerificationCount).toBe(3);
    expect(state.rows[0]?.lockedUntil).toBeInstanceOf(Date);
    expect((state.rows[0]?.lockedUntil?.getTime() ?? 0) > Date.now()).toBe(true);
  });

  it('50 parallel failures count exactly 50 and lock the account at 10', async () => {
    const userId = await seedUser();
    await setTwoFactorFlag(userId, true);
    const id = await seedTwoFactor(userId);

    const results = await Promise.all(
      Array.from({ length: 50 }, () => repo.globalRecordTwoFactorFailure(id)),
    );

    // Every statement saw its own count: none was lost, none was counted twice.
    expect(results.map((r) => r.failedVerificationCount).sort((x, y) => x - y)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 1),
    );
    const after = await twoFactorColumns(id);
    expect(after.failed).toBe(50);
    expect(after.lockedUntil).toBeInstanceOf(Date);
    const remainingMs = (after.lockedUntil?.getTime() ?? 0) - Date.now();
    expect(remainingMs).toBeGreaterThan(800_000);
    expect(remainingMs).toBeLessThanOrEqual(900_000 + 5_000);
  });

  it('the account is not locked before the tenth failure and locked at it', async () => {
    const userId = await seedUser();
    await setTwoFactorFlag(userId, true);
    const id = await seedTwoFactor(userId, { failed: null });

    for (let n = 1; n <= 9; n += 1) {
      const r = await repo.globalRecordTwoFactorFailure(id);
      expect(r.failedVerificationCount).toBe(n);
      expect(r.lockedUntil, `failure ${String(n)}`).toBeNull();
    }
    const tenth = await repo.globalRecordTwoFactorFailure(id);
    expect(tenth.failedVerificationCount).toBe(10);
    expect(tenth.lockedUntil).toBeInstanceOf(Date);
    expect((tenth.lockedUntil?.getTime() ?? 0) > Date.now()).toBe(true);
  });

  it('an expired lock is cleared before the next count', async () => {
    const userId = await seedUser();
    await setTwoFactorFlag(userId, true);
    const id = await seedTwoFactor(userId, {
      failed: 10,
      lockedUntilSql: "now() - interval '1 second'",
    });

    expect(await repo.globalClearExpiredTwoFactorLock(id)).toBe(true);
    expect(await twoFactorColumns(id)).toMatchObject({ failed: 0, lockedUntil: null });

    const next = await repo.globalRecordTwoFactorFailure(id);
    expect(next.failedVerificationCount, 'the count restarts at one').toBe(1);
    expect(next.lockedUntil).toBeNull();
  });

  it('a lock still in force is not cleared', async () => {
    const userId = await seedUser();
    await setTwoFactorFlag(userId, true);
    const id = await seedTwoFactor(userId, {
      failed: 10,
      lockedUntilSql: "now() + interval '5 minutes'",
    });

    expect(await repo.globalClearExpiredTwoFactorLock(id)).toBe(false);
    const after = await twoFactorColumns(id);
    expect(after.failed).toBe(10);
    expect(after.lockedUntil).toBeInstanceOf(Date);
  });

  it('the counter reset clears the count and the lock of that row only', async () => {
    const userId = await seedUser();
    await setTwoFactorFlag(userId, true);
    const id = await seedTwoFactor(userId, {
      failed: 7,
      lockedUntilSql: "now() + interval '5 minutes'",
    });
    const otherUser = await seedUser();
    const otherId = await seedTwoFactor(otherUser, { failed: 4 });

    await repo.globalResetTwoFactorFailures(id);

    expect(await twoFactorColumns(id)).toMatchObject({ failed: 0, lockedUntil: null });
    expect((await twoFactorColumns(otherId)).failed).toBe(4);
  });

  it('two parallel spends of one backup code: exactly one wins', async () => {
    const userId = await seedUser();
    await setTwoFactorFlag(userId, true);
    const id = await seedTwoFactor(userId, { backupCodes: 'enc-original' });

    const outcomes = await Promise.all([
      repo.globalSpendBackupCode(id, 'enc-original', 'enc-remaining-1'),
      repo.globalSpendBackupCode(id, 'enc-original', 'enc-remaining-2'),
    ]);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const winner = outcomes[0] ? 'enc-remaining-1' : 'enc-remaining-2';
    expect((await twoFactorColumns(id)).backupCodes).toBe(winner);

    // A later spend against the stale value loses too.
    expect(await repo.globalSpendBackupCode(id, 'enc-original', 'enc-remaining-3')).toBe(false);
    expect((await twoFactorColumns(id)).backupCodes).toBe(winner);
  });

  it('every function of the two-factor section runs on the client passed as db', async () => {
    const userId = await seedUser();
    await setTwoFactorFlag(userId, true);
    const lockedId = await seedTwoFactor(userId, {
      failed: 10,
      lockedUntilSql: "now() - interval '1 second'",
      backupCodes: 'enc-original',
    });
    const accountId = await seedAccount(userId, 'credential', userId);

    // The repository's own pool is a stub that fails on any use.
    let poolUses = 0;
    const deadPool = {
      query: () => {
        poolUses += 1;
        return Promise.reject(new Error('the pool must not be used'));
      },
      connect: () => {
        poolUses += 1;
        return Promise.reject(new Error('the pool must not be used'));
      },
    } as unknown as Pool;
    const probeRepo = createAuthRepository(deadPool);

    const client = await authPool.connect();
    const statements: string[] = [];
    const runOnClient = client.query.bind(client) as (...args: unknown[]) => unknown;
    const probe = new Proxy(client, {
      get(target, prop) {
        if (prop === 'query') {
          return (...args: unknown[]): unknown => {
            statements.push(typeof args[0] === 'string' ? args[0] : '');
            return runOnClient(...args);
          };
        }
        return Reflect.get(target, prop) as unknown;
      },
    });
    try {
      const state = await probeRepo.globalTwoFactorStateOf(userId, probe);
      expect(state.rows.map((r) => r.id)).toEqual([lockedId]);
      expect(await probeRepo.globalClearExpiredTwoFactorLock(lockedId, probe)).toBe(true);
      const failure = await probeRepo.globalRecordTwoFactorFailure(lockedId, probe);
      expect(failure.failedVerificationCount).toBe(1);
      await probeRepo.globalResetTwoFactorFailures(lockedId, probe);
      expect(
        await probeRepo.globalSpendBackupCode(lockedId, 'enc-original', 'enc-rest', probe),
      ).toBe(true);
      expect((await probeRepo.globalAccountsOf(userId, probe)).map((a) => a.id)).toEqual([
        accountId,
      ]);
    } finally {
      client.release();
    }

    expect(poolUses, 'the pool sees none of the statements').toBe(0);
    expect(statements.length, 'the probe client saw every statement').toBeGreaterThanOrEqual(6);
  });

  it('globalAccountsOf: with a db argument the statement runs on that client', async () => {
    const userId = await seedUser();
    const client = await authPool.connect();
    try {
      await client.query('begin');
      // Uncommitted: visible to this client only.
      await client.query(
        `insert into auth.account (id, account_id, provider_id, user_id, created_at, updated_at)
         values ($1, $2, 'credential', $3, now(), now())`,
        [`acc-${randomUUID()}`, userId, userId],
      );

      expect(await repo.globalAccountsOf(userId, client)).toHaveLength(1);
      expect(await repo.globalAccountsOf(userId), 'the pool does not see it').toEqual([]);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });

  /*
   * Task 8.8 of `044-password-reset-and-account-recovery` (design D7 steps 6, 8, 9 and 12).
   *
   * ## Production symbols expected
   *
   * ```ts
   * // apps/api/src/identity/auth-repository.ts, added to AuthRepository. The design fixes no
   * // name, and none takes a tenantId, so all carry the 043 `global` prefix. Each takes the
   * // lock's connection as a required last argument `db: Pick<Pool, 'query'>`.
   * globalSetCredentialPassword(userId, passwordHash, db): Promise<void>;
   *   // updates password and updated_at of the user's `credential` account; exactly one row
   *   // must change, else it throws (zero or two rows).
   * globalDeleteTemporaryPasswordMarker(userId, db): Promise<boolean>;
   *   // deletes the verification row whose identifier is `temp-password:<userId>`; true when a row went.
   * globalDeleteTwoFactorChallenges(userId, db): Promise<number>;
   *   // deletes verification rows whose identifier starts `2fa-` (but not `2fa-attempts-`) or
   *   // `trust-device-` AND whose value equals the user id; returns the rows deleted.
   * globalMarkEmailVerified(userId, db): Promise<void>; // user.email_verified = true
   * globalDeleteSessionsOf(userId, db): Promise<{ id: string; tenantId: string | null }[]>;
   *   // deletes every session of the user in every tenant, returning each deleted row's
   *   // id and active_organization_id (null when it has none).
   * ```
   *
   * "Delete other reset tokens" is the existing `deleteResetTokensOf(userId, db)`.
   */
  async function seedVerification(identifier: string, value: string): Promise<void> {
    await authPool.query(
      `insert into auth.verification (id, identifier, value, expires_at, created_at, updated_at)
       values ($1, $2, $3, now() + interval '10 minutes', now(), now())`,
      [randomUUID(), identifier, value],
    );
  }

  async function verificationIdentifiers(...identifiers: string[]): Promise<string[]> {
    const result = await authPool.query<{ identifier: string }>(
      'select identifier from auth.verification where identifier = any($1::text[]) order by identifier',
      [identifiers],
    );
    return result.rows.map((r) => r.identifier);
  }

  async function seedCredential(userId: string, password: string | null): Promise<string> {
    const id = `acc-${randomUUID()}`;
    await authPool.query(
      `insert into auth.account (id, account_id, provider_id, user_id, password, created_at, updated_at)
       values ($1, $2, 'credential', $3, $4, now() - interval '1 day', now() - interval '1 day')`,
      [id, userId, userId, password],
    );
    return id;
  }

  async function passwordOf(
    accountId: string,
  ): Promise<{ password: string | null; fresh: boolean }> {
    const result = await authPool.query<{ password: string | null; fresh: boolean }>(
      `select password, updated_at > now() - interval '1 hour' as fresh from auth.account where id = $1`,
      [accountId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('expected the account row');
    return row;
  }

  it('the password update changes exactly one credential row or throws', async () => {
    const userId = await seedUser();
    const credential = await seedCredential(userId, 'old-hash');
    const other = await seedAccount(userId, 'github', `gh-${randomUUID()}`);
    const otherUser = await seedUser();
    const otherCredential = await seedCredential(otherUser, 'other-hash');

    await repo.globalSetCredentialPassword(userId, 'new-hash', authPool);

    expect(await passwordOf(credential)).toEqual({ password: 'new-hash', fresh: true });
    expect((await passwordOf(other)).password, 'a linked account is untouched').toBeNull();
    expect((await passwordOf(otherCredential)).password, 'another user is untouched').toBe(
      'other-hash',
    );

    // Zero rows: no credential account.
    const noCredential = await seedUser();
    await seedAccount(noCredential, 'github', `gh-${randomUUID()}`);
    await expect(repo.globalSetCredentialPassword(noCredential, 'x', authPool)).rejects.toThrow();

    // Two rows: the update is not left half applied by the caller's rollback, so it must throw.
    const twice = await seedUser();
    const first = await seedCredential(twice, 'a');
    await seedAccount(twice, 'credential', `second-${twice}`);
    const client = await authPool.connect();
    try {
      await client.query('begin');
      await expect(repo.globalSetCredentialPassword(twice, 'z', client)).rejects.toThrow();
    } finally {
      await client.query('rollback');
      client.release();
    }
    expect((await passwordOf(first)).password).toBe('a');
  });

  it('the temporary-password marker is deleted by identifier (its value is an ISO expiry)', async () => {
    const userId = await seedUser();
    const otherUser = await seedUser();
    const expiry = new Date(Date.now() + 3_600_000).toISOString();
    await seedVerification(`temp-password:${userId}`, expiry);
    await seedVerification(`temp-password:${otherUser}`, expiry);

    expect(await repo.globalDeleteTemporaryPasswordMarker(userId, authPool)).toBe(true);
    expect(
      await verificationIdentifiers(`temp-password:${userId}`, `temp-password:${otherUser}`),
    ).toEqual([`temp-password:${otherUser}`]);
    expect(await repo.globalDeleteTemporaryPasswordMarker(userId, authPool)).toBe(false);
  });

  it('challenge and trust rows are deleted by value equal to the user id', async () => {
    const userId = await seedUser();
    const suffix = randomUUID();
    await seedVerification(`2fa-${suffix}-a`, userId);
    await seedVerification(`2fa-${suffix}-b`, userId);
    await seedVerification(`trust-device-${suffix}-a`, userId);

    expect(await repo.globalDeleteTwoFactorChallenges(userId, authPool)).toBe(3);
    expect(
      await verificationIdentifiers(
        `2fa-${suffix}-a`,
        `2fa-${suffix}-b`,
        `trust-device-${suffix}-a`,
      ),
    ).toEqual([]);
  });

  it('the 2fa-attempts- rows (value 0), the mfa-reenrol: rows and other users rows are left', async () => {
    const userId = await seedUser();
    const otherUser = await seedUser();
    const suffix = randomUUID();
    await seedVerification(`2fa-${suffix}`, userId);
    await seedVerification(`2fa-attempts-2fa-${suffix}`, '0');
    await seedVerification(`mfa-reenrol:${userId}`, 'required');
    await seedVerification(`2fa-other-${suffix}`, otherUser);
    await seedVerification(`trust-device-other-${suffix}`, otherUser);
    await seedVerification(`temp-password:${userId}`, new Date(Date.now() + 60_000).toISOString());
    // Even if an attempts row held the user id, it is not a challenge.
    await seedVerification(`2fa-attempts-2fa-user-${suffix}`, userId);

    expect(await repo.globalDeleteTwoFactorChallenges(userId, authPool)).toBe(1);

    expect(
      await verificationIdentifiers(
        `2fa-${suffix}`,
        `2fa-attempts-2fa-${suffix}`,
        `mfa-reenrol:${userId}`,
        `2fa-other-${suffix}`,
        `trust-device-other-${suffix}`,
        `temp-password:${userId}`,
        `2fa-attempts-2fa-user-${suffix}`,
      ),
    ).toEqual(
      [
        `2fa-attempts-2fa-${suffix}`,
        `mfa-reenrol:${userId}`,
        `2fa-other-${suffix}`,
        `trust-device-other-${suffix}`,
        `temp-password:${userId}`,
        `2fa-attempts-2fa-user-${suffix}`,
      ].sort(),
    );
  });

  it('globalMarkEmailVerified sets emailVerified on that user only', async () => {
    const userId = await seedUser();
    const otherUser = await seedUser();
    await authPool.query('update auth."user" set email_verified = false where id = any($1)', [
      [userId, otherUser],
    ]);

    await repo.globalMarkEmailVerified(userId, authPool);

    const result = await authPool.query<{ id: string; email_verified: boolean }>(
      'select id, email_verified from auth."user" where id = any($1)',
      [[userId, otherUser]],
    );
    const byId = new Map(result.rows.map((r) => [r.id, r.email_verified]));
    expect(byId.get(userId)).toBe(true);
    expect(byId.get(otherUser)).toBe(false);
  });

  it('the session delete returns the tenant of each row, null included', async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const userId = await seedUser();
    const otherUser = await seedUser();
    const inA = await seedSession(userId, tenantA);
    const inB = await seedSession(userId, tenantB);
    const none = await seedSession(userId, null);
    const others = await seedSession(otherUser, tenantA);

    const deleted = await repo.globalDeleteSessionsOf(userId, authPool);

    expect([...deleted].sort((x, y) => x.id.localeCompare(y.id))).toEqual(
      [
        { id: inA, tenantId: tenantA },
        { id: inB, tenantId: tenantB },
        { id: none, tenantId: null },
      ].sort((x, y) => x.id.localeCompare(y.id)),
    );
    expect(await sessionExists(inA)).toBe(false);
    expect(await sessionExists(inB)).toBe(false);
    expect(await sessionExists(none)).toBe(false);
    expect(await sessionExists(others), "another user's session stays").toBe(true);
    expect(await repo.globalDeleteSessionsOf(userId, authPool)).toEqual([]);
  });

  it('every function of the completion section runs on the client passed as db', async () => {
    const userId = await seedUser();
    await seedCredential(userId, 'old');
    await seedSession(userId, null);
    let poolUses = 0;
    const deadPool = {
      query: () => {
        poolUses += 1;
        return Promise.reject(new Error('the pool must not be used'));
      },
      connect: () => {
        poolUses += 1;
        return Promise.reject(new Error('the pool must not be used'));
      },
    } as unknown as Pool;
    const probeRepo = createAuthRepository(deadPool);

    const client = await authPool.connect();
    try {
      await probeRepo.globalSetCredentialPassword(userId, 'new', client);
      await probeRepo.globalDeleteTemporaryPasswordMarker(userId, client);
      await probeRepo.globalDeleteTwoFactorChallenges(userId, client);
      await probeRepo.globalMarkEmailVerified(userId, client);
      expect(await probeRepo.globalDeleteSessionsOf(userId, client)).toHaveLength(1);
    } finally {
      client.release();
    }
    expect(poolUses).toBe(0);
  });

  /*
   * Task 9.1 of `044-password-reset-and-account-recovery` (design D11).
   *
   * ## Production symbols expected
   *
   * - `auth-repository.ts`: `writeMfaReenrolMarker(userId, db?): Promise<void>` on
   *   `AuthRepository`. The design fixes the name without the `global` prefix, so it is NOT in
   *   the 'only the global functions' list and must reject a call without a user id.
   * - `@tayzu/auth` (index): `mfaReenrolMarkerIdentifier`, `MFA_REENROL_MARKER_VALUE` and
   *   `MARKER_EXPIRES_AT_SENTINEL` (a `Date`, exported from `temporary-password.ts`).
   */
  it('writeMfaReenrolMarker writes one row with the module identifier, value and sentinel, a second write leaves one row, and it runs on the client passed as db', async () => {
    const userId = await seedUser();
    const identifier = mfaReenrolMarkerIdentifier(userId);
    expect(identifier).toBe(`mfa-reenrol:${userId}`);

    const rowsOf = async (): Promise<{ identifier: string; value: string; expires_at: Date }[]> =>
      (
        await authPool.query<{ identifier: string; value: string; expires_at: Date }>(
          'select identifier, value, expires_at from auth.verification where identifier = $1',
          [identifier],
        )
      ).rows;

    await repo.writeMfaReenrolMarker(userId);
    const first = await rowsOf();
    expect(first).toHaveLength(1);
    expect(first[0]?.identifier).toBe(identifier);
    expect(first[0]?.value).toBe(MFA_REENROL_MARKER_VALUE);
    expect(first[0]?.expires_at.getTime()).toBe(MARKER_EXPIRES_AT_SENTINEL.getTime());

    await repo.writeMfaReenrolMarker(userId);
    expect(await rowsOf(), 'a second write leaves one row').toHaveLength(1);

    // On the client passed as `db`: uncommitted there, invisible to the pool.
    const otherUser = await seedUser();
    const otherIdentifier = mfaReenrolMarkerIdentifier(otherUser);
    let poolUses = 0;
    const deadPool = {
      query: () => {
        poolUses += 1;
        return Promise.reject(new Error('the pool must not be used'));
      },
      connect: () => {
        poolUses += 1;
        return Promise.reject(new Error('the pool must not be used'));
      },
    } as unknown as Pool;
    const probeRepo = createAuthRepository(deadPool);
    const client = await authPool.connect();
    try {
      await client.query('begin');
      await probeRepo.writeMfaReenrolMarker(otherUser, client);
      const seenByClient = await client.query(
        'select 1 from auth.verification where identifier = $1',
        [otherIdentifier],
      );
      expect(seenByClient.rowCount).toBe(1);
      const seenByPool = await authPool.query(
        'select 1 from auth.verification where identifier = $1',
        [otherIdentifier],
      );
      expect(seenByPool.rowCount, 'the pool does not see it').toBe(0);
    } finally {
      await client.query('rollback');
      client.release();
    }
    expect(poolUses).toBe(0);
  });

  it('only the global functions are callable without a tenantId', async () => {
    const names = Object.keys(repo);
    const globals = names.filter((name) => name.startsWith('global'));
    expect([...globals].sort()).toEqual(
      [
        'globalAccountByKey',
        'globalAccountsOf',
        'globalClearExpiredTwoFactorLock',
        'globalDeleteSessionsOf',
        'globalDeleteTemporaryPasswordMarker',
        'globalDeleteTwoFactorChallenges',
        'globalInvitationById',
        'globalMarkEmailVerified',
        'globalMembershipTenantsOf',
        'globalRecordTwoFactorFailure',
        'globalResetTwoFactorFailures',
        'globalSetCredentialPassword',
        'globalSpendBackupCode',
        'globalTwoFactorStateOf',
        'globalUserBanned',
        'globalUserByEmail',
        'globalUserById',
      ].sort(),
    );
    // Every other function rejects a call whose first argument is not a tenant id.
    for (const name of names.filter((n) => !n.startsWith('global'))) {
      const fn = (repo as unknown as Record<string, (...args: unknown[]) => unknown>)[name];
      expect(fn, name).toBeTypeOf('function');
      await expect(
        Promise.resolve().then(() => fn?.(undefined, 'x', 'y')),
        `${name} without a tenantId`,
      ).rejects.toThrow();
    }
  });
});
