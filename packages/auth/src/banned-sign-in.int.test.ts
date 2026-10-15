/**
 * Task 13.4 of openspec/changes/archive/2026-10-14-043-identity-lifecycle-and-org-admin (design
 * D13, Resolved decision Q54). Spec scenario, quoted from
 * `specs/identity-lifecycle-and-org-admin/spec.md`:
 *
 * #### Scenario: A disabled user's sessions stop working
 * - GIVEN an `Active` user with a single membership and a live session
 * - WHEN an admin disables the user
 * - THEN the next request on that session is rejected with
 *   `CATALOG_CONTEXT_REQUIRED` (401) and no reason in the body, a new sign-in
 *   (local or SSO) is refused, and a session of that user that the deletion did
 *   not reach (seeded directly) is rejected with
 *   `catalog.security.principal_rejected` and the reason `user_banned`
 *
 * This file covers "a new sign-in (local or SSO) is refused" for a banned user:
 * the local `/sign-in/email` with the correct password creates no session and
 * answers an error, and the Visma Connect callback of a banned, linked user
 * answers the one `401 AUTH_SSO_REJECTED` with no session. The uniformity of the
 * local failure with a wrong password and the `account_disabled` log are task
 * 13.4b's (`enumeration-resistance.int.test.ts`), not asserted here. The
 * `catalog.security.banned_sign_in_attempt` event is 13.4b's as well.
 *
 * ## Production symbols expected
 *
 * None new. Better Auth's admin plugin already refuses a banned user's session
 * creation after a correct password, and `auth.ts` already turns every SSO
 * callback failure into `401 AUTH_SSO_REJECTED`, so these tests are expected to
 * pass on arrival.
 *
 * ## Harness
 *
 * `auth.handler(new Request(...))` with a fresh random `x-forwarded-for` per
 * request; a fresh random tenant per test; the SSO flow follows
 * `sso-sign-in.int.test.ts` (task-19.1 OIDC stub).
 */
import { randomInt, randomUUID } from 'node:crypto';

import { SeverityNumber, type AnyValueMap } from '@opentelemetry/api-logs';
import { runMigrations } from '@tayzu/db';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Import order is load-bearing (design D1): the harness registers before `./auth.js`.
import './__fixtures__/registered-harness.js';
import { bootstrapTestTenant, testAppPool } from './__fixtures__/admin-user.js';
import { registration, type TelemetryTestHarness } from './__fixtures__/registered-harness.js';
import { startOidcStub, type OidcStub } from './__fixtures__/oidc-stub.js';
import { TEST_PASSWORD, TEST_SECRET } from './__fixtures__/test-secret.js';
import { createAuth, type AuthInstance } from './auth.js';
import * as authSchema from './persistence/schema.js';

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim() === '') {
    throw new Error(
      'DATABASE_URL is not set: the int project global setup should have stopped this run.',
    );
  }
  return url;
}

function connect(url: string): ReturnType<typeof drizzle<typeof authSchema>> {
  return drizzle(url, { schema: authSchema });
}

type TestDb = ReturnType<typeof connect>;

async function endQuietly(closeable: {
  on(event: 'error', listener: (error: unknown) => void): unknown;
  end(): Promise<void>;
}): Promise<void> {
  closeable.on('error', () => {
    // Expected only during teardown; nothing left to report it to.
  });
  await closeable.end();
}

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

function hasSessionCookie(response: Response): boolean {
  return response.headers.getSetCookie().some((c) => c.includes('session_token'));
}

interface CallbackParams {
  readonly code: string;
  readonly state: string;
  readonly iss?: string;
}

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
  return {
    cookie: cookieHeaderFrom(initiated),
    params: { code, state, ...(inputs['iss'] !== undefined ? { iss: inputs['iss'] } : {}) },
  };
}

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
      new Request(new URL(location, AUTH_BASE_URL), {
        method: 'GET',
        headers: headers({}),
      }),
    );
  }
  return posted;
}

describe('A banned user is refused at sign-in (task 13.4, D13)', () => {
  let db: TestDb;
  let auth: AuthInstance;
  let stub: OidcStub;

  beforeAll(async () => {
    db = connect(databaseUrl());
    await runMigrations(db.$client);
    stub = await startOidcStub();
    auth = createAuth({
      db,
      secret: TEST_SECRET,
      sso: {
        discoveryUrl: stub.discoveryUrl,
        clientId: stub.clientId,
        clientSecret: stub.clientSecret,
      },
    });
  }, 60_000);

  afterAll(async () => {
    await stub.close();
    await endQuietly(db.$client);
  });

  async function newUser(): Promise<{ userId: string; email: string }> {
    const email = `banned-${randomUUID()}@example.test`;
    const tenant = await bootstrapTestTenant(auth, {
      pool: testAppPool(),
      name: 'Banned Sign-In User',
      email,
      password: TEST_PASSWORD,
      organizationName: 'Banned Sign-In Org',
      organizationSlug: `banned-${randomUUID()}`,
      ip: randomIp(),
    });
    return { userId: tenant.userId, email };
  }

  async function setBanned(userId: string, banned: boolean): Promise<void> {
    await db.execute(sql`update auth."user" set banned = ${banned} where id = ${userId}`);
  }

  async function sessionCount(userId: string): Promise<number> {
    const result = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from auth.session where user_id = ${userId}`,
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  function signInEmail(email: string, password: string): Promise<Response> {
    return handlerOf(auth)(
      new Request(`${AUTH_BASE_URL}/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': randomIp() },
        body: JSON.stringify({ email, password }),
      }),
    );
  }

  it('A banned user is refused at local sign-in with the correct password: an error, no session cookie and no new session row', async () => {
    const user = await newUser();
    const before = await sessionCount(user.userId);
    expect(before, 'sanity: the bootstrap sign-in created one session').toBe(1);

    // control: before the ban the same credentials sign in.
    const allowed = await signInEmail(user.email, TEST_PASSWORD);
    expect(allowed.status, 'control: not banned yet').toBe(200);
    const afterControl = await sessionCount(user.userId);
    expect(afterControl).toBe(2);

    await setBanned(user.userId, true);
    const refused = await signInEmail(user.email, TEST_PASSWORD);

    expect(refused.status, 'a client or authorization error').toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    expect(hasSessionCookie(refused), 'no session cookie is set').toBe(false);
    expect(await sessionCount(user.userId), 'no new session row').toBe(afterControl);

    // AND clearing the ban lets the user sign in again.
    await setBanned(user.userId, false);
    const restored = await signInEmail(user.email, TEST_PASSWORD);
    expect(restored.status).toBe(200);
  }, 60_000);

  it('A banned user is refused at the SSO callback: the uniform 401 AUTH_SSO_REJECTED with no session', async () => {
    const user = await newUser();
    const sub = `banned-sub-${randomUUID()}`;
    await db.insert(authSchema.account).values({
      id: randomUUID(),
      accountId: sub,
      providerId: PROVIDER_ID,
      userId: user.userId,
    });
    const identity = {
      sub,
      email: `idp-${randomUUID()}@example.test`,
      name: 'Banned Sso Person',
    };

    // control: before the ban the linked sub signs in.
    stub.setSubject({ ...identity, sid: `sid-${randomUUID()}` });
    const first = await initiateSignIn(auth, stub);
    const allowed = await completeCallback(auth, first.cookie, first.params);
    expect(allowed.status, 'control: not banned yet').toBeLessThan(400);
    expect(hasSessionCookie(allowed), 'control: a session is established').toBe(true);
    const sessionsBefore = await sessionCount(user.userId);

    await setBanned(user.userId, true);
    stub.setSubject({ ...identity, sid: `sid-${randomUUID()}` });
    const second = await initiateSignIn(auth, stub);
    const refused = await completeCallback(auth, second.cookie, second.params);
    const bodyText = await refused.text();

    expect(refused.status).toBe(401);
    expect((JSON.parse(bodyText) as { code?: unknown }).code).toBe('AUTH_SSO_REJECTED');
    expect(hasSessionCookie(refused), 'no session cookie is set').toBe(false);
    expect(await sessionCount(user.userId), 'no new session row').toBe(sessionsBefore);
    expect(bodyText).not.toMatch(/banned/i);
  }, 60_000);

  /**
   * Task 16.12l (Resolved decision Q149). Spec scenario "A banned user's sign-in is
   * indistinguishable from a wrong password": the SSO path's response has the same status, error
   * code and body as another SSO sign-in failure (an unlinked sub). Expected to pass on arrival:
   * `auth.ts` already turns every callback failure into the one `401 AUTH_SSO_REJECTED`.
   */
  it("A banned user's sign-in is indistinguishable: the SSO callback of a banned, linked user has the same status, headers that matter and body as an unlinked SSO sign-in failure", async () => {
    // Reference failure: a never-linked sub.
    stub.setSubject({
      sub: `unlinked-${randomUUID()}`,
      email: `idp-unlinked-${randomUUID()}@example.test`,
      name: 'Unlinked Person',
      sid: `sid-${randomUUID()}`,
    });
    const reference = await initiateSignIn(auth, stub);
    const unlinked = await completeCallback(auth, reference.cookie, reference.params);
    const unlinkedBody = await unlinked.text();

    const user = await newUser();
    const sub = `banned-same-${randomUUID()}`;
    await db.insert(authSchema.account).values({
      id: randomUUID(),
      accountId: sub,
      providerId: PROVIDER_ID,
      userId: user.userId,
    });
    await setBanned(user.userId, true);
    stub.setSubject({
      sub,
      email: `idp-${randomUUID()}@example.test`,
      name: 'Banned Same Person',
      sid: `sid-${randomUUID()}`,
    });
    const started = await initiateSignIn(auth, stub);
    const banned = await completeCallback(auth, started.cookie, started.params);
    const bannedBody = await banned.text();

    expect(unlinked.status).toBe(401);
    expect(banned.status).toBe(unlinked.status);
    expect((JSON.parse(bannedBody) as { code?: unknown }).code).toBe('AUTH_SSO_REJECTED');
    expect(banned.headers.get('content-type')).toBe(unlinked.headers.get('content-type'));
    expect(bannedBody, 'identical body text').toBe(unlinkedBody);
    expect(hasSessionCookie(banned)).toBe(false);
  }, 60_000);
});

/**
 * Task 13.4b (design D13, Q54). The attempt of a banned user is logged
 * internally as `catalog.security.banned_sign_in_attempt` (WARN) with
 * `tayzu.identity.user.id` and `tayzu.identity.sign_in.channel` (`local` |
 * `sso`) and no email, once per attempt on each channel, while the response
 * stays uniform (the SSO one is the `401 AUTH_SSO_REJECTED` above).
 *
 * Production symbols expected: the emission from `auth.ts` (through the
 * identity telemetry helpers); the event name is declared in 15.1.
 */
describe('A banned sign-in attempt is logged once per attempt with its channel (task 13.4b, D13)', () => {
  let db: TestDb;
  let auth: AuthInstance;
  let stub: OidcStub;
  let harness: TelemetryTestHarness;

  beforeAll(async () => {
    db = connect(databaseUrl());
    await runMigrations(db.$client);
    stub = await startOidcStub();
    auth = createAuth({
      db,
      secret: TEST_SECRET,
      sso: {
        discoveryUrl: stub.discoveryUrl,
        clientId: stub.clientId,
        clientSecret: stub.clientSecret,
      },
    });
    if ('error' in registration) {
      throw new Error('createTelemetryTestHarness() failed while the module graph loaded', {
        cause: registration.error,
      });
    }
    harness = registration.harness;
  }, 60_000);

  afterAll(async () => {
    await stub.close();
    await endQuietly(db.$client);
  });

  async function bannedUser(): Promise<{ userId: string; email: string }> {
    const email = `banned-log-${randomUUID()}@example.test`;
    const tenant = await bootstrapTestTenant(auth, {
      pool: testAppPool(),
      name: 'Banned Log User',
      email,
      password: TEST_PASSWORD,
      organizationName: 'Banned Log Org',
      organizationSlug: `banned-log-${randomUUID()}`,
      ip: randomIp(),
    });
    await db.execute(sql`update auth."user" set banned = true where id = ${tenant.userId}`);
    return { userId: tenant.userId, email };
  }

  async function attempts(): Promise<
    { severity: SeverityNumber | undefined; attributes: AnyValueMap; body: unknown }[]
  > {
    await harness.forceFlush();
    return [...harness.logExporter.getFinishedLogRecords()]
      .filter((record) => record.eventName === 'catalog.security.banned_sign_in_attempt')
      .map((record) => ({
        severity: record.severityNumber,
        attributes: record.attributes,
        body: record.body,
      }));
  }

  it('A banned local sign-in emits one banned_sign_in_attempt with channel local, the user id and no email', async () => {
    const user = await bannedUser();
    await harness.reset();

    const refused = await handlerOf(auth)(
      new Request(`${AUTH_BASE_URL}/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': randomIp() },
        body: JSON.stringify({ email: user.email, password: TEST_PASSWORD }),
      }),
    );
    expect(refused.status).toBeGreaterThanOrEqual(400);

    const records = await attempts();
    expect(records, 'once per banned attempt').toHaveLength(1);
    expect(records[0]?.severity).toBe(SeverityNumber.WARN);
    expect(records[0]?.attributes).toEqual({
      'tayzu.identity.user.id': user.userId,
      'tayzu.identity.sign_in.channel': 'local',
    });
    expect(JSON.stringify(records)).not.toContain(user.email);
  }, 60_000);

  it('A banned SSO callback emits one banned_sign_in_attempt with channel sso, the user id and no email', async () => {
    const user = await bannedUser();
    const sub = `banned-log-sub-${randomUUID()}`;
    await db.insert(authSchema.account).values({
      id: randomUUID(),
      accountId: sub,
      providerId: PROVIDER_ID,
      userId: user.userId,
    });
    const idpEmail = `idp-${randomUUID()}@example.test`;
    stub.setSubject({ sub, email: idpEmail, name: 'Banned Log Sso', sid: `sid-${randomUUID()}` });
    const started = await initiateSignIn(auth, stub);
    await harness.reset();

    const refused = await completeCallback(auth, started.cookie, started.params);
    expect(refused.status).toBe(401);

    const records = await attempts();
    expect(records, 'once per banned attempt').toHaveLength(1);
    expect(records[0]?.severity).toBe(SeverityNumber.WARN);
    expect(records[0]?.attributes).toEqual({
      'tayzu.identity.user.id': user.userId,
      'tayzu.identity.sign_in.channel': 'sso',
    });
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain(user.email);
    expect(serialized).not.toContain(idpEmail);
  }, 60_000);
});
