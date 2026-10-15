/**
 * Task 9.2 of openspec/changes/archive/2026-10-14-043-identity-lifecycle-and-org-admin
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
// Load-bearing import order (design D1): the telemetry harness registers
// before anything that loads `@tayzu/auth` creates its logger (task 9.8).
import { registration, type TelemetryTestHarness } from '../__fixtures__/link-telemetry.js';
import { randomUUID } from 'node:crypto';

import { createRouterClient } from '@orpc/server';
import {
  authSchema,
  createAuth,
  createContextResolver,
  exchangeMachineToken,
  type AuthInstance,
  createServiceAccountLookup,
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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
const revokeSeam = vi.hoisted(() => ({
  failFor: new Set<string>(),
  /** Task 9.8: every revoke inside these tenants fails (the new key's id is not known upfront). */
  failTenants: new Set<string>(),
}));

vi.mock('@tayzu/auth/machine-credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof MachineCredentialsModule>();
  return {
    ...actual,
    revokeMachineCredential: async (
      ...args: Parameters<typeof actual.revokeMachineCredential>
    ): Promise<void> => {
      if (revokeSeam.failFor.has(args[1].id) || revokeSeam.failTenants.has(args[1].tenantId)) {
        throw new Error('injected revoke failure');
      }
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
      { query: {} },
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
      clientFor().identity.credentials.list(
        { query: {} },
        { context: context(tenant, ['member']) },
      ),
    ).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });
  }, 120_000);

  it('The viewer shows every credential a tenant can hold: 200 non-revoked and 30 revoked list all 200 non-revoked ones, truncated', async () => {
    const tenant = await freshTenant();
    const active = await inBatches(200, 20, (i) => seed(tenant, `active-${String(i)}`));
    const revoked = await inBatches(30, 15, (i) => seed(tenant, `revoked-${String(i)}`));
    await inBatches(revoked.length, 10, (i) => revoke(tenant, revoked[i]?.id ?? ''));

    const output = (await clientFor().identity.credentials.list(
      { query: {} },
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
      { query: {} },
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
      { query: {} },
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
      { query: {} },
      { context: context(tenant) },
    )) as ListOutput;

    expect(output.credentials.map((c) => c.id).sort()).toEqual(active.map((a) => a.id).sort());
    expect(output.truncated).toBe(true);
  }, 120_000);

  it("Each entry carries the key's opaque apikey id, the one that rotate and revoke take as {credential}", async () => {
    const tenant = await freshTenant();
    const created = await seed(tenant, 'Addressable');

    const output = (await clientFor().identity.credentials.list(
      { query: {} },
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
      { query: {} },
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
      { query: {} },
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
 * Task 9.5 of openspec/changes/archive/2026-10-14-043-identity-lifecycle-and-org-admin
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
          input: { body: { name: string; kind: string } },
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
      { body: { name: 'Billing sync', kind: 'integration' } },
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
      { body: { name: 'Planner agent', kind: 'agent' } },
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
      { body: { name: 'Tuned', kind: 'integration' } },
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
      { body: { name: 'Before change', kind: 'integration' } },
      { context: contextOf(org, org.adminId) },
    );
    const second = await creator(after).identity.credentials.create(
      { body: { name: 'After change', kind: 'integration' } },
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
        { body: { name: 'a'.repeat(33), kind: 'integration' } },
        { context: contextOf(org, org.adminId) },
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });
    expect(await keyRows(org)).toHaveLength(0);

    await client.identity.credentials.create(
      { body: { name: 'a'.repeat(32), kind: 'integration' } },
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
          { body: { name, kind: 'integration' } },
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
        { body: { name: 'Denied', kind: 'integration' } },
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
 * Task 9.5b of openspec/changes/archive/2026-10-14-043-identity-lifecycle-and-org-admin
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
          input: { body: { name: string; kind: string; userId?: string } },
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
          { body: { name: 'Bound', kind: 'integration', userId } },
          { context: contextOf(org) },
        ),
      ).rejects.toMatchObject({ code: 'CATALOG_NOT_FOUND' });
    }
    expect(await keyIds(org)).toHaveLength(0);
    expect(await keyIds(other)).toHaveLength(0);
  }, 120_000);

  it('A credential bound to a human or to a look-alike is refused with the same answer as an unknown id (task 10.7b)', async () => {
    const org = await freshOrg();
    const suffix = randomUUID().slice(0, 8);
    const humanLookalike = `svc-human-${suffix}`;
    const noPrefix = `ci-bot-${suffix}`;
    const alice = `alice-${suffix}@example.com`;
    await seedUser(org, humanLookalike, { accountKind: 'standard', status: 'Active' });
    // A service `_user` without the `svc-` identifier shape is not a service account either.
    await seedUser(org, noPrefix, { accountKind: 'service', status: 'Active' });
    await seedUser(org, alice, { accountKind: 'standard', status: 'Active' });

    const attempt = async (userId: string): Promise<Record<string, unknown>> => {
      try {
        await client().identity.credentials.create(
          { body: { name: 'Bound', kind: 'integration', userId } },
          { context: contextOf(org) },
        );
      } catch (error) {
        return {
          code: (error as { code?: unknown }).code,
          status: (error as { status?: unknown }).status,
          message: (error as Error).message,
          data: (error as { data?: unknown }).data,
        };
      }
      return { code: 'NO_ERROR' };
    };

    const unknown = await attempt(`svc-unknown-${suffix}`);
    expect(unknown['code']).toBe('CATALOG_NOT_FOUND');
    for (const userId of [alice, org.adminId, humanLookalike, noPrefix]) {
      expect(await attempt(userId)).toEqual(unknown);
    }
    expect(await keyIds(org)).toHaveLength(0);
  }, 120_000);

  it('A credential bound to a service account of the tenant is created with its svc- identifier in the metadata', async () => {
    const org = await freshOrg();
    const identifier = `svc-ok-${randomUUID().slice(0, 8)}`;
    await seedServiceAccount(org, identifier);

    const created = await client().identity.credentials.create(
      { body: { name: 'Bound', kind: 'integration', userId: identifier } },
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

    const first = await client().identity.credentials.create(
      { body: input },
      { context: contextOf(org) },
    );

    await expect(
      client().identity.credentials.create({ body: input }, { context: contextOf(org) }),
    ).rejects.toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });
    expect(await keyIds(org)).toEqual([first.id]);

    await revokeMachineCredential(auth, {
      userId: org.adminId,
      id: first.id,
      pool: appPool,
      tenantId: org.tenantId,
    });

    const second = await client().identity.credentials.create(
      { body: input },
      {
        context: contextOf(org),
      },
    );
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
      client().identity.credentials.create({ body: input }, { context: contextOf(org) }),
      client().identity.credentials.create({ body: input }, { context: contextOf(org) }),
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
 * Task 9.5d of openspec/changes/archive/2026-10-14-043-identity-lifecycle-and-org-admin
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
          input: { body: { name: string; kind: string } },
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
      client().identity.credentials.create(
        { body: input('One too many') },
        { context: contextOf(org) },
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });
    await expect(
      client().identity.credentials.create(
        { body: input('a'.repeat(33)) },
        { context: contextOf(org) },
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });
    expect(await keyCount(org)).toBe(200);

    // A revoked credential does not count: revoking one frees exactly one place.
    await revokeMachineCredential(auth, {
      userId: org.adminId,
      id: ids[0] ?? '',
      pool: appPool,
      tenantId: org.tenantId,
    });
    const created = await client().identity.credentials.create(
      { body: input('After revoke') },
      {
        context: contextOf(org),
      },
    );
    expect(created.secret).toMatch(/^tayzu_mc_/);
    expect(await keyCount(org)).toBe(201);
    await expect(
      client().identity.credentials.create(
        { body: input('Over again') },
        { context: contextOf(org) },
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });
    expect(await keyCount(org)).toBe(201);
  }, 300_000);

  it('The cap is per tenant: a full tenant does not block another one', async () => {
    const full = await freshOrg();
    await seedMany(full, 200);
    const other = await freshOrg();

    await expect(
      client().identity.credentials.create(
        { body: input('Blocked') },
        { context: contextOf(full) },
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });
    const created = await client().identity.credentials.create(
      { body: input('Free') },
      {
        context: contextOf(other),
      },
    );
    expect(created.id).toEqual(expect.any(String));
  }, 300_000);

  it('Concurrent creates at 199 yield one success: the other is refused with CATALOG_VALIDATION_FAILED and the tenant ends at 200', async () => {
    const org = await freshOrg();
    await seedMany(org, 199);

    const results = await Promise.allSettled([
      client().identity.credentials.create(
        { body: input('Racer one') },
        { context: contextOf(org) },
      ),
      client().identity.credentials.create(
        { body: input('Racer two') },
        { context: contextOf(org) },
      ),
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
 * Task 9.6 of openspec/changes/archive/2026-10-14-043-identity-lifecycle-and-org-admin
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
          input: { query: Record<string, never> },
          options: { context: Record<string, unknown> },
        ): Promise<ListOutput>;
        rotate(
          input: { params: { credential: string } },
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
    const issued = await exchangeMachineToken(
      auth,
      {
        clientId: c1.id,
        clientSecret: c1.secret,
      },
      { serviceAccountLookup: createServiceAccountLookup(appPool) },
    );
    // The token is usable before the rotation (this also warms the revocation cache).
    await expect(
      resolveContext(new Headers({ authorization: `Bearer ${issued.accessToken}` })),
    ).resolves.toMatchObject({ tenantId: org.tenantId, actor: { type: 'integration', id: c1.id } });

    const listed = await client().identity.credentials.list(
      { query: {} },
      { context: contextOf(org, org.ownerId) },
    );
    const c1Id = listed.credentials.find((c) => c.id === c1.id)?.id;
    expect(c1Id).toBe(c1.id);

    const before = Date.now();
    const rotated = await client().identity.credentials.rotate(
      { params: { credential: c1Id ?? '' } },
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
      exchangeMachineToken(
        auth,
        { clientId: c1.id, clientSecret: c1.secret },
        { serviceAccountLookup: createServiceAccountLookup(appPool) },
      ),
    ).rejects.toThrow();

    // AND c2 is the usable credential.
    const fresh = await exchangeMachineToken(
      auth,
      {
        clientId: rotated.id,
        clientSecret: rotated.secret,
      },
      { serviceAccountLookup: createServiceAccountLookup(appPool) },
    );
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
      { query: {} },
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
      { params: { credential: c1.id } },
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
      exchangeMachineToken(
        auth,
        { clientId: c1.id, clientSecret: c1.secret },
        { serviceAccountLookup: createServiceAccountLookup(appPool) },
      ),
    ).rejects.toThrow();
    const token = await exchangeMachineToken(
      auth,
      {
        clientId: rotated.id,
        clientSecret: rotated.secret,
      },
      { serviceAccountLookup: createServiceAccountLookup(appPool) },
    );
    expect(token.accessToken.length).toBeGreaterThan(0);
  }, 180_000);
});

/**
 * Task 9.6b of openspec/changes/archive/2026-10-14-043-identity-lifecycle-and-org-admin
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
          input: { params: { credential: string } },
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
        { params: { credential: c1.id } },
        { context: contextOf(org, org.ownerId) },
      ),
      client().identity.credentials.rotate(
        { params: { credential: c1.id } },
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
        { params: { credential: c1.id } },
        { context: contextOf(org, org.ownerId) },
      ),
      client().identity.credentials.rotate(
        { params: { credential: c1.id } },
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
        { params: { credential: c1.id } },
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
      { params: { credential: c1.id } },
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
          input: { params: { credential: string } },
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
          { params: { credential: c1.id } },
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

/**
 * Task 9.8 (design D8, "Rotate"; log event table): "A rotation that cannot compensate is
 * signalled". GIVEN retiring the old credential and revoking the new one both fail, WHEN an
 * admin rotates, THEN `catalog.security.credential_rotation_incomplete` is logged with both
 * opaque identifiers (`tayzu.identity.credential.old_id` / `.new_id`, plus `tayzu.tenant.id`
 * and `tayzu.actor.id`), and never a secret.
 *
 * Production symbols expected: the rotate procedure emits that WARN log event with those
 * attributes when the compensation revoke throws.
 */
describe('identity.credentials.rotate signals an incomplete compensation (task 9.8)', () => {
  const EVENT = 'catalog.security.credential_rotation_incomplete';
  let appPool: Pool;
  let authPool: Pool;
  let auth: AuthInstance;
  let cerbos: CerbosClient;
  let authRepository: AuthRepository;
  let harness: TelemetryTestHarness;

  beforeAll(async () => {
    if ('error' in registration) {
      throw new Error(`createTelemetryTestHarness() failed: ${String(registration.error)}`, {
        cause: registration.error,
      });
    }
    harness = registration.harness;
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

  interface RotateClient {
    identity: {
      credentials: {
        rotate(
          input: { params: { credential: string } },
          options: { context: Record<string, unknown> },
        ): Promise<{ id: string; secret: string }>;
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

  async function freshOrg(): Promise<{ tenantId: string; adminId: string }> {
    const id = randomUUID();
    const api = auth.api as OrganizationSurface;
    const owner = await createAdminUser(auth, {
      name: 'Incomplete Owner',
      email: `inc-owner-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    const org = await api.createOrganization({
      body: { name: 'Incomplete Org', slug: `inc-${id}`, userId: owner.userId },
    });
    const admin = await createAdminUser(auth, {
      name: 'Incomplete Admin',
      email: `inc-admin-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    await api.addMember({ body: { userId: admin.userId, organizationId: org.id, role: 'admin' } });
    return { tenantId: org.id, adminId: admin.userId };
  }

  async function incompleteEvents(tenantId: string) {
    await harness.forceFlush();
    return [...harness.logExporter.getFinishedLogRecords()].filter(
      (record) => record.eventName === EVENT && record.attributes['tayzu.tenant.id'] === tenantId,
    );
  }

  it('A rotation that cannot compensate is signalled: when retiring the old credential and revoking the new one both fail, the operation fails and catalog.security.credential_rotation_incomplete is logged with both opaque identifiers', async () => {
    const org = await freshOrg();
    const c1 = await createMachineCredential(auth, {
      userId: org.adminId,
      organizationId: org.tenantId,
      name: 'Uncompensated rotation',
      actorKind: 'integration',
      metadata: { createdBy: org.adminId },
    });
    expect(await incompleteEvents(org.tenantId)).toHaveLength(0);
    revokeSeam.failTenants.add(org.tenantId);

    try {
      await expect(
        client().identity.credentials.rotate(
          { params: { credential: c1.id } },
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
      revokeSeam.failTenants.delete(org.tenantId);
    }

    const rows = await authPool.query<{ id: string }>(
      'select id from auth.apikey where reference_id = $1',
      [org.tenantId],
    );
    const newIds = rows.rows.map((r) => r.id).filter((id) => id !== c1.id);
    expect(newIds).toHaveLength(1);
    const newId = newIds[0] ?? '';

    const events = await incompleteEvents(org.tenantId);
    expect(events).toHaveLength(1);
    expect(events[0]?.attributes).toMatchObject({
      'tayzu.tenant.id': org.tenantId,
      'tayzu.actor.id': org.adminId,
      'tayzu.identity.credential.old_id': c1.id,
      'tayzu.identity.credential.new_id': newId,
    });
    expect(events[0]?.severityText).toBe('WARN');
    // Opaque identifiers only: no secret or key material in the record.
    expect(JSON.stringify(events[0]?.attributes)).not.toContain(c1.secret);
    expect(JSON.stringify(events[0]?.body ?? '')).not.toContain(c1.secret);
  }, 120_000);
});

/**
 * Task 9.9 of openspec/changes/archive/2026-10-14-043-identity-lifecycle-and-org-admin
 * (`identity.credentials.revoke`; design D8; Resolved decisions Q40, Q90).
 *
 * Scenario (verbatim from the spec): "Revoking a credential is permanent": GIVEN an enabled
 * credential `c1`, WHEN an admin revokes it, THEN `c1` can never be restored, and only a new
 * rotation or a new credential creation can restore access. Also (task text): revoking an
 * already revoked credential is a no-op, and a Better Auth `admin` member who is not the owner
 * and an `owner` each revoke a key through the operation with the headerless call of 9.1b.
 *
 * ## Production symbols expected
 *
 * - `createIdentityRouter` (`../identity-router.js`): `identity.credentials.revoke`, a
 *   `defineIdentityOperation` on `RESOURCE_KINDS.credential` / `revoke`, input
 *   `{ credential: string }` (the `id` that `identity.credentials.list` returns, resolved inside
 *   the tenant like `rotate`), resolving on success (its output is not asserted). It calls the
 *   headerless `revokeMachineCredential` with the acting user as `userId`, and the second call
 *   for an already revoked credential resolves without error and without a second revocation row.
 */
describe('identity.credentials.revoke (task 9.9)', () => {
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

  interface RevokeClient {
    identity: {
      credentials: {
        list(
          input: { query: Record<string, never> },
          options: { context: Record<string, unknown> },
        ): Promise<ListOutput>;
        revoke(
          input: { params: { credential: string } },
          options: { context: Record<string, unknown> },
        ): Promise<unknown>;
        rotate(
          input: { params: { credential: string } },
          options: { context: Record<string, unknown> },
        ): Promise<{ id: string; secret: string }>;
      };
    };
  }

  function client(): RevokeClient {
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
      name: 'Revoke Owner',
      email: `revoke-owner-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    const org = await api.createOrganization({
      body: { name: 'Revoke Org', slug: `revoke-${id}`, userId: owner.userId },
    });
    const admin = await createAdminUser(auth, {
      name: 'Revoke Admin',
      email: `revoke-admin-${id}@example.test`,
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

  function seed(org: Org, name: string, metadata: Record<string, string> = {}) {
    return createMachineCredential(auth, {
      userId: org.adminId,
      organizationId: org.tenantId,
      name,
      actorKind: 'integration',
      metadata: { createdBy: org.adminId, ...metadata },
    });
  }

  async function revocationCount(org: Org, id: string): Promise<number> {
    const result = await withTenantTransaction(appPool, { tenantId: org.tenantId }, (c) =>
      c.query<{ n: string }>(
        `select count(*)::text as n from machine_credential_revocation
          where credential_id = $1 and tenant_id = $2`,
        [id, org.tenantId],
      ),
    );
    return Number(result.rows[0]?.n);
  }

  async function keyEnabled(id: string): Promise<boolean | undefined> {
    const row = await authPool.query<{ enabled: boolean }>(
      'select enabled from auth.apikey where id = $1',
      [id],
    );
    return row.rows[0]?.enabled;
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

  it('Revoking a credential is permanent: the credential is revoked and disabled, a new exchange is rejected, and a second revoke is a no-op that restores nothing', async () => {
    const org = await freshOrg();
    const c1 = await seed(org, 'To revoke');
    const untouched = await seed(org, 'Untouched');
    const issued = await exchangeMachineToken(
      auth,
      { clientId: c1.id, clientSecret: c1.secret },
      { serviceAccountLookup: createServiceAccountLookup(appPool) },
    );
    expect(issued.accessToken.length).toBeGreaterThan(0);
    expect(await revocationCount(org, c1.id)).toBe(0);

    await client().identity.credentials.revoke(
      { params: { credential: c1.id } },
      { context: contextOf(org, org.adminId) },
    );

    expect(await revocationCount(org, c1.id)).toBe(1);
    expect(await keyEnabled(c1.id)).toBe(false);
    await expect(
      exchangeMachineToken(
        auth,
        { clientId: c1.id, clientSecret: c1.secret },
        { serviceAccountLookup: createServiceAccountLookup(appPool) },
      ),
    ).rejects.toThrow();
    // Only the revoked credential is affected.
    expect(await revocationCount(org, untouched.id)).toBe(0);
    expect(await keyEnabled(untouched.id)).toBe(true);

    // Revoking it again is a no-op: it resolves, adds no row and restores nothing.
    await expect(
      client().identity.credentials.revoke(
        { params: { credential: c1.id } },
        { context: contextOf(org, org.ownerId) },
      ),
    ).resolves.not.toThrow();
    expect(await revocationCount(org, c1.id)).toBe(1);
    expect(await keyEnabled(c1.id)).toBe(false);
    await expect(
      exchangeMachineToken(
        auth,
        { clientId: c1.id, clientSecret: c1.secret },
        { serviceAccountLookup: createServiceAccountLookup(appPool) },
      ),
    ).rejects.toThrow();

    const listed = await client().identity.credentials.list(
      { query: {} },
      { context: contextOf(org, org.adminId) },
    );
    const byId = new Map(listed.credentials.map((c) => [c.id, c]));
    expect(byId.get(c1.id)?.enabled).toBe(false);
    expect(byId.get(untouched.id)?.enabled).toBe(true);
  }, 120_000);

  it('Revoking a credential is permanent: only a rotation or a new creation restores access, and c1 stays revoked', async () => {
    const org = await freshOrg();
    const identifier = `svc-perm-${randomUUID().slice(0, 8)}`;
    await seedServiceAccount(org, identifier);
    const c1 = await seed(org, 'Bound', { userId: identifier });
    await client().identity.credentials.revoke(
      { params: { credential: c1.id } },
      { context: contextOf(org, org.adminId) },
    );

    // A rotation of the revoked credential (the account has no active one) yields a new key.
    const rotated = await client().identity.credentials.rotate(
      { params: { credential: c1.id } },
      { context: contextOf(org, org.adminId) },
    );

    expect(rotated.id).not.toBe(c1.id);
    const fresh = await exchangeMachineToken(
      auth,
      {
        clientId: rotated.id,
        clientSecret: rotated.secret,
      },
      { serviceAccountLookup: createServiceAccountLookup(appPool) },
    );
    expect(fresh.accessToken.length).toBeGreaterThan(0);
    // c1 itself is still revoked and unusable.
    expect(await revocationCount(org, c1.id)).toBe(1);
    expect(await keyEnabled(c1.id)).toBe(false);
    await expect(
      exchangeMachineToken(
        auth,
        { clientId: c1.id, clientSecret: c1.secret },
        { serviceAccountLookup: createServiceAccountLookup(appPool) },
      ),
    ).rejects.toThrow();
  }, 120_000);

  it('A Better Auth admin member who is not the owner revokes a key through the operation, headerless', async () => {
    const org = await freshOrg();
    const c1 = await seed(org, 'Admin revokes');

    await client().identity.credentials.revoke(
      { params: { credential: c1.id } },
      { context: contextOf(org, org.adminId) },
    );

    expect(await revocationCount(org, c1.id)).toBe(1);
    expect(await keyEnabled(c1.id)).toBe(false);
  }, 120_000);

  it('An owner revokes a key through the operation, headerless', async () => {
    const org = await freshOrg();
    const c1 = await seed(org, 'Owner revokes');

    await client().identity.credentials.revoke(
      { params: { credential: c1.id } },
      { context: contextOf(org, org.ownerId) },
    );

    expect(await revocationCount(org, c1.id)).toBe(1);
    expect(await keyEnabled(c1.id)).toBe(false);
  }, 120_000);
});

/**
 * Task 9.10 (design D8 and the log event table): rotation and revocation log events carry only
 * opaque credential identifiers, never a secret, even under a forced serialization of the full
 * credential object.
 *
 * Verify clause: a marker-leak check: a credential secret string never appears in the
 * `catalog.audit.credential_rotated` or `catalog.security.credential_revoked` record.
 *
 * ## Production symbols expected
 *
 * - `identity.credentials.rotate` (`rotateCredential` in `./credentials.js`) emits, through
 *   `emitIdentityEvent`, `catalog.audit.credential_rotated` (INFO) with exactly the attributes
 *   `tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.identity.credential.old_id` and
 *   `tayzu.identity.credential.new_id`.
 * - `identity.credentials.revoke` (`revokeCredential`) emits `catalog.security.credential_revoked`
 *   (WARN) with exactly `tayzu.tenant.id`, `tayzu.actor.id` and `tayzu.identity.credential.id`.
 *
 * ## Why this fails right now
 *
 * Neither event is emitted yet, so the records are missing.
 */
describe('credential rotation and revocation events never carry a secret (task 9.10)', () => {
  const ROTATED = 'catalog.audit.credential_rotated';
  const REVOKED = 'catalog.security.credential_revoked';
  let appPool: Pool;
  let authPool: Pool;
  let auth: AuthInstance;
  let cerbos: CerbosClient;
  let authRepository: AuthRepository;
  let harness: TelemetryTestHarness;

  beforeAll(async () => {
    if ('error' in registration) {
      throw new Error(`createTelemetryTestHarness() failed: ${String(registration.error)}`, {
        cause: registration.error,
      });
    }
    harness = registration.harness;
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

  interface EventClient {
    identity: {
      credentials: {
        rotate(
          input: { params: { credential: string } },
          options: { context: Record<string, unknown> },
        ): Promise<{ id: string; secret: string }>;
        revoke(
          input: { params: { credential: string } },
          options: { context: Record<string, unknown> },
        ): Promise<unknown>;
      };
    };
  }

  function client(): EventClient {
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
      name: 'Leak Owner',
      email: `leak-owner-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    const org = await api.createOrganization({
      body: { name: 'Leak Org', slug: `leak-${id}`, userId: owner.userId },
    });
    const admin = await createAdminUser(auth, {
      name: 'Leak Admin',
      email: `leak-admin-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    await api.addMember({ body: { userId: admin.userId, organizationId: org.id, role: 'admin' } });
    return { tenantId: org.id, adminId: admin.userId };
  }

  async function eventsOf(name: string, tenantId: string) {
    await harness.forceFlush();
    return [...harness.logExporter.getFinishedLogRecords()].filter(
      (record) => record.eventName === name && record.attributes['tayzu.tenant.id'] === tenantId,
    );
  }

  function contextOf(org: { tenantId: string; adminId: string }): Record<string, unknown> {
    return {
      tenantId: org.tenantId,
      actor: { type: 'user', id: org.adminId },
      principal: { roles: ['admin'] },
    };
  }

  it('A rotation record carries only opaque identifiers: neither the old nor the new secret appears in catalog.audit.credential_rotated', async () => {
    const org = await freshOrg();
    const c1 = await createMachineCredential(auth, {
      userId: org.adminId,
      organizationId: org.tenantId,
      name: 'Leak rotate',
      actorKind: 'integration',
      metadata: { createdBy: org.adminId },
    });

    const rotated = await client().identity.credentials.rotate(
      { params: { credential: c1.id } },
      { context: contextOf(org) },
    );

    const events = await eventsOf(ROTATED, org.tenantId);
    expect(events).toHaveLength(1);
    const record = events[0];
    expect(record?.severityText).toBe('INFO');
    expect(record?.attributes).toEqual({
      'tayzu.tenant.id': org.tenantId,
      'tayzu.actor.id': org.adminId,
      'tayzu.identity.credential.old_id': c1.id,
      'tayzu.identity.credential.new_id': rotated.id,
    });
    // Forced serialization of the whole record: no secret anywhere in it.
    const serialized = JSON.stringify(record, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(c1.secret.length).toBeGreaterThan(0);
    expect(rotated.secret.length).toBeGreaterThan(0);
    expect(serialized).not.toContain(c1.secret);
    expect(serialized).not.toContain(rotated.secret);
  }, 120_000);

  it('A revocation record carries only opaque identifiers: the secret never appears in catalog.security.credential_revoked', async () => {
    const org = await freshOrg();
    const c1 = await createMachineCredential(auth, {
      userId: org.adminId,
      organizationId: org.tenantId,
      name: 'Leak revoke',
      actorKind: 'integration',
      metadata: { createdBy: org.adminId },
    });

    await client().identity.credentials.revoke(
      { params: { credential: c1.id } },
      { context: contextOf(org) },
    );

    const events = (await eventsOf(REVOKED, org.tenantId)).filter(
      (record) => record.attributes['tayzu.identity.credential.id'] === c1.id,
    );
    expect(events).toHaveLength(1);
    const record = events[0];
    expect(record?.severityText).toBe('WARN');
    expect(record?.attributes).toEqual({
      'tayzu.tenant.id': org.tenantId,
      'tayzu.actor.id': org.adminId,
      'tayzu.identity.credential.id': c1.id,
    });
    const serialized = JSON.stringify(record, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(c1.secret.length).toBeGreaterThan(0);
    expect(serialized).not.toContain(c1.secret);
  }, 120_000);
});

/**
 * Task 9.11 (spec "Targets belong to the caller's tenant", scenario "Another tenant's credential
 * cannot be listed, rotated or revoked"): a foreign or unknown credential id answers the same
 * `CATALOG_NOT_FOUND`, and the key is read through the adapter-level lookup filtered by
 * `referenceId`.
 *
 * ## Production symbols expected
 *
 * - `identity.credentials.revoke` and `identity.credentials.rotate` (`createIdentityRouter` in
 *   `../identity-router.js`) fail with an error whose `code` is `CATALOG_NOT_FOUND` for another
 *   tenant's credential and for an unknown id, with identical status, message and data. For revoke
 *   the `AuthContextError` of `revokeMachineCredential` is mapped (`./credentials.js`).
 * - `AuthRepository.apiKeyById` / `listApiKeys` (`./auth-repository.js`) filter by `referenceId`.
 */
describe('a foreign or unknown credential id answers CATALOG_NOT_FOUND (task 9.11)', () => {
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

  interface TargetClient {
    identity: {
      credentials: {
        revoke(
          input: { params: { credential: string } },
          options: { context: Record<string, unknown> },
        ): Promise<unknown>;
        rotate(
          input: { params: { credential: string } },
          options: { context: Record<string, unknown> },
        ): Promise<{ id: string; secret: string }>;
      };
    };
  }

  function client(): TargetClient {
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
      name: 'Target Owner',
      email: `target-owner-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    const org = await api.createOrganization({
      body: { name: 'Target Org', slug: `target-${id}`, userId: owner.userId },
    });
    const admin = await createAdminUser(auth, {
      name: 'Target Admin',
      email: `target-admin-${id}@example.test`,
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

  function seed(org: Org, name: string) {
    return createMachineCredential(auth, {
      userId: org.adminId,
      organizationId: org.tenantId,
      name,
      actorKind: 'integration',
      metadata: { createdBy: org.adminId },
    });
  }

  async function failureOf(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
    try {
      await run();
    } catch (error) {
      return {
        code: (error as { code?: unknown }).code,
        status: (error as { status?: unknown }).status,
        message: (error as Error).message,
        data: (error as { data?: unknown }).data,
      };
    }
    return { code: 'NO_ERROR' };
  }

  async function revocationCount(org: Org, id: string): Promise<number> {
    const result = await withTenantTransaction(appPool, { tenantId: org.tenantId }, (c) =>
      c.query<{ n: string }>(
        `select count(*)::text as n from machine_credential_revocation
          where credential_id = $1 and tenant_id = $2`,
        [id, org.tenantId],
      ),
    );
    return Number(result.rows[0]?.n);
  }

  async function keyCount(org: Org): Promise<number> {
    return (await readAllApiKeys(authRepository, org.tenantId)).length;
  }

  it("Another tenant's credential cannot be rotated or revoked: both answer CATALOG_NOT_FOUND, identical to an unknown id, and tenant t2's key is untouched", async () => {
    const t1 = await freshOrg();
    const t2 = await freshOrg();
    const foreign = await seed(t2, 'Foreign');
    const unknownId = randomUUID();
    const t1Keys = await keyCount(t1);
    const t2Keys = await keyCount(t2);

    const revokeForeign = await failureOf(() =>
      client().identity.credentials.revoke(
        { params: { credential: foreign.id } },
        { context: contextOf(t1) },
      ),
    );
    const revokeUnknown = await failureOf(() =>
      client().identity.credentials.revoke(
        { params: { credential: unknownId } },
        { context: contextOf(t1) },
      ),
    );
    const rotateForeign = await failureOf(() =>
      client().identity.credentials.rotate(
        { params: { credential: foreign.id } },
        { context: contextOf(t1) },
      ),
    );
    const rotateUnknown = await failureOf(() =>
      client().identity.credentials.rotate(
        { params: { credential: unknownId } },
        { context: contextOf(t1) },
      ),
    );

    expect(revokeForeign['code']).toBe('CATALOG_NOT_FOUND');
    expect(revokeUnknown['code']).toBe('CATALOG_NOT_FOUND');
    expect(rotateForeign['code']).toBe('CATALOG_NOT_FOUND');
    expect(rotateUnknown['code']).toBe('CATALOG_NOT_FOUND');
    // The same answer for a foreign and an unknown id, and for both operations.
    expect(revokeForeign).toEqual(revokeUnknown);
    expect(rotateForeign).toEqual(rotateUnknown);
    expect(revokeForeign).toEqual(rotateForeign);

    // Nothing changed in either tenant.
    expect(await revocationCount(t2, foreign.id)).toBe(0);
    expect(await revocationCount(t1, foreign.id)).toBe(0);
    expect(await keyCount(t1)).toBe(t1Keys);
    expect(await keyCount(t2)).toBe(t2Keys);
    const stored = await authPool.query<{ enabled: boolean }>(
      'select enabled from auth.apikey where id = $1',
      [foreign.id],
    );
    expect(stored.rows[0]?.enabled).toBe(true);
    const exchange = await exchangeMachineToken(
      auth,
      {
        clientId: foreign.id,
        clientSecret: foreign.secret,
      },
      { serviceAccountLookup: createServiceAccountLookup(appPool) },
    );
    expect(exchange.accessToken.length).toBeGreaterThan(0);
  }, 120_000);

  it("The key lookup is filtered by referenceId: another tenant's key is not found by id, and is absent from the tenant's paged read", async () => {
    const t1 = await freshOrg();
    const t2 = await freshOrg();
    const own = await seed(t1, 'Own');
    const foreign = await seed(t2, 'Foreign');

    expect((await authRepository.apiKeyById(t1.tenantId, own.id))?.referenceId).toBe(t1.tenantId);
    expect(await authRepository.apiKeyById(t1.tenantId, foreign.id)).toBeUndefined();
    expect(await authRepository.apiKeyById(t2.tenantId, own.id)).toBeUndefined();
    const ids = (await readAllApiKeys(authRepository, t1.tenantId)).map((k) => k.id);
    expect(ids).toContain(own.id);
    expect(ids).not.toContain(foreign.id);
  }, 120_000);

  /**
   * Task 16.12f (design D8, task 9.11; Resolved decision Q149): the lookup also filters by the
   * machine-credential `configId`, so a key of another configuration in the SAME tenant is not
   * found by rotate or revoke.
   *
   * Production symbols expected: none new; `authRepository.apiKeyById` (`./auth-repository.js`)
   * restricts to `config_id = 'machine-credential'`, however the implementer shapes its signature.
   */
  it('A key of another configuration in the same tenant answers CATALOG_NOT_FOUND on rotate and on revoke, identical to an unknown id, and stays untouched (task 16.12f)', async () => {
    const t1 = await freshOrg();
    const other = await seed(t1, 'Other configuration');
    const own = await seed(t1, 'Own machine credential');
    await authPool.query("update auth.apikey set config_id = 'other-config' where id = $1", [
      other.id,
    ]);
    const unknownId = randomUUID();

    const revokeOther = await failureOf(() =>
      client().identity.credentials.revoke(
        { params: { credential: other.id } },
        { context: contextOf(t1) },
      ),
    );
    const revokeUnknown = await failureOf(() =>
      client().identity.credentials.revoke(
        { params: { credential: unknownId } },
        { context: contextOf(t1) },
      ),
    );
    const rotateOther = await failureOf(() =>
      client().identity.credentials.rotate(
        { params: { credential: other.id } },
        { context: contextOf(t1) },
      ),
    );
    const rotateUnknown = await failureOf(() =>
      client().identity.credentials.rotate(
        { params: { credential: unknownId } },
        { context: contextOf(t1) },
      ),
    );

    expect(revokeOther['code']).toBe('CATALOG_NOT_FOUND');
    expect(rotateOther['code']).toBe('CATALOG_NOT_FOUND');
    expect(revokeOther).toEqual(revokeUnknown);
    expect(rotateOther).toEqual(rotateUnknown);

    // Nothing changed: no revocation row, the key is still enabled and in its configuration.
    expect(await revocationCount(t1, other.id)).toBe(0);
    const stored = await authPool.query<{ enabled: boolean; config_id: string }>(
      'select enabled, config_id from auth.apikey where id = $1',
      [other.id],
    );
    expect(stored.rows[0]?.enabled).toBe(true);
    expect(stored.rows[0]?.config_id).toBe('other-config');
    const count = await authPool.query<{ n: string }>(
      'select count(*)::text as n from auth.apikey where reference_id = $1',
      [t1.tenantId],
    );
    expect(Number(count.rows[0]?.n)).toBe(2);

    // The tenant's own machine credential is still found by the same operations.
    const rotated = await client().identity.credentials.rotate(
      { params: { credential: own.id } },
      { context: contextOf(t1) },
    );
    expect(rotated.id.length).toBeGreaterThan(0);
  }, 120_000);
});

/**
 * Task 16.11b of openspec/changes/archive/2026-10-14-043-identity-lifecycle-and-org-admin (Resolved decision Q147;
 * the security review's LOW-2): `identity.credentials.create` never takes a second pooled
 * connection while its transaction holds an advisory lock.
 *
 * Scenario: GIVEN a `tayzu_app` pool built for the test with a small `max`, WHEN more concurrent
 * `identity.credentials.create` calls of one tenant than the pool has connections are made, THEN
 * all of them complete within the cap, none with a statement timeout or a pool timeout.
 *
 * ## Production symbols expected
 *
 * None new: `createCredential` (`./credentials.js`) runs `serviceAccountExists` and
 * `readRevokedIds` on the client that holds the lock instead of on `appPool`.
 *
 * ## Why this fails right now
 *
 * Each in-flight create holds one pooled connection for its lock and the one that holds the cap
 * lock asks the pool for a second one for `readRevokedIds`; with every connection held by a
 * waiter, nobody progresses until the pool's checkout timeout rejects the calls.
 */
describe('identity.credentials.create under a small pool (task 16.11b)', () => {
  const POOL_MAX = 3;
  const CONCURRENT = 8;
  let smallPool: Pool;
  let authPool: Pool;
  let auth: AuthInstance;
  let cerbos: CerbosClient;

  beforeAll(async () => {
    const pools = await harnessPools();
    authPool = pools.authPool;
    await runMigrations(authPool);
    cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync: createUserSyncAdapter({
        userSync: createUserSync({ pool: pools.appPool, authz: cerbos }),
      }),
    });
    const { Pool: PoolConstructor } = await import('pg');
    smallPool = new PoolConstructor({
      connectionString: process.env['DATABASE_URL'],
      max: POOL_MAX,
      // A stalled checkout rejects instead of hanging the file.
      connectionTimeoutMillis: 15_000,
    });
    smallPool.on('connect', (client) => {
      void client.query('SET ROLE tayzu_app').catch(() => undefined);
    });
  }, 60_000);

  afterAll(async () => {
    await smallPool.end();
  }, 60_000);

  it('more concurrent credentials.create calls of one tenant than the pool has connections all complete with no statement timeout', async () => {
    const id = randomUUID();
    const api = auth.api as OrganizationSurface;
    const owner = await createAdminUser(auth, {
      name: 'Pool Owner',
      email: `pool-owner-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    const org = await api.createOrganization({
      body: { name: 'Pool Org', slug: `pool-${id}`, userId: owner.userId },
    });
    const admin = await createAdminUser(auth, {
      name: 'Pool Admin',
      email: `pool-admin-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    await api.addMember({ body: { userId: admin.userId, organizationId: org.id, role: 'admin' } });

    const client = createRouterClient(
      createIdentityRouter({
        auth,
        authz: cerbos,
        authRepository: createAuthRepository(authPool),
        withUserLock: createWithUserLock(authPool),
        appPool: smallPool,
      }),
      { context: (raw: Record<string, unknown>) => raw },
    ) as unknown as {
      identity: {
        credentials: {
          create(
            input: { body: { name: string; kind: string } },
            options: { context: Record<string, unknown> },
          ): Promise<{ id: string; secret: string }>;
        };
      };
    };
    const context = {
      tenantId: org.id,
      actor: { type: 'user', id: admin.userId },
      principal: { roles: ['admin'] },
    };

    const started = Date.now();
    const outcomes = await Promise.allSettled(
      Array.from({ length: CONCURRENT }, (_, i) =>
        client.identity.credentials.create(
          { body: { name: `Pool key ${String(i)}`, kind: 'integration' } },
          { context },
        ),
      ),
    );
    const elapsedMs = Date.now() - started;

    const failures = outcomes.flatMap((o) =>
      o.status === 'rejected' ? [(o.reason as Error).message] : [],
    );
    expect(failures).toEqual([]);
    expect(outcomes.every((o) => o.status === 'fulfilled')).toBe(true);
    expect(elapsedMs).toBeLessThan(10_000);
    const keys = await authPool.query('select id from auth.apikey where reference_id = $1', [
      org.id,
    ]);
    expect(keys.rows).toHaveLength(CONCURRENT);
  }, 90_000);
});

/**
 * Task 16.12d of openspec/changes/archive/2026-10-14-043-identity-lifecycle-and-org-admin
 * (rotating a revoked credential counts like a creation; Resolved decisions Q56 and Q149; 9.5d).
 *
 * Rotating a revoked credential restores a non-revoked one, so it takes the
 * `credential-cap:<tenant>` advisory lock and is refused beyond the cap with
 * `CATALOG_VALIDATION_FAILED`, creating nothing.
 *
 * ## Production symbols expected
 *
 * - `rotateCredential` (`./credentials.js`), reached through `identity.credentials.rotate`:
 *   when the credential being rotated is revoked, it counts the tenant's non-revoked keys
 *   (`options.credentialCap` of `createIdentityRouter`) under the per-tenant cap lock and
 *   refuses with `CATALOG_VALIDATION_FAILED` before creating anything when the cap is reached.
 */
describe('rotating a revoked credential counts against the cap (task 16.12d, Q56, Q149)', () => {
  const CAP = 3;
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

  interface CapRotateClient {
    identity: {
      credentials: {
        rotate(
          input: { params: { credential: string } },
          options: { context: Record<string, unknown> },
        ): Promise<{ id: string; secret: string }>;
        create(
          input: { body: { name: string; kind: string } },
          options: { context: Record<string, unknown> },
        ): Promise<{ id: string; secret: string }>;
      };
    };
  }

  function client(): CapRotateClient {
    return createRouterClient(
      createIdentityRouter({
        auth,
        authz: cerbos,
        authRepository,
        withUserLock: createWithUserLock(authPool),
        appPool,
        credentialCap: CAP,
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
      name: 'CapRot Owner',
      email: `caprot-owner-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    const org = await api.createOrganization({
      body: { name: 'CapRot Org', slug: `caprot-${id}`, userId: owner.userId },
    });
    const admin = await createAdminUser(auth, {
      name: 'CapRot Admin',
      email: `caprot-admin-${id}@example.test`,
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

  async function seed(org: Org, count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const c = await createMachineCredential(auth, {
        userId: org.adminId,
        organizationId: org.tenantId,
        name: `seed-${String(i)}`,
        actorKind: 'integration',
        metadata: { createdBy: org.adminId },
      });
      ids.push(c.id);
    }
    return ids;
  }

  async function revoke(org: Org, id: string): Promise<void> {
    await revokeMachineCredential(auth, {
      userId: org.adminId,
      id,
      pool: appPool,
      tenantId: org.tenantId,
    });
  }

  /** A revoked key bound to a fresh service account that has no other active credential. */
  async function revokedServiceKey(org: Org): Promise<string> {
    const identifier = `svc-cap-${randomUUID().slice(0, 8)}`;
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
    const c = await createMachineCredential(auth, {
      userId: org.adminId,
      organizationId: org.tenantId,
      name: 'Revoked bound',
      actorKind: 'integration',
      metadata: { userId: identifier, createdBy: org.adminId },
    });
    await revoke(org, c.id);
    return c.id;
  }

  async function keyIds(org: Org): Promise<string[]> {
    const rows = await authPool.query<{ id: string }>(
      'select id from auth.apikey where reference_id = $1',
      [org.tenantId],
    );
    return rows.rows.map((r) => r.id);
  }

  it('A tenant at the cap refuses the rotation of a revoked credential with CATALOG_VALIDATION_FAILED and creates nothing', async () => {
    const org = await freshOrg();
    // CAP non-revoked credentials plus one revoked one.
    await seed(org, CAP);
    const revokedId = await revokedServiceKey(org);
    const before = (await keyIds(org)).sort();
    expect(before).toHaveLength(CAP + 1);

    await expect(
      client().identity.credentials.rotate(
        { params: { credential: revokedId } },
        { context: contextOf(org) },
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });

    expect((await keyIds(org)).sort()).toEqual(before);
  }, 120_000);

  it('Rotating a revoked credential counts like a creation: one place below the cap it succeeds, and the tenant is then full', async () => {
    const org = await freshOrg();
    await seed(org, CAP - 1);
    const revokedId = await revokedServiceKey(org); // CAP - 1 non-revoked

    const rotated = await client().identity.credentials.rotate(
      { params: { credential: revokedId } },
      { context: contextOf(org) },
    );
    expect(rotated.id).not.toBe(revokedId);
    expect(await keyIds(org)).toHaveLength(CAP + 1); // CAP - 1 + revoked + the new one

    await expect(
      client().identity.credentials.create(
        { body: { name: 'One too many', kind: 'integration' } },
        { context: contextOf(org) },
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });
  }, 120_000);

  it('Two concurrent rotations of revoked credentials one below the cap yield exactly one success under the cap lock', async () => {
    const org = await freshOrg();
    await seed(org, CAP - 1); // CAP - 1 non-revoked: one place left
    const a = await revokedServiceKey(org);
    const b = await revokedServiceKey(org);

    const results = await Promise.allSettled([
      client().identity.credentials.rotate(
        { params: { credential: a } },
        { context: contextOf(org) },
      ),
      client().identity.credentials.rotate(
        { params: { credential: b } },
        { context: contextOf(org) },
      ),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });
  }, 120_000);
});

/**
 * Task 16.12j of openspec/changes/archive/2026-10-14-043-identity-lifecycle-and-org-admin (Resolved decision Q148):
 * identity mutations that take an advisory lock are bounded per process by an in-memory semaphore
 * of 2, taken before a pooled connection.
 *
 * Scenario: GIVEN one small `tayzu_app` pool shared by the router and the user-sync adapter (as in
 * production), WHEN more concurrent `identity.credentials.rotate` calls of one tenant than the
 * pool has connections are made, THEN all of them complete within the cap, none with a statement
 * timeout or a pool timeout.
 *
 * ## Production symbols expected
 *
 * None new in the public surface: a process-wide semaphore of 2 (for example
 * `./mutation-semaphore.js`) wraps the five lock-taking identity mutations in
 * `createIdentityRouter`, before `appPool` is asked for a connection.
 *
 * ## Why this fails right now
 *
 * Every in-flight rotation holds a pooled connection waiting for its lock and the holder needs
 * another one from the same pool to revoke the old key, so nobody progresses until the checkout
 * timeout rejects the calls.
 */
describe('identity.credentials.rotate under a small pool shared with the user-sync adapter (task 16.12j, Q148)', () => {
  const POOL_MAX = 3;
  const CONCURRENT = 8;
  let sharedPool: Pool;
  let authPool: Pool;
  let auth: AuthInstance;
  let cerbos: CerbosClient;
  let userSync: ReturnType<typeof createUserSyncAdapter>;

  beforeAll(async () => {
    const pools = await harnessPools();
    authPool = pools.authPool;
    await runMigrations(authPool);
    cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    const { Pool: PoolConstructor } = await import('pg');
    sharedPool = new PoolConstructor({
      connectionString: process.env['DATABASE_URL'],
      max: POOL_MAX,
      connectionTimeoutMillis: 15_000,
    });
    sharedPool.on('connect', (client) => {
      void client.query('SET ROLE tayzu_app').catch(() => undefined);
    });
    userSync = createUserSyncAdapter({
      userSync: createUserSync({ pool: sharedPool, authz: cerbos }),
    });
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync,
    });
  }, 60_000);

  afterAll(async () => {
    await sharedPool.end();
  }, 60_000);

  it('more concurrent credentials.rotate calls of one tenant than the shared pool has connections all complete with no statement timeout', async () => {
    const id = randomUUID();
    const api = auth.api as OrganizationSurface;
    const owner = await createAdminUser(auth, {
      name: 'Rotate Pool Owner',
      email: `rot-pool-owner-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    const org = await api.createOrganization({
      body: { name: 'Rotate Pool Org', slug: `rot-pool-${id}`, userId: owner.userId },
    });
    const admin = await createAdminUser(auth, {
      name: 'Rotate Pool Admin',
      email: `rot-pool-admin-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    await api.addMember({ body: { userId: admin.userId, organizationId: org.id, role: 'admin' } });

    // One service account and one key bound to it per rotation, so the calls hold different
    // per-service-account locks and only the pool limits them.
    const entities = createEntityService({ pool: sharedPool, authz: cerbos });
    const keyIds: string[] = [];
    for (let i = 0; i < CONCURRENT; i += 1) {
      const identifier = `svc-rotpool-${String(i)}`;
      await entities.create(
        {
          tenantId: org.id,
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
      const key = await createMachineCredential(auth, {
        userId: admin.userId,
        organizationId: org.id,
        name: `Rotate pool key ${String(i)}`,
        actorKind: 'integration',
        metadata: { userId: identifier, createdBy: admin.userId },
      });
      keyIds.push(key.id);
    }

    const client = createRouterClient(
      createIdentityRouter({
        auth,
        authz: cerbos,
        authRepository: createAuthRepository(authPool),
        withUserLock: createWithUserLock(authPool),
        appPool: sharedPool,
        userSync,
      }),
      { context: (raw: Record<string, unknown>) => raw },
    ) as unknown as {
      identity: {
        credentials: {
          rotate(
            input: { params: { credential: string } },
            options: { context: Record<string, unknown> },
          ): Promise<{ id: string; secret: string }>;
        };
      };
    };
    const context = {
      tenantId: org.id,
      actor: { type: 'user', id: admin.userId },
      principal: { roles: ['admin'] },
    };

    const started = Date.now();
    const outcomes = await Promise.allSettled(
      keyIds.map((credential) =>
        client.identity.credentials.rotate({ params: { credential } }, { context }),
      ),
    );
    const elapsedMs = Date.now() - started;

    const failures = outcomes.flatMap((o) =>
      o.status === 'rejected' ? [(o.reason as Error).message] : [],
    );
    expect(failures).toEqual([]);
    expect(outcomes.every((o) => o.status === 'fulfilled')).toBe(true);
    expect(elapsedMs).toBeLessThan(10_000);
    const keys = await authPool.query('select id from auth.apikey where reference_id = $1', [
      org.id,
    ]);
    expect(keys.rows).toHaveLength(CONCURRENT * 2);
  }, 120_000);
});

/**
 * Task 16.12l (Resolved decision Q149). Spec scenario "Delete and rotate see credentials beyond
 * the viewer's limit": GIVEN a service account whose credential is beyond the viewer's page limit
 * among the tenant's keys, WHEN an admin rotates or deletes it, THEN the credential is found and
 * revoked.
 *
 * The viewer lists at most 200 non-revoked credentials, oldest first, and reads keys in pages of
 * 100. The tenant holds 205 unbound keys created BEFORE the two service-account keys, so those
 * come after the viewer's limit (and after the second page of the reader).
 *
 * Production symbols expected: none new. This is expected to pass on arrival (`apiKeyById`
 * looks the key up directly).
 */
describe('delete and rotate see credentials beyond the viewer limit (task 16.12l, Q149)', () => {
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

  interface BeyondClient {
    identity: {
      credentials: {
        list(
          input: { query: Record<string, never> },
          options: { context: Record<string, unknown> },
        ): Promise<ListOutput>;
        rotate(
          input: { params: { credential: string } },
          options: { context: Record<string, unknown> },
        ): Promise<{ id: string; secret: string }>;
      };
      serviceAccounts: {
        delete(
          input: { params: { user: string } },
          options: { context: Record<string, unknown> },
        ): Promise<unknown>;
      };
    };
  }

  function client(): BeyondClient {
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

  async function revocationCount(tenantId: string, id: string): Promise<number> {
    const result = await withTenantTransaction(appPool, { tenantId }, (c) =>
      c.query<{ n: string }>(
        `select count(*)::text as n from machine_credential_revocation
          where credential_id = $1 and tenant_id = $2`,
        [id, tenantId],
      ),
    );
    return Number(result.rows[0]?.n);
  }

  async function seedServiceAccount(tenantId: string, identifier: string): Promise<void> {
    await createEntityService({ pool: appPool, authz: cerbos }).create(
      {
        tenantId,
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

  it("Delete and rotate see credentials beyond the viewer's limit: a service account's key after 205 older keys is absent from the viewer, yet rotate and delete find and revoke it", async () => {
    const id = randomUUID();
    const api = auth.api as OrganizationSurface;
    const owner = await createAdminUser(auth, {
      name: 'Beyond Owner',
      email: `beyond-owner-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    const org = await api.createOrganization({
      body: { name: 'Beyond Org', slug: `beyond-${id}`, userId: owner.userId },
    });
    const admin = await createAdminUser(auth, {
      name: 'Beyond Admin',
      email: `beyond-admin-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    await api.addMember({ body: { userId: admin.userId, organizationId: org.id, role: 'admin' } });
    const context = {
      tenantId: org.id,
      actor: { type: 'user', id: admin.userId },
      principal: { roles: ['admin'] },
    };
    const seedKey = (name: string, userId?: string) =>
      createMachineCredential(auth, {
        userId: admin.userId,
        organizationId: org.id,
        name,
        actorKind: 'integration',
        metadata: { createdBy: admin.userId, ...(userId === undefined ? {} : { userId }) },
      });

    // 205 older keys, in batches.
    for (let start = 0; start < 205; start += 20) {
      const width = Math.min(20, 205 - start);
      await Promise.all(
        Array.from({ length: width }, (_, i) => seedKey(`filler-${String(start + i)}`)),
      );
    }

    const rotating = `svc-rot-${randomUUID().slice(0, 8)}`;
    const deleting = `svc-del-${randomUUID().slice(0, 8)}`;
    await seedServiceAccount(org.id, rotating);
    await seedServiceAccount(org.id, deleting);
    const toRotate = await seedKey('Rotate me', rotating);
    const toDelete = await seedKey('Delete me', deleting);

    // GIVEN both keys are beyond the viewer's limit among the tenant's keys.
    const listed = await client().identity.credentials.list({ query: {} }, { context });
    expect(listed.credentials).toHaveLength(200);
    expect(listed.truncated).toBe(true);
    const shown = listed.credentials.map((c) => c.id);
    expect(shown).not.toContain(toRotate.id);
    expect(shown).not.toContain(toDelete.id);

    // WHEN an admin rotates one and deletes the other, THEN each is found and revoked.
    const rotated = await client().identity.credentials.rotate(
      { params: { credential: toRotate.id } },
      { context },
    );
    expect(rotated.id).not.toBe(toRotate.id);
    expect(await revocationCount(org.id, toRotate.id)).toBe(1);
    expect(await revocationCount(org.id, rotated.id)).toBe(0);

    await client().identity.serviceAccounts.delete({ params: { user: deleting } }, { context });
    expect(await revocationCount(org.id, toDelete.id)).toBe(1);
  }, 300_000);
});
