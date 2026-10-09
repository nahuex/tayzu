/**
 * Integration test for task 5.2 of `043-identity-lifecycle-and-org-admin`
 * (design D14; spec requirement "Targets belong to the caller's tenant"): every
 * invitation, credential and user targeted by an `identity.*` operation is
 * resolved on the server, through the repository of 5.1b, and a target of another
 * tenant answers `CATALOG_NOT_FOUND`, identical to a nonexistent id. `tenantId`
 * and `actor` are never read from input.
 *
 * Cases:
 *
 * - a foreign and an unknown invitation answer the same `CATALOG_NOT_FOUND`;
 * - a foreign and an unknown credential answer the same;
 * - a foreign and an unknown user answer the same (a user whose membership is only
 *   in another tenant is foreign; a user with memberships in both tenants belongs);
 * - a target of the caller's own tenant resolves, carrying the host tenant;
 * - a target with a `tenantId` (or `actor`) field is rejected with
 *   `CATALOG_VALIDATION_FAILED` before anything is read;
 * - the helper reads only through the repository, always with the host tenant.
 *
 * ## Production symbols expected
 *
 * ```ts
 * // apps/api/src/identity/identity-target.ts
 * export type IdentityTargetKind = 'invitation' | 'credential' | 'user';
 * export interface ResolvedIdentityTarget {
 *   readonly kind: IdentityTargetKind;
 *   readonly id: string;       // the opaque id of the resolved record
 *   readonly tenantId: string; // the target's real tenant (the host tenant once resolved)
 * }
 * export interface IdentityTargetResolver {
 *   // `context` is the host-supplied context (only `tenantId` is read); `rawTarget` is
 *   // untrusted: exactly `{ kind, id }`, any other field (`tenantId`, `actor`, …) is
 *   // rejected with a `CATALOG_VALIDATION_FAILED` error before any read.
 *   resolve(context: { tenantId: string }, rawTarget: unknown): Promise<ResolvedIdentityTarget>;
 * }
 * export function createIdentityTargetResolver(options: {
 *   authRepository: AuthRepository; // ./auth-repository.js, the only reader of the auth schema
 * }): IdentityTargetResolver;
 * ```
 *
 * Uses `invitationById`, `apiKeyById` and `userInTenant` of the repository. A
 * not-found error is an `Error` whose `code` is `CATALOG_NOT_FOUND`, with the same
 * class, name and message whatever the reason.
 *
 * Tenant-per-test isolation: every test seeds fresh random tenants and the code
 * under test scans no table, so the shared test database is safe.
 */
import { randomUUID } from 'node:crypto';

import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import { harnessPools } from '../__fixtures__/pools.js';
import { createAuthRepository, type AuthRepository } from './auth-repository.js';
import { createIdentityTargetResolver, type IdentityTargetResolver } from './identity-target.js';

describe('identity target resolution', () => {
  let authPool: Pool;
  let repo: AuthRepository;
  let resolver: IdentityTargetResolver;

  beforeAll(async () => {
    ({ authPool } = await harnessPools());
    repo = createAuthRepository(authPool);
    resolver = createIdentityTargetResolver({ authRepository: repo });
  }, 60_000);

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
      'insert into auth."user" (id, name, email, email_verified, created_at, updated_at) values ($1, $2, $3, true, now(), now())',
      [id, 'User', `u-${randomUUID()}@example.test`],
    );
    return id;
  }

  async function seedMember(tenantId: string, userId: string): Promise<void> {
    await authPool.query(
      "insert into auth.member (id, organization_id, user_id, role, created_at) values ($1, $2, $3, 'member', now())",
      [`mem-${randomUUID()}`, tenantId, userId],
    );
  }

  async function seedInvitation(tenantId: string, inviterId: string): Promise<string> {
    const id = `inv-${randomUUID()}`;
    await authPool.query(
      `insert into auth.invitation (id, organization_id, email, role, status, expires_at, created_at, inviter_id)
       values ($1, $2, $3, 'member', 'pending', now() + interval '1 day', now(), $4)`,
      [id, tenantId, `i-${randomUUID()}@example.test`, inviterId],
    );
    return id;
  }

  async function seedApiKey(tenantId: string): Promise<string> {
    const id = `key-${randomUUID()}`;
    await authPool.query(
      `insert into auth.apikey (id, name, reference_id, key, created_at, updated_at)
       values ($1, 'k', $2, 'hashed', now(), now())`,
      [id, tenantId],
    );
    return id;
  }

  async function rejection(promise: Promise<unknown>): Promise<Error> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof Error) return error;
      throw new Error('rejected with a non-Error value', { cause: error });
    }
    throw new Error('expected the promise to reject');
  }

  /** The foreign and the unknown answers must be indistinguishable. */
  function expectSameNotFound(foreign: Error, unknown: Error, ...secrets: string[]): void {
    expect(foreign).toMatchObject({ code: 'CATALOG_NOT_FOUND' });
    expect(unknown).toMatchObject({ code: 'CATALOG_NOT_FOUND' });
    expect(foreign.constructor).toBe(unknown.constructor);
    expect(foreign.name).toBe(unknown.name);
    expect(foreign.message).toBe(unknown.message);
    expect(Object.entries(foreign)).toEqual(Object.entries(unknown));
    for (const secret of secrets) {
      expect(foreign.message).not.toContain(secret);
      expect(JSON.stringify(Object.entries(foreign))).not.toContain(secret);
    }
  }

  it("Another tenant's invitation answers the same as an unknown id", async () => {
    const t1 = await seedTenant();
    const t2 = await seedTenant();
    const inviter = await seedUser();
    await seedMember(t2, inviter);
    const foreignId = await seedInvitation(t2, inviter);
    const own = await seedInvitation(t1, inviter);

    const foreign = await rejection(
      resolver.resolve({ tenantId: t1 }, { kind: 'invitation', id: foreignId }),
    );
    const unknown = await rejection(
      resolver.resolve({ tenantId: t1 }, { kind: 'invitation', id: `inv-${randomUUID()}` }),
    );
    expectSameNotFound(foreign, unknown, foreignId, t2);

    await expect(
      resolver.resolve({ tenantId: t1 }, { kind: 'invitation', id: own }),
    ).resolves.toEqual({ kind: 'invitation', id: own, tenantId: t1 });
  });

  it("Another tenant's credential answers the same as an unknown id", async () => {
    const t1 = await seedTenant();
    const t2 = await seedTenant();
    const foreignId = await seedApiKey(t2);
    const own = await seedApiKey(t1);

    const foreign = await rejection(
      resolver.resolve({ tenantId: t1 }, { kind: 'credential', id: foreignId }),
    );
    const unknown = await rejection(
      resolver.resolve({ tenantId: t1 }, { kind: 'credential', id: `key-${randomUUID()}` }),
    );
    expectSameNotFound(foreign, unknown, foreignId, t2);

    await expect(
      resolver.resolve({ tenantId: t1 }, { kind: 'credential', id: own }),
    ).resolves.toEqual({ kind: 'credential', id: own, tenantId: t1 });
  });

  it("Another tenant's user answers the same as an unknown id", async () => {
    const t1 = await seedTenant();
    const t2 = await seedTenant();
    const foreignUser = await seedUser();
    await seedMember(t2, foreignUser);
    const ownUser = await seedUser();
    await seedMember(t1, ownUser);
    const bothUser = await seedUser();
    await seedMember(t1, bothUser);
    await seedMember(t2, bothUser);

    const foreign = await rejection(
      resolver.resolve({ tenantId: t1 }, { kind: 'user', id: foreignUser }),
    );
    const unknown = await rejection(
      resolver.resolve({ tenantId: t1 }, { kind: 'user', id: `usr-${randomUUID()}` }),
    );
    expectSameNotFound(foreign, unknown, foreignUser, t2);

    await expect(
      resolver.resolve({ tenantId: t1 }, { kind: 'user', id: ownUser }),
    ).resolves.toEqual({ kind: 'user', id: ownUser, tenantId: t1 });
    // A user belongs to the tenant when they have a membership in it, even if they also belong to another.
    await expect(
      resolver.resolve({ tenantId: t1 }, { kind: 'user', id: bothUser }),
    ).resolves.toEqual({ kind: 'user', id: bothUser, tenantId: t1 });
  });

  it('A target carrying a tenantId or actor field is rejected before anything is read', async () => {
    const t1 = await seedTenant();
    const t2 = await seedTenant();
    const inviter = await seedUser();
    await seedMember(t2, inviter);
    const foreignId = await seedInvitation(t2, inviter);

    const spied = createAuthRepository(authPool);
    const spies = (Object.keys(spied) as (keyof AuthRepository)[]).map((name) =>
      vi.spyOn(spied, name),
    );
    const guarded = createIdentityTargetResolver({ authRepository: spied });

    // Even a body naming the target's own tenant must be rejected, not honoured.
    const withTenant = await rejection(
      guarded.resolve({ tenantId: t1 }, { kind: 'invitation', id: foreignId, tenantId: t2 }),
    );
    const withHostTenant = await rejection(
      guarded.resolve({ tenantId: t1 }, { kind: 'invitation', id: foreignId, tenantId: t1 }),
    );
    const withActor = await rejection(
      guarded.resolve(
        { tenantId: t1 },
        { kind: 'invitation', id: foreignId, actor: { id: 'someone', type: 'user' } },
      ),
    );
    for (const error of [withTenant, withHostTenant, withActor]) {
      expect(error).toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('Every read goes through the repository with the host tenant', async () => {
    const t1 = `org-${randomUUID()}`;
    const calls: unknown[][] = [];
    const record =
      (name: string) =>
      (...args: unknown[]): Promise<undefined> => {
        calls.push([name, ...args]);
        return Promise.resolve(undefined);
      };
    // A repository that knows nothing: the helper has no other way to look a target up.
    const fake = new Proxy({} as AuthRepository, {
      get: (_target, name) => record(String(name)),
    });
    const fakeResolver = createIdentityTargetResolver({ authRepository: fake });

    await rejection(fakeResolver.resolve({ tenantId: t1 }, { kind: 'invitation', id: 'inv-1' }));
    await rejection(fakeResolver.resolve({ tenantId: t1 }, { kind: 'credential', id: 'key-1' }));
    await rejection(fakeResolver.resolve({ tenantId: t1 }, { kind: 'user', id: 'usr-1' }));

    expect(calls).toEqual([
      ['invitationById', t1, 'inv-1'],
      ['apiKeyById', t1, 'key-1'],
      ['userInTenant', t1, 'usr-1'],
    ]);
  });
});
