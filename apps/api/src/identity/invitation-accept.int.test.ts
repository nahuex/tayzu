/**
 * Task 8.2 of openspec/changes/043-identity-lifecycle-and-org-admin (spec
 * "Invitation acceptance"; design D4 steps 1 to 5 and the Observability
 * contract; Resolved decisions Q112 and Q116).
 *
 * Scenarios (from the spec, "Invitation acceptance"):
 * - "A new person accepts and can then sign in": the account has a verified
 *   email, a membership with the invited role and status `Active`, no session
 *   exists, and the invitee then signs in through the normal route, also with
 *   the password in its NFD form (8.1d). The `accepted` invitation status and
 *   the single use of the token are 8.3's.
 * - "A failed `_user` write undoes the acceptance": with a `userSync` that
 *   throws, no user, no member, the `_user` still `Invited`, the token still
 *   verifies, the sanitized `INTERNAL` answer, and a retry with the same token
 *   succeeds.
 * - A successful acceptance emits `catalog.audit.invitation_accepted` with
 *   `tayzu.actor.type` `user` and `tayzu.actor.id` the new user's Better Auth
 *   user id, the same value as `tayzu.identity.user.id` (Q116).
 *
 * ## Production symbols expected
 *
 * `apps/api/src/identity/accept-flow.ts` (exists since 8.1e): `createAcceptFlow`
 * whose `accept({ invitationId, token, password })` emits, once the new-account
 * acceptance has committed, `catalog.audit.invitation_accepted` through
 * `emitIdentityEvent` with `tayzu.tenant.id`, `tayzu.identity.invitation.id`,
 * `tayzu.actor.type` `user`, `tayzu.actor.id` and `tayzu.identity.user.id` (both
 * the new user's id). It emits nothing for a failed attempt.
 */
// Load-bearing import order (design D1): the telemetry harness registers
// before anything that loads `@tayzu/auth` creates its logger.
import { registration, type TelemetryTestHarness } from '../__fixtures__/link-telemetry.js';
import { randomInt, randomUUID } from 'node:crypto';

import { authSchema, createAuth, type AuthInstance } from '@tayzu/auth';
import { createCerbosClient } from '@tayzu/authz';
import { createUserSync, type UserSync } from '@tayzu/catalog';
import { runMigrations } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { bootstrapTestTenant } from '../../../../packages/auth/src/__fixtures__/admin-user.js';
import {
  TEST_PASSWORD,
  TEST_SECRET,
} from '../../../../packages/auth/src/__fixtures__/test-secret.js';
import {
  digestInvitationToken,
  generateInvitationToken,
  verifyInvitationToken,
} from '../../../../packages/auth/src/identity/invitation-token.js';
import { harnessPools } from '../__fixtures__/pools.js';
import { toOrpcError } from '../error-mapping.js';
import { createAcceptFlow } from './accept-flow.js';
import { createAuthRepository } from './auth-repository.js';
import { runWithIdentityContext } from './identity-context.js';
import { createUserSyncAdapter } from './user-sync-adapter.js';

const ACCEPTED_EVENT = 'catalog.audit.invitation_accepted';
const AUTH_BASE_URL = 'http://localhost:3000/api/auth';

/** Compliant, NFC (precomposed é, ñ, ä), so that its NFD form differs. */
const PASSWORD_NFC = 'Café-Mañana-Passäphrase-2026!';
const PASSWORD_NFD = PASSWORD_NFC.normalize('NFD');

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

interface Tenant {
  readonly tenantId: string;
  readonly adminId: string;
  readonly cookie: string;
}

interface Invitation {
  readonly invitationId: string;
  readonly token: string;
}

interface InviteApiSurface {
  createInvitation(args: {
    body: { email: string; role: 'member' | 'admin'; organizationId: string };
    headers: Headers;
  }): Promise<{ id: string; expiresAt: Date | string }>;
}

describe('A new person accepts an invitation (task 8.2, design D4, Resolved decisions Q112 and Q116)', () => {
  let harness: TelemetryTestHarness;
  let authPool: Pool;
  let auth: AuthInstance;
  let catalogSync: UserSync;
  let acceptFlow: ReturnType<typeof createAcceptFlow>;
  const failingUserWrites = new Set<string>();

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
    const cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    const base = createUserSync({ pool: pools.appPool, authz: cerbos });
    catalogSync = {
      getUser: (input) => base.getUser(input),
      upsertUser: async (input) => {
        if (failingUserWrites.has(input.tenantId)) throw new Error('user sync unavailable');
        await base.upsertUser(input);
      },
    };
    const adapter = createUserSyncAdapter({ userSync: catalogSync });
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync: adapter,
    });
    acceptFlow = createAcceptFlow({
      auth,
      authRepository: createAuthRepository(authPool),
      authPool,
      userSync: adapter,
    });
  }, 60_000);

  async function freshTenant(): Promise<Tenant> {
    const id = randomUUID();
    const t = await bootstrapTestTenant(auth, {
      name: 'Accept Admin',
      email: `accept-admin-${id}@example.test`,
      password: TEST_PASSWORD,
      organizationName: 'Accept Org',
      organizationSlug: `accept-${id}`,
      ip: randomIp(),
    });
    return { tenantId: t.organizationId, adminId: t.userId, cookie: t.cookie };
  }

  /** What `identity.users.invite` leaves: the invitation (its hook writes the `Invited` `_user`) and the token digest. */
  async function invite(
    tenant: Tenant,
    email: string,
    role: 'member' | 'admin' = 'member',
  ): Promise<Invitation> {
    const api = auth.api as InviteApiSurface;
    const invitation = await runWithIdentityContext({ adminId: tenant.adminId }, () =>
      api.createInvitation({
        body: { email, role, organizationId: tenant.tenantId },
        headers: new Headers({ cookie: tenant.cookie, 'x-forwarded-for': randomIp() }),
      }),
    );
    const token = generateInvitationToken();
    await authPool.query(
      `insert into auth.verification (id, identifier, value, expires_at)
       values ($1, $2, $3, $4)`,
      [
        randomUUID(),
        `invitation-accept:${invitation.id}`,
        digestInvitationToken(token),
        new Date(invitation.expiresAt),
      ],
    );
    return { invitationId: invitation.id, token };
  }

  async function tokenRows(invitationId: string): Promise<readonly string[]> {
    const result = await authPool.query<{ value: string }>(
      `select value from auth.verification where identifier = $1`,
      [`invitation-accept:${invitationId}`],
    );
    return result.rows.map((row) => row.value);
  }

  async function tokenStillVerifies(invitation: Invitation): Promise<boolean> {
    const rows = await tokenRows(invitation.invitationId);
    return rows.length === 1 && verifyInvitationToken(invitation.token, rows[0] ?? null);
  }

  async function userByEmail(
    email: string,
  ): Promise<{ id: string; emailVerified: boolean; role: string | null } | undefined> {
    const result = await authPool.query<{
      id: string;
      email_verified: boolean;
      role: string | null;
    }>(`select id, email_verified, role from auth."user" where email = $1`, [email]);
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : { id: row.id, emailVerified: row.email_verified, role: row.role };
  }

  async function members(
    tenantId: string,
    userId: string,
  ): Promise<readonly { id: string; role: string }[]> {
    const result = await authPool.query<{ id: string; role: string }>(
      `select id, role from auth.member where organization_id = $1 and user_id = $2`,
      [tenantId, userId],
    );
    return result.rows;
  }

  async function sessionCount(userId: string): Promise<number> {
    const result = await authPool.query(`select 1 from auth.session where user_id = $1`, [userId]);
    return result.rowCount ?? 0;
  }

  async function userStatus(tenantId: string, email: string): Promise<string | undefined> {
    return (await catalogSync.getUser({ tenantId, email }))?.status;
  }

  async function signIn(email: string, password: string): Promise<Response> {
    return (auth as unknown as { handler: (r: Request) => Promise<Response> }).handler(
      new Request(`${AUTH_BASE_URL}/sign-in/email`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': randomIp(),
          origin: 'http://localhost:3000',
        },
        body: JSON.stringify({ email, password }),
      }),
    );
  }

  async function acceptedEvents(invitationId: string) {
    await harness.forceFlush();
    return [...harness.logExporter.getFinishedLogRecords()].filter(
      (record) =>
        record.eventName === ACCEPTED_EVENT &&
        record.attributes['tayzu.identity.invitation.id'] === invitationId,
    );
  }

  it('A new person accepts and can then sign in: verified email, global role user, membership with the invited role, Active _user and no session', async () => {
    const tenant = await freshTenant();
    const email = `bob-${randomUUID()}@example.test`;
    const invitation = await invite(tenant, email, 'admin');

    // GIVEN a pending invitation to a person with no account.
    expect(await userByEmail(email)).toBeUndefined();

    // WHEN they present the invitation id, the token and a policy-compliant password.
    const { userId } = await acceptFlow.accept({ ...invitation, password: PASSWORD_NFC });

    // THEN they have an account with a verified email and the global role `user`...
    const user = await userByEmail(email);
    expect(user?.id).toBe(userId);
    expect(user?.emailVerified).toBe(true);
    expect(user?.role).toBe('user');
    // ...a membership with the invited role and the status `Active`...
    const memberships = await members(tenant.tenantId, userId);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.role).toBe('admin');
    expect(await userStatus(tenant.tenantId, email)).toBe('Active');
    // ...and no session exists.
    expect(await sessionCount(userId), 'the acceptance creates no session').toBe(0);
  }, 60_000);

  it('A new person accepts and can then sign in: sign-in through the normal route succeeds afterward, also with the password in its NFD form', async () => {
    const tenant = await freshTenant();
    const email = `bob-${randomUUID()}@example.test`;
    const invitation = await invite(tenant, email);
    const { userId } = await acceptFlow.accept({ ...invitation, password: PASSWORD_NFC });
    expect(PASSWORD_NFD).not.toBe(PASSWORD_NFC);

    const nfc = await signIn(email, PASSWORD_NFC);
    const nfd = await signIn(email, PASSWORD_NFD);

    expect(nfc.status, 'sign-in with the password as supplied').toBe(200);
    expect(nfd.status, 'sign-in with the NFD form of the password').toBe(200);
    expect(await sessionCount(userId), 'only the sign-ins created sessions').toBe(2);
  }, 60_000);

  it('A failed `_user` write undoes the acceptance: no user, no member, the _user still Invited, the token still verifies, the sanitized INTERNAL answer, and a retry with the same token succeeds', async () => {
    const tenant = await freshTenant();
    const email = `bob-${randomUUID()}@example.test`;
    const invitation = await invite(tenant, email);

    // GIVEN a `_user` write that fails.
    failingUserWrites.add(tenant.tenantId);
    let failure: { code: string } | undefined;
    try {
      await acceptFlow.accept({ ...invitation, password: PASSWORD_NFC });
    } catch (error) {
      failure = toOrpcError(error);
    }

    // THEN the answer is the sanitized generic server error...
    expect(failure?.code).toBe('INTERNAL');
    // ...no user and no membership exist, the `_user` keeps `Invited`, and the token still verifies...
    expect(await userByEmail(email), 'no user').toBeUndefined();
    const count = await authPool.query(`select 1 from auth.member where organization_id = $1`, [
      tenant.tenantId,
    ]);
    expect(count.rowCount, 'only the inviting admin is a member').toBe(1);
    expect(await userStatus(tenant.tenantId, email)).toBe('Invited');
    expect(await tokenStillVerifies(invitation)).toBe(true);
    expect(
      await acceptedEvents(invitation.invitationId),
      'a failed attempt is no audit event',
    ).toHaveLength(0);

    // AND a retry with the same token succeeds.
    failingUserWrites.delete(tenant.tenantId);
    const result = await acceptFlow.accept({ ...invitation, password: PASSWORD_NFC });
    expect((await userByEmail(email))?.id).toBe(result.userId);
    expect(await members(tenant.tenantId, result.userId)).toHaveLength(1);
    expect(await userStatus(tenant.tenantId, email)).toBe('Active');
  }, 60_000);

  it('A successful acceptance emits catalog.audit.invitation_accepted with tayzu.actor.type user and tayzu.actor.id the new user id, the same value as tayzu.identity.user.id (Q116)', async () => {
    const tenant = await freshTenant();
    const email = `bob-${randomUUID()}@example.test`;
    const invitation = await invite(tenant, email);

    const { userId } = await acceptFlow.accept({ ...invitation, password: PASSWORD_NFC });

    const logged = await acceptedEvents(invitation.invitationId);
    expect(logged, 'one audit event').toHaveLength(1);
    const attributes = logged[0]?.attributes;
    expect(attributes?.['tayzu.actor.type']).toBe('user');
    expect(attributes?.['tayzu.actor.id']).toBe(userId);
    expect(attributes?.['tayzu.identity.user.id']).toBe(userId);
    expect(attributes?.['tayzu.tenant.id']).toBe(tenant.tenantId);
  }, 60_000);
});
