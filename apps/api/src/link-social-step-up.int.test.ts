/**
 * Integration test for task 20.2 (openspec/changes/002-auth-and-rbac; design
 * D24 path (a), Resolved decisions Q18 and Q19; `specs/auth-and-rbac/spec.md`,
 * requirement "Account linking to Visma Connect is explicit and keyed on the
 * Visma Connect UserID").
 *
 * Task 20.2: "A Fastify pre-handler on `/link-social` reusing task 4.2's
 * `twoFactorVerifiedAt` freshness check, requiring a fresh MFA verification
 * when the caller has an enrolled factor (design D24)."
 *
 * Scenarios covered (verbatim from the spec):
 * - "A signed-in user links their own Visma Connect account": GIVEN a user
 *   signed in locally with a fresh MFA verification, WHEN they link their
 *   Visma Connect account, THEN their account is linked, keyed on the Visma
 *   Connect UserID.
 * - "Linking without a fresh MFA verification is blocked for an MFA-enrolled
 *   user": GIVEN a user signed in locally with an enrolled MFA factor but no
 *   fresh verification, WHEN they attempt to link their Visma Connect account,
 *   THEN it fails with `AUTH_STEP_UP_REQUIRED`.
 *
 * ## Harness
 *
 * The pre-handler lives in the Fastify app, so this test lives in `apps/api`
 * and drives `POST /api/auth/link-social` through `app.app.inject` (the
 * request goes through the real `createApp`). `createApp({ ..., sso })` points
 * Visma Connect at the task-19.1 local OIDC stub; the real Visma Connect is
 * never called. Every request carries a fresh random `x-forwarded-for`.
 *
 * The OAuth round trip after `/link-social` is completed against
 * `app.auth.handler` directly (not through Fastify): the callback is not what
 * task 20.2 changes, and the Fastify catch-all parses a `form_post` callback
 * body differently from Better Auth's own handler. Only the initiation, the
 * step of 20.2's pre-handler, goes through Fastify.
 *
 * The linking identity's email equals the caller's email so that this test
 * exercises step-up only; task 20.2 does not concern how email is treated.
 *
 * "Enrolled factor, no fresh verification" is set up by enrolling TOTP,
 * signing in through a real TOTP challenge (enrolling invalidates the
 * enrollment session itself), and then removing the step-up freshness marker
 * (a `verification` row keyed `step-up-verified:<session token>`,
 * `packages/auth/src/step-up.ts`) for that session, so the session is one
 * whose verification is not fresh (absent). The stub identity carries
 * `email_verified: true` so Better Auth's own link check accepts the provider;
 * that is a stub detail, not something task 20.2 changes.
 *
 * ## Production symbols expected
 *
 * - `createApp` (`./server.js`) gains a pre-handler scoped to
 *   `POST /api/auth/link-social`. It reads the caller's session, and when the
 *   user has `twoFactorEnabled` and the session has no fresh (5-minute) MFA
 *   verification marker, answers `403` with body code `AUTH_STEP_UP_REQUIRED`
 *   without reaching Better Auth. It reuses `@tayzu/auth`'s freshness check
 *   from `step-up.ts` (no second implementation); the tests only observe
 *   behavior.
 * - No Cerbos policy change and no new route allowlist entry (`/link-social`
 *   is already allowlisted, task 19.3).
 */
import { randomInt, randomUUID } from 'node:crypto';

// Import order is load-bearing (design D1): the telemetry harness must register
// before `@tayzu/auth` creates its instruments (task 20.4).
import {
  linkCounterTotal,
  linkLogEvents,
  registration,
  type TelemetryTestHarness,
} from './__fixtures__/link-telemetry.js';
import { authSchema } from '@tayzu/auth';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createCerbosClient } from '@tayzu/authz';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { startOidcStub, type OidcStub } from '../../../packages/auth/src/__fixtures__/oidc-stub.js';
import {
  bootstrapTestTenant,
  createAdminUser,
  type BootstrappedTenant,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { enrollTotp, sessionTokenOfCookie, signInWithTotp } from './__fixtures__/fresh-mfa.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createAppFromEnv } from './bootstrap.js';
import { createIdentityRouter } from './identity-router.js';
import { createApp, type App } from './server.js';
import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';

const poolState = vi.hoisted(() => ({ pools: new Map<string, unknown>() }));

// Task 23.14 builds its app through `createAppFromEnv`, whose pools are the
// harness pools (the same seam `admin-mfa-enrollment.int.test.ts` uses).
vi.mock('@tayzu/db', async (importActual) => {
  const actual = await importActual<typeof import('@tayzu/db')>();
  return {
    ...actual,
    createPool: vi.fn((url: string) => {
      const role = url.includes('tayzu_auth') ? 'auth' : 'app';
      const real = poolState.pools.get(role) as object;
      return new Proxy(real, {
        get(target, prop) {
          if (prop === 'end') {
            return () => Promise.resolve();
          }
          const value: unknown = Reflect.get(target, prop, target);
          return typeof value === 'function'
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });
    }),
  };
});

const TEST_PASSWORD = 'correct horse battery staple';
const ORIGIN = 'http://localhost:3000';
const AUTH_BASE_URL = `${ORIGIN}/api/auth`;
const PROVIDER_ID = 'visma-connect';

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

type AccountRow = {
  readonly account_id: string;
  readonly provider_id: string;
  readonly user_id: string;
};

interface TwoFactorApiSurface {
  enableTwoFactor(args: {
    body: { password: string; method: 'totp' };
    headers: Headers;
  }): Promise<{ totpURI: string }>;
  generateTOTP(args: { body: { secret: string } }): Promise<{ code: string }>;
  verifyTOTP(args: { body: { code: string }; headers: Headers }): Promise<unknown>;
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decodeBase32(encoded: string): Uint8Array {
  const bytes: number[] = [];
  let buffer = 0;
  let bitsCollected = 0;
  for (const char of encoded) {
    if (char === '=') {
      break;
    }
    const value = BASE32_ALPHABET.indexOf(char.toUpperCase());
    if (value === -1) {
      throw new Error(`invalid base32 character in TOTP secret: ${char}`);
    }
    buffer = (buffer << 5) | value;
    bitsCollected += 5;
    if (bitsCollected >= 8) {
      bitsCollected -= 8;
      bytes.push((buffer >> bitsCollected) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

function rawSecretFromTotpUri(totpURI: string): string {
  const secretParam = new URL(totpURI).searchParams.get('secret');
  if (secretParam === null) {
    throw new Error('expected a secret query parameter on the TOTP URI');
  }
  return new TextDecoder().decode(decodeBase32(secretParam));
}

function authHandlerOf(app: App): (request: Request) => Promise<Response> {
  return (app.auth as unknown as { handler: (request: Request) => Promise<Response> }).handler;
}

function cookieFrom(setCookie: string | string[] | number | undefined): string {
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : typeof setCookie === 'string'
      ? [setCookie]
      : [];
  return cookies.map((raw) => raw.split(';')[0]).join('; ');
}

function cookieHeaderOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((raw) => raw.split(';')[0])
    .join('; ');
}

describe('POST /api/auth/link-social step-up (task 20.2, design D24 path (a))', () => {
  let app: App;
  let stub: OidcStub;
  let db: ReturnType<typeof drizzle<typeof authSchema>>;
  let totp: TwoFactorApiSurface;
  let authHandler: (request: Request) => Promise<Response>;

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
    totp = app.auth.api as TwoFactorApiSurface;
    authHandler = authHandlerOf(app);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await stub.close();
  }, 60_000);

  /** A user with one org, signed in locally, with an enrolled and verified TOTP factor. */
  async function enrolledUser(): Promise<{
    tenant: BootstrappedTenant;
    email: string;
    secret: string;
  }> {
    const email = `link-${randomUUID()}@example.test`;
    const tenant = await bootstrapTestTenant(app.auth, {
      name: 'Link User',
      email,
      password: TEST_PASSWORD,
      organizationName: 'Link Org',
      organizationSlug: `link-${randomUUID()}`,
      ip: randomIp(),
    });
    const headers = new Headers({ cookie: tenant.cookie });
    const enabled = await totp.enableTwoFactor({
      body: { password: TEST_PASSWORD, method: 'totp' },
      headers,
    });
    const secret = rawSecretFromTotpUri(enabled.totpURI);
    const code = (await totp.generateTOTP({ body: { secret } })).code;
    await totp.verifyTOTP({ body: { code }, headers });
    return { tenant, email, secret };
  }

  /** A fresh, fully signed-in session obtained by completing a real TOTP challenge. */
  async function freshMfaSessionCookie(email: string, secret: string): Promise<string> {
    const challenge = await authHandler(
      new Request(`${AUTH_BASE_URL}/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': randomIp() },
        body: JSON.stringify({ email, password: TEST_PASSWORD }),
      }),
    );
    expect(challenge.status, 'the sign-in is challenged, not rejected').toBe(200);
    const code = (await totp.generateTOTP({ body: { secret } })).code;
    const verified = await authHandler(
      new Request(`${AUTH_BASE_URL}/two-factor/verify-totp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': randomIp(),
          cookie: cookieHeaderOf(challenge),
          origin: ORIGIN,
        },
        body: JSON.stringify({ code }),
      }),
    );
    expect(verified.status, 'the TOTP challenge is verified').toBe(200);
    return cookieHeaderOf(verified);
  }

  function linkSocial(cookie: string) {
    return app.app.inject({
      method: 'POST',
      url: '/api/auth/link-social',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': randomIp(),
        origin: ORIGIN,
        host: 'localhost:3000',
        cookie,
      },
      payload: JSON.stringify({ provider: PROVIDER_ID, callbackURL: '/' }),
    });
  }

  async function ssoAccountsOf(userId: string): Promise<readonly AccountRow[]> {
    const result = await db.execute<AccountRow>(sql`
      select account_id, provider_id, user_id
      from auth.account
      where user_id = ${userId} and provider_id = ${PROVIDER_ID}
    `);
    return result.rows;
  }

  async function ssoAccountsForSub(sub: string): Promise<readonly AccountRow[]> {
    const result = await db.execute<AccountRow>(sql`
      select account_id, provider_id, user_id
      from auth.account
      where provider_id = ${PROVIDER_ID} and account_id = ${sub}
    `);
    return result.rows;
  }

  it('A signed-in user links their own Visma Connect account: linked, keyed on the Visma Connect UserID', async () => {
    const { tenant, email, secret } = await enrolledUser();
    const cookie = await freshMfaSessionCookie(email, secret);
    const sub = `link-sub-${randomUUID()}`;
    stub.setSubject({
      sub,
      email,
      name: 'Link User',
      sid: `sid-${randomUUID()}`,
      claims: { email_verified: true },
    });
    expect(await ssoAccountsOf(tenant.userId), 'precondition: nothing linked yet').toHaveLength(0);

    // WHEN they link their Visma Connect account (initiation goes through Fastify).
    const initiated = await linkSocial(cookie);
    expect(initiated.statusCode, 'a fresh MFA verification lets the link start').toBe(200);
    const { url } = initiated.json<{ url: string }>();
    expect(url.startsWith(stub.issuer), 'the authorization URL points at the local stub').toBe(
      true,
    );

    // The OAuth round trip: the stub approves, then the callback is processed.
    const approval = await fetch(url, { redirect: 'manual' });
    const page = await approval.text();
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
    const callbackCookie = [cookie, cookieFrom(initiated.headers['set-cookie'])]
      .filter((part) => part !== '')
      .join('; ');
    const headers = (): Record<string, string> => ({
      'x-forwarded-for': randomIp(),
      cookie: callbackCookie,
    });
    const posted = await authHandler(
      new Request(`${AUTH_BASE_URL}/callback/${PROVIDER_ID}`, {
        method: 'POST',
        headers: {
          ...headers(),
          'content-type': 'application/x-www-form-urlencoded',
          origin: ORIGIN,
        },
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
      await authHandler(
        new Request(new URL(location, AUTH_BASE_URL), { method: 'GET', headers: headers() }),
      );
    }

    // THEN their account is linked, keyed on the Visma Connect UserID.
    const linked = await ssoAccountsOf(tenant.userId);
    expect(linked).toHaveLength(1);
    expect(linked[0]?.account_id, 'keyed on the Visma Connect sub').toBe(sub);
    expect(linked[0]?.user_id, "linked to the caller's own user").toBe(tenant.userId);
  }, 60_000);

  it('Linking without a fresh MFA verification is blocked for an MFA-enrolled user: AUTH_STEP_UP_REQUIRED', async () => {
    const { tenant, email, secret } = await enrolledUser();
    // GIVEN an enrolled factor but no fresh verification for this session:
    // a real, challenge-verified session whose freshness marker is then absent.
    const cookie = await freshMfaSessionCookie(email, secret);
    const session = await (
      app.auth.api as {
        getSession(args: { headers: Headers }): Promise<{ session: { token: string } } | null>;
      }
    ).getSession({ headers: new Headers({ cookie }) });
    if (session === null) {
      throw new Error('expected the challenge-verified session to be valid');
    }
    await db.execute(sql`
      delete from auth.verification
      where identifier = ${`step-up-verified:${session.session.token}`}
    `);
    const sub = `blocked-sub-${randomUUID()}`;
    stub.setSubject({ sub, email, name: 'Link User' });
    const requestsBefore = stub.authorizationRequests.length;

    // WHEN they attempt to link their Visma Connect account.
    const response = await linkSocial(cookie);

    // THEN it fails with AUTH_STEP_UP_REQUIRED (403), before Better Auth starts the flow.
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json<{ code?: unknown }>().code).toBe('AUTH_STEP_UP_REQUIRED');
    expect(response.body, 'no authorization URL is handed out').not.toContain(stub.issuer);
    expect(response.json<{ url?: unknown }>().url).toBeUndefined();
    expect(stub.authorizationRequests, 'the stub was never contacted').toHaveLength(requestsBefore);
    expect(await ssoAccountsOf(tenant.userId), 'nothing was linked').toHaveLength(0);
    expect(await ssoAccountsForSub(sub)).toHaveLength(0);
  }, 60_000);

  // Task 20.4 (design D24; Observability contract). Expected production
  // symbols: the `tayzu.auth.account_link.events` counter and the INFO log
  // events `auth.security.account_linked` / `auth.security.account_unlinked`
  // (`tayzu.tenant.id`, `tayzu.actor.id`, `tayzu.auth.link.actor`), emitted
  // with `link.actor` = `self` when a user links (`/link-social` callback) or
  // unlinks (`/unlink-account`) their own account. `tayzu.actor.id` is the
  // user's id and `tayzu.tenant.id` the session's active organization.
  function registeredHarness(): TelemetryTestHarness {
    if ('error' in registration) {
      throw new Error(`telemetry harness failed to register: ${String(registration.error)}`, {
        cause: registration.error,
      });
    }
    return registration.harness;
  }

  /** Completes the OAuth round trip of a self-service link for `cookie`'s user. */
  async function completeSelfLink(cookie: string, email: string, sub: string): Promise<void> {
    stub.setSubject({
      sub,
      email,
      name: 'Link User',
      sid: `sid-${randomUUID()}`,
      claims: { email_verified: true },
    });
    const initiated = await linkSocial(cookie);
    expect(initiated.statusCode, initiated.body).toBe(200);
    const approval = await fetch(initiated.json<{ url: string }>().url, { redirect: 'manual' });
    const page = await approval.text();
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
    const callbackCookie = [cookie, cookieFrom(initiated.headers['set-cookie'])]
      .filter((part) => part !== '')
      .join('; ');
    const headers = (): Record<string, string> => ({
      'x-forwarded-for': randomIp(),
      cookie: callbackCookie,
    });
    const posted = await authHandler(
      new Request(`${AUTH_BASE_URL}/callback/${PROVIDER_ID}`, {
        method: 'POST',
        headers: {
          ...headers(),
          'content-type': 'application/x-www-form-urlencoded',
          origin: ORIGIN,
        },
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
      await authHandler(
        new Request(new URL(location, AUTH_BASE_URL), { method: 'GET', headers: headers() }),
      );
    }
  }

  it('A self-service link emits auth.security.account_linked and the account_link counter (actor self)', async () => {
    const harness = registeredHarness();
    const { tenant, email, secret } = await enrolledUser();
    const cookie = await freshMfaSessionCookie(email, secret);
    const sub = `audit-sub-${randomUUID()}`;
    await harness.reset();

    await completeSelfLink(cookie, email, sub);

    expect(await ssoAccountsOf(tenant.userId), 'precondition: the link happened').toHaveLength(1);
    const events = await linkLogEvents(harness, 'auth.security.account_linked');
    expect(events).toHaveLength(1);
    const attributes = events[0]?.attributes;
    expect(attributes?.['tayzu.auth.link.actor']).toBe('self');
    expect(attributes?.['tayzu.actor.id']).toBe(tenant.userId);
    expect(attributes?.['tayzu.tenant.id']).toBe(tenant.organizationId);
    expect(events[0]?.severityText).toBe('INFO');
    const serialized = JSON.stringify(attributes);
    expect(serialized, 'no Visma Connect sub in telemetry').not.toContain(sub);
    expect(serialized, 'no email in telemetry').not.toContain(email);
    expect(linkCounterTotal(harness, 'linked', 'self')).toBe(1);
    expect(linkCounterTotal(harness, 'linked', 'admin')).toBe(0);
  }, 60_000);

  it('A self-service unlink emits auth.security.account_unlinked and the account_link counter (actor self)', async () => {
    const harness = registeredHarness();
    const { tenant, email, secret } = await enrolledUser();
    const cookie = await freshMfaSessionCookie(email, secret);
    const sub = `audit-sub-${randomUUID()}`;
    await completeSelfLink(cookie, email, sub);
    expect(await ssoAccountsOf(tenant.userId), 'precondition: linked').toHaveLength(1);
    await harness.reset();

    const rowId = (
      await db.execute<{ id: string }>(sql`
        select id from auth.account
        where user_id = ${tenant.userId} and provider_id = ${PROVIDER_ID}
      `)
    ).rows[0]?.id;
    if (rowId === undefined) {
      throw new Error('expected the linked account row');
    }

    // The user keeps their password, so the last-sign-in-method guard allows it.
    const response = await app.app.inject({
      method: 'POST',
      url: '/api/auth/unlink-account',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': randomIp(),
        origin: ORIGIN,
        host: 'localhost:3000',
        cookie,
      },
      payload: JSON.stringify({ providerId: PROVIDER_ID, accountId: rowId }),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(await ssoAccountsOf(tenant.userId), 'precondition: unlinked').toHaveLength(0);

    const events = await linkLogEvents(harness, 'auth.security.account_unlinked');
    expect(events).toHaveLength(1);
    const attributes = events[0]?.attributes;
    expect(attributes?.['tayzu.auth.link.actor']).toBe('self');
    expect(attributes?.['tayzu.actor.id']).toBe(tenant.userId);
    expect(attributes?.['tayzu.tenant.id']).toBe(tenant.organizationId);
    expect(await linkLogEvents(harness, 'auth.security.account_linked')).toHaveLength(0);
    expect(linkCounterTotal(harness, 'unlinked', 'self')).toBe(1);
    expect(linkCounterTotal(harness, 'unlinked', 'admin')).toBe(0);
  }, 60_000);

  it('A blocked self-service link (no fresh MFA) emits neither signal', async () => {
    const harness = registeredHarness();
    const { tenant, email, secret } = await enrolledUser();
    const cookie = await freshMfaSessionCookie(email, secret);
    const session = await (
      app.auth.api as {
        getSession(args: { headers: Headers }): Promise<{ session: { token: string } } | null>;
      }
    ).getSession({ headers: new Headers({ cookie }) });
    if (session === null) {
      throw new Error('expected the challenge-verified session to be valid');
    }
    await db.execute(sql`
      delete from auth.verification
      where identifier = ${`step-up-verified:${session.session.token}`}
    `);
    stub.setSubject({ sub: `blocked-audit-${randomUUID()}`, email, name: 'Link User' });
    await harness.reset();

    const response = await linkSocial(cookie);

    expect(response.statusCode).toBe(403);
    expect(await ssoAccountsOf(tenant.userId)).toHaveLength(0);
    expect(await linkLogEvents(harness, 'auth.security.account_linked')).toHaveLength(0);
    expect(linkCounterTotal(harness, 'linked', 'self')).toBe(0);
  }, 60_000);
});

/**
 * Task 23.14 (design Q43, Q49, Q50, D24; `specs/auth-and-rbac/spec.md`,
 * requirement "Account linking to Visma Connect is explicit and keyed on the
 * Visma Connect UserID").
 *
 * Task 23.14: "`/link-social` and `/unlink-account`, and `identity.users.
 * linkSsoAccount` / `unlinkSsoAccount` for the caller's own account, require
 * step-up: a fresh MFA verification, or a fresh password re-entry for a user
 * without MFA."
 *
 * Scenarios covered:
 * - "Linking without a fresh MFA verification is blocked for an MFA-enrolled
 *   user" (link, and unlinking the same way: `AUTH_STEP_UP_REQUIRED`; allowed
 *   with a fresh MFA verification).
 * - "Linking without a fresh password re-entry is blocked for a user without
 *   MFA" (link or unlink, marker absent or expired: `AUTH_STEP_UP_REQUIRED`;
 *   allowed right after `/verify-password`).
 * - Q50: the admin procedures are marked `x-tayzu-risk: high`, so 11.15's
 *   step-up applies to them.
 *
 * ## Harness
 *
 * The app is built by the production bootstrap, `createAppFromEnv(env)`, with
 * Visma Connect pointed at the task-19.1 local OIDC stub. Every request has a
 * fresh random `x-forwarded-for`, and every cookie-bearing POST sends `Origin`.
 * A user without MFA is a `member` (an unenrolled admin/owner is limited to MFA
 * enrollment, task 23.15) that signs in with the password alone: that session
 * has no freshness marker. An MFA user's "no fresh verification" state is the
 * same as in the first block of this file: the marker row is deleted.
 *
 * ## Production symbols expected
 *
 * - `POST /api/auth/verify-password` (Better Auth's own route, body
 *   `{ password }`) is reachable: it joins `ALLOWED_AUTH_ROUTES`
 *   (`packages/auth/src/http/allowed-routes.ts`, D18). A successful check on
 *   the current session writes the `step-up-verified:<session token>`
 *   `auth.verification` marker with a 5-minute window (Q49).
 * - The Fastify pre-handler of `POST /api/auth/link-social` also covers
 *   `POST /api/auth/unlink-account` and, for a user without an enrolled MFA
 *   factor, requires that same marker (a fresh password re-entry). Blocked
 *   requests answer `403` with body code `AUTH_STEP_UP_REQUIRED` before
 *   Better Auth runs.
 * - `createIdentityRouter` (`./identity-router.js`): `identity.users.
 *   linkSsoAccount` and `unlinkSsoAccount` have a route spec carrying
 *   `x-tayzu-risk: 'high'`.
 */
describe('self-service link and unlink step-up (task 23.14, design Q43, Q49, Q50, D24)', () => {
  const ENV_ORIGIN = 'https://app.tayzu.test';
  const STEP_UP_WINDOW_MS = 5 * 60 * 1000;
  let app: App;
  let stub: OidcStub;
  let db: ReturnType<typeof drizzle<typeof authSchema>>;
  let authHandler: (request: Request) => Promise<Response>;

  type MarkerRow = { readonly expires_at: Date | string };
  type LinkedRow = { readonly id: string };

  interface MemberApiSurface {
    addMember(args: {
      body: { userId: string; organizationId: string; role: 'member' };
    }): Promise<unknown>;
    getSession(args: { headers: Headers }): Promise<{ session: { token: string } } | null>;
  }

  interface LinkAdapterSurface {
    internalAdapter: {
      linkAccount(args: {
        userId: string;
        providerId: string;
        accountId: string;
      }): Promise<unknown>;
    };
  }

  beforeAll(async () => {
    const pools = await harnessPools();
    poolState.pools.set('app', pools.appPool);
    poolState.pools.set('auth', pools.authPool);
    stub = await startOidcStub();
    app = await createAppFromEnv({
      DATABASE_URL: 'postgres://tayzu_app:pw@db.invalid:5432/tayzu?sslmode=verify-full',
      AUTH_DATABASE_URL: 'postgres://tayzu_auth:pw@db.invalid:5432/tayzu?sslmode=verify-full',
      BETTER_AUTH_SECRET: TEST_SECRET,
      CERBOS_ADDRESS: 'localhost:3593',
      ALLOWED_ORIGINS: ENV_ORIGIN,
      // The link is initiated through Fastify and the callback goes to this same
      // origin, so the redirect_uri the OIDC stub sees is identical in both steps.
      BETTER_AUTH_URL: ENV_ORIGIN,
      VISMA_CONNECT_DISCOVERY_URL: stub.discoveryUrl,
      VISMA_CONNECT_CLIENT_ID: stub.clientId,
      VISMA_CONNECT_CLIENT_SECRET: stub.clientSecret,
    });
    db = drizzle(pools.authPool, { schema: authSchema });
    authHandler = authHandlerOf(app);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await stub.close();
    poolState.pools.clear();
  }, 60_000);

  function postAuth(cookie: string, path: string, body: Record<string, unknown>) {
    return app.app.inject({
      method: 'POST',
      url: `/api/auth${path}`,
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': randomIp(),
        origin: ENV_ORIGIN,
        host: 'localhost:3000',
        cookie,
      },
      payload: JSON.stringify(body),
    });
  }

  function linkSocialRequest(cookie: string) {
    return postAuth(cookie, '/link-social', { provider: PROVIDER_ID, callbackURL: '/' });
  }

  function unlinkRequest(cookie: string, accountRowId: string) {
    return postAuth(cookie, '/unlink-account', {
      providerId: PROVIDER_ID,
      accountId: accountRowId,
    });
  }

  function codeOf(response: { body: string }): unknown {
    try {
      return (JSON.parse(response.body) as { code?: unknown }).code;
    } catch {
      return undefined;
    }
  }

  /** An owner with an enrolled TOTP factor, and a session with a fresh MFA verification. */
  async function mfaUser(): Promise<{
    userId: string;
    email: string;
    secret: string;
    cookie: string;
  }> {
    const email = `link-mfa-${randomUUID()}@example.test`;
    const tenant = await bootstrapTestTenant(app.auth, {
      name: 'Link Mfa User',
      email,
      password: TEST_PASSWORD,
      organizationName: 'Link Mfa Org',
      organizationSlug: `link-mfa-${randomUUID()}`,
      ip: randomIp(),
    });
    const secret = await enrollTotp(app, {
      password: TEST_PASSWORD,
      enrollmentCookie: tenant.cookie,
    });
    const cookie = await signInWithTotp(app, {
      email,
      password: TEST_PASSWORD,
      secret,
      origin: ENV_ORIGIN,
    });
    return { userId: tenant.userId, email, secret, cookie };
  }

  /** A `member` without MFA, signed in with the password alone. */
  async function passwordUser(): Promise<{ userId: string; email: string; cookie: string }> {
    const owner = await bootstrapTestTenant(app.auth, {
      name: 'Link Owner',
      email: `link-owner-${randomUUID()}@example.test`,
      password: TEST_PASSWORD,
      organizationName: 'Link Pw Org',
      organizationSlug: `link-pw-${randomUUID()}`,
      ip: randomIp(),
    });
    const email = `link-pw-${randomUUID()}@example.test`;
    const created = await createAdminUser(app.auth, {
      name: 'Link Pw User',
      email,
      password: TEST_PASSWORD,
    });
    await (app.auth.api as MemberApiSurface).addMember({
      body: { userId: created.userId, organizationId: owner.organizationId, role: 'member' },
    });
    const signedIn = await app.app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': randomIp(),
        origin: ENV_ORIGIN,
        host: 'localhost:3000',
      },
      payload: JSON.stringify({ email, password: TEST_PASSWORD }),
    });
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    expect(
      signedIn.json<{ twoFactorRedirect?: unknown }>().twoFactorRedirect,
      'no additional factor is requested',
    ).toBeUndefined();
    return { userId: created.userId, email, cookie: cookieFrom(signedIn.headers['set-cookie']) };
  }

  async function dropMarker(cookie: string): Promise<void> {
    await db.execute(sql`
      delete from auth.verification
      where identifier = ${`step-up-verified:${sessionTokenOfCookie(cookie)}`}
    `);
  }

  async function markerOf(cookie: string): Promise<MarkerRow | undefined> {
    const result = await db.execute<MarkerRow>(sql`
      select expires_at from auth.verification
      where identifier = ${`step-up-verified:${sessionTokenOfCookie(cookie)}`}
    `);
    return result.rows[0];
  }

  /** A linked account row for `userId`, recorded without going through the self-service path. */
  async function seedLinkedAccount(userId: string): Promise<string> {
    const context = (await app.auth.$context) as LinkAdapterSurface;
    await context.internalAdapter.linkAccount({
      userId,
      providerId: PROVIDER_ID,
      accountId: `seed-sub-${randomUUID()}`,
    });
    const result = await db.execute<LinkedRow>(sql`
      select id from auth.account
      where user_id = ${userId} and provider_id = ${PROVIDER_ID}
    `);
    const id = result.rows[0]?.id;
    if (id === undefined) {
      throw new Error('expected the seeded linked account row');
    }
    return id;
  }

  async function linkedAccountCount(userId: string): Promise<number> {
    const result = await db.execute<{ n: string }>(sql`
      select count(*)::text as n from auth.account
      where user_id = ${userId} and provider_id = ${PROVIDER_ID}
    `);
    return Number(result.rows[0]?.n ?? '0');
  }

  /** Runs the OAuth round trip of a self-service link that the pre-handler let start. */
  async function completeLink(cookie: string, email: string, sub: string): Promise<void> {
    stub.setSubject({
      sub,
      email,
      name: 'Link User',
      sid: `sid-${randomUUID()}`,
      claims: { email_verified: true },
    });
    const initiated = await linkSocialRequest(cookie);
    expect(initiated.statusCode, initiated.body).toBe(200);
    const approval = await fetch(initiated.json<{ url: string }>().url, { redirect: 'manual' });
    const page = await approval.text();
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
    const callbackCookie = [cookie, cookieFrom(initiated.headers['set-cookie'])]
      .filter((part) => part !== '')
      .join('; ');
    const headers = (): Record<string, string> => ({
      'x-forwarded-for': randomIp(),
      cookie: callbackCookie,
    });
    const callbackBase = `${ENV_ORIGIN}/api/auth`;
    const posted = await authHandler(
      new Request(`${callbackBase}/callback/${PROVIDER_ID}`, {
        method: 'POST',
        headers: {
          ...headers(),
          'content-type': 'application/x-www-form-urlencoded',
          origin: ENV_ORIGIN,
        },
        body: params.toString(),
      }),
    );
    const location = posted.headers.get('location');
    if (
      posted.status >= 300 &&
      posted.status < 400 &&
      location !== null &&
      new URL(location, callbackBase).pathname.endsWith(`/callback/${PROVIDER_ID}`)
    ) {
      await authHandler(
        new Request(new URL(location, callbackBase), { method: 'GET', headers: headers() }),
      );
    }
  }

  function expectBlocked(response: { statusCode: number; body: string }): void {
    expect(response.statusCode, response.body).toBe(403);
    expect(codeOf(response)).toBe('AUTH_STEP_UP_REQUIRED');
  }

  it('Linking without a fresh MFA verification is blocked for an MFA-enrolled user (link): AUTH_STEP_UP_REQUIRED', async () => {
    const user = await mfaUser();
    await dropMarker(user.cookie);
    stub.setSubject({ sub: `mfa-blocked-${randomUUID()}`, email: user.email, name: 'Link User' });
    const requestsBefore = stub.authorizationRequests.length;

    const response = await linkSocialRequest(user.cookie);

    expectBlocked(response);
    expect(stub.authorizationRequests, 'the stub was never contacted').toHaveLength(requestsBefore);
    expect(await linkedAccountCount(user.userId)).toBe(0);
  }, 60_000);

  it('Unlinking without a fresh MFA verification is blocked for an MFA-enrolled user: AUTH_STEP_UP_REQUIRED, the account stays linked', async () => {
    const user = await mfaUser();
    const rowId = await seedLinkedAccount(user.userId);
    await dropMarker(user.cookie);

    const response = await unlinkRequest(user.cookie, rowId);

    expectBlocked(response);
    expect(await linkedAccountCount(user.userId), 'the account is still linked').toBe(1);
  }, 60_000);

  it('Unlinking with a fresh MFA verification is allowed for an MFA-enrolled user', async () => {
    const user = await mfaUser();
    const rowId = await seedLinkedAccount(user.userId);

    // The user keeps their password, so the last-sign-in-method guard allows it.
    const response = await unlinkRequest(user.cookie, rowId);

    expect(response.statusCode, response.body).toBe(200);
    expect(await linkedAccountCount(user.userId)).toBe(0);
  }, 60_000);

  it('Linking without a fresh password re-entry is blocked for a user without MFA (link, marker absent): AUTH_STEP_UP_REQUIRED', async () => {
    const user = await passwordUser();
    stub.setSubject({ sub: `pw-blocked-${randomUUID()}`, email: user.email, name: 'Link User' });
    const requestsBefore = stub.authorizationRequests.length;

    expect(await markerOf(user.cookie), 'precondition: no freshness marker').toBeUndefined();
    const response = await linkSocialRequest(user.cookie);

    expectBlocked(response);
    expect(stub.authorizationRequests, 'the stub was never contacted').toHaveLength(requestsBefore);
    expect(await linkedAccountCount(user.userId)).toBe(0);
  }, 60_000);

  it('Linking without a fresh password re-entry is blocked for a user without MFA (link, marker expired): AUTH_STEP_UP_REQUIRED', async () => {
    const user = await passwordUser();
    const verified = await postAuth(user.cookie, '/verify-password', { password: TEST_PASSWORD });
    expect(verified.statusCode, verified.body).toBe(200);
    await db.execute(sql`
      update auth.verification
      set expires_at = now() - interval '1 minute'
      where identifier = ${`step-up-verified:${sessionTokenOfCookie(user.cookie)}`}
    `);
    stub.setSubject({ sub: `pw-expired-${randomUUID()}`, email: user.email, name: 'Link User' });

    const response = await linkSocialRequest(user.cookie);

    expectBlocked(response);
    expect(await linkedAccountCount(user.userId)).toBe(0);
  }, 60_000);

  it('Unlinking without a fresh password re-entry is blocked for a user without MFA (marker absent): AUTH_STEP_UP_REQUIRED', async () => {
    const user = await passwordUser();
    const rowId = await seedLinkedAccount(user.userId);

    const response = await unlinkRequest(user.cookie, rowId);

    expectBlocked(response);
    expect(await linkedAccountCount(user.userId), 'the account is still linked').toBe(1);
  }, 60_000);

  it('Unlinking without a fresh password re-entry is blocked for a user without MFA (marker expired): AUTH_STEP_UP_REQUIRED', async () => {
    const user = await passwordUser();
    const rowId = await seedLinkedAccount(user.userId);
    const verified = await postAuth(user.cookie, '/verify-password', { password: TEST_PASSWORD });
    expect(verified.statusCode, verified.body).toBe(200);
    await db.execute(sql`
      update auth.verification
      set expires_at = now() - interval '1 minute'
      where identifier = ${`step-up-verified:${sessionTokenOfCookie(user.cookie)}`}
    `);

    const response = await unlinkRequest(user.cookie, rowId);

    expectBlocked(response);
    expect(await linkedAccountCount(user.userId), 'the account is still linked').toBe(1);
  }, 60_000);

  it('Linking right after a password re-entry is allowed for a user without MFA, and /verify-password records the same 5-minute marker', async () => {
    const user = await passwordUser();
    const before = Date.now();

    const verified = await postAuth(user.cookie, '/verify-password', { password: TEST_PASSWORD });
    expect(verified.statusCode, verified.body).toBe(200);

    const marker = await markerOf(user.cookie);
    expect(marker, 'the step-up marker is written for the current session').toBeDefined();
    const expiresAt = new Date(marker?.expires_at ?? 0).getTime();
    expect(expiresAt).toBeGreaterThan(before + STEP_UP_WINDOW_MS - 60_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + STEP_UP_WINDOW_MS + 5_000);

    const sub = `pw-allowed-${randomUUID()}`;
    await completeLink(user.cookie, user.email, sub);
    const linked = await db.execute<{ account_id: string }>(sql`
      select account_id from auth.account
      where user_id = ${user.userId} and provider_id = ${PROVIDER_ID}
    `);
    expect(linked.rows.map((row) => row.account_id)).toEqual([sub]);
  }, 60_000);

  it('Unlinking right after a password re-entry is allowed for a user without MFA', async () => {
    const user = await passwordUser();
    const rowId = await seedLinkedAccount(user.userId);
    const verified = await postAuth(user.cookie, '/verify-password', { password: TEST_PASSWORD });
    expect(verified.statusCode, verified.body).toBe(200);

    // The user keeps their password, so the last-sign-in-method guard allows it.
    const response = await unlinkRequest(user.cookie, rowId);

    expect(response.statusCode, response.body).toBe(200);
    expect(await linkedAccountCount(user.userId)).toBe(0);
  }, 60_000);

  it('identity.users.linkSsoAccount and unlinkSsoAccount are marked x-tayzu-risk: high (step-up applies)', () => {
    const router = createIdentityRouter({
      auth: app.auth,
      authz: createCerbosClient({ address: 'localhost:3593', tls: false }),
    });
    const riskOf = (procedure: unknown): unknown => {
      const route = (procedure as { '~orpc': { route: { spec?: unknown } } })['~orpc'].route;
      const spec =
        typeof route.spec === 'function'
          ? (route.spec as (operation: object) => unknown)({})
          : route.spec;
      return (spec as Record<string, unknown> | undefined)?.['x-tayzu-risk'];
    };

    expect(riskOf(router.identity.users.linkSsoAccount)).toBe('high');
    expect(riskOf(router.identity.users.unlinkSsoAccount)).toBe('high');
  });
});
