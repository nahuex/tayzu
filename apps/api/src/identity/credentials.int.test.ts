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
import {
  authSchema,
  createAuth,
  createContextResolver,
  exchangeMachineToken,
  type AuthInstance,
} from '@tayzu/auth';
import {
  createMachineCredential,
  revokeMachineCredential,
  type MachineCredentialActorKind,
} from '@tayzu/auth/machine-credentials';
import { createCerbosClient, type CerbosClient } from '@tayzu/authz';
import { createEntityService, createUserSync } from '@tayzu/catalog';
import { runMigrations, withTenantTransaction } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type * as MachineCredentialsModule from '@tayzu/auth/machine-credentials';

import { harnessPools } from '../__fixtures__/pools.js';
import { createIdentityRouter } from '../identity-router.js';
import { createAuthRepository, type AuthRepository } from './auth-repository.js';
import {
  DEFAULT_ROTATION_INTERVAL_DAYS,
  readAllApiKeys,
  readApiKeyMetadata,
} from './credentials.js';
import { createWithUserLock } from './user-lock.js';
import { createUserSyncAdapter } from './user-sync-adapter.js';
import { createAdminUser } from '../../../../packages/auth/src/__fixtures__/admin-user.js';
import {
  TEST_PASSWORD,
  TEST_SECRET,
} from '../../../../packages/auth/src/__fixtures__/test-secret.js';

/**
 * Failure seam of task 9.7: `revokeMachineCredential` delegates to the real function except for
 * the credential ids listed here, for which it throws before writing anything. Empty by default,
 * so every other test of this file sees the real behavior.
 */
const revokeSeam = vi.hoisted(() => ({ failFor: new Set<string>() }));

vi.mock('@tayzu/auth/machine-credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof MachineCredentialsModule>();
  return {
    ...actual,
    revokeMachineCredential: async (
      ...args: Parameters<typeof actual.revokeMachineCredential>
    ): Promise<void> => {
      if (revokeSeam.failFor.has(args[1].id)) throw new Error('injected revoke failure');
      await actual.revokeMachineCredential(...args);
    },
  };
});

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

  /*
   * Task 9.3: "A credential MUST be shown disabled when its key is disabled, it is revoked,
   * or its bound service account is `Disabled`." Each case is checked next to an untouched
   * credential of the same tenant that stays enabled. Production symbols expected: none new;
   * `identity.credentials.list` of 9.2 joins `metadata.userId` to the tenant's `_user`
   * entity (identifier = `metadata.userId`) and derives `enabled` from its `status`.
   */
  async function listFor(tenant: Tenant): Promise<Map<string, CredentialView>> {
    const output = (await clientFor().identity.credentials.list(
      {},
      { context: context(tenant) },
    )) as ListOutput;
    return new Map(output.credentials.map((c) => [c.id, c]));
  }

  async function seedBound(tenant: Tenant, name: string, userId: string): Promise<Seeded> {
    const created = await createMachineCredential(auth, {
      userId: tenant.adminId,
      organizationId: tenant.tenantId,
      name,
      actorKind: 'integration',
      metadata: { userId, createdBy: tenant.adminId },
    });
    return { id: created.id, secret: created.secret };
  }

  async function seedServiceAccount(
    tenant: Tenant,
    identifier: string,
    status: 'Active' | 'Disabled',
  ): Promise<void> {
    await createEntityService({ pool: appPool, authz: cerbos }).create(
      {
        tenantId: tenant.tenantId,
        actor: { type: 'system', id: 'credentials-test-seed' },
        principal: { roles: ['admin'] },
      },
      {
        blueprint: '_user',
        identifier,
        title: 'Service account',
        spec: { properties: { accountKind: 'service', status } },
      },
    );
  }

  it('A credential is shown disabled when its key is disabled', async () => {
    const tenant = await freshTenant();
    const disabled = await seed(tenant, 'Disabled key');
    const untouched = await seed(tenant, 'Untouched key');
    await authPool.query('update auth.apikey set enabled = false where id = $1', [disabled.id]);

    const byId = await listFor(tenant);

    expect(byId.get(disabled.id)?.enabled).toBe(false);
    expect(byId.get(untouched.id)?.enabled).toBe(true);
  }, 120_000);

  it('A credential is shown disabled when it is revoked', async () => {
    const tenant = await freshTenant();
    const revoked = await seed(tenant, 'Revoked key');
    const untouched = await seed(tenant, 'Untouched key');
    await revoke(tenant, revoked.id);

    const byId = await listFor(tenant);

    expect(byId.get(revoked.id)?.enabled).toBe(false);
    expect(byId.get(untouched.id)?.enabled).toBe(true);
  }, 120_000);

  it('A credential is shown disabled when its bound service account is Disabled', async () => {
    const tenant = await freshTenant();
    const suffix = randomUUID().slice(0, 8);
    const disabledAccount = `svc-off-${suffix}`;
    const activeAccount = `svc-on-${suffix}`;
    await seedServiceAccount(tenant, disabledAccount, 'Disabled');
    await seedServiceAccount(tenant, activeAccount, 'Active');
    const ofDisabled = await seedBound(tenant, 'Of disabled account', disabledAccount);
    const ofActive = await seedBound(tenant, 'Of active account', activeAccount);

    const byId = await listFor(tenant);

    expect(byId.get(ofDisabled.id)?.kind).toBe('service_account');
    expect(byId.get(ofDisabled.id)?.enabled).toBe(false);
    expect(byId.get(ofActive.id)?.kind).toBe('service_account');
    expect(byId.get(ofActive.id)?.enabled).toBe(true);
  }, 120_000);
});

/**
 * Task 9.5 of openspec/changes/043-identity-lifecycle-and-org-admin
 * (`identity.credentials.create`, integration and agent credentials; design D8; Resolved
 * decisions Q20, Q44, Q90, Q94).
 *
 * Scenario (verbatim from the spec): "Creating a credential requires step-up and bounds its
 * use": WHEN an admin without a fresh step-up verification creates a credential, THEN the
 * operation fails with `AUTH_STEP_UP_REQUIRED`; with a fresh verification the created key has
 * the configured rate limit and stores no secret characters. The step-up part is asserted over
 * HTTP in 14.4; this block is the service-level part (the key's limits, its metadata, the name
 * limit, and a non-owner `admin` and an `owner` each creating through the operation).
 *
 * ## Production symbols expected
 *
 * - `createIdentityRouter` (`../identity-router.js`): `identity.credentials.create`, a
 *   `defineIdentityOperation` on `RESOURCE_KINDS.credential` / `create`, flat input
 *   `{ name: string; kind: 'integration' | 'agent' }` (`name` 1 to 32 characters of
 *   `[A-Za-z0-9 _.-]`), output containing `{ id: string; secret: string }` (the secret once).
 *   It calls the headerless `createMachineCredential` with `userId` the acting admin and the
 *   metadata `{ createdBy: <acting admin> }`.
 * - `createAuth` (`@tayzu/auth`) gains the option `machineCredentialRateLimit?: { max: number;
 *   timeWindowMs: number }` (default 60 per 3 600 000 ms), the plugin-level `rateLimit` of the
 *   `machine-credential` apiKey config, plus `startingCharactersConfig: { shouldStore: false }`.
 */
describe('identity.credentials.create (task 9.5)', () => {
  let appPool: Pool;
  let authPool: Pool;
  let cerbos: CerbosClient;
  let authRepository: AuthRepository;
  let userSync: ReturnType<typeof createUserSync>;
  let defaultAuth: AuthInstance;

  function authWith(rateLimit?: { max: number; timeWindowMs: number }): AuthInstance {
    const options = {
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync: createUserSyncAdapter({ userSync }),
      ...(rateLimit === undefined ? {} : { machineCredentialRateLimit: rateLimit }),
    };
    return createAuth(options);
  }

  beforeAll(async () => {
    const pools = await harnessPools();
    appPool = pools.appPool;
    authPool = pools.authPool;
    await runMigrations(authPool);
    cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    userSync = createUserSync({ pool: appPool, authz: cerbos });
    defaultAuth = authWith();
    authRepository = createAuthRepository(authPool);
  }, 60_000);

  function clientFor(auth: AuthInstance) {
    return createRouterClient(
      createIdentityRouter({
        auth,
        authz: cerbos,
        authRepository,
        withUserLock: createWithUserLock(authPool),
        appPool,
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );
  }

  interface CreateOutput {
    readonly id: string;
    readonly secret: string;
  }

  interface CreatableClient {
    identity: {
      credentials: {
        create(
          input: { name: string; kind: string },
          options: { context: Record<string, unknown> },
        ): Promise<CreateOutput>;
      };
    };
  }

  function creator(auth: AuthInstance): CreatableClient {
    return clientFor(auth);
  }

  interface Org {
    readonly tenantId: string;
    readonly ownerId: string;
    readonly adminId: string;
  }

  async function freshOrg(auth: AuthInstance): Promise<Org> {
    const id = randomUUID();
    const api = auth.api as OrganizationSurface;
    const owner = await createAdminUser(auth, {
      name: 'Create Owner',
      email: `create-owner-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    const org = await api.createOrganization({
      body: { name: 'Create Org', slug: `create-${id}`, userId: owner.userId },
    });
    const admin = await createAdminUser(auth, {
      name: 'Create Admin',
      email: `create-admin-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    await api.addMember({ body: { userId: admin.userId, organizationId: org.id, role: 'admin' } });
    return { tenantId: org.id, ownerId: owner.userId, adminId: admin.userId };
  }

  function contextOf(org: Org, actorId: string): Record<string, unknown> {
    return {
      tenantId: org.tenantId,
      actor: { type: 'user', id: actorId },
      principal: { roles: ['admin'] },
    };
  }

  interface KeyRow {
    readonly id: string;
    readonly start: string | null;
    readonly prefix: string | null;
    readonly rate_limit_enabled: boolean | null;
    readonly rate_limit_max: number | null;
    readonly rate_limit_time_window: number | null;
    readonly expires_at: Date | null;
    readonly metadata: unknown;
  }

  async function keyRows(org: Org): Promise<KeyRow[]> {
    const rows = await authPool.query<KeyRow>(
      `select id, start, prefix, rate_limit_enabled, rate_limit_max, rate_limit_time_window,
              expires_at, metadata
         from auth.apikey where reference_id = $1 order by created_at`,
      [org.tenantId],
    );
    return rows.rows;
  }

  const metadataOf = (row: KeyRow): Record<string, unknown> =>
    readApiKeyMetadata(row.metadata) as Record<string, unknown>;

  it('Creating a credential requires step-up and bounds its use: a non-owner admin creates a key with the default limit of 60 per hour, no stored secret characters, no expiry, and createdBy', async () => {
    const org = await freshOrg(defaultAuth);

    const created = await creator(defaultAuth).identity.credentials.create(
      { name: 'Billing sync', kind: 'integration' },
      { context: contextOf(org, org.adminId) },
    );

    expect(created.secret).toMatch(/^tayzu_mc_/);
    const rows = await keyRows(org);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.id).toBe(created.id);
    expect(row?.rate_limit_enabled).toBe(true);
    expect(row?.rate_limit_max).toBe(60);
    expect(row?.rate_limit_time_window).toBe(3_600_000);
    expect(row?.start ?? '').toBe('');
    expect(row?.expires_at).toBeNull();
    expect(row !== undefined && JSON.stringify(row)).not.toContain(created.secret);
    expect(row === undefined ? {} : metadataOf(row)).toEqual({
      actorKind: 'integration',
      role: 'member',
      createdBy: org.adminId,
    });
    expect((await readAllApiKeys(authRepository, org.tenantId)).map((k) => k.id)).toEqual([
      created.id,
    ]);
  }, 120_000);

  it('An owner creates an agent credential through the operation, recorded as the creator', async () => {
    const org = await freshOrg(defaultAuth);

    const created = await creator(defaultAuth).identity.credentials.create(
      { name: 'Planner agent', kind: 'agent' },
      { context: contextOf(org, org.ownerId) },
    );

    const [row] = await keyRows(org);
    expect(row?.id).toBe(created.id);
    expect(row === undefined ? {} : metadataOf(row)).toEqual({
      actorKind: 'agent',
      role: 'member',
      createdBy: org.ownerId,
    });
    expect(row?.rate_limit_max).toBe(60);
  }, 120_000);

  it('A configured limit is honored by the created key', async () => {
    const tuned = authWith({ max: 7, timeWindowMs: 120_000 });
    const org = await freshOrg(tuned);

    await creator(tuned).identity.credentials.create(
      { name: 'Tuned', kind: 'integration' },
      { context: contextOf(org, org.adminId) },
    );

    const [row] = await keyRows(org);
    expect(row?.rate_limit_enabled).toBe(true);
    expect(row?.rate_limit_max).toBe(7);
    expect(row?.rate_limit_time_window).toBe(120_000);
    expect(row?.start ?? '').toBe('');
  }, 120_000);

  it('A changed limit applies only to keys created afterwards', async () => {
    const before = authWith({ max: 60, timeWindowMs: 3_600_000 });
    const after = authWith({ max: 5, timeWindowMs: 60_000 });
    const org = await freshOrg(before);

    const first = await creator(before).identity.credentials.create(
      { name: 'Before change', kind: 'integration' },
      { context: contextOf(org, org.adminId) },
    );
    const second = await creator(after).identity.credentials.create(
      { name: 'After change', kind: 'integration' },
      { context: contextOf(org, org.adminId) },
    );

    const byId = new Map((await keyRows(org)).map((r) => [r.id, r]));
    expect(byId.get(first.id)?.rate_limit_max).toBe(60);
    expect(byId.get(first.id)?.rate_limit_time_window).toBe(3_600_000);
    expect(byId.get(second.id)?.rate_limit_max).toBe(5);
    expect(byId.get(second.id)?.rate_limit_time_window).toBe(60_000);
  }, 120_000);

  it('A 33-character name is refused with CATALOG_VALIDATION_FAILED and nothing is created; 32 characters are accepted', async () => {
    const org = await freshOrg(defaultAuth);
    const client = creator(defaultAuth);

    await expect(
      client.identity.credentials.create(
        { name: 'a'.repeat(33), kind: 'integration' },
        { context: contextOf(org, org.adminId) },
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });
    expect(await keyRows(org)).toHaveLength(0);

    await client.identity.credentials.create(
      { name: 'a'.repeat(32), kind: 'integration' },
      { context: contextOf(org, org.adminId) },
    );
    expect(await keyRows(org)).toHaveLength(1);
  }, 120_000);

  it('A name outside [A-Za-z0-9 _.-] or empty is refused with CATALOG_VALIDATION_FAILED', async () => {
    const org = await freshOrg(defaultAuth);
    const client = creator(defaultAuth);

    for (const name of ['', 'bad/name', 'semi;colon', 'émile']) {
      await expect(
        client.identity.credentials.create(
          { name, kind: 'integration' },
          { context: contextOf(org, org.adminId) },
        ),
      ).rejects.toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });
    }
    expect(await keyRows(org)).toHaveLength(0);
  }, 120_000);

  it('A member is denied by Cerbos and nothing is created', async () => {
    const org = await freshOrg(defaultAuth);

    await expect(
      creator(defaultAuth).identity.credentials.create(
        { name: 'Denied', kind: 'integration' },
        {
          context: {
            tenantId: org.tenantId,
            actor: { type: 'user', id: org.adminId },
            principal: { roles: ['member'] },
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });
    expect(await keyRows(org)).toHaveLength(0);
  }, 120_000);
});

/**
 * Task 9.5b of openspec/changes/043-identity-lifecycle-and-org-admin
 * (the optional `userId` of `identity.credentials.create`; design D6, D14; Resolved decisions
 * Q40, Q62, Q90).
 *
 * Scenarios (verbatim from the spec):
 * - "A credential cannot be bound to a user outside the tenant or to a human": WHEN an admin
 *   creates a credential with a `userId` that is a human, unknown, or a service account of
 *   another tenant, THEN the operation fails with `CATALOG_NOT_FOUND` and nothing is created.
 * - "A service account holds one active credential": GIVEN a service account with an active
 *   credential, WHEN an admin creates another credential bound to it, THEN the operation fails
 *   with `CATALOG_VALIDATION_FAILED`, and after the first is revoked a new one can be created.
 *
 * ## Production symbols expected
 *
 * - `identity.credentials.create` accepts the optional input `userId: string` (the `svc-…`
 *   identifier of a service account), resolved server-side within the caller's tenant (the
 *   resolver of 10.7b, or a lookup of the same shape): the `_user` must have
 *   `accountKind == "service"` and an `svc-` identifier, else `CATALOG_NOT_FOUND`. The created
 *   key's metadata then carries `userId` (the `svc-…` identifier). A service account that
 *   already has a non-revoked credential is refused with `CATALOG_VALIDATION_FAILED`.
 */
describe('identity.credentials.create with a bound userId (task 9.5b)', () => {
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

  interface BoundClient {
    identity: {
      credentials: {
        create(
          input: { name: string; kind: string; userId?: string },
          options: { context: Record<string, unknown> },
        ): Promise<{ id: string; secret: string }>;
      };
    };
  }

  function client(): BoundClient {
    return createRouterClient(
      createIdentityRouter({
        auth,
        authz: cerbos,
        authRepository,
        withUserLock: createWithUserLock(authPool),
        appPool,
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );
  }

  interface Org {
    readonly tenantId: string;
    readonly adminId: string;
  }

  async function freshOrg(): Promise<Org> {
    const id = randomUUID();
    const api = auth.api as OrganizationSurface;
    const owner = await createAdminUser(auth, {
      name: 'Bound Owner',
      email: `bound-owner-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    const org = await api.createOrganization({
      body: { name: 'Bound Org', slug: `bound-${id}`, userId: owner.userId },
    });
    const admin = await createAdminUser(auth, {
      name: 'Bound Admin',
      email: `bound-admin-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    await api.addMember({ body: { userId: admin.userId, organizationId: org.id, role: 'admin' } });
    return { tenantId: org.id, adminId: admin.userId };
  }

  function contextOf(org: Org): Record<string, unknown> {
    return {
      tenantId: org.tenantId,
      actor: { type: 'user', id: org.adminId },
      principal: { roles: ['admin'] },
    };
  }

  async function seedUser(
    org: Org,
    identifier: string,
    properties: Record<string, unknown>,
  ): Promise<void> {
    await createEntityService({ pool: appPool, authz: cerbos }).create(
      {
        tenantId: org.tenantId,
        actor: { type: 'system', id: 'credentials-test-seed' },
        principal: { roles: ['admin'] },
      },
      { blueprint: '_user', identifier, title: 'Seeded user', spec: { properties } },
    );
  }

  const seedServiceAccount = (org: Org, identifier: string): Promise<void> =>
    seedUser(org, identifier, { accountKind: 'service', status: 'Active' });

  async function keyIds(org: Org): Promise<string[]> {
    const rows = await authPool.query<{ id: string }>(
      'select id from auth.apikey where reference_id = $1',
      [org.tenantId],
    );
    return rows.rows.map((r) => r.id);
  }

  it('A credential cannot be bound to a user outside the tenant or to a human: CATALOG_NOT_FOUND and nothing is created', async () => {
    const org = await freshOrg();
    const other = await freshOrg();
    const suffix = randomUUID().slice(0, 8);
    const foreign = `svc-foreign-${suffix}`;
    const humanLookalike = `svc-human-${suffix}`;
    await seedServiceAccount(other, foreign);
    // A standard `_user` is not a service account even with an `svc-` identifier.
    await seedUser(org, humanLookalike, { accountKind: 'standard', status: 'Active' });

    const targets = [
      org.adminId, // a human (the acting admin's own `_user`)
      humanLookalike,
      `svc-unknown-${suffix}`,
      foreign, // a service account of another tenant
    ];
    for (const userId of targets) {
      await expect(
        client().identity.credentials.create(
          { name: 'Bound', kind: 'integration', userId },
          { context: contextOf(org) },
        ),
      ).rejects.toMatchObject({ code: 'CATALOG_NOT_FOUND' });
    }
    expect(await keyIds(org)).toHaveLength(0);
    expect(await keyIds(other)).toHaveLength(0);
  }, 120_000);

  it('A credential bound to a service account of the tenant is created with its svc- identifier in the metadata', async () => {
    const org = await freshOrg();
    const identifier = `svc-ok-${randomUUID().slice(0, 8)}`;
    await seedServiceAccount(org, identifier);

    const created = await client().identity.credentials.create(
      { name: 'Bound', kind: 'integration', userId: identifier },
      { context: contextOf(org) },
    );

    expect(await keyIds(org)).toEqual([created.id]);
    const keys = await readAllApiKeys(authRepository, org.tenantId);
    expect(keys.map((k) => k.id)).toEqual([created.id]);
    const row = await authPool.query<{ metadata: unknown }>(
      'select metadata from auth.apikey where id = $1',
      [created.id],
    );
    expect(readApiKeyMetadata(row.rows[0]?.metadata)).toMatchObject({
      userId: identifier,
      createdBy: org.adminId,
    });
  }, 120_000);

  it('A service account holds one active credential: a second create is refused with CATALOG_VALIDATION_FAILED, and after the first is revoked a new one can be created', async () => {
    const org = await freshOrg();
    const identifier = `svc-one-${randomUUID().slice(0, 8)}`;
    await seedServiceAccount(org, identifier);
    const input = { name: 'Bound', kind: 'integration', userId: identifier };

    const first = await client().identity.credentials.create(input, { context: contextOf(org) });

    await expect(
      client().identity.credentials.create(input, { context: contextOf(org) }),
    ).rejects.toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });
    expect(await keyIds(org)).toEqual([first.id]);

    await revokeMachineCredential(auth, {
      userId: org.adminId,
      id: first.id,
      pool: appPool,
      tenantId: org.tenantId,
    });

    const second = await client().identity.credentials.create(input, {
      context: contextOf(org),
    });
    expect(second.id).not.toBe(first.id);
    expect((await keyIds(org)).sort()).toEqual([first.id, second.id].sort());
  }, 120_000);

  /**
   * Task 9.5c: "Concurrent credential creation for one service account yields one": GIVEN a
   * service account with no active credential, WHEN two admins create a credential bound to it
   * at the same time, THEN exactly one succeeds, the other fails with
   * `CATALOG_VALIDATION_FAILED`, and exactly one credential is active.
   *
   * Production behavior expected: the check-then-insert of `createCredential`
   * (`./credentials.ts`) runs under a per-service-account Postgres advisory lock.
   */
  it('Concurrent credential creation for one service account yields one', async () => {
    const org = await freshOrg();
    const identifier = `svc-race-${randomUUID().slice(0, 8)}`;
    await seedServiceAccount(org, identifier);
    const input = { name: 'Bound', kind: 'integration', userId: identifier };

    const results = await Promise.allSettled([
      client().identity.credentials.create(input, { context: contextOf(org) }),
      client().identity.credentials.create(input, { context: contextOf(org) }),
    ]);

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<{ id: string; secret: string }> => r.status === 'fulfilled',
    );
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });

    const keys = await readAllApiKeys(authRepository, org.tenantId);
    const active = keys.filter((k) => readApiKeyMetadata(k.metadata).userId === identifier);
    expect(active).toHaveLength(1);
    expect(active.map((k) => k.id)).toEqual(fulfilled.map((r) => r.value.id));
    expect(await keyIds(org)).toHaveLength(1);
  }, 120_000);
});

/**
 * Task 9.5d of openspec/changes/043-identity-lifecycle-and-org-admin
 * (the per-tenant credential cap; design D8; Resolved decision Q56).
 *
 * Scenario (verbatim from the spec): "The credential cap and the name limit hold": GIVEN a
 * tenant with 200 non-revoked credentials, WHEN an admin creates another, or creates one with a
 * name of 33 characters, THEN the creation fails with `CATALOG_VALIDATION_FAILED` and nothing
 * is created. Also: a tenant MUST NOT hold more than 200 non-revoked credentials; a revoked one
 * does not count; concurrent creates under the per-tenant advisory lock cannot overshoot.
 *
 * ## Production symbols expected
 *
 * - `createIdentityRouter` (`../identity-router.js`): `options.credentialCap` (already the page
 *   size of the viewer, default 200) is also the cap that `identity.credentials.create` enforces
 *   by counting the tenant's non-revoked keys through `readAllApiKeys` and the revocation list,
 *   under a per-tenant Postgres advisory lock. Beyond it: `CATALOG_VALIDATION_FAILED`.
 * - The key issued by `identity.serviceAccounts.create` counts and is bound by the same cap
 *   (its router procedure does not exist yet, so it is covered where that operation is tested).
 */
describe('the credential cap holds (task 9.5d, Q56)', () => {
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

  interface CapClient {
    identity: {
      credentials: {
        create(
          input: { name: string; kind: string },
          options: { context: Record<string, unknown> },
        ): Promise<{ id: string; secret: string }>;
      };
    };
  }

  function client(): CapClient {
    return createRouterClient(
      createIdentityRouter({
        auth,
        authz: cerbos,
        authRepository,
        withUserLock: createWithUserLock(authPool),
        appPool,
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );
  }

  interface Org {
    readonly tenantId: string;
    readonly adminId: string;
  }

  async function freshOrg(): Promise<Org> {
    const id = randomUUID();
    const api = auth.api as OrganizationSurface;
    const owner = await createAdminUser(auth, {
      name: 'Cap Owner',
      email: `cap-owner-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    const org = await api.createOrganization({
      body: { name: 'Cap Org', slug: `cap-${id}`, userId: owner.userId },
    });
    const admin = await createAdminUser(auth, {
      name: 'Cap Admin',
      email: `cap-admin-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    await api.addMember({ body: { userId: admin.userId, organizationId: org.id, role: 'admin' } });
    return { tenantId: org.id, adminId: admin.userId };
  }

  function contextOf(org: Org): Record<string, unknown> {
    return {
      tenantId: org.tenantId,
      actor: { type: 'user', id: org.adminId },
      principal: { roles: ['admin'] },
    };
  }

  async function seedMany(org: Org, count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let start = 0; start < count; start += 20) {
      const batch = Array.from({ length: Math.min(20, count - start) }, (_, i) =>
        createMachineCredential(auth, {
          userId: org.adminId,
          organizationId: org.tenantId,
          name: `seed-${String(start + i)}`,
          actorKind: 'integration',
          metadata: { createdBy: org.adminId },
        }),
      );
      ids.push(...(await Promise.all(batch)).map((c) => c.id));
    }
    return ids;
  }

  async function keyCount(org: Org): Promise<number> {
    const rows = await authPool.query<{ n: string }>(
      'select count(*)::text as n from auth.apikey where reference_id = $1',
      [org.tenantId],
    );
    return Number(rows.rows[0]?.n);
  }

  const input = (name: string) => ({ name, kind: 'integration' });

  it('The credential cap and the name limit hold: with 200 non-revoked credentials the 201st is refused with CATALOG_VALIDATION_FAILED, a 33-character name is refused, and nothing is created', async () => {
    const org = await freshOrg();
    const ids = await seedMany(org, 200);
    expect(await keyCount(org)).toBe(200);

    await expect(
      client().identity.credentials.create(input('One too many'), { context: contextOf(org) }),
    ).rejects.toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });
    await expect(
      client().identity.credentials.create(input('a'.repeat(33)), { context: contextOf(org) }),
    ).rejects.toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });
    expect(await keyCount(org)).toBe(200);

    // A revoked credential does not count: revoking one frees exactly one place.
    await revokeMachineCredential(auth, {
      userId: org.adminId,
      id: ids[0] ?? '',
      pool: appPool,
      tenantId: org.tenantId,
    });
    const created = await client().identity.credentials.create(input('After revoke'), {
      context: contextOf(org),
    });
    expect(created.secret).toMatch(/^tayzu_mc_/);
    expect(await keyCount(org)).toBe(201);
    await expect(
      client().identity.credentials.create(input('Over again'), { context: contextOf(org) }),
    ).rejects.toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });
    expect(await keyCount(org)).toBe(201);
  }, 300_000);

  it('The cap is per tenant: a full tenant does not block another one', async () => {
    const full = await freshOrg();
    await seedMany(full, 200);
    const other = await freshOrg();

    await expect(
      client().identity.credentials.create(input('Blocked'), { context: contextOf(full) }),
    ).rejects.toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });
    const created = await client().identity.credentials.create(input('Free'), {
      context: contextOf(other),
    });
    expect(created.id).toEqual(expect.any(String));
  }, 300_000);

  it('Concurrent creates at 199 yield one success: the other is refused with CATALOG_VALIDATION_FAILED and the tenant ends at 200', async () => {
    const org = await freshOrg();
    await seedMany(org, 199);

    const results = await Promise.allSettled([
      client().identity.credentials.create(input('Racer one'), { context: contextOf(org) }),
      client().identity.credentials.create(input('Racer two'), { context: contextOf(org) }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });
    expect(await keyCount(org)).toBe(200);
  }, 300_000);
});

/**
 * Task 9.6 of openspec/changes/043-identity-lifecycle-and-org-admin
 * (`identity.credentials.rotate`; design D8; Resolved decisions Q40, Q90).
 *
 * Scenario (verbatim from the spec): "Rotating replaces the usable credential": GIVEN service
 * account `svc-ci-github` with credential `c1`, enabled, and an access token issued from it,
 * WHEN an admin rotates its credential, THEN a new credential `c2` is returned once with its
 * secret, `c1` is revoked, and `c1`'s issued token and any new exchange with `c1` are rejected
 * within seconds, AND the listing shows `c2` created by the rotating admin, with its
 * rotation-due threshold counted from the rotation.
 *
 * ## Production symbols expected
 *
 * - `createIdentityRouter` (`../identity-router.js`): `identity.credentials.rotate`, a
 *   `defineIdentityOperation` on `RESOURCE_KINDS.credential` / `rotate`, input
 *   `{ credential: string }` (the `id` that `identity.credentials.list` returns), output
 *   containing `{ id: string; secret: string }` (the new key's id and its secret, once).
 * - It creates the new key (metadata: the old key's `actorKind`, `role` and `userId`, `createdBy`
 *   the rotating admin, `rotatedAt` an ISO timestamp of the rotation), then retires the old key
 *   through `revokeMachineCredential` (the revocation list).
 */
describe('identity.credentials.rotate (task 9.6)', () => {
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

  interface RotateOutput {
    readonly id: string;
    readonly secret: string;
  }

  interface RotateClient {
    identity: {
      credentials: {
        list(
          input: Record<string, never>,
          options: { context: Record<string, unknown> },
        ): Promise<ListOutput>;
        rotate(
          input: { credential: string },
          options: { context: Record<string, unknown> },
        ): Promise<RotateOutput>;
      };
    };
  }

  function client(): RotateClient {
    return createRouterClient(
      createIdentityRouter({
        auth,
        authz: cerbos,
        authRepository,
        withUserLock: createWithUserLock(authPool),
        appPool,
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );
  }

  interface Org {
    readonly tenantId: string;
    readonly ownerId: string;
    readonly adminId: string;
  }

  async function freshOrg(): Promise<Org> {
    const id = randomUUID();
    const api = auth.api as OrganizationSurface;
    const owner = await createAdminUser(auth, {
      name: 'Rotate Owner',
      email: `rotate-owner-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    const org = await api.createOrganization({
      body: { name: 'Rotate Org', slug: `rotate-${id}`, userId: owner.userId },
    });
    const admin = await createAdminUser(auth, {
      name: 'Rotate Admin',
      email: `rotate-admin-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    await api.addMember({ body: { userId: admin.userId, organizationId: org.id, role: 'admin' } });
    return { tenantId: org.id, ownerId: owner.userId, adminId: admin.userId };
  }

  function contextOf(org: Org, actorId: string): Record<string, unknown> {
    return {
      tenantId: org.tenantId,
      actor: { type: 'user', id: actorId },
      principal: { roles: ['admin'] },
    };
  }

  async function seedServiceAccount(org: Org, identifier: string): Promise<void> {
    await createEntityService({ pool: appPool, authz: cerbos }).create(
      {
        tenantId: org.tenantId,
        actor: { type: 'system', id: 'credentials-test-seed' },
        principal: { roles: ['admin'] },
      },
      {
        blueprint: '_user',
        identifier,
        title: 'Service account',
        spec: { properties: { accountKind: 'service', status: 'Active' } },
      },
    );
  }

  async function metadataOfKey(id: string): Promise<ReturnType<typeof readApiKeyMetadata>> {
    const row = await authPool.query<{ metadata: unknown }>(
      'select metadata from auth.apikey where id = $1',
      [id],
    );
    return readApiKeyMetadata(row.rows[0]?.metadata);
  }

  async function revocationRows(org: Org, id: string): Promise<number> {
    const rows = await authPool.query('select 1 from auth.apikey where id = $1', [id]);
    expect(rows.rows).toHaveLength(1);
    const revoked = await withTenantTransaction(appPool, { tenantId: org.tenantId }, (client) =>
      client.query<{ n: string }>(
        `select count(*)::text as n from machine_credential_revocation
            where credential_id = $1 and tenant_id = $2`,
        [id, org.tenantId],
      ),
    );
    return Number(revoked.rows[0]?.n);
  }

  const REJECTION_WINDOW_MS = 8_000;

  /** Polls the resolver until it rejects the token, or the window (cache TTL 5 s plus slack) passes. */
  async function rejectedWithinWindow(
    resolveContext: (headers: Headers) => Promise<unknown>,
    token: string,
  ): Promise<boolean> {
    const deadline = Date.now() + REJECTION_WINDOW_MS;
    while (Date.now() < deadline) {
      try {
        await resolveContext(new Headers({ authorization: `Bearer ${token}` }));
      } catch {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }

  it("Rotating replaces the usable credential: a service account's c1 is revoked, its issued token and new exchanges are rejected within seconds, and c2 carries c1's metadata, the rotating admin and rotatedAt", async () => {
    const org = await freshOrg();
    const identifier = `svc-ci-github-${randomUUID().slice(0, 8)}`;
    await seedServiceAccount(org, identifier);
    // c1 was created by the admin; the owner rotates it, so createdBy must change.
    const c1 = await createMachineCredential(auth, {
      userId: org.adminId,
      organizationId: org.tenantId,
      name: 'CI GitHub',
      actorKind: 'integration',
      metadata: { userId: identifier, createdBy: org.adminId },
    });
    const resolveContext = createContextResolver({ auth, revocationPool: appPool });
    const issued = await exchangeMachineToken(auth, {
      clientId: c1.id,
      clientSecret: c1.secret,
    });
    // The token is usable before the rotation (this also warms the revocation cache).
    await expect(
      resolveContext(new Headers({ authorization: `Bearer ${issued.accessToken}` })),
    ).resolves.toMatchObject({ tenantId: org.tenantId, actor: { type: 'integration', id: c1.id } });

    const listed = await client().identity.credentials.list(
      {},
      { context: contextOf(org, org.ownerId) },
    );
    const c1Id = listed.credentials.find((c) => c.id === c1.id)?.id;
    expect(c1Id).toBe(c1.id);

    const before = Date.now();
    const rotated = await client().identity.credentials.rotate(
      { credential: c1Id ?? '' },
      { context: contextOf(org, org.ownerId) },
    );
    const after = Date.now();

    // THEN a new credential c2 is returned once with its secret.
    expect(rotated.id).not.toBe(c1.id);
    expect(rotated.secret).toMatch(/^tayzu_mc_/);
    expect(rotated.secret).not.toBe(c1.secret);

    // AND c1 is revoked: on the revocation list and disabled.
    expect(await revocationRows(org, c1.id)).toBe(1);
    expect(await revocationRows(org, rotated.id)).toBe(0);

    // AND c1's issued token is rejected within the cache window.
    expect(await rejectedWithinWindow(resolveContext, issued.accessToken)).toBe(true);
    // AND any new exchange with c1 is rejected.
    await expect(
      exchangeMachineToken(auth, { clientId: c1.id, clientSecret: c1.secret }),
    ).rejects.toThrow();

    // AND c2 is the usable credential.
    const fresh = await exchangeMachineToken(auth, {
      clientId: rotated.id,
      clientSecret: rotated.secret,
    });
    await expect(
      resolveContext(new Headers({ authorization: `Bearer ${fresh.accessToken}` })),
    ).resolves.toMatchObject({ tenantId: org.tenantId, actor: { id: rotated.id } });

    // AND c2's metadata copies c1's actorKind, role and userId, with the rotating admin and rotatedAt.
    const metadata = await metadataOfKey(rotated.id);
    expect(metadata).toMatchObject({
      actorKind: 'integration',
      role: 'member',
      userId: identifier,
      createdBy: org.ownerId,
    });
    const rotatedAt = new Date(metadata.rotatedAt ?? 'invalid');
    expect(Number.isNaN(rotatedAt.getTime())).toBe(false);
    expect(rotatedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(rotatedAt.getTime()).toBeLessThanOrEqual(after + 1000);

    // AND the listing shows c2 created by the rotating admin, its due date counted from rotatedAt.
    const after2 = await client().identity.credentials.list(
      {},
      { context: contextOf(org, org.ownerId) },
    );
    const byId = new Map(after2.credentials.map((c) => [c.id, c]));
    const c2View = byId.get(rotated.id);
    expect(c2View?.createdBy).toBe(org.ownerId);
    expect(c2View?.enabled).toBe(true);
    expect(c2View?.kind).toBe('service_account');
    expect(c2View?.rotationDueAt).toEqual(
      new Date(rotatedAt.getTime() + DEFAULT_ROTATION_INTERVAL_DAYS * 24 * 60 * 60 * 1000),
    );
    expect(byId.get(c1.id)?.enabled).toBe(false);
  }, 180_000);

  it('Rotating an unbound agent credential copies its actorKind and role and adds no userId', async () => {
    const org = await freshOrg();
    const c1 = await createMachineCredential(auth, {
      userId: org.adminId,
      organizationId: org.tenantId,
      name: 'Planner agent',
      actorKind: 'agent',
      metadata: { createdBy: org.adminId },
    });

    const rotated = await client().identity.credentials.rotate(
      { credential: c1.id },
      { context: contextOf(org, org.ownerId) },
    );

    const metadata = await metadataOfKey(rotated.id);
    expect(metadata).toMatchObject({
      actorKind: 'agent',
      role: 'member',
      createdBy: org.ownerId,
    });
    expect(metadata.userId).toBeUndefined();
    expect(typeof metadata.rotatedAt).toBe('string');
    expect(await revocationRows(org, c1.id)).toBe(1);
    await expect(
      exchangeMachineToken(auth, { clientId: c1.id, clientSecret: c1.secret }),
    ).rejects.toThrow();
    const token = await exchangeMachineToken(auth, {
      clientId: rotated.id,
      clientSecret: rotated.secret,
    });
    expect(token.accessToken.length).toBeGreaterThan(0);
  }, 180_000);
});

/**
 * Task 9.6b of openspec/changes/043-identity-lifecycle-and-org-admin
 * (rotation serialized per service account; design D8; Resolved decision Q40).
 *
 * Scenario (verbatim from the spec): "Concurrent rotation leaves exactly one active
 * credential": GIVEN a service account with one active credential, WHEN two admins rotate it at
 * the same time, THEN exactly one rotation succeeds, the other fails, and exactly one credential
 * is usable afterward. Also: a revoked credential MUST be rotatable only when its service
 * account has no active credential.
 *
 * ## Production behavior expected
 *
 * `rotateCredential` (`./credentials.js`) and so `identity.credentials.rotate` hold the
 * per-service-account advisory lock of 9.5c (the same key as `createCredential`) for the whole
 * rotation (per credential for an unbound one), and read the old credential's revocation state
 * under it: a revoked old credential is rotatable only when its service account has no active
 * credential; otherwise `CATALOG_VALIDATION_FAILED`, with nothing created.
 */
describe('identity.credentials.rotate is serialized (task 9.6b, Q40)', () => {
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

  interface SerialClient {
    identity: {
      credentials: {
        rotate(
          input: { credential: string },
          options: { context: Record<string, unknown> },
        ): Promise<{ id: string; secret: string }>;
      };
    };
  }

  function client(): SerialClient {
    return createRouterClient(
      createIdentityRouter({
        auth,
        authz: cerbos,
        authRepository,
        withUserLock: createWithUserLock(authPool),
        appPool,
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );
  }

  interface Org {
    readonly tenantId: string;
    readonly ownerId: string;
    readonly adminId: string;
  }

  async function freshOrg(): Promise<Org> {
    const id = randomUUID();
    const api = auth.api as OrganizationSurface;
    const owner = await createAdminUser(auth, {
      name: 'Serial Owner',
      email: `serial-owner-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    const org = await api.createOrganization({
      body: { name: 'Serial Org', slug: `serial-${id}`, userId: owner.userId },
    });
    const admin = await createAdminUser(auth, {
      name: 'Serial Admin',
      email: `serial-admin-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    await api.addMember({ body: { userId: admin.userId, organizationId: org.id, role: 'admin' } });
    return { tenantId: org.id, ownerId: owner.userId, adminId: admin.userId };
  }

  function contextOf(org: Org, actorId: string): Record<string, unknown> {
    return {
      tenantId: org.tenantId,
      actor: { type: 'user', id: actorId },
      principal: { roles: ['admin'] },
    };
  }

  async function seedServiceAccount(org: Org, identifier: string): Promise<void> {
    await createEntityService({ pool: appPool, authz: cerbos }).create(
      {
        tenantId: org.tenantId,
        actor: { type: 'system', id: 'credentials-test-seed' },
        principal: { roles: ['admin'] },
      },
      {
        blueprint: '_user',
        identifier,
        title: 'Service account',
        spec: { properties: { accountKind: 'service', status: 'Active' } },
      },
    );
  }

  async function revokedIds(org: Org): Promise<Set<string>> {
    const result = await withTenantTransaction(appPool, { tenantId: org.tenantId }, (c) =>
      c.query<{ credential_id: string }>(
        'select credential_id from machine_credential_revocation where tenant_id = $1',
        [org.tenantId],
      ),
    );
    return new Set(result.rows.map((r) => r.credential_id));
  }

  /** Ids of the tenant's keys that are enabled and not on the revocation list. */
  async function usableIds(org: Org): Promise<string[]> {
    const [keys, revoked] = await Promise.all([
      readAllApiKeys(authRepository, org.tenantId),
      revokedIds(org),
    ]);
    return keys.filter((k) => k.enabled && !revoked.has(k.id)).map((k) => k.id);
  }

  async function allKeyIds(org: Org): Promise<string[]> {
    const rows = await authPool.query<{ id: string }>(
      'select id from auth.apikey where reference_id = $1',
      [org.tenantId],
    );
    return rows.rows.map((r) => r.id);
  }

  it('Concurrent rotation leaves exactly one active credential: two admins rotate a service account credential at once, one succeeds, the other fails with CATALOG_VALIDATION_FAILED, one credential is usable', async () => {
    const org = await freshOrg();
    const identifier = `svc-rot-${randomUUID().slice(0, 8)}`;
    await seedServiceAccount(org, identifier);
    const c1 = await createMachineCredential(auth, {
      userId: org.adminId,
      organizationId: org.tenantId,
      name: 'Rot race',
      actorKind: 'integration',
      metadata: { userId: identifier, createdBy: org.adminId },
    });

    const results = await Promise.allSettled([
      client().identity.credentials.rotate(
        { credential: c1.id },
        { context: contextOf(org, org.ownerId) },
      ),
      client().identity.credentials.rotate(
        { credential: c1.id },
        { context: contextOf(org, org.adminId) },
      ),
    ]);

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<{ id: string; secret: string }> => r.status === 'fulfilled',
    );
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });

    const winner = fulfilled[0]?.value.id;
    expect(await usableIds(org)).toEqual([winner]);
    // The loser created nothing: c1 and the winner's key are the only keys.
    expect((await allKeyIds(org)).sort()).toEqual([c1.id, winner].sort());
    expect((await revokedIds(org)).has(c1.id)).toBe(true);
  }, 120_000);

  it('Concurrent rotation of an unbound credential (per credential lock) leaves exactly one usable credential', async () => {
    const org = await freshOrg();
    const c1 = await createMachineCredential(auth, {
      userId: org.adminId,
      organizationId: org.tenantId,
      name: 'Agent race',
      actorKind: 'agent',
      metadata: { createdBy: org.adminId },
    });

    const results = await Promise.allSettled([
      client().identity.credentials.rotate(
        { credential: c1.id },
        { context: contextOf(org, org.ownerId) },
      ),
      client().identity.credentials.rotate(
        { credential: c1.id },
        { context: contextOf(org, org.adminId) },
      ),
    ]);

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<{ id: string; secret: string }> => r.status === 'fulfilled',
    );
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });
    expect(await usableIds(org)).toEqual([fulfilled[0]?.value.id]);
  }, 120_000);

  it('Rotating a revoked credential is refused while the service account has another active credential: CATALOG_VALIDATION_FAILED, nothing is created, the active one stays the only usable', async () => {
    const org = await freshOrg();
    const identifier = `svc-rev-${randomUUID().slice(0, 8)}`;
    await seedServiceAccount(org, identifier);
    const c1 = await createMachineCredential(auth, {
      userId: org.adminId,
      organizationId: org.tenantId,
      name: 'Revoked one',
      actorKind: 'integration',
      metadata: { userId: identifier, createdBy: org.adminId },
    });
    await revokeMachineCredential(auth, {
      userId: org.adminId,
      id: c1.id,
      pool: appPool,
      tenantId: org.tenantId,
    });
    // A new active credential for the same service account (the revoked one does not block it).
    const c2 = await createMachineCredential(auth, {
      userId: org.adminId,
      organizationId: org.tenantId,
      name: 'Active one',
      actorKind: 'integration',
      metadata: { userId: identifier, createdBy: org.adminId },
    });

    await expect(
      client().identity.credentials.rotate(
        { credential: c1.id },
        { context: contextOf(org, org.ownerId) },
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });

    expect((await allKeyIds(org)).sort()).toEqual([c1.id, c2.id].sort());
    expect(await usableIds(org)).toEqual([c2.id]);
  }, 120_000);

  it('Rotating a revoked credential succeeds when its service account has no active credential, and leaves exactly one usable', async () => {
    const org = await freshOrg();
    const identifier = `svc-none-${randomUUID().slice(0, 8)}`;
    await seedServiceAccount(org, identifier);
    const c1 = await createMachineCredential(auth, {
      userId: org.adminId,
      organizationId: org.tenantId,
      name: 'Revoked only',
      actorKind: 'integration',
      metadata: { userId: identifier, createdBy: org.adminId },
    });
    await revokeMachineCredential(auth, {
      userId: org.adminId,
      id: c1.id,
      pool: appPool,
      tenantId: org.tenantId,
    });

    const rotated = await client().identity.credentials.rotate(
      { credential: c1.id },
      { context: contextOf(org, org.ownerId) },
    );

    expect(rotated.id).not.toBe(c1.id);
    expect(await usableIds(org)).toEqual([rotated.id]);
  }, 120_000);
});

describe('identity.credentials.rotate compensates a failed revoke (task 9.7)', () => {
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

  interface CompensationClient {
    identity: {
      credentials: {
        rotate(
          input: { credential: string },
          options: { context: Record<string, unknown> },
        ): Promise<{ id: string; secret: string }>;
      };
    };
  }

  function client(): CompensationClient {
    return createRouterClient(
      createIdentityRouter({
        auth,
        authz: cerbos,
        authRepository,
        withUserLock: createWithUserLock(authPool),
        appPool,
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );
  }

  async function freshOrg(): Promise<{ tenantId: string; adminId: string }> {
    const id = randomUUID();
    const api = auth.api as OrganizationSurface;
    const owner = await createAdminUser(auth, {
      name: 'Compensation Owner',
      email: `comp-owner-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    const org = await api.createOrganization({
      body: { name: 'Compensation Org', slug: `comp-${id}`, userId: owner.userId },
    });
    const admin = await createAdminUser(auth, {
      name: 'Compensation Admin',
      email: `comp-admin-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    await api.addMember({ body: { userId: admin.userId, organizationId: org.id, role: 'admin' } });
    return { tenantId: org.id, adminId: admin.userId };
  }

  async function revokedIds(tenantId: string): Promise<Set<string>> {
    const result = await withTenantTransaction(appPool, { tenantId }, (c) =>
      c.query<{ credential_id: string }>(
        'select credential_id from machine_credential_revocation where tenant_id = $1',
        [tenantId],
      ),
    );
    return new Set(result.rows.map((r) => r.credential_id));
  }

  /** Ids of the tenant's keys that are enabled and not on the revocation list. */
  async function usableIds(tenantId: string): Promise<string[]> {
    const [keys, revoked] = await Promise.all([
      readAllApiKeys(authRepository, tenantId),
      revokedIds(tenantId),
    ]);
    return keys.filter((k) => k.enabled && !revoked.has(k.id)).map((k) => k.id);
  }

  async function allKeyIds(tenantId: string): Promise<string[]> {
    const rows = await authPool.query<{ id: string }>(
      'select id from auth.apikey where reference_id = $1',
      [tenantId],
    );
    return rows.rows.map((r) => r.id);
  }

  it('A failed rotation leaves no second usable credential: when retiring the old credential fails, the new one is revoked and disabled, the operation fails, and at most the old one is usable', async () => {
    const org = await freshOrg();
    const c1 = await createMachineCredential(auth, {
      userId: org.adminId,
      organizationId: org.tenantId,
      name: 'Failing rotation',
      actorKind: 'integration',
      metadata: { createdBy: org.adminId },
    });
    revokeSeam.failFor.add(c1.id);

    try {
      await expect(
        client().identity.credentials.rotate(
          { credential: c1.id },
          {
            context: {
              tenantId: org.tenantId,
              actor: { type: 'user', id: org.adminId },
              principal: { roles: ['admin'] },
            },
          },
        ),
      ).rejects.toBeDefined();
    } finally {
      revokeSeam.failFor.delete(c1.id);
    }

    // A new key was created and then retired as compensation.
    const newIds = (await allKeyIds(org.tenantId)).filter((id) => id !== c1.id);
    expect(newIds).toHaveLength(1);
    const revoked = await revokedIds(org.tenantId);
    expect(revoked.has(newIds[0] ?? '')).toBe(true);
    const keys = await readAllApiKeys(authRepository, org.tenantId);
    expect(keys.find((k) => k.id === newIds[0])?.enabled).toBe(false);

    // No second usable credential: the only usable one is the old one, whose retirement failed.
    expect(await usableIds(org.tenantId)).toEqual([c1.id]);
  }, 120_000);
});
