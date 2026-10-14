/**
 * Task 8.5k of openspec/changes/043-identity-lifecycle-and-org-admin (Resolved
 * decisions Q106, Q115 and Q122; design D4 step 7).
 *
 * Scenarios (spec "An SSO link that its user did not make does not survive into
 * a second tenant"):
 * - "A sign-in through a shed link creates no session"
 * - "A session created during the shed is swept"
 * - "The accepting session is revoked when the shed removed a link"
 * - "A failed revocation of the accepting session is logged"
 *
 * ## Harness
 *
 * Same as `sso-link-shed.int.test.ts` (one Better Auth instance with the real
 * user sync and the shed core's port, a real `createApp` for `/v1`, the local
 * OIDC stub, a fresh random `x-forwarded-for` per request, fresh tenants and
 * users per test). Seams, all outside production code:
 *
 * - The Better Auth instance's database pool is wrapped. A seam can hold the
 *   callback right after its `UPDATE auth.account` statement has completed (the
 *   callback has read the account and refreshed its tokens, and has not yet
 *   created its session) while the test runs the shed, or can blank the
 *   `id` of the row that statement returns so that no account id can be recorded
 *   for the request (the stash is then suppressed).
 * - The sweep test wraps the shed core's `withUserLock` so that a session row is
 *   inserted inside the lock's transaction after the shed's first sweep and
 *   before its commit.
 * - The acceptance's `onStep` seam records the state at each step.
 * - A pool that fails `DELETE FROM auth.session` once a flag is set (the flag is
 *   raised when the `user_step` begins, so the shed step and its sweeps have
 *   already run) is given to the shed core, the flow and its repository.
 *
 * ## Production symbols expected
 *
 * - `packages/auth/src/auth.ts`: `databaseHooks.session.create.before` refuses a
 *   callback session (with the callback's uniform rejection, same status and body
 *   as the rejection of an unlinked `sub`) when the account the callback signed
 *   in through no longer exists, when it has no marker while its user has two or
 *   more memberships, and when no account id was recorded for the request.
 * - `apps/api/src/identity/accept-flow.ts`: right after the `_user` step, when
 *   the attempt's shed removed a link, the accepting session is deleted through
 *   the shed core (reason `sso_link_shed`, one `auth.security.session_revoked`),
 *   before the `email_verified` step and the `consume` step. A failure of that
 *   deletion does not stop the acceptance and emits
 *   `catalog.security.accepting_session_revocation_failed` with
 *   `tayzu.tenant.id`, `tayzu.identity.invitation.id`, `tayzu.identity.user.id`.
 *
 * ## Why this fails right now
 *
 * The callback creates a session through a deleted or unmarked link, and the
 * acceptance keeps the accepting session. The sweep test already passes: the
 * shed core of 8.5h sweeps twice.
 */
// Load-bearing import order (design D1): the telemetry harness registers before
// anything that loads `@tayzu/auth` creates its logger.
import {
  linkLogEvents,
  registration,
  type TelemetryTestHarness,
} from '../__fixtures__/link-telemetry.js';
import { randomUUID } from 'node:crypto';

import { createRouterClient } from '@orpc/server';
import { authSchema, createAuth, type AuthInstance } from '@tayzu/auth';
import { createCerbosClient } from '@tayzu/authz';
import { createUserSync, type UserSync } from '@tayzu/catalog';
import { runMigrations } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bootstrapTestTenant,
  createAdminUser,
  signInAdminUser,
  testAppPool,
} from '../../../../packages/auth/src/__fixtures__/admin-user.js';
import {
  startOidcStub,
  type OidcStub,
} from '../../../../packages/auth/src/__fixtures__/oidc-stub.js';
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
import {
  AUTH_BASE_URL,
  MARKER_PREFIX,
  ORIGIN,
  PROVIDER_ID,
  oidcRoundTrip,
  poolFailing,
  randomIp,
  setsSessionCookie,
  type Handler,
} from '../__fixtures__/sso-shed.js';
import { createIdentityRouter } from '../identity-router.js';
import { createApp, type App } from '../server.js';
import { createAcceptFlow } from './accept-flow.js';
import { createAuthRepository } from './auth-repository.js';
import { runWithIdentityContext } from './identity-context.js';
import { createSsoLinkShed } from './sso-link-shed.js';
import { createUserSyncAdapter } from './user-sync-adapter.js';
import { createWithUserLock, type WithUserLock } from './user-lock.js';

const REVOKED_EVENT = 'auth.security.session_revoked';
const SHED_EVENT = 'catalog.security.sso_link_shed';
const REVOCATION_FAILED_EVENT = 'catalog.security.accepting_session_revocation_failed';
const ACCOUNT_UPDATE = /update\s+"?auth"?\."?account"?(\s|$)/i;
const SESSION_DELETE = /delete\s+from\s+"?auth"?\."?session"?(\s|$)/i;
const sharedCerbos = createCerbosClient({ address: 'localhost:3593', tls: false });

interface Tenant {
  readonly tenantId: string;
  readonly adminId: string;
  readonly cookie: string;
}

interface Person {
  readonly userId: string;
  readonly email: string;
}

interface Invitation {
  readonly invitationId: string;
  readonly token: string;
}

type StepSeam = (step: string) => void | Promise<void>;

interface ApiSurface {
  createInvitation(args: {
    body: { email: string; role: 'member' | 'admin'; organizationId: string };
    headers: Headers;
  }): Promise<{ id: string; expiresAt: Date | string }>;
  addMember(args: {
    body: { userId: string; role: 'member' | 'admin'; organizationId: string };
  }): Promise<unknown>;
}

interface AuthDbSeam {
  /** Awaited once, after the next `UPDATE auth.account` statement completed. */
  afterAccountUpdate: (() => Promise<void>) | undefined;
  /**
   * While true, the row that an `UPDATE auth.account ... RETURNING` statement hands
   * back has a null id, so that no account id can be recorded for the request
   * (the statement itself still runs).
   */
  hideAccountId: boolean;
}

function textOf(args: readonly unknown[]): string {
  const [first] = args;
  if (typeof first === 'string') return first;
  const text = (first as { text?: unknown } | null | undefined)?.text;
  return typeof text === 'string' ? text : '';
}

/** Sets the `id` column of every returned row of a `pg` result to null (array or object rows). */
function blankIdColumn(result: unknown): void {
  const { rows, fields } = result as {
    rows?: unknown[];
    fields?: { name: string }[];
  };
  const index = fields?.findIndex((field) => field.name === 'id') ?? -1;
  for (const row of rows ?? []) {
    if (Array.isArray(row)) {
      if (index >= 0) row[index] = null;
    } else if (typeof row === 'object' && row !== null) {
      (row as Record<string, unknown>)['id'] = null;
    }
  }
}

/** The pool of the Better Auth instance, with the account-update seams. */
function seamedPool(pool: Pool, seam: AuthDbSeam): Pool {
  return new Proxy(pool, {
    get(target, property) {
      if (property === 'query') {
        return async (...args: unknown[]): Promise<unknown> => {
          const isAccountUpdate = ACCOUNT_UPDATE.test(textOf(args));
          const result = await (target.query as (...a: unknown[]) => Promise<unknown>).apply(
            target,
            args,
          );
          if (isAccountUpdate && seam.hideAccountId) {
            blankIdColumn(result);
          }
          if (isAccountUpdate && seam.afterAccountUpdate !== undefined) {
            const hold = seam.afterAccountUpdate;
            seam.afterAccountUpdate = undefined;
            await hold();
          }
          return result;
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

describe('The session paths that the shed still missed are closed (task 8.5k)', () => {
  let harness: TelemetryTestHarness;
  let authPool: Pool;
  let auth: AuthInstance;
  let api: ApiSurface;
  let app: App;
  let stub: OidcStub;
  let catalogSync: UserSync;
  let adapter: ReturnType<typeof createUserSyncAdapter>;
  let shedCore: ReturnType<typeof createSsoLinkShed>;
  let client: ReturnType<
    typeof createRouterClient<ReturnType<typeof createIdentityRouter>, Record<string, unknown>>
  >;
  const seam: AuthDbSeam = { afterAccountUpdate: undefined, hideAccountId: false };

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
    stub = await startOidcStub();
    const sso = {
      discoveryUrl: stub.discoveryUrl,
      clientId: stub.clientId,
      clientSecret: stub.clientSecret,
    };
    catalogSync = createUserSync({ pool: pools.appPool, authz: sharedCerbos });
    adapter = createUserSyncAdapter({ userSync: catalogSync });
    shedCore = createSsoLinkShed({ authPool });
    auth = createAuth({
      db: drizzle(seamedPool(authPool, seam), { schema: authSchema }),
      secret: TEST_SECRET,
      baseURL: ORIGIN,
      trustedOrigins: [ORIGIN],
      sso,
      userSync: adapter,
      ssoLinkShed: shedCore.port,
    });
    api = auth.api as ApiSurface;
    client = createRouterClient(
      createIdentityRouter({
        auth,
        authz: sharedCerbos,
        authRepository: createAuthRepository(authPool),
        withUserLock: createWithUserLock(authPool),
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );
    app = await createApp({
      appPool: pools.appPool,
      authPool,
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: ['https://app.tayzu.test'],
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await stub.close();
  });

  function handler(): Handler {
    return (auth as unknown as { handler: Handler }).handler;
  }

  // ---- tenants, people, invitations ------------------------------------------------------

  async function freshTenant(): Promise<Tenant> {
    const id = randomUUID();
    const t = await bootstrapTestTenant(auth, {
      pool: testAppPool(),
      name: 'Shed Admin',
      email: `shed-admin-${id}@example.test`,
      password: TEST_PASSWORD,
      organizationName: 'Shed Org',
      organizationSlug: `shed-${id}`,
      ip: randomIp(),
    });
    return { tenantId: t.organizationId, adminId: t.userId, cookie: t.cookie };
  }

  async function singleTenantMember(tenant: Tenant): Promise<Person> {
    const person = await createAdminUser(auth, {
      name: 'Shed Member',
      email: `shed-member-${randomUUID()}@example.test`,
      password: TEST_PASSWORD,
    });
    await api.addMember({
      body: { userId: person.userId, organizationId: tenant.tenantId, role: 'member' },
    });
    return person;
  }

  async function invite(tenant: Tenant, email: string): Promise<Invitation> {
    const invitation = await runWithIdentityContext({ adminId: tenant.adminId }, () =>
      api.createInvitation({
        body: { email, role: 'member', organizationId: tenant.tenantId },
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

  function flowWith(onStep?: StepSeam) {
    return createAcceptFlow({
      auth,
      authz: sharedCerbos,
      authRepository: createAuthRepository(authPool),
      authPool,
      userSync: adapter,
      ssoLinkShed: shedCore,
      ...(onStep === undefined ? {} : { onStep }),
    });
  }

  // ---- links and sign-ins ----------------------------------------------------------------------

  async function adminLink(tenant: Tenant, person: Person, sub: string): Promise<void> {
    await client.identity.users.linkSsoAccount(
      { params: { user: person.email }, body: { subject: sub } },
      {
        context: {
          tenantId: tenant.tenantId,
          actor: { type: 'user', id: `caller-${randomUUID()}` },
          principal: { roles: ['admin'] },
        },
      },
    );
  }

  /** A link that pre-dates this change, seeded directly with no marker. */
  async function seedUnmarkedLink(userId: string, sub: string): Promise<string> {
    const id = randomUUID();
    await authPool.query(
      `insert into auth.account (id, account_id, provider_id, user_id, created_at, updated_at)
       values ($1, $2, $3, $4, now(), now())`,
      [id, sub, PROVIDER_ID, userId],
    );
    return id;
  }

  async function seedMember(tenantId: string, userId: string): Promise<void> {
    await authPool.query(
      `insert into auth.member (id, organization_id, user_id, role, created_at)
       values ($1, $2, $3, 'member', now())`,
      [randomUUID(), tenantId, userId],
    );
  }

  function setSubject(sub: string, email: string): void {
    stub.setSubject({
      sub,
      email,
      name: 'Shed Member',
      sid: `sid-${randomUUID()}`,
      claims: { email_verified: true },
    });
  }

  async function selfLink(cookie: string, person: Person, sub: string): Promise<Response> {
    setSubject(sub, person.email);
    return (await oidcRoundTrip(handler(), '/link-social', cookie)).response;
  }

  async function signInThrough(
    sub: string,
    email: string,
  ): Promise<{ response: Response; cookie: string; ok: boolean }> {
    setSubject(sub, email);
    const { response, cookie } = await oidcRoundTrip(handler(), '/sign-in/social', '');
    return {
      response,
      cookie,
      ok: setsSessionCookie(response) || cookie.includes('session_token'),
    };
  }

  /** The rejection of a callback for a `sub` that no account carries: the uniform one. */
  async function uniformRejection(): Promise<{ status: number; body: string }> {
    const { response, ok } = await signInThrough(
      `unlinked-${randomUUID()}`,
      `nobody-${randomUUID()}@example.test`,
    );
    expect(ok, 'precondition: an unlinked sub creates no session').toBe(false);
    return { status: response.status, body: await response.text() };
  }

  async function expectUniformRejection(refused: Response): Promise<void> {
    const reference = await uniformRejection();
    expect(refused.status, 'the callback fails with its uniform status').toBe(reference.status);
    expect(await refused.text(), 'and its uniform body').toBe(reference.body);
  }

  async function passwordSession(person: Person): Promise<string> {
    return (
      await signInAdminUser(auth, { email: person.email, password: TEST_PASSWORD, ip: randomIp() })
    ).cookie;
  }

  async function ownUnlink(cookie: string, accountRowId: string): Promise<Response> {
    return handler()(
      new Request(`${AUTH_BASE_URL}/unlink-account`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': randomIp(),
          origin: ORIGIN,
          cookie,
        },
        body: JSON.stringify({ accountId: accountRowId }),
      }),
    );
  }

  // ---- reads -------------------------------------------------------------------------------------

  async function accountsOf(
    userId: string,
  ): Promise<readonly { id: string; account_id: string }[]> {
    const result = await authPool.query<{ id: string; account_id: string }>(
      `select id, account_id from auth.account where user_id = $1 and provider_id <> 'credential'`,
      [userId],
    );
    return result.rows;
  }

  async function markerFor(accountRowId: string): Promise<number> {
    const result = await authPool.query<{ n: string }>(
      `select count(*)::text as n from auth.verification where identifier = $1`,
      [`${MARKER_PREFIX}${accountRowId}`],
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  async function sessionCount(userId: string): Promise<number> {
    const result = await authPool.query<{ n: string }>(
      `select count(*)::text as n from auth.session where user_id = $1`,
      [userId],
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  async function membersOf(tenantId: string, userId: string): Promise<number> {
    const result = await authPool.query(
      `select id from auth.member where organization_id = $1 and user_id = $2`,
      [tenantId, userId],
    );
    return result.rowCount ?? 0;
  }

  async function emailVerified(userId: string): Promise<boolean> {
    const result = await authPool.query<{ email_verified: boolean }>(
      'select email_verified from auth."user" where id = $1',
      [userId],
    );
    return result.rows[0]?.email_verified === true;
  }

  async function tokenStillVerifies(invitation: Invitation): Promise<boolean> {
    const result = await authPool.query<{ value: string }>(
      `select value from auth.verification where identifier = $1`,
      [`invitation-accept:${invitation.invitationId}`],
    );
    return (
      result.rows.length === 1 &&
      verifyInvitationToken(invitation.token, result.rows[0]?.value ?? null)
    );
  }

  async function userStatus(tenantId: string, email: string): Promise<string | undefined> {
    return (await catalogSync.getUser({ tenantId, email }))?.status;
  }

  async function revokedEvents(userId: string) {
    return (await linkLogEvents(harness, REVOKED_EVENT)).filter(
      (record) =>
        record.attributes['tayzu.actor.id'] === userId &&
        record.attributes['tayzu.auth.revocation.reason'] === 'sso_link_shed',
    );
  }

  async function shedEventsOf(userId: string) {
    return (await linkLogEvents(harness, SHED_EVENT)).filter(
      (record) => record.attributes['tayzu.identity.user.id'] === userId,
    );
  }

  async function sessionAlive(cookie: string): Promise<{ alive: boolean; id?: string }> {
    const response = await handler()(
      new Request(`${AUTH_BASE_URL}/get-session`, {
        method: 'GET',
        headers: { cookie, 'x-forwarded-for': randomIp() },
      }),
    );
    if (response.status !== 200) return { alive: false };
    const body = (await response.json().catch(() => null)) as {
      session?: { id?: string };
    } | null;
    const id = body?.session?.id;
    return id === undefined ? { alive: false } : { alive: true, id };
  }

  async function v1Status(cookie: string): Promise<number> {
    const response = await app.app.inject({
      method: 'GET',
      url: '/v1/blueprints',
      headers: { cookie },
    });
    return response.statusCode;
  }

  /** A single-tenant member of `t1` with an admin-recorded link and an SSO session minted through it. */
  async function linkedMemberWithSsoSession(t1: Tenant) {
    const person = await singleTenantMember(t1);
    const sub = `shed-sub-${randomUUID()}`;
    await adminLink(t1, person, sub);
    const signedIn = await signInThrough(sub, person.email);
    expect(signedIn.ok, 'precondition: the sign-in through the link created a session').toBe(true);
    expect((await sessionAlive(signedIn.cookie)).alive, 'precondition: the SSO session works').toBe(
      true,
    );
    return { person, sub, ssoCookie: signedIn.cookie };
  }

  /** Arms the seam that holds the next callback right after its account update completed. */
  function holdNextAccountUpdate(): { reached: Promise<void>; release: () => void } {
    let release: () => void = () => undefined;
    let fireReached: () => void = () => undefined;
    const reached = new Promise<void>((resolve, reject) => {
      fireReached = resolve;
      setTimeout(() => {
        reject(new Error('the callback never updated its account'));
      }, 20_000).unref();
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
      setTimeout(resolve, 40_000).unref();
    });
    seam.afterAccountUpdate = async () => {
      fireReached();
      await released;
    };
    return { reached, release };
  }

  // ---- scenario: A sign-in through a shed link creates no session -----------------------------------

  it('A sign-in through a shed link creates no session: a callback held between its account read and its session creation while the shed deletes the link fails with the uniform rejection and leaves no session row', async () => {
    const t1 = await freshTenant();
    const t2 = await freshTenant();
    const person = await singleTenantMember(t1);
    const sub = `shed-sub-${randomUUID()}`;
    await adminLink(t1, person, sub);
    expect(await accountsOf(person.userId), 'precondition: the admin link exists').toHaveLength(1);

    const held = holdNextAccountUpdate();
    const inFlight = signInThrough(sub, person.email);
    let outcome: Awaited<typeof inFlight>;
    try {
      await held.reached;
      // The callback has read and refreshed the account; now the user joins t2 and the hook sheds.
      await api.addMember({
        body: { userId: person.userId, organizationId: t2.tenantId, role: 'member' },
      });
      expect(
        await accountsOf(person.userId),
        'precondition: the shed deleted the link',
      ).toHaveLength(0);
    } finally {
      seam.afterAccountUpdate = undefined;
      held.release();
      outcome = await inFlight;
    }

    expect(outcome.ok, 'no session cookie is set').toBe(false);
    expect(await sessionCount(person.userId), 'no session row exists').toBe(0);
    await expectUniformRejection(outcome.response);
  }, 90_000);

  it('A sign-in through a shed link creates no session: a callback through an unmarked link of a user of two tenants is refused, a /link-social of the same sub writes no marker, and after an unlink and a new /link-social the user signs in', async () => {
    const t1 = await freshTenant();
    const t2 = await freshTenant();
    const person = await singleTenantMember(t1);
    const sub = `shed-sub-${randomUUID()}`;
    // A link that pre-dates this change, then the second membership seeded directly so no shed ran.
    const legacyRow = await seedUnmarkedLink(person.userId, sub);
    await seedMember(t2.tenantId, person.userId);
    const sessionsBefore = await sessionCount(person.userId);

    const first = await signInThrough(sub, person.email);
    expect(first.ok, 'the unmarked link of a two-tenant user creates no session').toBe(false);
    expect(await sessionCount(person.userId)).toBe(sessionsBefore);
    await expectUniformRejection(first.response);

    // A /link-social of the same sub updates the existing row and never creates one.
    const cookie = await passwordSession(person);
    const sessionsWithPassword = await sessionCount(person.userId);
    await selfLink(cookie, person, sub);
    const rows = await accountsOf(person.userId);
    expect(
      rows.map((row) => row.id),
      'the same row, no new one',
    ).toEqual([legacyRow]);
    expect(await markerFor(legacyRow), 'the re-link wrote no marker').toBe(0);
    const second = await signInThrough(sub, person.email);
    expect(second.ok, 'the callback is still refused').toBe(false);
    expect(await sessionCount(person.userId)).toBe(sessionsWithPassword);

    // The repair: an unlink, then a link.
    expect((await ownUnlink(cookie, legacyRow)).status, 'the unlink succeeds').toBe(200);
    expect(await accountsOf(person.userId), 'precondition: the legacy link is gone').toHaveLength(
      0,
    );
    await selfLink(cookie, person, sub);
    const relinked = await accountsOf(person.userId);
    expect(relinked).toHaveLength(1);
    expect(await markerFor(relinked[0]?.id ?? ''), 'the new link has a marker').toBe(1);
    const third = await signInThrough(sub, person.email);
    expect(third.ok, 'the marked link signs in').toBe(true);
    expect((await sessionAlive(third.cookie)).alive).toBe(true);
  }, 90_000);

  it('A sign-in through a shed link creates no session: a callback for which no account id was recorded is refused the same way with no session row', async () => {
    const t1 = await freshTenant();
    const person = await singleTenantMember(t1);
    const cookie = await passwordSession(person);
    const sub = `shed-sub-${randomUUID()}`;
    await selfLink(cookie, person, sub);
    const [row] = await accountsOf(person.userId);
    expect(await markerFor(row?.id ?? ''), 'precondition: a marked link').toBe(1);
    const sessionsBefore = await sessionCount(person.userId);

    seam.hideAccountId = true;
    let suppressed: Awaited<ReturnType<typeof signInThrough>>;
    try {
      suppressed = await signInThrough(sub, person.email);
    } finally {
      seam.hideAccountId = false;
    }

    expect(suppressed.ok, 'no session cookie is set').toBe(false);
    expect(await sessionCount(person.userId), 'no session row was written').toBe(sessionsBefore);
    await expectUniformRejection(suppressed.response);
  }, 90_000);

  it('A sign-in through a shed link creates no session: a callback through a marked link of a user of two tenants succeeds', async () => {
    const t1 = await freshTenant();
    const t2 = await freshTenant();
    const person = await singleTenantMember(t1);
    const cookie = await passwordSession(person);
    const sub = `shed-sub-${randomUUID()}`;
    await selfLink(cookie, person, sub);
    await api.addMember({
      body: { userId: person.userId, organizationId: t2.tenantId, role: 'member' },
    });
    const [row] = await accountsOf(person.userId);
    expect(await markerFor(row?.id ?? ''), 'precondition: the marked link survived the join').toBe(
      1,
    );

    const signedIn = await signInThrough(sub, person.email);

    expect(signedIn.ok).toBe(true);
    expect((await sessionAlive(signedIn.cookie)).alive).toBe(true);
  }, 90_000);

  // ---- scenario: A session created during the shed is swept -------------------------------------------

  it('A session created during the shed is swept: a session inserted between the first sweep and the deletion commit is revoked by the second sweep, with the event emitted', async () => {
    const t1 = await freshTenant();
    const t2 = await freshTenant();
    const { person, ssoCookie } = await linkedMemberWithSsoSession(t1);
    await seedMember(t2.tenantId, person.userId);
    let injectedToken: string | undefined;
    const realLock = createWithUserLock(authPool);
    const lock: WithUserLock = (userId, fn) =>
      realLock(userId, async (tx) => {
        const result = await fn(tx);
        // The first sweep has run inside this transaction; the commit has not happened.
        injectedToken = `injected-${randomUUID()}`;
        await authPool.query(
          `insert into auth.session (id, expires_at, token, created_at, updated_at, user_id)
           values ($1, now() + interval '1 day', $2, now(), now(), $3)`,
          [randomUUID(), injectedToken, userId],
        );
        return result;
      });
    const seamed = createSsoLinkShed({ authPool, withUserLock: lock });
    await harness.reset();

    const result = await seamed.shed({
      tenantId: t2.tenantId,
      userId: person.userId,
      path: 'membership_hook',
    });

    expect(injectedToken, 'the seam ran').toBeDefined();
    expect(await sessionCount(person.userId), 'the injected session is gone').toBe(0);
    expect((await sessionAlive(ssoCookie)).alive).toBe(false);
    expect(result.revokedSessions, 'both sessions are counted').toBe(2);
    expect(await revokedEvents(person.userId), 'one event per revoked session').toHaveLength(2);
  }, 90_000);

  // ---- scenario: The accepting session is revoked when the shed removed a link --------------------------

  it('The accepting session is revoked when the shed removed a link: revoked after the _user step and before the emailVerified write and the token consumption, the acceptance succeeds and the user signs in again', async () => {
    const t1 = await freshTenant();
    const t2 = await freshTenant();
    const { person } = await linkedMemberWithSsoSession(t1);
    await authPool.query('update auth."user" set email_verified = false where id = $1', [
      person.userId,
    ]);
    const invitation = await invite(t2, person.email);
    const acceptingCookie = await passwordSession(person);
    const accepting = await sessionAlive(acceptingCookie);
    expect(await v1Status(acceptingCookie), 'precondition: the session reaches /v1').toBe(200);
    await harness.reset();
    const seen: Record<
      string,
      { alive: boolean; verified: boolean; tokenIntact: boolean; status: string | undefined }
    > = {};
    const order: string[] = [];

    const result = await flowWith(async (step) => {
      order.push(step);
      if (step !== 'user_step' && step !== 'email_verified' && step !== 'consume') return;
      seen[step] = {
        alive: (await sessionAlive(acceptingCookie)).alive,
        verified: await emailVerified(person.userId),
        tokenIntact: await tokenStillVerifies(invitation),
        status: await userStatus(t2.tenantId, person.email),
      };
    }).accept({
      ...invitation,
      session: { userId: person.userId, sessionId: accepting.id ?? '' },
    });

    expect(result.userId, 'the acceptance succeeds').toBe(person.userId);
    expect(order.indexOf('user_step')).toBeLessThan(order.indexOf('email_verified'));
    expect(order.indexOf('email_verified')).toBeLessThan(order.indexOf('consume'));
    expect(seen['user_step']?.alive, 'kept until the _user step has run').toBe(true);
    expect(seen['email_verified']?.status, 'the _user step has run').toBe('Active');
    expect(seen['email_verified']?.alive, 'revoked as soon as the _user step has run').toBe(false);
    expect(seen['email_verified']?.verified, 'before the emailVerified write').toBe(false);
    expect(seen['email_verified']?.tokenIntact, 'before the consumption').toBe(true);
    expect(seen['consume']?.alive).toBe(false);
    expect(await emailVerified(person.userId), 'the email is verified at the end').toBe(true);
    expect(await tokenStillVerifies(invitation), 'the token is consumed at the end').toBe(false);
    expect((await sessionAlive(acceptingCookie)).alive, 'the session fails get-session').toBe(
      false,
    );
    expect(await v1Status(acceptingCookie), 'and a /v1 call').toBeGreaterThanOrEqual(400);
    expect(
      await revokedEvents(person.userId),
      'one event for the SSO session, one for the accepting session',
    ).toHaveLength(2);
    expect(
      (await sessionAlive(await passwordSession(person))).alive,
      'the user signs in again',
    ).toBe(true);
  }, 90_000);

  it('The accepting session is revoked when the shed removed a link: an acceptance by a user whose only link they made keeps its session', async () => {
    const t1 = await freshTenant();
    const t2 = await freshTenant();
    const person = await singleTenantMember(t1);
    const cookie = await passwordSession(person);
    await selfLink(cookie, person, `shed-sub-${randomUUID()}`);
    expect(await accountsOf(person.userId), 'precondition: a made link').toHaveLength(1);
    const invitation = await invite(t2, person.email);
    const accepting = await sessionAlive(cookie);
    await harness.reset();

    await flowWith().accept({
      ...invitation,
      session: { userId: person.userId, sessionId: accepting.id ?? '' },
    });

    expect(await userStatus(t2.tenantId, person.email)).toBe('Active');
    expect((await sessionAlive(cookie)).alive, 'the accepting session keeps working').toBe(true);
    expect(await v1Status(cookie)).toBe(200);
    expect(await shedEventsOf(person.userId)).toHaveLength(0);
    expect(await revokedEvents(person.userId)).toHaveLength(0);
  }, 90_000);

  // ---- scenario: A failed revocation of the accepting session is logged ---------------------------------

  it('A failed revocation of the accepting session is logged: the join is not undone, the acceptance completes and the event carries opaque ids only', async () => {
    const t1 = await freshTenant();
    const t2 = await freshTenant();
    const person = await singleTenantMember(t1);
    await adminLink(t1, person, `shed-sub-${randomUUID()}`);
    const invitation = await invite(t2, person.email);
    const cookie = await passwordSession(person);
    const accepting = await sessionAlive(cookie);
    let failSessionDeletes = false;
    const failing = poolFailing(
      authPool,
      (text) => failSessionDeletes && SESSION_DELETE.test(text),
    );
    const failingShed = createSsoLinkShed({ authPool: failing });
    await harness.reset();

    const result = await createAcceptFlow({
      auth,
      authz: sharedCerbos,
      authRepository: createAuthRepository(failing),
      authPool: failing,
      userSync: adapter,
      ssoLinkShed: failingShed,
      onStep: (step) => {
        // The shed step and its sweeps have run by the time the _user step begins.
        if (step === 'user_step') failSessionDeletes = true;
      },
    }).accept({
      ...invitation,
      session: { userId: person.userId, sessionId: accepting.id ?? '' },
    });

    expect(result.userId, 'the acceptance completes').toBe(person.userId);
    expect(await membersOf(t2.tenantId, person.userId), 'the join is not undone').toBe(1);
    expect(await userStatus(t2.tenantId, person.email)).toBe('Active');
    expect(await tokenStillVerifies(invitation), 'the token is consumed').toBe(false);
    expect(await accountsOf(person.userId), 'the link was shed').toHaveLength(0);
    const events = await linkLogEvents(harness, REVOCATION_FAILED_EVENT);
    expect(events, 'the failure is logged once').toHaveLength(1);
    expect(events[0]?.attributes['tayzu.tenant.id']).toBe(t2.tenantId);
    expect(events[0]?.attributes['tayzu.identity.invitation.id']).toBe(invitation.invitationId);
    expect(events[0]?.attributes['tayzu.identity.user.id']).toBe(person.userId);
    const serialized = JSON.stringify(events[0]?.attributes);
    expect(serialized, 'no email in the event').not.toContain(person.email);
    expect(serialized, 'no token in the event').not.toContain(invitation.token);
  }, 90_000);

  // ==== Task 8.5m: a retried acceptance revokes the session an earlier attempt's shed kept ====
  //
  // Scenarios: "A retried acceptance revokes the session an earlier attempt's shed kept" and
  // "An attempt that fails after its _user step has already revoked the sessions".
  //
  // Seams (all outside production code): the acceptance's `onStep` throws at a chosen step
  // (a failure at the `_user` step or at the `emailVerified` write, or a resend replacing the
  // token digest right before the consumption); a pool that fails `DELETE FROM auth.session`
  // once the `_user` step begins.
  //
  // Production symbols expected:
  // - `apps/api/src/identity/sso-link-shed.ts`: `shed()` on an acceptance-path removal writes,
  //   in the `withUserLock` transaction, one `auth.verification` row with the identifier
  //   `invitation-shed:<invitationId>`, the kept session row id as its value and the
  //   invitation's expiry (it needs the invitation id in `ShedInput`, here as
  //   `invitationId`), after deleting every row with that identifier; `revokeSession` stays.
  // - `apps/api/src/identity/accept-flow.ts`: right after the `_user` step, whenever its own
  //   shed removed a link or the record exists, revokes its own session and the recorded one
  //   through the shed core and deletes the record after a successful revocation; a failed
  //   revocation emits `catalog.security.accepting_session_revocation_failed` and keeps the
  //   record.

  const SHED_RECORD_PREFIX = 'invitation-shed:';

  const failAt =
    (target: string): StepSeam =>
    (step) => {
      if (step === target) throw new Error(`injected failure at ${target}`);
    };

  async function shedRecords(
    invitationId: string,
  ): Promise<readonly { value: string; expires_at: Date }[]> {
    const result = await authPool.query<{ value: string; expires_at: Date }>(
      'select value, expires_at from auth.verification where identifier = $1',
      [`${SHED_RECORD_PREFIX}${invitationId}`],
    );
    return result.rows;
  }

  async function tokenExpiry(invitationId: string): Promise<Date | undefined> {
    const result = await authPool.query<{ expires_at: Date }>(
      'select expires_at from auth.verification where identifier = $1',
      [`invitation-accept:${invitationId}`],
    );
    return result.rows[0]?.expires_at;
  }

  async function seedAdminLink(userId: string): Promise<void> {
    await seedUnmarkedLink(userId, `shed-sub-${randomUUID()}`);
  }

  /**
   * A user of `t1` with an unmarked link, an invitation of `t2`, a password session A,
   * and a first attempt with A that sheds the link and fails at the `_user` step.
   */
  async function afterFailedFirstAttempt() {
    const t1 = await freshTenant();
    const t2 = await freshTenant();
    const person = await singleTenantMember(t1);
    await adminLink(t1, person, `shed-sub-${randomUUID()}`);
    const invitation = await invite(t2, person.email);
    const cookieA = await passwordSession(person);
    const sessionA = (await sessionAlive(cookieA)).id ?? '';
    expect(sessionA, 'precondition: a session A').not.toBe('');
    await expect(
      flowWith(failAt('user_step')).accept({
        ...invitation,
        session: { userId: person.userId, sessionId: sessionA },
      }),
    ).rejects.toThrow();
    expect(
      await accountsOf(person.userId),
      'precondition: the first attempt shed the link',
    ).toEqual([]);
    return { t2, person, invitation, cookieA, sessionA };
  }

  async function sessionOf(person: Person): Promise<{ cookie: string; id: string }> {
    const cookie = await passwordSession(person);
    return { cookie, id: (await sessionAlive(cookie)).id ?? '' };
  }

  it("A retried acceptance revokes the session an earlier attempt's shed kept: the first attempt leaves the record naming its kept session, and the retry with the same session revokes it, emits the event and deletes the record", async () => {
    const { t2, person, invitation, cookieA, sessionA } = await afterFailedFirstAttempt();
    const records = await shedRecords(invitation.invitationId);
    expect(records, 'one record after the failed first attempt').toHaveLength(1);
    expect(records[0]?.value, 'it names the kept session row id').toBe(sessionA);
    expect(records[0]?.value, 'and never the session token').not.toContain('.');
    expect(records[0]?.expires_at.getTime(), 'it expires with the invitation (its token row)').toBe(
      (await tokenExpiry(invitation.invitationId))?.getTime(),
    );
    expect((await sessionAlive(cookieA)).alive, 'the kept session still works').toBe(true);
    await harness.reset();

    const result = await flowWith().accept({
      ...invitation,
      session: { userId: person.userId, sessionId: sessionA },
    });

    expect(result.userId).toBe(person.userId);
    expect(await userStatus(t2.tenantId, person.email)).toBe('Active');
    expect((await sessionAlive(cookieA)).alive, 'the session fails get-session').toBe(false);
    expect(await v1Status(cookieA), 'and a /v1 call').toBeGreaterThanOrEqual(400);
    expect(await revokedEvents(person.userId), 'the event is emitted').toHaveLength(1);
    expect(await shedRecords(invitation.invitationId), 'the record is gone').toHaveLength(0);
  }, 90_000);

  it("A retried acceptance revokes the session an earlier attempt's shed kept: the retry made with a new session signed in after the first attempt revokes both that session and the first attempt's", async () => {
    const { t2, person, invitation, cookieA, sessionA } = await afterFailedFirstAttempt();
    const b = await sessionOf(person);
    expect(b.id, 'precondition: a new session B').not.toBe(sessionA);
    await harness.reset();

    const result = await flowWith().accept({
      ...invitation,
      session: { userId: person.userId, sessionId: b.id },
    });

    expect(result.userId).toBe(person.userId);
    expect(await userStatus(t2.tenantId, person.email)).toBe('Active');
    expect((await sessionAlive(cookieA)).alive, "the first attempt's session is revoked").toBe(
      false,
    );
    expect((await sessionAlive(b.cookie)).alive, "and so is the retry's").toBe(false);
    expect(await v1Status(b.cookie)).toBeGreaterThanOrEqual(400);
    expect(await revokedEvents(person.userId), 'one event for each').toHaveLength(2);
    expect(await shedRecords(invitation.invitationId)).toHaveLength(0);
  }, 90_000);

  it("A retried acceptance revokes the session an earlier attempt's shed kept: a second attempt whose shed removes a link recorded again, and that also fails at the _user step, leaves exactly one record naming the second attempt's session", async () => {
    const { person, invitation, sessionA } = await afterFailedFirstAttempt();
    await seedAdminLink(person.userId);
    const b = await sessionOf(person);

    await expect(
      flowWith(failAt('user_step')).accept({
        ...invitation,
        session: { userId: person.userId, sessionId: b.id },
      }),
    ).rejects.toThrow();

    const records = await shedRecords(invitation.invitationId);
    expect(records, 'exactly one record').toHaveLength(1);
    expect(records[0]?.value, "it names the second attempt's session").toBe(b.id);
    expect(records[0]?.value).not.toBe(sessionA);
  }, 90_000);

  it("A retried acceptance revokes the session an earlier attempt's shed kept: an acceptance whose attempts never removed a link writes no record and keeps its session", async () => {
    const t1 = await freshTenant();
    const t2 = await freshTenant();
    const person = await singleTenantMember(t1);
    const cookie = await passwordSession(person);
    await selfLink(cookie, person, `shed-sub-${randomUUID()}`);
    expect(await accountsOf(person.userId), 'precondition: a link the user made').toHaveLength(1);
    const invitation = await invite(t2, person.email);
    const accepting = (await sessionAlive(cookie)).id ?? '';
    await expect(
      flowWith(failAt('user_step')).accept({
        ...invitation,
        session: { userId: person.userId, sessionId: accepting },
      }),
    ).rejects.toThrow();
    expect(await shedRecords(invitation.invitationId), 'no record after a failed attempt').toEqual(
      [],
    );
    await harness.reset();

    await flowWith().accept({
      ...invitation,
      session: { userId: person.userId, sessionId: accepting },
    });

    expect(await shedRecords(invitation.invitationId), 'no record after the retry').toEqual([]);
    expect((await sessionAlive(cookie)).alive, 'the session is kept').toBe(true);
    expect(await v1Status(cookie)).toBe(200);
    expect(await revokedEvents(person.userId)).toHaveLength(0);
  }, 90_000);

  it("A retried acceptance revokes the session an earlier attempt's shed kept: a revocation that fails leaves the record in place and emits the failure event", async () => {
    const { t2, person, invitation, cookieA, sessionA } = await afterFailedFirstAttempt();
    let failSessionDeletes = false;
    const failing = poolFailing(
      authPool,
      (text) => failSessionDeletes && SESSION_DELETE.test(text),
    );
    await harness.reset();

    const result = await createAcceptFlow({
      auth,
      authz: sharedCerbos,
      authRepository: createAuthRepository(failing),
      authPool: failing,
      userSync: adapter,
      ssoLinkShed: createSsoLinkShed({ authPool: failing }),
      onStep: (step) => {
        if (step === 'user_step') failSessionDeletes = true;
      },
    }).accept({
      ...invitation,
      session: { userId: person.userId, sessionId: sessionA },
    });

    expect(result.userId, 'the acceptance still completes').toBe(person.userId);
    expect(await userStatus(t2.tenantId, person.email)).toBe('Active');
    expect(await shedRecords(invitation.invitationId), 'the record stays').toHaveLength(1);
    expect((await sessionAlive(cookieA)).alive, 'the session was not revoked').toBe(true);
    const events = await linkLogEvents(harness, REVOCATION_FAILED_EVENT);
    expect(events.length, 'the failure is logged').toBeGreaterThanOrEqual(1);
    expect(events[0]?.attributes['tayzu.identity.invitation.id']).toBe(invitation.invitationId);
    expect(events[0]?.attributes['tayzu.identity.user.id']).toBe(person.userId);
  }, 90_000);

  it('An attempt that fails after its _user step has already revoked the sessions: an attempt that sheds and fails at the emailVerified write has revoked its own session and the recorded one, the events are emitted and the record is gone, and a retry with a new session revokes nothing more and completes', async () => {
    const { t2, person, invitation, cookieA } = await afterFailedFirstAttempt();
    await seedAdminLink(person.userId);
    const b = await sessionOf(person);
    await harness.reset();

    await expect(
      flowWith(failAt('email_verified')).accept({
        ...invitation,
        session: { userId: person.userId, sessionId: b.id },
      }),
    ).rejects.toThrow();

    expect((await sessionAlive(b.cookie)).alive, 'its own session is already revoked').toBe(false);
    expect((await sessionAlive(cookieA)).alive, "and the earlier attempt's").toBe(false);
    expect(await revokedEvents(person.userId), 'one event for each').toHaveLength(2);
    expect(await shedRecords(invitation.invitationId), 'the record is gone').toHaveLength(0);
    expect(await userStatus(t2.tenantId, person.email), 'the join is not undone').toBe('Active');
    expect(await tokenStillVerifies(invitation), 'the token is not consumed').toBe(true);

    const c = await sessionOf(person);
    await harness.reset();
    const result = await flowWith().accept({
      ...invitation,
      session: { userId: person.userId, sessionId: c.id },
    });

    expect(result.userId, 'the retry completes').toBe(person.userId);
    expect(await revokedEvents(person.userId), 'and revokes nothing more').toHaveLength(0);
    expect((await sessionAlive(c.cookie)).alive, 'its session is kept').toBe(true);
    expect(await tokenStillVerifies(invitation), 'the token is consumed').toBe(false);
  }, 90_000);

  it('An attempt that fails after its _user step has already revoked the sessions: an attempt whose own shed removes nothing but finds the record has revoked its own session and the recorded one before failing at the emailVerified write', async () => {
    const { person, invitation, cookieA } = await afterFailedFirstAttempt();
    const b = await sessionOf(person);
    await harness.reset();

    await expect(
      flowWith(failAt('email_verified')).accept({
        ...invitation,
        session: { userId: person.userId, sessionId: b.id },
      }),
    ).rejects.toThrow();

    expect((await sessionAlive(b.cookie)).alive, 'its own session is already revoked').toBe(false);
    expect((await sessionAlive(cookieA)).alive, 'and the recorded one').toBe(false);
    expect(await revokedEvents(person.userId), 'one event for each').toHaveLength(2);
    expect(await shedRecords(invitation.invitationId), 'the record is gone').toHaveLength(0);
    expect(await tokenStillVerifies(invitation), 'the token is not consumed').toBe(true);
  }, 90_000);

  it('An attempt that fails after its _user step has already revoked the sessions: a consumption that deletes zero rows because a resend replaced the digest fails as a lost race with the sessions revoked and the record gone', async () => {
    const { person, invitation, cookieA } = await afterFailedFirstAttempt();
    const b = await sessionOf(person);
    await harness.reset();

    await expect(
      flowWith(async (step) => {
        if (step === 'consume') {
          await authPool.query('update auth.verification set value = $2 where identifier = $1', [
            `invitation-accept:${invitation.invitationId}`,
            digestInvitationToken(generateInvitationToken()),
          ]);
        }
      }).accept({
        ...invitation,
        session: { userId: person.userId, sessionId: b.id },
      }),
    ).rejects.toMatchObject({ code: 'CATALOG_NOT_FOUND' });

    const denied = (
      await linkLogEvents(harness, 'catalog.security.invitation_acceptance_denied')
    ).filter(
      (record) => record.attributes['tayzu.identity.invitation.id'] === invitation.invitationId,
    );
    expect(denied).toHaveLength(1);
    expect(denied[0]?.attributes['tayzu.identity.invitation.denial_reason']).toBe(
      'consume_conflict',
    );
    expect((await sessionAlive(b.cookie)).alive, 'its own session is revoked').toBe(false);
    expect((await sessionAlive(cookieA)).alive, 'and the recorded one').toBe(false);
    expect(await shedRecords(invitation.invitationId), 'the record is gone').toHaveLength(0);
  }, 90_000);
});
