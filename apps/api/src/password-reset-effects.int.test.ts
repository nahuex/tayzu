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
import { randomInt, randomUUID } from 'node:crypto';

import { createRecordingEmailSender } from '@tayzu/auth';
import { withTenantTransaction } from '@tayzu/db';
import type { Pool } from 'pg';
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
