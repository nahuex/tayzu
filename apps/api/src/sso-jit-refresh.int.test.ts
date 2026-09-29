/**
 * Integration test for task 21.1 (openspec/changes/002-auth-and-rbac; design
 * D24 "JIT refresh (display data only, never identity)", Resolved decisions
 * Q16-Q21 and Q26-Q29; `specs/auth-and-rbac/spec.md`, requirement "Display
 * data from Visma Connect is refreshed just-in-time and never used as an
 * identity key").
 *
 * Scenarios covered (verbatim from the spec):
 *
 * - "Display name and email are refreshed on sign-in": GIVEN a linked user
 *   whose name at Visma Connect has changed since their last sign-in, WHEN
 *   they sign in through Visma Connect again, THEN their Tayzu display name
 *   reflects the new value.
 * - "A changed Visma Connect email does not alter local sign-in identity":
 *   GIVEN a user with both a local password and a linked Visma Connect
 *   account, WHEN their email at Visma Connect changes and they sign in
 *   through Visma Connect, THEN their local email+password sign-in identity is
 *   unchanged.
 *
 * The test lives in `apps/api` (like `user-sync.int.test.ts`) because it is
 * the only package that depends on `@tayzu/auth`, `@tayzu/authz` and
 * `@tayzu/catalog` together (`@tayzu/auth` has no dependency on the catalog).
 * Tests never call the real Visma Connect: the local OIDC stub (task 19.1)
 * serves discovery, token and userinfo. Cerbos runs on localhost:3593.
 *
 * ## Production symbols assumed (the red phase)
 *
 * - `createAuth({ db, secret, sso, userSync })`: after every successful
 *   `/callback/visma-connect` sign-in, and before the response is returned,
 *   the callback handler calls the stub's `/userinfo` with the fresh access
 *   token and writes the returned `name` / `email` through the `userSync` port
 *   (the `system` actor path) to the linked user's `_user` entity: `title` =
 *   the userinfo `name`, `spec.properties.contactEmail` = the userinfo
 *   `email`. The entity is addressed by the Tayzu user's own local email
 *   (`identifier`), never by the Visma Connect email.
 * - `UserSyncPort.upsertUser` (and `@tayzu/catalog`'s `UserSyncInput`) accept
 *   an optional `contactEmail` and merge it into `spec.properties.contactEmail`.
 * - The `_user` system blueprint (`system-blueprints.ts`) declares a string
 *   `contactEmail` property, so the entity validates.
 * - Better Auth's `auth.user.email` is never written by the refresh
 *   (`overrideUserInfo` stays `false`).
 */
import { randomInt, randomUUID } from 'node:crypto';

import { authSchema, createAuth, type AuthInstance } from '@tayzu/auth';
import { createCerbosClient } from '@tayzu/authz';
import { createEntityService, createUserSync } from '@tayzu/catalog';
import { runMigrations } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { bootstrapTestTenant } from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { startOidcStub, type OidcStub } from '../../../packages/auth/src/__fixtures__/oidc-stub.js';
import { harnessPools } from './__fixtures__/pools.js';
import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';

const AUTH_BASE_URL = 'http://localhost:3000/api/auth';
const PROVIDER_ID = 'visma-connect';
const PASSWORD = 'correct-horse-battery-staple-1';

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
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

interface CallbackParams {
  readonly code: string;
  readonly state: string;
  readonly iss?: string;
}

/** Initiates a Visma Connect sign-in and lets the stub approve it. */
async function initiateSignIn(
  auth: AuthInstance,
  stub: OidcStub,
): Promise<{ cookie: string; params: CallbackParams }> {
  const initiated = await handlerOf(auth)(
    new Request(`${AUTH_BASE_URL}/sign-in/social`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': randomIp(),
        origin: 'http://localhost:3000',
      },
      body: JSON.stringify({ provider: PROVIDER_ID, callbackURL: '/' }),
    }),
  );
  expect(initiated.status, 'sign-in initiation succeeds').toBe(200);
  const { url } = (await initiated.json()) as { url: string };
  expect(url.startsWith(stub.issuer), 'the authorization URL points at the local stub').toBe(true);

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
  return {
    cookie: cookieHeaderFrom(initiated),
    params: { code, state, ...(inputs['iss'] !== undefined ? { iss: inputs['iss'] } : {}) },
  };
}

/** POSTs the callback, then follows the same-URL `GET` redirect once, like a browser. */
async function completeCallback(
  auth: AuthInstance,
  cookie: string,
  params: CallbackParams,
): Promise<Response> {
  const handler = handlerOf(auth);
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
        origin: 'http://localhost:3000',
      }),
      body: new URLSearchParams(params as unknown as Record<string, string>).toString(),
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

interface UserEntity {
  readonly title: string;
  readonly createdBy: { readonly type: string };
  readonly spec: { readonly properties: Record<string, unknown> };
}

describe('Visma Connect JIT display-data refresh (task 21.1, design D24)', () => {
  let authPool: Pool;
  let auth: AuthInstance;
  let stub: OidcStub;
  let readUser: (tenantId: string, localEmail: string) => Promise<UserEntity>;

  beforeAll(async () => {
    const pools = await harnessPools();
    authPool = pools.authPool;
    await runMigrations(authPool);
    stub = await startOidcStub();
    const cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync: createUserSync({ pool: pools.appPool, authz: cerbos }),
      sso: {
        discoveryUrl: stub.discoveryUrl,
        clientId: stub.clientId,
        clientSecret: stub.clientSecret,
      },
    });
    const entities = createEntityService({ pool: pools.appPool, authz: cerbos });
    readUser = async (tenantId, localEmail) =>
      await entities.get(
        {
          tenantId,
          actor: { type: 'system', id: 'sso-jit-refresh-test' },
          principal: { roles: ['admin'] },
        },
        { blueprint: '_user', identifier: localEmail },
      );
  }, 60_000);

  afterAll(async () => {
    await stub.close();
  });

  /** A local-password user, in their own organization, linked to a fresh Visma Connect `sub`. */
  async function linkedUser(): Promise<{
    userId: string;
    localEmail: string;
    organizationId: string;
    sub: string;
  }> {
    const localEmail = `jit-local-${randomUUID()}@example.test`;
    const tenant = await bootstrapTestTenant(auth, {
      name: 'Local Name',
      email: localEmail,
      password: PASSWORD,
      organizationName: 'JIT Org',
      organizationSlug: `jit-${randomUUID()}`,
      ip: randomIp(),
    });
    const sub = `jit-sub-${randomUUID()}`;
    await authPool.query(
      `insert into auth.account (id, account_id, provider_id, user_id, created_at, updated_at)
       values ($1, $2, $3, $4, now(), now())`,
      [randomUUID(), sub, PROVIDER_ID, tenant.userId],
    );
    return {
      userId: tenant.userId,
      localEmail,
      organizationId: tenant.organizationId,
      sub,
    };
  }

  async function signInThroughVisma(identity: {
    sub: string;
    name: string;
    email: string;
  }): Promise<void> {
    stub.setSubject({ ...identity, sid: `sid-${randomUUID()}` });
    const { cookie, params } = await initiateSignIn(auth, stub);
    const response = await completeCallback(auth, cookie, params);
    expect(response.status, 'the Visma Connect sign-in succeeds').toBeLessThan(400);
    expect(
      response.headers.getSetCookie().some((c) => c.includes('session_token')),
      'a session is established',
    ).toBe(true);
  }

  it('Display name and email are refreshed on sign-in: the _user entity title and contactEmail follow the new Visma Connect values, written by the system actor', async () => {
    const user = await linkedUser();
    const firstEmail = `visma-first-${randomUUID()}@example.test`;
    const changedEmail = `visma-changed-${randomUUID()}@example.test`;

    await signInThroughVisma({ sub: user.sub, name: 'Original Visma Name', email: firstEmail });
    const first = await readUser(user.organizationId, user.localEmail);
    expect(first.title).toBe('Original Visma Name');
    expect(first.spec.properties['contactEmail']).toBe(firstEmail);

    // The name (and email) at Visma Connect changed since the last sign-in.
    await signInThroughVisma({ sub: user.sub, name: 'Renamed Visma Name', email: changedEmail });
    const refreshed = await readUser(user.organizationId, user.localEmail);
    expect(refreshed.title, 'display name reflects the new value').toBe('Renamed Visma Name');
    expect(refreshed.spec.properties['contactEmail']).toBe(changedEmail);
    expect(refreshed.createdBy.type, 'written through the system actor path').toBe('system');
    // The refresh is a merge: it does not erase what the user sync recorded.
    expect(refreshed.spec.properties['status']).toBe('Active');
    expect(refreshed.spec.properties['portRole']).toBe('admin');
  }, 60_000);

  it('A changed Visma Connect email does not alter local sign-in identity: auth.user.email and email+password sign-in are unchanged', async () => {
    const user = await linkedUser();
    const changedEmail = `visma-moved-${randomUUID()}@example.test`;

    await signInThroughVisma({ sub: user.sub, name: 'Local Name', email: changedEmail });

    // Better Auth's core email column (the local sign-in identifier) is untouched.
    const row = await authPool.query<{ email: string }>(
      'select email from auth."user" where id = $1',
      [user.userId],
    );
    expect(row.rows[0]?.email).toBe(user.localEmail);
    const collisions = await authPool.query(
      'select id from auth."user" where lower(email) = lower($1)',
      [changedEmail],
    );
    expect(collisions.rowCount, 'no local identity was created for the Visma Connect email').toBe(
      0,
    );

    const signIn = (email: string): Promise<Response> =>
      handlerOf(auth)(
        new Request(`${AUTH_BASE_URL}/sign-in/email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': randomIp() },
          body: JSON.stringify({ email, password: PASSWORD }),
        }),
      );

    // The original email + password still signs in, as the same user.
    const local = await signIn(user.localEmail);
    expect(local.status).toBe(200);
    expect(((await local.json()) as { user: { id: string } }).user.id).toBe(user.userId);
    // The Visma Connect email is not a local sign-in identifier.
    expect((await signIn(changedEmail)).status).not.toBe(200);

    // ... while the changed email is recorded as display data only.
    const entity = await readUser(user.organizationId, user.localEmail);
    expect(entity.spec.properties['contactEmail']).toBe(changedEmail);
  }, 60_000);
});
