/**
 * Integration test for task 19.4 (design D24 "Rejection", resolved decisions
 * Q16-Q18; `specs/auth-and-rbac/spec.md`, "Visma Connect SSO sign-in").
 *
 * Scenarios covered (exactly the two the task's Verify clause names):
 *
 * - "Sign-in with an unlinked Visma Connect account is rejected generically":
 *   GIVEN a Visma Connect `sub` with no linked Tayzu user, WHEN that person
 *   completes sign-in through Visma Connect, THEN it fails with
 *   `AUTH_SSO_REJECTED`, and no user account is created.
 * - "A mismatched state value is rejected the same way as an unlinked
 *   account": GIVEN a callback whose `state` does not match, WHEN it is
 *   processed, THEN it fails with the same `AUTH_SSO_REJECTED` status, error
 *   code, and body shape as an unlinked account.
 *
 * Plus design D24's "recording the internal cause only on
 * `auth.security.sso_sign_in_failed`" (`tayzu.auth.failure_reason` is
 * `sso_unlinked` / `sso_state_mismatch`; never in the HTTP response).
 *
 * ## Assumed production behavior (the red phase)
 *
 * `auth.handler` (the real HTTP entry point `apps/api` mounts) answers a
 * failed `/callback/visma-connect` request with `401` and a JSON body whose
 * `code` is `AUTH_SSO_REJECTED`, identical (status, headers that matter, and
 * body text) for every failure cause. Today Better Auth answers with a `302`
 * redirect to `/api/auth/error?error=<cause-specific code>`, which differs per
 * cause, so these tests fail on plain assertions.
 *
 * ## Harness
 *
 * `createAuth({ db, secret, sso })` with `sso.discoveryUrl` pointed at the
 * task-19.1 OIDC stub (never the real Visma Connect). The flow is driven
 * through `auth.handler(new Request(...))`, with a fresh random
 * `x-forwarded-for` per request so the 2.5 rate limiter never interferes:
 * 1. `POST /sign-in/social { provider: 'visma-connect' }` returns the
 *    authorization URL (and possibly a state cookie).
 * 2. The stub's authorization endpoint (auto-approve, `form_post`) returns an
 *    auto-submitting page; its hidden inputs are the callback parameters.
 * 3. The callback is `POST`ed form-encoded; Better Auth's `POST` handler
 *    answers with a redirect to the same URL as `GET`, which is followed once
 *    with the same cookies (what a browser does). The final response is what
 *    is asserted.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { runMigrations } from '@tayzu/db';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Import order is load-bearing (design D1; `packages/observability/CLAUDE.md`):
// the harness must register before `./auth.js` creates its instruments.
import { registration, type TelemetryTestHarness } from './__fixtures__/registered-harness.js';
import { startOidcStub, type OidcStub } from './__fixtures__/oidc-stub.js';
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

const TEST_SECRET = 'int-test-only-secret-not-used-for-anything-real-0123456789';
const AUTH_BASE_URL = 'http://localhost:3000/api/auth';
const PROVIDER_ID = 'visma-connect';

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

function handlerOf(auth: AuthInstance): (request: Request) => Promise<Response> {
  return (auth as unknown as { handler: (request: Request) => Promise<Response> }).handler;
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

/** A `cookie` request header from a response's `Set-Cookie` headers (possibly none). */
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

interface InitiatedSignIn {
  readonly cookie: string;
  readonly params: CallbackParams;
}

/** Steps 1 and 2 of the module doc comment: initiate, then let the stub approve. */
async function initiateSignIn(auth: AuthInstance, stub: OidcStub): Promise<InitiatedSignIn> {
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

/** Step 3: POST the callback, then follow the same-URL `GET` redirect once, like a browser. */
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

type CountRow = { readonly n: string };

async function countRows(db: TestDb, query: ReturnType<typeof sql>): Promise<number> {
  const result = await db.execute<CountRow>(query);
  return Number(result.rows[0]?.n ?? 0);
}

interface RejectionShape {
  readonly status: number;
  readonly code: unknown;
  readonly bodyText: string;
  readonly contentType: string | null;
  readonly sessionCookie: boolean;
}

async function shapeOf(response: Response): Promise<RejectionShape> {
  const bodyText = await response.text();
  let code: unknown;
  try {
    code = (JSON.parse(bodyText) as { code?: unknown }).code;
  } catch {
    code = undefined;
  }
  return {
    status: response.status,
    code,
    bodyText,
    contentType: response.headers.get('content-type'),
    sessionCookie: response.headers.getSetCookie().some((c) => c.includes('session_token')),
  };
}

describe('Visma Connect callback rejection (task 19.4, design D24)', () => {
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

  /** Signs in as a fresh, never-linked `sub`; returns the rejection and the identity used. */
  async function unlinkedAttempt(): Promise<{
    response: Response;
    sub: string;
    email: string;
  }> {
    const sub = `unlinked-${randomUUID()}`;
    const email = `sso-unlinked-${randomUUID()}@example.test`;
    stub.setSubject({ sub, email, name: 'Unlinked Person', sid: `sid-${randomUUID()}` });
    const { cookie, params } = await initiateSignIn(auth, stub);
    return { response: await completeCallback(auth, cookie, params), sub, email };
  }

  it('Sign-in with an unlinked Visma Connect account is rejected generically: AUTH_SSO_REJECTED and no user account is created', async () => {
    const harness = registeredHarness();
    await harness.reset();

    const { response, sub, email } = await unlinkedAttempt();
    const shape = await shapeOf(response);

    expect(shape.status, 'AUTH_SSO_REJECTED is a 401').toBe(401);
    expect(shape.code).toBe('AUTH_SSO_REJECTED');
    expect(shape.sessionCookie, 'no session is established').toBe(false);

    // ... and no user account is created (by email or by sub).
    expect(
      await countRows(db, sql`select count(*)::text as n from auth."user" where email = ${email}`),
      'no auth."user" row was created for the unlinked identity',
    ).toBe(0);
    expect(
      await countRows(
        db,
        sql`select count(*)::text as n from auth.account where account_id = ${sub}`,
      ),
      'no auth.account row was created for the unlinked sub',
    ).toBe(0);

    // The internal cause is recorded only on the log event, never in the response.
    await harness.forceFlush();
    const events = [...harness.logExporter.getFinishedLogRecords()].filter(
      (record) => record.eventName === 'auth.security.sso_sign_in_failed',
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.attributes['tayzu.auth.failure_reason']).toBe('sso_unlinked');
    expect(JSON.stringify(events[0]?.attributes), 'no email in telemetry').not.toContain(email);
    expect(shape.bodyText).not.toContain('sso_unlinked');
  }, 60_000);

  it('A mismatched state value is rejected the same way as an unlinked account: byte-identical status, error code and body', async () => {
    const harness = registeredHarness();

    // Reference: the unlinked-account rejection.
    const unlinked = await shapeOf((await unlinkedAttempt()).response);

    // A callback whose `state` does not match the value the sign-in was
    // initiated with.
    await harness.reset();
    const email = `sso-mismatch-${randomUUID()}@example.test`;
    stub.setSubject({ sub: `mismatch-${randomUUID()}`, email, name: 'Mismatch Person' });
    const { cookie, params } = await initiateSignIn(auth, stub);
    const mismatched = await shapeOf(
      await completeCallback(auth, cookie, { ...params, state: `forged-${randomUUID()}` }),
    );

    expect(mismatched.status).toBe(401);
    expect(mismatched.code).toBe('AUTH_SSO_REJECTED');
    expect(mismatched.status).toBe(unlinked.status);
    expect(mismatched.code).toBe(unlinked.code);
    expect(mismatched.contentType).toBe(unlinked.contentType);
    expect(mismatched.bodyText, 'identical body text').toBe(unlinked.bodyText);
    expect(mismatched.sessionCookie).toBe(false);

    // The distinguishing cause lives only on the log event.
    await harness.forceFlush();
    const events = [...harness.logExporter.getFinishedLogRecords()].filter(
      (record) => record.eventName === 'auth.security.sso_sign_in_failed',
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.attributes['tayzu.auth.failure_reason']).toBe('sso_state_mismatch');
    expect(mismatched.bodyText).not.toContain('sso_state_mismatch');
    expect(
      await countRows(db, sql`select count(*)::text as n from auth."user" where email = ${email}`),
    ).toBe(0);
  }, 60_000);
});
