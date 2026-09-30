/**
 * Integration test for task 23.5 (design Q35, D25; `specs/auth-and-rbac/spec.md`,
 * "Step-up authentication for high-risk operations" and "Visma Connect SSO
 * sign-in").
 *
 * The Visma sign-in must populate `session.ssoSid` from the ID token `sid`
 * (left `null` for local sessions and when the token omits `sid`), so the D25
 * SSO step-up branch is reachable.
 *
 * Tests:
 * - a real SSO sign-in through `auth.handler` produces a session whose
 *   `ssoSid` equals the token's `sid`;
 * - a local sign-in leaves `ssoSid` `null`;
 * - an SSO sign-in whose ID token omits `sid` leaves `ssoSid` `null`;
 * - the step-up guard takes the Visma Connect branch for the SSO-created
 *   session (a qualifying re-authorization token satisfies it, span method
 *   `visma_connect`; an insufficient one is `AUTH_STEP_UP_REQUIRED` with
 *   `step_up_insufficient`), while a local session does not.
 *
 * No raw SQL: sessions are read through `auth.api.getSession`, the linked
 * account is inserted through the Drizzle schema.
 *
 * ## Expected production behavior (the red phase)
 *
 * The Visma sign-in (genericOAuth `getUserInfo`/session hooks in `auth.ts`)
 * writes the ID token `sid` claim into `session.ssoSid`. Today nothing writes
 * it, so the session's `ssoSid` is always `null`.
 *
 * Harness as in `sso-sign-in.int.test.ts`: the task-19.1 OIDC stub, the flow
 * driven through `auth.handler(new Request(...))` with a fresh random
 * `x-forwarded-for` per request.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { runMigrations } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Import order is load-bearing (design D1): the harness registers first.
import { bootstrapTestTenant } from './__fixtures__/admin-user.js';
import { startOidcStub, type OidcStub } from './__fixtures__/oidc-stub.js';
import { registration, type TelemetryTestHarness } from './__fixtures__/registered-harness.js';
import { TEST_PASSWORD, TEST_SECRET } from './__fixtures__/test-secret.js';
import { createAuth, type AuthInstance } from './auth.js';
import * as authSchema from './persistence/schema.js';
import { createStepUpGuard } from './step-up.js';
import type { AssertStepUpParams, StepUpGuard } from './step-up.js';

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
    // Expected only during teardown.
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

interface SessionApiSurface {
  getSession(input: { headers: Headers }): Promise<{ session: { ssoSid?: string | null } } | null>;
}

/** `AuthInstance.api` is typed `unknown`; narrow it to the one call this file makes. */
function sessionApiOf(auth: AuthInstance): SessionApiSurface {
  return (auth as unknown as { api: SessionApiSurface }).api;
}

function registeredHarness(): TelemetryTestHarness {
  if ('error' in registration) {
    throw new Error(
      `createTelemetryTestHarness() failed while the test module graph loaded: ${String(registration.error)}`,
      { cause: registration.error },
    );
  }
  return registration.harness;
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
      new Request(new URL(location, AUTH_BASE_URL), { method: 'GET', headers: headers({}) }),
    );
  }
  return posted;
}

function sessionCookieOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((raw) => raw.split(';')[0])
    .filter((pair) => pair?.includes('session_token') === true)
    .join('; ');
}

describe('session.ssoSid population (task 23.5, design Q35/D25)', () => {
  let db: TestDb;
  let auth: AuthInstance;
  let stub: OidcStub;
  let guard: StepUpGuard;

  beforeAll(async () => {
    db = connect(databaseUrl());
    await runMigrations(db.$client);
    stub = await startOidcStub();
    const sso = {
      discoveryUrl: stub.discoveryUrl,
      clientId: stub.clientId,
      clientSecret: stub.clientSecret,
    };
    auth = createAuth({ db, secret: TEST_SECRET, sso });
    guard = createStepUpGuard({ auth, sso });
  }, 60_000);

  afterAll(async () => {
    await stub.close();
    await endQuietly(db.$client);
  });

  async function localUser(): Promise<{
    cookie: string;
    userId: string;
    organizationId: string;
  }> {
    return bootstrapTestTenant(auth, {
      name: 'Sid Person',
      email: `sid-${randomUUID()}@example.test`,
      password: TEST_PASSWORD,
      organizationName: 'Sid Org',
      organizationSlug: `sid-${randomUUID()}`,
      ip: randomIp(),
    });
  }

  /** Links a fresh Visma `sub` to a fresh Tayzu user, then completes a real SSO sign-in. */
  async function ssoSignIn(sid: string | undefined): Promise<{
    cookie: string;
    userId: string;
    organizationId: string;
  }> {
    const tenant = await localUser();
    const sub = `sid-sub-${randomUUID()}`;
    await db.insert(authSchema.account).values({
      id: randomUUID(),
      accountId: sub,
      providerId: PROVIDER_ID,
      userId: tenant.userId,
    });
    stub.setSubject({
      sub,
      email: `other-${randomUUID()}@example.test`,
      name: 'Sid Person',
      ...(sid !== undefined ? { sid } : {}),
    });
    const { cookie, params } = await initiateSignIn(auth);
    const response = await completeCallback(auth, cookie, params);
    expect(response.status, 'the SSO sign-in succeeds').toBeLessThan(400);
    const ssoCookie = sessionCookieOf(response);
    expect(ssoCookie, 'a session is established').not.toBe('');
    return { ...tenant, cookie: ssoCookie };
  }

  async function ssoSidOf(cookie: string): Promise<unknown> {
    const session = await sessionApiOf(auth).getSession({ headers: new Headers({ cookie }) });
    expect(session, 'the session resolves').not.toBeNull();
    return session?.session.ssoSid ?? null;
  }

  function reauthToken(sid: string, claims: Record<string, unknown>): string {
    const now = Math.floor(Date.now() / 1000);
    return stub.signJwt({
      iss: stub.issuer,
      aud: stub.clientId,
      sub: `sub-${randomUUID()}`,
      sid,
      iat: now,
      exp: now + 300,
      auth_time: now,
      ...claims,
    });
  }

  function stepUpParams(
    user: { cookie: string; userId: string; organizationId: string },
    idToken: string,
  ): AssertStepUpParams {
    return {
      headers: new Headers({ cookie: user.cookie }),
      tenantId: user.organizationId,
      actor: { type: 'user', id: user.userId },
      route: { riskLevel: 'high' },
      operation: 'blueprint.delete',
      reauthorization: { idToken },
    };
  }

  it("A Visma Connect sign-in populates session.ssoSid with the ID token's sid", async () => {
    const sid = `sid-${randomUUID()}`;
    const user = await ssoSignIn(sid);
    expect(await ssoSidOf(user.cookie)).toBe(sid);
  }, 60_000);

  it('A local sign-in leaves session.ssoSid null', async () => {
    const user = await localUser();
    expect(await ssoSidOf(user.cookie)).toBeNull();
  }, 60_000);

  it('A Visma Connect sign-in whose ID token omits sid leaves session.ssoSid null', async () => {
    const user = await ssoSignIn(undefined);
    expect(await ssoSidOf(user.cookie)).toBeNull();
  }, 60_000);

  it('The step-up guard takes the Visma Connect branch for an SSO-created session', async () => {
    const harness = registeredHarness();
    const sid = `sid-${randomUUID()}`;
    const user = await ssoSignIn(sid);
    await harness.reset();

    // A qualifying re-authorization satisfies step-up: only possible on the SSO branch.
    await expect(
      guard(stepUpParams(user, reauthToken(sid, { acr: 3, amr: ['pwd', 'otp'] }))),
    ).resolves.toBeUndefined();

    // A non-qualifying one is rejected on that same branch.
    await expect(
      guard(stepUpParams(user, reauthToken(sid, { acr: 2, amr: ['pwd'] }))),
    ).rejects.toMatchObject({ code: 'AUTH_STEP_UP_REQUIRED' });

    await harness.forceFlush();
    const spans = harness.spanExporter
      .getFinishedSpans()
      .filter((span) => span.name === 'auth.session.step_up_check');
    expect(spans.map((s) => s.attributes['tayzu.auth.method'])).toEqual([
      'visma_connect',
      'visma_connect',
    ]);
    const insufficient = [...harness.logExporter.getFinishedLogRecords()].filter(
      (record) => record.eventName === 'auth.security.step_up_insufficient',
    );
    expect(insufficient).toHaveLength(1);
    expect(insufficient[0]?.attributes['tayzu.auth.method']).toBe('visma_connect');
  }, 60_000);

  it('The step-up guard does not take the Visma Connect branch for a local session', async () => {
    const harness = registeredHarness();
    const user = await localUser();
    await harness.reset();

    // The same qualifying token cannot satisfy a local session: it needs local TOTP step-up.
    await expect(
      guard(
        stepUpParams(user, reauthToken(`sid-${randomUUID()}`, { acr: 3, amr: ['pwd', 'otp'] })),
      ),
    ).rejects.toMatchObject({ code: 'AUTH_STEP_UP_REQUIRED' });

    await harness.forceFlush();
    const spans = harness.spanExporter
      .getFinishedSpans()
      .filter((span) => span.name === 'auth.session.step_up_check');
    expect(spans[0]?.attributes['tayzu.auth.method']).toBe('local');
  }, 60_000);
});
