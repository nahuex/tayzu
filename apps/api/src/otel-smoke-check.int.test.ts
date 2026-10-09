/**
 * `otel-smoke-check`, 002 extension (task 13.2, openspec/changes/002-auth-and-rbac;
 * design.md "Observability contract"; Resolved decisions Q16-Q21 and Q26-Q29).
 *
 * "Extend `otel-smoke-check` to run every new auth/authz operation once on
 * success and once per new error class, asserting every declared span, metric,
 * and log event appears with its required attributes, and that no undeclared
 * attribute key appears on any `tayzu.auth.*`/`tayzu.authz.*` metric."
 *
 * The declared names come from `packages/authz/src/telemetry/contract.ts`
 * (task 13.1, the executable mirror of the design's tables); every assertion in
 * the second `describe` is derived from it, so the design and this check stay
 * in one place. The first `describe` only *drives* the operations (through
 * `createApp`'s Fastify instance with `app.inject`, and in-process where the
 * operation has no HTTP route yet); its own assertions are limited to "the
 * operation behaved as its class says" so a failure there is never a telemetry
 * finding.
 *
 * Operations driven, success and error class each:
 *
 * - catalog operations behind Cerbos: allow (`POST /v1/blueprints`, admin),
 *   `authz.plan` (`GET .../entities`), deny (`POST /v1/blueprints`, member).
 * - sessions: sign-in success, sign-in failure (`bad_credentials`), sign-out,
 *   password change (session revocation), pre-authentication rate limit.
 * - MFA: challenge issued, verified, failed.
 * - step-up guard: local fresh, local not fresh, Visma Connect fresh, Visma
 *   Connect insufficient.
 * - machine credentials: token exchange (`integration`, `agent`), wrong secret,
 *   revoked credential, revocation check allowed / rejected / lookup failed.
 * - Visma Connect SSO: initiated, succeeded, rejected (unlinked).
 * - account linking: admin link, admin unlink.
 * - back-channel logout: `revoked`, `replay`, `invalid`, `no_match`.
 *
 * Tests never call the real Visma Connect (the local OIDC stub, task 19.1,
 * serves discovery and JWKS and mints tokens, `logout_token`s with
 * `typ: logout+jwt` included). Cerbos is expected on `localhost:3593`. Every
 * Better Auth request carries a fresh random `x-forwarded-for`, so the rate
 * limiter never interferes except in the one test that provokes it.
 *
 * ## Production symbols expected (the red phase)
 *
 * All modules exist; the expected failures are assertion failures on signals
 * that are declared but not yet emitted, at the time of writing:
 *
 * - counter `tayzu.auth.mfa.events` (`challenge_issued` | `verified` | `failed`),
 *   and the `mfa_failed` value of `auth.security.login_failed`.
 * - `tayzu.auth.session.events` value `logout` (sign-out).
 * - log event `auth.security.backchannel_logout_received` (INFO, with the
 *   closed `tayzu.auth.backchannel_logout.outcome` attribute), emitted next to
 *   the existing span and counter.
 * - `POST /v1/auth/visma-connect/backchannel-logout` must accept a fully
 *   spec-valid token (`typ: logout+jwt`): the `revoked` outcome depends on it.
 *
 * `pnpm otel-smoke-check` (root, Turborepo) only runs packages that define the
 * script: `apps/api/package.json` needs
 * `"otel-smoke-check": "vitest run src/otel-smoke-check.int.test.ts"`
 * (a non-test change, for the implementer).
 *
 * ## Import order (design D1)
 *
 * `./__fixtures__/link-telemetry.js` registers the telemetry harness while the
 * module graph loads. It must stay the first same-package import: every
 * instrument in `@tayzu/auth` and `@tayzu/catalog` is created at import time
 * and the OTel metrics API has no proxy meter provider.
 */
import { createHash, randomInt, randomUUID } from 'node:crypto';

import { registration, type TelemetryTestHarness } from './__fixtures__/link-telemetry.js';

import { createRouterClient } from '@orpc/server';
import {
  authSchema,
  createAuth,
  createContextResolver,
  createStepUpGuard,
  type AuthInstance,
} from '@tayzu/auth';
import { createCerbosClient } from '@tayzu/authz';
import { runMigrations } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  bootstrapTestTenant,
  createAdminUser,
  signInAdminUser,
  type BootstrappedTenant,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { startOidcStub, type OidcStub } from '../../../packages/auth/src/__fixtures__/oidc-stub.js';
import {
  createMachineCredential,
  revokeMachineCredential,
} from '../../../packages/auth/src/machine-credentials.js';
import { exchangeMachineToken } from '../../../packages/auth/src/token-exchange.js';
import { LOG_EVENTS, METRICS, SPANS } from '../../../packages/authz/src/telemetry/contract.js';
import { csrfHeaders } from './__fixtures__/csrf.js';
import { enrolledAdminSession } from './__fixtures__/fresh-mfa.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createAuthRepository } from './identity/auth-repository.js';
import { createIdentityRouter } from './identity-router.js';
import { createApp, type App } from './server.js';
import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';

// Same secret as `@tayzu/auth`'s machine-credential int tests: Better Auth's `jwks` row is
// shared in the test database and encrypted with whichever secret created it first, so
// the token-exchange drive below needs the secret those tests use.
const TEST_PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a different correct horse battery staple';
const AUTH_BASE_URL = 'http://localhost:3000/api/auth';
const AUTH_ORIGIN = 'http://localhost:3000';
const PROVIDER_ID = 'visma-connect';
const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
const BACKCHANNEL_ROUTE = '/v1/auth/visma-connect/backchannel-logout';
const HIGH_RISK_ROUTE = { riskLevel: 'high' } as const;
const BLUEPRINT_DELETE_OPERATION = 'blueprints.delete';

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

function registeredHarness(): TelemetryTestHarness {
  if ('error' in registration) {
    throw new Error(
      `the telemetry test harness failed to register while the module graph loaded: ${String(registration.error)}`,
      { cause: registration.error },
    );
  }
  return registration.harness;
}

type WebHandler = (request: Request) => Promise<Response>;

function handlerOf(auth: AuthInstance): WebHandler {
  return (auth as unknown as { handler: WebHandler }).handler;
}

function cookieFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((raw) => raw.split(';')[0])
    .join('; ');
}

function postJson(
  handler: WebHandler,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return handler(
    new Request(`${AUTH_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': randomIp(),
        origin: AUTH_ORIGIN,
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
}

interface TotpApi {
  enableTwoFactor(args: {
    body: { password: string; method: 'totp' };
    headers: Headers;
  }): Promise<{ totpURI: string }>;
  generateTOTP(args: { body: { secret: string } }): Promise<{ code: string }>;
  verifyTOTP(args: { body: { code: string }; headers: Headers }): Promise<unknown>;
}

interface AccountApi {
  changePassword(args: {
    body: { currentPassword: string; newPassword: string };
    headers: Headers;
  }): Promise<unknown>;
  addMember(args: {
    body: { userId: string; organizationId: string; role: string };
  }): Promise<unknown>;
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function rawSecretFromTotpUri(totpURI: string): string {
  const encoded = new URL(totpURI).searchParams.get('secret');
  if (encoded === null) {
    throw new Error('expected a secret query parameter on the TOTP URI');
  }
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of encoded) {
    if (char === '=') break;
    const value = BASE32_ALPHABET.indexOf(char.toUpperCase());
    if (value === -1) throw new Error('invalid base32 character in TOTP secret');
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

/** Every SUM data point of every metric export collected so far, by metric name. */
function dataPointAttributes(
  harness: TelemetryTestHarness,
  name: string,
): Readonly<Record<string, unknown>>[] {
  const collected: Readonly<Record<string, unknown>>[] = [];
  for (const resourceMetrics of harness.metricExporter.getMetrics()) {
    for (const scopeMetrics of resourceMetrics.scopeMetrics) {
      for (const metric of scopeMetrics.metrics) {
        if (metric.descriptor.name === name) {
          for (const point of metric.dataPoints) {
            collected.push(point.attributes);
          }
        }
      }
    }
  }
  return collected;
}

function logRecords(harness: TelemetryTestHarness, eventName: string) {
  return [...harness.logExporter.getFinishedLogRecords()].filter(
    (record) => record.eventName === eventName,
  );
}

function spansNamed(harness: TelemetryTestHarness, name: string) {
  return harness.spanExporter.getFinishedSpans().filter((span) => span.name === name);
}

/** Values of `key` across a metric's data points. */
function metricValues(harness: TelemetryTestHarness, name: string, key: string): Set<unknown> {
  return new Set(dataPointAttributes(harness, name).map((attributes) => attributes[key]));
}

/** Values of `key` across a log event's records. */
function logValues(harness: TelemetryTestHarness, eventName: string, key: string): Set<unknown> {
  return new Set(logRecords(harness, eventName).map((record) => record.attributes[key]));
}

describe('otel-smoke-check, 002: every auth/authz operation is driven (task 13.2)', () => {
  let app: App;
  let stub: OidcStub;
  let appPool: Pool;
  let authPool: Pool;
  let handler: WebHandler;
  let totp: TotpApi;
  let account: AccountApi;
  let admin: BootstrappedTenant;
  let identity: ReturnType<
    typeof createRouterClient<ReturnType<typeof createIdentityRouter>, Record<string, unknown>>
  >;

  beforeAll(async () => {
    registeredHarness();
    const pools = await harnessPools();
    appPool = pools.appPool;
    authPool = pools.authPool;
    await runMigrations(authPool);
    stub = await startOidcStub();
    app = await createApp({
      appPool,
      authPool,
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: ['https://app.tayzu.test'],
      sso: {
        discoveryUrl: stub.discoveryUrl,
        clientId: stub.clientId,
        clientSecret: stub.clientSecret,
      },
    });
    handler = handlerOf(app.auth);
    totp = app.auth.api as TotpApi;
    account = app.auth.api as AccountApi;
    identity = createRouterClient(
      createIdentityRouter({
        authRepository: createAuthRepository(authPool),
        auth: app.auth,
        authz: createCerbosClient({ address: 'localhost:3593', tls: false }),
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );
    // Q43: an unenrolled admin/owner is limited to MFA enrollment on /v1, so the acting admin is enrolled.
    admin = await enrolledAdminSession(app, await newTenant('Smoke Admin'), {
      password: TEST_PASSWORD,
      origin: 'https://app.tayzu.test',
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await stub.close();
  });

  async function newTenant(name: string): Promise<BootstrappedTenant> {
    const suffix = randomUUID();
    return bootstrapTestTenant(app.auth, {
      name,
      email: `smoke-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Smoke Org ${suffix}`,
      organizationSlug: `smoke-org-${suffix}`,
      ip: randomIp(),
    });
  }

  function catalogRequest(
    cookieOrBearer: { cookie: string } | { bearer: string },
    method: 'GET' | 'POST',
    url: string,
    body?: unknown,
  ) {
    return app.app.inject({
      method,
      url,
      headers: {
        ...('cookie' in cookieOrBearer
          ? { cookie: cookieOrBearer.cookie }
          : { authorization: `Bearer ${cookieOrBearer.bearer}` }),
        'content-type': 'application/json',
        origin: 'https://app.tayzu.test',
        ...csrfHeaders(method),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  }

  /** A TOTP-enrolled user and a completed challenge: the returned cookie is a fresh-MFA session. */
  async function enrolledUser(): Promise<{
    tenant: BootstrappedTenant;
    email: string;
    secret: string;
  }> {
    const tenant = await newTenant('Smoke Mfa');
    const headers = new Headers({ cookie: tenant.cookie });
    const enabled = await totp.enableTwoFactor({
      body: { password: TEST_PASSWORD, method: 'totp' },
      headers,
    });
    const secret = rawSecretFromTotpUri(enabled.totpURI);
    await totp.verifyTOTP({
      body: { code: (await totp.generateTOTP({ body: { secret } })).code },
      headers,
    });
    return { tenant, email: tenant.email, secret };
  }

  async function challenge(email: string): Promise<string> {
    const response = await postJson(handler, '/sign-in/email', { email, password: TEST_PASSWORD });
    expect(response.status, 'the sign-in is challenged, not rejected').toBe(200);
    return cookieFrom(response);
  }

  it('authz: an admin write is allowed, an entity list plans, a member write is denied (AUTH_FORBIDDEN)', async () => {
    const created = await catalogRequest({ cookie: admin.cookie }, 'POST', '/v1/blueprints', {
      identifier: 'team',
      title: { en: 'Team' },
      schema: { properties: {}, required: [] },
    });
    expect(created.statusCode, created.body).toBeLessThan(300);

    const listed = await catalogRequest(
      { cookie: admin.cookie },
      'GET',
      '/v1/blueprints/team/entities',
    );
    expect(listed.statusCode, listed.body).toBe(200);

    const memberUser = await createAdminUser(app.auth, {
      name: 'Smoke Member',
      email: `smoke-member-${randomUUID()}@example.test`,
      password: TEST_PASSWORD,
    });
    await account.addMember({
      body: { userId: memberUser.userId, organizationId: admin.organizationId, role: 'member' },
    });
    const member = await signInAdminUser(app.auth, {
      email: memberUser.email,
      password: TEST_PASSWORD,
      ip: randomIp(),
    });
    const denied = await catalogRequest({ cookie: member.cookie }, 'POST', '/v1/blueprints', {
      identifier: 'denied',
      title: { en: 'Denied' },
      schema: { properties: {}, required: [] },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json<{ code: string }>().code).toBe('AUTH_FORBIDDEN');
  }, 60_000);

  it('sessions: a wrong password fails, sign-out, and a password change revokes other sessions', async () => {
    const failed = await postJson(handler, '/sign-in/email', {
      email: admin.email,
      password: 'definitely the wrong password, not correct',
    });
    expect(failed.status).toBe(401);

    const tenant = await newTenant('Smoke Sessions');
    const second = await signInAdminUser(app.auth, {
      email: tenant.email,
      password: TEST_PASSWORD,
      ip: randomIp(),
    });
    await account.changePassword({
      body: { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD },
      headers: new Headers({ cookie: tenant.cookie }),
    });

    const other = await newTenant('Smoke Signout');
    const signedOut = await postJson(handler, '/sign-out', {}, { cookie: other.cookie });
    expect(signedOut.status).toBe(200);
    expect(second.cookie).not.toBe('');
  }, 60_000);

  it('rate limit: repeated failed sign-ins from one IP and email are blocked with 429', async () => {
    const limitedAuth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      rateLimit: { signIn: { window: 60, max: 3 } },
    });
    const limitedHandler = handlerOf(limitedAuth);
    const ip = randomIp();
    const email = `rate-${randomUUID()}@example.test`;
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await postJson(
        limitedHandler,
        '/sign-in/email',
        { email, password: 'definitely the wrong password, not correct' },
        { 'x-forwarded-for': ip },
      );
      statuses.push(response.status);
    }
    expect(statuses).toEqual([401, 401, 401, 429]);
  }, 60_000);

  it('mfa: a challenge is issued, a correct code verifies, a wrong code fails', async () => {
    const { email, secret } = await enrolledUser();

    const verifiedCookie = await challenge(email);
    const code = (await totp.generateTOTP({ body: { secret } })).code;
    const verified = await postJson(
      handler,
      '/two-factor/verify-totp',
      { code },
      {
        cookie: verifiedCookie,
      },
    );
    expect(verified.status).toBe(200);

    const failedCookie = await challenge(email);
    const wrong = await postJson(
      handler,
      '/two-factor/verify-totp',
      { code: '000000' },
      {
        cookie: failedCookie,
      },
    );
    expect(wrong.status).toBeGreaterThanOrEqual(400);
  }, 60_000);

  it('step-up: a local session is fresh after MFA and not fresh without it', async () => {
    const guard = createStepUpGuard({ auth: app.auth });
    const { tenant, email, secret } = await enrolledUser();

    const freshCookie = await (async () => {
      const cookie = await challenge(email);
      const code = (await totp.generateTOTP({ body: { secret } })).code;
      const verified = await postJson(handler, '/two-factor/verify-totp', { code }, { cookie });
      expect(verified.status).toBe(200);
      return cookieFrom(verified);
    })();
    await guard({
      headers: new Headers({ cookie: freshCookie }),
      tenantId: tenant.organizationId,
      actor: { type: 'user', id: tenant.userId },
      route: HIGH_RISK_ROUTE,
      operation: BLUEPRINT_DELETE_OPERATION,
    });

    const plain = await newTenant('Smoke Not Fresh');
    await expect(
      guard({
        headers: new Headers({ cookie: plain.cookie }),
        tenantId: plain.organizationId,
        actor: { type: 'user', id: plain.userId },
        route: HIGH_RISK_ROUTE,
        operation: BLUEPRINT_DELETE_OPERATION,
      }),
    ).rejects.toMatchObject({ code: 'AUTH_STEP_UP_REQUIRED' });
  }, 60_000);

  it('step-up success (task 27.5, design Q77): a TOTP verification on an existing session is driven', async () => {
    const { tenant, email, secret } = await enrolledUser();
    const sessionCookie = await (async (): Promise<string> => {
      const cookie = await challenge(email);
      const code: string = (await totp.generateTOTP({ body: { secret } })).code;
      const verified = await postJson(handler, '/two-factor/verify-totp', { code }, { cookie });
      expect(verified.status).toBe(200);
      return cookieFrom(verified);
    })();
    const code: string = (await totp.generateTOTP({ body: { secret } })).code;
    const stepUp = await postJson(
      handler,
      '/two-factor/verify-totp',
      { code },
      { cookie: sessionCookie },
    );
    expect(stepUp.status, 'the step-up verification succeeds').toBe(200);
    expect(tenant.userId).toBeTruthy();
  }, 60_000);

  it('step-up: a Visma Connect session is satisfied by an MFA re-authorization and rejected by an insufficient one', async () => {
    const guard = createStepUpGuard({
      auth: app.auth,
      sso: {
        discoveryUrl: stub.discoveryUrl,
        clientId: stub.clientId,
        clientSecret: stub.clientSecret,
      },
    });
    const now = Math.floor(Date.now() / 1000);
    const run = async (claims: Record<string, unknown>): Promise<void> => {
      const tenant = await newTenant('Smoke Sso Step-Up');
      const sid = `sid-${randomUUID()}`;
      await authPool.query('update auth.session set sso_sid = $1 where user_id = $2', [
        sid,
        tenant.userId,
      ]);
      await guard({
        headers: new Headers({ cookie: tenant.cookie }),
        tenantId: tenant.organizationId,
        actor: { type: 'user', id: tenant.userId },
        route: HIGH_RISK_ROUTE,
        operation: BLUEPRINT_DELETE_OPERATION,
        reauthorization: {
          idToken: stub.signJwt({
            iss: stub.issuer,
            aud: stub.clientId,
            sub: `sub-${randomUUID()}`,
            sid,
            iat: now,
            exp: now + 300,
            ...claims,
          }),
        },
      });
    };
    await run({ auth_time: now - 10, acr: 3, amr: ['pwd', 'otp'] });
    await expect(run({ auth_time: now - 10, acr: 2, amr: ['pwd'] })).rejects.toMatchObject({
      code: 'AUTH_STEP_UP_REQUIRED',
    });
  }, 60_000);

  it('machine credentials: exchange succeeds for both kinds, a wrong secret and a revoked credential fail, revocation checks allow, reject and fail closed', async () => {
    const headers = new Headers({ cookie: admin.cookie });
    const create = (actorKind: 'integration' | 'agent') =>
      createMachineCredential(app.auth, {
        headers,
        organizationId: admin.organizationId,
        name: `smoke ${actorKind}`,
        actorKind,
      });

    const integration = await create('integration');
    const agent = await create('agent');
    const integrationToken = await exchangeMachineToken(app.auth, {
      clientId: integration.id,
      clientSecret: integration.secret,
    });
    await exchangeMachineToken(app.auth, { clientId: agent.id, clientSecret: agent.secret });

    await expect(
      exchangeMachineToken(app.auth, { clientId: integration.id, clientSecret: 'wrong-secret' }),
    ).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });

    // Revocation check `allowed`: an active credential's token resolves.
    const allowed = await catalogRequest(
      { bearer: integrationToken.accessToken },
      'GET',
      '/v1/blueprints',
    );
    expect(allowed.statusCode, allowed.body).toBe(200);

    // A revoked credential cannot exchange, and its already-issued token is
    // rejected on the next request (a token never used before: no cached allow).
    const revoked = await create('integration');
    const revokedToken = await exchangeMachineToken(app.auth, {
      clientId: revoked.id,
      clientSecret: revoked.secret,
    });
    await revokeMachineCredential(app.auth, {
      headers,
      id: revoked.id,
      pool: appPool,
      tenantId: admin.organizationId,
    });
    await expect(
      exchangeMachineToken(app.auth, { clientId: revoked.id, clientSecret: revoked.secret }),
    ).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
    const rejected = await catalogRequest(
      { bearer: revokedToken.accessToken },
      'GET',
      '/v1/blueprints',
    );
    expect(rejected.statusCode).toBeGreaterThanOrEqual(400);

    // Lookup failure fails closed: a revocation pool that is already ended.
    const brokenPool = new Pool({ connectionString: process.env['DATABASE_URL'] });
    brokenPool.on('error', () => {
      // Expected only while the pool is being ended.
    });
    await brokenPool.end();
    const failingResolver = createContextResolver({ auth: app.auth, revocationPool: brokenPool });
    const fresh = await create('integration');
    const freshToken = await exchangeMachineToken(app.auth, {
      clientId: fresh.id,
      clientSecret: fresh.secret,
    });
    await expect(
      failingResolver(new Headers({ authorization: `Bearer ${freshToken.accessToken}` })),
    ).rejects.toMatchObject({ code: 'CATALOG_CONTEXT_REQUIRED' });
  }, 60_000);

  it('visma connect sso: sign-in is initiated, a linked account succeeds, an unlinked one is rejected', async () => {
    const authorize = async (): Promise<{ cookie: string; params: URLSearchParams }> => {
      const initiated = await postJson(handler, '/sign-in/social', {
        provider: PROVIDER_ID,
        callbackURL: '/',
      });
      expect(initiated.status).toBe(200);
      const { url } = (await initiated.json()) as { url: string };
      const page = await (await fetch(url, { redirect: 'manual' })).text();
      const inputs = Object.fromEntries(
        [...page.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [
          m[1] ?? '',
          m[2] ?? '',
        ]),
      );
      const { code, state, iss } = inputs;
      if (code === undefined || state === undefined) {
        throw new Error('the OIDC stub did not return code and state');
      }
      return {
        cookie: cookieFrom(initiated),
        params: new URLSearchParams({ code, state, ...(iss === undefined ? {} : { iss }) }),
      };
    };
    const callback = async (cookie: string, params: URLSearchParams): Promise<void> => {
      const headers = (): Record<string, string> => ({ 'x-forwarded-for': randomIp(), cookie });
      const posted = await handler(
        new Request(`${AUTH_BASE_URL}/callback/${PROVIDER_ID}`, {
          method: 'POST',
          headers: {
            ...headers(),
            'content-type': 'application/x-www-form-urlencoded',
            origin: AUTH_ORIGIN,
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
        await handler(new Request(new URL(location, AUTH_BASE_URL), { headers: headers() }));
      }
    };

    // Linked: succeeds.
    const linked = await newTenant('Smoke Sso Linked');
    const sub = `smoke-sub-${randomUUID()}`;
    await authPool.query(
      `insert into auth.account (id, account_id, provider_id, user_id, created_at, updated_at)
       values ($1, $2, $3, $4, now(), now())`,
      [randomUUID(), sub, PROVIDER_ID, linked.userId],
    );
    stub.setSubject({
      sub,
      email: `sso-${randomUUID()}@example.test`,
      name: 'Smoke Sso',
      sid: `sid-${randomUUID()}`,
    });
    const success = await authorize();
    await callback(success.cookie, success.params);

    // Unlinked: rejected.
    stub.setSubject({
      sub: `unlinked-${randomUUID()}`,
      email: `sso-${randomUUID()}@example.test`,
      name: 'Smoke Sso Unlinked',
      sid: `sid-${randomUUID()}`,
    });
    const rejected = await authorize();
    await callback(rejected.cookie, rejected.params);
  }, 60_000);

  it('account linking: an admin links and unlinks a Visma Connect account', async () => {
    const target = await createAdminUser(app.auth, {
      name: 'Smoke Link Target',
      email: `smoke-link-${randomUUID()}@example.test`,
      password: TEST_PASSWORD,
    });
    await account.addMember({
      body: { userId: target.userId, organizationId: admin.organizationId, role: 'member' },
    });
    const context = {
      tenantId: admin.organizationId,
      actor: { type: 'user', id: admin.userId },
      principal: { roles: ['admin'] },
    };
    await identity.identity.users.linkSsoAccount(
      { userId: target.userId, subject: `smoke-link-sub-${randomUUID()}` },
      { context },
    );
    await identity.identity.users.unlinkSsoAccount({ userId: target.userId }, { context });
  }, 60_000);

  it('back-channel logout: revoked, replay, invalid and no_match all answer the same 200', async () => {
    const sid = `sid-${randomUUID()}`;
    const target = await newTenant('Smoke Backchannel');
    await authPool.query('update auth.session set sso_sid = $1 where user_id = $2', [
      sid,
      target.userId,
    ]);
    const claims = (forSid: string): Record<string, unknown> => {
      const now = Math.floor(Date.now() / 1000);
      return {
        iss: stub.issuer,
        aud: stub.clientId,
        sub: `bcl-sub-${randomUUID()}`,
        sid: forSid,
        iat: now,
        exp: now + 300,
        jti: randomUUID(),
        events: { [LOGOUT_EVENT]: {} },
      };
    };
    const post = (token: string) =>
      app.app.inject({
        method: 'POST',
        url: BACKCHANNEL_ROUTE,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-forwarded-for': randomIp(),
        },
        payload: new URLSearchParams({ logout_token: token }).toString(),
      });
    const mint = (forSid: string): string => stub.signJwt(claims(forSid), { typ: 'logout+jwt' });

    const revokedToken = mint(sid);
    const responses = [
      await post(revokedToken), // revoked
      await post(revokedToken), // replay
      await post(mint(`sid-missing-${randomUUID()}`)), // no_match
      await post('not.a.jwt'), // invalid
    ];
    for (const response of responses) {
      expect(response.statusCode).toBe(200);
    }
    const remaining = await authPool.query<{ n: string }>(
      'select count(*)::text as n from auth.session where sso_sid = $1',
      [sid],
    );
    expect(remaining.rows[0]?.n, 'the valid token revoked the matching session').toBe('0');
  }, 60_000);

  it('internal error (task 27.4, design Q76): an unmapped database failure on the admin-MFA gate answers 500', async () => {
    const api = app.auth.api as { getSession(args: unknown): Promise<unknown> };
    const original = api.getSession.bind(api);
    const spy = vi.spyOn(api, 'getSession');
    const list = () => catalogRequest({ cookie: admin.cookie }, 'GET', '/v1/blueprints');
    try {
      spy.mockImplementation((args) => original(args));
      expect((await list()).statusCode, 'precondition: the gated request succeeds').toBe(200);
      const callsPerRequest: number = spy.mock.calls.length;
      let call = 0;
      spy.mockImplementation((args) => {
        call += 1;
        return call === callsPerRequest
          ? Promise.reject(Object.assign(new Error('driver failure'), { code: '57P01' }))
          : original(args);
      });
      expect((await list()).statusCode).toBe(500);
    } finally {
      spy.mockRestore();
    }
  }, 60_000);
});

/**
 * `signal:attribute` pairs whose attribute may be absent on the wrong-secret failure of a
 * token exchange (the credential kind is unknowable there) but must be present on at
 * least one signal of that name (the success and revoked-credential paths know it).
 */
const UNKNOWN_KIND_ALLOWED_ON_FAILURE: ReadonlySet<string> = new Set([
  'auth.token.exchange:tayzu.auth.credential.kind',
  'tayzu.auth.token.exchanges:tayzu.auth.credential.kind',
  'auth.security.token_exchange_failed:tayzu.auth.credential.kind',
]);

/** OpenTelemetry `SeverityNumber` values (INFO = 9, WARN = 13, ERROR = 17), without importing the API package. */
const SEVERITY_NUMBER: Readonly<Record<'INFO' | 'WARN' | 'ERROR', number>> = {
  INFO: 9,
  WARN: 13,
  ERROR: 17,
};

/**
 * Log-event attribute keys that the design documents as conditional: they are
 * required on the records that have the condition, never on every record.
 */
const CONDITIONAL_LOG_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  'auth.security.login_succeeded': new Set(['tayzu.tenant.id']),
};

describe('otel-smoke-check, 002: every declared signal appears with its declared attributes (task 13.2)', () => {
  let harness: TelemetryTestHarness;

  beforeAll(async () => {
    harness = registeredHarness();
    await harness.forceFlush();
  });

  describe('spans', () => {
    it.each(SPANS.map((span) => [span.name, span] as const))(
      '%s is emitted with its required attributes, and its conditional ones on at least one span',
      (name, contract) => {
        const spans = spansNamed(harness, name);
        expect(spans.length, `no "${name}" span was captured`).toBeGreaterThan(0);
        for (const key of contract.requiredAttributes) {
          if (UNKNOWN_KIND_ALLOWED_ON_FAILURE.has(`${name}:${key}`)) {
            // A wrong secret never finds a credential, so its kind is unknowable and
            // absent by an accepted decision (`token-exchange.int.test.ts`, "Why the
            // two rejection scenarios assert `tayzu.auth.credential.kind` differently").
            expect(
              spans.some((span) => key in span.attributes),
              `no "${name}" span carried ${key}`,
            ).toBe(true);
            continue;
          }
          for (const span of spans) {
            expect(span.attributes, `${name} is missing ${key}`).toHaveProperty([key]);
          }
        }
        for (const key of contract.conditionalAttributes) {
          expect(
            spans.some((span) => key in span.attributes),
            `no "${name}" span carried the conditional attribute ${key}`,
          ).toBe(true);
        }
      },
    );
  });

  describe('metrics', () => {
    it.each(METRICS.map((metric) => [metric.name, metric] as const))(
      '%s is recorded, and every data point carries exactly its declared attribute keys (cardinality guard)',
      (name, contract) => {
        const points = dataPointAttributes(harness, name);
        expect(points.length, `no "${name}" data point was captured`).toBeGreaterThan(0);
        const declared = [...contract.attributes].sort();
        for (const attributes of points) {
          const keys = Object.keys(attributes).sort();
          if (
            UNKNOWN_KIND_ALLOWED_ON_FAILURE.has(`${name}:tayzu.auth.credential.kind`) &&
            attributes['tayzu.auth.exchange.outcome'] === 'invalid_credentials' &&
            !keys.includes('tayzu.auth.credential.kind')
          ) {
            expect(keys, `${name} attribute keys (unknown credential kind)`).toEqual([
              'tayzu.auth.exchange.outcome',
            ]);
            continue;
          }
          expect(keys, `${name} attribute keys`).toEqual(declared);
        }
      },
    );

    it('no tayzu.auth.* / tayzu.authz.* metric carries an attribute key outside its declared set', () => {
      const declaredByMetric = new Map(METRICS.map((metric) => [metric.name, metric.attributes]));
      const offenders: string[] = [];
      for (const resourceMetrics of harness.metricExporter.getMetrics()) {
        for (const scopeMetrics of resourceMetrics.scopeMetrics) {
          for (const metric of scopeMetrics.metrics) {
            const name = metric.descriptor.name;
            if (!name.startsWith('tayzu.auth.') && !name.startsWith('tayzu.authz.')) continue;
            const declared = declaredByMetric.get(name);
            if (declared === undefined) {
              offenders.push(`${name}: not a declared metric`);
              continue;
            }
            for (const point of metric.dataPoints) {
              for (const key of Object.keys(point.attributes)) {
                if (!declared.includes(key)) offenders.push(`${name}: ${key}`);
              }
            }
          }
        }
      }
      expect(offenders).toEqual([]);
    });

    it('token exchanges cover success and invalid_credentials, for both credential kinds', () => {
      expect(
        metricValues(harness, 'tayzu.auth.token.exchanges', 'tayzu.auth.exchange.outcome'),
      ).toEqual(new Set(['success', 'invalid_credentials']));
      const kinds = metricValues(
        harness,
        'tayzu.auth.token.exchanges',
        'tayzu.auth.credential.kind',
      );
      kinds.delete(undefined);
      expect(kinds).toEqual(new Set(['integration', 'agent']));
    });

    it('revocation checks cover allowed, rejected and lookup_failed', () => {
      expect(
        metricValues(harness, 'tayzu.auth.token.revocation_checks', 'tayzu.auth.revocation.result'),
      ).toEqual(new Set(['allowed', 'rejected', 'lookup_failed']));
    });

    it('MFA events cover challenge_issued, verified and failed', () => {
      expect(metricValues(harness, 'tayzu.auth.mfa.events', 'tayzu.auth.event')).toEqual(
        new Set(['challenge_issued', 'verified', 'failed']),
      );
    });

    it('session events cover login_succeeded, login_failed, logout and session_revoked', () => {
      const events = metricValues(harness, 'tayzu.auth.session.events', 'tayzu.auth.event');
      for (const event of ['login_succeeded', 'login_failed', 'logout', 'session_revoked']) {
        expect(events, `session event ${event}`).toContain(event);
      }
    });

    it('SSO events cover sso_initiated, sso_succeeded and sso_rejected', () => {
      const events = metricValues(harness, 'tayzu.auth.sso.events', 'tayzu.auth.event');
      for (const event of ['sso_initiated', 'sso_succeeded', 'sso_rejected']) {
        expect(events, `sso event ${event}`).toContain(event);
      }
    });

    it('back-channel logout events cover revoked, replay, invalid and no_match', () => {
      expect(
        metricValues(
          harness,
          'tayzu.auth.backchannel_logout.events',
          'tayzu.auth.backchannel_logout.outcome',
        ),
      ).toEqual(new Set(['revoked', 'replay', 'invalid', 'no_match']));
    });

    it('authorization decisions cover allow and deny, and rate-limit events cover sign_in', () => {
      expect(metricValues(harness, 'tayzu.authz.decisions', 'tayzu.authz.decision')).toEqual(
        new Set(['allow', 'deny']),
      );
      expect(
        metricValues(harness, 'tayzu.auth.rate_limit.events', 'tayzu.auth.rate_limit.scope'),
      ).toContain('sign_in');
    });
  });

  describe('log events', () => {
    it.each(LOG_EVENTS.map((event) => [event.name, event] as const))(
      '%s is emitted at its declared severity with its declared attributes and no others',
      (name, contract) => {
        const records = logRecords(harness, name);
        expect(records.length, `no "${name}" log record was captured`).toBeGreaterThan(0);
        const conditional = CONDITIONAL_LOG_ATTRIBUTES[name] ?? new Set<string>();
        for (const key of contract.attributes) {
          if (UNKNOWN_KIND_ALLOWED_ON_FAILURE.has(`${name}:${key}`)) {
            expect(
              records.some((record) => key in record.attributes),
              `no "${name}" record carried ${key}`,
            ).toBe(true);
          }
        }
        for (const record of records) {
          expect(record.severityNumber, `${name} severity`).toBe(
            SEVERITY_NUMBER[contract.severity],
          );
          for (const key of contract.attributes) {
            if (conditional.has(key)) continue;
            if (UNKNOWN_KIND_ALLOWED_ON_FAILURE.has(`${name}:${key}`)) continue;
            expect(record.attributes, `${name} is missing ${key}`).toHaveProperty([key]);
          }
          for (const key of Object.keys(record.attributes)) {
            expect(contract.attributes, `${name} carries undeclared attribute ${key}`).toContain(
              key,
            );
          }
        }
      },
    );

    it('login_failed covers bad_credentials and mfa_failed', () => {
      expect(logValues(harness, 'auth.security.login_failed', 'tayzu.auth.failure_reason')).toEqual(
        new Set(['bad_credentials', 'mfa_failed']),
      );
    });

    it('backchannel_logout_received covers revoked, replay, invalid and no_match', () => {
      expect(
        logValues(
          harness,
          'auth.security.backchannel_logout_received',
          'tayzu.auth.backchannel_logout.outcome',
        ),
      ).toEqual(new Set(['revoked', 'replay', 'invalid', 'no_match']));
    });

    it('sso_sign_in_failed records the sso_unlinked reason, and only closed reasons (task 13.6)', () => {
      const reasons = logValues(
        harness,
        'auth.security.sso_sign_in_failed',
        'tayzu.auth.failure_reason',
      );
      expect(reasons).toContain('sso_unlinked');
      for (const reason of reasons) {
        expect(['sso_unlinked', 'sso_state_mismatch', 'sso_token_invalid']).toContain(reason);
      }
    });

    it('auth.session.step_up_check records tayzu.auth.step_up.fresh as both true and false (task 13.6)', () => {
      const fresh = new Set(
        spansNamed(harness, 'auth.session.step_up_check').map(
          (span) => span.attributes['tayzu.auth.step_up.fresh'],
        ),
      );
      expect(fresh).toContain(true);
      expect(fresh).toContain(false);
    });

    it('step_up_succeeded records the local method (task 27.5, design Q77)', () => {
      expect(logValues(harness, 'auth.security.step_up_succeeded', 'tayzu.auth.method')).toContain(
        'local',
      );
    });

    it('step_up_insufficient records the Visma Connect method, account_linked the admin actor, token_exchange_failed the integration kind', () => {
      expect(logValues(harness, 'auth.security.step_up_insufficient', 'tayzu.auth.method')).toEqual(
        new Set(['visma_connect']),
      );
      expect(logValues(harness, 'auth.security.account_linked', 'tayzu.auth.link.actor')).toContain(
        'admin',
      );
      expect(
        logValues(harness, 'auth.security.token_exchange_failed', 'tayzu.auth.credential.kind'),
      ).toContain('integration');
    });
  });
});

/**
 * Marker-leak extension (task 13.3, design "Observability contract" > "Forbidden
 * on any signal", and D20).
 *
 * "`otel-smoke-check` covers a forced sign-in failure, MFA failure, and
 * token-exchange failure, and asserts client secrets, access tokens, session
 * tokens, TOTP codes, and backup codes never appear in any exported span,
 * metric, or log attribute; extended (design D20) to assert a rate-limited
 * request's caller IP and submitted email never appear on
 * `auth.security.rate_limited` or `tayzu.auth.rate_limit.events`."
 *
 * Every marker is a unique random value (or a real credential minted for this
 * test), so a hit can only come from the code under test. Strings are compared
 * against attribute keys and values, span event attributes, span status
 * messages and log bodies, never against trace/span ids or timestamps (a
 * six-digit TOTP code would otherwise collide with them by chance). Codes of
 * six digits are matched exactly, every other marker by substring.
 *
 * ## Production symbols expected
 *
 * - Nothing new for the first three tests: they pass when the existing
 *   instrumentation is already clean, which is a valid outcome.
 * - `auth.security.rate_limited` / `tayzu.auth.rate_limit.events` with scope
 *   `token_exchange`, emitted when `POST /v1/auth/token` answers 429 (design D20:
 *   scope enum `sign_in | two_factor_verify | token_exchange`). Only the `sign_in`
 *   scope is emitted today (`pre-auth-rate-limit.ts`); the token-exchange
 *   limiter lives in `server.ts` and records nothing.
 */
interface CorpusEntry {
  readonly signal: string;
  readonly strings: readonly string[];
}

function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  return [];
}

function attributeStrings(attributes: Readonly<Record<string, unknown>>): string[] {
  return Object.entries(attributes).flatMap(([key, value]) => [key, ...stringsIn(value)]);
}

/** Everything the harness exported so far, one entry per span, metric data point and log record. */
function exportedCorpus(harness: TelemetryTestHarness): CorpusEntry[] {
  const entries: CorpusEntry[] = [];
  for (const span of harness.spanExporter.getFinishedSpans()) {
    entries.push({
      signal: `span ${span.name}`,
      strings: [
        span.name,
        span.status.message ?? '',
        ...attributeStrings(span.attributes),
        ...span.events.flatMap((event) => [
          event.name,
          ...attributeStrings(event.attributes ?? {}),
        ]),
      ],
    });
  }
  for (const resourceMetrics of harness.metricExporter.getMetrics()) {
    for (const scopeMetrics of resourceMetrics.scopeMetrics) {
      for (const metric of scopeMetrics.metrics) {
        for (const point of metric.dataPoints) {
          entries.push({
            signal: `metric ${metric.descriptor.name}`,
            strings: attributeStrings(point.attributes),
          });
        }
      }
    }
  }
  for (const record of harness.logExporter.getFinishedLogRecords()) {
    entries.push({
      signal: `log ${record.eventName ?? '(no event name)'}`,
      strings: [...stringsIn(record.body), ...attributeStrings(record.attributes)],
    });
  }
  return entries;
}

function leaks(entries: readonly CorpusEntry[], marker: string): string[] {
  const exact = /^\d{6}$/.test(marker);
  return entries
    .filter((entry) =>
      entry.strings.some((text) => (exact ? text === marker : text.includes(marker))),
    )
    .map((entry) => entry.signal);
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('otel-smoke-check, 002: forbidden values never reach a signal (task 13.3)', () => {
  let app: App;
  let authPool: Pool;
  let handler: WebHandler;
  let harness: TelemetryTestHarness;
  let totp: {
    enableTwoFactor(args: {
      body: { password: string; method: 'totp' };
      headers: Headers;
    }): Promise<{ totpURI: string; backupCodes: readonly string[] }>;
    generateTOTP(args: { body: { secret: string } }): Promise<{ code: string }>;
    verifyTOTP(args: { body: { code: string }; headers: Headers }): Promise<unknown>;
  };

  beforeAll(async () => {
    harness = registeredHarness();
    const pools = await harnessPools();
    authPool = pools.authPool;
    await runMigrations(authPool);
    app = await createApp({
      ...pools,
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: ['https://app.tayzu.test'],
      tokenExchangeRateLimit: { max: 2, timeWindowMs: 60_000 },
    });
    handler = handlerOf(app.auth);
    const api: unknown = app.auth.api;
    totp = api as typeof totp;
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  function newTenant(name: string) {
    const suffix = randomUUID();
    return bootstrapTestTenant(app.auth, {
      name,
      email: `leak-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Leak Org ${suffix}`,
      organizationSlug: `leak-org-${suffix}`,
      ip: randomIp(),
    });
  }

  async function expectNoLeak(markers: Readonly<Record<string, string>>): Promise<void> {
    await harness.forceFlush();
    const entries = exportedCorpus(harness);
    expect(entries.length, 'the corpus is not empty').toBeGreaterThan(0);
    for (const [label, marker] of Object.entries(markers)) {
      expect(marker.length, `${label} marker is non-trivial`).toBeGreaterThanOrEqual(6);
      expect(leaks(entries, marker), `${label} must never appear on any signal`).toEqual([]);
    }
  }

  it('a forced sign-in failure leaks no session token or submitted password', async () => {
    const tenant = await newTenant('Leak Sign-In');
    const wrongPassword = `wrong-password-marker-${randomUUID()}`;
    const failed = await postJson(handler, '/sign-in/email', {
      email: tenant.email,
      password: wrongPassword,
    });
    expect(failed.status, 'the sign-in is rejected').toBe(401);

    const signedIn = await postJson(handler, '/sign-in/email', {
      email: tenant.email,
      password: TEST_PASSWORD,
    });
    expect(signedIn.status).toBe(200);
    const sessionCookieValues = [tenant.cookie, cookieFrom(signedIn)]
      .flatMap((cookie) => cookie.split('; '))
      .map((pair) => decodeURIComponent(pair.slice(pair.indexOf('=') + 1)))
      .filter((value) => value.length >= 16);
    const markers: Record<string, string> = { 'submitted password': wrongPassword };
    sessionCookieValues.forEach((value, index) => {
      markers[`session cookie value #${String(index)}`] = value;
      markers[`session token #${String(index)}`] = value.split('.')[0] ?? value;
    });
    await expectNoLeak(markers);
  }, 60_000);

  it('a forced MFA failure leaks no TOTP code, backup code or session token', async () => {
    const tenant = await newTenant('Leak Mfa');
    const headers = new Headers({ cookie: tenant.cookie });
    const enabled = await totp.enableTwoFactor({
      body: { password: TEST_PASSWORD, method: 'totp' },
      headers,
    });
    const secret = rawSecretFromTotpUri(enabled.totpURI);
    const enrolmentCode = (await totp.generateTOTP({ body: { secret } })).code;
    await totp.verifyTOTP({ body: { code: enrolmentCode }, headers });

    const challenged = await postJson(handler, '/sign-in/email', {
      email: tenant.email,
      password: TEST_PASSWORD,
    });
    expect(challenged.status, 'the sign-in is challenged').toBe(200);
    const challengeCookie = cookieFrom(challenged);
    const validCode = (await totp.generateTOTP({ body: { secret } })).code;
    let wrongCode = validCode;
    while (wrongCode === validCode || wrongCode === enrolmentCode) {
      wrongCode = randomInt(0, 1_000_000).toString(10).padStart(6, '0');
    }
    const wrong = await postJson(
      handler,
      '/two-factor/verify-totp',
      { code: wrongCode },
      { cookie: challengeCookie },
    );
    expect(wrong.status, 'the wrong code is rejected').toBeGreaterThanOrEqual(400);
    const verified = await postJson(
      handler,
      '/two-factor/verify-totp',
      { code: validCode },
      { cookie: challengeCookie },
    );
    expect(verified.status).toBe(200);

    const markers: Record<string, string> = {
      'wrong TOTP code': wrongCode,
      'valid TOTP code': validCode,
      'enrolment TOTP code': enrolmentCode,
      'TOTP secret': secret,
    };
    enabled.backupCodes.forEach((code, index) => {
      markers[`backup code #${String(index)}`] = code;
    });
    [tenant.cookie, challengeCookie, cookieFrom(verified)]
      .flatMap((cookie) => cookie.split('; '))
      .forEach((pair, index) => {
        const value = decodeURIComponent(pair.slice(pair.indexOf('=') + 1));
        // Cleared or short cookies (for example an emptied challenge cookie) carry no secret.
        if (value.length < 16) return;
        markers[`session cookie value #${String(index)}`] = value;
        markers[`session token #${String(index)}`] = value.split('.')[0] ?? value;
      });
    await expectNoLeak(markers);
  }, 60_000);

  it('a forced token-exchange failure leaks no client secret or access token', async () => {
    const tenant = await newTenant('Leak Token Exchange');
    const headers = new Headers({ cookie: tenant.cookie });
    const credential = await createMachineCredential(app.auth, {
      headers,
      organizationId: tenant.organizationId,
      name: 'leak marker credential',
      actorKind: 'integration',
    });
    const issued = await exchangeMachineToken(app.auth, {
      clientId: credential.id,
      clientSecret: credential.secret,
    });
    const wrongSecret = `wrong-secret-marker-${randomUUID()}`;
    await expect(
      exchangeMachineToken(app.auth, { clientId: credential.id, clientSecret: wrongSecret }),
    ).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });

    // Also through the HTTP route, where the secret is a request body field.
    const viaHttp = await app.app.inject({
      method: 'POST',
      url: '/v1/auth/token',
      headers: {
        'content-type': 'application/json',
        origin: 'https://app.tayzu.test',
        'x-forwarded-for': randomIp(),
        ...csrfHeaders('POST'),
      },
      payload: JSON.stringify({ clientId: credential.id, clientSecret: wrongSecret }),
    });
    expect(viaHttp.statusCode, 'the wrong secret is rejected').toBeGreaterThanOrEqual(400);

    await expectNoLeak({
      'client secret': credential.secret,
      'submitted wrong client secret': wrongSecret,
      'access token': issued.accessToken,
      'access token signature': issued.accessToken.split('.')[2] ?? issued.accessToken,
    });
  }, 60_000);

  it("a rate-limited sign-in's caller IP and submitted email never appear on auth.security.rate_limited or tayzu.auth.rate_limit.events", async () => {
    const limitedAuth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      rateLimit: { signIn: { window: 60, max: 2 } },
    });
    const limitedHandler = handlerOf(limitedAuth);
    const ip = randomIp();
    const email = `Rate-Leak-${randomUUID()}@Example.test`;
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await postJson(
        limitedHandler,
        '/sign-in/email',
        { email, password: 'definitely the wrong password, not correct' },
        { 'x-forwarded-for': ip },
      );
      statuses.push(response.status);
    }
    expect(statuses, 'the third attempt is rate-limited').toEqual([401, 401, 429]);

    await harness.forceFlush();
    const normalizedEmail = email.trim().toLowerCase();
    const [local = '', domain = ''] = normalizedEmail.split('@');
    const octets = ip.split('.');
    const forbidden = [
      ip,
      octets.slice(0, 3).join('.'),
      email,
      normalizedEmail,
      local,
      domain,
      sha256Hex(ip),
      sha256Hex(normalizedEmail),
      sha256Hex(ip).slice(0, 8),
      sha256Hex(normalizedEmail).slice(0, 8),
    ];
    const entries = exportedCorpus(harness).filter(
      (entry) =>
        entry.signal === 'log auth.security.rate_limited' ||
        entry.signal === 'metric tayzu.auth.rate_limit.events',
    );
    expect(
      entries.some((entry) => entry.signal === 'log auth.security.rate_limited'),
      'the rate-limited log event was emitted',
    ).toBe(true);
    expect(
      entries.some((entry) => entry.signal === 'metric tayzu.auth.rate_limit.events'),
      'the rate-limit counter was recorded',
    ).toBe(true);
    for (const entry of entries) {
      for (const text of entry.strings) {
        for (const value of forbidden) {
          expect(text, `${entry.signal} must not carry "${value}"`).not.toContain(value);
        }
      }
    }
  }, 60_000);

  it("a rate-limited token exchange's caller IP and client id never appear on auth.security.rate_limited or tayzu.auth.rate_limit.events", async () => {
    const ip = randomIp();
    const clientId = `rate-leak-client-${randomUUID()}`;
    const exchange = () =>
      app.app.inject({
        method: 'POST',
        url: '/v1/auth/token',
        headers: {
          'content-type': 'application/json',
          origin: 'https://app.tayzu.test',
          'x-forwarded-for': ip,
          ...csrfHeaders('POST'),
        },
        payload: JSON.stringify({ clientId, clientSecret: `wrong-secret-${randomUUID()}` }),
      });
    await exchange();
    await exchange();
    const limited = await exchange();
    expect(limited.statusCode, 'the third exchange is rate-limited').toBe(429);

    await harness.forceFlush();
    const entries = exportedCorpus(harness);
    expect(
      logValues(harness, 'auth.security.rate_limited', 'tayzu.auth.rate_limit.scope'),
      'the token_exchange scope is recorded on the log event',
    ).toContain('token_exchange');
    expect(
      metricValues(harness, 'tayzu.auth.rate_limit.events', 'tayzu.auth.rate_limit.scope'),
      'the token_exchange scope is recorded on the counter',
    ).toContain('token_exchange');
    const onRateLimitSignals = entries.filter(
      (entry) =>
        entry.signal === 'log auth.security.rate_limited' ||
        entry.signal === 'metric tayzu.auth.rate_limit.events',
    );
    for (const entry of onRateLimitSignals) {
      for (const text of entry.strings) {
        for (const value of [ip, ip.split('.').slice(0, 3).join('.'), clientId, sha256Hex(ip)]) {
          expect(text, `${entry.signal} must not carry "${value}"`).not.toContain(value);
        }
      }
    }
  }, 60_000);
});

/**
 * SSO / back-channel logout / step-up-insufficient leak extension (task 13.5).
 *
 * "`otel-smoke-check` (extended) exercises `auth.sso.callback`,
 * `auth.backchannel_logout.received`, and the step-up-insufficient path once
 * each, asserting the Visma Connect `sub`/`sid`/tokens/email/IP never appear on
 * any of them."
 *
 * The contract half of 13.5 (`contract.ts` and `contract.test.ts`) already
 * holds: 13.1 declared every SSO, account-link, back-channel-logout and
 * step-up-insufficient name, and the 13.2 drive asserts they are emitted. These
 * tests cover only what is left: that no forbidden value reaches those signals.
 *
 * ## Production symbols expected
 *
 * - Nothing new. Like the 13.3 tests, these pass when the existing
 *   instrumentation is already clean, which is a valid outcome (not forced to
 *   fail). Non-vacuity is asserted: the named span and log event must exist.
 */
describe('otel-smoke-check, 002: Visma Connect values never reach a signal (task 13.5)', () => {
  let app: App;
  let stub: OidcStub;
  let authPool: Pool;
  let handler: WebHandler;
  let harness: TelemetryTestHarness;

  beforeAll(async () => {
    harness = registeredHarness();
    const pools = await harnessPools();
    authPool = pools.authPool;
    await runMigrations(authPool);
    stub = await startOidcStub();
    app = await createApp({
      ...pools,
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: ['https://app.tayzu.test'],
      sso: {
        discoveryUrl: stub.discoveryUrl,
        clientId: stub.clientId,
        clientSecret: stub.clientSecret,
      },
    });
    handler = handlerOf(app.auth);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await stub.close();
  });

  function newTenant(name: string) {
    const suffix = randomUUID();
    return bootstrapTestTenant(app.auth, {
      name,
      email: `sso-leak-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Sso Leak Org ${suffix}`,
      organizationSlug: `sso-leak-org-${suffix}`,
      ip: randomIp(),
    });
  }

  async function expectNoLeak(markers: Readonly<Record<string, string>>): Promise<void> {
    await harness.forceFlush();
    const entries = exportedCorpus(harness);
    expect(entries.length, 'the corpus is not empty').toBeGreaterThan(0);
    for (const [label, marker] of Object.entries(markers)) {
      expect(marker.length, `${label} marker is non-trivial`).toBeGreaterThanOrEqual(6);
      expect(leaks(entries, marker), `${label} must never appear on any signal`).toEqual([]);
    }
  }

  /** Markers for an email: the address, its lower-case form, and its local part. */
  function emailMarkers(label: string, email: string): Record<string, string> {
    const normalized = email.trim().toLowerCase();
    return {
      [`${label} email`]: email,
      [`${label} normalized email`]: normalized,
      [`${label} email local part`]: normalized.split('@')[0] ?? normalized,
    };
  }

  function ipMarkers(label: string, ip: string): Record<string, string> {
    return {
      [`${label} IP`]: ip,
      [`${label} IP /24 prefix`]: ip.split('.').slice(0, 3).join('.'),
      [`${label} IP digest`]: sha256Hex(ip),
    };
  }

  it('an auth.sso.callback, success and rejected, leaks no sub, sid, email, code, state or caller IP', async () => {
    const ip = randomIp();
    const seen: Record<string, string> = {};
    const run = async (label: string, linkTo: string | null): Promise<void> => {
      const sub = `leak-sub-${randomUUID()}`;
      const sid = `leak-sid-${randomUUID()}`;
      const email = `Leak-Sso-${randomUUID()}@Example.test`;
      if (linkTo !== null) {
        await authPool.query(
          `insert into auth.account (id, account_id, provider_id, user_id, created_at, updated_at)
           values ($1, $2, $3, $4, now(), now())`,
          [randomUUID(), sub, PROVIDER_ID, linkTo],
        );
      }
      stub.setSubject({ sub, email, name: `Leak Name ${randomUUID()}`, sid });

      const initiated = await postJson(
        handler,
        '/sign-in/social',
        { provider: PROVIDER_ID, callbackURL: '/' },
        { 'x-forwarded-for': ip },
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
      const { code, state, iss } = inputs;
      if (code === undefined || state === undefined) {
        throw new Error('the OIDC stub did not return code and state');
      }
      const params = new URLSearchParams({ code, state, ...(iss === undefined ? {} : { iss }) });
      const headers = { 'x-forwarded-for': ip, cookie: cookieFrom(initiated) };
      const posted = await handler(
        new Request(`${AUTH_BASE_URL}/callback/${PROVIDER_ID}`, {
          method: 'POST',
          headers: {
            ...headers,
            'content-type': 'application/x-www-form-urlencoded',
            origin: AUTH_ORIGIN,
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
        await handler(new Request(new URL(location, AUTH_BASE_URL), { headers }));
      }
      seen[`${label} sub`] = sub;
      seen[`${label} sid`] = sid;
      seen[`${label} authorization code`] = code;
      seen[`${label} state`] = state;
      Object.assign(seen, emailMarkers(label, email));
    };

    const linked = await newTenant('Leak Sso Linked');
    await run('linked', linked.userId);
    await run('unlinked', null);

    await harness.forceFlush();
    expect(
      spansNamed(harness, 'auth.sso.callback').length,
      'the callback span exists',
    ).toBeGreaterThanOrEqual(2);
    await expectNoLeak({ ...seen, ...ipMarkers('caller', ip) });
  }, 60_000);

  it('an auth.backchannel_logout.received, revoked, replay, no_match and invalid, leaks no sub, sid, jti, logout token or caller IP', async () => {
    const ip = randomIp();
    const sid = `leak-bcl-sid-${randomUUID()}`;
    const target = await newTenant('Leak Backchannel');
    await authPool.query('update auth.session set sso_sid = $1 where user_id = $2', [
      sid,
      target.userId,
    ]);
    const markers: Record<string, string> = { ...ipMarkers('caller', ip) };
    const mint = (label: string, forSid: string): string => {
      const now = Math.floor(Date.now() / 1000);
      const sub = `leak-bcl-sub-${randomUUID()}`;
      const jti = randomUUID();
      const token = stub.signJwt(
        {
          iss: stub.issuer,
          aud: stub.clientId,
          sub,
          sid: forSid,
          iat: now,
          exp: now + 300,
          jti,
          events: { [LOGOUT_EVENT]: {} },
        },
        { typ: 'logout+jwt' },
      );
      markers[`${label} sub`] = sub;
      markers[`${label} sid`] = forSid;
      markers[`${label} jti`] = jti;
      markers[`${label} logout token`] = token;
      markers[`${label} logout token signature`] = token.split('.')[2] ?? token;
      return token;
    };
    const post = (token: string) =>
      app.app.inject({
        method: 'POST',
        url: BACKCHANNEL_ROUTE,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-forwarded-for': ip,
        },
        payload: new URLSearchParams({ logout_token: token }).toString(),
      });

    const revokedToken = mint('valid', sid);
    const responses = [
      await post(revokedToken), // revoked
      await post(revokedToken), // replay
      await post(mint('no_match', `leak-bcl-missing-${randomUUID()}`)), // no_match
      await post(`invalid.${randomUUID()}.marker`), // invalid
    ];
    for (const response of responses) {
      expect(response.statusCode).toBe(200);
    }

    await harness.forceFlush();
    expect(
      spansNamed(harness, 'auth.backchannel_logout.received').length,
      'the back-channel span exists',
    ).toBeGreaterThanOrEqual(4);
    expect(
      logRecords(harness, 'auth.security.backchannel_logout_received').length,
      'the back-channel log event exists',
    ).toBeGreaterThanOrEqual(4);
    await expectNoLeak(markers);
  }, 60_000);

  it('a step_up_insufficient re-authorization leaks no sub, sid, id token, email or session cookie', async () => {
    const tenant = await newTenant('Leak Step-Up');
    const sid = `leak-su-sid-${randomUUID()}`;
    const sub = `leak-su-sub-${randomUUID()}`;
    const claimEmail = `Leak-StepUp-${randomUUID()}@Example.test`;
    await authPool.query('update auth.session set sso_sid = $1 where user_id = $2', [
      sid,
      tenant.userId,
    ]);
    const guard = createStepUpGuard({
      auth: app.auth,
      sso: {
        discoveryUrl: stub.discoveryUrl,
        clientId: stub.clientId,
        clientSecret: stub.clientSecret,
      },
    });
    const now = Math.floor(Date.now() / 1000);
    const idToken = stub.signJwt({
      iss: stub.issuer,
      aud: stub.clientId,
      sub,
      sid,
      email: claimEmail,
      iat: now,
      exp: now + 300,
      auth_time: now - 10,
      acr: 2,
      amr: ['pwd'],
    });
    await expect(
      guard({
        headers: new Headers({ cookie: tenant.cookie }),
        tenantId: tenant.organizationId,
        actor: { type: 'user', id: tenant.userId },
        route: HIGH_RISK_ROUTE,
        operation: BLUEPRINT_DELETE_OPERATION,
        reauthorization: { idToken },
      }),
    ).rejects.toMatchObject({ code: 'AUTH_STEP_UP_REQUIRED' });

    await harness.forceFlush();
    expect(
      logRecords(harness, 'auth.security.step_up_insufficient').length,
      'the step-up-insufficient log event exists',
    ).toBeGreaterThanOrEqual(1);
    const markers: Record<string, string> = {
      'reauthorization sub': sub,
      'reauthorization sid': sid,
      'reauthorization id token': idToken,
      'reauthorization id token signature': idToken.split('.')[2] ?? idToken,
      ...emailMarkers('claim', claimEmail),
      ...emailMarkers('account', tenant.email),
    };
    tenant.cookie
      .split('; ')
      .map((pair) => decodeURIComponent(pair.slice(pair.indexOf('=') + 1)))
      .filter((value) => value.length >= 16)
      .forEach((value, index) => {
        markers[`session cookie value #${String(index)}`] = value;
        markers[`session token #${String(index)}`] = value.split('.')[0] ?? value;
      });
    await expectNoLeak(markers);
  }, 60_000);
});
