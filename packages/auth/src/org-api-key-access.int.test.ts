/**
 * Integration test for task 9.1b of `043-identity-lifecycle-and-org-admin`
 * (design D8 "Org keys by an admin who is not the owner", Resolved decisions
 * Q29 and Q94).
 *
 * ## Production symbols expected (flagged for the green phase)
 *
 * - `./auth.ts`: `organization({ ac, roles: { owner, admin, member } })` where
 *   the three roles are built from Better Auth's default statements (every
 *   default permission kept) and `admin` additionally holds `apiKey`
 *   create/read/update/delete. `owner` holds the `apiKey` permissions too.
 *   `member` does not.
 * - `./machine-credentials.ts`:
 *   - `CreateMachineCredentialParams` loses `headers`, gains a required
 *     `userId` (the acting admin's Better Auth user id, forwarded as
 *     `body.userId`) and an optional `metadata?: { userId?: string;
 *     createdBy?: string }` supplied by the caller (`userId` is the `svc-…`
 *     identifier of a bound service account, `createdBy` the acting admin's
 *     opaque id). `actorKind`, `organizationId`, `name` and `role?` stay.
 *   - `RevokeMachineCredentialParams` loses `headers` and gains a required
 *     `userId` (the acting admin's Better Auth user id). `id`, `pool` and
 *     `tenantId` stay. A key of another tenant (or an unknown id) throws
 *     `AuthContextError` before any revocation row is written.
 *
 * ## Why these cases
 *
 * Custom organization roles replace Better Auth's defaults, so defining the
 * roles must keep every default permission (an `admin` still creates and
 * cancels invitations; a `member` still cannot), and the `apiKey` grant is
 * what lets Better Auth's own check pass for an `admin` who is not the owner
 * when the call is headerless with `body.userId`. The `apikey` row stores no
 * user id, so "`body.userId` is the admin's id" is observed through Better
 * Auth's organization-permission check, which only passes for a user that is a
 * member of the organization with an `apiKey` grant: a `member`, or a user
 * outside the organization, is refused whatever `metadata.userId` says.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { runMigrations, withTenantTransaction } from '@tayzu/db';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Import order is load-bearing: the harness registers before `./auth.js`.
import {
  bootstrapTestTenant,
  createAdminUser,
  signInAdminUser,
} from './__fixtures__/admin-user.js';
import './__fixtures__/registered-harness.js';
import { createAuth, type AuthInstance } from './auth.js';
import { AuthContextError } from './errors.js';
import { createMachineCredential, revokeMachineCredential } from './machine-credentials.js';
import * as authSchema from './persistence/schema.js';
import { TEST_SECRET } from './__fixtures__/test-secret.js';

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim() === '') {
    throw new Error(
      'DATABASE_URL is not set: the int project global setup should have stopped this run.',
    );
  }
  return url;
}

function connect(url: string): ReturnType<typeof drizzle<typeof authSchema>> {
  return drizzle(url, { schema: authSchema });
}

type TestDb = ReturnType<typeof connect>;

async function endQuietly(closeable: {
  on(event: 'error', listener: (error: unknown) => void): unknown;
  end(): Promise<void>;
}): Promise<void> {
  closeable.on('error', () => {
    // Expected only during teardown.
  });
  await closeable.end();
}

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

const TEST_PASSWORD = 'correct horse battery staple';
const AUTH_BASE_URL = 'http://localhost:3000/api/auth';
const TEST_ORIGIN = 'http://localhost:3000';
const MACHINE_CREDENTIAL_CONFIG_ID = 'machine-credential';

interface AddMemberApiSurface {
  addMember(args: {
    body: { userId: string; organizationId: string; role: string };
  }): Promise<unknown>;
}

interface VerifyApiKeyApiSurface {
  verifyApiKey(args: {
    body: { readonly key: string; readonly configId?: string };
  }): Promise<{ readonly valid: boolean }>;
}

function handlerOf(auth: AuthInstance): (request: Request) => Promise<Response> {
  return (auth as unknown as { handler: (request: Request) => Promise<Response> }).handler;
}

async function post(
  auth: AuthInstance,
  cookie: string,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: unknown }> {
  const response = await handlerOf(auth)(
    new Request(`${AUTH_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: TEST_ORIGIN,
        'x-forwarded-for': randomIp(),
      },
      body: JSON.stringify(body),
    }),
  );
  const text = await response.text();
  return { status: response.status, json: text === '' ? null : (JSON.parse(text) as unknown) };
}

describe('Org API keys for an admin who is not the owner (task 9.1b, Q29)', () => {
  let db: TestDb;
  let auth: AuthInstance;
  let appPool: TestDb['$client'];

  beforeAll(async () => {
    db = connect(databaseUrl());
    await runMigrations(db.$client);
    auth = createAuth({ db, secret: TEST_SECRET });
    appPool = connect(databaseUrl()).$client;
    appPool.on('connect', (client) => {
      void client.query('SET ROLE tayzu_app');
    });
  }, 60_000);

  afterAll(async () => {
    await endQuietly(appPool);
    await endQuietly(db.$client);
  });

  async function newTenant(): Promise<{
    ownerId: string;
    ownerCookie: string;
    organizationId: string;
  }> {
    const owner = await bootstrapTestTenant(auth, {
      name: 'Org Key Owner',
      email: `org-key-owner-${randomUUID()}@example.test`,
      password: TEST_PASSWORD,
      organizationName: 'Org Key Org',
      organizationSlug: `org-key-org-${randomUUID()}`,
      ip: randomIp(),
    });
    return {
      ownerId: owner.userId,
      ownerCookie: owner.cookie,
      organizationId: owner.organizationId,
    };
  }

  /** A user that is a member of the organization with the given Better Auth role. */
  async function addMemberWithRole(
    organizationId: string,
    role: 'admin' | 'member',
  ): Promise<{ userId: string; cookie: string }> {
    const email = `org-key-${role}-${randomUUID()}@example.test`;
    const user = await createAdminUser(auth, {
      name: `Org Key ${role}`,
      email,
      password: TEST_PASSWORD,
    });
    await (auth.api as AddMemberApiSurface).addMember({
      body: { userId: user.userId, organizationId, role },
    });
    const signedIn = await signInAdminUser(auth, {
      email,
      password: TEST_PASSWORD,
      ip: randomIp(),
    });
    return { userId: user.userId, cookie: signedIn.cookie };
  }

  async function verifies(secret: string): Promise<boolean> {
    const result = await (auth.api as VerifyApiKeyApiSurface).verifyApiKey({
      body: { key: secret, configId: MACHINE_CREDENTIAL_CONFIG_ID },
    });
    return result.valid;
  }

  async function keyCount(organizationId: string): Promise<number> {
    const result = await db.execute<{ n: string }>(sql`
      select count(*)::text as n from auth.apikey where reference_id = ${organizationId}
    `);
    return Number(result.rows[0]?.n ?? '0');
  }

  async function revocationIds(tenantId: string, id: string): Promise<readonly string[]> {
    return withTenantTransaction(appPool, { tenantId }, async (client) => {
      const result = await client.query<{ credential_id: string }>(
        'select credential_id from machine_credential_revocation where credential_id = $1',
        [id],
      );
      return result.rows.map((row) => row.credential_id);
    });
  }

  it('An admin who is not the owner creates and revokes an org key headerless with body.userId', async () => {
    const { organizationId } = await newTenant();
    const admin = await addMemberWithRole(organizationId, 'admin');

    // WHEN the admin (Better Auth role `admin`, not `owner`) creates a key
    // headerless, `body.userId` being the admin's own Better Auth user id and
    // `metadata.userId` a different (service-account) identifier.
    const created = await createMachineCredential(auth, {
      userId: admin.userId,
      organizationId,
      name: 'admin created key',
      actorKind: 'integration',
      metadata: { userId: 'svc-example', createdBy: admin.userId },
    });
    expect(created.organizationId, 'the key belongs to the admin’s organization').toBe(
      organizationId,
    );
    expect(await verifies(created.secret), 'the new key authenticates').toBe(true);

    const stored = await db.execute<{ metadata: string | null }>(sql`
      select metadata from auth.apikey where id = ${created.id}
    `);
    const metadata = JSON.parse(stored.rows[0]?.metadata ?? '{}') as Record<string, unknown>;
    expect(metadata.createdBy, 'createdBy is supplied by the caller').toBe(admin.userId);
    expect(
      metadata.userId,
      'metadata.userId is the caller-supplied identifier, not body.userId',
    ).toBe('svc-example');
    expect(metadata.actorKind).toBe('integration');
    expect(metadata.role).toBe('member');

    // AND the same admin revokes it, headerless with body.userId.
    await revokeMachineCredential(auth, {
      userId: admin.userId,
      id: created.id,
      pool: appPool,
      tenantId: organizationId,
    });
    expect(await verifies(created.secret), 'the revoked key no longer authenticates').toBe(false);
    expect(await revocationIds(organizationId, created.id)).toEqual([created.id]);
  });

  it('An owner creates and revokes an org key the same way (custom roles replace the defaults)', async () => {
    const { ownerId, organizationId } = await newTenant();

    const created = await createMachineCredential(auth, {
      userId: ownerId,
      organizationId,
      name: 'owner created key',
      actorKind: 'agent',
      metadata: { createdBy: ownerId },
    });
    expect(await verifies(created.secret)).toBe(true);

    await revokeMachineCredential(auth, {
      userId: ownerId,
      id: created.id,
      pool: appPool,
      tenantId: organizationId,
    });
    expect(await verifies(created.secret)).toBe(false);
    expect(await revocationIds(organizationId, created.id)).toEqual([created.id]);
  });

  it('An admin revokes a key that the owner created', async () => {
    const { ownerId, organizationId } = await newTenant();
    const admin = await addMemberWithRole(organizationId, 'admin');
    const created = await createMachineCredential(auth, {
      userId: ownerId,
      organizationId,
      name: 'owner key',
      actorKind: 'integration',
      metadata: { createdBy: ownerId },
    });

    await revokeMachineCredential(auth, {
      userId: admin.userId,
      id: created.id,
      pool: appPool,
      tenantId: organizationId,
    });
    expect(await verifies(created.secret)).toBe(false);
  });

  it('A member cannot manage keys: create and revoke are refused by Better Auth’s own check', async () => {
    const { ownerId, organizationId } = await newTenant();
    const member = await addMemberWithRole(organizationId, 'member');
    const existing = await createMachineCredential(auth, {
      userId: ownerId,
      organizationId,
      name: 'owner key',
      actorKind: 'integration',
      metadata: { createdBy: ownerId },
    });
    const before = await keyCount(organizationId);

    await expect(
      createMachineCredential(auth, {
        userId: member.userId,
        organizationId,
        name: 'member created key',
        actorKind: 'integration',
        metadata: { createdBy: member.userId },
      }),
    ).rejects.toMatchObject({ status: 'FORBIDDEN' });
    expect(await keyCount(organizationId), 'no key row was written').toBe(before);

    await expect(
      revokeMachineCredential(auth, {
        userId: member.userId,
        id: existing.id,
        pool: appPool,
        tenantId: organizationId,
      }),
    ).rejects.toMatchObject({ status: 'FORBIDDEN' });
    expect(await revocationIds(organizationId, existing.id), 'no revocation row').toHaveLength(0);
    expect(await verifies(existing.secret), 'the key is still enabled').toBe(true);
  });

  it('body.userId is the acting admin: a user outside the organization is refused', async () => {
    const { organizationId } = await newTenant();
    const otherTenant = await newTenant();
    const before = await keyCount(organizationId);

    await expect(
      createMachineCredential(auth, {
        userId: otherTenant.ownerId,
        organizationId,
        name: 'outsider key',
        actorKind: 'integration',
        metadata: { createdBy: otherTenant.ownerId },
      }),
    ).rejects.toBeDefined();
    expect(await keyCount(organizationId), 'no key row was written').toBe(before);
  });

  it('The three roles keep every default permission', async () => {
    const { ownerCookie, organizationId } = await newTenant();
    const admin = await addMemberWithRole(organizationId, 'admin');
    const member = await addMemberWithRole(organizationId, 'member');

    // admin: can create and cancel an invitation.
    const invited = await post(auth, admin.cookie, '/organization/invite-member', {
      email: `invitee-${randomUUID()}@example.test`,
      role: 'member',
      organizationId,
    });
    expect(invited.status, 'an admin can create an invitation').toBe(200);
    const invitationId = (invited.json as { id: string }).id;
    const canceled = await post(auth, admin.cookie, '/organization/cancel-invitation', {
      invitationId,
    });
    expect(canceled.status, 'an admin can cancel an invitation').toBe(200);

    // owner: can create an invitation too.
    const ownerInvited = await post(auth, ownerCookie, '/organization/invite-member', {
      email: `invitee-${randomUUID()}@example.test`,
      role: 'member',
      organizationId,
    });
    expect(ownerInvited.status, 'an owner can create an invitation').toBe(200);

    // member: cannot.
    const memberInvited = await post(auth, member.cookie, '/organization/invite-member', {
      email: `invitee-${randomUUID()}@example.test`,
      role: 'member',
      organizationId,
    });
    expect(memberInvited.status, 'a member cannot create an invitation').toBe(403);

    // The rest of the default statements: owner may delete the organization,
    // an admin may update it but not delete it, a member may do neither.
    const has = async (cookie: string, permissions: Record<string, string[]>): Promise<boolean> => {
      const result = await post(auth, cookie, '/organization/has-permission', {
        permissions,
        organizationId,
      });
      return (result.json as { success?: boolean }).success === true;
    };
    expect(await has(ownerCookie, { organization: ['delete'] }), 'owner deletes the org').toBe(
      true,
    );
    expect(await has(admin.cookie, { organization: ['update'] }), 'admin updates the org').toBe(
      true,
    );
    expect(await has(admin.cookie, { organization: ['delete'] }), 'admin cannot delete').toBe(
      false,
    );
    expect(await has(admin.cookie, { member: ['create'] }), 'admin manages members').toBe(true);
    expect(await has(member.cookie, { organization: ['update'] }), 'member cannot update').toBe(
      false,
    );
  });

  it('Neither helper takes session headers any more', () => {
    const never = async (): Promise<void> => {
      await createMachineCredential(auth, {
        // @ts-expect-error `headers` is no longer a parameter of `CreateMachineCredentialParams`
        headers: new Headers(),
        userId: 'u',
        organizationId: 'o',
        name: 'n',
        actorKind: 'integration',
      });
      await revokeMachineCredential(auth, {
        // @ts-expect-error `headers` is no longer a parameter of `RevokeMachineCredentialParams`
        headers: new Headers(),
        userId: 'u',
        id: 'x',
        pool: appPool,
        tenantId: 't',
      });
    };
    expect(typeof never).toBe('function');
  });

  it('Revoking another tenant’s key still throws AuthContextError without a revocation row', async () => {
    const tenantA = await newTenant();
    const tenantB = await newTenant();
    const foreign = await createMachineCredential(auth, {
      userId: tenantB.ownerId,
      organizationId: tenantB.organizationId,
      name: 'tenant B key',
      actorKind: 'integration',
      metadata: { createdBy: tenantB.ownerId },
    });

    await expect(
      revokeMachineCredential(auth, {
        userId: tenantA.ownerId,
        id: foreign.id,
        pool: appPool,
        tenantId: tenantA.organizationId,
      }),
    ).rejects.toBeInstanceOf(AuthContextError);

    expect(await revocationIds(tenantA.organizationId, foreign.id)).toHaveLength(0);
    expect(await revocationIds(tenantB.organizationId, foreign.id)).toHaveLength(0);
    expect(await verifies(foreign.secret), 'the foreign key is untouched').toBe(true);
  });
});
