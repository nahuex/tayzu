/**
 * Integration test for task 18.3 (openspec/changes/archive/2026-10-15-002-auth-and-rbac; design
 * D22, Resolved decision Q16; `specs/auth-and-rbac/spec.md`, "Public self
 * sign-up is not available").
 *
 * Task 18.3: "`identity.users.create`: a Cerbos-gated oRPC procedure (`admin`
 * role, `user.yaml` resource policy) calling `auth.api.createUser` in-process,
 * fixing the created user's initial role and returning a system-generated
 * temporary password once, in the creation response only."
 *
 * Scenarios covered (verbatim from the spec):
 * - "An org admin can create a user": GIVEN a caller with the `admin` role,
 *   WHEN they create a user with an email and a fixed actor kind, THEN a
 *   Tayzu user account exists, and a temporary credential is returned once in
 *   the response.
 * - "A member cannot create a user": GIVEN a caller with only the `member`
 *   role, WHEN they attempt to create a user, THEN it fails with
 *   `AUTH_FORBIDDEN`.
 *
 * The test lives in `apps/api` because it is the only package depending on
 * `@tayzu/auth` and `@tayzu/authz` together (`@tayzu/auth` has no dependency
 * on `@tayzu/authz`), same reason `user-sync.int.test.ts` gives.
 *
 * ## Production symbols assumed (none of them exists yet)
 *
 * - `./identity-router.js` exports `createIdentityRouter({ auth, authz })`,
 *   an oRPC router (called in-process with `createRouterClient`, never over
 *   HTTP, design D18/CLAUDE.md "No network exposure") with one procedure at
 *   `identity.users.create`. `auth` is the `AuthInstance`, `authz` the
 *   `CerbosClient` from `@tayzu/authz`.
 * - The procedure's host-supplied context is the same raw shape the catalog
 *   router takes: `{ tenantId, actor, principal: { roles } }`. It checks
 *   Cerbos for resource kind `user`, action `create` (`user.yaml`, no policy
 *   change needed: `admin` gets `*`, `member` only `view`/`list`). A deny
 *   throws an error whose `code` is `AUTH_FORBIDDEN` (`AuthorizationError`)
 *   and nothing is created.
 * - Input: `{ email, name, role }` -- `role` is the created user's fixed
 *   initial (Better Auth admin plugin) role. The caller never supplies a
 *   password: the procedure generates it.
 * - Output includes `temporaryPassword` (a non-empty string) and `email`.
 *   The password is real: signing in with it succeeds. It is returned in the
 *   creation response only (no email is sent, 002 ships no email sender).
 *
 * The spec's scenario says "an email and a fixed actor kind"; the task text
 * says "initial role". This test treats it as the one `role` input field.
 * Nothing about organization membership is asserted: the spec does not say.
 */
// Load-bearing import order (044 design D1): the telemetry harness registers before anything
// that loads `@tayzu/auth` creates its logger.
import { registration, type TelemetryTestHarness } from './__fixtures__/link-telemetry.js';
import { randomUUID } from 'node:crypto';

import { createRouterClient } from '@orpc/server';
import {
  AuthRateLimitedError,
  authSchema,
  createAuth,
  createRecordingEmailSender,
  type AuthInstance,
  type EmailSender,
} from '@tayzu/auth';
import { createCerbosClient } from '@tayzu/authz';
import { runMigrations } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import {
  createAdminUser,
  signInAdminUser,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createAuthRepository } from './identity/auth-repository.js';
import type { EmailCapStore } from './identity/email-tenant-gate.js';
import { createRecoveryMailer } from './identity/recovery-mailer.js';
import { createWithUserLock } from './identity/user-lock.js';
// The module under test (task 18.3): does not exist yet.
import { createIdentityRouter } from './identity-router.js';
import { TEST_SECRET, TEST_PASSWORD } from '../../../packages/auth/src/__fixtures__/test-secret.js';

function randomIp(): string {
  const octet = (): string => String(1 + Math.floor(Math.random() * 254));
  return `10.${octet()}.${octet()}.${octet()}`;
}

interface CreateOrganizationSurface {
  createOrganization(args: {
    body: { name: string; slug: string; userId: string };
  }): Promise<{ id: string }>;
}

type UserRow = { readonly id: string; readonly role: string | null };

describe('identity.users.create (task 18.3, design D22)', () => {
  let authPool: Pool;
  let auth: AuthInstance;
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
    client = createRouterClient(
      createIdentityRouter({
        auth,
        authz: cerbos,
        authRepository: createAuthRepository(authPool),
        withUserLock: createWithUserLock(authPool),
      }),
      {
        context: (raw: Record<string, unknown>) => raw,
      },
    );
  }, 60_000);

  async function freshTenantId(): Promise<string> {
    const id = randomUUID();
    const owner = await createAdminUser(auth, {
      name: 'Tenant Owner',
      email: `owner-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    const org = await (auth.api as CreateOrganizationSurface).createOrganization({
      body: { name: 'Admin Creation Org', slug: `admin-creation-${id}`, userId: owner.userId },
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

  async function findUser(email: string): Promise<UserRow | undefined> {
    const db = drizzle(authPool, { schema: authSchema });
    const result = await db.execute<UserRow>(sql`
      select id, role from auth."user" where email = ${email}
    `);
    return result.rows[0];
  }

  it('An org admin can create a user: the account exists and a working temporary password is returned in the response', async () => {
    const tenantId = await freshTenantId();
    const email = `created-${randomUUID()}@example.test`;

    // GIVEN a caller with the `admin` role; WHEN they create a user.
    const result = await client.identity.users.create(
      { body: { email, name: 'Created By Admin', role: 'member' } },
      { context: context(tenantId, ['admin']) },
    );

    // THEN a Tayzu user account exists, with the fixed global role `user`
    // (design Q37: `member` is the organization role, not the global one)...
    const row = await findUser(email);
    expect(row, 'a user account exists for the email').toBeDefined();
    expect(row?.role).toBe('user');

    // ...and a temporary credential is returned in the response.
    expect(typeof result.temporaryPassword).toBe('string');
    expect(result.temporaryPassword.length).toBeGreaterThan(0);

    // The returned credential is real: it signs the new user in.
    const signedIn = await signInAdminUser(auth, {
      email,
      password: result.temporaryPassword,
      ip: randomIp(),
    });
    expect(signedIn.email).toBe(email);
  }, 60_000);

  it('A member cannot create a user: it fails with AUTH_FORBIDDEN and no account is created', async () => {
    const tenantId = await freshTenantId();
    const email = `forbidden-${randomUUID()}@example.test`;

    // GIVEN a caller with only the `member` role; WHEN they attempt to create a user.
    const thrown: unknown = await client.identity.users
      .create(
        { body: { email, name: 'Should Not Exist', role: 'member' } },
        { context: context(tenantId, ['member']) },
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // THEN it fails with `AUTH_FORBIDDEN`...
    expect(thrown, 'the call must be rejected').toBeDefined();
    expect((thrown as { code?: unknown }).code).toBe('AUTH_FORBIDDEN');

    // ...and nothing was created.
    expect(await findUser(email)).toBeUndefined();
  }, 60_000);

  // Task 23.9 (design Q37, D22): `role` is an ORGANIZATION role (`member` or
  // `admin`); the global Better Auth role is always `user`; the membership is
  // added in the same operation. Expected production behavior: `role` outside
  // {member, admin} is rejected with `CATALOG_VALIDATION_FAILED` before any
  // user is created; `identity.users.create` adds an `auth.member` row.
  async function findMemberships(
    userId: string,
  ): Promise<readonly { organizationId: string; role: string }[]> {
    const db = drizzle(authPool, { schema: authSchema });
    const result = await db.execute<{ organizationId: string; role: string }>(sql`
      select organization_id as "organizationId", role from auth.member where user_id = ${userId}
    `);
    return result.rows;
  }

  it('Task 23.9: role "admin" creates a user whose global role is `user` with an org `admin` membership', async () => {
    const tenantId = await freshTenantId();
    const email = `org-admin-${randomUUID()}@example.test`;

    const result = await client.identity.users.create(
      { body: { email, name: 'Org Admin', role: 'admin' } },
      { context: context(tenantId, ['admin']) },
    );

    const row = await findUser(email);
    expect(row?.role, 'global auth.user.role is always `user`').toBe('user');
    const memberships = await findMemberships(result.userId);
    expect(memberships).toEqual([{ organizationId: tenantId, role: 'admin' }]);
  }, 60_000);

  it('Task 23.9: role "member" creates a user whose global role is `user` with an org `member` membership', async () => {
    const tenantId = await freshTenantId();
    const email = `org-member-${randomUUID()}@example.test`;

    const result = await client.identity.users.create(
      { body: { email, name: 'Org Member', role: 'member' } },
      { context: context(tenantId, ['admin']) },
    );

    const row = await findUser(email);
    expect(row?.role).toBe('user');
    const memberships = await findMemberships(result.userId);
    expect(memberships).toEqual([{ organizationId: tenantId, role: 'member' }]);
  }, 60_000);

  it.each(['user', 'owner', 'user,admin', ''])(
    'Task 23.9: role %j is rejected as invalid input and no user is created',
    async (role) => {
      const tenantId = await freshTenantId();
      const email = `invalid-role-${randomUUID()}@example.test`;

      const thrown: unknown = await client.identity.users
        .create(
          { body: { email, name: 'Invalid Role', role } },
          { context: context(tenantId, ['admin']) },
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(thrown, 'the call must be rejected').toBeDefined();
      expect((thrown as { code?: unknown }).code).toBe('CATALOG_VALIDATION_FAILED');
      expect(await findUser(email)).toBeUndefined();
    },
    60_000,
  );
});

/**
 * Task 7.3 of openspec/changes/044-password-reset-and-account-recovery.
 *
 * Scenario "A squatted address is warned" (specs/password-reset-and-account-recovery/spec.md,
 * requirement "Recovery notices are fixed and carry no link"): WHEN an admin creates an account
 * for `victim@example.com` through `identity.users.create`, THEN `victim@example.com` receives
 * the fixed account-created notice, with no link, no organization name and the
 * operator-contact sentence, and the response of the operation is unchanged.
 * The fixed text is covered by task 3.3; here the template kind is the contract.
 *
 * Also "a notice MUST NOT block the operation that triggered it and MUST NOT be sent when the
 * operation fails" and the cap scenario's "both creations succeed, neither notice is sent".
 *
 * ## Production symbols expected (none exists yet)
 *
 * `CreateIdentityRouterOptions` (apps/api/src/identity-router.ts) gains
 * `readonly recoveryMailer?: RecoveryMailer` (apps/api/src/identity/recovery-mailer.ts). After
 * `addMember` succeeds, `identity.users.create` calls
 * `recoveryMailer.sendNotice({ kind: 'AccountCreatedNotice', address, userId, tenantIds,
 * creatingTenantId })` with the canonical address and the creating tenant. The response keeps
 * its pre-044 shape `{ userId, email, temporaryPassword }`.
 */
describe('identity.users.create account-created notice (044 task 7.3)', () => {
  let authPool: Pool;
  let auth: AuthInstance;
  let harness: TelemetryTestHarness;

  const SUPPRESSED = 'catalog.security.recovery_email_suppressed';
  const SECRET = 'admin-user-creation-test-only-secret-0123456789-abcdef';

  beforeAll(async () => {
    if ('error' in registration) {
      throw new Error(`createTelemetryTestHarness() failed: ${String(registration.error)}`, {
        cause: registration.error,
      });
    }
    harness = registration.harness;
    const pools = await harnessPools();
    authPool = pools.authPool;
    await runMigrations(authPool);
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
    });
  }, 60_000);

  beforeEach(async () => {
    await harness.reset();
  });

  function roomyStore(): EmailCapStore {
    return { consume: () => Promise.resolve() };
  }

  function clientWith(recoveryMailer?: ReturnType<typeof createRecoveryMailer>) {
    return createRouterClient(
      createIdentityRouter({
        auth,
        authz: createCerbosClient({ address: 'localhost:3593', tls: false }),
        authRepository: createAuthRepository(authPool),
        withUserLock: createWithUserLock(authPool),
        ...(recoveryMailer === undefined ? {} : { recoveryMailer }),
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );
  }

  function mailerWith(sender: EmailSender, capStore: EmailCapStore = roomyStore()) {
    return createRecoveryMailer({
      disabledTenantIds: [],
      capStore,
      sender,
      recipientKeySecret: SECRET,
    });
  }

  async function freshTenantId(): Promise<string> {
    const id = randomUUID();
    const owner = await createAdminUser(auth, {
      name: 'Tenant Owner',
      email: `owner-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    const org = await (auth.api as CreateOrganizationSurface).createOrganization({
      body: { name: '<b>Pay now</b>', slug: `notice-creation-${id}`, userId: owner.userId },
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

  async function userIdOf(email: string): Promise<string | undefined> {
    const db = drizzle(authPool, { schema: authSchema });
    const result = await db.execute<{ id: string }>(sql`
      select id from auth."user" where email = ${email}
    `);
    return result.rows[0]?.id;
  }

  async function membershipCount(userId: string): Promise<number> {
    const db = drizzle(authPool, { schema: authSchema });
    const result = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from auth.member where user_id = ${userId}
    `);
    return result.rows[0]?.n ?? 0;
  }

  async function everySignal(): Promise<string> {
    await harness.forceFlush();
    return JSON.stringify([
      harness.logExporter.getFinishedLogRecords().map((r) => [r.eventName, r.attributes, r.body]),
      harness.metricExporter
        .getMetrics()
        .flatMap((m) => m.scopeMetrics)
        .flatMap((s) => s.metrics)
        .map((metric) => [metric.descriptor.name, metric.dataPoints.map((p) => p.attributes)]),
    ]);
  }

  it('A squatted address is warned: the address receives one fixed AccountCreatedNotice with no link', async () => {
    const tenantId = await freshTenantId();
    const email = `victim-${randomUUID()}@example.test`;
    const sender = createRecordingEmailSender();
    const client = clientWith(mailerWith(sender));

    await client.identity.users.create(
      { body: { email, name: 'Victim <i>Name</i>', role: 'member' } },
      { context: context(tenantId, ['admin']) },
    );

    await vi.waitFor(() => {
      expect(sender.sent).toHaveLength(1);
    });
    const [message] = sender.sent;
    expect(message?.to).toBe(email);
    // The template is the bare fixed kind: no link, no interpolated value, no tenant text.
    expect(message?.template).toEqual({ kind: 'AccountCreatedNotice' });
    expect(JSON.stringify(message)).not.toContain('Pay now');
    expect(JSON.stringify(message)).not.toContain('http');
  }, 60_000);

  it('the notice is sent after the membership is added, never before', async () => {
    const tenantId = await freshTenantId();
    const email = `order-${randomUUID()}@example.test`;
    let membershipsAtSend: number | undefined;
    const sender: EmailSender = {
      async send(to) {
        const userId = await userIdOf(to);
        membershipsAtSend = userId === undefined ? -1 : await membershipCount(userId);
      },
    };
    const client = clientWith(mailerWith(sender));

    await client.identity.users.create(
      { body: { email, name: 'Order Check', role: 'member' } },
      { context: context(tenantId, ['admin']) },
    );

    await vi.waitFor(() => {
      expect(membershipsAtSend).toBeDefined();
    });
    expect(membershipsAtSend).toBe(1);
  }, 60_000);

  it('the response body equals the pre-044 body', async () => {
    const tenantId = await freshTenantId();
    const withNotice = clientWith(mailerWith(createRecordingEmailSender()));
    const withoutMailer = clientWith();

    const emailA = `body-a-${randomUUID()}@example.test`;
    const emailB = `body-b-${randomUUID()}@example.test`;
    const a = await withNotice.identity.users.create(
      { body: { email: emailA, name: 'Body A', role: 'member' } },
      { context: context(tenantId, ['admin']) },
    );
    const b = await withoutMailer.identity.users.create(
      { body: { email: emailB, name: 'Body B', role: 'member' } },
      { context: context(tenantId, ['admin']) },
    );

    expect(Object.keys(a).sort()).toEqual(['email', 'temporaryPassword', 'userId']);
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    expect(a.email).toBe(emailA);
    expect(a.userId).toBe(await userIdOf(emailA));
    expect(typeof a.temporaryPassword).toBe('string');
    expect(a.temporaryPassword.length).toBeGreaterThan(0);
  }, 60_000);

  it('a failing notice does not fail the creation, and the address reaches no signal', async () => {
    const tenantId = await freshTenantId();
    const email = `failing-${randomUUID()}@example.test`;
    const sender: EmailSender = {
      send: (to) => Promise.reject(new Error(`provider refused ${to}`)),
    };
    const client = clientWith(mailerWith(sender));

    const result = await client.identity.users.create(
      { body: { email, name: 'Failing Notice', role: 'member' } },
      { context: context(tenantId, ['admin']) },
    );

    expect(result.email).toBe(email);
    expect(typeof result.temporaryPassword).toBe('string');
    const userId = await userIdOf(email);
    expect(userId).toBeDefined();
    expect(await membershipCount(userId ?? '')).toBe(1);
    await vi.waitFor(async () => {
      await harness.forceFlush();
      const suppressed = harness.logExporter
        .getFinishedLogRecords()
        .filter((record) => record.eventName === SUPPRESSED);
      expect(suppressed.length).toBeGreaterThanOrEqual(1);
    });
    expect(await everySignal()).not.toContain(email);
  }, 60_000);

  it('a capped notice does not fail the creation: the tenant cap suppresses it and logs the reason without an address', async () => {
    const tenantId = await freshTenantId();
    const email = `capped-${randomUUID()}@example.test`;
    const sender = createRecordingEmailSender();
    const capStore: EmailCapStore = {
      consume: (scope) =>
        scope === 'account_created_tenant'
          ? Promise.reject(new AuthRateLimitedError(3600))
          : Promise.resolve(),
    };
    const client = clientWith(mailerWith(sender, capStore));

    const result = await client.identity.users.create(
      { body: { email, name: 'Capped Notice', role: 'member' } },
      { context: context(tenantId, ['admin']) },
    );

    expect(result.email).toBe(email);
    const userId = await userIdOf(email);
    expect(userId).toBeDefined();
    expect(await membershipCount(userId ?? '')).toBe(1);
    await vi.waitFor(async () => {
      await harness.forceFlush();
      const suppressed = harness.logExporter
        .getFinishedLogRecords()
        .filter((record) => record.eventName === SUPPRESSED);
      expect(suppressed).toHaveLength(1);
      expect(suppressed[0]?.attributes['tayzu.identity.recovery.suppression']).toBe('tenant_cap');
    });
    expect(sender.sent).toHaveLength(0);
    expect(await everySignal()).not.toContain(email);
  }, 60_000);

  it('no notice is sent when the operation fails (a member caller, an existing address)', async () => {
    const tenantId = await freshTenantId();
    const sender = createRecordingEmailSender();
    const client = clientWith(mailerWith(sender));

    // A caller without the admin role is denied before anything runs.
    const deniedEmail = `denied-${randomUUID()}@example.test`;
    const denied: unknown = await client.identity.users
      .create(
        { body: { email: deniedEmail, name: 'Denied', role: 'member' } },
        { context: context(tenantId, ['member']) },
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect((denied as { code?: unknown }).code).toBe('AUTH_FORBIDDEN');

    // A second creation for an address that already has an account is refused.
    const existingEmail = `existing-${randomUUID()}@example.test`;
    await client.identity.users.create(
      { body: { email: existingEmail, name: 'First', role: 'member' } },
      { context: context(tenantId, ['admin']) },
    );
    await vi.waitFor(() => {
      expect(sender.sent).toHaveLength(1);
    });
    const duplicate: unknown = await client.identity.users
      .create(
        { body: { email: existingEmail, name: 'Second', role: 'member' } },
        { context: context(tenantId, ['admin']) },
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(duplicate, 'the duplicate creation must be rejected').toBeDefined();

    // Give a wrongly detached notice time to arrive, then count: only the first creation sent one.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sender.sent.map((message) => message.to)).toEqual([existingEmail]);
  }, 60_000);
});
