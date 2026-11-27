/**
 * Integration test for task 3.9 of `openspec/changes/archive/2026-11-27-003-catalog-ui-core` (design D8,
 * Resolved decision Q13; `specs/catalog-ui-core/spec.md`, requirement "The shell knows the
 * caller's session and enforces its gates"), the API side of `GET /v1/me`.
 *
 * Requirement, quoted: "The API MUST offer `GET /v1/me`, which reads only the caller's own
 * session, never a bearer token, and MUST NOT read a tenant, user or organization from its
 * path, query or body. For a valid session it MUST return the user's id, name and email, the
 * active organization's id and name, the member role, the sign-in method, whether a second
 * factor is enrolled, and the gate that applies: `password_expired` for an expired temporary
 * password, `password_change_required` for an unexpired one, `mfa_enrolment_required` for the
 * re-enrolment marker or for an admin or owner without an enrolled factor, or `none`. For no
 * session, an expired or idle session, a banned or disabled user, a tenant pending or past
 * deletion, or a session with no active organization, it MUST answer exactly like any other
 * `/v1` route without a context. A marker lookup that fails MUST fail closed."
 *
 * Scenarios, quoted:
 *
 * #### Scenario: A member reads their session
 * - GIVEN a signed-in member with no gate
 * - WHEN the app calls `GET /v1/me`
 * - THEN it receives the member's name, organization, role `member`, sign-in method and
 *   `gate: none`
 *
 * #### Scenario: A temporary password is a gate (API side)
 * - GIVEN a user signed in with an unexpired temporary password
 * - THEN ... `GET /v1/me` reports `password_change_required`
 *
 * #### Scenario: An admin without MFA must enrol (API side)
 * - GIVEN an admin with no enrolled factor
 * - WHEN they sign in
 * - THEN ... `GET /v1/me` reports `mfa_enrolment_required`
 *
 * #### Scenario: No session looks like any other missing context
 * - WHEN an anonymous client calls `GET /v1/me`
 * - THEN it receives the same `401 CATALOG_CONTEXT_REQUIRED` body as `GET /v1/blueprints`
 *
 * #### Scenario: A machine token is not a session
 * - GIVEN a valid machine access token
 * - WHEN it calls `GET /v1/me` as a bearer token
 * - THEN it receives the same `401 CATALOG_CONTEXT_REQUIRED` body as an anonymous client
 *
 * Design D8 adds: the body is `{ user: { id, name, email }, organization: { id, name }, role:
 * "owner" | "admin" | "member", signInMethod: "password" | "visma-connect", mfa: { enrolled:
 * boolean }, gate }` with `Cache-Control: no-store`; the gates apply in the order
 * `password_expired`, `password_change_required`, `mfa_enrolment_required`, `none`; "A failed
 * lookup fails closed (`401`)"; `signInMethod` is `visma-connect` when the session carries an
 * `ssoSid` and `password` otherwise.
 *
 * ## Production symbols expected (the red phase)
 *
 * - `GET /v1/me`, a plain Fastify route registered by `createApp` before the `/v1/*` catch-all,
 *   answering `200` with the D8 body and `Cache-Control: no-store`, or the catch-all's own
 *   `401 CATALOG_CONTEXT_REQUIRED` body. It is built on `createSessionStateResolver` of
 *   `@tayzu/auth` (see `packages/auth/src/session-state.int.test.ts`).
 * - Today the catch-all answers `/v1/me`: `404 NOT_FOUND` for a valid session. So every case
 *   that first proves a valid session answers `200` fails now. The two cases that have no
 *   valid session at all (an anonymous client, a machine token) already get the catch-all's
 *   `401`, which is exactly what the spec asks of the new route: they are guards that the route
 *   keeps that answer, and pass before it exists.
 *
 * ## Harness
 *
 * `createApp` over the harness pools, Cerbos on `localhost:3593`, and the local OIDC stub for
 * Visma Connect. Every request goes through Fastify (`app.app.inject`) with a fresh random
 * `x-forwarded-for`, except the OIDC round trip, which drives Better Auth's handler as the
 * SSO shed tests do. Each test has its own tenant and users. Markers, bans, statuses and
 * deletion markers are written directly, standing in for the operations that write them. The
 * resolver caches the `_user` state and the deletion marker for at most 5 seconds, so a case
 * that changes either after a first read moves `Date` (only `Date`) past that window.
 */
import { randomUUID } from 'node:crypto';

import { withTenantTransaction } from '@tayzu/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createAdminUser,
  seedUserRow,
  testAppPool,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { startOidcStub, type OidcStub } from '../../../packages/auth/src/__fixtures__/oidc-stub.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { createMachineCredential } from '../../../packages/auth/src/machine-credentials.js';
import { csrfHeaders } from './__fixtures__/csrf.js';
import { enrolledAdminSession } from './__fixtures__/fresh-mfa.js';
import { harnessPools, type HarnessPools } from './__fixtures__/pools.js';
import { ORIGIN, PROVIDER_ID, oidcRoundTrip, randomIp } from './__fixtures__/sso-shed.js';
import { createApp, type App } from './server.js';

const ME_PATH = '/v1/me';
const SENTINEL = '9999-12-31T23:59:59.000Z';
const HOUR_MS = 60 * 60 * 1000;
/** The resolver's cache window (5 s) plus margin. */
const PAST_CACHE_WINDOW_MS = 10_000;

type Gate = 'none' | 'password_change_required' | 'password_expired' | 'mfa_enrolment_required';
type Marker = 'temporary_password' | 'expired_temporary_password' | 'mfa_reenrol';

interface MeBody {
  readonly user: { readonly id: string; readonly name: string; readonly email: string };
  readonly organization: { readonly id: string; readonly name: string };
  readonly role: 'owner' | 'admin' | 'member';
  readonly signInMethod: 'password' | 'visma-connect';
  readonly mfa: { readonly enrolled: boolean };
  readonly gate: Gate;
}

interface Person {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
}

interface Organization {
  readonly id: string;
  readonly name: string;
  /** The creator, Better Auth role `owner`, with an Active `_user` and no factor. */
  readonly owner: Person;
}

interface MemberApiSurface {
  createOrganization(args: {
    body: { name: string; slug: string; userId: string };
  }): Promise<{ id: string }>;
  addMember(args: {
    body: { userId: string; organizationId: string; role: 'member' | 'admin' };
  }): Promise<unknown>;
}

interface MarkerAdapter {
  findOne(args: {
    readonly model: string;
    readonly where: readonly { readonly field: string; readonly value: string }[];
  }): Promise<unknown>;
}

function cookieFrom(setCookie: string | string[] | number | undefined): string {
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : typeof setCookie === 'string'
      ? [setCookie]
      : [];
  return cookies.map((raw) => raw.split(';')[0]).join('; ');
}

function handlerOf(app: App): (request: Request) => Promise<Response> {
  return (app.auth as unknown as { handler: (request: Request) => Promise<Response> }).handler;
}

describe('GET /v1/me: the shell view of its own session (003 task 3.9, design D8)', () => {
  let app: App;
  let pools: HarnessPools;
  let stub: OidcStub;
  let api: MemberApiSurface;

  beforeAll(async () => {
    pools = await harnessPools();
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
    api = app.auth.api as MemberApiSurface;
  }, 60_000);

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
    await stub.close();
  }, 60_000);

  // ---- Requests ----

  function me(headers: Record<string, string> = {}, url = ME_PATH) {
    return app.app.inject({
      method: 'GET',
      url,
      headers: { 'x-forwarded-for': randomIp(), ...headers },
    });
  }

  function blueprints(headers: Record<string, string> = {}) {
    return app.app.inject({
      method: 'GET',
      url: '/v1/blueprints',
      headers: { 'x-forwarded-for': randomIp(), ...headers },
    });
  }

  /** The reference answer: what any `/v1` route answers an anonymous client. */
  async function anonymousReference(): Promise<unknown> {
    const reference = await blueprints();
    expect(reference.statusCode, 'reference: anonymous GET /v1/blueprints').toBe(401);
    const body = reference.json<{ code?: unknown }>();
    expect(body.code).toBe('CATALOG_CONTEXT_REQUIRED');
    return body;
  }

  async function expectUniform401(response: Awaited<ReturnType<typeof me>>): Promise<void> {
    expect(response.statusCode, response.body).toBe(401);
    expect(response.json()).toEqual(await anonymousReference());
  }

  async function expectSession(
    cookie: string,
    gate: Gate,
  ): Promise<{ body: MeBody; response: Awaited<ReturnType<typeof me>> }> {
    const response = await me({ cookie });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<MeBody>();
    expect(body.gate).toBe(gate);
    return { body, response };
  }

  /** Signs in through Fastify, as the web app does. */
  async function signIn(email: string): Promise<string> {
    const response = await app.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': randomIp(),
        origin: ORIGIN,
        host: 'localhost:3000',
      },
      payload: JSON.stringify({ email, password: TEST_PASSWORD }),
    });
    expect(response.statusCode, response.body).toBe(200);
    const cookie = cookieFrom(response.headers['set-cookie']);
    expect(cookie, 'a session cookie is issued').toContain('session_token');
    return cookie;
  }

  // ---- Fixtures ----

  async function newOrganization(): Promise<Organization> {
    const id = randomUUID();
    const name = `Me Route Org ${id}`;
    const ownerName = `Me Route Owner ${id}`;
    const owner = await createAdminUser(app.auth, {
      name: ownerName,
      email: `me-route-owner-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    const organization = await api.createOrganization({
      body: { name, slug: `me-route-${id}`, userId: owner.userId },
    });
    await seedUserRow(testAppPool(), {
      tenantId: organization.id,
      email: owner.email,
      name: ownerName,
    });
    return {
      id: organization.id,
      name,
      owner: { userId: owner.userId, name: ownerName, email: owner.email },
    };
  }

  /** A new user who belongs to `organization` with `role` and an Active `_user` there. */
  async function newPerson(
    organization: Organization,
    role: 'member' | 'admin' = 'member',
  ): Promise<Person> {
    const id = randomUUID();
    const name = `Me Route ${role} ${id}`;
    const created = await createAdminUser(app.auth, {
      name,
      email: `me-route-${role}-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    await api.addMember({
      body: { userId: created.userId, organizationId: organization.id, role },
    });
    await seedUserRow(testAppPool(), { tenantId: organization.id, email: created.email, name });
    return { userId: created.userId, name, email: created.email };
  }

  async function writeMarker(userId: string, marker: Marker): Promise<void> {
    const identifier =
      marker === 'mfa_reenrol' ? `mfa-reenrol:${userId}` : `temp-password:${userId}`;
    const value =
      marker === 'mfa_reenrol'
        ? 'mfa-reenrol'
        : new Date(
            Date.now() + (marker === 'temporary_password' ? 48 * HOUR_MS : -HOUR_MS),
          ).toISOString();
    await pools.authPool.query(
      `insert into auth.verification (id, identifier, value, expires_at)
       values ($1, $2, $3, $4::timestamptz)`,
      [randomUUID(), identifier, value, SENTINEL],
    );
  }

  async function tokenOfCookie(cookie: string, userId: string): Promise<string> {
    const result = await pools.authPool.query<{ token: string }>(
      'select token from auth.session where user_id = $1',
      [userId],
    );
    const token = result.rows.find((row) => cookie.includes(row.token))?.token;
    if (token === undefined) throw new Error('the session row of the cookie is missing');
    return token;
  }

  function movePastCaches(): void {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + PAST_CACHE_WINDOW_MS });
  }

  // ---- Scenarios ----

  it('A member reads their session: the name, organization, role member, sign-in method and gate none', async () => {
    const organization = await newOrganization();
    const member = await newPerson(organization);
    const cookie = await signIn(member.email);

    const response = await me({ cookie });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      user: { id: member.userId, name: member.name, email: member.email },
      organization: { id: organization.id, name: organization.name },
      role: 'member',
      signInMethod: 'password',
      mfa: { enrolled: false },
      gate: 'none',
    });
  }, 60_000);

  it('the answer to a valid session carries Cache-Control: no-store', async () => {
    const organization = await newOrganization();
    const member = await newPerson(organization);

    const { response } = await expectSession(await signIn(member.email), 'none');

    expect(response.headers['cache-control']).toBe('no-store');
  }, 60_000);

  it('A temporary password is a gate (API side): a user signed in with an unexpired temporary password is reported password_change_required', async () => {
    const organization = await newOrganization();
    const person = await newPerson(organization);
    await writeMarker(person.userId, 'temporary_password');
    const cookie = await signIn(person.email);

    const { body } = await expectSession(cookie, 'password_change_required');

    expect(body.user.id).toBe(person.userId);
    expect(body.organization.id).toBe(organization.id);
  }, 60_000);

  it('An expired temporary password is reported password_expired', async () => {
    const organization = await newOrganization();
    const person = await newPerson(organization);
    const cookie = await signIn(person.email);
    await writeMarker(person.userId, 'expired_temporary_password');

    await expectSession(cookie, 'password_expired');
  }, 60_000);

  it('The re-enrolment marker is reported mfa_enrolment_required, for a member too', async () => {
    const organization = await newOrganization();
    const person = await newPerson(organization);
    const cookie = await signIn(person.email);
    await writeMarker(person.userId, 'mfa_reenrol');

    const { body } = await expectSession(cookie, 'mfa_enrolment_required');

    expect(body.role).toBe('member');
    expect(body.mfa).toEqual({ enrolled: false });
  }, 60_000);

  it('the gates apply in the order password_expired, password_change_required, mfa_enrolment_required', async () => {
    const organization = await newOrganization();

    const expired = await newPerson(organization, 'admin');
    const expiredCookie = await signIn(expired.email);
    await writeMarker(expired.userId, 'expired_temporary_password');
    await writeMarker(expired.userId, 'mfa_reenrol');
    await expectSession(expiredCookie, 'password_expired');

    const unexpired = await newPerson(organization, 'admin');
    await writeMarker(unexpired.userId, 'temporary_password');
    const unexpiredCookie = await signIn(unexpired.email);
    await writeMarker(unexpired.userId, 'mfa_reenrol');
    await expectSession(unexpiredCookie, 'password_change_required');
  }, 60_000);

  it.each(['admin', 'owner'] as const)(
    'An admin without MFA must enrol (API side): an %s with no enrolled factor who signs in is reported mfa_enrolment_required',
    async (role) => {
      const organization = await newOrganization();
      const person = role === 'admin' ? await newPerson(organization, 'admin') : organization.owner;

      const { body } = await expectSession(await signIn(person.email), 'mfa_enrolment_required');

      expect(body.role).toBe(role);
      expect(body.mfa).toEqual({ enrolled: false });
      expect(body.user).toEqual({ id: person.userId, name: person.name, email: person.email });
    },
    60_000,
  );

  it('an admin with an enrolled factor is not gated, and mfa.enrolled is true', async () => {
    const organization = await newOrganization();
    const admin = await newPerson(organization, 'admin');
    const enrolled = await enrolledAdminSession(
      app,
      { email: admin.email, cookie: await signIn(admin.email) },
      { password: TEST_PASSWORD, origin: ORIGIN },
    );

    const { body } = await expectSession(enrolled.cookie, 'none');

    expect(body.role).toBe('admin');
    expect(body.mfa).toEqual({ enrolled: true });
  }, 60_000);

  it.each(['temp-password:', 'mfa-reenrol:'] as const)(
    'a failed %s marker lookup fails closed with the uniform 401',
    async (prefix) => {
      const organization = await newOrganization();
      const member = await newPerson(organization);
      const cookie = await signIn(member.email);
      const reachable = await blueprints({ cookie });
      expect(reachable.statusCode, 'precondition: the session reaches /v1').toBe(200);

      const context = (await app.auth.$context) as { adapter: MarkerAdapter };
      const findOne = context.adapter.findOne.bind(context.adapter);
      const failing = `${prefix}${member.userId}`;
      vi.spyOn(context.adapter, 'findOne').mockImplementation(async (args) => {
        if (args.model === 'verification' && args.where.some((w) => w.value === failing)) {
          throw new Error('simulated marker lookup failure');
        }
        return findOne(args);
      });
      const refused = await blueprints({ cookie });
      expect(refused.statusCode, 'sanity: the seam reaches the marker lookup').toBe(401);

      await expectUniform401(await me({ cookie }));

      vi.restoreAllMocks();
      await expectSession(cookie, 'none');
    },
    60_000,
  );

  describe('No session looks like any other missing context', () => {
    it('no session: an anonymous client receives the same 401 CATALOG_CONTEXT_REQUIRED body as GET /v1/blueprints', async () => {
      await expectUniform401(await me());
      await expectUniform401(await me({ cookie: 'better-auth.session_token=not-a-session' }));
    });

    it('a banned user', async () => {
      const organization = await newOrganization();
      const member = await newPerson(organization);
      const cookie = await signIn(member.email);
      await expectSession(cookie, 'none');

      await pools.authPool.query('update auth."user" set banned = true where id = $1', [
        member.userId,
      ]);

      await expectUniform401(await me({ cookie }));
    }, 60_000);

    it('a disabled _user', async () => {
      const organization = await newOrganization();
      const member = await newPerson(organization);
      const cookie = await signIn(member.email);
      await expectSession(cookie, 'none');

      await withTenantTransaction(testAppPool(), { tenantId: organization.id }, async (client) => {
        const result = await client.query(
          `update catalog_entity
              set spec_properties = jsonb_set(spec_properties, '{status}', to_jsonb('Disabled'::text))
            where tenant_id = $1 and identifier = $2`,
          [organization.id, member.email],
        );
        expect(result.rowCount, 'sanity: the _user row exists').toBe(1);
      });
      movePastCaches();

      await expectUniform401(await me({ cookie }));
    }, 60_000);

    it.each(['pending', 'purged'] as const)(
      'a tenant with a %s deletion marker',
      async (state) => {
        const organization = await newOrganization();
        const member = await newPerson(organization);
        const cookie = await signIn(member.email);
        await expectSession(cookie, 'none');

        await pools.authPool.query(
          `insert into tenant_deletion_marker
             (tenant_id, purge_after, requested_by, state, catalog_purged_at, auth_purged_at)
           values ($1, now() + interval '14 days', $2, $3::text,
                   case when $3::text = 'purged' then now() end,
                   case when $3::text = 'purged' then now() end)`,
          [organization.id, `usr-${randomUUID()}`, state],
        );
        movePastCaches();

        await expectUniform401(await me({ cookie }));
      },
      60_000,
    );

    it('no active organization', async () => {
      const organization = await newOrganization();
      const member = await newPerson(organization);
      const cookie = await signIn(member.email);
      await expectSession(cookie, 'none');

      await pools.authPool.query(
        'update auth.session set active_organization_id = null where token = $1',
        [await tokenOfCookie(cookie, member.userId)],
      );

      await expectUniform401(await me({ cookie }));
    }, 60_000);

    it('an idle session (last used more than 12 hours ago)', async () => {
      const organization = await newOrganization();
      const member = await newPerson(organization);
      const cookie = await signIn(member.email);
      await expectSession(cookie, 'none');

      await pools.authPool.query(
        `update auth.session set updated_at = now() - interval '13 hours' where token = $1`,
        [await tokenOfCookie(cookie, member.userId)],
      );

      await expectUniform401(await me({ cookie }));
    }, 60_000);

    it('an expired session', async () => {
      const organization = await newOrganization();
      const member = await newPerson(organization);
      const cookie = await signIn(member.email);
      await expectSession(cookie, 'none');

      await pools.authPool.query(
        `update auth.session set expires_at = now() - interval '1 minute' where token = $1`,
        [await tokenOfCookie(cookie, member.userId)],
      );

      await expectUniform401(await me({ cookie }));
    }, 60_000);
  });

  it('A machine token is not a session: a valid machine access token as a bearer token receives the same 401 body as an anonymous client', async () => {
    const organization = await newOrganization();
    const credential = await createMachineCredential(app.auth, {
      userId: organization.owner.userId,
      organizationId: organization.id,
      name: 'Me route integration',
      actorKind: 'integration',
    });
    const exchanged = await app.app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        'x-forwarded-for': randomIp(),
        ...csrfHeaders('POST'),
      },
      payload: JSON.stringify({ clientId: credential.id, clientSecret: credential.secret }),
    });
    expect(exchanged.statusCode, exchanged.body).toBe(200);
    const authorization = `Bearer ${exchanged.json<{ accessToken: string }>().accessToken}`;
    const valid = await blueprints({ authorization });
    expect(valid.statusCode, 'precondition: the token is valid on /v1').toBe(200);

    const response = await me({ authorization });

    expect(response.statusCode, response.body).toBe(401);
    expect(response.json()).toEqual((await me()).json());
    await expectUniform401(response);
  }, 60_000);

  it('signInMethod is password for a local session', async () => {
    const organization = await newOrganization();
    const member = await newPerson(organization);

    const { body } = await expectSession(await signIn(member.email), 'none');

    expect(body.signInMethod).toBe('password');
  }, 60_000);

  it('signInMethod is visma-connect for a Visma Connect session', async () => {
    const organization = await newOrganization();
    const member = await newPerson(organization);
    const sub = `me-route-sub-${randomUUID()}`;
    await pools.authPool.query(
      `insert into auth.account (id, account_id, provider_id, user_id, created_at, updated_at)
       values ($1, $2, $3, $4, now(), now())`,
      [randomUUID(), sub, PROVIDER_ID, member.userId],
    );
    stub.setSubject({
      sub,
      email: `me-route-idp-${randomUUID()}@example.test`,
      name: 'Me Route Sso Person',
      sid: `sid-${randomUUID()}`,
    });
    const { cookie } = await oidcRoundTrip(handlerOf(app), '/sign-in/social', '');
    expect(cookie, 'the Visma Connect sign-in issues a session cookie').toContain('session_token');

    const { body } = await expectSession(cookie, 'none');

    expect(body.signInMethod).toBe('visma-connect');
    expect(body.user.id).toBe(member.userId);
    expect(body.organization.id).toBe(organization.id);
  }, 60_000);

  it('a tenantId, organizationId or userId in the query is ignored: the answer is the session’s own', async () => {
    const home = await newOrganization();
    const other = await newOrganization();
    const member = await newPerson(home);
    await api.addMember({
      body: { userId: member.userId, organizationId: other.id, role: 'member' },
    });
    await seedUserRow(testAppPool(), {
      tenantId: other.id,
      email: member.email,
      name: member.name,
    });
    const cookie = await signIn(member.email);
    await pools.authPool.query(
      'update auth.session set active_organization_id = $1 where token = $2',
      [home.id, await tokenOfCookie(cookie, member.userId)],
    );
    const { body: plain } = await expectSession(cookie, 'none');

    const query = new URLSearchParams({
      tenantId: other.id,
      organizationId: other.id,
      userId: other.owner.userId,
    });
    const response = await me({ cookie }, `${ME_PATH}?${query.toString()}`);

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<MeBody>();
    expect(body.organization).toEqual({ id: home.id, name: home.name });
    expect(body.user.id).toBe(member.userId);
    expect(body).toEqual(plain);
  }, 60_000);
});
