/**
 * Integration test for task 4.1c of `043-identity-lifecycle-and-org-admin`
 * (design D2, Resolved decisions Q105 and Q117; the `refreshDisplayData`
 * paragraph of D2): the JIT display-data refresh of a Visma Connect sign-in
 * updates the display fields of a `_user` row that exists, never creates a row
 * and never writes a status.
 *
 * Cases:
 *
 * - "A member with no _user row still has none after a profile refresh": the
 *   member's `_user` row is absent (the tenant was bootstrapped by an `auth`
 *   instance with no user sync), a Visma Connect sign-in refreshes the profile,
 *   and `getUser` still finds no row.
 * - "A member with a _user row has only its display fields updated, the status
 *   unchanged": the row is `Invited`; after the refresh the title and
 *   `contactEmail` follow Visma Connect, and the status is still `Invited`.
 *
 * ## Production symbols assumed
 *
 * - `refreshDisplayData` in `packages/auth/src/auth.ts` (existing symbol,
 *   behavior changes): no longer creates a row or writes a status when it
 *   calls `userSync.upsertUser` without a `change`.
 * - `createUserSyncAdapter` in `./user-sync-adapter.js` (existing): its
 *   display-only write (no `change`) must not create a missing row.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { authSchema, createAuth, type AuthInstance } from '@tayzu/auth';
import { createCerbosClient } from '@tayzu/authz';
import { createEntityService, createUserSync } from '@tayzu/catalog';
import { runMigrations } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { bootstrapTestTenant } from '../../../../packages/auth/src/__fixtures__/admin-user.js';
import {
  startOidcStub,
  type OidcStub,
} from '../../../../packages/auth/src/__fixtures__/oidc-stub.js';
import {
  TEST_SECRET,
  TEST_PASSWORD,
} from '../../../../packages/auth/src/__fixtures__/test-secret.js';
import { harnessPools } from '../__fixtures__/pools.js';
import { createUserSyncAdapter, type UserSyncAdapter } from './user-sync-adapter.js';

const AUTH_BASE_URL = 'http://localhost:3000/api/auth';
const PROVIDER_ID = 'visma-connect';

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

describe('JIT display-data refresh never creates a _user row or writes a status (task 4.1c)', () => {
  let authPool: Pool;
  let bootstrapAuth: AuthInstance;
  let auth: AuthInstance;
  let stub: OidcStub;
  let adapter: UserSyncAdapter;
  let userSync: ReturnType<typeof createUserSync>;
  let readUserEntity: (
    tenantId: string,
    localEmail: string,
  ) => Promise<{ title: string; spec: { properties: Record<string, unknown> } }>;

  beforeAll(async () => {
    const pools = await harnessPools();
    authPool = pools.authPool;
    await runMigrations(authPool);
    stub = await startOidcStub();
    const cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    userSync = createUserSync({ pool: pools.appPool, authz: cerbos });
    adapter = createUserSyncAdapter({ userSync });
    const db = drizzle(authPool, { schema: authSchema });
    const sso = {
      discoveryUrl: stub.discoveryUrl,
      clientId: stub.clientId,
      clientSecret: stub.clientSecret,
    };
    // No user sync: bootstrapping a tenant with it writes no `_user` row.
    bootstrapAuth = createAuth({ db, secret: TEST_SECRET, sso });
    auth = createAuth({ db, secret: TEST_SECRET, sso, userSync: adapter });
    const entities = createEntityService({ pool: pools.appPool, authz: cerbos });
    readUserEntity = async (tenantId, localEmail) =>
      await entities.get(
        {
          tenantId,
          actor: { type: 'system', id: 'display-data-test' },
          principal: { roles: ['admin'] },
        },
        { blueprint: '_user', identifier: localEmail },
      );
  }, 60_000);

  afterAll(async () => {
    await stub.close();
  });

  /** A local-password member, linked to a fresh Visma Connect `sub`, with no `_user` row. */
  async function memberWithoutRow(): Promise<{
    localEmail: string;
    organizationId: string;
    sub: string;
  }> {
    const localEmail = `display-${randomUUID()}@example.test`;
    const tenant = await bootstrapTestTenant(bootstrapAuth, {
      name: 'Local Name',
      email: localEmail,
      password: TEST_PASSWORD,
      organizationName: 'Display Org',
      organizationSlug: `display-${randomUUID()}`,
      ip: randomIp(),
    });
    const sub = `display-sub-${randomUUID()}`;
    await authPool.query(
      `insert into auth.account (id, account_id, provider_id, user_id, created_at, updated_at)
       values ($1, $2, $3, $4, now(), now())`,
      [randomUUID(), sub, PROVIDER_ID, tenant.userId],
    );
    return { localEmail, organizationId: tenant.organizationId, sub };
  }

  async function signInThroughVisma(identity: {
    sub: string;
    name: string;
    email: string;
  }): Promise<void> {
    stub.setSubject({ ...identity, sid: `sid-${randomUUID()}` });
    const { cookie, params } = await initiateSignIn(auth);
    const response = await completeCallback(auth, cookie, params);
    expect(response.status, 'the Visma Connect sign-in succeeds').toBeLessThan(400);
    expect(
      response.headers.getSetCookie().some((c) => c.includes('session_token')),
      'a session is established',
    ).toBe(true);
  }

  it('A member with no _user row still has none after a profile refresh', async () => {
    const member = await memberWithoutRow();
    expect(
      await userSync.getUser({ tenantId: member.organizationId, email: member.localEmail }),
      'precondition: the member has no _user row',
    ).toBeNull();

    await signInThroughVisma({
      sub: member.sub,
      name: 'Refreshed Visma Name',
      email: `visma-${randomUUID()}@example.test`,
    });

    expect(
      await userSync.getUser({ tenantId: member.organizationId, email: member.localEmail }),
      'the refresh created no row',
    ).toBeNull();
  }, 60_000);

  it('A member with a _user row has only its display fields updated, the status unchanged', async () => {
    const member = await memberWithoutRow();
    // An Invited row is one a refresh must not promote or replace with a default.
    const written = await adapter.writeUserChange({
      tenantId: member.organizationId,
      email: member.localEmail,
      name: 'Name Before Refresh',
      change: 'created_invited',
      invitationId: randomUUID(),
    });
    expect(written, 'precondition: the row was created as Invited').toBe('created_invited');
    const before = await userSync.getUser({
      tenantId: member.organizationId,
      email: member.localEmail,
    });
    expect(before?.status).toBe('Invited');

    const vismaEmail = `visma-${randomUUID()}@example.test`;
    await signInThroughVisma({
      sub: member.sub,
      name: 'Refreshed Visma Name',
      email: vismaEmail,
    });

    const entity = await readUserEntity(member.organizationId, member.localEmail);
    expect(entity.title, 'the display name follows Visma Connect').toBe('Refreshed Visma Name');
    expect(entity.spec.properties['contactEmail']).toBe(vismaEmail);
    expect(entity.spec.properties['status'], 'the status is unchanged').toBe('Invited');
    const after = await userSync.getUser({
      tenantId: member.organizationId,
      email: member.localEmail,
    });
    expect(after?.status).toBe('Invited');
  }, 60_000);
});
