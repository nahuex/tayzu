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
      `insert into auth.apikey (id, name, reference_id, key, created_at, updated_at)
       values ($1, $2, $3, $4, now(), now())`,
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

  it('only the global functions are callable without a tenantId', async () => {
    const names = Object.keys(repo);
    const globals = names.filter((name) => name.startsWith('global'));
    expect([...globals].sort()).toEqual(
      [
        'globalAccountByKey',
        'globalAccountsOf',
        'globalInvitationById',
        'globalMembershipTenantsOf',
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
