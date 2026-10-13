/**
 * Task 8.5h of openspec/changes/043-identity-lifecycle-and-org-admin (Resolved
 * decisions Q73, Q86, Q87, Q105, Q112, Q114, Q120 and Q122; design D4 step 7).
 *
 * Scenarios (from the spec, "An SSO link that its user did not make does not
 * survive into a second tenant"):
 * - "An SSO link its user did not make does not survive into a second tenant"
 * - "A session established through a shed link cannot reach the joined tenant"
 * - "A retried acceptance still sheds the link and revokes the sessions"
 * - "A link the user made survives"
 * - "A link that pre-dates the marker is treated as admin-recorded"
 * - "A marker does not outlive its link" (the shed's own deletion)
 * - "The user can link again"
 * - "The acceptance holds back only its own member's hooks" (the shed's half)
 *
 * Not covered here, by the task's own split: the interleavings of a link and a
 * join (`sso-link-race.int.test.ts`), the wiring of `createApp` (`user-sync-wiring`),
 * the revocation of the accepting session right after the `_user` step (8.5k) and
 * the step-up in front of `/link-social` (`link-social-step-up.int.test.ts`; the
 * Better Auth handler is called directly here, as in `sso-link-provenance`).
 *
 * ## Harness
 *
 * One Better Auth instance is built with `createAuth({ ..., sso, userSync,
 * ssoLinkShed })`: `userSync` is the real `UserSyncAdapter` over the catalog's
 * `createUserSync`, `ssoLinkShed` is the port of the shed core built on the
 * `tayzu_auth` pool. The shed core's pool is wrapped so that a test can make its
 * deletion of `account` rows fail. A real `createApp` answers the `/v1` calls
 * (`app.app.inject`) over the same database and secret. Every Better Auth request
 * carries a fresh random `x-forwarded-for`; every test uses fresh tenants (each
 * with a real admin as the inviter) and fresh users. SSO sessions are minted by
 * an actual sign-in through the local OIDC stub against an admin-recorded link.
 *
 * ## Production symbols expected (none exists yet)
 *
 * - `apps/api/src/identity/sso-link-shed.ts` exports
 *   `createSsoLinkShed({ authPool, withUserLock? })` returning the shed core
 *   `{ shed(input), port }`:
 *   - `shed({ tenantId, userId, path, keepSessionId? })` with `path` one of
 *     `acceptance`, `membership_hook`, `reconcile`: inside `withUserLock` (default
 *     `createWithUserLock(authPool)`), whenever the user holds a membership in
 *     another tenant than `tenantId`, deletes every non-`credential` account without a marker (and any
 *     marker keyed by the rows it deletes), emits `catalog.security.sso_link_shed`
 *     (`tayzu.tenant.id`, `tayzu.identity.user.id`, `tayzu.identity.sso_link.path`)
 *     once, and, when it removed a link, deletes every `session` row of the user
 *     except `keepSessionId`, emitting `auth.security.session_revoked` (the
 *     exported `emitSessionRevoked`, actor id the user id, reason `sso_link_shed`)
 *     for each, then sweeps the sessions a second time after the commit. Its
 *     result is `{ removedLinks, revokedSessions }`. It builds no Better Auth
 *     instance and reads no `BETTER_AUTH_SECRET`.
 *   - `port` is the `SsoLinkShedPort` (`packages/auth/src/identity/ports.ts`,
 *     `shed({ tenantId, userId }): Promise<void>`) for `createAuth`'s option
 *     `ssoLinkShed`: it reads `currentAcceptanceContext()` and returns without
 *     shedding only for the acceptance's own `(tenantId, userId)`, otherwise it
 *     sheds with the path `membership_hook`.
 * - `createAuth` takes the option `ssoLinkShed`; `afterAddMember` calls the port
 *   before its `_user` write.
 * - `createAcceptFlow` takes the option `ssoLinkShed` (the shed core) and runs
 *   `shed({ tenantId, userId, path: 'acceptance', keepSessionId })` in its
 *   `shed` step of every existing-account attempt, before the `user_step`.
 *
 * ## Why this fails right now
 *
 * `./sso-link-shed.js` does not exist.
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
import { toOrpcError } from '../error-mapping.js';
import { createIdentityRouter } from '../identity-router.js';
import { createApp, type App } from '../server.js';
import { createAcceptFlow } from './accept-flow.js';
import { createAuthRepository, type AuthRepository } from './auth-repository.js';
import { runWithIdentityContext } from './identity-context.js';
import { createSsoLinkShed } from './sso-link-shed.js';
import { createUserSyncAdapter } from './user-sync-adapter.js';
import { createWithUserLock } from './user-lock.js';

const SHED_EVENT = 'catalog.security.sso_link_shed';
const REVOKED_EVENT = 'auth.security.session_revoked';
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

describe('An SSO link its user did not make does not survive into a second tenant (task 8.5h)', () => {
  let harness: TelemetryTestHarness;
  let authPool: Pool;
  let auth: AuthInstance;
  let api: ApiSurface;
  let app: App;
  let stub: OidcStub;
  let catalogSync: UserSync;
  let repository: AuthRepository;
  let adapter: ReturnType<typeof createUserSyncAdapter>;
  let shedCore: ReturnType<typeof createSsoLinkShed>;
  let client: ReturnType<
    typeof createRouterClient<ReturnType<typeof createIdentityRouter>, Record<string, unknown>>
  >;

  /** While true, the shed core's deletion of `account` rows fails. */
  let failShedDeletes = false;
  /** Tenants whose membership deletion (the acceptance's compensation) fails. */
  const failingMemberDeletes = new Set<string>();
  /** A seam run by the membership hook's shed port before it sheds (task 11.8); unset elsewhere. */
  let beforeHookShed: (() => Promise<void>) | undefined;

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
    shedCore = createSsoLinkShed({
      authPool: poolFailing(
        authPool,
        (text) => failShedDeletes && /delete\s+from\s+"?auth"?\."?account"?(\s|$)/i.test(text),
      ),
    });
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      baseURL: ORIGIN,
      trustedOrigins: [ORIGIN],
      sso,
      userSync: adapter,
      ssoLinkShed: {
        ...shedCore.port,
        shed: async (input: Parameters<typeof shedCore.port.shed>[0]) => {
          await beforeHookShed?.();
          return shedCore.port.shed(input);
        },
      },
    });
    api = auth.api as ApiSurface;
    const real = createAuthRepository(authPool);
    repository = {
      ...real,
      deleteMember: async (tenantId, memberId) => {
        if (failingMemberDeletes.has(tenantId)) throw new Error('member delete unavailable');
        return await real.deleteMember(tenantId, memberId);
      },
    };
    client = createRouterClient(
      createIdentityRouter({
        auth,
        authz: sharedCerbos,
        authRepository: real,
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

  /** A user who is a member of `tenant` only (the hook writes the `Active` `_user`). */
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
      authRepository: repository,
      authPool,
      userSync: adapter,
      ssoLinkShed: shedCore,
      ...(onStep === undefined ? {} : { onStep }),
    });
  }

  // ---- links ---------------------------------------------------------------------------------

  /** The link an admin of the user's tenant records (`linkSsoAccount`): no marker. */
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

  /** A link that pre-dates this change (or whose marker a crash lost), seeded directly. */
  async function seedUnmarkedLink(userId: string, sub: string): Promise<string> {
    const id = randomUUID();
    await authPool.query(
      `insert into auth.account (id, account_id, provider_id, user_id, created_at, updated_at)
       values ($1, $2, $3, $4, now(), now())`,
      [id, sub, PROVIDER_ID, userId],
    );
    return id;
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

  /** The user's own `/link-social` (carries a marker); returns the final response. */
  async function selfLink(cookie: string, person: Person, sub: string): Promise<Response> {
    setSubject(sub, person.email);
    return (await oidcRoundTrip(handler(), '/link-social', cookie)).response;
  }

  /** A sign-in through the provider with `sub`; the cookie is empty when no session was created. */
  async function ssoSignIn(sub: string, email: string): Promise<{ cookie: string; ok: boolean }> {
    setSubject(sub, email);
    const { response, cookie } = await oidcRoundTrip(handler(), '/sign-in/social', '');
    return { cookie, ok: setsSessionCookie(response) || cookie.includes('session_token') };
  }

  async function passwordSession(person: Person): Promise<string> {
    return (
      await signInAdminUser(auth, { email: person.email, password: TEST_PASSWORD, ip: randomIp() })
    ).cookie;
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

  async function markersOfUser(userId: string): Promise<number> {
    const result = await authPool.query<{ n: string }>(
      `select count(*)::text as n from auth.verification v
        where v.identifier in (select $2 || a.id from auth.account a where a.user_id = $1)`,
      [userId, MARKER_PREFIX],
    );
    return Number(result.rows[0]?.n ?? 0);
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

  async function seedMember(tenantId: string, userId: string): Promise<void> {
    await authPool.query(
      `insert into auth.member (id, organization_id, user_id, role, created_at)
       values ($1, $2, $3, 'member', now())`,
      [randomUUID(), tenantId, userId],
    );
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

  async function shedEvents(userId: string) {
    return (await linkLogEvents(harness, SHED_EVENT)).filter(
      (record) => record.attributes['tayzu.identity.user.id'] === userId,
    );
  }

  async function revokedEvents(userId: string) {
    return (await linkLogEvents(harness, REVOKED_EVENT)).filter(
      (record) =>
        record.attributes['tayzu.actor.id'] === userId &&
        record.attributes['tayzu.auth.revocation.reason'] === 'sso_link_shed',
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

  async function setActiveStatus(cookie: string, organizationId: string): Promise<number> {
    const response = await handler()(
      new Request(`${AUTH_BASE_URL}/organization/set-active`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': randomIp(),
          origin: ORIGIN,
          cookie,
        },
        body: JSON.stringify({ organizationId }),
      }),
    );
    return response.status;
  }

  async function v1Status(cookie: string): Promise<number> {
    const response = await app.app.inject({
      method: 'GET',
      url: '/v1/blueprints',
      headers: { cookie },
    });
    return response.statusCode;
  }

  async function failureOf(attempt: Promise<unknown>): Promise<{ code: string } | undefined> {
    try {
      await attempt;
      return undefined;
    } catch (error) {
      return toOrpcError(error);
    }
  }

  /** A single-tenant member of `t1` holding an admin-recorded link, with an SSO session minted through it. */
  async function linkedMemberWithSsoSession(t1: Tenant) {
    const person = await singleTenantMember(t1);
    const sub = `shed-sub-${randomUUID()}`;
    await adminLink(t1, person, sub);
    const signedIn = await ssoSignIn(sub, person.email);
    expect(signedIn.ok, 'precondition: the sign-in through the link created a session').toBe(true);
    expect((await sessionAlive(signedIn.cookie)).alive, 'precondition: the SSO session works').toBe(
      true,
    );
    expect(await v1Status(signedIn.cookie), 'precondition: the SSO session reaches /v1').toBe(200);
    return { person, sub, ssoCookie: signedIn.cookie };
  }

  // ---- scenario: the link does not survive -------------------------------------------------------

  it('An SSO link its user did not make does not survive into a second tenant: existing-account acceptance', async () => {
    const t1 = await freshTenant();
    const t2 = await freshTenant();
    const person = await singleTenantMember(t1);
    const sub = `shed-sub-${randomUUID()}`;
    await adminLink(t1, person, sub);
    expect(await accountsOf(person.userId), 'precondition: the admin link exists').toHaveLength(1);
    const invitation = await invite(t2, person.email);
    const cookie = await passwordSession(person);
    const session = await sessionAlive(cookie);

    await flowWith().accept({
      ...invitation,
      session: { userId: person.userId, sessionId: session.id ?? '' },
    });

    expect(await accountsOf(person.userId), 'the link is gone').toHaveLength(0);
    expect(await markersOfUser(person.userId), 'no marker is left').toBe(0);
    const events = await shedEvents(person.userId);
    expect(events, 'the event is emitted once').toHaveLength(1);
    expect(events[0]?.attributes['tayzu.tenant.id']).toBe(t2.tenantId);
    expect(events[0]?.attributes['tayzu.identity.sso_link.path']).toBe('acceptance');
    const serialized = JSON.stringify(events[0]?.attributes);
    expect(serialized, 'no email in the event').not.toContain(person.email);
    expect(serialized, 'no sub in the event').not.toContain(sub);
    const again = await ssoSignIn(sub, person.email);
    expect(again.ok, 'a sign-in through that sub no longer reaches the user').toBe(false);
  }, 60_000);

  it('An SSO link its user did not make does not survive into a second tenant: a membership added directly', async () => {
    const t1 = await freshTenant();
    const t2 = await freshTenant();
    const person = await singleTenantMember(t1);
    const sub = `shed-sub-${randomUUID()}`;
    await adminLink(t1, person, sub);

    await api.addMember({
      body: { userId: person.userId, organizationId: t2.tenantId, role: 'member' },
    });

    expect(await accountsOf(person.userId), 'the link is gone').toHaveLength(0);
    expect(await markersOfUser(person.userId), 'no marker is left').toBe(0);
    const events = await shedEvents(person.userId);
    expect(events, 'the event is emitted once').toHaveLength(1);
    expect(events[0]?.attributes['tayzu.tenant.id']).toBe(t2.tenantId);
    expect(events[0]?.attributes['tayzu.identity.sso_link.path']).toBe('membership_hook');
    expect(JSON.stringify(events[0]?.attributes)).not.toContain(person.email);
    expect((await ssoSignIn(sub, person.email)).ok, 'the sub no longer signs in').toBe(false);
  }, 60_000);

  it("A link the user made survives: a link made through /link-social keeps its marker and the user's sessions", async () => {
    const t1 = await freshTenant();
    const t2 = await freshTenant();
    const person = await singleTenantMember(t1);
    const cookie = await passwordSession(person);
    const sub = `shed-sub-${randomUUID()}`;
    await selfLink(cookie, person, sub);
    const [row] = await accountsOf(person.userId);
    expect(row, 'precondition: the self-service link exists').toBeDefined();
    expect(await markerFor(row?.id ?? ''), 'precondition: it carries a marker').toBe(1);
    const sessionsBefore = await sessionCount(person.userId);

    await api.addMember({
      body: { userId: person.userId, organizationId: t2.tenantId, role: 'member' },
    });

    expect(await accountsOf(person.userId), 'the link survives').toHaveLength(1);
    expect(await markerFor(row?.id ?? ''), 'its marker survives').toBe(1);
    expect(await shedEvents(person.userId), 'nothing is logged').toHaveLength(0);
    expect(await revokedEvents(person.userId), 'no session is revoked').toHaveLength(0);
    expect(await sessionCount(person.userId), 'the sessions are unchanged').toBe(sessionsBefore);
    expect((await sessionAlive(cookie)).alive).toBe(true);
  }, 60_000);

  it('A link that pre-dates the marker is treated as admin-recorded: seeded directly with no marker, it is shed at the next join', async () => {
    const t1 = await freshTenant();
    const t2 = await freshTenant();
    const person = await singleTenantMember(t1);
    const sub = `shed-sub-${randomUUID()}`;
    const rowId = await seedUnmarkedLink(person.userId, sub);
    expect(await markerFor(rowId), 'precondition: no marker').toBe(0);

    await api.addMember({
      body: { userId: person.userId, organizationId: t2.tenantId, role: 'member' },
    });

    expect(await accountsOf(person.userId), 'the link is shed').toHaveLength(0);
    expect(await shedEvents(person.userId)).toHaveLength(1);
  }, 60_000);

  it('A marker does not outlive its link: the shed keeps the marked link and its marker and deletes only the unmarked one', async () => {
    const t1 = await freshTenant();
    const t2 = await freshTenant();
    const person = await singleTenantMember(t1);
    const cookie = await passwordSession(person);
    const mineSub = `shed-sub-${randomUUID()}`;
    await selfLink(cookie, person, mineSub);
    const [mine] = await accountsOf(person.userId);
    const strayId = await seedUnmarkedLink(person.userId, `shed-stray-${randomUUID()}`);

    await api.addMember({
      body: { userId: person.userId, organizationId: t2.tenantId, role: 'member' },
    });

    const remaining = await accountsOf(person.userId);
    expect(remaining.map((row) => row.id)).toEqual([mine?.id]);
    expect(await markerFor(mine?.id ?? ''), 'the marker of the kept link is kept').toBe(1);
    expect(await markerFor(strayId), 'no marker is keyed by the deleted row').toBe(0);
    expect(await shedEvents(person.userId)).toHaveLength(1);
  }, 60_000);

  it('The user can link again: after the shed a /link-social of the same sub creates a link with a fresh marker', async () => {
    const t1 = await freshTenant();
    const t2 = await freshTenant();
    const person = await singleTenantMember(t1);
    const sub = `shed-sub-${randomUUID()}`;
    await adminLink(t1, person, sub);
    await api.addMember({
      body: { userId: person.userId, organizationId: t2.tenantId, role: 'member' },
    });
    expect(await accountsOf(person.userId), 'precondition: shed').toHaveLength(0);
    const cookie = await passwordSession(person);

    await selfLink(cookie, person, sub);

    const rows = await accountsOf(person.userId);
    expect(rows).toHaveLength(1);
    expect(await markerFor(rows[0]?.id ?? ''), 'the new link carries its own marker').toBe(1);
    expect(await shedEvents(person.userId), 'the new link is not shed again').toHaveLength(1);
  }, 60_000);

  // ---- scenario: sessions ---------------------------------------------------------------------------

  it('A session established through a shed link cannot reach the joined tenant: a membership added directly', async () => {
    const t1 = await freshTenant();
    const t2 = await freshTenant();
    const { person, ssoCookie } = await linkedMemberWithSsoSession(t1);
    const deviceCookie = await passwordSession(person);
    const sessionsBefore = await sessionCount(person.userId);
    await harness.reset();

    await api.addMember({
      body: { userId: person.userId, organizationId: t2.tenantId, role: 'member' },
    });

    expect((await sessionAlive(ssoCookie)).alive, 'the SSO session is revoked').toBe(false);
    expect((await sessionAlive(deviceCookie)).alive, 'every session of the user is revoked').toBe(
      false,
    );
    expect(await sessionCount(person.userId)).toBe(0);
    expect(await setActiveStatus(ssoCookie, t2.tenantId)).toBeGreaterThanOrEqual(400);
    expect(await v1Status(ssoCookie)).toBeGreaterThanOrEqual(400);
    expect(await revokedEvents(person.userId), 'one revocation event per session').toHaveLength(
      sessionsBefore,
    );
    const selfUnlinked = (await linkLogEvents(harness, 'auth.security.account_unlinked')).filter(
      (record) => record.attributes['tayzu.auth.link.actor'] === 'self',
    );
    expect(selfUnlinked, 'the shed is not a self unlink').toHaveLength(0);
  }, 60_000);

  it('A session established through a shed link cannot reach the joined tenant: acceptance, which completes on another session of the user', async () => {
    const t1 = await freshTenant();
    const t2 = await freshTenant();
    const { person, ssoCookie } = await linkedMemberWithSsoSession(t1);
    const invitation = await invite(t2, person.email);
    const acceptingCookie = await passwordSession(person);
    const accepting = await sessionAlive(acceptingCookie);
    await harness.reset();
    let acceptingAliveAfterShed: boolean | undefined;
    let eventsAfterShed: number | undefined;

    const result = await flowWith(async (step) => {
      if (step !== 'user_step') return;
      acceptingAliveAfterShed = (await sessionAlive(acceptingCookie)).alive;
      eventsAfterShed = (await revokedEvents(person.userId)).length;
    }).accept({
      ...invitation,
      session: { userId: person.userId, sessionId: accepting.id ?? '' },
    });

    expect(result.userId, 'the acceptance carried by another session completes').toBe(
      person.userId,
    );
    expect(acceptingAliveAfterShed, 'the shed step keeps the accepting session').toBe(true);
    expect(eventsAfterShed, 'the shed revoked the other session and emitted for it').toBe(1);
    expect((await sessionAlive(ssoCookie)).alive, 'the SSO session is revoked').toBe(false);
    expect(await setActiveStatus(ssoCookie, t2.tenantId)).toBeGreaterThanOrEqual(400);
    expect(await v1Status(ssoCookie)).toBeGreaterThanOrEqual(400);
    expect(await userStatus(t2.tenantId, person.email)).toBe('Active');
  }, 60_000);

  // ---- scenario: a joined tenant stays unreachable until the shed is done (task 11.8) ----------------------

  /**
   * Task 11.8, Resolved decision Q112; spec "A joined tenant stays unreachable until
   * the shed is done": a session minted through a link the user did not make switches
   * its active organization to the joined tenant while the membership exists and the
   * shed has not run, and calls a `/v1` route. The resolver rejects the call (401
   * `CATALOG_CONTEXT_REQUIRED`, the `_user` of the joined tenant not yet `Active`),
   * and once the shed has run that session is revoked.
   */
  async function reachJoinedTenant(
    ssoCookie: string,
    joinedTenantId: string,
  ): Promise<{ switched: number; status: number; code: unknown }> {
    const switched = await setActiveStatus(ssoCookie, joinedTenantId);
    const response = await app.app.inject({
      method: 'GET',
      url: '/v1/blueprints',
      headers: { cookie: ssoCookie },
    });
    return {
      switched,
      status: response.statusCode,
      code: response.json<{ code?: unknown }>().code,
    };
  }

  it('A joined tenant stays unreachable until the shed is done: an existing-account acceptance held between addMember and the shed', async () => {
    const t1 = await freshTenant();
    const t2 = await freshTenant();
    const { person, ssoCookie } = await linkedMemberWithSsoSession(t1);
    const invitation = await invite(t2, person.email);
    const acceptingCookie = await passwordSession(person);
    const accepting = await sessionAlive(acceptingCookie);
    let held:
      | { reach: Awaited<ReturnType<typeof reachJoinedTenant>>; userStatus: string | undefined }
      | undefined;

    await flowWith(async (step) => {
      if (step !== 'shed') return;
      // `addMember` has returned and the shed has not run.
      held = {
        reach: await reachJoinedTenant(ssoCookie, t2.tenantId),
        userStatus: await userStatus(t2.tenantId, person.email),
      };
    }).accept({ ...invitation, session: { userId: person.userId, sessionId: accepting.id ?? '' } });

    expect(held, 'the seam between addMember and the shed ran').toBeDefined();
    expect(held?.reach.switched, 'the membership exists, so the session can switch to t2').toBe(
      200,
    );
    expect(held?.userStatus, 'the _user of t2 is not Active yet').toBe('Invited');
    expect(held?.reach.status, 'the resolver rejects the call').toBe(401);
    expect(held?.reach.code).toBe('CATALOG_CONTEXT_REQUIRED');
    expect(
      (await sessionAlive(ssoCookie)).alive,
      'once the shed has run the session is revoked',
    ).toBe(false);
    expect(await userStatus(t2.tenantId, person.email)).toBe('Active');
  }, 60_000);

  it('A joined tenant stays unreachable until the shed is done: a membership added directly, whose _user is written only after the hook shed', async () => {
    const t1 = await freshTenant();
    const t2 = await freshTenant();
    const { person, ssoCookie } = await linkedMemberWithSsoSession(t1);
    let held:
      | { reach: Awaited<ReturnType<typeof reachJoinedTenant>>; userStatus: string | undefined }
      | undefined;
    beforeHookShed = async () => {
      // The membership row exists; the hook has neither shed nor written the `_user`.
      held = {
        reach: await reachJoinedTenant(ssoCookie, t2.tenantId),
        userStatus: await userStatus(t2.tenantId, person.email),
      };
    };
    try {
      await api.addMember({
        body: { userId: person.userId, organizationId: t2.tenantId, role: 'member' },
      });
    } finally {
      beforeHookShed = undefined;
    }

    expect(held, 'the seam before the hook shed ran').toBeDefined();
    expect(held?.reach.switched, 'the membership exists, so the session can switch to t2').toBe(
      200,
    );
    expect(held?.userStatus, 'no _user is written before the shed').toBeUndefined();
    expect(held?.reach.status, 'the resolver rejects the call').toBe(401);
    expect(held?.reach.code).toBe('CATALOG_CONTEXT_REQUIRED');
    expect(
      (await sessionAlive(ssoCookie)).alive,
      'once the shed has run the session is revoked',
    ).toBe(false);
    expect(await userStatus(t2.tenantId, person.email)).toBe('Active');
  }, 60_000);

  // ---- scenario: a retried acceptance -----------------------------------------------------------------

  it('A retried acceptance still sheds the link and revokes the sessions: the retry finds the membership already added and sheds before the token is consumed', async () => {
    const t1 = await freshTenant();
    const t2 = await freshTenant();
    const { person, ssoCookie, sub } = await linkedMemberWithSsoSession(t1);
    const invitation = await invite(t2, person.email);
    const acceptingCookie = await passwordSession(person);
    const accepting = await sessionAlive(acceptingCookie);
    const session = { userId: person.userId, sessionId: accepting.id ?? '' };

    // GIVEN a first attempt that fails after `addMember` inserted the member and before the
    // shed, and whose compensation fails too, so the membership stays.
    failingMemberDeletes.add(t2.tenantId);
    const first = await failureOf(
      flowWith((step) => {
        if (step === 'shed') throw new Error('injected failure before the shed');
      }).accept({ ...invitation, session }),
    );
    failingMemberDeletes.delete(t2.tenantId);
    expect(first?.code).toBe('INTERNAL');
    expect(await membersOf(t2.tenantId, person.userId), 'the membership stays').toBe(1);
    expect(await accountsOf(person.userId), 'the link is not shed yet').toHaveLength(1);
    expect(await shedEvents(person.userId)).toHaveLength(0);
    expect(await userStatus(t2.tenantId, person.email), 'the _user stays Invited').toBe('Invited');

    // WHEN the acceptance is retried with the same token.
    let atConsume:
      { linkGone: boolean; events: number; tokenIntact: boolean; ssoAlive: boolean } | undefined;
    await flowWith(async (step) => {
      if (step !== 'consume') return;
      atConsume = {
        linkGone: (await accountsOf(person.userId)).length === 0,
        events: (await shedEvents(person.userId)).length,
        tokenIntact: await tokenStillVerifies(invitation),
        ssoAlive: (await sessionAlive(ssoCookie)).alive,
      };
    }).accept({ ...invitation, session });

    // THEN the shed ran before the token was consumed.
    expect(atConsume, 'the retry reached the consumption').toBeDefined();
    expect(atConsume?.linkGone, 'the link was shed before the consumption').toBe(true);
    expect(atConsume?.events, 'the event was emitted before the consumption').toBe(1);
    expect(atConsume?.tokenIntact, 'the token was not yet consumed').toBe(true);
    expect(atConsume?.ssoAlive, "the user's other session was revoked").toBe(false);
    const events = await shedEvents(person.userId);
    expect(events).toHaveLength(1);
    expect(events[0]?.attributes['tayzu.identity.sso_link.path']).toBe('acceptance');
    expect(await tokenStillVerifies(invitation), 'the token is consumed at the end').toBe(false);
    expect(await userStatus(t2.tenantId, person.email)).toBe('Active');
    expect((await ssoSignIn(sub, person.email)).ok).toBe(false);
  }, 60_000);

  it('A retried acceptance still sheds the link and revokes the sessions: a shed that fails fails the attempt, leaves the token unconsumed and deletes the membership it created', async () => {
    const t1 = await freshTenant();
    const t2 = await freshTenant();
    const person = await singleTenantMember(t1);
    await adminLink(t1, person, `shed-sub-${randomUUID()}`);
    const invitation = await invite(t2, person.email);
    const cookie = await passwordSession(person);
    const session = { userId: person.userId, sessionId: (await sessionAlive(cookie)).id ?? '' };

    failShedDeletes = true;
    let failure: { code: string } | undefined;
    try {
      failure = await failureOf(flowWith().accept({ ...invitation, session }));
    } finally {
      failShedDeletes = false;
    }

    expect(failure?.code).toBe('INTERNAL');
    expect(await tokenStillVerifies(invitation), 'the token is not consumed').toBe(true);
    expect(
      await membersOf(t2.tenantId, person.userId),
      'the membership it created is deleted',
    ).toBe(0);
    expect(await accountsOf(person.userId), 'the link was not shed').toHaveLength(1);
    expect(await userStatus(t2.tenantId, person.email)).toBe('Invited');
  }, 60_000);

  it('A retried acceptance still sheds the link and revokes the sessions: a shed that fails with a failing compensation leaves the membership inert, the _user Invited and the token unconsumed', async () => {
    const t1 = await freshTenant();
    const t2 = await freshTenant();
    const person = await singleTenantMember(t1);
    await adminLink(t1, person, `shed-sub-${randomUUID()}`);
    const invitation = await invite(t2, person.email);
    const cookie = await passwordSession(person);
    const session = { userId: person.userId, sessionId: (await sessionAlive(cookie)).id ?? '' };

    failShedDeletes = true;
    failingMemberDeletes.add(t2.tenantId);
    let failure: { code: string } | undefined;
    try {
      failure = await failureOf(flowWith().accept({ ...invitation, session }));
    } finally {
      failShedDeletes = false;
      failingMemberDeletes.delete(t2.tenantId);
    }

    expect(failure?.code).toBe('INTERNAL');
    expect(await membersOf(t2.tenantId, person.userId), 'the membership is left').toBe(1);
    expect(await userStatus(t2.tenantId, person.email), 'the _user stays Invited').toBe('Invited');
    expect(await tokenStillVerifies(invitation)).toBe(true);
    expect(await accountsOf(person.userId)).toHaveLength(1);
  }, 60_000);

  it('A membership added directly whose hook shed fails leaves its _user unwritten: the hook sheds before its _user write', async () => {
    const t1 = await freshTenant();
    const t2 = await freshTenant();
    const person = await singleTenantMember(t1);
    await adminLink(t1, person, `shed-sub-${randomUUID()}`);
    expect(
      await userStatus(t2.tenantId, person.email),
      'precondition: no _user in t2',
    ).toBeUndefined();

    failShedDeletes = true;
    let failure: { code: string } | undefined;
    try {
      failure = await failureOf(
        api.addMember({
          body: { userId: person.userId, organizationId: t2.tenantId, role: 'member' },
        }),
      );
    } finally {
      failShedDeletes = false;
    }

    expect(failure, 'the failed shed fails the add').toBeDefined();
    expect(
      await userStatus(t2.tenantId, person.email),
      'the _user was not written',
    ).toBeUndefined();
    expect(await accountsOf(person.userId), 'the link was not shed').toHaveLength(1);
  }, 60_000);

  // ---- the core without Better Auth ----------------------------------------------------------------------

  it("The shed's deletes run on the tayzu_auth pool with no Better Auth instance: a core built with only that pool and no BETTER_AUTH_SECRET sheds the link and revokes the sessions", async () => {
    const t1 = await freshTenant();
    const t2 = await freshTenant();
    const { person, ssoCookie } = await linkedMemberWithSsoSession(t1);
    const deviceCookie = await passwordSession(person);
    // The membership of t2 is seeded directly, so that no hook runs.
    await seedMember(t2.tenantId, person.userId);
    const savedSecret = process.env['BETTER_AUTH_SECRET'];
    delete process.env['BETTER_AUTH_SECRET'];
    await harness.reset();

    try {
      const bare = createSsoLinkShed({ authPool });
      await bare.shed({ tenantId: t2.tenantId, userId: person.userId, path: 'reconcile' });
    } finally {
      if (savedSecret !== undefined) process.env['BETTER_AUTH_SECRET'] = savedSecret;
    }

    expect(await accountsOf(person.userId), 'the link is shed').toHaveLength(0);
    expect(await sessionCount(person.userId)).toBe(0);
    expect((await sessionAlive(ssoCookie)).alive, 'a revoked session fails get-session').toBe(
      false,
    );
    expect((await sessionAlive(deviceCookie)).alive).toBe(false);
    const events = await shedEvents(person.userId);
    expect(events).toHaveLength(1);
    expect(events[0]?.attributes['tayzu.identity.sso_link.path']).toBe('reconcile');
    expect(await revokedEvents(person.userId)).toHaveLength(2);
  }, 60_000);

  it('The shed of a single-tenant member leaves their links and sessions alone', async () => {
    const t1 = await freshTenant();
    const { person, ssoCookie } = await linkedMemberWithSsoSession(t1);

    await shedCore.shed({ tenantId: t1.tenantId, userId: person.userId, path: 'reconcile' });

    expect(await accountsOf(person.userId)).toHaveLength(1);
    expect((await sessionAlive(ssoCookie)).alive).toBe(true);
    expect(await shedEvents(person.userId)).toHaveLength(0);
  }, 60_000);

  // ---- the acceptance holds back only its own member's hooks ----------------------------------------------

  it("The acceptance holds back only its own member's hooks: another user's membership added inside the context is shed by its hook", async () => {
    const t1 = await freshTenant();
    const t2 = await freshTenant();
    const invitee = await singleTenantMember(t1);
    const other = await singleTenantMember(t1);
    await seedUnmarkedLink(other.userId, `shed-sub-${randomUUID()}`);
    const invitation = await invite(t2, invitee.email);
    const cookie = await passwordSession(invitee);
    const session = { userId: invitee.userId, sessionId: (await sessionAlive(cookie)).id ?? '' };

    await flowWith(async (step) => {
      if (step !== 'add_member') return;
      await api.addMember({
        body: { userId: other.userId, organizationId: t2.tenantId, role: 'member' },
      });
    }).accept({ ...invitation, session });

    expect(await accountsOf(other.userId), "the other user's link is shed").toHaveLength(0);
    const events = await shedEvents(other.userId);
    expect(events).toHaveLength(1);
    expect(events[0]?.attributes['tayzu.identity.sso_link.path']).toBe('membership_hook');
    expect(events[0]?.attributes['tayzu.tenant.id']).toBe(t2.tenantId);
  }, 60_000);

  it("The acceptance holds back only its own member's hooks: the same user's membership in another tenant is shed by its hook", async () => {
    const t1 = await freshTenant();
    const t2 = await freshTenant();
    const t3 = await freshTenant();
    const invitee = await singleTenantMember(t1);
    await seedUnmarkedLink(invitee.userId, `shed-sub-${randomUUID()}`);
    const invitation = await invite(t2, invitee.email);
    const cookie = await passwordSession(invitee);
    const session = { userId: invitee.userId, sessionId: (await sessionAlive(cookie)).id ?? '' };

    await flowWith(async (step) => {
      if (step !== 'add_member') return;
      await api.addMember({
        body: { userId: invitee.userId, organizationId: t3.tenantId, role: 'member' },
      });
    }).accept({ ...invitation, session });

    expect(await accountsOf(invitee.userId)).toHaveLength(0);
    const events = await shedEvents(invitee.userId);
    expect(events, 'shed once, by the hook of the other tenant').toHaveLength(1);
    expect(events[0]?.attributes['tayzu.identity.sso_link.path']).toBe('membership_hook');
    expect(events[0]?.attributes['tayzu.tenant.id']).toBe(t3.tenantId);
  }, 60_000);

  it("The acceptance holds back only its own member's hooks: its own member is shed only by the explicit step", async () => {
    const t1 = await freshTenant();
    const t2 = await freshTenant();
    const invitee = await singleTenantMember(t1);
    await seedUnmarkedLink(invitee.userId, `shed-sub-${randomUUID()}`);
    const invitation = await invite(t2, invitee.email);
    const cookie = await passwordSession(invitee);
    const session = { userId: invitee.userId, sessionId: (await sessionAlive(cookie)).id ?? '' };
    let atShedStep: { links: number; events: number } | undefined;

    await flowWith(async (step) => {
      if (step !== 'shed') return;
      // `addMember` has returned, so the hook has run for the acceptance's own member.
      atShedStep = {
        links: (await accountsOf(invitee.userId)).length,
        events: (await shedEvents(invitee.userId)).length,
      };
    }).accept({ ...invitation, session });

    expect(atShedStep?.links, 'the hook left the link to the explicit step').toBe(1);
    expect(atShedStep?.events).toBe(0);
    expect(await accountsOf(invitee.userId)).toHaveLength(0);
    const events = await shedEvents(invitee.userId);
    expect(events).toHaveLength(1);
    expect(events[0]?.attributes['tayzu.identity.sso_link.path']).toBe('acceptance');
    expect(events[0]?.attributes['tayzu.tenant.id']).toBe(t2.tenantId);
  }, 60_000);
});
