/**
 * Task 9.2 of openspec/changes/043-identity-lifecycle-and-org-admin
 * (`identity.credentials.list`; design D7, D8; Resolved decisions Q29, Q56, Q90).
 *
 * Scenarios (verbatim from the spec, "Org API-credentials viewer never re-exposes a secret"):
 * - "Listing never includes the secret": GIVEN an organization with 3 API credentials,
 *   WHEN an admin lists them, THEN each entry has a prefix, not the full secret, and no
 *   field in the response ever equals a credential's secret value.
 * - "The viewer shows every credential a tenant can hold": GIVEN a tenant with 200
 *   non-revoked and 30 revoked credentials, WHEN an admin lists them, THEN all 200
 *   non-revoked credentials are listed, each with an id that `rotate` accepts (that
 *   `rotate` accepts it is 9.6's case), and the page says that revoked ones were left out.
 * - "The viewer shows who created a credential": GIVEN a credential created by an admin
 *   through the identity operations, WHEN an admin lists the credentials, THEN its entry
 *   carries the creating admin's opaque id and no email.
 * - "Non-admin cannot list credentials": WHEN an actor without the grant lists
 *   credentials, THEN the operation is denied.
 *
 * ## Harness
 *
 * Real `auth` (the real adapter of 4.1 as `userSync`, like `identity-router.int.test.ts`), a
 * real Cerbos at `localhost:3593`, the shared pools. Each test uses a fresh organization (the
 * tenant) with an owner and an `admin` member who is not the owner. Credentials are seeded
 * with the headerless `createMachineCredential` / `revokeMachineCredential` of 9.1b/9.1c
 * (`body.userId` the admin), because the create and revoke operations are 9.5's and 9.9's.
 *
 * ## Production symbols expected
 *
 * - `createIdentityRouter` (`../identity-router.js`) gains the options `appPool: Pool` (the
 *   `tayzu_app` pool that the revocation list is read through) and `credentialCap?: number`
 *   (the cap of 9.5d, default 200), and the procedure `identity.credentials.list`, a
 *   `defineIdentityOperation` on `RESOURCE_KINDS.credential` / `list`, input `{}`, output
 *   `{ credentials: CredentialView[]; truncated: boolean }` where `CredentialView` is
 *   `{ id, name, kind, prefix, createdAt, lastRequest, enabled, rotationDueAt, createdBy? }`.
 *   A revoked credential is one with a row in `machine_credential_revocation`.
 * - `./credentials.js` exports `readApiKeyMetadata(value: unknown)` returning
 *   `{ actorKind?, userId?, createdBy?, rotatedAt? }` from an object or a JSON string, and
 *   `readAllApiKeys(authRepository, tenantId, { pageSize? })` which pages through the
 *   tenant's `machine-credential` keys to the end and returns entries with at least `id`.
 *   `AuthRepository` (`./auth-repository.js`) is extended as that needs.
 *
 * ## Why this fails right now
 *
 * `identity.credentials` does not exist on the router (a TypeError on the call) and
 * `./credentials.js` exports none of the symbols above.
 */
import { randomUUID } from 'node:crypto';

import { createRouterClient } from '@orpc/server';
import { authSchema, createAuth, type AuthInstance } from '@tayzu/auth';
import {
  createMachineCredential,
  revokeMachineCredential,
  type MachineCredentialActorKind,
} from '@tayzu/auth/machine-credentials';
import { createCerbosClient, type CerbosClient } from '@tayzu/authz';
import { createUserSync } from '@tayzu/catalog';
import { runMigrations } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { harnessPools } from '../__fixtures__/pools.js';
import { createIdentityRouter } from '../identity-router.js';
import { createAuthRepository, type AuthRepository } from './auth-repository.js';
import { readAllApiKeys, readApiKeyMetadata } from './credentials.js';
import { createWithUserLock } from './user-lock.js';
import { createUserSyncAdapter } from './user-sync-adapter.js';
import { createAdminUser } from '../../../../packages/auth/src/__fixtures__/admin-user.js';
import {
  TEST_PASSWORD,
  TEST_SECRET,
} from '../../../../packages/auth/src/__fixtures__/test-secret.js';

interface OrganizationSurface {
  createOrganization(args: {
    body: { name: string; slug: string; userId: string };
  }): Promise<{ id: string }>;
  addMember(args: {
    body: { userId: string; organizationId: string; role: string };
  }): Promise<unknown>;
}

interface CredentialView {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly prefix: string;
  readonly createdAt: unknown;
  readonly lastRequest: unknown;
  readonly enabled: boolean;
  readonly rotationDueAt: unknown;
  readonly createdBy?: string;
}

interface ListOutput {
  readonly credentials: readonly CredentialView[];
  readonly truncated: boolean;
}

interface Tenant {
  readonly tenantId: string;
  readonly adminId: string;
  readonly adminEmail: string;
}

interface Seeded {
  readonly id: string;
  readonly secret: string;
}

describe('identity.credentials.list (task 9.2)', () => {
  let appPool: Pool;
  let authPool: Pool;
  let auth: AuthInstance;
  let cerbos: CerbosClient;
  let authRepository: AuthRepository;

  beforeAll(async () => {
    const pools = await harnessPools();
    appPool = pools.appPool;
    authPool = pools.authPool;
    await runMigrations(authPool);
    cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    const userSync = createUserSync({ pool: appPool, authz: cerbos });
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync: createUserSyncAdapter({ userSync }),
    });
    authRepository = createAuthRepository(authPool);
  }, 60_000);

  function clientFor(credentialCap?: number) {
    return createRouterClient(
      createIdentityRouter({
        auth,
        authz: cerbos,
        authRepository,
        withUserLock: createWithUserLock(authPool),
        appPool,
        ...(credentialCap === undefined ? {} : { credentialCap }),
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );
  }

  async function freshTenant(): Promise<Tenant> {
    const id = randomUUID();
    const api = auth.api as OrganizationSurface;
    const owner = await createAdminUser(auth, {
      name: 'Credentials Owner',
      email: `cred-owner-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    const org = await api.createOrganization({
      body: { name: 'Credentials Org', slug: `credentials-${id}`, userId: owner.userId },
    });
    const adminEmail = `cred-admin-${id}@example.test`;
    const admin = await createAdminUser(auth, {
      name: 'Credentials Admin',
      email: adminEmail,
      password: TEST_PASSWORD,
    });
    await api.addMember({
      body: { userId: admin.userId, organizationId: org.id, role: 'admin' },
    });
    return { tenantId: org.id, adminId: admin.userId, adminEmail };
  }

  function context(tenant: Tenant, roles: string[] = ['admin']): Record<string, unknown> {
    return {
      tenantId: tenant.tenantId,
      actor: { type: 'user', id: tenant.adminId },
      principal: { roles },
    };
  }

  async function seed(
    tenant: Tenant,
    name: string,
    actorKind: MachineCredentialActorKind = 'integration',
    withCreatedBy = true,
  ): Promise<Seeded> {
    const created = await createMachineCredential(auth, {
      userId: tenant.adminId,
      organizationId: tenant.tenantId,
      name,
      actorKind,
      ...(withCreatedBy ? { metadata: { createdBy: tenant.adminId } } : {}),
    });
    return { id: created.id, secret: created.secret };
  }

  async function revoke(tenant: Tenant, id: string): Promise<void> {
    await revokeMachineCredential(auth, {
      userId: tenant.adminId,
      id,
      pool: appPool,
      tenantId: tenant.tenantId,
    });
  }

  /** Runs `count` async jobs, `width` at a time. */
  async function inBatches<T>(
    count: number,
    width: number,
    job: (index: number) => Promise<T>,
  ): Promise<T[]> {
    const results: T[] = [];
    for (let start = 0; start < count; start += width) {
      const batch = Array.from({ length: Math.min(width, count - start) }, (_, i) =>
        job(start + i),
      );
      results.push(...(await Promise.all(batch)));
    }
    return results;
  }

  it('Listing never includes the secret: 3 credentials, each entry has the constant prefix, and no field equals a secret or the stored hash', async () => {
    const tenant = await freshTenant();
    const seeded = [
      await seed(tenant, 'First integration', 'integration'),
      await seed(tenant, 'Second integration', 'integration'),
      await seed(tenant, 'The agent', 'agent'),
    ];
    // Another tenant's credential must never appear.
    const other = await freshTenant();
    const foreign = await seed(other, 'Foreign credential');

    const output = (await clientFor().identity.credentials.list(
      {},
      { context: context(tenant) },
    )) as ListOutput;

    expect(output.credentials).toHaveLength(3);
    expect(output.credentials.map((c) => c.id).sort()).toEqual(seeded.map((s) => s.id).sort());
    expect(output.credentials.map((c) => c.id)).not.toContain(foreign.id);
    for (const entry of output.credentials) {
      expect(entry.prefix).toBe('tayzu_mc_');
      expect(entry).toHaveProperty('name');
      expect(entry).toHaveProperty('kind');
      expect(entry).toHaveProperty('createdAt');
      expect(entry).toHaveProperty('lastRequest');
      expect(entry).toHaveProperty('enabled');
      expect(entry).toHaveProperty('rotationDueAt');
      expect(entry).not.toHaveProperty('key');
      expect(entry).not.toHaveProperty('secret');
    }
    expect(output.credentials.map((c) => c.kind).sort()).toEqual([
      'agent',
      'integration',
      'integration',
    ]);

    // No field anywhere equals (or contains) a secret, or the stored hashed key column.
    const serialized = JSON.stringify(output);
    for (const { secret } of seeded) expect(serialized).not.toContain(secret);
    const hashes = await authPool.query<{ key: string }>(
      'select key from auth.apikey where reference_id = $1',
      [tenant.tenantId],
    );
    expect(hashes.rows).toHaveLength(3);
    for (const { key } of hashes.rows) expect(serialized).not.toContain(key);
  }, 120_000);

  it('Non-admin cannot list credentials: a member is denied with AUTH_FORBIDDEN', async () => {
    const tenant = await freshTenant();
    await seed(tenant, 'Hidden credential');

    await expect(
      clientFor().identity.credentials.list({}, { context: context(tenant, ['member']) }),
    ).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });
  }, 120_000);

  it('The viewer shows every credential a tenant can hold: 200 non-revoked and 30 revoked list all 200 non-revoked ones, truncated', async () => {
    const tenant = await freshTenant();
    const active = await inBatches(200, 20, (i) => seed(tenant, `active-${String(i)}`));
    const revoked = await inBatches(30, 15, (i) => seed(tenant, `revoked-${String(i)}`));
    await inBatches(revoked.length, 10, (i) => revoke(tenant, revoked[i]?.id ?? ''));

    const output = (await clientFor().identity.credentials.list(
      {},
      { context: context(tenant) },
    )) as ListOutput;

    expect(output.credentials).toHaveLength(200);
    expect(output.credentials.map((c) => c.id).sort()).toEqual(active.map((a) => a.id).sort());
    expect(output.credentials.every((c) => c.enabled)).toBe(true);
    expect(output.truncated).toBe(true);
  }, 300_000);

  it('The page limit applies: with the cap at 5, non-revoked credentials come first and the page holds 5', async () => {
    const tenant = await freshTenant();
    const revoked = [
      await seed(tenant, 'revoked-a'),
      await seed(tenant, 'revoked-b'),
      await seed(tenant, 'revoked-c'),
    ];
    // Revoked ones are created first so that creation order cannot explain the ordering.
    for (const { id } of revoked) await revoke(tenant, id);
    const active = [
      await seed(tenant, 'active-a'),
      await seed(tenant, 'active-b'),
      await seed(tenant, 'active-c'),
      await seed(tenant, 'active-d'),
    ];

    const output = (await clientFor(5).identity.credentials.list(
      {},
      { context: context(tenant) },
    )) as ListOutput;

    expect(output.credentials).toHaveLength(5);
    expect(
      output.credentials
        .slice(0, 4)
        .map((c) => c.id)
        .sort(),
    ).toEqual(active.map((a) => a.id).sort());
    expect(output.credentials.slice(0, 4).every((c) => c.enabled)).toBe(true);
    expect(output.credentials[4]?.enabled).toBe(false);
    expect(revoked.map((r) => r.id)).toContain(output.credentials[4]?.id);
    expect(output.truncated).toBe(true);
  }, 120_000);

  it('The page limit applies: when every credential fits, nothing is truncated', async () => {
    const tenant = await freshTenant();
    const revoked = await seed(tenant, 'revoked-only');
    await revoke(tenant, revoked.id);
    await seed(tenant, 'active-one');
    await seed(tenant, 'active-two');

    const output = (await clientFor(5).identity.credentials.list(
      {},
      { context: context(tenant) },
    )) as ListOutput;

    expect(output.credentials).toHaveLength(3);
    expect(output.truncated).toBe(false);
  }, 120_000);

  it('A cap other than 200: with the cap at 7, all 7 non-revoked credentials are listed and revoked ones are left out', async () => {
    const tenant = await freshTenant();
    const active = await inBatches(7, 7, (i) => seed(tenant, `active-${String(i)}`));
    const revoked = await inBatches(2, 2, (i) => seed(tenant, `revoked-${String(i)}`));
    await inBatches(revoked.length, 2, (i) => revoke(tenant, revoked[i]?.id ?? ''));

    const output = (await clientFor(7).identity.credentials.list(
      {},
      { context: context(tenant) },
    )) as ListOutput;

    expect(output.credentials.map((c) => c.id).sort()).toEqual(active.map((a) => a.id).sort());
    expect(output.truncated).toBe(true);
  }, 120_000);

  it("Each entry carries the key's opaque apikey id, the one that rotate and revoke take as {credential}", async () => {
    const tenant = await freshTenant();
    const created = await seed(tenant, 'Addressable');

    const output = (await clientFor().identity.credentials.list(
      {},
      { context: context(tenant) },
    )) as ListOutput;

    expect(output.credentials).toHaveLength(1);
    expect(output.credentials[0]?.id).toBe(created.id);
    const row = await authPool.query<{ id: string }>(
      'select id from auth.apikey where reference_id = $1',
      [tenant.tenantId],
    );
    expect(row.rows.map((r) => r.id)).toEqual([created.id]);
  }, 120_000);

  it("The viewer shows who created a credential: createdBy is the creating admin's opaque id, no email, and absent for a key created without it", async () => {
    const tenant = await freshTenant();
    const withCreator = await seed(tenant, 'With creator');
    const without = await seed(tenant, 'Without creator', 'agent', false);

    const output = (await clientFor().identity.credentials.list(
      {},
      { context: context(tenant) },
    )) as ListOutput;

    const byId = new Map(output.credentials.map((c) => [c.id, c]));
    expect(byId.get(withCreator.id)?.createdBy).toBe(tenant.adminId);
    expect(byId.get(without.id)?.createdBy).toBeUndefined();
    expect(JSON.stringify(output)).not.toContain(tenant.adminEmail);
    expect(JSON.stringify(output)).not.toContain('@example.test');
  }, 120_000);

  it('The adapter returns apikey.metadata as an object, and the reader accepts both an object and a JSON string', async () => {
    const tenant = await freshTenant();
    const created = await seed(tenant, 'Metadata shape', 'agent');

    // Pin: the plugin's `transform.output` makes the adapter return an object.
    const { adapter } = (await auth.$context) as {
      adapter: {
        findOne<T>(args: {
          model: string;
          where: readonly { field: string; value: string }[];
        }): Promise<T | null>;
      };
    };
    // The pin is on the adapter's own output shape, which only a direct adapter read shows.
    const row = await adapter.findOne<{ metadata: unknown }>({
      // eslint-disable-next-line no-restricted-syntax -- test pins the plugin's adapter output (task 9.2)
      model: 'apikey',
      where: [{ field: 'id', value: created.id }],
    });
    expect(typeof row?.metadata).toBe('object');
    expect(row?.metadata).not.toBeNull();

    const expected = { actorKind: 'agent', createdBy: tenant.adminId };
    expect(readApiKeyMetadata(row?.metadata)).toMatchObject(expected);
    expect(readApiKeyMetadata(JSON.stringify(row?.metadata))).toMatchObject(expected);
    expect(
      readApiKeyMetadata(
        JSON.stringify({ userId: 'svc-x', rotatedAt: '2026-01-01T00:00:00.000Z' }),
      ),
    ).toMatchObject({ userId: 'svc-x', rotatedAt: '2026-01-01T00:00:00.000Z' });
  }, 120_000);

  it('The paged lookup reaches the end: a tenant with more keys than the page size yields every one of its keys and none of another tenant', async () => {
    const tenant = await freshTenant();
    const seeded = await inBatches(8, 8, (i) => seed(tenant, `many-${String(i)}`));
    const other = await freshTenant();
    const foreign = await seed(other, 'Foreign');

    const found = await readAllApiKeys(authRepository, tenant.tenantId, { pageSize: 3 });

    const ids = found.map((k) => k.id);
    expect(ids.slice().sort()).toEqual(seeded.map((s) => s.id).sort());
    expect(ids).not.toContain(foreign.id);
    // The key that sorts last is beyond the first pages of 3.
    const last = seeded.map((s) => s.id).sort()[seeded.length - 1];
    expect(ids).toContain(last);
  }, 120_000);
});
