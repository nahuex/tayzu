/**
 * Integration test for task 23.6 (openspec/changes/002-auth-and-rbac; design
 * Resolved decision Q35 and D23; `specs/auth-and-rbac/spec.md`, requirement
 * "Visma Connect SSO sign-in").
 *
 * Task 23.6: "The Fastify app parses the `application/x-www-form-urlencoded`
 * `form_post` callback body before it reaches the Better Auth handler, without
 * loosening the catch-all parser for other routes."
 *
 * Scenarios covered (verbatim from the spec):
 * - "Sign-in with a linked Visma Connect account succeeds": GIVEN a Tayzu user
 *   whose account is linked to a Visma Connect `sub`, WHEN that person
 *   completes sign-in through Visma Connect, THEN it resolves to `actor.type`
 *   `user` for the linked Tayzu user.
 * - "Sign-in with an unlinked Visma Connect account is rejected generically":
 *   GIVEN a Visma Connect `sub` with no linked Tayzu user, WHEN that person
 *   completes sign-in through Visma Connect, THEN it fails with
 *   `AUTH_SSO_REJECTED`, and no user account is created.
 *
 * ## Harness
 *
 * Unlike the `auth.handler` tests of group 19, every request, including the
 * `form_post` callback, goes through Fastify (`app.app.inject`) on the real
 * `createApp`, with SSO pointed at the task-19.1 local OIDC stub. Every request
 * carries a fresh random `x-forwarded-for`. The stub's authorization endpoint
 * is reached with `fetch` (it is the identity provider, not the app).
 *
 * ## Production symbols expected
 *
 * - `createApp` (`./server.js`): the `/api/auth/*` route sees the parsed
 *   `application/x-www-form-urlencoded` body of `POST /api/auth/callback/
 *   visma-connect` (today the catch-all `*` parser discards it, so the
 *   callback fails with a missing code). The parser is scoped to the auth
 *   callback route; the `*` parser stays as is for other routes.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { authSchema } from '@tayzu/auth';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bootstrapTestTenant } from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { startOidcStub, type OidcStub } from '../../../packages/auth/src/__fixtures__/oidc-stub.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createApp, type App } from './server.js';

const ORIGIN = 'http://localhost:3000';
const PROVIDER_ID = 'visma-connect';

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

function cookieFrom(setCookie: string | string[] | number | undefined): string {
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : typeof setCookie === 'string'
      ? [setCookie]
      : [];
  return cookies.map((raw) => raw.split(';')[0]).join('; ');
}

describe('Visma Connect SSO sign-in through Fastify (task 23.6, design Q35)', () => {
  let app: App;
  let stub: OidcStub;
  let db: ReturnType<typeof drizzle<typeof authSchema>>;

  beforeAll(async () => {
    const pools = await harnessPools();
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
    db = drizzle(pools.authPool, { schema: authSchema });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await stub.close();
  }, 60_000);

  function post(url: string, headers: Record<string, string>, payload: string) {
    return app.app.inject({
      method: 'POST',
      url,
      headers: {
        'x-forwarded-for': randomIp(),
        origin: ORIGIN,
        host: 'localhost:3000',
        ...headers,
      },
      payload,
    });
  }

  /** Runs the whole SSO round trip through Fastify; returns the final response. */
  async function ssoSignIn(): Promise<Awaited<ReturnType<typeof post>>> {
    const initiated = await post(
      '/api/auth/sign-in/social',
      { 'content-type': 'application/json' },
      JSON.stringify({ provider: PROVIDER_ID, callbackURL: '/' }),
    );
    expect(initiated.statusCode, initiated.body).toBe(200);
    const { url } = initiated.json<{ url: string }>();
    expect(url.startsWith(stub.issuer), 'the authorization URL points at the local stub').toBe(
      true,
    );
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
    const cookie = cookieFrom(initiated.headers['set-cookie']);
    const posted = await post(
      `/api/auth/callback/${PROVIDER_ID}`,
      {
        'content-type': 'application/x-www-form-urlencoded',
        ...(cookie === '' ? {} : { cookie }),
      },
      params.toString(),
    );
    const location = posted.headers.location;
    if (
      posted.statusCode >= 300 &&
      posted.statusCode < 400 &&
      typeof location === 'string' &&
      new URL(location, ORIGIN).pathname.endsWith(`/callback/${PROVIDER_ID}`)
    ) {
      const target = new URL(location, ORIGIN);
      return app.app.inject({
        method: 'GET',
        url: `${target.pathname}${target.search}`,
        headers: {
          'x-forwarded-for': randomIp(),
          host: 'localhost:3000',
          ...(cookie === '' ? {} : { cookie }),
        },
      });
    }
    return posted;
  }

  it('Sign-in with a linked Visma Connect account succeeds: resolves to actor.type user for the linked Tayzu user', async () => {
    const tenant = await bootstrapTestTenant(app.auth, {
      name: 'Linked Person',
      email: `sso-http-${randomUUID()}@example.test`,
      password: TEST_PASSWORD,
      organizationName: 'Linked Org',
      organizationSlug: `sso-http-${randomUUID()}`,
      ip: randomIp(),
    });
    const sub = `sso-http-sub-${randomUUID()}`;
    await db.insert(authSchema.account).values({
      id: randomUUID(),
      accountId: sub,
      providerId: PROVIDER_ID,
      userId: tenant.userId,
    });
    stub.setSubject({
      sub,
      email: `other-${randomUUID()}@example.test`,
      name: 'Linked Person',
      sid: `sid-${randomUUID()}`,
    });

    const response = await ssoSignIn();

    expect(response.statusCode, response.body).toBeLessThan(400);
    const sessionCookie = cookieFrom(response.headers['set-cookie']);
    expect(sessionCookie, 'a session cookie is issued').toContain('session_token');
    const session = await (
      app.auth.api as {
        getSession(args: { headers: Headers }): Promise<{ user: { id: string } } | null>;
      }
    ).getSession({ headers: new Headers({ cookie: sessionCookie }) });
    expect(session?.user.id, 'the session belongs to the linked Tayzu user').toBe(tenant.userId);
  }, 60_000);

  it('Sign-in with an unlinked Visma Connect account is rejected generically: AUTH_SSO_REJECTED and no user account is created', async () => {
    const sub = `sso-http-unlinked-${randomUUID()}`;
    const email = `sso-http-unlinked-${randomUUID()}@example.test`;
    stub.setSubject({ sub, email, name: 'Unlinked Person', sid: `sid-${randomUUID()}` });

    const response = await ssoSignIn();

    expect(response.statusCode, response.body).toBe(401);
    expect(response.json<{ code?: unknown }>().code).toBe('AUTH_SSO_REJECTED');
    expect(cookieFrom(response.headers['set-cookie'])).not.toContain('session_token');
    const users = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from auth."user" where email = ${email}`,
    );
    expect(Number(users.rows[0]?.n ?? 0), 'no user was created').toBe(0);
    const accounts = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from auth.account where account_id = ${sub}`,
    );
    expect(Number(accounts.rows[0]?.n ?? 0), 'no account was created').toBe(0);
  }, 60_000);
});
