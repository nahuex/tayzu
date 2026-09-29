/**
 * Integration test for task 20.1 (openspec/changes/002-auth-and-rbac; design
 * D24 path (b), Resolved decision Q18; `specs/auth-and-rbac/spec.md`, "Visma
 * Connect SSO account linking").
 *
 * Task 20.1: "`identity.users.linkSsoAccount` / `identity.users.
 * unlinkSsoAccount`: Cerbos-gated oRPC procedures (`admin` role) writing or
 * removing an `account` row for a target user, keyed on the Visma Connect
 * `sub`, using `@tayzu/auth`'s internal adapter directly rather than Better
 * Auth's session-scoped `/link-social` (design D24)."
 *
 * Scenario covered (verbatim from the spec):
 * - "An admin records a user's Visma Connect UserID": GIVEN a caller with the
 *   `admin` role, WHEN they record a Visma Connect UserID on another user's
 *   account, THEN that account is linked, keyed on the Visma Connect UserID,
 *   and the action is audited.
 *
 * The "audited" clause is the `auth.security.account_linked` log event and the
 * `tayzu.auth.account_link.events` counter. Task 20.4 owns those signals and
 * says this file is *extended* with their assertions there, so they are not
 * asserted here.
 *
 * The test lives in `apps/api` for the same reason `admin-user-creation.int.
 * test.ts` does: it is the only package that depends on `@tayzu/auth` and
 * `@tayzu/authz` together. Tests never call the real Visma Connect; linking
 * writes a row from a caller-supplied `sub` and needs no OIDC round trip.
 *
 * ## Production symbols assumed (none exists yet)
 *
 * - `createIdentityRouter({ auth, authz })` (`./identity-router.js`, already
 *   exists) gains `identity.users.linkSsoAccount` (and `unlinkSsoAccount`,
 *   not tested by this task).
 * - Input: `{ userId, subject }`: `userId` is the target Tayzu user's id,
 *   `subject` the Visma Connect `sub` (UserID). Nothing else is accepted from
 *   the caller: the tenant and the actor come from the host context.
 * - It checks Cerbos for resource kind `user`, action `update` (`user.yaml`
 *   already allows `*` for `admin`, so no policy change is needed).
 * - It writes one `auth.account` row: `provider_id = 'visma-connect'`,
 *   `account_id = <subject>`, `user_id = <target userId>`.
 */
import { randomUUID } from 'node:crypto';

import { createRouterClient } from '@orpc/server';
import { authSchema, createAuth, type AuthInstance } from '@tayzu/auth';
import { createCerbosClient, type CerbosClient } from '@tayzu/authz';
import { runMigrations } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { createAdminUser } from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createIdentityRouter } from './identity-router.js';

const TEST_SECRET = 'int-test-only-secret-not-used-for-anything-real-0123456789';
const PROVIDER_ID = 'visma-connect';

interface CreateOrganizationSurface {
  createOrganization(args: {
    body: { name: string; slug: string; userId: string };
  }): Promise<{ id: string }>;
}

// A type alias (not an interface) so it satisfies `db.execute`'s `Record<string, unknown>` bound.
type AccountRow = {
  readonly id: string;
  readonly account_id: string;
  readonly provider_id: string;
  readonly user_id: string;
};

interface MemberSurface {
  addMember(args: {
    body: { userId: string; organizationId: string; role: string };
  }): Promise<unknown>;
}

type CheckResourcesRequest = Parameters<CerbosClient['checkResources']>[0];

describe('identity.users.linkSsoAccount (task 20.1, design D24 path (b))', () => {
  let authPool: Pool;
  let auth: AuthInstance;
  const cerbosRequests: CheckResourcesRequest[] = [];
  let client: ReturnType<
    typeof createRouterClient<ReturnType<typeof createIdentityRouter>, Record<string, unknown>>
  >;

  beforeAll(async () => {
    const pools = await harnessPools();
    authPool = pools.authPool;
    await runMigrations(authPool);
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
    });
    const cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    // Records every Cerbos request, then delegates to the real Cerbos.
    const recording = Object.create(cerbos) as CerbosClient;
    recording.checkResources = (request: CheckResourcesRequest) => {
      cerbosRequests.push(request);
      return cerbos.checkResources(request);
    };
    client = createRouterClient(createIdentityRouter({ auth, authz: recording }), {
      context: (raw: Record<string, unknown>) => raw,
    });
  }, 60_000);

  async function freshTenantId(): Promise<string> {
    const id = randomUUID();
    const owner = await createAdminUser(auth, {
      name: 'Tenant Owner',
      email: `owner-${id}@example.test`,
      password: 'correct-horse-battery-staple',
    });
    const org = await (auth.api as CreateOrganizationSurface).createOrganization({
      body: { name: 'Account Linking Org', slug: `account-linking-${id}`, userId: owner.userId },
    });
    return org.id;
  }

  function context(tenantId: string, roles: readonly string[]): Record<string, unknown> {
    return {
      tenantId,
      actor: { type: 'user', id: `caller-${randomUUID()}` },
      principal: { roles },
    };
  }

  async function join(userId: string, organizationId: string): Promise<void> {
    await (auth.api as MemberSurface).addMember({
      body: { userId, organizationId, role: 'member' },
    });
  }

  async function newUser(label: string): Promise<{ userId: string; email: string }> {
    const email = `${label}-${randomUUID()}@example.test`;
    return createAdminUser(auth, {
      name: label,
      email,
      password: 'correct-horse-battery-staple',
    });
  }

  async function rejection(promise: Promise<unknown>): Promise<Error> {
    try {
      await promise;
    } catch (error) {
      return error as Error;
    }
    throw new Error('expected the call to be rejected');
  }

  function shape(error: Error): unknown {
    const { code, status, data } = error as Error & {
      code?: unknown;
      status?: unknown;
      data?: unknown;
    };
    return { name: error.name, message: error.message, code, status, data };
  }

  async function ssoAccountsFor(subject: string): Promise<readonly AccountRow[]> {
    const db = drizzle(authPool, { schema: authSchema });
    const result = await db.execute<AccountRow>(sql`
      select id, account_id, provider_id, user_id
      from auth.account
      where provider_id = ${PROVIDER_ID} and account_id = ${subject}
    `);
    return result.rows;
  }

  async function accountsOfUser(userId: string): Promise<readonly AccountRow[]> {
    const db = drizzle(authPool, { schema: authSchema });
    const result = await db.execute<AccountRow>(sql`
      select id, account_id, provider_id, user_id
      from auth.account
      where user_id = ${userId} and provider_id = ${PROVIDER_ID}
    `);
    return result.rows;
  }

  it("An admin records a user's Visma Connect UserID: the target account is linked, keyed on the UserID", async () => {
    const tenantId = await freshTenantId();
    const target = await createAdminUser(auth, {
      name: 'Link Target',
      email: `target-${randomUUID()}@example.test`,
      password: 'correct-horse-battery-staple',
    });
    const other = await createAdminUser(auth, {
      name: 'Bystander',
      email: `bystander-${randomUUID()}@example.test`,
      password: 'correct-horse-battery-staple',
    });
    await join(target.userId, tenantId);
    const subject = `visma-sub-${randomUUID()}`;
    expect(await ssoAccountsFor(subject), 'precondition: nothing linked yet').toHaveLength(0);

    // GIVEN a caller with the `admin` role; WHEN they record a Visma Connect
    // UserID on another user's account.
    await client.identity.users.linkSsoAccount(
      { userId: target.userId, subject },
      { context: context(tenantId, ['admin']) },
    );

    // THEN that account is linked, keyed on the Visma Connect UserID (the
    // `sub`, never the email): exactly one row, for the target user only.
    const rows = await ssoAccountsFor(subject);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.provider_id).toBe(PROVIDER_ID);
    expect(rows[0]?.account_id).toBe(subject);
    expect(rows[0]?.user_id).toBe(target.userId);
    expect(await accountsOfUser(target.userId)).toHaveLength(1);
    expect(await accountsOfUser(other.userId), 'no other user is linked').toHaveLength(0);
  }, 60_000);

  it('Cross-tenant link and unlink look exactly like a nonexistent user, and write or delete nothing', async () => {
    const tenantA = await freshTenantId();
    const tenantB = await freshTenantId();
    const victim = await newUser('victim');
    await join(victim.userId, tenantB); // belongs ONLY to tenant B
    const adminA = context(tenantA, ['admin']);

    // Tenant B already has a legitimate link for the victim (written by B's admin).
    const existingSub = `visma-sub-${randomUUID()}`;
    await client.identity.users.linkSsoAccount(
      { userId: victim.userId, subject: existingSub },
      { context: context(tenantB, ['admin']) },
    );
    expect(await accountsOfUser(victim.userId), 'precondition: victim linked').toHaveLength(1);

    const newSub = `visma-sub-${randomUUID()}`;
    const ghostId = randomUUID();

    // Link: cross-tenant target vs. nonexistent target.
    const crossLink = await rejection(
      client.identity.users.linkSsoAccount(
        { userId: victim.userId, subject: newSub },
        { context: adminA },
      ),
    );
    const ghostLink = await rejection(
      client.identity.users.linkSsoAccount(
        { userId: ghostId, subject: `visma-sub-${randomUUID()}` },
        { context: adminA },
      ),
    );
    expect(shape(crossLink)).toEqual(shape(ghostLink));
    expect((crossLink as Error & { code?: unknown }).code).toBe('CATALOG_NOT_FOUND');
    expect(crossLink.message).not.toContain(victim.userId);
    expect(crossLink.message).not.toContain(tenantB);
    expect(await ssoAccountsFor(newSub), 'no account row is written').toHaveLength(0);
    expect(await accountsOfUser(victim.userId)).toHaveLength(1);

    // Unlink: cross-tenant target vs. nonexistent target.
    const crossUnlink = await rejection(
      client.identity.users.unlinkSsoAccount({ userId: victim.userId }, { context: adminA }),
    );
    const ghostUnlink = await rejection(
      client.identity.users.unlinkSsoAccount({ userId: ghostId }, { context: adminA }),
    );
    expect(shape(crossUnlink)).toEqual(shape(ghostUnlink));
    expect((crossUnlink as Error & { code?: unknown }).code).toBe('CATALOG_NOT_FOUND');
    const remaining = await accountsOfUser(victim.userId);
    expect(remaining, 'no account row is deleted').toHaveLength(1);
    expect(remaining[0]?.account_id).toBe(existingSub);
  }, 60_000);

  it('Linking a sub already linked to a different Tayzu user is rejected without revealing the other user', async () => {
    const tenantId = await freshTenantId();
    const owner = await newUser('sub-owner');
    const intruder = await newUser('sub-intruder');
    await join(owner.userId, tenantId);
    await join(intruder.userId, tenantId);
    const subject = `visma-sub-${randomUUID()}`;
    const admin = context(tenantId, ['admin']);

    await client.identity.users.linkSsoAccount(
      { userId: owner.userId, subject },
      { context: admin },
    );
    const before = await ssoAccountsFor(subject);
    expect(before, 'precondition: linked to the owner').toHaveLength(1);

    const error = await rejection(
      client.identity.users.linkSsoAccount(
        { userId: intruder.userId, subject },
        { context: admin },
      ),
    );

    // No second link, the existing link untouched.
    const after = await ssoAccountsFor(subject);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(before[0]?.id);
    expect(after[0]?.user_id).toBe(owner.userId);
    expect(await accountsOfUser(intruder.userId)).toHaveLength(0);

    // A generic error that does not reveal the other user.
    const revealed = JSON.stringify(shape(error));
    expect(revealed).not.toContain(owner.userId);
    expect(revealed).not.toContain(owner.email);
    expect(revealed).not.toContain('sub-owner');
    expect(revealed).not.toContain(subject);
  }, 60_000);

  it("The Cerbos check uses the target user's real tenant, and a principal of another tenant is denied", async () => {
    const tenantA = await freshTenantId();
    const tenantB = await freshTenantId();
    const victim = await newUser('cerbos-victim');
    await join(victim.userId, tenantB);
    const subject = `visma-sub-${randomUUID()}`;

    // Cross-tenant caller: the check must be made against tenant B's resource.
    cerbosRequests.length = 0;
    await rejection(
      client.identity.users.linkSsoAccount(
        { userId: victim.userId, subject },
        { context: context(tenantA, ['admin']) },
      ),
    );
    const cross = cerbosRequests.filter((r) =>
      r.resources.some((entry) => entry.resource.attr?.['tenantId'] === tenantB),
    );
    expect(cross.length, 'Cerbos was asked about a tenant-B resource').toBeGreaterThan(0);
    const request = cross[0];
    expect(request?.principal.attr?.['tenantId']).toBe(tenantA);

    // Replayed against the real Cerbos, that principal is denied.
    const cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    const decision = await cerbos.checkResources(request as CheckResourcesRequest);
    expect(decision.results[0]?.isAllowed('update')).toBe(false);

    // Control: tenant B's own admin is allowed and the check carries tenant B on both sides.
    cerbosRequests.length = 0;
    await client.identity.users.linkSsoAccount(
      { userId: victim.userId, subject },
      { context: context(tenantB, ['admin']) },
    );
    const own = cerbosRequests.at(-1);
    expect(own?.principal.attr?.['tenantId']).toBe(tenantB);
    expect(own?.resources[0]?.resource.attr?.['tenantId']).toBe(tenantB);
    expect(await accountsOfUser(victim.userId)).toHaveLength(1);
  }, 60_000);
});
