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
import { createEntityService, createUserSync } from '@tayzu/catalog';
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
