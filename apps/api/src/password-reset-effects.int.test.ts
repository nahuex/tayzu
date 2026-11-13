/**
 * Task 8.9 of openspec/changes/044-password-reset-and-account-recovery (design D7 "The completed
 * reset: policy, hash, one transaction", D6 "What enrolled means", D2 "Answers").
 *
 * The completion transaction on the lock's connection, for a user whose factor is a TOTP code or
 * who has none. Scenarios of `specs/password-reset-and-account-recovery/spec.md`, quoted:
 *
 * - "A valid TOTP code completes the reset": GIVEN a user with TOTP enrolled and a valid token;
 *   WHEN the same request carries the current TOTP code; THEN the reset completes and the token is
 *   consumed.
 * - "A user without a second factor needs only the link": GIVEN a user with no enrolled factor;
 *   WHEN a valid token and a compliant password are submitted; THEN the reset completes.
 * - "A reset keeps the second factor": WHEN an enrolled user completes a reset; THEN the next
 *   sign-in with the new password still requires the second factor.
 * - "Every session in every tenant ends": GIVEN a user with live sessions in two tenants; WHEN a
 *   reset completes; THEN both sessions are rejected, and one `auth.security.session_revoked` event
 *   with the reason `password_reset` is logged per session (the tenant omitted when the session has
 *   none, D7 step 12).
 * - "The new password signs in": WHEN a reset completes with a compliant password; THEN a sign-in
 *   with the new password succeeds (with the second factor, if enrolled) and a sign-in with the old
 *   password fails.
 * - "A reset does not sign the user in": WHEN a reset completes; THEN the response sets no cookie
 *   and creates no session.
 * - "A reset never revives a banned or disabled user": GIVEN an eligible user who is then banned
 *   before the link is used; WHEN the link is submitted to the confirm route; THEN the answer is the
 *   uniform rejection, the password is unchanged, and `banned` is still true. (A completed reset
 *   MUST NOT change the status of any `_user`: a user `Disabled` in one tenant and `Active` in
 *   another resets, and the `Disabled` row stays `Disabled`.)
 * - "A reset is the way out of an expired temporary password": GIVEN a user whose 48-hour temporary
 *   password expired; WHEN they complete a reset; THEN the temporary-password marker is gone and
 *   they sign in with the new password and reach the platform without a forced change.
 * - "A weak password is refused and the token survives" (second half): the same token completes a
 *   reset with a compliant password.
 * - Case "an unverified row with the flag off is not enrolled and the link alone completes".
 *
 * ## Harness
 *
 * The real server (`createApp`, injected requests, never a listener) with the identity routes
 * mounted. Accounts are real (`bootstrapTestTenant`, `createAdminUser`, Better Auth's own TOTP
 * enrolment through `enrollTotp`), tokens come from the real `createResetTokenStore`. Every request
 * carries a fresh random `x-forwarded-for`, `Origin` and `x-csrf-token: orpc`. The breached-password
 * range service is a stubbed global `fetch` that reports nothing as breached. Every seeded value is
 * random per run. The telemetry harness registers before anything that loads `@tayzu/auth`
 * (design D1), and events are read by the `tayzu.actor.id` of each test's own random user.
 *
 * ## Production symbols expected
 *
 * `createPasswordResetConfirmFlow` (`./identity/password-reset-confirm.js`) runs, in the lock's
 * transaction after the factor check, the completion of D7 steps 4-12 through the completion section
 * of `./identity/auth-repository.js` (task 8.8): hash, consume, credential update, other-token
 * delete, marker/challenge/trust delete, `emailVerified`, backup-code spend, counter reset, session
 * delete with `returning`. After the commit it emits `auth.security.session_revoked` (reason
 * `password_reset`, `tayzu.tenant.id` only when the session had a tenant) once per deleted session
 * and the route answers `200 { "completed": true }` with no cookie.
 */
// Load-bearing import order (design D1): the telemetry harness registers before
// anything that loads `@tayzu/auth` creates its logger.
import {
  linkLogEvents,
  registration,
  type TelemetryTestHarness,
} from './__fixtures__/link-telemetry.js';
import { createHash, randomInt, randomUUID } from 'node:crypto';

import { createRecordingEmailSender } from '@tayzu/auth';
import { withTenantTransaction } from '@tayzu/db';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bootstrapTestTenant,
  createAdminUser,
  seedUserRow,
  signInAdminUser,
  testAppPool,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { enrollTotp, signInWithTotp } from './__fixtures__/fresh-mfa.js';
import { harnessPools } from './__fixtures__/pools.js';
import { renderPasswordChangedNotice } from '../../../packages/auth/src/identity/email/recovery-notice-templates.js';
import { createMachineCredential } from '../../../packages/auth/src/machine-credentials.js';
import { createResetTokenStore } from './identity/reset-token-store.js';
import { createWithUserLock } from './identity/user-lock.js';
import { createApp, type App } from './server.js';

const ORIGIN = 'https://app.tayzu.test';
const LINK_BASE_URL = 'https://app.tayzu.test';
const AUTH_BASE_URL = 'http://localhost:3000/api/auth';
const CONFIRM_PATH = '/v1/auth/password-reset/confirm';
const HMAC_SECRET = 'reset-effects-test-only-secret-0123456789-abcdef';
const NEW_PASSWORD = 'Another-Perfectly-Fine-Passphrase-77!';
const REVOKED_EVENT = 'auth.security.session_revoked';

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

interface Answer {
  readonly status: number;
  readonly body: unknown;
  readonly setCookie: unknown;
  readonly cacheControl: unknown;
  readonly pragma: unknown;
}

interface CreateOrganizationSurface {
  createOrganization(args: {
    body: { name: string; slug: string; userId: string };
  }): Promise<{ id: string }>;
}

type Handler = (request: Request) => Promise<Response>;

describe('The completion transaction of a password reset (task 8.9)', () => {
  let harness: TelemetryTestHarness;
  let app: App;
  let authPool: Pool;
  const sender = createRecordingEmailSender();

  beforeAll(async () => {
    if ('error' in registration) {
      throw new Error(`createTelemetryTestHarness() failed: ${String(registration.error)}`, {
        cause: registration.error,
      });
    }
    harness = registration.harness;
    const pools = await harnessPools();
    authPool = pools.authPool;
    const email = {
      sender,
      invitationLinkBaseUrl: LINK_BASE_URL,
      passwordResetLinkBaseUrl: LINK_BASE_URL,
      passwordResetMinResponseMs: 0,
      disabledTenantIds: [] as string[],
      killSwitch: false,
      recipientKeySecret: HMAC_SECRET,
      tenantCap: { max: 1000, windowSeconds: 3600 },
      recipientCap: { max: 1000, windowSeconds: 86_400 },
      passwordResetRecipientCap: { max: 1000, windowSeconds: 3600 },
      passwordResetIpCap: { max: 1000, windowSeconds: 3600 },
      passwordResetGlobalCap: { max: 100_000, windowSeconds: 3600 },
      accountCreatedNoticeGlobalCap: { max: 100_000, windowSeconds: 86_400 },
    };
    app = await createApp({
      appPool: pools.appPool,
      authPool: pools.authPool,
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ORIGIN],
      mountIdentityRoutes: true,
      identityTokenHmacSecret: HMAC_SECRET,
      ...{ email },
    });
  }, 60_000);

  beforeEach(() => {
    // The range service reports nothing as breached.
    vi.stubGlobal('fetch', (): Promise<Response> => {
      return Promise.resolve(
        new Response('0000000000000000000000000000000000A:3\r\n', { status: 200 }),
      );
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await app.close();
  }, 60_000);

  function handler(): Handler {
    return (app.auth as unknown as { handler: Handler }).handler;
  }

  function store() {
    return createResetTokenStore({ authPool, withUserLock: createWithUserLock(authPool) });
  }

  interface Person {
    readonly email: string;
    readonly userId: string;
    readonly cookie: string;
    readonly token: string;
    readonly organizationId: string;
  }

  /** A password user, admin of one Active tenant, with one live session. */
  async function createPerson(): Promise<Person> {
    const suffix = randomUUID();
    const email = `effects-${suffix}@example.test`;
    const tenant = await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: 'Effects User',
      email,
      password: TEST_PASSWORD,
      organizationName: `Effects Org ${suffix}`,
      organizationSlug: `effects-${suffix}`,
      ip: randomIp(),
    });
    return {
      email,
      userId: tenant.userId,
      cookie: tenant.cookie,
      token: tenant.token,
      organizationId: tenant.organizationId,
    };
  }

  /** A user with TOTP enrolled through Better Auth itself; `secret` yields real codes. */
  async function createEnrolled(): Promise<Person & { secret: string }> {
    const person = await createPerson();
    const secret = await enrollTotp(app, {
      password: TEST_PASSWORD,
      enrollmentCookie: person.cookie,
    });
    return { ...person, secret };
  }

  async function currentCode(secret: string): Promise<string> {
    const api = app.auth.api as {
      generateTOTP(args: { body: { secret: string } }): Promise<{ code: string }>;
    };
    return (await api.generateTOTP({ body: { secret } })).code;
  }

  async function post(fields: Record<string, unknown>): Promise<Answer> {
    const response = await app.app.inject({
      method: 'POST',
      url: CONFIRM_PATH,
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        'x-csrf-token': 'orpc',
        'x-forwarded-for': randomIp(),
      },
      payload: JSON.stringify({ newPassword: NEW_PASSWORD, ...fields }),
    });
    let body: unknown;
    try {
      body = response.json();
    } catch {
      body = response.body;
    }
    return {
      status: response.statusCode,
      body,
      setCookie: response.headers['set-cookie'],
      cacheControl: response.headers['cache-control'],
      pragma: response.headers['pragma'],
    };
  }

  function expectCompleted(answer: Answer): void {
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ completed: true });
    expect(String(answer.cacheControl)).toContain('no-store');
    expect(answer.pragma).toBe('no-cache');
  }

  function expectUniformRejection(answer: Answer): void {
    expect(answer.status).toBe(404);
    expect(answer.body).toMatchObject({ code: 'CATALOG_NOT_FOUND' });
  }

  async function passwordHash(userId: string): Promise<string> {
    const result = await authPool.query<{ password: string | null }>(
      `select password from auth.account where user_id = $1 and provider_id = 'credential'`,
      [userId],
    );
    return result.rows[0]?.password ?? '';
  }

  async function tokenRows(id: string): Promise<number> {
    const result = await authPool.query('select 1 from auth.verification where identifier = $1', [
      `password-reset:${id}`,
    ]);
    return result.rowCount ?? 0;
  }

  async function sessionCount(userId: string): Promise<number> {
    const result = await authPool.query<{ n: string }>(
      'select count(*)::text as n from auth.session where user_id = $1',
      [userId],
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  async function sessionAlive(cookie: string): Promise<boolean> {
    const response = await handler()(
      new Request(`${AUTH_BASE_URL}/get-session`, {
        method: 'GET',
        headers: { cookie, 'x-forwarded-for': randomIp() },
      }),
    );
    if (response.status !== 200) return false;
    const body = (await response.json().catch(() => null)) as {
      session?: { id?: string };
    } | null;
    return body?.session?.id !== undefined;
  }

  async function v1Status(cookie: string): Promise<number> {
    const response = await app.app.inject({
      method: 'GET',
      url: '/v1/blueprints',
      headers: { cookie },
    });
    return response.statusCode;
  }

  async function signInRaw(
    email: string,
    password: string,
  ): Promise<{ status: number; body: unknown }> {
    const response = await handler()(
      new Request(`${AUTH_BASE_URL}/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': randomIp() },
        body: JSON.stringify({ email, password }),
      }),
    );
    const body: unknown = await response.json().catch(() => null);
    return { status: response.status, body };
  }

  async function seedTwoFactor(userId: string, verified: boolean): Promise<string> {
    const id = `tf-${randomUUID()}`;
    await authPool.query(
      `insert into auth.two_factor (id, secret, backup_codes, user_id, verified, failed_verification_count)
       values ($1, $2, $3, $4, $5, 0)`,
      [id, `enc-secret-${id}`, `enc-codes-${id}`, userId, verified],
    );
    return id;
  }

  describe('A valid TOTP code completes the reset', () => {
    it('with the current TOTP code the reset completes, the token is consumed and the password is the new one', async () => {
      const user = await createEnrolled();
      const issued = await store().issue(user.userId);
      const hashBefore = await passwordHash(user.userId);
      expect(await tokenRows(issued.id), 'precondition: the token row exists').toBe(1);

      const answer = await post({
        id: issued.id,
        token: issued.token,
        factor: { kind: 'totp', code: await currentCode(user.secret) },
      });

      expectCompleted(answer);
      expect(await tokenRows(issued.id), 'the token is consumed').toBe(0);
      expect(await store().lookup(issued.id, issued.token)).toMatchObject({ status: 'not_found' });
      expect(await passwordHash(user.userId), 'the password changed').not.toBe(hashBefore);
    }, 60_000);
  });

  describe('A user without a second factor needs only the link', () => {
    it('a valid token and a compliant password complete the reset', async () => {
      const person = await createPerson();
      const issued = await store().issue(person.userId);
      const hashBefore = await passwordHash(person.userId);

      const answer = await post({ id: issued.id, token: issued.token });

      expectCompleted(answer);
      expect(await tokenRows(issued.id), 'the token is consumed').toBe(0);
      expect(await passwordHash(person.userId)).not.toBe(hashBefore);
    }, 60_000);

    it('an unverified row with the flag off is not enrolled and the link alone completes', async () => {
      const person = await createPerson();
      await seedTwoFactor(person.userId, false);
      await authPool.query('update auth."user" set two_factor_enabled = false where id = $1', [
        person.userId,
      ]);
      const issued = await store().issue(person.userId);
      const hashBefore = await passwordHash(person.userId);

      const answer = await post({ id: issued.id, token: issued.token });

      expectCompleted(answer);
      expect(await tokenRows(issued.id)).toBe(0);
      expect(await passwordHash(person.userId)).not.toBe(hashBefore);
    }, 60_000);
  });

  describe('A reset keeps the second factor', () => {
    it('the enrolment is untouched and the next sign-in with the new password still requires the second factor', async () => {
      const user = await createEnrolled();
      const rowsBefore = await authPool.query<{ id: string; secret: string; verified: boolean }>(
        'select id, secret, verified from auth.two_factor where user_id = $1 order by id',
        [user.userId],
      );
      expect(rowsBefore.rowCount, 'precondition: one enrolled row').toBe(1);
      const issued = await store().issue(user.userId);

      expectCompleted(
        await post({
          id: issued.id,
          token: issued.token,
          factor: { kind: 'totp', code: await currentCode(user.secret) },
        }),
      );

      const rowsAfter = await authPool.query<{ id: string; secret: string; verified: boolean }>(
        'select id, secret, verified from auth.two_factor where user_id = $1 order by id',
        [user.userId],
      );
      expect(rowsAfter.rows, 'the factor row is unchanged').toEqual(rowsBefore.rows);
      const flag = await authPool.query<{ enabled: boolean | null }>(
        'select two_factor_enabled as enabled from auth."user" where id = $1',
        [user.userId],
      );
      expect(flag.rows[0]?.enabled, 'the flag is still on').toBe(true);

      const signIn = await signInRaw(user.email, NEW_PASSWORD);
      expect(signIn.status).toBe(200);
      expect(signIn.body).toMatchObject({ twoFactorRedirect: true });
      expect(await sessionCount(user.userId), 'the password step alone creates no session').toBe(0);
    }, 60_000);
  });

  describe('Every session in every tenant ends', () => {
    it('sessions in two tenants and one without a tenant are all rejected, with one session_revoked event of reason password_reset each (tenant omitted when none)', async () => {
      const person = await createPerson();
      const suffix = randomUUID();
      const second = await (app.auth.api as CreateOrganizationSurface).createOrganization({
        body: {
          name: `Effects Second ${suffix}`,
          slug: `effects-second-${suffix}`,
          userId: person.userId,
        },
      });
      const sessionTwo = await signInAdminUser(app.auth, {
        email: person.email,
        password: TEST_PASSWORD,
        ip: randomIp(),
      });
      const sessionThree = await signInAdminUser(app.auth, {
        email: person.email,
        password: TEST_PASSWORD,
        ip: randomIp(),
      });
      await authPool.query('update auth.session set active_organization_id = $2 where token = $1', [
        person.token,
        person.organizationId,
      ]);
      await authPool.query('update auth.session set active_organization_id = $2 where token = $1', [
        sessionTwo.token,
        second.id,
      ]);
      await authPool.query(
        'update auth.session set active_organization_id = null where token = $1',
        [sessionThree.token],
      );
      expect(await sessionCount(person.userId), 'precondition: three live sessions').toBe(3);
      expect(await sessionAlive(person.cookie), 'precondition: tenant one session').toBe(true);
      expect(await sessionAlive(sessionTwo.cookie), 'precondition: tenant two session').toBe(true);
      expect(await sessionAlive(sessionThree.cookie), 'precondition: no-tenant session').toBe(true);
      const issued = await store().issue(person.userId);

      expectCompleted(await post({ id: issued.id, token: issued.token }));

      expect(await sessionCount(person.userId)).toBe(0);
      expect(await sessionAlive(person.cookie)).toBe(false);
      expect(await sessionAlive(sessionTwo.cookie)).toBe(false);
      expect(await sessionAlive(sessionThree.cookie)).toBe(false);

      const events = (await linkLogEvents(harness, REVOKED_EVENT)).filter(
        (record) => record.attributes['tayzu.actor.id'] === person.userId,
      );
      expect(events, 'one event per session').toHaveLength(3);
      for (const event of events) {
        expect(event.attributes['tayzu.auth.revocation.reason']).toBe('password_reset');
      }
      const tenants = events
        .map((event) => event.attributes['tayzu.tenant.id'])
        .filter((tenant) => tenant !== undefined)
        .map(String)
        .sort();
      expect(tenants, 'the tenant of each session that has one').toEqual(
        [person.organizationId, second.id].sort(),
      );
      expect(
        events.filter((event) => !('tayzu.tenant.id' in event.attributes)),
        'the event of the session with no tenant omits the tenant',
      ).toHaveLength(1);
    }, 90_000);
  });

  describe('The new password signs in', () => {
    it('a sign-in with the new password succeeds and a sign-in with the old password fails', async () => {
      const person = await createPerson();
      const issued = await store().issue(person.userId);

      expectCompleted(await post({ id: issued.id, token: issued.token }));

      const fresh = await signInRaw(person.email, NEW_PASSWORD);
      expect(fresh.status, 'the new password signs in').toBe(200);
      const old = await signInRaw(person.email, TEST_PASSWORD);
      expect(old.status, 'the old password is refused').toBe(401);
    }, 60_000);

    it('for an enrolled user the new password signs in with the second factor', async () => {
      const user = await createEnrolled();
      const issued = await store().issue(user.userId);
      expectCompleted(
        await post({
          id: issued.id,
          token: issued.token,
          factor: { kind: 'totp', code: await currentCode(user.secret) },
        }),
      );

      const cookie = await signInWithTotp(app, {
        email: user.email,
        password: NEW_PASSWORD,
        secret: user.secret,
        origin: 'http://localhost:3000',
      });

      expect(await sessionAlive(cookie)).toBe(true);
      const old = await signInRaw(user.email, TEST_PASSWORD);
      expect(old.status, 'the old password is refused').toBe(401);
    }, 60_000);
  });

  describe('A reset does not sign the user in', () => {
    it('the response sets no cookie and no session exists afterwards', async () => {
      const person = await createPerson();
      const issued = await store().issue(person.userId);

      const answer = await post({ id: issued.id, token: issued.token });

      expectCompleted(answer);
      expect(answer.setCookie, 'no Set-Cookie header').toBeUndefined();
      expect(await sessionCount(person.userId), 'no session exists').toBe(0);
    }, 60_000);
  });

  describe('A reset never revives a banned or disabled user', () => {
    it('a user banned after the token was issued gets the uniform rejection, the password is unchanged and banned is still true', async () => {
      const person = await createPerson();
      const issued = await store().issue(person.userId);
      await authPool.query('update auth."user" set banned = true where id = $1', [person.userId]);
      const hashBefore = await passwordHash(person.userId);

      const answer = await post({ id: issued.id, token: issued.token });

      expectUniformRejection(answer);
      expect(await passwordHash(person.userId), 'the password is unchanged').toBe(hashBefore);
      const banned = await authPool.query<{ banned: boolean | null }>(
        'select banned from auth."user" where id = $1',
        [person.userId],
      );
      expect(banned.rows[0]?.banned, 'banned is still true').toBe(true);
    }, 60_000);

    /** A user, a member of one new tenant per entry, with the given `_user` status in each. */
    async function createMember(
      statuses: readonly ('Active' | 'Disabled')[],
    ): Promise<{ email: string; userId: string; tenantIds: string[] }> {
      const suffix = randomUUID();
      const email = `effects-member-${suffix}@example.test`;
      const created = await createAdminUser(app.auth, {
        name: 'Effects Member',
        email,
        password: TEST_PASSWORD,
      });
      const tenantIds: string[] = [];
      for (const [index, status] of statuses.entries()) {
        const organization = await (app.auth.api as CreateOrganizationSurface).createOrganization({
          body: {
            name: `Effects Member Org ${String(index)} ${suffix}`,
            slug: `effects-member-${String(index)}-${suffix}`,
            userId: created.userId,
          },
        });
        await seedUserRow(testAppPool(), {
          tenantId: organization.id,
          email,
          name: 'Effects Member',
          status,
        });
        // Creating the organization may already have written an Active `_user`, which the seed
        // leaves untouched: set the wanted status explicitly.
        await withTenantTransaction(
          testAppPool(),
          { tenantId: organization.id },
          async (client) => {
            await client.query(
              `update catalog_entity
                set spec_properties = jsonb_set(spec_properties, '{status}', to_jsonb($3::text))
              where tenant_id = $1 and identifier = $2`,
              [organization.id, email, status],
            );
          },
        );
        tenantIds.push(organization.id);
      }
      return { email, userId: created.userId, tenantIds };
    }

    async function userStatus(tenantId: string, email: string): Promise<string | undefined> {
      return withTenantTransaction(testAppPool(), { tenantId }, async (client) => {
        const result = await client.query<{ status: string | null }>(
          `select spec_properties->>'status' as status from catalog_entity
            where tenant_id = $1 and identifier = $2`,
          [tenantId, email],
        );
        return result.rows[0]?.status ?? undefined;
      });
    }

    it('a user Disabled in every tenant gets the uniform rejection and the password is unchanged', async () => {
      const member = await createMember(['Disabled']);
      const issued = await store().issue(member.userId);
      const hashBefore = await passwordHash(member.userId);

      const answer = await post({ id: issued.id, token: issued.token });

      expectUniformRejection(answer);
      expect(await passwordHash(member.userId)).toBe(hashBefore);
      const [tenantId] = member.tenantIds;
      expect(await userStatus(tenantId ?? '', member.email), 'still Disabled').toBe('Disabled');
    }, 60_000);

    it('a user Disabled in one tenant and Active in another resets, and the Disabled _user stays Disabled', async () => {
      const member = await createMember(['Disabled', 'Active']);
      const issued = await store().issue(member.userId);
      const hashBefore = await passwordHash(member.userId);

      expectCompleted(await post({ id: issued.id, token: issued.token }));

      expect(await passwordHash(member.userId)).not.toBe(hashBefore);
      expect(await userStatus(member.tenantIds[0] ?? '', member.email)).toBe('Disabled');
      expect(await userStatus(member.tenantIds[1] ?? '', member.email)).toBe('Active');
      const banned = await authPool.query<{ banned: boolean | null }>(
        'select banned from auth."user" where id = $1',
        [member.userId],
      );
      expect(banned.rows[0]?.banned === true, 'banned is untouched').toBe(false);
    }, 60_000);
  });

  describe('A reset is the way out of an expired temporary password', () => {
    it('the marker is gone, the new password signs in and reaches the platform without a forced change', async () => {
      // A plain member (what 043's `identity.users.create` gives a new account), not an
      // admin: the admin-MFA gate of 002 is orthogonal to a temporary password.
      const owner = await createPerson();
      const suffix = randomUUID();
      const email = `effects-temp-${suffix}@example.test`;
      const created = await createAdminUser(app.auth, {
        name: 'Effects Temp Member',
        email,
        password: TEST_PASSWORD,
      });
      await (
        app.auth.api as {
          addMember(args: {
            body: { userId: string; organizationId: string; role: string };
          }): Promise<unknown>;
        }
      ).addMember({
        body: { userId: created.userId, organizationId: owner.organizationId, role: 'member' },
      });
      await seedUserRow(testAppPool(), {
        tenantId: owner.organizationId,
        email,
        name: 'Effects Temp Member',
        status: 'Active',
      });
      const person = { email, userId: created.userId };
      await authPool.query(
        `insert into auth.verification (id, identifier, value, expires_at, created_at, updated_at)
         values ($1, $2, $3, $4, now(), now())`,
        [
          randomUUID(),
          `temp-password:${person.userId}`,
          new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          new Date('9999-12-31T23:59:59.000Z'),
        ],
      );
      const expired = await signInRaw(person.email, TEST_PASSWORD);
      expect(expired.status, 'precondition: the expired temporary password is refused').not.toBe(
        200,
      );
      const issued = await store().issue(person.userId);

      expectCompleted(await post({ id: issued.id, token: issued.token }));

      const markers = await authPool.query(
        'select 1 from auth.verification where identifier = $1',
        [`temp-password:${person.userId}`],
      );
      expect(markers.rowCount, 'the marker is gone').toBe(0);
      const signedIn = await signInAdminUser(app.auth, {
        email: person.email,
        password: NEW_PASSWORD,
        ip: randomIp(),
      });
      expect(await v1Status(signedIn.cookie), 'the platform is reachable').toBe(200);
    }, 60_000);
  });

  describe('A weak password is refused and the token survives (second half)', () => {
    it('the same token then completes a reset with a compliant password', async () => {
      const person = await createPerson();
      const issued = await store().issue(person.userId);
      const hashBefore = await passwordHash(person.userId);

      const weak = await post({ id: issued.id, token: issued.token, newPassword: 'Short-1!' });
      expect(weak.status).toBe(400);
      expect(weak.body).toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });
      expect(await passwordHash(person.userId)).toBe(hashBefore);

      const answer = await post({ id: issued.id, token: issued.token });

      expectCompleted(answer);
      expect(await passwordHash(person.userId)).not.toBe(hashBefore);
      expect((await signInRaw(person.email, NEW_PASSWORD)).status).toBe(200);
    }, 60_000);
  });
});

/**
 * Task 8.10 of openspec/changes/044-password-reset-and-account-recovery (design D7 steps 10-12,
 * D6 "Enrolled and a `factor`", Q19). Scenarios of `specs/password-reset-and-account-recovery/spec.md`,
 * quoted:
 *
 * - "A backup code completes the reset and is spent": WHEN the request carries an unused backup
 *   code; THEN the reset completes, and the same backup code is refused on the next sign-in.
 * - "A refused password does not spend the backup code": GIVEN an enrolled user, a valid token and
 *   an unused backup code; WHEN the token, the backup code and a weak or breached password are
 *   submitted; THEN the answer is `CATALOG_VALIDATION_FAILED` and the same backup code still
 *   completes a reset with a compliant password.
 * - "A failed write leaves everything as it was": GIVEN a failure injected after the password write
 *   and before the commit; WHEN a valid token is submitted; THEN the old password still signs in,
 *   the sessions are still live, the token still works and a backup code that was presented is not
 *   spent.
 * - Case "a lost backup-code swap aborts with `AUTH_STEP_UP_REQUIRED` and nothing else changed"
 *   (D7 step 10: a sign-in spent the same code at the same moment).
 * - Case "with a pool of one connection the completion does not take a second pooled connection
 *   while the lock is held" (D7, Q13).
 *
 * ## Harness
 *
 * Two real servers over instrumented `pg` pools (the `connect` event wraps each physical client's
 * promise-style `query`): one normal-size pool whose hook injects the failure at `commit` after the
 * credential write, and the interleaved sign-in just before the backup-code swap; one pool of
 * exactly one connection. Everything else is as the first describe of this file. No production
 * hook is needed: the failure and the race are injected at the database client.
 *
 * ## Production symbols expected
 *
 * None new: `createPasswordResetConfirmFlow` spends the backup code with the existing
 * `globalSpendBackupCode(twoFactorId, expected, remaining, tx)` inside the completion transaction
 * (D7 step 10), aborting with `AuthStepUpError` when the swap changes no row.
 */
describe('Atomicity and the backup code of a password reset (task 8.10)', () => {
  type QueryHook = (client: object, sql: string) => Promise<void> | void;

  interface Instrumented {
    readonly pool: Pool;
    setHook(hook: QueryHook | undefined): void;
  }

  function instrumentedPool(max?: number): Instrumented {
    const url = process.env['DATABASE_URL'];
    if (url === undefined || url.trim() === '') throw new Error('DATABASE_URL is not set');
    const pool = new Pool({ connectionString: url, ...(max === undefined ? {} : { max }) });
    let current: QueryHook | undefined;
    pool.on('connect', (client) => {
      const target = client as unknown as { query: (...args: unknown[]) => unknown };
      const original = target.query.bind(client);
      target.query = (...args: unknown[]): unknown => {
        const first = args[0];
        const sql =
          typeof first === 'string'
            ? first
            : ((first as { text?: string } | undefined)?.text ?? '');
        const last = args[args.length - 1];
        if (current !== undefined && typeof last !== 'function') {
          const hook = current;
          return Promise.resolve(hook(client, sql)).then(() => original(...args));
        }
        return original(...args);
      };
    });
    pool.on('error', () => undefined);
    return {
      pool,
      setHook(hook) {
        current = hook;
      },
    };
  }

  const BREACHED = 'Crème-Brûlée-Battery-Staple-2026!';
  let harnessAuthPool: Pool;
  let appPool: Pool;
  let normal: Instrumented;
  let single: Instrumented;
  let appA: App;
  let appOne: App;
  const sender = createRecordingEmailSender();

  function buildApp(authPool: Pool): Promise<App> {
    const email = {
      sender,
      invitationLinkBaseUrl: LINK_BASE_URL,
      passwordResetLinkBaseUrl: LINK_BASE_URL,
      passwordResetMinResponseMs: 0,
      disabledTenantIds: [] as string[],
      killSwitch: false,
      recipientKeySecret: HMAC_SECRET,
      tenantCap: { max: 1000, windowSeconds: 3600 },
      recipientCap: { max: 1000, windowSeconds: 86_400 },
      passwordResetRecipientCap: { max: 1000, windowSeconds: 3600 },
      passwordResetIpCap: { max: 1000, windowSeconds: 3600 },
      passwordResetGlobalCap: { max: 100_000, windowSeconds: 3600 },
      accountCreatedNoticeGlobalCap: { max: 100_000, windowSeconds: 86_400 },
    };
    return createApp({
      appPool,
      authPool,
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ORIGIN],
      mountIdentityRoutes: true,
      identityTokenHmacSecret: HMAC_SECRET,
      ...{ email },
    });
  }

  beforeAll(async () => {
    const pools = await harnessPools();
    appPool = pools.appPool;
    harnessAuthPool = pools.authPool;
    normal = instrumentedPool();
    single = instrumentedPool(1);
    appA = await buildApp(normal.pool);
    appOne = await buildApp(single.pool);
  }, 60_000);

  beforeEach(() => {
    vi.stubGlobal('fetch', (): Promise<Response> => {
      return Promise.resolve(
        new Response('0000000000000000000000000000000000A:3\r\n', { status: 200 }),
      );
    });
  });

  afterEach(() => {
    normal.setHook(undefined);
    single.setHook(undefined);
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    const giveUp = new Promise<void>((resolve) => setTimeout(resolve, 5000));
    await Promise.race([
      Promise.all([appA.close(), appOne.close(), normal.pool.end(), single.pool.end()]),
      giveUp,
    ]);
  }, 60_000);

  function store() {
    return createResetTokenStore({
      authPool: harnessAuthPool,
      withUserLock: createWithUserLock(harnessAuthPool),
    });
  }

  function handlerOf(): Handler {
    return (appA.auth as unknown as { handler: Handler }).handler;
  }

  interface Enrolled {
    readonly email: string;
    readonly userId: string;
    readonly secret: string;
    readonly backupCodes: readonly string[];
    /** A live session cookie created after the enrolment (through a TOTP sign-in). */
    readonly cookie: string;
  }

  async function createEnrolledWithBackupCodes(): Promise<Enrolled> {
    const suffix = randomUUID();
    const email = `effects-backup-${suffix}@example.test`;
    const tenant = await bootstrapTestTenant(appA.auth, {
      pool: testAppPool(),
      name: 'Backup User',
      email,
      password: TEST_PASSWORD,
      organizationName: `Backup Org ${suffix}`,
      organizationSlug: `backup-${suffix}`,
      ip: randomIp(),
    });
    const secret = await enrollTotp(appA, {
      password: TEST_PASSWORD,
      enrollmentCookie: tenant.cookie,
    });
    const cookie = await signInWithTotp(appA, {
      email,
      password: TEST_PASSWORD,
      secret,
      origin: 'http://localhost:3000',
    });
    const generated = await (
      appA.auth.api as {
        generateBackupCodes(args: {
          body: { password: string };
          headers: Headers;
        }): Promise<{ backupCodes: string[] }>;
      }
    ).generateBackupCodes({
      body: { password: TEST_PASSWORD },
      headers: new Headers({ cookie }),
    });
    expect(generated.backupCodes.length, 'precondition: backup codes exist').toBeGreaterThan(1);
    return { email, userId: tenant.userId, secret, backupCodes: generated.backupCodes, cookie };
  }

  async function postTo(app: App, fields: Record<string, unknown>): Promise<Answer> {
    const response = await app.app.inject({
      method: 'POST',
      url: CONFIRM_PATH,
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        'x-csrf-token': 'orpc',
        'x-forwarded-for': randomIp(),
      },
      payload: JSON.stringify({ newPassword: NEW_PASSWORD, ...fields }),
    });
    let body: unknown;
    try {
      body = response.json();
    } catch {
      body = response.body;
    }
    return {
      status: response.statusCode,
      body,
      setCookie: response.headers['set-cookie'],
      cacheControl: response.headers['cache-control'],
      pragma: response.headers['pragma'],
    };
  }

  function completed(answer: Answer): void {
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ completed: true });
  }

  function stepUp(answer: Answer): void {
    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ code: 'AUTH_STEP_UP_REQUIRED' });
  }

  async function scalar(sql: string, params: unknown[]): Promise<string> {
    const result = await harnessAuthPool.query<{ v: string | null }>(sql, params);
    return result.rows[0]?.v ?? '';
  }

  const passwordOf = (userId: string): Promise<string> =>
    scalar(
      `select password as v from auth.account where user_id = $1 and provider_id = 'credential'`,
      [userId],
    );
  const backupCodesOf = (userId: string): Promise<string> =>
    scalar('select backup_codes as v from auth.two_factor where user_id = $1', [userId]);
  const tokenRowsOf = (id: string): Promise<string> =>
    scalar(`select count(*)::text as v from auth.verification where identifier = $1`, [
      `password-reset:${id}`,
    ]);
  const sessionsOf = async (userId: string): Promise<number> =>
    Number(
      await scalar('select count(*)::text as v from auth.session where user_id = $1', [userId]),
    );

  async function signIn(email: string, password: string): Promise<Response> {
    return handlerOf()(
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

  /** Signs in with the password and answers the status of `verify-backup-code` for `code`. */
  async function backupCodeSignInStatus(
    email: string,
    password: string,
    code: string,
  ): Promise<number> {
    const challenge = await signIn(email, password);
    expect(challenge.status, 'the password step is challenged').toBe(200);
    const cookie = challenge.headers
      .getSetCookie()
      .map((raw) => raw.split(';')[0])
      .join('; ');
    const response = await handlerOf()(
      new Request(`${AUTH_BASE_URL}/two-factor/verify-backup-code`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': randomIp(),
          origin: 'http://localhost:3000',
          cookie,
        },
        body: JSON.stringify({ code }),
      }),
    );
    return response.status;
  }

  async function sessionLive(cookie: string): Promise<boolean> {
    const response = await handlerOf()(
      new Request(`${AUTH_BASE_URL}/get-session`, {
        method: 'GET',
        headers: { cookie, 'x-forwarded-for': randomIp() },
      }),
    );
    if (response.status !== 200) return false;
    const body = (await response.json().catch(() => null)) as {
      session?: { id?: string };
    } | null;
    return body?.session?.id !== undefined;
  }

  describe('A backup code completes the reset and is spent', () => {
    it('the reset completes and the same backup code is refused on the next sign-in, a reset included', async () => {
      const user = await createEnrolledWithBackupCodes();
      const [spent, unused] = user.backupCodes;
      expect(spent).toBeDefined();
      expect(unused).toBeDefined();
      const issued = await store().issue(user.userId);
      const hashBefore = await passwordOf(user.userId);
      const codesBefore = await backupCodesOf(user.userId);

      const answer = await postTo(appA, {
        id: issued.id,
        token: issued.token,
        factor: { kind: 'backup_code', code: spent },
      });

      completed(answer);
      expect(await tokenRowsOf(issued.id), 'the token is consumed').toBe('0');
      expect(await passwordOf(user.userId), 'the password changed').not.toBe(hashBefore);
      expect(await backupCodesOf(user.userId), 'the stored code list shrank').not.toBe(codesBefore);

      const reuse = await backupCodeSignInStatus(user.email, NEW_PASSWORD, spent ?? '');
      expect(reuse, 'the spent code is refused at sign-in').toBeGreaterThanOrEqual(400);
      const other = await backupCodeSignInStatus(user.email, NEW_PASSWORD, unused ?? '');
      expect(other, 'an unused code still signs in').toBe(200);

      const second = await store().issue(user.userId);
      stepUp(
        await postTo(appA, {
          id: second.id,
          token: second.token,
          factor: { kind: 'backup_code', code: spent },
        }),
      );
      expect(await tokenRowsOf(second.id), 'the refused spent code left the token').toBe('1');
    }, 90_000);
  });

  describe('A refused password does not spend the backup code', () => {
    it.each([
      ['weak', 'Short-1!'],
      ['breached', BREACHED],
    ])(
      'a %s password answers CATALOG_VALIDATION_FAILED and the same backup code then completes a reset',
      async (kind, newPassword) => {
        const user = await createEnrolledWithBackupCodes();
        const code = user.backupCodes[0];
        const issued = await store().issue(user.userId);
        const hashBefore = await passwordOf(user.userId);
        const codesBefore = await backupCodesOf(user.userId);
        if (kind === 'breached') {
          vi.stubGlobal('fetch', (input: string | URL | Request): Promise<Response> => {
            const url =
              typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
            const prefix = new URL(url).pathname.split('/').pop() ?? '';
            const hash = createHash('sha1').update(BREACHED.normalize('NFC')).digest('hex');
            const upper = hash.toUpperCase();
            const lines = ['0000000000000000000000000000000000A:3'];
            if (upper.startsWith(prefix)) lines.push(`${upper.slice(5)}:42`);
            return Promise.resolve(new Response(lines.join('\r\n'), { status: 200 }));
          });
        }

        const refused = await postTo(appA, {
          id: issued.id,
          token: issued.token,
          newPassword,
          factor: { kind: 'backup_code', code },
        });

        expect(refused.status).toBe(400);
        expect(refused.body).toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });
        expect(await backupCodesOf(user.userId), 'the backup code is not spent').toBe(codesBefore);
        expect(await passwordOf(user.userId)).toBe(hashBefore);
        expect(await tokenRowsOf(issued.id), 'the token survives').toBe('1');

        vi.unstubAllGlobals();
        vi.stubGlobal('fetch', (): Promise<Response> => {
          return Promise.resolve(
            new Response('0000000000000000000000000000000000A:3\r\n', { status: 200 }),
          );
        });
        completed(
          await postTo(appA, {
            id: issued.id,
            token: issued.token,
            factor: { kind: 'backup_code', code },
          }),
        );
        expect(await passwordOf(user.userId)).not.toBe(hashBefore);
      },
      90_000,
    );
  });

  describe('A failed write leaves everything as it was', () => {
    it('a failure after the password write and before the commit keeps the old password, the sessions, the token and the backup code', async () => {
      const user = await createEnrolledWithBackupCodes();
      const code = user.backupCodes[0];
      const issued = await store().issue(user.userId);
      const hashBefore = await passwordOf(user.userId);
      const codesBefore = await backupCodesOf(user.userId);
      const sessionsBefore = await sessionsOf(user.userId);
      expect(sessionsBefore, 'precondition: live sessions').toBeGreaterThan(0);
      expect(await sessionLive(user.cookie), 'precondition: the session is live').toBe(true);

      const wrote = new WeakSet<object>();
      normal.setHook((client, sql) => {
        if (/^\s*update\s+auth\.account\b/i.test(sql)) wrote.add(client);
        if (sql.trim().toLowerCase() === 'commit' && wrote.has(client)) {
          throw new Error('injected failure before the commit');
        }
      });
      const failed = await postTo(appA, {
        id: issued.id,
        token: issued.token,
        factor: { kind: 'backup_code', code },
      });
      normal.setHook(undefined);

      expect(failed.status, 'a sanitized internal error').toBe(500);
      expect(JSON.stringify(failed.body)).not.toContain('injected');
      expect(await passwordOf(user.userId), 'the password is unchanged').toBe(hashBefore);
      expect((await signIn(user.email, TEST_PASSWORD)).status, 'the old password signs in').toBe(
        200,
      );
      expect((await signIn(user.email, NEW_PASSWORD)).status, 'the new one does not').toBe(401);
      expect(await sessionsOf(user.userId), 'the sessions are live').toBeGreaterThanOrEqual(
        sessionsBefore,
      );
      expect(await sessionLive(user.cookie)).toBe(true);
      expect(await tokenRowsOf(issued.id), 'the token row is there').toBe('1');
      expect(await backupCodesOf(user.userId), 'the backup code is not spent').toBe(codesBefore);

      completed(
        await postTo(appA, {
          id: issued.id,
          token: issued.token,
          factor: { kind: 'backup_code', code },
        }),
      );
      expect(await passwordOf(user.userId), 'the token still works').not.toBe(hashBefore);
    }, 90_000);
  });

  describe('Backup-code swap and connection discipline', () => {
    it('a lost backup-code swap aborts with AUTH_STEP_UP_REQUIRED and nothing else changed', async () => {
      const user = await createEnrolledWithBackupCodes();
      const code = user.backupCodes[0];
      const issued = await store().issue(user.userId);
      await harnessAuthPool.query('update auth."user" set email_verified = false where id = $1', [
        user.userId,
      ]);
      await harnessAuthPool.query(
        `insert into auth.verification (id, identifier, value, expires_at, created_at, updated_at)
         values ($1, $2, $3, $4, now(), now())`,
        [
          randomUUID(),
          `temp-password:${user.userId}`,
          new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          new Date('9999-12-31T23:59:59.000Z'),
        ],
      );
      const hashBefore = await passwordOf(user.userId);
      const sessionsBefore = await sessionsOf(user.userId);
      const failuresBefore = await scalar(
        'select coalesce(failed_verification_count, 0)::text as v from auth.two_factor where user_id = $1',
        [user.userId],
      );
      let racedValue = '';
      let raced = false;

      // A sign-in spends the same code at the same moment: its write commits on another
      // connection just before the completion's swap.
      normal.setHook(async (_client, sql) => {
        if (!raced && /^\s*update\s+auth\.two_factor\s+set\s+backup_codes/i.test(sql)) {
          raced = true;
          racedValue = `raced-${randomUUID()}`;
          await harnessAuthPool.query(
            'update auth.two_factor set backup_codes = $2 where user_id = $1',
            [user.userId, racedValue],
          );
        }
      });
      const answer = await postTo(appA, {
        id: issued.id,
        token: issued.token,
        factor: { kind: 'backup_code', code },
      });
      normal.setHook(undefined);

      expect(raced, 'the swap statement was reached and raced').toBe(true);
      stepUp(answer);
      expect(await passwordOf(user.userId), 'the password is unchanged').toBe(hashBefore);
      expect(await tokenRowsOf(issued.id), 'the token is not consumed').toBe('1');
      expect(await sessionsOf(user.userId), 'the sessions are untouched').toBe(sessionsBefore);
      expect(
        await scalar('select email_verified::text as v from auth."user" where id = $1', [
          user.userId,
        ]),
        'emailVerified is untouched',
      ).toBe('false');
      expect(
        await scalar(`select count(*)::text as v from auth.verification where identifier = $1`, [
          `temp-password:${user.userId}`,
        ]),
        'the temporary-password marker is still there',
      ).toBe('1');
      expect(await backupCodesOf(user.userId), 'only the racing write stands').toBe(racedValue);
      expect(
        await scalar(
          'select coalesce(failed_verification_count, 0)::text as v from auth.two_factor where user_id = $1',
          [user.userId],
        ),
        'the account counter is untouched',
      ).toBe(failuresBefore);
    }, 90_000);

    it('with a pool of one connection the completion does not take a second pooled connection while the lock is held', async () => {
      const user = await createEnrolledWithBackupCodes();
      const code = user.backupCodes[0];
      const issued = await store().issue(user.userId);
      const hashBefore = await passwordOf(user.userId);

      const outcome = await Promise.race([
        postTo(appOne, {
          id: issued.id,
          token: issued.token,
          factor: { kind: 'backup_code', code },
        }),
        new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 20_000)),
      ]);

      expect(outcome, 'the completion did not wait for a second connection').not.toBe('hung');
      if (outcome === 'hung') return;
      completed(outcome);
      expect(single.pool.totalCount, 'the pool never grew past one').toBeLessThanOrEqual(1);
      expect(await passwordOf(user.userId)).not.toBe(hashBefore);
      expect(await tokenRowsOf(issued.id)).toBe('0');
    }, 60_000);
  });
});

/**
 * Task 8.11 of openspec/changes/044-password-reset-and-account-recovery (design D7, Resolved
 * decision on single use). Scenarios of `specs/password-reset-and-account-recovery/spec.md`, quoted:
 *
 * - "A token is single use": WHEN a valid token completes a reset and is submitted again; THEN the
 *   second submission is the uniform rejection and changes nothing.
 * - "A concurrent double submit completes once": WHEN the same valid token is submitted twice at
 *   the same time; THEN exactly one completes and the other is the uniform rejection.
 *
 * ## Harness
 *
 * The real server with the identity routes mounted over the shared pools, as the first describe of
 * this file. The two parallel submissions carry different passwords so the winner is identifiable
 * from which password signs in. Every seeded value is random per run.
 *
 * ## Production symbols expected
 *
 * None new: the confirm flow of task 8.9 (`createPasswordResetConfirmFlow`) consuming the token on
 * the lock's connection (`createResetTokenStore().consume`, task 2.6).
 */
describe('Concurrency of a password reset (task 8.11)', () => {
  const FIRST_PASSWORD = 'First-Winner-Passphrase-Perfectly-Fine-11!';
  const SECOND_PASSWORD = 'Second-Winner-Passphrase-Perfectly-Fine-22!';
  let app: App;
  let authPool: Pool;
  const sender = createRecordingEmailSender();

  beforeAll(async () => {
    const pools = await harnessPools();
    authPool = pools.authPool;
    const email = {
      sender,
      invitationLinkBaseUrl: LINK_BASE_URL,
      passwordResetLinkBaseUrl: LINK_BASE_URL,
      passwordResetMinResponseMs: 0,
      disabledTenantIds: [] as string[],
      killSwitch: false,
      recipientKeySecret: HMAC_SECRET,
      tenantCap: { max: 1000, windowSeconds: 3600 },
      recipientCap: { max: 1000, windowSeconds: 86_400 },
      passwordResetRecipientCap: { max: 1000, windowSeconds: 3600 },
      passwordResetIpCap: { max: 1000, windowSeconds: 3600 },
      passwordResetGlobalCap: { max: 100_000, windowSeconds: 3600 },
      accountCreatedNoticeGlobalCap: { max: 100_000, windowSeconds: 86_400 },
    };
    app = await createApp({
      appPool: pools.appPool,
      authPool: pools.authPool,
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ORIGIN],
      mountIdentityRoutes: true,
      identityTokenHmacSecret: HMAC_SECRET,
      ...{ email },
    });
  }, 60_000);

  beforeEach(() => {
    vi.stubGlobal('fetch', (): Promise<Response> => {
      return Promise.resolve(
        new Response('0000000000000000000000000000000000A:3\r\n', { status: 200 }),
      );
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await app.close();
  }, 60_000);

  function store() {
    return createResetTokenStore({ authPool, withUserLock: createWithUserLock(authPool) });
  }

  async function createUser(): Promise<{ email: string; userId: string }> {
    const suffix = randomUUID();
    const email = `effects-race-${suffix}@example.test`;
    const tenant = await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: 'Race User',
      email,
      password: TEST_PASSWORD,
      organizationName: `Race Org ${suffix}`,
      organizationSlug: `race-${suffix}`,
      ip: randomIp(),
    });
    return { email, userId: tenant.userId };
  }

  async function confirm(fields: Record<string, unknown>): Promise<Answer> {
    const response = await app.app.inject({
      method: 'POST',
      url: CONFIRM_PATH,
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        'x-csrf-token': 'orpc',
        'x-forwarded-for': randomIp(),
      },
      payload: JSON.stringify(fields),
    });
    let body: unknown;
    try {
      body = response.json();
    } catch {
      body = response.body;
    }
    return {
      status: response.statusCode,
      body,
      setCookie: response.headers['set-cookie'],
      cacheControl: response.headers['cache-control'],
      pragma: response.headers['pragma'],
    };
  }

  async function passwordOf(userId: string): Promise<string> {
    const result = await authPool.query<{ password: string | null }>(
      `select password from auth.account where user_id = $1 and provider_id = 'credential'`,
      [userId],
    );
    return result.rows[0]?.password ?? '';
  }

  async function signInStatus(email: string, password: string): Promise<number> {
    const response = await (app.auth as unknown as { handler: Handler }).handler(
      new Request(`${AUTH_BASE_URL}/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': randomIp() },
        body: JSON.stringify({ email, password }),
      }),
    );
    return response.status;
  }

  function isCompleted(answer: Answer): boolean {
    return answer.status === 200 && JSON.stringify(answer.body) === '{"completed":true}';
  }

  function isUniform(answer: Answer): boolean {
    return (
      answer.status === 404 &&
      typeof answer.body === 'object' &&
      answer.body !== null &&
      (answer.body as { code?: unknown }).code === 'CATALOG_NOT_FOUND'
    );
  }

  describe('A token is single use', () => {
    it('a token that completed a reset is the uniform rejection when submitted again, and changes nothing', async () => {
      const user = await createUser();
      const issued = await store().issue(user.userId);

      const first = await confirm({
        id: issued.id,
        token: issued.token,
        newPassword: FIRST_PASSWORD,
      });
      expect(first.status).toBe(200);
      expect(first.body).toEqual({ completed: true });
      const hashAfterFirst = await passwordOf(user.userId);

      const second = await confirm({
        id: issued.id,
        token: issued.token,
        newPassword: SECOND_PASSWORD,
      });

      expect(second.status).toBe(404);
      expect(second.body).toMatchObject({ code: 'CATALOG_NOT_FOUND' });
      expect(await passwordOf(user.userId), 'the password is unchanged by the replay').toBe(
        hashAfterFirst,
      );
      expect(await signInStatus(user.email, FIRST_PASSWORD)).toBe(200);
      expect(await signInStatus(user.email, SECOND_PASSWORD)).not.toBe(200);
    }, 60_000);
  });

  describe('A concurrent double submit completes once', () => {
    it('two simultaneous submissions of one token: exactly one completes and the other is the uniform rejection', async () => {
      const user = await createUser();
      const issued = await store().issue(user.userId);

      const [a, b] = await Promise.all([
        confirm({ id: issued.id, token: issued.token, newPassword: FIRST_PASSWORD }),
        confirm({ id: issued.id, token: issued.token, newPassword: SECOND_PASSWORD }),
      ]);

      expect([a, b].filter(isCompleted), 'exactly one completes').toHaveLength(1);
      expect([a, b].filter(isUniform), 'the other is the uniform rejection').toHaveLength(1);
      const winnerPassword = isCompleted(a) ? FIRST_PASSWORD : SECOND_PASSWORD;
      const loserPassword = isCompleted(a) ? SECOND_PASSWORD : FIRST_PASSWORD;
      expect(await signInStatus(user.email, winnerPassword), 'the winner password signs in').toBe(
        200,
      );
      expect(
        await signInStatus(user.email, loserPassword),
        'the loser password was never written',
      ).not.toBe(200);
      const rows = await authPool.query(`select 1 from auth.verification where identifier = $1`, [
        `password-reset:${issued.id}`,
      ]);
      expect(rows.rowCount, 'the token is consumed').toBe(0);
    }, 60_000);
  });
});

/**
 * Task 8.14 of openspec/changes/044-password-reset-and-account-recovery (design D7, D8, Resolved
 * decisions Q21 and the squatted-account recovery of D12). Scenarios of
 * `specs/password-reset-and-account-recovery/spec.md`, quoted:
 *
 * - "A reset recovers a squatted account": GIVEN an admin created an account for the victim's
 *   address with a temporary password the admin knows, and the admin has a live session on it;
 *   WHEN the victim completes a reset; THEN the admin's session and knowledge of the temporary
 *   password are both useless, and the victim receives the password-changed notice.
 * - "Machine credentials are untouched": GIVEN a user who owns a service account with a
 *   credential; WHEN the user completes a reset; THEN the credential still exchanges for a token.
 * - "A reset leaves linked sign-ins and credentials, and the notice says to review them": GIVEN a
 *   user with a linked Visma Connect account and a service account with a credential; WHEN the user
 *   completes a reset; THEN the link and the credential are unchanged, and the password-changed
 *   notice tells the user, in its fixed text, to review service accounts, credentials and linked
 *   sign-ins.
 *
 * ## Harness
 *
 * As the first describe of this file (real server, injected requests, random `x-forwarded-for`,
 * stubbed range service, roomy global caps). The squatted account is a real account whose
 * temporary password (`TEST_PASSWORD`) the "admin" knows, with a valid temporary-password marker
 * and the admin's live session. The credential is a real machine credential bound to a seeded
 * service-account `_user`, exchanged at `POST /v1/auth/token`. The Visma Connect link is an
 * `auth.account` row with a random subject. Row snapshots are compared as `to_jsonb`.
 *
 * ## Production symbols expected
 *
 * None new: the completion of task 8.9 and the notice of task 8.12. The reset must not touch
 * `auth.apikey` or any `auth.account` row other than the `credential` one.
 */
describe('Recovery and invariant scenarios of a password reset (task 8.14)', () => {
  let app: App;
  let authPool: Pool;
  const sender = createRecordingEmailSender();

  beforeAll(async () => {
    const pools = await harnessPools();
    authPool = pools.authPool;
    const email = {
      sender,
      invitationLinkBaseUrl: LINK_BASE_URL,
      passwordResetLinkBaseUrl: LINK_BASE_URL,
      passwordResetMinResponseMs: 0,
      disabledTenantIds: [] as string[],
      killSwitch: false,
      recipientKeySecret: HMAC_SECRET,
      tenantCap: { max: 1000, windowSeconds: 3600 },
      recipientCap: { max: 1000, windowSeconds: 86_400 },
      passwordResetRecipientCap: { max: 1000, windowSeconds: 3600 },
      passwordResetIpCap: { max: 1000, windowSeconds: 3600 },
      passwordResetGlobalCap: { max: 100_000, windowSeconds: 3600 },
      accountCreatedNoticeGlobalCap: { max: 100_000, windowSeconds: 86_400 },
    };
    app = await createApp({
      appPool: pools.appPool,
      authPool: pools.authPool,
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ORIGIN],
      mountIdentityRoutes: true,
      identityTokenHmacSecret: HMAC_SECRET,
      ...{ email },
    });
  }, 60_000);

  beforeEach(() => {
    vi.stubGlobal('fetch', (): Promise<Response> => {
      return Promise.resolve(
        new Response('0000000000000000000000000000000000A:3\r\n', { status: 200 }),
      );
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await app.close();
  }, 60_000);

  function store() {
    return createResetTokenStore({ authPool, withUserLock: createWithUserLock(authPool) });
  }

  async function createPerson() {
    const suffix = randomUUID();
    const email = `effects-recovery-${suffix}@example.test`;
    const tenant = await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: 'Recovery User',
      email,
      password: TEST_PASSWORD,
      organizationName: `Recovery Org ${suffix}`,
      organizationSlug: `recovery-${suffix}`,
      ip: randomIp(),
    });
    return {
      email,
      userId: tenant.userId,
      cookie: tenant.cookie,
      organizationId: tenant.organizationId,
    };
  }

  async function confirm(fields: Record<string, unknown>) {
    const response = await app.app.inject({
      method: 'POST',
      url: CONFIRM_PATH,
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        'x-csrf-token': 'orpc',
        'x-forwarded-for': randomIp(),
      },
      payload: JSON.stringify({ newPassword: NEW_PASSWORD, ...fields }),
    });
    return { status: response.statusCode, body: response.body };
  }

  async function signInStatus(email: string, password: string): Promise<number> {
    const response = await (app.auth as unknown as { handler: Handler }).handler(
      new Request(`${AUTH_BASE_URL}/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': randomIp() },
        body: JSON.stringify({ email, password }),
      }),
    );
    return response.status;
  }

  async function sessionAlive(cookie: string): Promise<boolean> {
    const response = await (app.auth as unknown as { handler: Handler }).handler(
      new Request(`${AUTH_BASE_URL}/get-session`, {
        method: 'GET',
        headers: { cookie, 'x-forwarded-for': randomIp() },
      }),
    );
    if (response.status !== 200) return false;
    const body = (await response.json().catch(() => null)) as {
      session?: { id?: string };
    } | null;
    return body?.session?.id !== undefined;
  }

  async function exchange(credential: { id: string; secret: string }): Promise<number> {
    const response = await app.app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        'x-csrf-token': 'orpc',
        'x-forwarded-for': randomIp(),
      },
      payload: JSON.stringify({ clientId: credential.id, clientSecret: credential.secret }),
    });
    return response.statusCode;
  }

  async function snapshot(sql: string, params: unknown[]): Promise<unknown[]> {
    const result = await authPool.query<{ row: unknown }>(sql, params);
    return result.rows.map((r) => r.row);
  }

  const credentialRows = (id: string): Promise<unknown[]> =>
    snapshot('select to_jsonb(k) as row from auth.apikey k where id = $1', [id]);
  const linkRows = (userId: string): Promise<unknown[]> =>
    snapshot(
      `select to_jsonb(a) as row from auth.account a
        where user_id = $1 and provider_id <> 'credential' order by id`,
      [userId],
    );

  async function withServiceAccount(person: {
    userId: string;
    organizationId: string;
  }): Promise<{ id: string; secret: string }> {
    const serviceAccountId = `svc-${randomUUID().slice(0, 8)}`;
    await seedUserRow(testAppPool(), {
      tenantId: person.organizationId,
      email: serviceAccountId,
      name: serviceAccountId,
      status: 'Active',
    });
    return createMachineCredential(app.auth, {
      userId: person.userId,
      organizationId: person.organizationId,
      name: 'Service account credential',
      actorKind: 'integration',
      metadata: { userId: serviceAccountId, createdBy: person.userId },
    });
  }

  async function noticesTo(email: string) {
    await vi.waitFor(() => {
      expect(sender.sent.filter((message) => message.to === email)).toHaveLength(1);
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    return sender.sent.filter((message) => message.to === email);
  }

  describe('A reset recovers a squatted account', () => {
    it('the admin session and the temporary password are useless and the victim receives the password-changed notice', async () => {
      // The account an admin created: the admin knows its temporary password (TEST_PASSWORD) and
      // holds a live session on it.
      const victim = await createPerson();
      await authPool.query(
        `insert into auth.verification (id, identifier, value, expires_at, created_at, updated_at)
         values ($1, $2, $3, $4, now(), now())`,
        [
          randomUUID(),
          `temp-password:${victim.userId}`,
          new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
          new Date('9999-12-31T23:59:59.000Z'),
        ],
      );
      const adminSession = await signInAdminUser(app.auth, {
        email: victim.email,
        password: TEST_PASSWORD,
        ip: randomIp(),
      });
      expect(
        await sessionAlive(adminSession.cookie),
        'precondition: the admin session is live',
      ).toBe(true);
      const issued = await store().issue(victim.userId);

      const answer = await confirm({ id: issued.id, token: issued.token });

      expect(answer.status).toBe(200);
      expect(JSON.parse(answer.body)).toEqual({ completed: true });
      expect(await sessionAlive(adminSession.cookie), 'the admin session is useless').toBe(false);
      expect(await sessionAlive(victim.cookie)).toBe(false);
      expect(
        await signInStatus(victim.email, TEST_PASSWORD),
        'the temporary password is useless',
      ).toBe(401);
      expect(await signInStatus(victim.email, NEW_PASSWORD), 'the victim signs in').toBe(200);
      const sent = await noticesTo(victim.email);
      expect(sent, 'exactly one notice, to the victim').toHaveLength(1);
      expect(sent[0]?.template).toEqual({ kind: 'PasswordChangedNotice' });
    }, 90_000);
  });

  describe('Machine credentials are untouched', () => {
    it('a credential of a service account the user owns still exchanges for a token after a reset', async () => {
      const person = await createPerson();
      const credential = await withServiceAccount(person);
      expect(await exchange(credential), 'precondition: the credential exchanges').toBe(200);
      const before = await credentialRows(credential.id);
      expect(before, 'precondition: the credential row exists').toHaveLength(1);
      const issued = await store().issue(person.userId);

      const answer = await confirm({ id: issued.id, token: issued.token });

      expect(answer.status).toBe(200);
      expect(await exchange(credential), 'the credential still exchanges').toBe(200);
      const after = await credentialRows(credential.id);
      expect(after.length, 'the credential row survives').toBe(1);
      expect(
        (after[0] as Record<string, unknown>)['key'],
        'the stored credential hash is unchanged',
      ).toBe((before[0] as Record<string, unknown>)['key']);
    }, 90_000);
  });

  describe('A reset leaves linked sign-ins and credentials, and the notice says to review them', () => {
    it('the Visma Connect link and the credential are unchanged and the notice tells the user to review them', async () => {
      const person = await createPerson();
      const credential = await withServiceAccount(person);
      await authPool.query(
        `insert into auth.account (id, account_id, provider_id, user_id, created_at, updated_at)
         values ($1, $2, 'visma-connect', $3, now(), now())`,
        [randomUUID(), `sub-${randomUUID()}`, person.userId],
      );
      const linksBefore = await linkRows(person.userId);
      const credentialBefore = await credentialRows(credential.id);
      expect(linksBefore, 'precondition: one linked sign-in').toHaveLength(1);
      expect(credentialBefore, 'precondition: one credential').toHaveLength(1);
      const issued = await store().issue(person.userId);

      const answer = await confirm({ id: issued.id, token: issued.token });

      expect(answer.status).toBe(200);
      expect(await linkRows(person.userId), 'the link is unchanged').toEqual(linksBefore);
      expect(await credentialRows(credential.id), 'the credential is unchanged').toEqual(
        credentialBefore,
      );
      expect(await exchange(credential)).toBe(200);

      const sent = await noticesTo(person.email);
      expect(sent).toHaveLength(1);
      const template = sent[0]?.template;
      expect(template).toEqual({ kind: 'PasswordChangedNotice' });
      const rendered = renderPasswordChangedNotice({ kind: 'PasswordChangedNotice' });
      for (const body of [rendered.text, rendered.html]) {
        const lower = body.toLowerCase();
        expect(lower).toContain('service accounts');
        expect(lower).toContain('credentials');
        expect(lower).toContain('linked sign-ins');
      }
    }, 90_000);
  });
});
