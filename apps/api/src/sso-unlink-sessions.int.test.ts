/**
 * Task 8.5j of openspec/changes/043-identity-lifecycle-and-org-admin (Resolved
 * decision Q86; design D4 step 7 and D24).
 *
 * An admin `unlinkSsoAccount` revokes every session of the target user through the
 * internal adapter (`listSessions` and `deleteUserSessions`), because a session
 * already issued through the link would otherwise outlive the unlink. Each
 * revocation emits `auth.security.session_revoked` with the reason `sso_link_shed`
 * (through the exported `emitSessionRevoked`).
 *
 * Verify clause, one test each:
 * - a session minted through the link before an admin unlink is rejected after it
 *   (`/api/auth/get-session` and a `/v1` call);
 * - the user's session on a second device is gone too;
 * - the event is emitted with the reason;
 * - the unlink of a link that does not exist revokes nothing.
 *
 * ## Harness
 *
 * A real `createApp` with SSO pointed at the local OIDC stub; `app.auth` is the
 * Better Auth instance under test and `/v1` is answered by `app.app.inject`. The
 * admin unlink goes through `createIdentityRouter` over `app.auth`, as
 * `account-linking.int.test.ts` does. SSO sessions are minted by actual sign-ins
 * through the stub against an admin-recorded link. Every Better Auth request
 * carries a fresh random `x-forwarded-for`; every test uses a fresh tenant and
 * fresh users.
 *
 * ## Production symbols expected
 *
 * Nothing new is imported. The `unlinkSsoAccount` handler in
 * `apps/api/src/identity-router.ts` must, when it deleted at least one SSO link,
 * list the target user's sessions (`internalAdapter.listSessions`), delete them
 * (`internalAdapter.deleteUserSessions`) and call `emitSessionRevoked` from
 * `@tayzu/auth` once per revoked session with `{ actorId: <user id>, reason:
 * 'sso_link_shed' }`. When the user has no SSO link it revokes nothing.
 *
 * ## Why this fails right now
 *
 * The handler only deletes the account rows: the sessions survive, so
 * `get-session` and `/v1` still answer and no `session_revoked` event is emitted.
 */
// Load-bearing import order (design D1): the telemetry harness registers before
// anything that loads `@tayzu/auth` creates its logger.
import {
  linkLogEvents,
  registration,
  type TelemetryTestHarness,
} from './__fixtures__/link-telemetry.js';
import { randomUUID } from 'node:crypto';

import { createRouterClient } from '@orpc/server';
import { createCerbosClient } from '@tayzu/authz';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bootstrapTestTenant,
  createAdminUser,
  signInAdminUser,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { startOidcStub, type OidcStub } from '../../../packages/auth/src/__fixtures__/oidc-stub.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { harnessPools } from './__fixtures__/pools.js';
import {
  AUTH_BASE_URL,
  oidcRoundTrip,
  randomIp,
  setsSessionCookie,
  type Handler,
} from './__fixtures__/sso-shed.js';
import { createAuthRepository } from './identity/auth-repository.js';
import { createWithUserLock } from './identity/user-lock.js';
import { createIdentityRouter } from './identity-router.js';
import { createApp, type App } from './server.js';

import type { Pool } from 'pg';

const REVOKED_EVENT = 'auth.security.session_revoked';
const ORIGIN = 'http://localhost:3000';

interface MemberSurface {
  addMember(args: {
    body: { userId: string; organizationId: string; role: string };
  }): Promise<unknown>;
}

interface Tenant {
  readonly tenantId: string;
}

interface Person {
  readonly userId: string;
  readonly email: string;
}

describe('An admin SSO unlink revokes every session of the user (task 8.5j, Q86)', () => {
  let harness: TelemetryTestHarness;
  let authPool: Pool;
  let app: App;
  let stub: OidcStub;
  let client: ReturnType<
    typeof createRouterClient<ReturnType<typeof createIdentityRouter>, Record<string, unknown>>
  >;

  beforeAll(async () => {
    if ('error' in registration) {
      throw new Error(`createTelemetryTestHarness() failed: ${String(registration.error)}`, {
        cause: registration.error,
      });
    }
    harness = registration.harness;
    const pools = await harnessPools();
    authPool = pools.authPool;
    stub = await startOidcStub();
    app = await createApp({
      ...pools,
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ORIGIN],
      sso: {
        discoveryUrl: stub.discoveryUrl,
        clientId: stub.clientId,
        clientSecret: stub.clientSecret,
      },
    });
    client = createRouterClient(
      createIdentityRouter({
        auth: app.auth,
        authz: createCerbosClient({ address: 'localhost:3593', tls: false }),
        authRepository: createAuthRepository(authPool),
        withUserLock: createWithUserLock(authPool),
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await stub.close();
  }, 60_000);

  function handler(): Handler {
    return (app.auth as unknown as { handler: Handler }).handler;
  }

  async function freshTenant(): Promise<Tenant> {
    const id = randomUUID();
    const t = await bootstrapTestTenant(app.auth, {
      name: 'Unlink Admin',
      email: `unlink-admin-${id}@example.test`,
      password: TEST_PASSWORD,
      organizationName: 'Unlink Org',
      organizationSlug: `unlink-${id}`,
      ip: randomIp(),
    });
    return { tenantId: t.organizationId };
  }

  /** A user who is a member of `tenant` only, with a password. */
  async function member(tenant: Tenant): Promise<Person> {
    const email = `unlink-member-${randomUUID()}@example.test`;
    const person = await createAdminUser(app.auth, {
      name: 'Unlink Member',
      email,
      password: TEST_PASSWORD,
    });
    await (app.auth.api as MemberSurface).addMember({
      body: { userId: person.userId, organizationId: tenant.tenantId, role: 'member' },
    });
    return { userId: person.userId, email };
  }

  function adminContext(tenant: Tenant): Record<string, unknown> {
    return {
      tenantId: tenant.tenantId,
      actor: { type: 'user', id: `caller-${randomUUID()}` },
      principal: { roles: ['admin'] },
    };
  }

  async function adminLink(tenant: Tenant, person: Person, sub: string): Promise<void> {
    await client.identity.users.linkSsoAccount(
      { user: person.email, subject: sub },
      { context: adminContext(tenant) },
    );
  }

  async function adminUnlink(tenant: Tenant, person: Person): Promise<void> {
    await client.identity.users.unlinkSsoAccount(
      { user: person.email },
      { context: adminContext(tenant) },
    );
  }

  /** A sign-in through the provider with `sub`; returns the session cookie. */
  async function ssoSession(sub: string, email: string): Promise<string> {
    stub.setSubject({
      sub,
      email,
      name: 'Unlink Member',
      sid: `sid-${randomUUID()}`,
      claims: { email_verified: true },
    });
    const { response, cookie } = await oidcRoundTrip(handler(), '/sign-in/social', '');
    expect(
      setsSessionCookie(response) || cookie.includes('session_token'),
      'precondition: the SSO sign-in created a session',
    ).toBe(true);
    return cookie;
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

  async function sessionCount(userId: string): Promise<number> {
    const result = await authPool.query<{ n: string }>(
      `select count(*)::text as n from auth.session where user_id = $1`,
      [userId],
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  async function revokedEventsAbout(userId: string) {
    return (await linkLogEvents(harness, REVOKED_EVENT)).filter(
      (record) => record.attributes['tayzu.actor.id'] === userId,
    );
  }

  it('A session minted through the link before an admin unlink is rejected after it, by get-session and by /v1', async () => {
    const tenant = await freshTenant();
    const person = await member(tenant);
    const sub = `unlink-sub-${randomUUID()}`;
    await adminLink(tenant, person, sub);
    const cookie = await ssoSession(sub, person.email);
    expect(await sessionAlive(cookie), 'precondition: get-session works').toBe(true);
    expect(await v1Status(cookie), 'precondition: /v1 works').toBe(200);

    await adminUnlink(tenant, person);

    expect(await sessionAlive(cookie), 'get-session rejects the session').toBe(false);
    expect(await v1Status(cookie), '/v1 rejects the session').toBeGreaterThanOrEqual(400);
    expect(await sessionCount(person.userId), 'no session row remains').toBe(0);
  }, 60_000);

  it("The user's session on a second device is gone too, whatever way it was created", async () => {
    const tenant = await freshTenant();
    const person = await member(tenant);
    const sub = `unlink-sub-${randomUUID()}`;
    await adminLink(tenant, person, sub);
    const firstDevice = await ssoSession(sub, person.email);
    const secondDevice = await ssoSession(sub, person.email);
    const passwordDevice = (
      await signInAdminUser(app.auth, {
        email: person.email,
        password: TEST_PASSWORD,
        ip: randomIp(),
      })
    ).cookie;
    expect(await sessionCount(person.userId), 'precondition: three sessions').toBe(3);

    await adminUnlink(tenant, person);

    expect(await sessionAlive(firstDevice)).toBe(false);
    expect(await sessionAlive(secondDevice)).toBe(false);
    expect(await sessionAlive(passwordDevice), 'every session of the user, not only SSO ones').toBe(
      false,
    );
    expect(await sessionCount(person.userId)).toBe(0);
  }, 60_000);

  it('Each revocation emits auth.security.session_revoked with the reason sso_link_shed', async () => {
    const tenant = await freshTenant();
    const person = await member(tenant);
    const sub = `unlink-sub-${randomUUID()}`;
    await adminLink(tenant, person, sub);
    await ssoSession(sub, person.email);
    await ssoSession(sub, person.email);
    expect(await sessionCount(person.userId), 'precondition: two sessions').toBe(2);
    await harness.reset();

    await adminUnlink(tenant, person);

    const events = await revokedEventsAbout(person.userId);
    expect(events, 'one event per revoked session').toHaveLength(2);
    for (const event of events) {
      expect(event.attributes['tayzu.auth.revocation.reason']).toBe('sso_link_shed');
      const serialized = JSON.stringify(event.attributes);
      expect(serialized, 'no email in the event').not.toContain(person.email);
      expect(serialized, 'no sub in the event').not.toContain(sub);
    }
  }, 60_000);

  it('The unlink of a link that does not exist revokes nothing and emits nothing', async () => {
    const tenant = await freshTenant();
    const person = await member(tenant);
    const cookie = (
      await signInAdminUser(app.auth, {
        email: person.email,
        password: TEST_PASSWORD,
        ip: randomIp(),
      })
    ).cookie;
    expect(await sessionAlive(cookie), 'precondition: the session works').toBe(true);
    const before = await sessionCount(person.userId);
    expect(before).toBeGreaterThan(0);
    await harness.reset();

    await adminUnlink(tenant, person);

    expect(await sessionCount(person.userId), 'no session was revoked').toBe(before);
    expect(await sessionAlive(cookie), 'the session still works').toBe(true);
    expect(await revokedEventsAbout(person.userId), 'no event').toHaveLength(0);
  }, 60_000);
});
