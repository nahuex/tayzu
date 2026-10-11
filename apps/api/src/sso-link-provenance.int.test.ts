/**
 * Integration test for task 8.5g of 043 (Resolved decisions Q87, Q114, Q115 and
 * Q120; design D4 step 7; spec requirement "An SSO link that its user did not
 * make does not survive into a second tenant").
 *
 * Scenarios covered (from the spec):
 * - "A link the user made survives" (the part this task owns: a link through the
 *   self-service route carries a marker keyed by the link's row identifier);
 * - "A link that pre-dates the marker is treated as admin-recorded" (the part
 *   this task owns: a link through `linkSsoAccount` carries no marker);
 * - "An account written inside another operation gets no marker";
 * - "A failed marker write fails closed";
 * - "A link to a provider account with another email is refused";
 * - "A marker does not outlive its link" (the user's own unlink and the admin
 *   unlink; the shed's own marker deletion is 8.5h's case).
 *
 * ## Harness
 *
 * `createAuth({ db, secret, sso })` points Visma Connect at the local OIDC stub
 * (never the real one). The self-service link is driven through
 * `auth.handler(new Request(...))` (`POST /link-social`, the stub's approval, the
 * `form_post` callback and its same-URL `GET`), every request with a fresh random
 * `x-forwarded-for`. The step-up pre-handler lives in the Fastify app and is not
 * under test here, so the handler is called directly. The admin paths go through
 * `createIdentityRouter(...)` as `account-linking.int.test.ts` does. Every test
 * uses a fresh random tenant and fresh users, so tests share no rows.
 *
 * Three instances share the database and the secret:
 * - `auth`: the instance under test;
 * - `seamAuth`: its `userSync` is a fake whose `upsertUser`, which
 *   `afterAddMember` calls inside the `addMember` handler, runs a callback the
 *   test arms. That is the test-only `afterAddMember` seam of the task: the
 *   callback writes or deletes an `account` row through the internal adapter
 *   from inside another endpoint handler, so the hook fires with that handler's
 *   ambient context;
 * - `failingAuth`: its pool rejects the insert of a `sso-link:` verification row
 *   and nothing else, which is a marker write that fails.
 *
 * ## Production symbols expected (none exists yet)
 *
 * - `databaseHooks.account.create.after` in `packages/auth/src/auth.ts` writes
 *   `auth.verification` (`identifier = 'sso-link:' || account.id`, `value =
 *   'self'`, a far-future `expires_at`) only when the hook context's route path
 *   is `/callback/:id`, and on a failed write deletes the account row, logs
 *   `catalog.security.sso_link_marker_failed` (`tayzu.identity.user.id`) and
 *   throws.
 * - `databaseHooks.account.delete.after` deletes that marker, through the
 *   adapter of its endpoint context or, with none, through
 *   `(await auth.$context).adapter`.
 * - `emitSelfLink` emits `auth.security.account_linked` (actor `self`) only on
 *   the route `/callback/:id` and `auth.security.account_unlinked` (actor `self`)
 *   only on `/unlink-account`.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { createRouterClient } from '@orpc/server';
// Import order is load-bearing (design D1): the telemetry harness must register
// before `@tayzu/auth` creates its instruments.
import {
  linkCounterTotal,
  linkLogEvents,
  registration,
  type TelemetryTestHarness,
} from './__fixtures__/link-telemetry.js';
import { authSchema, createAuth, type AuthInstance, type UserSyncPort } from '@tayzu/auth';
import { createCerbosClient } from '@tayzu/authz';
import { runMigrations } from '@tayzu/db';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createAdminUser,
  signInAdminUser,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { startOidcStub, type OidcStub } from '../../../packages/auth/src/__fixtures__/oidc-stub.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createAuthRepository } from './identity/auth-repository.js';
import { createWithUserLock } from './identity/user-lock.js';
import { createIdentityRouter } from './identity-router.js';

const ORIGIN = 'http://localhost:3000';
const AUTH_BASE_URL = `${ORIGIN}/api/auth`;
const PROVIDER_ID = 'visma-connect';
const MARKER_PREFIX = 'sso-link:';
/** A sentinel is "far future" when it is at least this many years away. */
const FAR_FUTURE_YEARS = 50;

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

type AccountRow = { readonly id: string; readonly user_id: string; readonly account_id: string };
type MarkerRow = { readonly identifier: string; readonly value: string; readonly expires_at: Date };

interface CreateOrganizationSurface {
  createOrganization(args: {
    body: { name: string; slug: string; userId: string };
  }): Promise<{ id: string }>;
}

interface MemberSurface {
  addMember(args: {
    body: { userId: string; organizationId: string; role: string };
  }): Promise<unknown>;
}

interface InternalAdapterSurface {
  readonly internalAdapter: {
    linkAccount(account: {
      userId: string;
      providerId: string;
      accountId: string;
    }): Promise<{ id: string }>;
    deleteAccount(id: string): Promise<void>;
    findVerificationValue(identifier: string): Promise<unknown>;
  };
}

function handlerOf(auth: AuthInstance): (request: Request) => Promise<Response> {
  return (auth as unknown as { handler: (request: Request) => Promise<Response> }).handler;
}

function cookieHeaderFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((raw) => raw.split(';')[0])
    .join('; ');
}

function registeredHarness(): TelemetryTestHarness {
  if ('error' in registration) {
    throw new Error(`telemetry harness failed to register: ${String(registration.error)}`, {
      cause: registration.error,
    });
  }
  return registration.harness;
}

/** A pool that rejects the insert of a `sso-link:` verification row and passes everything else. */
function poolFailingMarkerWrites(pool: Pool): Pool {
  const blocks = (args: readonly unknown[]): boolean => {
    const [first, second] = args;
    const config = (typeof first === 'object' ? first : null) as {
      text?: unknown;
      values?: unknown;
    } | null;
    const text = typeof first === 'string' ? first : config?.text;
    const values = Array.isArray(second) ? (second as unknown[]) : config?.values;
    return (
      typeof text === 'string' &&
      /insert\s+into\s+"auth"\."verification"/i.test(text) &&
      Array.isArray(values) &&
      values.some((value) => typeof value === 'string' && value.startsWith(MARKER_PREFIX))
    );
  };
  const wrap = <T extends object>(target: T, overrides: Record<string, unknown>): T =>
    new Proxy(target, {
      get(object, property) {
        if (typeof property === 'string' && property in overrides) return overrides[property];
        const value: unknown = Reflect.get(object, property, object);
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(object)
          : value;
      },
    });
  const guardedQuery =
    (target: { query: (...args: unknown[]) => unknown }) =>
    (...args: unknown[]): unknown =>
      blocks(args)
        ? Promise.reject(new Error('injected marker write failure'))
        : target.query(...args);
  return wrap(pool, {
    query: guardedQuery(pool as unknown as { query: (...args: unknown[]) => unknown }),
    connect: async (...args: unknown[]): Promise<unknown> => {
      const client = await (pool.connect as (...a: unknown[]) => Promise<object>).apply(pool, args);
      return wrap(client, {
        query: guardedQuery(client as unknown as { query: (...a: unknown[]) => unknown }),
      });
    },
  });
}

describe('Positive provenance of SSO links (task 8.5g, Resolved decision Q87)', () => {
  let authPool: Pool;
  let db: ReturnType<typeof drizzle<typeof authSchema>>;
  let stub: OidcStub;
  let auth: AuthInstance;
  let seamAuth: AuthInstance;
  let failingAuth: AuthInstance;
  let client: ReturnType<
    typeof createRouterClient<ReturnType<typeof createIdentityRouter>, Record<string, unknown>>
  >;
  /** Armed by a test; run once, inside the next `addMember` call's `afterAddMember`. */
  let seamCallback: ((userId: string) => Promise<void>) | undefined;

  beforeAll(async () => {
    const pools = await harnessPools();
    authPool = pools.authPool;
    await runMigrations(authPool);
    db = drizzle(authPool, { schema: authSchema });
    stub = await startOidcStub();
    const sso = {
      discoveryUrl: stub.discoveryUrl,
      clientId: stub.clientId,
      clientSecret: stub.clientSecret,
    };
    const base = { secret: TEST_SECRET, baseURL: ORIGIN, trustedOrigins: [ORIGIN], sso };
    auth = createAuth({ ...base, db });
    const seamSync: UserSyncPort = {
      upsertUser: async (input) => {
        const run = seamCallback;
        seamCallback = undefined;
        if (run !== undefined && input.userId !== undefined) await run(input.userId);
      },
    };
    seamAuth = createAuth({ ...base, db, userSync: seamSync });
    failingAuth = createAuth({
      ...base,
      db: drizzle(poolFailingMarkerWrites(authPool), { schema: authSchema }),
    });
    const cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    client = createRouterClient(
      createIdentityRouter({
        auth,
        authz: cerbos,
        authRepository: createAuthRepository(authPool),
        withUserLock: createWithUserLock(authPool),
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );
  }, 60_000);

  afterAll(async () => {
    await stub.close();
  });

  async function freshTenantId(): Promise<string> {
    const id = randomUUID();
    const owner = await createAdminUser(auth, {
      name: 'Tenant Owner',
      email: `owner-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    const org = await (auth.api as CreateOrganizationSurface).createOrganization({
      body: { name: 'Provenance Org', slug: `provenance-${id}`, userId: owner.userId },
    });
    return org.id;
  }

  function adminContext(tenantId: string): Record<string, unknown> {
    return {
      tenantId,
      actor: { type: 'user', id: `caller-${randomUUID()}` },
      principal: { roles: ['admin'] },
    };
  }

  /** A member of a fresh tenant who can sign in locally. */
  async function newMember(): Promise<{
    tenantId: string;
    userId: string;
    email: string;
    cookie: string;
  }> {
    const tenantId = await freshTenantId();
    const email = `member-${randomUUID()}@example.test`;
    const user = await createAdminUser(auth, {
      name: 'Provenance Member',
      email,
      password: TEST_PASSWORD,
    });
    await (auth.api as MemberSurface).addMember({
      body: { userId: user.userId, organizationId: tenantId, role: 'member' },
    });
    const signedIn = await signInAdminUser(auth, {
      email,
      password: TEST_PASSWORD,
      ip: randomIp(),
    });
    return { tenantId, userId: user.userId, email, cookie: signedIn.cookie };
  }

  /** The self-service link of `cookie`'s user to `sub`, through `handler`; returns the final response. */
  async function selfLink(
    handler: (request: Request) => Promise<Response>,
    cookie: string,
    identity: { sub: string; email: string },
  ): Promise<Response> {
    stub.setSubject({
      sub: identity.sub,
      email: identity.email,
      name: 'Provenance Member',
      sid: `sid-${randomUUID()}`,
      claims: { email_verified: true },
    });
    const initiated = await handler(
      new Request(`${AUTH_BASE_URL}/link-social`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': randomIp(),
          origin: ORIGIN,
          cookie,
        },
        body: JSON.stringify({ provider: PROVIDER_ID, callbackURL: '/' }),
      }),
    );
    expect(initiated.status, 'the link starts').toBe(200);
    const { url } = (await initiated.json()) as { url: string };
    const page = await (await fetch(url, { redirect: 'manual' })).text();
    const inputs = Object.fromEntries(
      [...page.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [
        m[1] ?? '',
        m[2] ?? '',
      ]),
    );
    const code = inputs['code'];
    const state = inputs['state'];
    if (code === undefined || state === undefined) {
      throw new Error('the OIDC stub did not return code and state');
    }
    const params = new URLSearchParams({
      code,
      state,
      ...(inputs['iss'] === undefined ? {} : { iss: inputs['iss'] }),
    });
    const callbackCookie = [cookie, cookieHeaderFrom(initiated)]
      .filter((part) => part !== '')
      .join('; ');
    const headers = (extra: Record<string, string>): Record<string, string> => ({
      'x-forwarded-for': randomIp(),
      cookie: callbackCookie,
      ...extra,
    });
    const posted = await handler(
      new Request(`${AUTH_BASE_URL}/callback/${PROVIDER_ID}`, {
        method: 'POST',
        headers: headers({
          'content-type': 'application/x-www-form-urlencoded',
          origin: ORIGIN,
        }),
        body: params.toString(),
      }),
    );
    const location = posted.headers.get('location');
    if (
      posted.status >= 300 &&
      posted.status < 400 &&
      location !== null &&
      new URL(location, AUTH_BASE_URL).pathname.endsWith(`/callback/${PROVIDER_ID}`)
    ) {
      return handler(
        new Request(new URL(location, AUTH_BASE_URL), { method: 'GET', headers: headers({}) }),
      );
    }
    return posted;
  }

  async function ownUnlink(cookie: string, accountId: string): Promise<Response> {
    return handlerOf(auth)(
      new Request(`${AUTH_BASE_URL}/unlink-account`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': randomIp(),
          origin: ORIGIN,
          cookie,
        },
        body: JSON.stringify({ accountId }),
      }),
    );
  }

  async function accountsOf(userId: string): Promise<readonly AccountRow[]> {
    const result = await db.execute<AccountRow>(sql`
      select id, user_id, account_id from auth.account
      where user_id = ${userId} and provider_id = ${PROVIDER_ID}
    `);
    return result.rows;
  }

  async function accountsForSub(sub: string): Promise<readonly AccountRow[]> {
    const result = await db.execute<AccountRow>(sql`
      select id, user_id, account_id from auth.account
      where provider_id = ${PROVIDER_ID} and account_id = ${sub}
    `);
    return result.rows;
  }

  async function markersFor(accountId: string): Promise<readonly MarkerRow[]> {
    const result = await db.execute<MarkerRow>(sql`
      select identifier, value, expires_at from auth.verification
      where identifier = ${`${MARKER_PREFIX}${accountId}`}
    `);
    return result.rows;
  }

  /** Every marker whose identifier is keyed by an account row of `userId`, or by one of `subs`. */
  async function markerCountForUser(userId: string, subs: readonly string[]): Promise<number> {
    const result = await db.execute<{ n: string }>(sql`
      select count(*)::text as n from auth.verification v
      where v.identifier in (
        select ${MARKER_PREFIX} || a.id from auth.account a where a.user_id = ${userId}
      )
      or v.identifier in (${sql.join(
        subs.map((sub) => sql`${`${MARKER_PREFIX}${sub}`}`),
        sql`, `,
      )}, ${`${MARKER_PREFIX}none`})
    `);
    return Number(result.rows[0]?.n ?? 0);
  }

  async function linkedOnce(
    member: { cookie: string; email: string; userId: string },
    sub: string,
  ): Promise<AccountRow> {
    await selfLink(handlerOf(auth), member.cookie, { sub, email: member.email });
    const rows = await accountsOf(member.userId);
    expect(rows, 'precondition: the self-service link happened').toHaveLength(1);
    const [row] = rows;
    if (row === undefined) throw new Error('unreachable');
    return row;
  }

  async function selfEvents(
    harness: TelemetryTestHarness,
    name: 'auth.security.account_linked' | 'auth.security.account_unlinked',
  ) {
    return (await linkLogEvents(harness, name)).filter(
      (record) => record.attributes['tayzu.auth.link.actor'] === 'self',
    );
  }

  it('A link through /link-social writes exactly one marker keyed by the account row id, with the value self and no email', async () => {
    const member = await newMember();
    const sub = `prov-sub-${randomUUID()}`;

    const row = await linkedOnce(member, sub);

    const markers = await markersFor(row.id);
    expect(markers, 'one marker keyed by the account row id').toHaveLength(1);
    expect(markers[0]?.value).toBe('self');
    expect(markers[0]?.identifier).toBe(`${MARKER_PREFIX}${row.id}`);
    expect(markers[0]?.identifier, 'no email in the marker').not.toContain(member.email);
    expect(await markersFor(sub), 'not keyed by the provider subject').toHaveLength(0);
    expect(await markerCountForUser(member.userId, [sub]), 'exactly one marker in all').toBe(1);
  }, 60_000);

  it('A link through linkSsoAccount writes no marker: an unmarked link counts as admin-recorded', async () => {
    const member = await newMember();
    const sub = `prov-sub-${randomUUID()}`;

    await client.identity.users.linkSsoAccount(
      { user: member.email, subject: sub },
      { context: adminContext(member.tenantId) },
    );

    const rows = await accountsOf(member.userId);
    expect(rows, 'precondition: the admin link happened').toHaveLength(1);
    expect(await markersFor(rows[0]?.id ?? '')).toHaveLength(0);
    expect(await markerCountForUser(member.userId, [sub])).toBe(0);
  }, 60_000);

  it("The marker's expiresAt is a far-future sentinel and survives Better Auth's expired-row cleanup", async () => {
    const member = await newMember();
    const row = await linkedOnce(member, `prov-sub-${randomUUID()}`);

    const [marker] = await markersFor(row.id);
    expect(marker, 'precondition: the marker exists').toBeDefined();
    const horizon = Date.now() + FAR_FUTURE_YEARS * 365 * 24 * 3600 * 1000;
    expect(new Date(marker?.expires_at ?? 0).getTime()).toBeGreaterThan(horizon);

    // A verification lookup runs Better Auth's cleanup of every expired verification row.
    const context = (await auth.$context) as InternalAdapterSurface;
    await context.internalAdapter.findVerificationValue(`cleanup-probe-${randomUUID()}`);

    expect(await markersFor(row.id), 'the marker is still there').toHaveLength(1);
  }, 60_000);

  it("A user's own /unlink-account removes the marker and emits account_unlinked with the actor self once", async () => {
    const harness = registeredHarness();
    const member = await newMember();
    const sub = `prov-sub-${randomUUID()}`;
    const row = await linkedOnce(member, sub);
    expect(await markersFor(row.id), 'precondition: marked').toHaveLength(1);
    await harness.reset();

    const response = await ownUnlink(member.cookie, row.id);

    expect(response.status, 'the unlink succeeds').toBe(200);
    expect(await accountsOf(member.userId)).toHaveLength(0);
    expect(await markersFor(row.id), 'the marker is gone with the link').toHaveLength(0);
    expect(await selfEvents(harness, 'auth.security.account_unlinked')).toHaveLength(1);
    expect(linkCounterTotal(harness, 'unlinked', 'self')).toBe(1);
  }, 60_000);

  it('An admin unlink removes the marker (no endpoint context) and emits no self-service event, and a later admin link of the same sub carries no stale marker', async () => {
    const harness = registeredHarness();
    const member = await newMember();
    const sub = `prov-sub-${randomUUID()}`;
    const row = await linkedOnce(member, sub);
    expect(await markersFor(row.id), 'precondition: marked').toHaveLength(1);
    await harness.reset();

    await client.identity.users.unlinkSsoAccount(
      { user: member.email },
      { context: adminContext(member.tenantId) },
    );

    expect(await accountsOf(member.userId)).toHaveLength(0);
    expect(await markersFor(row.id), 'the fallback adapter removed the marker').toHaveLength(0);
    expect(await selfEvents(harness, 'auth.security.account_unlinked')).toHaveLength(0);
    expect(linkCounterTotal(harness, 'unlinked', 'self')).toBe(0);
    expect(linkCounterTotal(harness, 'unlinked', 'admin')).toBe(1);

    // The same sub, recorded again by an admin, is unmarked: nothing stale is inherited.
    await client.identity.users.linkSsoAccount(
      { user: member.email, subject: sub },
      { context: adminContext(member.tenantId) },
    );
    expect(await markerCountForUser(member.userId, [sub])).toBe(0);
  }, 60_000);

  it('A re-link of the same sub after an unlink gets a fresh marker, not a stale one', async () => {
    const member = await newMember();
    const sub = `prov-sub-${randomUUID()}`;
    const first = await linkedOnce(member, sub);
    expect((await ownUnlink(member.cookie, first.id)).status).toBe(200);
    expect(await markersFor(first.id), 'the first marker is gone').toHaveLength(0);

    await selfLink(handlerOf(auth), member.cookie, { sub, email: member.email });

    const rows = await accountsOf(member.userId);
    expect(rows).toHaveLength(1);
    const second = rows[0];
    expect(second?.id, 'a new account row').not.toBe(first.id);
    expect(await markersFor(second?.id ?? ''), 'a fresh marker for the new row').toHaveLength(1);
    expect(await markersFor(first.id), 'no stale marker for the old row').toHaveLength(0);
    expect(await markerCountForUser(member.userId, [sub])).toBe(1);
  }, 60_000);

  it('account_linked with the actor self is emitted once for a /link-social callback and not for linkSsoAccount', async () => {
    const harness = registeredHarness();
    const selfMember = await newMember();
    const adminMember = await newMember();
    await harness.reset();

    await linkedOnce(selfMember, `prov-sub-${randomUUID()}`);

    expect(await selfEvents(harness, 'auth.security.account_linked')).toHaveLength(1);
    expect(linkCounterTotal(harness, 'linked', 'self')).toBe(1);

    await harness.reset();
    await client.identity.users.linkSsoAccount(
      { user: adminMember.email, subject: `prov-sub-${randomUUID()}` },
      { context: adminContext(adminMember.tenantId) },
    );

    expect(await selfEvents(harness, 'auth.security.account_linked')).toHaveLength(0);
    expect(linkCounterTotal(harness, 'linked', 'self')).toBe(0);
    expect(linkCounterTotal(harness, 'linked', 'admin')).toBe(1);
  }, 60_000);

  it('An account written inside another operation gets no marker and emits no self-link event, while the callback route still writes one', async () => {
    const harness = registeredHarness();
    const joiner = await createAdminUser(seamAuth, {
      name: 'Seam Joiner',
      email: `joiner-${randomUUID()}@example.test`,
      password: TEST_PASSWORD,
    });
    const targetTenant = await freshTenantId();
    const seamSub = `seam-sub-${randomUUID()}`;
    let written: { id: string } | undefined;
    seamCallback = async (userId) => {
      const context = (await seamAuth.$context) as InternalAdapterSurface;
      written = await context.internalAdapter.linkAccount({
        userId,
        providerId: PROVIDER_ID,
        accountId: seamSub,
      });
    };
    await harness.reset();

    // GIVEN an account written through the internal adapter while a membership is added.
    await (seamAuth.api as MemberSurface).addMember({
      body: { userId: joiner.userId, organizationId: targetTenant, role: 'member' },
    });

    // THEN it exists, carries no marker, and emitted no self-link event.
    expect(written, 'precondition: the seam wrote an account row').toBeDefined();
    expect(await accountsForSub(seamSub)).toHaveLength(1);
    expect(await markersFor(written?.id ?? '')).toHaveLength(0);
    expect(await selfEvents(harness, 'auth.security.account_linked')).toHaveLength(0);
    expect(linkCounterTotal(harness, 'linked', 'self')).toBe(0);

    // ... while a link the user makes through the callback route still carries one.
    const member = await newMember();
    const row = await linkedOnce(member, `prov-sub-${randomUUID()}`);
    expect(await markersFor(row.id)).toHaveLength(1);
  }, 60_000);

  it('An account row deleted inside another operation emits no self-link event', async () => {
    const harness = registeredHarness();
    const joiner = await newMember();
    const sub = `seam-sub-${randomUUID()}`;
    await client.identity.users.linkSsoAccount(
      { user: joiner.email, subject: sub },
      { context: adminContext(joiner.tenantId) },
    );
    const [seeded] = await accountsOf(joiner.userId);
    expect(seeded, 'precondition: an account to delete').toBeDefined();
    const targetTenant = await freshTenantId();
    seamCallback = async () => {
      const context = (await seamAuth.$context) as InternalAdapterSurface;
      await context.internalAdapter.deleteAccount(seeded?.id ?? '');
    };
    await harness.reset();

    await (seamAuth.api as MemberSurface).addMember({
      body: { userId: joiner.userId, organizationId: targetTenant, role: 'member' },
    });

    expect(await accountsOf(joiner.userId), 'the seam deleted the row').toHaveLength(0);
    expect(await selfEvents(harness, 'auth.security.account_unlinked')).toHaveLength(0);
    expect(linkCounterTotal(harness, 'unlinked', 'self')).toBe(0);
  }, 60_000);

  it('A failed marker write fails closed: the link fails, no account row of that link remains, and the failure is logged', async () => {
    const harness = registeredHarness();
    const member = await newMember();
    const sub = `prov-sub-${randomUUID()}`;
    await harness.reset();

    const response = await selfLink(handlerOf(failingAuth), member.cookie, {
      sub,
      email: member.email,
    });

    expect(response.status, 'the callback fails').toBeGreaterThanOrEqual(400);
    expect(await accountsForSub(sub), 'no account row of that link remains').toHaveLength(0);
    expect(await accountsOf(member.userId)).toHaveLength(0);
    expect(await markerCountForUser(member.userId, [sub])).toBe(0);
    const events = await linkLogEvents(harness, 'catalog.security.sso_link_marker_failed');
    expect(events).toHaveLength(1);
    expect(events[0]?.attributes['tayzu.identity.user.id']).toBe(member.userId);
    const serialized = JSON.stringify(events[0]?.attributes);
    expect(serialized, 'no email in telemetry').not.toContain(member.email);
    expect(serialized, 'no sub in telemetry').not.toContain(sub);
  }, 60_000);

  it('A link to a provider account with another email is refused: no account row and no marker', async () => {
    const member = await newMember();
    const sub = `prov-sub-${randomUUID()}`;

    // The provider account's email differs from the user's.
    await selfLink(handlerOf(auth), member.cookie, {
      sub,
      email: `someone-else-${randomUUID()}@example.test`,
    });

    expect(await accountsForSub(sub), 'no account row').toHaveLength(0);
    expect(await accountsOf(member.userId)).toHaveLength(0);
    expect(await markerCountForUser(member.userId, [sub])).toBe(0);
  }, 60_000);

  it("An SSO sign-in whose email matches another user's creates no link and no marker", async () => {
    const victim = await newMember();
    const sub = `prov-sub-${randomUUID()}`;
    stub.setSubject({
      sub,
      email: victim.email,
      name: 'Email Match',
      sid: `sid-${randomUUID()}`,
      claims: { email_verified: true },
    });

    const handler = handlerOf(auth);
    const initiated = await handler(
      new Request(`${AUTH_BASE_URL}/sign-in/social`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': randomIp(),
          origin: ORIGIN,
        },
        body: JSON.stringify({ provider: PROVIDER_ID, callbackURL: '/' }),
      }),
    );
    expect(initiated.status).toBe(200);
    const { url } = (await initiated.json()) as { url: string };
    const page = await (await fetch(url, { redirect: 'manual' })).text();
    const inputs = Object.fromEntries(
      [...page.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [
        m[1] ?? '',
        m[2] ?? '',
      ]),
    );
    const params = new URLSearchParams(inputs);
    const cookie = cookieHeaderFrom(initiated);
    const headers = (extra: Record<string, string>): Record<string, string> => ({
      'x-forwarded-for': randomIp(),
      ...(cookie === '' ? {} : { cookie }),
      ...extra,
    });
    const posted = await handler(
      new Request(`${AUTH_BASE_URL}/callback/${PROVIDER_ID}`, {
        method: 'POST',
        headers: headers({
          'content-type': 'application/x-www-form-urlencoded',
          origin: ORIGIN,
        }),
        body: params.toString(),
      }),
    );
    const location = posted.headers.get('location');
    const response =
      posted.status >= 300 && posted.status < 400 && location !== null
        ? await handler(
            new Request(new URL(location, AUTH_BASE_URL), { method: 'GET', headers: headers({}) }),
          )
        : posted;

    expect(response.status, 'the sign-in is rejected').toBe(401);
    expect(response.headers.getSetCookie().some((c) => c.includes('session_token'))).toBe(false);
    expect(await accountsForSub(sub), 'no account row').toHaveLength(0);
    expect(await accountsOf(victim.userId)).toHaveLength(0);
    expect(await markerCountForUser(victim.userId, [sub])).toBe(0);
  }, 60_000);
});
