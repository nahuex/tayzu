/**
 * Task 7.11 of openspec/changes/043-identity-lifecycle-and-org-admin (spec
 * "Invitation lifecycle"; design "Email form", Resolved decision Q33).
 *
 * Task 7.11 Verify: "`email-boundary.int.test.ts` covers both operations
 * refusing `a+b@example.com` and `a/b@example.com` with nothing created, and a
 * plus-alias therefore not reaching the per-recipient cap."
 *
 * Scenario (verbatim from the spec):
 * - "An address the platform cannot hold is rejected": WHEN an admin invites, or
 *   creates a user for, `a+b@example.com` or `a/b@example.com`, THEN the
 *   operation fails with `CATALOG_VALIDATION_FAILED` and no invitation, user,
 *   email or cap increment results.
 *
 * ## Harness
 *
 * Real Better Auth with `userSync`, real Cerbos container, a real admin session
 * (`bootstrapTestTenant`), the recording `EmailSender` behind the real
 * `createEmailTenantGate` (with `recipientKeySecret`, so the per-recipient cap is
 * live) over a counting `EmailCapStore`, and one fresh organization per test.
 *
 * ## Production symbols expected
 *
 * None new: `identity.users.invite` and `identity.users.create` of
 * `createIdentityRouter` (`./identity-router.js`) must call `canonicalEmail` and
 * `isValidIdentityEmail` (`./identity/email-canonical.js`) on the input email
 * and throw a `CATALOG_VALIDATION_FAILED` error before Better Auth, the email
 * gate or any cap is touched.
 *
 * ## Why this fails right now
 *
 * Both operations pass the address straight through, so they succeed (or fail
 * with another error) and create an invitation / a user.
 */
// Load-bearing import order (design D1): the telemetry harness registers
// before anything that loads `@tayzu/auth` creates its logger.
import { registration } from './__fixtures__/link-telemetry.js';
import { randomInt, randomUUID } from 'node:crypto';

import { createRouterClient } from '@orpc/server';
import { authSchema, createAuth, createRecordingEmailSender, type AuthInstance } from '@tayzu/auth';
import { createCerbosClient, type CerbosClient } from '@tayzu/authz';
import { createUserSync } from '@tayzu/catalog';
import { runMigrations } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { bootstrapTestTenant } from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createAuthRepository } from './identity/auth-repository.js';
import { createEmailTenantGate, type EmailCapStore } from './identity/email-tenant-gate.js';
import { createInMemoryEmailCapStore } from './identity/invitation-caps.js';
import { createUserSyncAdapter } from './identity/user-sync-adapter.js';
import { createIdentityRouter } from './identity-router.js';

const LINK_BASE_URL = 'https://app.tayzu.test';
const RECIPIENT_KEY_SECRET = 'email-boundary-recipient-key-secret';
const UNHOLDABLE = ['a+b@example.com', 'a/b@example.com'] as const;

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

describe('email boundary (task 7.11, Resolved decision Q33)', () => {
  let authPool: Pool;
  let auth: AuthInstance;
  let cerbos: CerbosClient;
  let userSync: ReturnType<typeof createUserSync>;
  let sender: ReturnType<typeof createRecordingEmailSender>;
  let capCalls: { scope: string; key: string }[];
  let client: ReturnType<
    typeof createRouterClient<ReturnType<typeof createIdentityRouter>, Record<string, unknown>>
  >;

  beforeAll(async () => {
    if ('error' in registration) {
      throw new Error(`createTelemetryTestHarness() failed: ${String(registration.error)}`, {
        cause: registration.error,
      });
    }
    const pools = await harnessPools();
    authPool = pools.authPool;
    await runMigrations(authPool);
    cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    userSync = createUserSync({ pool: pools.appPool, authz: cerbos });
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync: createUserSyncAdapter({ userSync }),
    });
    sender = createRecordingEmailSender();
    capCalls = [];
    const inner = createInMemoryEmailCapStore({
      tenant: { max: 1000, windowSeconds: 3600 },
      recipient: { max: 1000, windowSeconds: 86_400 },
    });
    const capStore: EmailCapStore = {
      consume(scope, key) {
        capCalls.push({ scope, key });
        return inner.consume(scope, key);
      },
    };
    client = createRouterClient(
      createIdentityRouter({
        auth,
        authz: cerbos,
        authRepository: createAuthRepository(authPool),
        emailGate: createEmailTenantGate({
          disabledTenantIds: [],
          capStore,
          sender,
          recipientKeySecret: RECIPIENT_KEY_SECRET,
        }),
        invitationLinkBaseUrl: LINK_BASE_URL,
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );
  }, 60_000);

  async function freshTenant(): Promise<{ tenantId: string; adminId: string; cookie: string }> {
    const id = randomUUID();
    const t = await bootstrapTestTenant(auth, {
      name: 'Boundary Admin',
      email: `boundary-admin-${id}@example.test`,
      password: TEST_PASSWORD,
      organizationName: 'Boundary Org',
      organizationSlug: `boundary-${id}`,
      ip: randomIp(),
    });
    return { tenantId: t.organizationId, adminId: t.userId, cookie: t.cookie };
  }

  function sessionContext(tenant: {
    tenantId: string;
    adminId: string;
    cookie: string;
  }): Record<string, unknown> {
    const headers = new Headers({ cookie: tenant.cookie, 'x-forwarded-for': randomIp() });
    return {
      tenantId: tenant.tenantId,
      actor: { type: 'user', id: tenant.adminId },
      principal: { roles: ['admin'] },
      __requestHeaders: headers,
      __stepUpHeaders: headers,
    };
  }

  async function count(sql: string, params: readonly unknown[]): Promise<number> {
    const result = await authPool.query<{ n: string }>(sql, [...params]);
    return Number(result.rows[0]?.n ?? '0');
  }

  /** Everything the two operations could create or consume for `email` in `tenantId`. */
  async function footprint(tenantId: string, email: string) {
    return {
      invitations: await count(
        `select count(*) as n from auth.invitation where organization_id = $1 and email = $2`,
        [tenantId, email],
      ),
      users: await count(`select count(*) as n from auth."user" where email = $1`, [email]),
      members: await count(
        `select count(*) as n from auth.member m join auth."user" u on u.id = m.user_id
         where m.organization_id = $1 and u.email = $2`,
        [tenantId, email],
      ),
      userEntity: await userSync.getUser({ tenantId, email }),
      emails: sender.sent.filter((message) => message.to === email).length,
    };
  }

  async function codeOf(call: Promise<unknown>): Promise<unknown> {
    const thrown: unknown = await call.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown, 'the call must be rejected').toBeDefined();
    return (thrown as { code?: unknown }).code;
  }

  it.each(UNHOLDABLE)(
    'An address the platform cannot hold is rejected: identity.users.invite refuses %s with CATALOG_VALIDATION_FAILED and nothing is created, sent or counted',
    async (email) => {
      const tenant = await freshTenant();
      const capsBefore = capCalls.length;
      const sentBefore = sender.sent.length;

      // WHEN an admin invites the address.
      const code = await codeOf(
        client.identity.users.invite(
          { email, role: 'member' },
          { context: sessionContext(tenant) },
        ),
      );

      // THEN it fails with CATALOG_VALIDATION_FAILED...
      expect(code).toBe('CATALOG_VALIDATION_FAILED');
      // ...and no invitation, user, email or cap increment results.
      expect(await footprint(tenant.tenantId, email)).toEqual({
        invitations: 0,
        users: 0,
        members: 0,
        userEntity: null,
        emails: 0,
      });
      expect(sender.sent.length).toBe(sentBefore);
      expect(capCalls.length, 'no cap was consumed').toBe(capsBefore);
    },
    60_000,
  );

  it.each(UNHOLDABLE)(
    'An address the platform cannot hold is rejected: identity.users.create refuses %s with CATALOG_VALIDATION_FAILED and nothing is created, sent or counted',
    async (email) => {
      const tenant = await freshTenant();
      const capsBefore = capCalls.length;
      const sentBefore = sender.sent.length;

      // WHEN an admin creates a user for the address.
      const code = await codeOf(
        client.identity.users.create(
          { email, name: 'Boundary User', role: 'member' },
          { context: sessionContext(tenant) },
        ),
      );

      // THEN it fails with CATALOG_VALIDATION_FAILED...
      expect(code).toBe('CATALOG_VALIDATION_FAILED');
      // ...and no invitation, user, email or cap increment results.
      expect(await footprint(tenant.tenantId, email)).toEqual({
        invitations: 0,
        users: 0,
        members: 0,
        userEntity: null,
        emails: 0,
      });
      expect(sender.sent.length).toBe(sentBefore);
      expect(capCalls.length, 'no cap was consumed').toBe(capsBefore);
    },
    60_000,
  );

  it('A plus-alias never reaches the per-recipient cap: the refused alias consumes nothing, while its plain address consumes the recipient bucket', async () => {
    const tenant = await freshTenant();
    const local = `plain-${randomUUID()}`;
    const alias = `${local}+alias@example.test`;
    const plain = `${local}@example.test`;
    const capsBefore = capCalls.length;

    // WHEN an admin invites the plus-alias of a plain address.
    const code = await codeOf(
      client.identity.users.invite(
        { email: alias, role: 'member' },
        { context: sessionContext(tenant) },
      ),
    );

    // THEN it is refused and no cap bucket (tenant or recipient) was touched.
    expect(code).toBe('CATALOG_VALIDATION_FAILED');
    expect(capCalls.length).toBe(capsBefore);
    // ...and it was refused before anything was created, not after.
    expect((await footprint(tenant.tenantId, alias)).invitations).toBe(0);

    // CONTROL: the plain address is accepted and does reach the recipient cap, so the
    // zero above is the validation's doing, not an unwired cap.
    await client.identity.users.invite(
      { email: plain, role: 'member' },
      { context: sessionContext(tenant) },
    );
    const consumed = capCalls.slice(capsBefore);
    expect(consumed.map((call) => call.scope).sort()).toEqual(['recipient', 'tenant']);
  }, 60_000);
});
