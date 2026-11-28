/**
 * `otel-smoke-check`, 002 extension (task 13.2, openspec/changes/archive/2026-10-15-002-auth-and-rbac;
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
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { inspect } from 'node:util';

import { registration, type TelemetryTestHarness } from './__fixtures__/link-telemetry.js';

import { createRouterClient } from '@orpc/server';
import {
  authSchema,
  AuthRateLimitedError,
  createAllowlistEmailSender,
  createAzureCommunicationEmailSender,
  createNonSendingEmailSender,
  createAuth,
  createContextResolver,
  createRecordingEmailSender,
  createStepUpGuard,
  type AuthInstance,
  type EmailTemplate,
} from '@tayzu/auth';
import { createCerbosClient } from '@tayzu/authz';
import { createUserSync } from '@tayzu/catalog';
import { runMigrations } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  bootstrapTestTenant,
  createAdminUser,
  seedUserRow,
  signInAdminUser,
  type BootstrappedTenant,
  testAppPool,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { startOidcStub, type OidcStub } from '../../../packages/auth/src/__fixtures__/oidc-stub.js';
import { createMachineCredential, revokeMachineCredential } from '@tayzu/auth/machine-credentials';
import { exchangeMachineToken } from '../../../packages/auth/src/token-exchange.js';
import { LOG_EVENTS, METRICS, SPANS } from '../../../packages/authz/src/telemetry/contract.js';
import {
  LOG_EVENTS as CATALOG_LOG_EVENTS,
  USER_ENTITY_IDENTIFIER_PLACEHOLDER,
} from '../../../packages/catalog/src/telemetry/contract.js';
import * as identityContract from '../../../packages/auth/src/telemetry/identity-contract.js';
import {
  EXPECTED_ATTRIBUTE_VALUES,
  EXPECTED_LOG_EVENTS,
  EXPECTED_METRICS,
  EXPECTED_SPANS,
} from '../../../packages/auth/src/__fixtures__/identity-contract-expected.js';
import {
  getDeletionAdminTestDatabase,
  getPurgeTestDatabase,
} from '../../../packages/db/src/harness.js';
import { csrfHeaders } from './__fixtures__/csrf.js';
import {
  enrolledAdminSession,
  enrollTotp,
  sessionTokenOfCookie,
  signInWithTotp,
} from './__fixtures__/fresh-mfa.js';
import { harnessPools, type HarnessPools } from './__fixtures__/pools.js';
import { oidcRoundTrip, poolFailing } from './__fixtures__/sso-shed.js';
import { createAcceptFlow, type AcceptFlowOptions } from './identity/accept-flow.js';
import { createAuthRepository } from './identity/auth-repository.js';
import { createEmailTenantGate, type EmailTenantGate } from './identity/email-tenant-gate.js';
import { createInMemoryEmailCapStore } from './identity/invitation-caps.js';
import { createNoticeDispatcher, type NoticeDispatcher } from './identity/notices.js';
import { createSsoLinkShed } from './identity/sso-link-shed.js';
import { createUserSyncAdapter } from './identity/user-sync-adapter.js';
import { createWithUserLock } from './identity/user-lock.js';
import { createMfaResetService } from './identity/mfa-reset.js';
import { createResetTokenStore } from './identity/reset-token-store.js';
import { createIdentityRouter } from './identity-router.js';
import { createApp, type App } from './server.js';
import { main as bootstrapAdminMain } from '../scripts/bootstrap-admin.js';
import { main as reconcileUsersMain } from '../scripts/reconcile-users.js';
import { main as cancelOrgDeletionMain } from '../scripts/cancel-org-deletion.js';
import { runPurge } from '../scripts/purge-job.js';
import type { Telemetry } from './telemetry.js';
import type * as MachineCredentialsModule from '@tayzu/auth/machine-credentials';
import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';

// Same secret as `@tayzu/auth`'s machine-credential int tests: Better Auth's `jwks` row is
// shared in the test database and encrypted with whichever secret created it first, so
// the token-exchange drive below needs the secret those tests use.
/**
 * Failure seam of the 043 describe below (task 15.2): `revokeMachineCredential` delegates to the
 * real function except inside the tenants listed here, where it throws a message that carries
 * SQL-looking text. Empty by default, so every other case of this file sees the real behavior.
 */
const identityRevokeSeam = vi.hoisted(() => ({
  failTenants: new Set<string>(),
  message: 'injected revoke failure: select token from auth.apikey where key = $1',
}));

vi.mock('@tayzu/auth/machine-credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof MachineCredentialsModule>();
  return {
    ...actual,
    revokeMachineCredential: async (
      ...args: Parameters<typeof actual.revokeMachineCredential>
    ): Promise<void> => {
      if (identityRevokeSeam.failTenants.has(args[1].tenantId)) {
        throw new Error(identityRevokeSeam.message);
      }
      await actual.revokeMachineCredential(...args);
    },
  };
});

const TEST_PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'A-different-Correct-Horse-Battery-Staple-42!';
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
        withUserLock: createWithUserLock(authPool),
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
      pool: testAppPool(),
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

  it('sessions: a banned user signing in with the correct password is refused like a wrong password (task 13.4b)', async () => {
    const tenant = await newTenant('Smoke Banned');
    await authPool.query('update auth."user" set banned = true where id = $1', [tenant.userId]);

    const refused = await postJson(handler, '/sign-in/email', {
      email: tenant.email,
      password: TEST_PASSWORD,
    });
    expect(refused.status).toBe(401);
    expect(refused.headers.getSetCookie().some((c) => c.includes('session_token'))).toBe(false);
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
    const create = (actorKind: 'integration' | 'agent') =>
      createMachineCredential(app.auth, {
        userId: admin.userId,
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
      userId: admin.userId,
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
      { params: { user: target.email }, body: { subject: `smoke-link-sub-${randomUUID()}` } },
      { context },
    );
    await identity.identity.users.unlinkSsoAccount({ params: { user: target.email } }, { context });
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

/*
 * Task 3.11 of openspec/changes/archive/2026-11-27-003-catalog-ui-core (design D11 "Step-up telemetry for Visma
 * Connect", "Observability contract" -> Log events; Resolved decisions Q27 B2 and Q29). Verify
 * clause: "the `apps/api` `otel-smoke-check.int.test.ts` covers "A Visma Connect step-up is
 * logged" against the OIDC stub (success with the bound tenant and actor, an unknown state and
 * a failed token exchange each with its reason), with a marker check that no code, state, token
 * or claim reaches any attribute; the local step-up still emits `local`."
 *
 * Design D11: "On a successful `complete`, the server emits the already-declared
 * `auth.security.step_up_succeeded` with `tayzu.auth.method` `visma_connect` and the tenant and
 * actor of the session the state is bound to ...; a failed callback emits the new
 * `auth.security.reauthorization_failed` (WARN, reason `invalid_state` or `exchange_failed`, no
 * tenant, since none is bound to an unknown state). No code, state, token or claim reaches
 * either event." Log events: both events belong to `@tayzu/auth`'s logger.
 *
 * Drive: the real HTTP flow of `step-up-sso-http.int.test.ts` (an MFA-enrolled owner whose
 * session carries an `sso_sid`; a high-risk `DELETE` answered `403 AUTH_STEP_UP_REQUIRED` with
 * `data.reauthorizationUrl`; the stub's authorization endpoint; the re-authorization callback
 * `GET /v1/auth/visma-connect/reauthorize/callback`). The unknown state is a state no `start`
 * issued; the failed token exchange presents a real state with a code the stub never issued,
 * which its token endpoint answers `400 invalid_grant`. `WEB_DIST_DIR` is unset, so the callback
 * answers `200 {}` or `400` (task 3.10 changes that only with the web app).
 *
 * The describe sits before the 002 per-event check below because that check iterates
 * `@tayzu/authz`'s `LOG_EVENTS`, which declares `auth.security.reauthorization_failed` too.
 *
 * ## Production symbols expected (the red phase)
 *
 * - `emitStepUpSucceeded` (`packages/auth/src/auth.ts`) takes the method
 *   (`'local' | 'visma_connect'`) instead of hard-coding `local`, and is reachable from the
 *   re-authorization `complete` (`apps/api/src/reauthorization.ts`), which on success emits it
 *   with `visma_connect` and the `userId` and `activeOrganizationId` of the `auth.session` row
 *   whose token the consumed state carries.
 * - `auth.security.reauthorization_failed` (WARN, `@tayzu/auth` logger, attribute only
 *   `tayzu.auth.reauthorization.reason`): `invalid_state` when no unexpired state row is
 *   consumed, `exchange_failed` when discovery, the token request or its `id_token` fails.
 */
describe('otel-smoke-check, 003: A Visma Connect step-up is logged (task 3.11)', () => {
  const STEP_UP_SUCCEEDED = 'auth.security.step_up_succeeded';
  const REAUTH_FAILED = 'auth.security.reauthorization_failed';
  const METHOD = 'tayzu.auth.method';
  const REASON = 'tayzu.auth.reauthorization.reason';
  const TENANT = 'tayzu.tenant.id';
  const ACTOR_ID = 'tayzu.actor.id';
  const ORIGIN = 'https://app.tayzu.test';
  const CALLBACK_PATH = '/v1/auth/visma-connect/reauthorize/callback';
  const RESULT_PREFIX = 'sso-reauth-result:';
  const SEVERITY_INFO = 9;
  const SEVERITY_WARN = 13;

  let app: App;
  let stub: OidcStub;
  let authPool: Pool;
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
      allowedOrigins: [ORIGIN],
      sso: {
        discoveryUrl: stub.discoveryUrl,
        clientId: stub.clientId,
        clientSecret: stub.clientSecret,
      },
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await stub.close();
  });

  interface EnrolledSession {
    readonly tenant: BootstrappedTenant;
    readonly cookie: string;
    readonly secret: string;
  }

  /** An MFA-enrolled org owner (Q43) signed in through a real TOTP challenge. */
  async function enrolledSession(label: string): Promise<EnrolledSession> {
    const suffix = randomUUID();
    const tenant = await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: `Reauth Smoke ${label}`,
      email: `reauth-smoke-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Reauth Smoke Org ${suffix}`,
      organizationSlug: `reauth-smoke-${suffix}`,
      ip: randomIp(),
    });
    const secret = await enrollTotp(app, {
      password: TEST_PASSWORD,
      enrollmentCookie: tenant.cookie,
    });
    const cookie = await signInWithTotp(app, {
      email: tenant.email,
      password: TEST_PASSWORD,
      secret,
      origin: ORIGIN,
    });
    return { tenant, cookie, secret };
  }

  /** The same owner, with the session marked as established through Visma Connect (D25). */
  async function ssoSession(label: string): Promise<EnrolledSession & { readonly sid: string }> {
    const session = await enrolledSession(label);
    const sid = `ReauthSidMarker-${randomUUID()}`;
    await authPool.query('update auth.session set sso_sid = $1 where user_id = $2', [
      sid,
      session.tenant.userId,
    ]);
    return { ...session, sid };
  }

  /** The step-up interceptor refuses a high-risk call and hands out the authorization URL. */
  async function startReauthorization(cookie: string): Promise<URL> {
    const refused = await app.app.inject({
      method: 'DELETE',
      url: `/v1/blueprints/reauth-smoke-${randomUUID().slice(0, 8)}`,
      headers: { cookie, origin: ORIGIN, 'x-forwarded-for': randomIp(), ...csrfHeaders('DELETE') },
    });
    expect(refused.statusCode, refused.body).toBe(403);
    const body = refused.json<{ code?: unknown; data?: { reauthorizationUrl?: unknown } }>();
    expect(body.code).toBe('AUTH_STEP_UP_REQUIRED');
    const raw = body.data?.reauthorizationUrl;
    if (typeof raw !== 'string') {
      throw new Error('the step-up refusal must carry data.reauthorizationUrl');
    }
    return new URL(raw);
  }

  /**
   * The browser lands on the callback; `cookie` is the initiating session's cookie, which the
   * callback requires and matches against the bound session (048 task 6.3, design D6).
   */
  function callback(params: { readonly code: string; readonly state: string }, cookie?: string) {
    return app.app.inject({
      method: 'GET',
      url: `${CALLBACK_PATH}?${new URLSearchParams(params).toString()}`,
      headers: {
        'x-forwarded-for': randomIp(),
        host: 'localhost:3000',
        origin: ORIGIN,
        ...(cookie === undefined ? {} : { cookie }),
      },
    });
  }

  /** The records of `name` emitted since `before` records of it existed. */
  async function recordsSince(name: string, before: number) {
    await harness.forceFlush();
    return logRecords(harness, name).slice(before);
  }

  async function flushedCount(name: string): Promise<number> {
    await harness.forceFlush();
    return logRecords(harness, name).length;
  }

  interface Drive {
    readonly tenantId?: string;
    readonly actorId?: string;
    readonly markers: Readonly<Record<string, string>>;
  }

  /** A completed re-authorization: the person approves at the stub and the callback succeeds. */
  async function driveSuccess(): Promise<Drive> {
    const user = await ssoSession('Success');
    const id = randomUUID();
    const claimEmail = `reauth-claim-marker-${id}@example.test`;
    const markers: Record<string, string> = {
      sub: `ReauthSubMarker-${id}`,
      'claim email': claimEmail,
      'claim email local part': claimEmail.split('@')[0] ?? claimEmail,
      'claim name': `ReauthNameMarker-${id}`,
      'custom claim': `ReauthClaimMarker-${id}`,
      sid: user.sid,
      'session token': sessionTokenOfCookie(user.cookie),
    };
    const now = Math.floor(Date.now() / 1000);
    stub.setSubject({
      sub: markers['sub'] ?? '',
      email: claimEmail,
      name: markers['claim name'] ?? '',
      sid: user.sid,
      claims: {
        auth_time: now - 10,
        acr: 3,
        amr: ['pwd', 'otp'],
        tayzu_marker: markers['custom claim'],
      },
    });
    const url = await startReauthorization(user.cookie);
    const state = url.searchParams.get('state') ?? '';
    const approval = await fetch(url, { redirect: 'manual' });
    const location = approval.headers.get('location');
    expect(approval.status, 'the stub approves with a query redirect').toBe(302);
    if (location === null) {
      throw new Error('the OIDC stub did not redirect to the callback');
    }
    const returned = new URL(location);
    expect(returned.pathname).toBe(CALLBACK_PATH);
    expect(returned.searchParams.get('state')).toBe(state);
    const code = returned.searchParams.get('code') ?? '';
    const answered = await callback({ code, state }, user.cookie);
    expect(answered.statusCode, `the callback succeeds: ${answered.body}`).toBeLessThan(400);
    const stored = await authPool.query<{ value: string }>(
      'select value from auth.verification where identifier = $1',
      [`${RESULT_PREFIX}${markers['session token'] ?? ''}`],
    );
    const idToken = stored.rows[0]?.value ?? '';
    expect(idToken, 'precondition: the callback stored the returned ID token').not.toBe('');
    return {
      tenantId: user.tenant.organizationId,
      actorId: user.tenant.userId,
      markers: {
        ...markers,
        'authorization code': code,
        state,
        'id token': idToken,
        'id token signature': idToken.split('.')[2] ?? idToken,
      },
    };
  }

  /** A callback whose state no `start` ever issued. */
  async function driveUnknownState(): Promise<Drive> {
    const id = randomUUID();
    const markers = {
      'unknown state': `ReauthUnknownStateMarker-${id}`,
      'unknown-state code': `ReauthUnknownCodeMarker-${id}`,
    };
    const answered = await callback({
      code: markers['unknown-state code'],
      state: markers['unknown state'],
    });
    expect(answered.statusCode, answered.body).toBe(400);
    return { markers };
  }

  /** A real, bound state presented with a code the stub never issued: the token exchange fails. */
  async function driveFailedExchange(): Promise<Drive> {
    const user = await ssoSession('Exchange');
    const url = await startReauthorization(user.cookie);
    const state = url.searchParams.get('state') ?? '';
    expect(state, 'precondition: the authorization URL carries a state').not.toBe('');
    const code = `ReauthRejectedCodeMarker-${randomUUID()}`;
    const answered = await callback({ code, state }, user.cookie);
    expect(answered.statusCode, answered.body).toBe(400);
    return {
      tenantId: user.tenant.organizationId,
      actorId: user.tenant.userId,
      markers: {
        'bound state': state,
        'rejected code': code,
        'exchange sid': user.sid,
        'exchange session token': sessionTokenOfCookie(user.cookie),
      },
    };
  }

  function expectFailureRecords(
    records: ReturnType<typeof logRecords>,
    reason: 'invalid_state' | 'exchange_failed',
  ): void {
    expect(records.length, `no "${REAUTH_FAILED}" record was captured`).toBeGreaterThan(0);
    expect(EXPECTED_ATTRIBUTE_VALUES[REASON], 'the reason is in the fixture set').toContain(reason);
    for (const record of records) {
      expect(record.instrumentationScope.name).toBe('@tayzu/auth');
      expect(record.severityNumber, `${REAUTH_FAILED} is WARN`).toBe(SEVERITY_WARN);
      expect(Object.keys(record.attributes), 'only the reason, no tenant').toEqual([REASON]);
      expect(record.attributes[REASON]).toBe(reason);
    }
  }

  it('a successful callback emits step_up_succeeded with tayzu.auth.method=visma_connect and the tenant and actor of the bound session', async () => {
    const drive = await driveSuccess();

    await harness.forceFlush();
    const ofTenant = logRecords(harness, STEP_UP_SUCCEEDED).filter(
      (record) => record.attributes[TENANT] === drive.tenantId,
    );
    const visma = ofTenant.filter((record) => record.attributes[METHOD] === 'visma_connect');
    expect(visma.length, `no visma_connect "${STEP_UP_SUCCEEDED}" for the bound tenant`).toBe(1);
    expect(EXPECTED_ATTRIBUTE_VALUES[METHOD], 'the method is in the fixture set').toContain(
      'visma_connect',
    );
    for (const record of visma) {
      expect(record.instrumentationScope.name).toBe('@tayzu/auth');
      expect(record.severityNumber, `${STEP_UP_SUCCEEDED} is INFO`).toBe(SEVERITY_INFO);
      expect(record.attributes[ACTOR_ID], 'the actor of the bound session').toBe(drive.actorId);
      expect(Object.keys(record.attributes).sort()).toEqual([ACTOR_ID, METHOD, TENANT].sort());
    }
  }, 60_000);

  it('an unknown state emits reauthorization_failed with reason invalid_state and no tenant', async () => {
    const before = await flushedCount(REAUTH_FAILED);

    await driveUnknownState();

    expectFailureRecords(await recordsSince(REAUTH_FAILED, before), 'invalid_state');
  }, 60_000);

  it('a failed token exchange emits reauthorization_failed with reason exchange_failed and no tenant, and no step_up_succeeded', async () => {
    const before = await flushedCount(REAUTH_FAILED);

    const drive = await driveFailedExchange();

    expectFailureRecords(await recordsSince(REAUTH_FAILED, before), 'exchange_failed');
    const visma = logRecords(harness, STEP_UP_SUCCEEDED).filter(
      (record) =>
        record.attributes[TENANT] === drive.tenantId &&
        record.attributes[METHOD] === 'visma_connect',
    );
    expect(visma, 'a failed callback records no Visma Connect step-up').toEqual([]);
  }, 60_000);

  it('no code, state, token or claim value of a Visma Connect step-up reaches any signal', async () => {
    const drives = [await driveSuccess(), await driveUnknownState(), await driveFailedExchange()];

    await harness.forceFlush();
    expect(
      logRecords(harness, STEP_UP_SUCCEEDED).some(
        (record) =>
          record.attributes[TENANT] === drives[0]?.tenantId &&
          record.attributes[METHOD] === 'visma_connect',
      ),
      'precondition: the success drive was logged',
    ).toBe(true);
    expect(
      new Set(logRecords(harness, REAUTH_FAILED).map((record) => record.attributes[REASON])),
      'precondition: both failure drives were logged',
    ).toEqual(new Set(['invalid_state', 'exchange_failed']));
    const corpus = exportedCorpus(harness);
    for (const drive of drives) {
      for (const [label, marker] of Object.entries(drive.markers)) {
        expect(marker.length, `${label} marker is non-trivial`).toBeGreaterThanOrEqual(6);
        expect(leaks(corpus, marker), `the ${label} must never appear on any signal`).toEqual([]);
      }
    }
  }, 120_000);

  it('the local step-up still emits step_up_succeeded with tayzu.auth.method=local', async () => {
    const { tenant, cookie, secret } = await enrolledSession('Local');
    const totpApi = app.auth.api as TotpApi;

    const stepUp = await postJson(
      handlerOf(app.auth),
      '/two-factor/verify-totp',
      { code: (await totpApi.generateTOTP({ body: { secret } })).code },
      { cookie },
    );
    expect(stepUp.status, 'the step-up verification succeeds').toBe(200);

    await harness.forceFlush();
    const ofTenant = logRecords(harness, STEP_UP_SUCCEEDED).filter(
      (record) => record.attributes[TENANT] === tenant.organizationId,
    );
    expect(
      ofTenant.some((record) => record.attributes[ACTOR_ID] === tenant.userId),
      `no "${STEP_UP_SUCCEEDED}" for the local actor`,
    ).toBe(true);
    expect(new Set(ofTenant.map((record) => record.attributes[METHOD]))).toEqual(
      new Set(['local']),
    );
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

    it('login_failed covers bad_credentials, mfa_failed and account_disabled', () => {
      expect(logValues(harness, 'auth.security.login_failed', 'tayzu.auth.failure_reason')).toEqual(
        new Set(['bad_credentials', 'mfa_failed', 'account_disabled']),
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
      pool: testAppPool(),
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
    const credential = await createMachineCredential(app.auth, {
      userId: tenant.userId,
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
      pool: testAppPool(),
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

/*
 * Task 15.1 (043): "`otel-smoke-check.int.test.ts` fails when a declared name is
 * missing from the imported module." The smoke check imports the identity
 * contract module in addition to `@tayzu/authz`'s contract; this check fails
 * for every name of design.md's Observability contract that the module does not
 * declare, so a name cannot be dropped (or never added) without the smoke check
 * going red. The expected names are the spec side, in
 * `packages/auth/src/__fixtures__/identity-contract-expected.ts`.
 *
 * Production symbols expected: `IDENTITY_SPANS`, `IDENTITY_METRICS` and
 * `IDENTITY_LOG_EVENTS` exported by `packages/auth/src/telemetry/identity-contract.ts`,
 * each a list of objects with a `name` (a log event may be a bare string).
 */
describe('otel-smoke-check, 043: every declared identity name is in the imported contract module (task 15.1)', () => {
  function namesOf(list: unknown): Set<string> {
    const entries = Array.isArray(list) ? (list as readonly unknown[]) : [];
    return new Set(
      entries.map((entry) =>
        typeof entry === 'string' ? entry : String((entry as { name?: unknown }).name),
      ),
    );
  }

  const declared = identityContract as Record<string, unknown>;

  it.each(EXPECTED_SPANS.map((span) => [span.name] as const))(
    'span %s is declared in the identity contract module',
    (name) => {
      expect(namesOf(declared.IDENTITY_SPANS).has(name)).toBe(true);
    },
  );

  it.each(EXPECTED_METRICS.map((metric) => [metric.name] as const))(
    'metric %s is declared in the identity contract module',
    (name) => {
      expect(namesOf(declared.IDENTITY_METRICS).has(name)).toBe(true);
    },
  );

  it.each(EXPECTED_LOG_EVENTS.map((event) => [event.name] as const))(
    'log event %s is declared in the identity contract module',
    (name) => {
      expect(namesOf(declared.IDENTITY_LOG_EVENTS).has(name)).toBe(true);
    },
  );
});

/*
 * Task 9.1 of openspec/changes/archive/2026-11-18-045-org-deletion-and-data-retention: "`otel-smoke-check.int.test.ts`
 * fails when a declared name is missing from the module." The 043 check above iterates the
 * extended fixture, so it already fails for every 045 name the module lacks; this check pins the
 * fifteen 045 names (and the value sets the cardinality guard reads from the module) on the spec
 * side too, so that dropping a name from the fixture and the module together still goes red.
 *
 * Production symbols expected: the 045 entries of `IDENTITY_SPANS`, `IDENTITY_METRICS`,
 * `IDENTITY_LOG_EVENTS` and `IDENTITY_ATTRIBUTE_VALUES` in
 * `packages/auth/src/telemetry/identity-contract.ts` (design "Observability contract").
 */
describe('otel-smoke-check, 045: every declared org-deletion name is in the imported contract module (task 9.1)', () => {
  const SPANS_045 = [
    'identity.organization.delete',
    'identity.organization.cancel_deletion',
    'identity.organization.purge',
  ];
  const METRICS_045 = ['tayzu.identity.org_deletions'];
  const LOGS_045 = [
    'catalog.audit.org_deletion_requested',
    'catalog.audit.org_deletion_cancelled',
    'catalog.audit.org_deletion_completed',
    'catalog.security.org_deletion_notice_failed',
    'catalog.security.org_deletion_failed',
    'catalog.security.org_deletion_repeated',
    'catalog.security.org_deletion_cancel_refused',
  ];
  const VALUES_045: Readonly<Record<string, readonly string[]>> = {
    'tayzu.identity.rejection.reason': ['tenant_pending_deletion'],
    'tayzu.identity.invitation.denial_reason': ['tenant_pending_deletion'],
    'tayzu.identity.invitation.reason': ['org_deletion'],
    'tayzu.identity.email.template': ['org_deletion'],
    'tayzu.identity.notice.template': ['org_deletion'],
    'tayzu.identity.org_deletion.outcome': ['requested', 'completed', 'failed', 'cancelled'],
    'tayzu.identity.org_deletion.step': ['catalog', 'auth'],
    'tayzu.identity.org_deletion.cancel_refusal': [
      'invalid_tenant',
      'no_pending_marker',
      'purge_begun',
      'purge_date_passed',
    ],
  };

  function count(list: unknown, name: string): number {
    const entries = Array.isArray(list) ? (list as readonly unknown[]) : [];
    return entries.filter(
      (entry) => (typeof entry === 'string' ? entry : (entry as { name?: unknown }).name) === name,
    ).length;
  }

  const declared = identityContract as Record<string, unknown>;

  it.each([
    ...SPANS_045.map((name) => ['span', name] as const),
    ...METRICS_045.map((name) => ['metric', name] as const),
    ...LOGS_045.map((name) => ['log event', name] as const),
  ])('the %s %s is in the fixture and declared exactly once in the module', (kind, name) => {
    const [fixture, module] =
      kind === 'span'
        ? [EXPECTED_SPANS, declared.IDENTITY_SPANS]
        : kind === 'metric'
          ? [EXPECTED_METRICS, declared.IDENTITY_METRICS]
          : [EXPECTED_LOG_EVENTS, declared.IDENTITY_LOG_EVENTS];
    expect(count(fixture, name), `fixture has ${name}`).toBe(1);
    expect(count(module, name), `module declares ${name}`).toBe(1);
  });

  it('the counter tayzu.identity.org_deletions has its declared unit', () => {
    expect(IDENTITY_METRIC_UNITS['tayzu.identity.org_deletions']).toBe('{deletion}');
  });

  it.each(Object.entries(VALUES_045))('the module declares the 045 values of %s', (key, values) => {
    const all = declared.IDENTITY_ATTRIBUTE_VALUES as
      Readonly<Record<string, readonly string[]>> | undefined;
    expect(all?.[key] ?? [], key).toEqual(expect.arrayContaining([...values]));
  });
});

/**
 * `otel-smoke-check`, 043 extension (task 15.2, openspec/changes/archive/2026-10-14-043-identity-lifecycle-and-org-admin;
 * design.md "Observability contract", Resolved decisions Q74, Q107, Q116, Q117 and Q131).
 *
 * "Extend `otel-smoke-check` to run every operation in this change once successfully and once
 * per applicable error or denial class."
 *
 * The first `describe` only drives the operations (its own assertions are limited to "the
 * operation behaved as its class says", so a failure there is never a telemetry finding); the
 * second asserts, from `packages/auth/src/telemetry/identity-contract.ts`, that every declared
 * span, metric and log event was produced with exactly its declared attribute keys, that each
 * metric has the unit of design.md's Metrics table, and the span error rules of design.md's
 * Observability contract ("expected errors: `error.type` only, no exception event; unexpected
 * errors: sanitized exception, no message/SQL").
 *
 * Operations driven, success and error class each:
 *
 * - the thirteen identity procedures, in process over the identity router (the step-up guard
 *   lives in the Fastify interceptor, which the 002 drive above does not cross either):
 *   `users.create`, `invite`, `cancelInvitation`, `resendInvitation`, `setStatus`,
 *   `linkSsoAccount`, `unlinkSsoAccount`, `serviceAccounts.create` / `delete` and
 *   `credentials.create` / `list` / `rotate` / `revoke`.
 * - the accept route over HTTP on both paths (new and existing account) and its denials,
 *   `csrf_rejected` and `origin_rejected` included; the accept flow with its test seams for
 *   `consume_conflict`, `disabled_user`, a failing notice, a failing compensation and a failing
 *   session revocation.
 * - the email gate (tenant disabled, kill switch, tenant and recipient caps), the recipient-domain
 *   allowlist and the notice dispatcher (disabled tenant, truncated, global, tenant, recipient).
 * - the reconcile (against a private scratch database: it scans every tenant) and the
 *   bootstrap CLI, the ban hook, a banned principal on `/v1` and a failing provenance marker.
 *
 * Not driven, because each needs a race or a limit the harness cannot set up without a
 * non-test change: the acceptance denial reasons `member_limit` and `account_conflict`, and the
 * invitation metric values `expired` and `rejected` (design.md does not say where they are
 * counted, so they are not asserted either).
 *
 * Entries of the identity contract that another change produces: none. The contract marks no
 * entry that way (`catalog.security.authz_denied` and `tayzu.authz.decisions`, reused from 001 and
 * 002, are not in it), so nothing is excluded.
 *
 * ## Production symbols expected (the red phase)
 *
 * Every module exists; the expected failures are assertion failures on signals that are declared
 * but not produced, or produced with drift:
 *
 * - spans `identity.invitation.create`, `.resend`, `identity.user.set_status`,
 *   `identity.credential.list`, `.create`, `.rotate` and `.revoke` have no producer, and
 *   `identity.invitation.cancel` has none on the admin path; `identity.invitation.accept`
 *   omits its conditional `tayzu.identity.invitation.path`; `identity.user.reconcile` omits
 *   `tayzu.identity.reconcile.created` and `tayzu.identity.reconcile.orphans` (a producer note
 *   beyond the audit's list: `withIdentitySpan`'s callback has no handle on the span).
 * - the counters `tayzu.identity.invitations`, `.user_status_changes`, `.service_accounts` and
 *   `.credential_mutations` are never recorded, and `recordIdentityMetric` creates counters
 *   without the declared unit.
 * - `catalog.audit.invitation_resent` is never emitted; the admin `cancelInvitation` emits no
 *   `catalog.audit.invitation_cancelled` and the reasons `admin_cancel` and `re_invite` are never
 *   produced; `catalog.audit.invitation_accepted` omits `tayzu.identity.invitation.role` and
 *   `tayzu.identity.invitation.path`; `catalog.security.invitation_acceptance_denied` is never
 *   produced with `csrf_rejected` or `origin_rejected` (a request that carries a session cookie
 *   but no CSRF header is `csrf_rejected`; one whose `Origin` is foreign or absent, with the CSRF
 *   header, is `origin_rejected`).
 * - `withIdentitySpan` records every error with `span.recordException` (raw message and stack)
 *   and sets no `error.type`.
 */
const IDENTITY_ORIGIN = 'https://app.tayzu.test';
const IDENTITY_ACCEPT_PATH = '/v1/auth/invitations/accept';
const IDENTITY_ACCEPT_PASSWORD = 'Café-Mañana-Passäphrase-2026!';
const IDENTITY_SECRET = 'smoke-043-test-only-secret-0123456789-abcdef';
const IDENTITY_OPERATOR_ID = 'gh:424242';
const IDENTITY_CERBOS = 'localhost:3593';
const SPAN_STATUS_ERROR = 2;
const isErrorStatus = (code: number): boolean => code === SPAN_STATUS_ERROR;

/** The unit of each counter, as design.md's Metrics table declares it. */
const IDENTITY_METRIC_UNITS: Readonly<Record<string, string>> = {
  'tayzu.identity.invitations': '{invitation}',
  'tayzu.identity.user_status_changes': '{change}',
  'tayzu.identity.service_accounts': '{account}',
  'tayzu.identity.credential_mutations': '{mutation}',
  'tayzu.identity.principal_rejections': '{rejection}',
  // 044 (design D15 Metrics: "counters, `{event}`").
  'tayzu.identity.password_reset_requests': '{event}',
  'tayzu.identity.password_reset_confirms': '{event}',
  'tayzu.identity.mfa_resets': '{event}',
  'tayzu.identity.recovery_emails': '{event}',
  // 045 (design "Observability contract", Metrics: "Counter, `{deletion}`").
  'tayzu.identity.org_deletions': '{deletion}',
};

/** Span attributes the design lists as conditional (its Spans table). */
const IDENTITY_SPAN_CONDITIONAL: Readonly<Record<string, readonly string[]>> = {
  'identity.invitation.accept': ['tayzu.identity.invitation.path'],
};

type IdentityClient = ReturnType<
  typeof createRouterClient<ReturnType<typeof createIdentityRouter>, Record<string, unknown>>
>;

interface MemberAdminApi {
  addMember(args: {
    body: { userId: string; organizationId: string; role: string };
  }): Promise<unknown>;
}

interface ScratchAuthApi extends MemberAdminApi {
  createOrganization(args: {
    body: { name: string; slug: string; userId: string };
  }): Promise<{ id: string }>;
}

interface InternalAdapterApi {
  readonly internalAdapter: {
    updateUser(userId: string, data: { banned: boolean }): Promise<unknown>;
  };
}

function ownerDatabaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url.trim() === '') {
    throw new Error(
      'DATABASE_URL is not set: the int project global setup should have stopped this run.',
    );
  }
  return url;
}

function databaseUrlFor(name: string): string {
  const url = new URL(ownerDatabaseUrl());
  url.pathname = `/${name}`;
  return url.href;
}

/** A pool whose every connection runs as `role` (a fixed literal, never input). */
function identityPoolAs(url: string, role: 'tayzu_app' | 'tayzu_auth'): Pool {
  const pool = new Pool({ connectionString: url });
  const statement = role === 'tayzu_app' ? 'SET ROLE tayzu_app' : 'SET ROLE tayzu_auth';
  pool.on('connect', (client) => {
    void client.query(statement).catch(() => undefined);
  });
  pool.on('error', () => undefined);
  return pool;
}

async function endQuietly(pool: Pool): Promise<void> {
  pool.on('error', () => undefined);
  await pool.end();
}

describe('otel-smoke-check, 043: every identity operation is driven (task 15.2)', () => {
  let app: App;
  let stub: OidcStub;
  let pools: HarnessPools;
  let sso: { discoveryUrl: string; clientId: string; clientSecret: string };
  const authz = createCerbosClient({ address: IDENTITY_CERBOS, tls: false });
  const sender = createRecordingEmailSender();
  const appSender = createRecordingEmailSender();
  let adapter: ReturnType<typeof createUserSyncAdapter>;
  let repository: ReturnType<typeof createAuthRepository>;
  let shed: ReturnType<typeof createSsoLinkShed>;

  beforeAll(async () => {
    registeredHarness();
    pools = await harnessPools();
    await runMigrations(pools.authPool);
    stub = await startOidcStub();
    sso = {
      discoveryUrl: stub.discoveryUrl,
      clientId: stub.clientId,
      clientSecret: stub.clientSecret,
    };
    app = await createApp({
      ...pools,
      authSecret: TEST_SECRET,
      cerbosAddress: IDENTITY_CERBOS,
      allowedOrigins: [IDENTITY_ORIGIN],
      sso,
      mountIdentityRoutes: true,
      email: {
        sender: appSender,
        invitationLinkBaseUrl: IDENTITY_ORIGIN,
        passwordResetLinkBaseUrl: IDENTITY_ORIGIN,
        disabledTenantIds: [],
        killSwitch: false,
        recipientKeySecret: IDENTITY_SECRET,
        tenantCap: { max: 1000, windowSeconds: 3600 },
        recipientCap: { max: 1000, windowSeconds: 86_400 },
      },
    });
    adapter = createUserSyncAdapter({
      userSync: createUserSync({ pool: pools.appPool, authz }),
    });
    repository = createAuthRepository(pools.authPool);
    shed = createSsoLinkShed({ authPool: pools.authPool });
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await stub.close();
  });

  function gateWith(
    options: {
      disabledTenantIds?: readonly string[];
      killSwitch?: boolean;
      tenantMax?: number;
      recipientMax?: number;
    } = {},
  ): EmailTenantGate {
    return createEmailTenantGate({
      disabledTenantIds: options.disabledTenantIds ?? [],
      capStore: createInMemoryEmailCapStore({
        tenant: { max: options.tenantMax ?? 1000, windowSeconds: 3600 },
        recipient: { max: options.recipientMax ?? 1000, windowSeconds: 86_400 },
      }),
      sender,
      recipientKeySecret: IDENTITY_SECRET,
      ...(options.killSwitch === undefined ? {} : { killSwitch: options.killSwitch }),
    });
  }

  function routerWith(emailGate: EmailTenantGate): IdentityClient {
    return createRouterClient(
      createIdentityRouter({
        auth: app.auth,
        authz,
        authRepository: repository,
        withUserLock: createWithUserLock(pools.authPool),
        emailGate,
        invitationLinkBaseUrl: IDENTITY_ORIGIN,
        appPool: pools.appPool,
        userSync: adapter,
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );
  }

  async function newTenant(label: string): Promise<BootstrappedTenant> {
    const id = randomUUID();
    return await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: `Identity ${label}`,
      email: `idsmoke-${label.toLowerCase().replaceAll(' ', '-')}-${id}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Identity Smoke ${id}`,
      organizationSlug: `idsmoke-${id}`,
      ip: randomIp(),
    });
  }

  function adminContext(tenant: BootstrappedTenant): Record<string, unknown> {
    const headers = new Headers({ cookie: tenant.cookie, 'x-forwarded-for': randomIp() });
    return {
      tenantId: tenant.organizationId,
      actor: { type: 'user', id: tenant.userId },
      principal: { roles: ['admin'] },
      __requestHeaders: headers,
      __stepUpHeaders: headers,
    };
  }

  const emailOf = (label: string): string => `idsmoke-${label}-${randomUUID()}@example.test`;

  function tokenFor(email: string): string {
    const message = [...sender.sent].reverse().find((candidate) => candidate.to === email);
    if (message?.template.kind !== 'InvitationEmail') {
      throw new Error('the invitation email was not sent');
    }
    return new URLSearchParams(new URL(message.template.link).hash.slice(1)).get('token') ?? '';
  }

  interface Invited {
    readonly tenant: BootstrappedTenant;
    readonly email: string;
    readonly invitationId: string;
    readonly token: string;
  }

  async function invite(
    client: IdentityClient,
    tenant: BootstrappedTenant,
    email: string,
    role: 'member' | 'admin' = 'member',
  ): Promise<Invited> {
    const created = await client.identity.users.invite(
      { body: { email, role } },
      { context: adminContext(tenant) },
    );
    return { tenant, email, invitationId: created.invitationId, token: tokenFor(email) };
  }

  function acceptHttp(
    body: Record<string, unknown>,
    options: { cookie?: string; omit?: 'x-csrf-token' | 'origin'; origin?: string } = {},
  ) {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      origin: options.origin ?? IDENTITY_ORIGIN,
      'x-csrf-token': 'orpc',
      'x-forwarded-for': randomIp(),
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    };
    if (options.omit !== undefined) Reflect.deleteProperty(headers, options.omit);
    return app.app.inject({
      method: 'POST',
      url: IDENTITY_ACCEPT_PATH,
      headers,
      payload: JSON.stringify(body),
    });
  }

  async function existingAccount(): Promise<{ userId: string; email: string; cookie: string }> {
    const email = emailOf('existing');
    const created = await createAdminUser(app.auth, {
      name: 'Identity Existing',
      email,
      password: TEST_PASSWORD,
    });
    const signedIn = await signInAdminUser(app.auth, {
      email,
      password: TEST_PASSWORD,
      ip: randomIp(),
    });
    return { userId: created.userId, email, cookie: signedIn.cookie };
  }

  /** A member of `other` whose Visma Connect link is unmarked, so a join of a second tenant sheds it. */
  async function linkedExistingAccount(other: BootstrappedTenant) {
    const existing = await existingAccount();
    await (app.auth.api as MemberAdminApi).addMember({
      body: { userId: existing.userId, organizationId: other.organizationId, role: 'member' },
    });
    await pools.authPool.query(
      `insert into auth.account (id, account_id, provider_id, user_id, created_at, updated_at)
       values ($1, $2, $3, $4, now(), now())`,
      [randomUUID(), `idsmoke-sub-${randomUUID()}`, PROVIDER_ID, existing.userId],
    );
    return existing;
  }

  async function sessionIdOf(cookie: string): Promise<string> {
    const token = decodeURIComponent(cookie.split('=')[1]?.split('.')[0] ?? '');
    const found = await pools.authPool.query<{ id: string }>(
      'select id from auth.session where token = $1',
      [token],
    );
    const id = found.rows[0]?.id;
    if (id === undefined) throw new Error('the session row was not found');
    return id;
  }

  function insertInvitation(
    tenantId: string,
    email: string,
    inviterId: string,
    status = 'pending',
  ): Promise<unknown> {
    return pools.authPool.query(
      `insert into auth.invitation (id, organization_id, email, role, status, expires_at, created_at, inviter_id)
       values ($1, $2, $3, 'member', $4, now() + interval '48 hours', now(), $5)`,
      [`inv-${randomUUID()}`, tenantId, email, status, inviterId],
    );
  }

  function flowWith(
    overrides: Partial<
      Pick<AcceptFlowOptions, 'notices' | 'onStep' | 'userSync' | 'authRepository' | 'ssoLinkShed'>
    > = {},
  ) {
    return createAcceptFlow({
      auth: app.auth,
      authz,
      authRepository: repository,
      authPool: pools.authPool,
      userSync: adapter,
      ssoLinkShed: shed,
      ...overrides,
    });
  }

  it('invitations: create, resend, admin cancel, re-invite, user_created and the email gate paths', async () => {
    const tenant = await newTenant('Invites');
    const context = adminContext(tenant);
    const plain = routerWith(gateWith());

    // create, resend and an admin cancel.
    const first = await invite(plain, tenant, emailOf('first'));
    const resent = await plain.identity.users.resendInvitation(
      { params: { invitation: first.invitationId } },
      { context },
    );
    expect(resent.invitationId).toBe(first.invitationId);
    await plain.identity.users.cancelInvitation(
      { params: { invitation: first.invitationId } },
      { context },
    );
    // Error classes: resending a cancelled invitation, cancelling an unknown one, an undeclared role.
    await expect(
      plain.identity.users.resendInvitation(
        { params: { invitation: first.invitationId } },
        { context },
      ),
    ).rejects.toBeDefined();
    await expect(
      plain.identity.users.cancelInvitation(
        { params: { invitation: `unknown-${randomUUID()}` } },
        { context },
      ),
    ).rejects.toBeDefined();
    await expect(
      plain.identity.users.invite(
        { body: { email: emailOf('role'), role: 'owner' as unknown as 'member' } },
        { context },
      ),
    ).rejects.toBeDefined();

    // a second invitation to the same address cancels the first (re_invite).
    const address = emailOf('reinvite');
    const original = await invite(plain, tenant, address);
    const again = await invite(plain, tenant, address);
    expect(again.invitationId).not.toBe(original.invitationId);

    // creating the user cancels a pending invitation to the address (user_created).
    const moot = emailOf('moot');
    await invite(plain, tenant, moot);
    const createdUser = await plain.identity.users.create(
      { body: { email: moot, name: 'Moot Person', role: 'member' } },
      { context },
    );
    expect(createdUser.email).toBe(moot);

    // the gate: a recipient cap, a tenant cap, the kill switch and a disabled tenant.
    const recipientLimited = routerWith(gateWith({ recipientMax: 1 }));
    const limitedAddress = emailOf('recipient-cap');
    await invite(recipientLimited, tenant, limitedAddress);
    await expect(invite(recipientLimited, tenant, limitedAddress)).rejects.toBeDefined();
    const tenantLimited = routerWith(gateWith({ tenantMax: 1 }));
    await invite(tenantLimited, tenant, emailOf('tenant-cap-a'));
    await expect(invite(tenantLimited, tenant, emailOf('tenant-cap-b'))).rejects.toBeDefined();
    const killed = routerWith(gateWith({ killSwitch: true }));
    await expect(invite(killed, tenant, emailOf('killed'))).rejects.toBeDefined();
    const blockedTenant = routerWith(gateWith({ disabledTenantIds: [tenant.organizationId] }));
    const suppressed = emailOf('suppressed');
    const created = await blockedTenant.identity.users.invite(
      { body: { email: suppressed, role: 'member' } },
      { context },
    );
    expect(created.invitationId).toBeTruthy();
    expect(sender.sent.some((message) => message.to === suppressed)).toBe(false);
  }, 180_000);

  it('users: create, a refused create, status changes and their cancellations, self-denial, link and unlink', async () => {
    const tenant = await newTenant('Users');
    const context = adminContext(tenant);
    const plain = routerWith(gateWith());

    const member = await plain.identity.users.create(
      { body: { email: emailOf('member'), name: 'Smoke Member', role: 'member' } },
      { context },
    );
    // Refused creates: the address exists (account_exists), and an undeclared role.
    await expect(
      plain.identity.users.create(
        { body: { email: member.email, name: 'Again', role: 'member' } },
        { context },
      ),
    ).rejects.toBeDefined();
    await expect(
      plain.identity.users.create(
        { body: { email: emailOf('bad-role'), name: 'Bad', role: 'owner' as unknown as 'member' } },
        { context },
      ),
    ).rejects.toBeDefined();

    // Disabling cancels the invitations to the user (user_disabled) and by the user (inviter_disabled).
    await insertInvitation(tenant.organizationId, member.email, tenant.userId);
    await insertInvitation(tenant.organizationId, emailOf('by-member'), member.userId);
    await plain.identity.users.setStatus(
      { params: { user: member.email }, body: { status: 'Disabled' } },
      { context },
    );
    await plain.identity.users.setStatus(
      { params: { user: member.email }, body: { status: 'Active' } },
      { context },
    );
    await expect(
      plain.identity.users.setStatus(
        { params: { user: member.email }, body: { status: 'Bogus' } },
        { context },
      ),
    ).rejects.toBeDefined();
    // A user cannot disable themselves.
    await expect(
      plain.identity.users.setStatus(
        { params: { user: tenant.email }, body: { status: 'Disabled' } },
        { context },
      ),
    ).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });

    // Link, a repeated link (sub_already_linked), a link to the owner, and unlink.
    const subject = `idsmoke-link-${randomUUID()}`;
    await plain.identity.users.linkSsoAccount(
      { params: { user: member.email }, body: { subject } },
      { context },
    );
    await expect(
      plain.identity.users.linkSsoAccount(
        { params: { user: member.email }, body: { subject } },
        { context },
      ),
    ).rejects.toBeDefined();
    await expect(
      plain.identity.users.linkSsoAccount(
        { params: { user: tenant.email }, body: { subject: `idsmoke-owner-${randomUUID()}` } },
        { context },
      ),
    ).rejects.toBeDefined();
    await plain.identity.users.unlinkSsoAccount({ params: { user: member.email } }, { context });
  }, 180_000);

  it('service accounts and credentials: create, status, delete, list, rotate, revoke and an incomplete rotation', async () => {
    const tenant = await newTenant('Credentials');
    const context = adminContext(tenant);
    const plain = routerWith(gateWith());

    const identifier = `svc-smoke-${randomUUID().slice(0, 8)}`;
    await plain.identity.serviceAccounts.create({ body: { identifier } }, { context });
    await plain.identity.users.setStatus(
      { params: { user: identifier }, body: { status: 'Disabled' } },
      { context },
    );
    await plain.identity.users.setStatus(
      { params: { user: identifier }, body: { status: 'Active' } },
      { context },
    );
    await expect(
      plain.identity.serviceAccounts.create(
        { body: { identifier: 'not a service account' } },
        { context },
      ),
    ).rejects.toBeDefined();
    await expect(
      plain.identity.serviceAccounts.create({ body: { identifier } }, { context }),
    ).rejects.toBeDefined();
    await plain.identity.serviceAccounts.delete({ params: { user: identifier } }, { context });
    await expect(
      plain.identity.serviceAccounts.delete(
        { params: { user: `svc-gone-${randomUUID().slice(0, 8)}` } },
        { context },
      ),
    ).rejects.toBeDefined();

    const integration = await plain.identity.credentials.create(
      { body: { name: 'Smoke integration', kind: 'integration' } },
      { context },
    );
    const agent = await plain.identity.credentials.create(
      { body: { name: 'Smoke agent', kind: 'agent' } },
      { context },
    );
    await expect(
      plain.identity.credentials.create(
        { body: { name: 'Smoke bogus', kind: 'bogus' as unknown as 'agent' } },
        { context },
      ),
    ).rejects.toBeDefined();
    await plain.identity.credentials.list({ query: {} }, { context });
    await plain.identity.credentials.rotate(
      { params: { credential: integration.id } },
      { context },
    );
    await plain.identity.credentials.revoke({ params: { credential: agent.id } }, { context });
    await expect(
      plain.identity.credentials.revoke(
        { params: { credential: `unknown-${randomUUID()}` } },
        { context },
      ),
    ).rejects.toBeDefined();
    await expect(
      plain.identity.credentials.rotate(
        { params: { credential: `unknown-${randomUUID()}` } },
        { context },
      ),
    ).rejects.toBeDefined();

    // An unexpected failure: the rotation cannot retire the old key nor revoke the new one.
    const stuck = await plain.identity.credentials.create(
      { body: { name: 'Smoke stuck', kind: 'integration' } },
      { context },
    );
    identityRevokeSeam.failTenants.add(tenant.organizationId);
    try {
      await expect(
        plain.identity.credentials.rotate({ params: { credential: stuck.id } }, { context }),
      ).rejects.toBeDefined();
    } finally {
      identityRevokeSeam.failTenants.delete(tenant.organizationId);
    }
  }, 180_000);

  it('accept route over HTTP: a new account, an admin, an existing account with a shed, and every driveable denial', async () => {
    const tenant = await newTenant('Accept');
    const plain = routerWith(gateWith());

    // A new person accepts, then replays (already_accepted).
    const bob = await invite(plain, tenant, emailOf('bob'));
    const accepted = await acceptHttp({
      invitationId: bob.invitationId,
      token: bob.token,
      password: IDENTITY_ACCEPT_PASSWORD,
    });
    expect(accepted.statusCode, accepted.body).toBeLessThan(300);
    const replay = await acceptHttp({
      invitationId: bob.invitationId,
      token: bob.token,
      password: IDENTITY_ACCEPT_PASSWORD,
    });
    expect(replay.statusCode).toBe(404);

    // An admin accepts: the notice goes to the other administrators.
    const dave = await invite(plain, tenant, emailOf('dave'), 'admin');
    const adminAccepted = await acceptHttp({
      invitationId: dave.invitationId,
      token: dave.token,
      password: IDENTITY_ACCEPT_PASSWORD,
    });
    expect(adminAccepted.statusCode, adminAccepted.body).toBeLessThan(300);

    // Denials of the uniform rejection.
    expect((await acceptHttp({})).statusCode).toBeGreaterThanOrEqual(400); // malformed_request
    const unknown = await acceptHttp({
      invitationId: `unknown-${randomUUID()}`,
      token: 'a'.repeat(32),
    });
    expect(unknown.statusCode).toBe(404); // not_found
    const eve = await invite(plain, tenant, emailOf('eve'));
    const wrongToken = await acceptHttp({
      invitationId: eve.invitationId,
      token: 'b'.repeat(eve.token.length),
      password: IDENTITY_ACCEPT_PASSWORD,
    });
    expect(wrongToken.statusCode).toBe(404); // token_mismatch
    const cancelled = await invite(plain, tenant, emailOf('cancelled'));
    await plain.identity.users.cancelInvitation(
      { params: { invitation: cancelled.invitationId } },
      { context: adminContext(tenant) },
    );
    expect(
      (
        await acceptHttp({
          invitationId: cancelled.invitationId,
          token: cancelled.token,
          password: IDENTITY_ACCEPT_PASSWORD,
        })
      ).statusCode,
    ).toBe(404); // cancelled
    const expired = await invite(plain, tenant, emailOf('expired'));
    await pools.authPool.query(
      "update auth.invitation set expires_at = now() - interval '1 hour' where id = $1",
      [expired.invitationId],
    );
    expect(
      (
        await acceptHttp({
          invitationId: expired.invitationId,
          token: expired.token,
          password: IDENTITY_ACCEPT_PASSWORD,
        })
      ).statusCode,
    ).toBe(404); // expired
    const rejected = await invite(plain, tenant, emailOf('rejected'));
    await pools.authPool.query("update auth.invitation set status = 'rejected' where id = $1", [
      rejected.invitationId,
    ]);
    expect(
      (
        await acceptHttp({
          invitationId: rejected.invitationId,
          token: rejected.token,
          password: IDENTITY_ACCEPT_PASSWORD,
        })
      ).statusCode,
    ).toBe(404); // rejected
    const banned = await newTenant('Accept Banned Inviter');
    const orphaned = await invite(plain, banned, emailOf('orphaned'));
    await pools.authPool.query('update auth."user" set banned = true where id = $1', [
      banned.userId,
    ]);
    expect(
      (
        await acceptHttp({
          invitationId: orphaned.invitationId,
          token: orphaned.token,
          password: IDENTITY_ACCEPT_PASSWORD,
        })
      ).statusCode,
    ).toBe(404); // inviter_not_active_admin

    // Existing accounts: no session, another account's session, no CSRF header, a foreign origin
    // and no Origin header are all refused with the same 404.
    const carol = await existingAccount();
    const pending = await invite(plain, tenant, carol.email);
    const body = { invitationId: pending.invitationId, token: pending.token };
    const other = await existingAccount();
    for (const response of [
      await acceptHttp(body), // session_required
      await acceptHttp(body, { cookie: other.cookie }), // email_mismatch
      await acceptHttp(body, { cookie: carol.cookie, omit: 'x-csrf-token' }), // csrf_rejected
      await acceptHttp(body, { cookie: carol.cookie, origin: 'https://evil.example' }), // origin_rejected
      await acceptHttp(body, { cookie: carol.cookie, omit: 'origin' }), // origin_rejected
    ]) {
      expect(response.statusCode, response.body).toBe(404);
    }

    // An existing account accepts with its session, and a link made by an admin is shed.
    const other_tenant = await newTenant('Accept Other');
    const linked = await linkedExistingAccount(other_tenant);
    const joining = await invite(plain, tenant, linked.email);
    const joined = await acceptHttp(
      { invitationId: joining.invitationId, token: joining.token },
      { cookie: linked.cookie },
    );
    expect(joined.statusCode, joined.body).toBeLessThan(300);

    // The membership hook sheds the link of a user who joins a second tenant.
    const hooked = await linkedExistingAccount(other_tenant);
    await (app.auth.api as MemberAdminApi).addMember({
      body: { userId: hooked.userId, organizationId: tenant.organizationId, role: 'member' },
    });
  }, 240_000);

  it('accept flow seams: consume_conflict, disabled_user, a failing notice, a failing compensation and a failing session revocation', async () => {
    const tenant = await newTenant('Flow');
    const plain = routerWith(gateWith());

    // A lost consume race.
    const racing = await invite(plain, tenant, emailOf('racing'));
    await expect(
      flowWith({
        onStep: async (step) => {
          if (step === 'consume') {
            await pools.authPool.query('delete from auth.verification where identifier = $1', [
              `invitation-accept:${racing.invitationId}`,
            ]);
          }
        },
      }).accept({
        invitationId: racing.invitationId,
        token: racing.token,
        password: IDENTITY_ACCEPT_PASSWORD,
      }),
    ).rejects.toBeDefined();

    // A disabled `_user`.
    const disabled = await invite(plain, tenant, emailOf('disabled'));
    await expect(
      flowWith({
        userSync: { ...adapter, readStatus: () => Promise.resolve('Disabled' as const) },
      }).accept({
        invitationId: disabled.invitationId,
        token: disabled.token,
        password: IDENTITY_ACCEPT_PASSWORD,
      }),
    ).rejects.toBeDefined();

    // A notice dispatcher that fails never blocks an admin acceptance.
    const broken: NoticeDispatcher = { send: () => Promise.reject(new Error('dispatcher down')) };
    const admin = await invite(plain, tenant, emailOf('notice'), 'admin');
    const noticed = await flowWith({ notices: broken }).accept({
      invitationId: admin.invitationId,
      token: admin.token,
      password: IDENTITY_ACCEPT_PASSWORD,
    });
    expect(noticed.userId).toBeTruthy();

    // A failing write whose compensation fails too.
    const doomed = await invite(plain, tenant, emailOf('doomed'));
    await expect(
      flowWith({
        userSync: {
          ...adapter,
          writeUserChange: () => Promise.reject(new Error('injected user write failure')),
        },
        authRepository: {
          ...repository,
          deleteMember: () => Promise.reject(new Error('injected member delete failure')),
        },
      }).accept({
        invitationId: doomed.invitationId,
        token: doomed.token,
        password: IDENTITY_ACCEPT_PASSWORD,
      }),
    ).rejects.toBeDefined();

    // A session revocation that fails after a shed does not stop the acceptance.
    const other = await newTenant('Flow Other');
    const linked = await linkedExistingAccount(other);
    const joining = await invite(plain, tenant, linked.email);
    const sessionId = await sessionIdOf(linked.cookie);
    const joinedFlow = await flowWith({
      ssoLinkShed: {
        ...shed,
        revokeSession: () => Promise.reject(new Error('injected revoke failure')),
      },
    }).accept({
      invitationId: joining.invitationId,
      token: joining.token,
      session: { userId: linked.userId, sessionId },
    });
    expect(joinedFlow.userId).toBe(linked.userId);
  }, 240_000);

  it('email: the recipient allowlist, the tenant gate and the notice dispatcher suppress and truncate', async () => {
    const templates: readonly EmailTemplate[] = [
      { kind: 'InvitationEmail', link: `${IDENTITY_ORIGIN}/#id=x&token=y`, expiryText: '48 hours' },
      { kind: 'AdminAcceptedNotice' },
    ];
    const allowlisted = createAllowlistEmailSender(createRecordingEmailSender(), ['allowed.test']);
    for (const template of templates) {
      await expect(allowlisted.send(`someone@blocked.test`, template)).rejects.toBeDefined();
    }

    const tenantId = `idsmoke-notice-${randomUUID()}`;
    const recipients = Array.from({ length: 21 }, (_, index) => ({
      email: `notice-${String(index)}-${randomUUID()}@example.test`,
      memberSince: new Date(Date.UTC(2020, 0, 1 + index)),
    }));
    const noticeSender = createRecordingEmailSender();
    const limit = (scope: string) => ({
      consume: (candidate: string) =>
        candidate === scope ? Promise.reject(new AuthRateLimitedError(60)) : Promise.resolve(),
    });
    const dispatch = (
      dispatcherOptions: Partial<Parameters<typeof createNoticeDispatcher>[0]>,
    ): Promise<void> =>
      createNoticeDispatcher({
        disabledTenantIds: [],
        capStore: limit('none'),
        sender: noticeSender,
        recipientKeySecret: IDENTITY_SECRET,
        ...dispatcherOptions,
      }).send({ tenantId, template: { kind: 'AdminAcceptedNotice' }, recipients });
    await dispatch({ disabledTenantIds: [tenantId] }); // email_tenant_blocked
    await dispatch({ killSwitch: true }); // truncated and global
    await dispatch({ capStore: limit('notice_tenant') }); // tenant
    await dispatch({ capStore: limit('notice_recipient') }); // recipient
  }, 60_000);

  it('reconcile (private scratch database) and the bootstrap CLI', async () => {
    const name = `tayzu_api_smoke_reconcile_${randomUUID().replaceAll('-', '')}`;
    const adminPool = new Pool({ connectionString: ownerDatabaseUrl(), max: 1 });
    await adminPool.query(`create database ${name}`);
    const ownerScratch = new Pool({ connectionString: databaseUrlFor(name) });
    const scratchApp = identityPoolAs(databaseUrlFor(name), 'tayzu_app');
    const scratchAuthPool = identityPoolAs(databaseUrlFor(name), 'tayzu_auth');
    try {
      await runMigrations(ownerScratch);
      // No `userSync`: a membership added here writes no `_user` row, which the reconcile repairs.
      const scratchAuth = createAuth({
        db: drizzle(scratchAuthPool, { schema: authSchema }),
        secret: TEST_SECRET,
      });
      const api = scratchAuth.api as ScratchAuthApi;
      const owner = await createAdminUser(scratchAuth, {
        name: 'Reconcile Owner',
        email: emailOf('reconcile-owner'),
        password: TEST_PASSWORD,
      });
      const org = await api.createOrganization({
        body: { name: 'Reconcile Org', slug: `reconcile-${randomUUID()}`, userId: owner.userId },
      });
      const bannedMember = await createAdminUser(scratchAuth, {
        name: 'Reconcile Banned',
        email: emailOf('reconcile-banned'),
        password: TEST_PASSWORD,
      });
      await api.addMember({
        body: { userId: bannedMember.userId, organizationId: org.id, role: 'member' },
      });
      await scratchAuthPool.query('update auth."user" set banned = true where id = $1', [
        bannedMember.userId,
      ]);
      // A user of two tenants with an unmarked link: the reconcile sheds it before it creates the row.
      const second = await api.createOrganization({
        body: { name: 'Reconcile Second', slug: `reconcile-${randomUUID()}`, userId: owner.userId },
      });
      const sharing = await createAdminUser(scratchAuth, {
        name: 'Reconcile Sharing',
        email: emailOf('reconcile-sharing'),
        password: TEST_PASSWORD,
      });
      await api.addMember({
        body: { userId: sharing.userId, organizationId: org.id, role: 'member' },
      });
      await api.addMember({
        body: { userId: sharing.userId, organizationId: second.id, role: 'member' },
      });
      await scratchAuthPool.query(
        `insert into auth.account (id, account_id, provider_id, user_id, created_at, updated_at)
         values ($1, $2, $3, $4, now(), now())`,
        [randomUUID(), `idsmoke-sub-${randomUUID()}`, PROVIDER_ID, sharing.userId],
      );

      await reconcileUsersMain({
        env: {
          NODE_ENV: 'test',
          DATABASE_URL: databaseUrlFor(name),
          AUTH_DATABASE_URL: databaseUrlFor(name),
          CERBOS_ADDRESS: IDENTITY_CERBOS,
          TAYZU_OPERATOR_ID: IDENTITY_OPERATOR_ID,
        },
        appPool: scratchApp,
        authPool: scratchAuthPool,
      });
    } finally {
      await endQuietly(scratchApp);
      await endQuietly(scratchAuthPool);
      await endQuietly(ownerScratch);
      await adminPool.query(`drop database if exists ${name} with (force)`);
      await endQuietly(adminPool);
    }

    // The bootstrap CLI reads no other tenant: the shared database with a fresh slug and email.
    const bootstrapApp = identityPoolAs(ownerDatabaseUrl(), 'tayzu_app');
    const bootstrapAuth = identityPoolAs(ownerDatabaseUrl(), 'tayzu_auth');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await bootstrapAdminMain({
        env: {
          NODE_ENV: 'test',
          DATABASE_URL: ownerDatabaseUrl(),
          AUTH_DATABASE_URL: ownerDatabaseUrl(),
          BETTER_AUTH_SECRETS: `1:${TEST_SECRET}`,
          CERBOS_ADDRESS: IDENTITY_CERBOS,
          ALLOWED_ORIGINS: AUTH_ORIGIN,
          BOOTSTRAP_ORGANIZATION_NAME: 'Identity Smoke Bootstrap',
          BOOTSTRAP_ORGANIZATION_SLUG: `idsmoke-bootstrap-${randomUUID()}`,
          BOOTSTRAP_ADMIN_NAME: 'Identity Smoke Bootstrap Admin',
          BOOTSTRAP_ADMIN_EMAIL: emailOf('bootstrap'),
          TAYZU_OPERATOR_ID: IDENTITY_OPERATOR_ID,
        },
        appPool: bootstrapApp,
        authPool: bootstrapAuth,
      });
    } finally {
      log.mockRestore();
      await endQuietly(bootstrapApp);
      await endQuietly(bootstrapAuth);
    }
  }, 240_000);

  it('principals: the ban hook, a banned principal on /v1 and a failing provenance marker', async () => {
    // The ban hook: a banned user's `_user` is disabled with no principal.
    const tenant = await newTenant('Ban Hook');
    const target = await createAdminUser(app.auth, {
      name: 'Ban Hook Target',
      email: emailOf('ban-hook'),
      password: TEST_PASSWORD,
    });
    await (app.auth.api as MemberAdminApi).addMember({
      body: { userId: target.userId, organizationId: tenant.organizationId, role: 'member' },
    });
    const context = (await app.auth.$context) as InternalAdapterApi;
    await context.internalAdapter.updateUser(target.userId, { banned: true });

    // A banned principal with a live session is refused on /v1 (principal_rejected).
    const rejected = await newTenant('Principal Rejected');
    await pools.authPool.query('update auth."user" set banned = true where id = $1', [
      rejected.userId,
    ]);
    const refused = await app.app.inject({
      method: 'GET',
      url: '/v1/blueprints',
      headers: { cookie: rejected.cookie, origin: IDENTITY_ORIGIN },
    });
    expect(refused.statusCode).toBeGreaterThanOrEqual(400);

    // A provenance marker that cannot be written fails the link closed (sso_link_marker_failed).
    const linker = await newTenant('Marker');
    const failing = createAuth({
      db: drizzle(
        poolFailing(
          pools.authPool,
          (text, values) =>
            /insert\s+into\s+"auth"\."verification"/i.test(text) &&
            values.some((value) => typeof value === 'string' && value.startsWith('sso-link:')),
        ),
        { schema: authSchema },
      ),
      secret: TEST_SECRET,
      baseURL: AUTH_ORIGIN,
      trustedOrigins: [AUTH_ORIGIN],
      sso,
    });
    stub.setSubject({
      sub: `idsmoke-marker-${randomUUID()}`,
      email: linker.email,
      name: 'Smoke Marker',
      sid: `sid-${randomUUID()}`,
      claims: { email_verified: true },
    });
    const trip = await oidcRoundTrip(handlerOf(failing), '/link-social', linker.cookie);
    expect(trip.response.status, 'the callback fails').toBeGreaterThanOrEqual(400);
  }, 180_000);

  // Task 15.2b (Resolved decisions Q143, Q144, Q145). Every identity data point carries the
  // tenant, which is unique per test, so the points below are exactly what each test caused.
  // The harness collects with delta temporality: the values of the points of one tenant add up.
  async function tenantPoints(
    metric: string,
    tenantId: string,
  ): Promise<Readonly<Record<string, unknown>>[]> {
    const harness = registeredHarness();
    await harness.forceFlush();
    const points: Readonly<Record<string, unknown>>[] = [];
    for (const resourceMetrics of harness.metricExporter.getMetrics()) {
      for (const scopeMetrics of resourceMetrics.scopeMetrics) {
        for (const candidate of scopeMetrics.metrics) {
          if (candidate.descriptor.name !== metric) continue;
          for (const point of candidate.dataPoints) {
            if (point.attributes['tayzu.tenant.id'] !== tenantId) continue;
            const value = typeof point.value === 'number' ? point.value : Number.NaN;
            points.push({ ...point.attributes, value });
          }
        }
      }
    }
    return points;
  }

  const total = (points: readonly Readonly<Record<string, unknown>>[]): number =>
    points.reduce((sum, point) => sum + (point['value'] as number), 0);

  it('invitation metric (Q143): an expired invitation’s acceptance records one expired data point and no rejected one', async () => {
    const tenant = await newTenant('Expired Metric');
    const plain = routerWith(gateWith());
    const expired = await invite(plain, tenant, emailOf('expired-metric'));
    await pools.authPool.query(
      "update auth.invitation set expires_at = now() - interval '1 hour' where id = $1",
      [expired.invitationId],
    );

    const response = await acceptHttp({
      invitationId: expired.invitationId,
      token: expired.token,
      password: IDENTITY_ACCEPT_PASSWORD,
    });
    expect(response.statusCode).toBe(404);

    const mutations = (await tenantPoints('tayzu.identity.invitations', tenant.organizationId)).map(
      (point) => ({
        mutation: point['tayzu.identity.invitation.mutation'],
        value: point['value'],
      }),
    );
    expect(mutations.filter((point) => point.mutation === 'expired')).toEqual([
      { mutation: 'expired', value: 1 },
    ]);
    expect(mutations.some((point) => point.mutation === 'rejected')).toBe(false);
  }, 120_000);

  it('status-change metric (Q144): a setStatus by an admin carries tayzu.actor.type user', async () => {
    const tenant = await newTenant('Status Actor');
    const plain = routerWith(gateWith());
    const member = await plain.identity.users.create(
      { body: { email: emailOf('status-actor'), name: 'Status Actor', role: 'member' } },
      { context: adminContext(tenant) },
    );
    await plain.identity.users.setStatus(
      { params: { user: member.email }, body: { status: 'Disabled' } },
      { context: adminContext(tenant) },
    );

    const disabled = (
      await tenantPoints('tayzu.identity.user_status_changes', tenant.organizationId)
    ).filter((point) => point['tayzu.identity.user.status.to'] === 'Disabled');
    expect(disabled.length).toBeGreaterThan(0);
    expect(new Set(disabled.map((point) => point['tayzu.actor.type']))).toEqual(new Set(['user']));
    expect(total(disabled)).toBe(1);
  }, 120_000);

  it('status-change metric (Q144): the ban hook’s status change carries tayzu.actor.type system', async () => {
    const tenant = await newTenant('Ban Actor');
    const target = await createAdminUser(app.auth, {
      name: 'Ban Actor Target',
      email: emailOf('ban-actor'),
      password: TEST_PASSWORD,
    });
    await (app.auth.api as MemberAdminApi).addMember({
      body: { userId: target.userId, organizationId: tenant.organizationId, role: 'member' },
    });
    // The hook runs on Better Auth's `banUser`, which needs an authenticated platform admin.
    const platformEmail = emailOf('ban-platform-admin');
    const platformApi = app.auth.api as {
      createUser(args: {
        body: { name: string; email: string; password: string; role: string };
      }): Promise<unknown>;
      banUser(args: { body: { userId: string }; headers: Headers }): Promise<unknown>;
    };
    await platformApi.createUser({
      body: {
        name: 'Ban Platform Admin',
        email: platformEmail,
        password: TEST_PASSWORD,
        role: 'admin',
      },
    });
    const platformSession = await signInAdminUser(app.auth, {
      email: platformEmail,
      password: TEST_PASSWORD,
      ip: randomIp(),
    });
    await platformApi.banUser({
      body: { userId: target.userId },
      headers: new Headers({ cookie: platformSession.cookie }),
    });

    await vi.waitFor(
      async () => {
        const disabled = (
          await tenantPoints('tayzu.identity.user_status_changes', tenant.organizationId)
        ).filter((point) => point['tayzu.identity.user.status.to'] === 'Disabled');
        expect(disabled.length).toBeGreaterThan(0);
        expect(new Set(disabled.map((point) => point['tayzu.actor.type']))).toEqual(
          new Set(['system']),
        );
      },
      { timeout: 10_000, interval: 250 },
    );
  }, 120_000);

  it('status-change metric (Q144): a reconcile’s status changes carry tayzu.actor.type system (private scratch database)', async () => {
    const name = `tayzu_api_smoke_actor_${randomUUID().replaceAll('-', '')}`;
    const adminPool = new Pool({ connectionString: ownerDatabaseUrl(), max: 1 });
    await adminPool.query(`create database ${name}`);
    const ownerScratch = new Pool({ connectionString: databaseUrlFor(name) });
    const scratchApp = identityPoolAs(databaseUrlFor(name), 'tayzu_app');
    const scratchAuthPool = identityPoolAs(databaseUrlFor(name), 'tayzu_auth');
    try {
      await runMigrations(ownerScratch);
      // No `userSync`: the memberships below write no `_user` row, which the reconcile repairs.
      const scratchAuth = createAuth({
        db: drizzle(scratchAuthPool, { schema: authSchema }),
        secret: TEST_SECRET,
      });
      const api = scratchAuth.api as ScratchAuthApi;
      const owner = await createAdminUser(scratchAuth, {
        name: 'Actor Owner',
        email: emailOf('actor-owner'),
        password: TEST_PASSWORD,
      });
      const org = await api.createOrganization({
        body: { name: 'Actor Org', slug: `actor-${randomUUID()}`, userId: owner.userId },
      });
      const member = await createAdminUser(scratchAuth, {
        name: 'Actor Member',
        email: emailOf('actor-member'),
        password: TEST_PASSWORD,
      });
      await api.addMember({
        body: { userId: member.userId, organizationId: org.id, role: 'member' },
      });

      await reconcileUsersMain({
        env: {
          NODE_ENV: 'test',
          DATABASE_URL: databaseUrlFor(name),
          AUTH_DATABASE_URL: databaseUrlFor(name),
          CERBOS_ADDRESS: IDENTITY_CERBOS,
          TAYZU_OPERATOR_ID: IDENTITY_OPERATOR_ID,
        },
        appPool: scratchApp,
        authPool: scratchAuthPool,
      });

      const points = await tenantPoints('tayzu.identity.user_status_changes', org.id);
      expect(points.length).toBeGreaterThan(0);
      expect(new Set(points.map((point) => point['tayzu.actor.type']))).toEqual(
        new Set(['system']),
      );
    } finally {
      await endQuietly(scratchApp);
      await endQuietly(scratchAuthPool);
      await endQuietly(ownerScratch);
      await adminPool.query(`drop database if exists ${name} with (force)`);
      await endQuietly(adminPool);
    }
  }, 240_000);

  it('credential metric (Q145): a service account’s creation, key rotation and key revocation each record kind service_account', async () => {
    const tenant = await newTenant('Service Credential Kind');
    const context = adminContext(tenant);
    const plain = routerWith(gateWith());

    const rotating = await plain.identity.serviceAccounts.create(
      { body: { identifier: `svc-kind-${randomUUID().slice(0, 8)}` } },
      { context },
    );
    const revoking = await plain.identity.serviceAccounts.create(
      { body: { identifier: `svc-kind-${randomUUID().slice(0, 8)}` } },
      { context },
    );
    await plain.identity.credentials.rotate(
      { params: { credential: rotating.clientId } },
      { context },
    );
    await plain.identity.credentials.revoke(
      { params: { credential: revoking.clientId } },
      { context },
    );

    const points = (
      await tenantPoints('tayzu.identity.credential_mutations', tenant.organizationId)
    )
      .filter((point) => point['tayzu.identity.credential.kind'] === 'service_account')
      .map((point) => ({
        mutation: point['tayzu.identity.credential.mutation'],
        value: point['value'],
      }));
    const countOf = (mutation: string): number =>
      points
        .filter((point) => point.mutation === mutation)
        .reduce((sum, point) => sum + (point.value as number), 0);
    expect(countOf('created')).toBe(2);
    expect(countOf('rotated')).toBe(1);
    expect(countOf('revoked')).toBe(1);

    // No service account key is counted under another kind.
    const others = (
      await tenantPoints('tayzu.identity.credential_mutations', tenant.organizationId)
    ).filter((point) => point['tayzu.identity.credential.kind'] !== 'service_account');
    expect(others).toEqual([]);
  }, 180_000);

  it('credential metric (Q145, Q149): a key that credentials.create binds to a service account counts as created of kind service_account', async () => {
    const tenant = await newTenant('Bound Credential Kind');
    const context = adminContext(tenant);
    const plain = routerWith(gateWith());

    const identifier = `svc-bound-${randomUUID().slice(0, 8)}`;
    const account = await plain.identity.serviceAccounts.create(
      { body: { identifier } },
      { context },
    );
    // One active key per service account (Q40): retire the creation key so the bound create is accepted.
    await plain.identity.credentials.revoke(
      { params: { credential: account.clientId } },
      { context },
    );
    const bound = await plain.identity.credentials.create(
      { body: { name: 'Bound key', kind: 'integration', userId: identifier } },
      { context },
    );
    expect(bound.id).toBeTruthy();

    const created = (
      await tenantPoints('tayzu.identity.credential_mutations', tenant.organizationId)
    )
      .filter((point) => point['tayzu.identity.credential.mutation'] === 'created')
      .map((point) => ({
        kind: point['tayzu.identity.credential.kind'],
        value: point['value'] as number,
      }));
    const countOf = (kind: string): number =>
      created.filter((point) => point.kind === kind).reduce((sum, point) => sum + point.value, 0);
    // The service account's own creation key and the bound key, both of kind service_account.
    expect(countOf('service_account')).toBe(2);
    expect(countOf('integration')).toBe(0);
    expect(countOf('agent')).toBe(0);
  }, 180_000);
});

/**
 * `otel-smoke-check`, 044 extension (task 12.3, openspec/changes/archive/2026-11-16-044-password-reset-and-account-recovery;
 * design D15 "Enforcement": "`otel-smoke-check` is extended to drive every operation once with each
 * denial reason under an in-memory exporter and to assert every declared name is observed and none
 * undeclared").
 *
 * This describe only drives the 044 operations, so that the 043 iteration below (spans, metrics, log
 * events with their declared attributes and forms) observes every 044 name. Operations driven:
 *
 * - the request route for an eligible address (a token is issued and a `PasswordResetEmail` sent)
 *   and for an unknown address (ineligible);
 * - a suppressed reset email (a second server with the kill switch on, for an eligible address);
 * - the confirm route: a refusal for an unknown id, a refusal for a wrong token of a real id, a
 *   weak-password refusal that spares the token, and the completion with the same token (which sends
 *   the `PasswordChangedNotice`);
 * - the MFA reset service: the admin form allowed, the admin form refused for a self-target, and the
 *   operator form.
 *
 * ## Production symbols expected
 *
 * - `createMfaResetService({ authPool, notices })` (`./identity/mfa-reset.js`, existing) with
 *   `resetAdmin` and `resetOperator`.
 * - `createResetTokenStore({ authPool, withUserLock }).issue(userId)` (`./identity/reset-token-store.js`).
 * - `CreateAppOptions.email.passwordResetLinkBaseUrl`, `passwordResetMinResponseMs` and
 *   `passwordResetGlobalCap` (`./server.js`).
 * - The 044 spans, metrics and log events of `identity-contract.ts`, emitted by those operations.
 */
const RESET_REQUEST_PATH = '/v1/auth/password-reset/request';
const RESET_CONFIRM_PATH = '/v1/auth/password-reset/confirm';
const RESET_HMAC_SECRET = 'smoke-044-test-only-secret-0123456789-abcdef';
const RESET_NEW_PASSWORD = 'Another-Perfectly-Fine-Passphrase-77!';

describe('otel-smoke-check, 044: every password-reset and MFA-reset operation is driven (task 12.3)', () => {
  let open: App;
  let killed: App;
  let pools: HarnessPools;
  let harness: TelemetryTestHarness;
  const openSender = createRecordingEmailSender();
  const killedSender = createRecordingEmailSender();

  function emailOptions(
    sender: ReturnType<typeof createRecordingEmailSender>,
    killSwitch: boolean,
  ) {
    return {
      sender,
      invitationLinkBaseUrl: IDENTITY_ORIGIN,
      passwordResetLinkBaseUrl: IDENTITY_ORIGIN,
      passwordResetMinResponseMs: 0,
      disabledTenantIds: [] as string[],
      killSwitch,
      recipientKeySecret: RESET_HMAC_SECRET,
      tenantCap: { max: 100_000, windowSeconds: 3600 },
      recipientCap: { max: 100_000, windowSeconds: 86_400 },
      passwordResetRecipientCap: { max: 100_000, windowSeconds: 3600 },
      passwordResetIpCap: { max: 100_000, windowSeconds: 3600 },
      // The global bucket has one constant key shared by every test file: a roomy cap.
      passwordResetGlobalCap: { max: 1_000_000, windowSeconds: 3600 },
    };
  }

  function appWith(sender: ReturnType<typeof createRecordingEmailSender>, killSwitch: boolean) {
    const email = emailOptions(sender, killSwitch);
    return createApp({
      ...pools,
      authSecret: TEST_SECRET,
      cerbosAddress: IDENTITY_CERBOS,
      allowedOrigins: [IDENTITY_ORIGIN],
      mountIdentityRoutes: true,
      identityTokenHmacSecret: RESET_HMAC_SECRET,
      ...{ email },
    });
  }

  beforeAll(async () => {
    harness = registeredHarness();
    pools = await harnessPools();
    await runMigrations(pools.authPool);
    open = await appWith(openSender, false);
    killed = await appWith(killedSender, true);
    // The breached-password range service reports nothing as breached.
    vi.stubGlobal('fetch', (): Promise<Response> => {
      return Promise.resolve(
        new Response('0000000000000000000000000000000000A:3\r\n', { status: 200 }),
      );
    });
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await open.close();
    await killed.close();
  }, 60_000);

  async function account(
    label: string,
  ): Promise<{ email: string; userId: string; tenantId: string }> {
    const id = randomUUID();
    const email = `s044-${label}-${id}@example.test`;
    const tenant = await bootstrapTestTenant(open.auth, {
      pool: testAppPool(),
      name: `Smoke 044 ${label}`,
      email,
      password: TEST_PASSWORD,
      organizationName: `Smoke 044 ${id}`,
      organizationSlug: `s044-${id}`,
      ip: randomIp(),
    });
    return { email, userId: tenant.userId, tenantId: tenant.organizationId };
  }

  async function postTo(
    app: App,
    url: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }> {
    const response = await app.app.inject({
      method: 'POST',
      url,
      headers: {
        'content-type': 'application/json',
        origin: IDENTITY_ORIGIN,
        'x-csrf-token': 'orpc',
        'x-forwarded-for': randomIp(),
      },
      payload: JSON.stringify(body),
    });
    return { status: response.statusCode, body: response.json() };
  }

  function sentTo(sender: ReturnType<typeof createRecordingEmailSender>, email: string): number {
    return sender.sent.filter((message) => message.to === email).length;
  }

  it('the request route: an eligible address is issued a link and an unknown address is ineligible', async () => {
    const known = await account('request');
    const eligible = await postTo(open, RESET_REQUEST_PATH, { email: known.email });
    const unknown = await postTo(open, RESET_REQUEST_PATH, {
      email: `s044-ghost-${randomUUID()}@example.test`,
    });
    expect(eligible.status).toBe(200);
    expect(unknown.status).toBe(200);
    await vi.waitFor(() => {
      expect(sentTo(openSender, known.email)).toBe(1);
    });
  }, 60_000);

  it('a suppressed reset email: the kill switch is on for an eligible address', async () => {
    const known = await account('suppressed');
    const answer = await postTo(killed, RESET_REQUEST_PATH, { email: known.email });
    expect(answer.status).toBe(200);
    await vi.waitFor(() => {
      const suppressed = logRecords(harness, 'catalog.security.recovery_email_suppressed');
      expect(
        suppressed.some((record) => record.attributes['tayzu.identity.user.id'] === known.userId),
      ).toBe(true);
    });
    expect(sentTo(killedSender, known.email)).toBe(0);
  }, 60_000);

  it('the confirm route: refusals (unknown id, wrong token, weak password) and a completion', async () => {
    const known = await account('confirm');
    const store = createResetTokenStore({
      authPool: pools.authPool,
      withUserLock: createWithUserLock(pools.authPool),
    });
    const issued = await store.issue(known.userId);

    const unknownId = await postTo(open, RESET_CONFIRM_PATH, {
      id: randomBytes(16).toString('base64url'),
      token: randomBytes(32).toString('base64url'),
      newPassword: RESET_NEW_PASSWORD,
    });
    expect(unknownId.status).toBe(404);
    const wrongToken = await postTo(open, RESET_CONFIRM_PATH, {
      id: issued.id,
      token: randomBytes(32).toString('base64url'),
      newPassword: RESET_NEW_PASSWORD,
    });
    expect(wrongToken.status).toBe(404);
    const weak = await postTo(open, RESET_CONFIRM_PATH, {
      id: issued.id,
      token: issued.token,
      newPassword: 'short',
    });
    expect(weak.status).toBeGreaterThanOrEqual(400);
    const completed = await postTo(open, RESET_CONFIRM_PATH, {
      id: issued.id,
      token: issued.token,
      newPassword: RESET_NEW_PASSWORD,
    });
    expect(completed.status).toBe(200);
    await vi.waitFor(() => {
      expect(sentTo(openSender, known.email)).toBeGreaterThanOrEqual(1);
    });
  }, 60_000);

  it('the MFA reset service: the admin form allowed and refused for a self-target, and the operator form', async () => {
    const authPool = pools.authPool;
    const notices = {
      send: (): Promise<'sent'> => Promise.resolve('sent'),
    };
    const service = createMfaResetService({ authPool, notices });

    const tenantId = `org-${randomUUID()}`;
    await authPool.query(
      'insert into auth.organization (id, name, slug, created_at) values ($1, $2, $3, now())',
      [tenantId, 'Org', `slug-${tenantId}`],
    );
    const seedMember = async (): Promise<string> => {
      const userId = `usr-${randomUUID()}`;
      await authPool.query(
        `insert into auth."user" (id, name, email, email_verified, created_at, updated_at, two_factor_enabled)
         values ($1, $2, $3, true, now(), now(), true)`,
        [userId, 'User', `s044-m-${randomUUID()}@example.test`],
      );
      await authPool.query(
        'insert into auth.member (id, organization_id, user_id, role, created_at) values ($1, $2, $3, $4, now())',
        [`mem-${randomUUID()}`, tenantId, userId, 'member'],
      );
      await authPool.query(
        `insert into auth.two_factor (id, secret, backup_codes, user_id, verified, failed_verification_count)
         values ($1, $2, $3, $4, true, 0)`,
        [`tf-${randomUUID()}`, `enc-secret-${randomUUID()}`, `enc-codes-${randomUUID()}`, userId],
      );
      await authPool.query(
        `insert into auth.session (id, expires_at, token, created_at, updated_at, user_id, active_organization_id)
         values ($1, now() + interval '1 day', $2, now(), now(), $3, $4)`,
        [`ses-${randomUUID()}`, `tok-${randomUUID()}`, userId, tenantId],
      );
      return userId;
    };

    const target = await seedMember();
    const allowed = await service.resetAdmin({
      tenantId,
      actorId: `adm-${randomUUID()}`,
      userId: target,
      reason: 'lost_both_factors',
    });
    expect(allowed.sessionsRevoked).toBe(1);

    const own = await seedMember();
    await expect(
      service.resetAdmin({
        tenantId,
        actorId: own,
        userId: own,
        reason: 'device_replaced',
      }),
    ).rejects.toBeDefined();

    const operatorTarget = await seedMember();
    const operated = await service.resetOperator({
      tenantId,
      operatorId: `gh:${randomInt(1_000_000, 9_999_999).toString(10)}`,
      approverId: `gh:${randomInt(1_000_000, 9_999_999).toString(10)}`,
      userId: operatorTarget,
    });
    expect(operated.sessionsRevoked).toBe(1);
  }, 60_000);
});

describe('otel-smoke-check, 044: every declared 044 name is observed once and no undeclared name appears (task 12.3)', () => {
  let harness: TelemetryTestHarness;

  /** The thirteen names design D15 adds (the spec side; the fixture and the module must agree). */
  const SPANS_044 = [
    'identity.password_reset.request',
    'identity.password_reset.confirm',
    'identity.mfa.reset',
  ];
  const METRICS_044 = [
    'tayzu.identity.password_reset_requests',
    'tayzu.identity.password_reset_confirms',
    'tayzu.identity.mfa_resets',
    'tayzu.identity.recovery_emails',
  ];
  const LOGS_044 = [
    'catalog.audit.password_reset_requested',
    'catalog.audit.password_reset_completed',
    'catalog.audit.mfa_reset',
    'catalog.security.password_reset_denied',
    'catalog.security.recovery_email_suppressed',
    'catalog.security.self_mfa_reset_denied',
  ];

  beforeAll(async () => {
    harness = registeredHarness();
    await harness.forceFlush();
  });

  function metricNames(): Set<string> {
    const names = new Set<string>();
    for (const resourceMetrics of harness.metricExporter.getMetrics()) {
      for (const scopeMetrics of resourceMetrics.scopeMetrics) {
        for (const metric of scopeMetrics.metrics) names.add(metric.descriptor.name);
      }
    }
    return names;
  }

  it.each([
    ...SPANS_044.map((name) => ['span', name] as const),
    ...METRICS_044.map((name) => ['metric', name] as const),
    ...LOGS_044.map((name) => ['log event', name] as const),
  ])('the %s %s is declared exactly once and observed', (kind, name) => {
    const declared =
      kind === 'span'
        ? identityContract.IDENTITY_SPANS
        : kind === 'metric'
          ? identityContract.IDENTITY_METRICS
          : identityContract.IDENTITY_LOG_EVENTS;
    expect(declared.filter((entry) => entry.name === name)).toHaveLength(1);
    if (kind === 'span') {
      expect(spansNamed(harness, name).length, `no "${name}" span was captured`).toBeGreaterThan(0);
    } else if (kind === 'metric') {
      expect(
        dataPointAttributes(harness, name).length,
        `no "${name}" data point was captured`,
      ).toBeGreaterThan(0);
    } else {
      expect(logRecords(harness, name).length, `no "${name}" record was captured`).toBeGreaterThan(
        0,
      );
    }
  });

  it('no span, metric or log event of the identity namespaces, or about a reset, carries an undeclared name', () => {
    const declared = new Set<string>([
      ...identityContract.IDENTITY_SPANS.map((entry) => entry.name),
      ...identityContract.IDENTITY_METRICS.map((entry) => entry.name),
      ...identityContract.IDENTITY_LOG_EVENTS.map((entry) => entry.name),
      ...LOG_EVENTS.map((entry) => entry.name),
      ...METRICS.map((entry) => entry.name),
      ...SPANS.map((entry) => entry.name),
      ...CATALOG_LOG_EVENTS.map((entry) => entry.name),
    ]);
    const aboutReset = /password_reset|mfa_reset|mfa\.reset|recovery/;
    const undeclared: string[] = [];
    for (const span of harness.spanExporter.getFinishedSpans()) {
      if (span.name.startsWith('identity.') || aboutReset.test(span.name)) {
        if (!declared.has(span.name)) undeclared.push(`span ${span.name}`);
      }
    }
    for (const name of metricNames()) {
      if (name.startsWith('tayzu.identity.') || aboutReset.test(name)) {
        if (!declared.has(name)) undeclared.push(`metric ${name}`);
      }
    }
    for (const record of harness.logExporter.getFinishedLogRecords()) {
      const name = record.eventName ?? '';
      if (
        name.startsWith('catalog.audit.') ||
        name.startsWith('catalog.security.') ||
        aboutReset.test(name)
      ) {
        if (!declared.has(name)) undeclared.push(`log ${name}`);
      }
    }
    expect([...new Set(undeclared)]).toEqual([]);
  });
});

/**
 * `otel-smoke-check`, 045 extension (task 9.2 of openspec/changes/archive/2026-11-18-045-org-deletion-and-data-retention;
 * design.md "Observability contract", Resolved decision Q169).
 *
 * "`otel-smoke-check` runs the request, the repeated request, the reversal and the purge once
 * successfully and once per applicable error or denial class."
 *
 * This `describe` only drives the operations; its own assertions are limited to "the operation
 * behaved as its class says", so a failure here is never a telemetry finding. The declared names
 * are asserted by the 043 `describe` below (it iterates the identity contract module, which
 * carries the 045 names since task 9.1) and by the 045 `describe` after it. Every driven
 * operation has a fresh tenant of its own (the repeated request reuses the tenant of its first
 * request, by definition).
 *
 * Operations driven, success and error class each:
 *
 * - the deletion request (`identity.organization.delete`): over HTTP (`DELETE /v1/organization`)
 *   a success with a fresh MFA step-up and a refusal without it (`AUTH_STEP_UP_REQUIRED`); in
 *   process over the identity router (step-up lives in the Fastify interceptor) a `member`
 *   denial (`AUTH_FORBIDDEN`), a wrong confirmation (`CATALOG_VALIDATION_FAILED`), a success
 *   whose notice the provider refuses and a success whose notice recipients cannot be read
 *   (both `catalog.security.org_deletion_notice_failed`);
 * - the repeated request, on the tenant of the provider-refused success;
 * - the reversal (`main` of `../scripts/cancel-org-deletion.js`): a cancellation and the four
 *   refusals `invalid_tenant`, `no_pending_marker`, `purge_begun` and `purge_date_passed`;
 * - the purge (`runPurge` of `../scripts/purge-job.js`, one due tenant per pass): a full purge,
 *   a failed catalog step (`afterTableDeleted`) and a failed auth step (`beforeUserDeleted`),
 *   each failed tenant then resumed to completion by a second pass.
 *
 * ## How the scripts reach their roles here
 *
 * As in `cancel-org-deletion.int.test.ts` and `purge-job.int.test.ts`, the harness's
 * `getDeletionAdminTestDatabase()` and `getPurgeTestDatabase()` pools (`SET ROLE` on every
 * connection). Both entry points take the pool as an option, so `createPool` is not mocked
 * here: `main` of the reversal gets `pool`, and `runPurge` always takes one. The injected env of
 * the reversal carries sentinel database URLs only; `DATABASE_URL` is never printed. The
 * `telemetry` seam of both scripts is the in-memory harness's flush, so `runScript`'s final
 * flush exports into the exporters this file reads. The purge passes name their tenant
 * (`tenantIds`), so no other file's due tenant is touched.
 *
 * ## Production symbols expected (the red phase)
 *
 * Every module exists; the expected failures are assertion failures on signals that are declared
 * but not produced: the spans `identity.organization.delete`, `.cancel_deletion` and `.purge`,
 * and the outcomes `requested`, `completed` and `failed` of `tayzu.identity.org_deletions`.
 */
const ORG_DELETION_REVERSAL_ENV: Readonly<Record<string, string>> = {
  REVERSAL_DATABASE_URL:
    'postgres://tayzu_deletion_admin@reversal.invalid:5432/tayzu?sslmode=verify-full',
  PURGE_DATABASE_URL: 'postgres://tayzu_purge@purge.invalid:5432/tayzu?sslmode=verify-full',
  DATABASE_URL: 'postgres://tayzu_app@app.invalid:5432/tayzu?sslmode=verify-full',
  AUTH_DATABASE_URL: 'postgres://tayzu_auth@auth.invalid:5432/tayzu?sslmode=verify-full',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
};

/** The text of the purge failure seams: SQL-looking, so a leak into a signal is recognizable. */
const ORG_PURGE_FAILURE_MESSAGE =
  'injected purge failure: delete from catalog_entity where tenant_id = $1 returning title';

/** What the 045 drive did, read by the 045 assertions below. Filled by the drive only. */
const orgDeletionDrive = {
  operatorId: `gh:${String(randomInt(1, 1_000_000_000))}`,
  /** Tenants whose first deletion request succeeded. */
  requested: new Set<string>(),
  wrongConfirmation: new Set<string>(),
  repeated: new Set<string>(),
  /** Tenants whose request succeeded with a failed notice (provider refusal, recipients read). */
  noticeFailed: new Set<string>(),
  cancelled: new Set<string>(),
  /** Refusal reason to the tenant id handed to the reversal (the malformed one included). */
  refused: new Map<string, string>(),
  /** Tenants fully purged by one pass, with one seeded entity each. */
  purgedAtOnce: new Set<string>(),
  /** Tenants whose first pass failed at the step, then completed in a second pass. */
  failedAt: new Map<string, 'catalog' | 'auth'>(),
};

/** `runScript`'s final flush, onto the in-memory harness. */
function harnessTelemetry(harness: TelemetryTestHarness): Telemetry {
  return { shutdown: () => harness.forceFlush() };
}

describe('otel-smoke-check, 045: every org-deletion operation is driven (task 9.2)', () => {
  let app: App;
  let pools: HarnessPools;
  let harness: TelemetryTestHarness;
  let repository: ReturnType<typeof createAuthRepository>;
  let reversalPool: Pool;
  let purgePool: Pool;
  const authz = createCerbosClient({ address: IDENTITY_CERBOS, tls: false });
  const appSender = createRecordingEmailSender();

  beforeAll(async () => {
    harness = registeredHarness();
    pools = await harnessPools();
    await runMigrations(pools.authPool);
    reversalPool = (await getDeletionAdminTestDatabase()).pool;
    purgePool = (await getPurgeTestDatabase()).pool;
    app = await createApp({
      ...pools,
      authSecret: TEST_SECRET,
      cerbosAddress: IDENTITY_CERBOS,
      allowedOrigins: [IDENTITY_ORIGIN],
      mountIdentityRoutes: true,
      email: {
        sender: appSender,
        invitationLinkBaseUrl: IDENTITY_ORIGIN,
        passwordResetLinkBaseUrl: IDENTITY_ORIGIN,
        disabledTenantIds: [],
        killSwitch: false,
        recipientKeySecret: IDENTITY_SECRET,
        tenantCap: { max: 1000, windowSeconds: 3600 },
        recipientCap: { max: 1000, windowSeconds: 86_400 },
      },
    });
    repository = createAuthRepository(pools.authPool);
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  async function newTenant(label: string): Promise<BootstrappedTenant> {
    const id = randomUUID();
    return await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: `Org Deletion ${label}`,
      email: `s045-${label.toLowerCase().replaceAll(' ', '-')}-${id}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Smoke 045 ${id}`,
      organizationSlug: `s045-${id}`,
      ip: randomIp(),
    });
  }

  function contextOf(tenant: BootstrappedTenant, role: 'admin' | 'member' = 'admin') {
    const headers = new Headers({ cookie: tenant.cookie, 'x-forwarded-for': randomIp() });
    return {
      tenantId: tenant.organizationId,
      actor: { type: 'user', id: tenant.userId },
      principal: { roles: [role] },
      __requestHeaders: headers,
      __stepUpHeaders: headers,
    };
  }

  function routerWith(
    options: { notices?: NoticeDispatcher; authRepository?: typeof repository } = {},
  ): IdentityClient {
    return createRouterClient(
      createIdentityRouter({
        auth: app.auth,
        authz,
        authRepository: options.authRepository ?? repository,
        withUserLock: createWithUserLock(pools.authPool),
        appPool: pools.appPool,
        ...(options.notices === undefined ? {} : { notices: options.notices }),
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );
  }

  function noticesWith(sender: Parameters<typeof createNoticeDispatcher>[0]['sender']) {
    return createNoticeDispatcher({
      disabledTenantIds: [],
      capStore: { consume: () => Promise.resolve() },
      sender,
      recipientKeySecret: IDENTITY_SECRET,
    });
  }

  function deleteOverHttp(cookie: string, confirmation: string) {
    return app.app.inject({
      method: 'DELETE',
      url: `/v1/organization?${new URLSearchParams({ confirmation }).toString()}`,
      headers: {
        cookie,
        origin: IDENTITY_ORIGIN,
        'x-forwarded-for': randomIp(),
        ...csrfHeaders('DELETE'),
      },
    });
  }

  async function enrolledAdmin(label: string): Promise<BootstrappedTenant> {
    return await enrolledAdminSession(app, await newTenant(label), {
      password: TEST_PASSWORD,
      origin: IDENTITY_ORIGIN,
    });
  }

  it('the request over HTTP: a success with a fresh step-up, and AUTH_STEP_UP_REQUIRED without one', async () => {
    const allowed = await enrolledAdmin('Http Allowed');
    const answer = await deleteOverHttp(allowed.cookie, allowed.organizationId);
    expect(answer.statusCode, 'the request succeeds').toBe(200);
    orgDeletionDrive.requested.add(allowed.organizationId);

    const stale = await enrolledAdmin('Http Stale');
    await pools.authPool.query('delete from auth.verification where identifier = $1', [
      `step-up-verified:${sessionTokenOfCookie(stale.cookie)}`,
    ]);
    const refused = await deleteOverHttp(stale.cookie, stale.organizationId);
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ code?: unknown }>().code).toBe('AUTH_STEP_UP_REQUIRED');
  }, 120_000);

  it('the request in process: a member denial and a wrong confirmation', async () => {
    const client = routerWith();
    const denied = await newTenant('Member');
    await expect(
      client.identity.organization.delete(
        { query: { confirmation: denied.organizationId } },
        { context: contextOf(denied, 'member') },
      ),
    ).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });

    const wrong = await newTenant('Wrong Confirmation');
    await expect(
      client.identity.organization.delete(
        { query: { confirmation: `org-${randomUUID()}` } },
        { context: contextOf(wrong) },
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });
    orgDeletionDrive.wrongConfirmation.add(wrong.organizationId);
  }, 120_000);

  it('the request with a notice the provider refuses, then the repeated request', async () => {
    const refusing = noticesWith({
      send: () => Promise.reject(new Error('provider refused the message')),
    });
    const client = routerWith({ notices: refusing });
    const tenant = await newTenant('Notice Refused');
    const first = await client.identity.organization.delete(
      { query: { confirmation: tenant.organizationId } },
      { context: contextOf(tenant) },
    );
    expect(typeof first.purgeAfter).toBe('string');
    orgDeletionDrive.requested.add(tenant.organizationId);
    orgDeletionDrive.noticeFailed.add(tenant.organizationId);

    const again = await client.identity.organization.delete(
      { query: { confirmation: tenant.organizationId } },
      { context: contextOf(tenant) },
    );
    expect(again.purgeAfter, 'a repeat answers the pending date').toBe(first.purgeAfter);
    orgDeletionDrive.repeated.add(tenant.organizationId);
  }, 120_000);

  it('the request whose notice recipients cannot be read', async () => {
    const failingRead: typeof repository = {
      ...repository,
      administratorsOf: () => Promise.reject(new Error('recipients read failed')),
    };
    const client = routerWith({
      notices: noticesWith(createRecordingEmailSender()),
      authRepository: failingRead,
    });
    const tenant = await newTenant('Notice Read');
    await client.identity.organization.delete(
      { query: { confirmation: tenant.organizationId } },
      { context: contextOf(tenant) },
    );
    orgDeletionDrive.requested.add(tenant.organizationId);
    orgDeletionDrive.noticeFailed.add(tenant.organizationId);
  }, 120_000);

  const MARKER_SEEDS = {
    pending: `insert into tenant_deletion_marker (tenant_id, requested_at, purge_after, requested_by)
              values ($1, now(), now() + interval '10 days', $2)`,
    purge_begun: `insert into tenant_deletion_marker
                    (tenant_id, requested_at, purge_after, requested_by, catalog_purged_at)
                  values ($1, now() - interval '1 day', now() + interval '9 days', $2,
                          now() - interval '1 hour')`,
    purge_date_passed: `insert into tenant_deletion_marker
                          (tenant_id, requested_at, purge_after, requested_by)
                        values ($1, now() - interval '15 days', now() - interval '1 day', $2)`,
  } as const;

  async function reverse(tenantId: string) {
    return await cancelOrgDeletionMain({
      tenantId,
      env: { ...ORG_DELETION_REVERSAL_ENV, TAYZU_OPERATOR_ID: orgDeletionDrive.operatorId },
      pool: reversalPool,
      telemetry: harnessTelemetry(harness),
    });
  }

  it('the reversal: a cancellation and every refusal reason', async () => {
    const pending = `org-${randomUUID()}`;
    await pools.authPool.query(MARKER_SEEDS.pending, [pending, `usr-${randomUUID()}`]);
    expect(await reverse(pending)).toEqual({ outcome: 'cancelled' });
    orgDeletionDrive.cancelled.add(pending);

    const malformed = `not a tenant id! ${randomUUID()}`;
    expect(await reverse(malformed)).toEqual({ outcome: 'refused', reason: 'invalid_tenant' });
    orgDeletionDrive.refused.set('invalid_tenant', malformed);

    const unmarked = `org-${randomUUID()}`;
    expect(await reverse(unmarked)).toEqual({ outcome: 'refused', reason: 'no_pending_marker' });
    orgDeletionDrive.refused.set('no_pending_marker', unmarked);

    for (const reason of ['purge_begun', 'purge_date_passed'] as const) {
      const tenantId = `org-${randomUUID()}`;
      await pools.authPool.query(MARKER_SEEDS[reason], [tenantId, `usr-${randomUUID()}`]);
      expect(await reverse(tenantId)).toEqual({ outcome: 'refused', reason });
      orgDeletionDrive.refused.set(reason, tenantId);
    }
  }, 120_000);

  /**
   * A due tenant (the seed of `purge-job.int.test.ts`): an organization, a user who belongs only
   * to it with a session, a blueprint and exactly one entity, and a pending marker whose date
   * has passed.
   */
  async function seedDueTenant(): Promise<string> {
    const owner = pools.authPool;
    const tenantId = `org-${randomUUID()}`;
    await owner.query(
      'insert into auth.organization (id, name, slug, created_at) values ($1, $2, $3, now())',
      [tenantId, 'Org', `slug-${tenantId}`],
    );
    await owner.query(MARKER_SEEDS.purge_date_passed, [tenantId, `actor-${randomUUID()}`]);
    const userId = `user-${randomUUID()}`;
    await owner.query(
      `insert into auth."user" (id, name, email, email_verified, created_at, updated_at)
       values ($1, 'User', $2, true, now(), now())`,
      [userId, `${userId}@example.test`],
    );
    await owner.query(
      `insert into auth.member (id, organization_id, user_id, role, created_at)
       values ($1, $2, $3, 'member', now())`,
      [`member-${randomUUID()}`, tenantId, userId],
    );
    await owner.query(
      `insert into auth.session (id, expires_at, token, created_at, updated_at, user_id, active_organization_id)
       values ($1, now() + interval '1 day', $2, now(), now(), $3, $4)`,
      [`session-${randomUUID()}`, randomBytes(24).toString('hex'), userId, tenantId],
    );
    const actorId = `actor-${randomUUID()}`;
    const blueprintId = randomUUID();
    await owner.query(
      `insert into catalog_blueprint
         (id, tenant_id, identifier, title, schema, version, created_at, created_by_type,
          created_by_id, updated_at, updated_by_type, updated_by_id)
       values ($1, $2, $3, '"Service"'::jsonb, '{}'::jsonb, 1, now(), 'user', $4,
               now(), 'user', $4)`,
      [blueprintId, tenantId, `service-${randomUUID()}`, actorId],
    );
    await owner.query(
      `insert into catalog_entity
         (id, tenant_id, blueprint_id, identifier, title, spec_properties, generation, version,
          created_at, created_by_type, created_by_id, updated_at, updated_by_type, updated_by_id)
       values ($1, $2, $3, $4, $4, '{}'::jsonb, 1, 1, now(), 'user', $5, now(), 'user', $5)`,
      [randomUUID(), tenantId, blueprintId, `entity-${randomUUID()}`, actorId],
    );
    return tenantId;
  }

  async function markerState(tenantId: string): Promise<string | undefined> {
    const { rows } = await pools.authPool.query<{ state: string }>(
      'select state::text as state from tenant_deletion_marker where tenant_id = $1',
      [tenantId],
    );
    return rows[0]?.state;
  }

  function purgeOnce(
    tenantId: string,
    seams: Pick<Parameters<typeof runPurge>[0], 'catalogOptions' | 'authOptions'> = {},
  ): Promise<void> {
    return runPurge({
      pool: purgePool,
      tenantIds: [tenantId],
      telemetry: harnessTelemetry(harness),
      ...seams,
    });
  }

  it('the purge: a full purge, a failed catalog step and a failed auth step, each resumed', async () => {
    const full = await seedDueTenant();
    await purgeOnce(full);
    expect(await markerState(full), 'the due tenant is purged').toBe('purged');
    orgDeletionDrive.purgedAtOnce.add(full);

    const catalogFails = await seedDueTenant();
    await purgeOnce(catalogFails, {
      catalogOptions: {
        afterTableDeleted: (table) => {
          if (table === 'catalog_entity') throw new Error(ORG_PURGE_FAILURE_MESSAGE);
        },
      },
    });
    expect(await markerState(catalogFails), 'a failed step leaves the marker pending').toBe(
      'pending',
    );
    orgDeletionDrive.failedAt.set(catalogFails, 'catalog');

    const authFails = await seedDueTenant();
    await purgeOnce(authFails, {
      authOptions: {
        beforeUserDeleted: () => {
          throw new Error(ORG_PURGE_FAILURE_MESSAGE);
        },
      },
    });
    expect(await markerState(authFails), 'a failed step leaves the marker pending').toBe('pending');
    orgDeletionDrive.failedAt.set(authFails, 'auth');

    // The next run resumes from the marker and completes both.
    for (const tenantId of [catalogFails, authFails]) {
      await purgeOnce(tenantId);
      expect(await markerState(tenantId), 'the resumed tenant is purged').toBe('purged');
    }
  }, 120_000);
});

/*
 * Task 3.9 of openspec/changes/archive/2026-11-27-003-catalog-ui-core (design D8 and "Observability contract",
 * Spans; spec requirement "The web app adds no browser telemetry and the server's new signals
 * carry no tenant free text"): "The server MUST declare in its telemetry contract the span of
 * `GET /v1/me` with its gate attribute ... An organization name, a user name or an email MUST
 * NOT reach any signal." Design: "`identity.session.me` | route |
 * `tayzu.identity.session.gate` (`none`|`password_change_required`|`password_expired`|
 * `mfa_enrolment_required`|`unauthenticated`) | `tayzu.tenant.id` (when the session has an
 * active organization)", tracer `@tayzu/auth`; and D8: `organization.name` "never reaches
 * telemetry".
 *
 * Drives `GET /v1/me` over HTTP once per gate (an owner without a factor, a member, an unexpired
 * and an expired temporary password) and once anonymously, with every organization name, user
 * name and email a marker string, then asserts the span and that no marker reached any signal.
 * It runs before the 043 check below, which requires every span the module declares to have
 * been captured.
 *
 * Production symbols expected: the `GET /v1/me` route of `createApp` and its span
 * `identity.session.me` on the `@tayzu/auth` tracer (design D8; the declaration is in
 * `packages/auth/src/telemetry/identity-contract.ts`).
 */
describe('otel-smoke-check, 003: GET /v1/me records identity.session.me with its gate and no names (task 3.9)', () => {
  const SESSION_GATES = [
    'none',
    'password_change_required',
    'password_expired',
    'mfa_enrolment_required',
    'unauthenticated',
  ];
  const GATE = 'tayzu.identity.session.gate';
  const TENANT = 'tayzu.tenant.id';
  let app: App;
  let pools: HarnessPools;
  let harness: TelemetryTestHarness;

  beforeAll(async () => {
    harness = registeredHarness();
    pools = await harnessPools();
    await runMigrations(pools.authPool);
    app = await createApp({
      ...pools,
      authSecret: TEST_SECRET,
      cerbosAddress: IDENTITY_CERBOS,
      allowedOrigins: [IDENTITY_ORIGIN],
    });
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  function me(cookie?: string) {
    return app.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { 'x-forwarded-for': randomIp(), ...(cookie === undefined ? {} : { cookie }) },
    });
  }

  it('identity.session.me carries the gate on every answer, the tenant only with an active organization, and no organization name, user name or email', async () => {
    const id = randomUUID();
    const markers = {
      'organization name': `MeOrgNameMarker-${id}`,
      'owner name': `MeOwnerNameMarker-${id}`,
      'owner email': `me-owner-marker-${id}@example.test`,
      'member name': `MeMemberNameMarker-${id}`,
      'member email': `me-member-marker-${id}@example.test`,
      'temporary user name': `MeTemporaryNameMarker-${id}`,
      'temporary user email': `me-temporary-marker-${id}@example.test`,
      'expired user name': `MeExpiredNameMarker-${id}`,
      'expired user email': `me-expired-marker-${id}@example.test`,
    };
    const owner = await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: markers['owner name'],
      email: markers['owner email'],
      password: TEST_PASSWORD,
      organizationName: markers['organization name'],
      organizationSlug: `me-smoke-${id}`,
      ip: randomIp(),
    });
    const tenantId = owner.organizationId;

    async function memberSession(name: string, email: string): Promise<SessionUser> {
      const created = await createAdminUser(app.auth, { name, email, password: TEST_PASSWORD });
      await (app.auth.api as MemberAdminApi).addMember({
        body: { userId: created.userId, organizationId: tenantId, role: 'member' },
      });
      await seedUserRow(testAppPool(), { tenantId, email, name });
      const signedIn = await signInAdminUser(app.auth, {
        email,
        password: TEST_PASSWORD,
        ip: randomIp(),
      });
      return { userId: created.userId, cookie: signedIn.cookie };
    }

    async function writeTemporaryPasswordMarker(userId: string, offsetMs: number): Promise<void> {
      await pools.authPool.query(
        `insert into auth.verification (id, identifier, value, expires_at)
         values ($1, $2, $3, '9999-12-31T23:59:59.000Z'::timestamptz)`,
        [randomUUID(), `temp-password:${userId}`, new Date(Date.now() + offsetMs).toISOString()],
      );
    }

    const member = await memberSession(markers['member name'], markers['member email']);
    const temporary = await memberSession(
      markers['temporary user name'],
      markers['temporary user email'],
    );
    await writeTemporaryPasswordMarker(temporary.userId, 48 * 60 * 60 * 1000);
    const expired = await memberSession(
      markers['expired user name'],
      markers['expired user email'],
    );
    await writeTemporaryPasswordMarker(expired.userId, -60 * 60 * 1000);

    const answers = {
      owner: await me(owner.cookie),
      member: await me(member.cookie),
      temporary: await me(temporary.cookie),
      expired: await me(expired.cookie),
      anonymous: await me(),
    };
    // The drive behaved as its class says (not a telemetry finding).
    const gateOf = (answer: (typeof answers)['owner']): unknown =>
      answer.json<{ gate?: unknown }>().gate;
    for (const [label, answer] of Object.entries(answers)) {
      expect(answer.statusCode, `${label}: ${answer.body}`).toBe(label === 'anonymous' ? 401 : 200);
    }
    expect(gateOf(answers.owner)).toBe('mfa_enrolment_required');
    expect(gateOf(answers.member)).toBe('none');
    expect(gateOf(answers.temporary)).toBe('password_change_required');
    expect(gateOf(answers.expired)).toBe('password_expired');

    await harness.forceFlush();
    const spans = spansNamed(harness, 'identity.session.me');
    expect(spans.length, 'no "identity.session.me" span was captured').toBeGreaterThan(0);
    for (const span of spans) {
      expect(span.instrumentationScope.name).toBe('@tayzu/auth');
      expect(SESSION_GATES, `${GATE} is in its closed set`).toContain(span.attributes[GATE]);
      for (const key of Object.keys(span.attributes)) {
        expect([GATE, TENANT, 'error.type'], `undeclared attribute ${key}`).toContain(key);
      }
    }
    const ofTenant = spans.filter((span) => span.attributes[TENANT] === tenantId);
    expect(new Set(ofTenant.map((span) => span.attributes[GATE]))).toEqual(
      new Set(['mfa_enrolment_required', 'none', 'password_change_required', 'password_expired']),
    );
    const unauthenticated = spans.filter((span) => span.attributes[GATE] === 'unauthenticated');
    expect(unauthenticated.length, 'the anonymous answer has its span').toBeGreaterThan(0);
    expect(
      unauthenticated.some((span) => !(TENANT in span.attributes)),
      'a span without a session carries no tenant',
    ).toBe(true);

    const corpus = exportedCorpus(harness);
    for (const [label, marker] of Object.entries(markers)) {
      expect(leaks(corpus, marker), `the ${label} must never appear on any signal`).toEqual([]);
      const local = marker.split('@')[0] ?? marker;
      expect(leaks(corpus, local), `the ${label} must never appear in part`).toEqual([]);
    }
  }, 120_000);
});

interface SessionUser {
  readonly userId: string;
  readonly cookie: string;
}

describe('otel-smoke-check, 043: every declared identity signal appears with its declared attributes (task 15.2)', () => {
  let harness: TelemetryTestHarness;

  beforeAll(async () => {
    harness = registeredHarness();
    await harness.forceFlush();
  });

  const identitySpans = () =>
    harness.spanExporter.getFinishedSpans().filter((span) => span.name.startsWith('identity.'));

  function metricUnits(name: string): Set<string> {
    const units = new Set<string>();
    for (const resourceMetrics of harness.metricExporter.getMetrics()) {
      for (const scopeMetrics of resourceMetrics.scopeMetrics) {
        for (const metric of scopeMetrics.metrics) {
          if (metric.descriptor.name === name) units.add(metric.descriptor.unit);
        }
      }
    }
    return units;
  }

  describe('spans', () => {
    it.each(identityContract.IDENTITY_SPANS.map((span) => [span.name, span] as const))(
      '%s is emitted with exactly its declared attributes, and its conditional ones on at least one span',
      (name, contract) => {
        const spans = spansNamed(harness, name);
        expect(spans.length, `no "${name}" span was captured`).toBeGreaterThan(0);
        const conditional = [
          ...new Set([...(IDENTITY_SPAN_CONDITIONAL[name] ?? []), ...(contract.conditional ?? [])]),
        ];
        const allowed = new Set([...contract.attributes, ...conditional, 'error.type']);
        for (const span of spans) {
          for (const key of Object.keys(span.attributes)) {
            expect(allowed.has(key), `${name} carries undeclared attribute ${key}`).toBe(true);
          }
          // A span that failed may not know every value yet; a span that succeeded does.
          if (!('error.type' in span.attributes)) {
            for (const key of contract.attributes) {
              expect(span.attributes, `${name} is missing ${key}`).toHaveProperty([key]);
            }
          }
        }
        for (const key of conditional) {
          expect(
            spans.some((span) => key in span.attributes),
            `no "${name}" span carried the conditional attribute ${key}`,
          ).toBe(true);
        }
      },
    );

    it('identity.invitation.accept records both paths and the cancel span every reason', () => {
      const paths = new Set(
        spansNamed(harness, 'identity.invitation.accept').map(
          (span) => span.attributes['tayzu.identity.invitation.path'],
        ),
      );
      paths.delete(undefined);
      expect(paths).toEqual(new Set(['new_account', 'existing_account']));
      const reasons = new Set(
        spansNamed(harness, 'identity.invitation.cancel').map(
          (span) => span.attributes['tayzu.identity.invitation.reason'],
        ),
      );
      for (const reason of [
        'admin_cancel',
        're_invite',
        'user_disabled',
        'inviter_disabled',
        'user_created',
      ]) {
        expect(reasons, `cancel reason ${reason}`).toContain(reason);
      }
    });
  });

  describe('span error rules (design.md: expected errors carry error.type only)', () => {
    it('no identity span has a status message, and every failed one carries error.type', () => {
      const failed = identitySpans().filter((span) => isErrorStatus(span.status.code));
      expect(failed.length, 'the drives produce failed identity spans').toBeGreaterThan(0);
      for (const span of failed) {
        expect(span.status.message ?? '', `${span.name} status message`).toBe('');
        expect(typeof span.attributes['error.type'], `${span.name} error.type`).toBe('string');
        expect(span.attributes['error.type'], `${span.name} error.type`).not.toBe('');
      }
    });

    it('an expected error carries error.type only: no exception event', () => {
      const expected = identitySpans().filter(
        (span) => isErrorStatus(span.status.code) && span.attributes['error.type'] !== 'internal',
      );
      expect(expected.length, 'the drives produce expected errors').toBeGreaterThan(0);
      for (const span of expected) {
        const exceptions = span.events.filter((event) => event.name === 'exception');
        expect(exceptions, `${span.name} (${String(span.attributes['error.type'])})`).toEqual([]);
      }
    });

    it('an unexpected error carries error.type internal and exactly one sanitized exception event', () => {
      const unexpected = identitySpans().filter(
        (span) => isErrorStatus(span.status.code) && span.attributes['error.type'] === 'internal',
      );
      expect(
        unexpected.map((span) => span.name),
        'the incomplete rotation is an unexpected failure of identity.credential.rotate',
      ).toContain('identity.credential.rotate');
      for (const span of unexpected) {
        const exceptions = span.events.filter((event) => event.name === 'exception');
        expect(exceptions, `${span.name} exception events`).toHaveLength(1);
        const attributes = exceptions[0]?.attributes ?? {};
        expect(attributes, `${span.name} exception message`).not.toHaveProperty([
          'exception.message',
        ]);
      }
    });

    it('no identity span carries the raw message, SQL or bind text of an injected failure', () => {
      const entries = exportedCorpus(harness).filter((entry) =>
        entry.signal.startsWith('span identity.'),
      );
      expect(entries.length).toBeGreaterThan(0);
      for (const marker of [
        identityRevokeSeam.message,
        'select token',
        'injected revoke failure',
      ]) {
        expect(leaks(entries, marker), `a span carries "${marker}"`).toEqual([]);
      }
    });
  });

  describe('metrics', () => {
    it.each(identityContract.IDENTITY_METRICS.map((metric) => [metric.name, metric] as const))(
      '%s is recorded with exactly its declared attribute keys and the unit of the design',
      (name, contract) => {
        const points = dataPointAttributes(harness, name);
        expect(points.length, `no "${name}" data point was captured`).toBeGreaterThan(0);
        const declared = [...contract.attributes].sort();
        for (const attributes of points) {
          expect(Object.keys(attributes).sort(), `${name} attribute keys`).toEqual(declared);
        }
        expect(metricUnits(name), `${name} unit`).toEqual(new Set([IDENTITY_METRIC_UNITS[name]]));
      },
    );

    it('invitations cover created, accepted, cancelled and rate_limited', () => {
      const mutations = metricValues(
        harness,
        'tayzu.identity.invitations',
        'tayzu.identity.invitation.mutation',
      );
      for (const mutation of ['created', 'accepted', 'cancelled', 'rate_limited']) {
        expect(mutations, `invitation mutation ${mutation}`).toContain(mutation);
      }
    });

    it('status changes cover Invited, Active and Disabled', () => {
      const statuses = metricValues(
        harness,
        'tayzu.identity.user_status_changes',
        'tayzu.identity.user.status.to',
      );
      for (const status of ['Invited', 'Active', 'Disabled']) {
        expect(statuses, `status ${status}`).toContain(status);
      }
    });

    it('service accounts cover created, disabled, enabled and deleted', () => {
      expect(
        metricValues(
          harness,
          'tayzu.identity.service_accounts',
          'tayzu.identity.service_account.mutation',
        ),
      ).toEqual(new Set(['created', 'disabled', 'enabled', 'deleted']));
    });

    it('credential mutations cover created, rotated and revoked, for both credential kinds', () => {
      expect(
        metricValues(
          harness,
          'tayzu.identity.credential_mutations',
          'tayzu.identity.credential.mutation',
        ),
      ).toEqual(new Set(['created', 'rotated', 'revoked']));
      const kinds = metricValues(
        harness,
        'tayzu.identity.credential_mutations',
        'tayzu.identity.credential.kind',
      );
      expect(kinds).toContain('integration');
      expect(kinds).toContain('agent');
    });

    it('principal rejections cover user_banned', () => {
      expect(
        metricValues(
          harness,
          'tayzu.identity.principal_rejections',
          'tayzu.identity.rejection.reason',
        ),
      ).toContain('user_banned');
    });
  });

  describe('log events', () => {
    it.each(identityContract.IDENTITY_LOG_EVENTS.map((event) => [event.name, event] as const))(
      '%s is emitted at its declared severity with exactly its declared attributes',
      (name, contract) => {
        const records = logRecords(harness, name);
        expect(records.length, `no "${name}" log record was captured`).toBeGreaterThan(0);
        const conditional = new Set(contract.conditional ?? []);
        const forms = Object.entries(contract.forms ?? {});
        const seen = new Set<string>();
        for (const record of records) {
          expect(record.severityNumber, `${name} severity`).toBe(
            SEVERITY_NUMBER[contract.severity],
          );
          const keys = Object.keys(record.attributes).filter((key) => !conditional.has(key));
          if (contract.attributes !== undefined) {
            expect(keys.sort(), `${name} attribute keys`).toEqual([...contract.attributes].sort());
          } else {
            const form = forms.find(
              ([, declared]) =>
                JSON.stringify([...declared].sort()) === JSON.stringify(keys.sort()),
            );
            expect(form, `${name} matches no declared form: ${keys.join(', ')}`).toBeDefined();
            if (form !== undefined) seen.add(form[0]);
          }
        }
        for (const [form] of forms) {
          expect(seen, `${name} was never emitted in its "${form}" form`).toContain(form);
        }
      },
    );

    it('invitation_accepted covers both paths and both roles', () => {
      const paths = logValues(
        harness,
        'catalog.audit.invitation_accepted',
        'tayzu.identity.invitation.path',
      );
      expect(paths).toEqual(new Set(['new_account', 'existing_account']));
      const roles = logValues(
        harness,
        'catalog.audit.invitation_accepted',
        'tayzu.identity.invitation.role',
      );
      expect(roles).toEqual(new Set(['member', 'admin']));
    });

    it('invitation_cancelled covers admin_cancel, re_invite, user_disabled, inviter_disabled and user_created', () => {
      const reasons = logValues(
        harness,
        'catalog.audit.invitation_cancelled',
        'tayzu.identity.invitation.reason',
      );
      for (const reason of [
        'admin_cancel',
        're_invite',
        'user_disabled',
        'inviter_disabled',
        'user_created',
      ]) {
        expect(reasons, `cancel reason ${reason}`).toContain(reason);
      }
    });

    it('invitation_acceptance_denied covers every driveable reason, csrf_rejected and origin_rejected included', () => {
      const reasons = logValues(
        harness,
        'catalog.security.invitation_acceptance_denied',
        'tayzu.identity.invitation.denial_reason',
      );
      for (const reason of [
        'malformed_request',
        'not_found',
        'token_mismatch',
        'already_accepted',
        'cancelled',
        'expired',
        'rejected',
        'disabled_user',
        'inviter_not_active_admin',
        'session_required',
        'email_mismatch',
        'csrf_rejected',
        'origin_rejected',
        'consume_conflict',
      ]) {
        expect(reasons, `denial reason ${reason}`).toContain(reason);
      }
    });

    it('the email, notice and rate-limit events cover their closed values', () => {
      const scopes = logValues(
        harness,
        'catalog.security.invitation_rate_limited',
        'tayzu.identity.invitation.limit_scope',
      );
      for (const scope of ['tenant', 'recipient', 'global']) expect(scopes).toContain(scope);
      const suppressions = logValues(
        harness,
        'catalog.security.notice_suppressed',
        'tayzu.identity.notice.suppression',
      );
      for (const suppression of ['global', 'tenant', 'recipient', 'truncated']) {
        expect(suppressions).toContain(suppression);
      }
      for (const event of [
        'catalog.security.email_recipient_blocked',
        'catalog.security.email_tenant_blocked',
      ]) {
        const templates = logValues(harness, event, 'tayzu.identity.email.template');
        expect(templates, event).toContain('invitation');
        expect(templates, event).toContain('admin_accepted');
      }
    });

    it('conflicts, sheds and rejections cover their reasons and paths', () => {
      const conflicts = logValues(
        harness,
        'catalog.security.identity_conflict_refused',
        'tayzu.identity.conflict.reason',
      );
      for (const reason of ['account_exists', 'sub_already_linked', 'target_is_admin_or_owner']) {
        expect(conflicts, `conflict ${reason}`).toContain(reason);
      }
      const paths = logValues(
        harness,
        'catalog.security.sso_link_shed',
        'tayzu.identity.sso_link.path',
      );
      for (const path of ['acceptance', 'membership_hook', 'reconcile']) {
        expect(paths, `shed path ${path}`).toContain(path);
      }
      expect(
        logValues(
          harness,
          'catalog.security.principal_rejected',
          'tayzu.identity.rejection.reason',
        ),
      ).toContain('user_banned');
      expect(
        logValues(
          harness,
          'catalog.security.banned_sign_in_attempt',
          'tayzu.identity.sign_in.channel',
        ),
      ).toContain('local');
    });

    it('user_created covers the admin and the bootstrap sources', () => {
      expect(
        logValues(harness, 'catalog.audit.user_created', 'tayzu.identity.user.source'),
      ).toEqual(new Set(['admin', 'bootstrap']));
    });
  });

  it('every bounded tayzu.identity.* attribute value of every span, metric and log is inside its closed set', () => {
    const offenders: string[] = [];
    const check = (signal: string, attributes: Readonly<Record<string, unknown>>): void => {
      for (const [key, value] of Object.entries(attributes)) {
        const allowed = identityContract.IDENTITY_ATTRIBUTE_VALUES[key];
        if (
          allowed === undefined ||
          !key.startsWith('tayzu.identity.') ||
          key === 'tayzu.identity.invitation.id'
        ) {
          continue;
        }
        if (typeof value !== 'string' || !allowed.includes(value)) {
          offenders.push(`${signal}: ${key}=${String(value)}`);
        }
      }
    };
    for (const span of identitySpans()) check(`span ${span.name}`, span.attributes);
    for (const { name } of identityContract.IDENTITY_METRICS) {
      for (const attributes of dataPointAttributes(harness, name))
        check(`metric ${name}`, attributes);
    }
    for (const { name } of identityContract.IDENTITY_LOG_EVENTS) {
      for (const record of logRecords(harness, name)) check(`log ${name}`, record.attributes);
    }
    expect([...new Set(offenders)]).toEqual([]);
  });
});

/**
 * Task 9.2 (045): the org-deletion signals of the drive above cover every success, error and
 * denial class the design's Observability contract names. The 043 `describe` above already
 * asserts, from the contract module, that each 045 span, counter and event is captured with
 * exactly its declared attribute keys; this one asserts the values: the counter's four
 * outcomes, one purge span per tenant and step with step 1's entities removed (Q169), the
 * reversal's refusal reasons and the failure classes.
 *
 * Span coverage ("removing one declared span makes the check fail"): the 043 span check is an
 * `it.each` over `IDENTITY_SPANS`, so a declared span that is no longer emitted fails its own
 * case ("no ... span was captured"), and a span removed from the module fails the 9.1 checks
 * above (the fixture and the pinned 045 list still name it). The last case here proves the
 * first half against the captured 045 spans.
 */
describe('otel-smoke-check, 045: every org-deletion class is observed with its declared values (task 9.2)', () => {
  let harness: TelemetryTestHarness;

  beforeAll(async () => {
    harness = registeredHarness();
    await harness.forceFlush();
  });

  const SPANS_045 = [
    'identity.organization.delete',
    'identity.organization.cancel_deletion',
    'identity.organization.purge',
  ] as const;

  const ofTenant = (name: string, tenantId: string) =>
    spansNamed(harness, name).filter((span) => span.attributes['tayzu.tenant.id'] === tenantId);
  const failed = (span: { attributes: Readonly<Record<string, unknown>> }) =>
    'error.type' in span.attributes;

  it('tayzu.identity.org_deletions covers requested, completed, failed and cancelled', () => {
    const outcomes = metricValues(
      harness,
      'tayzu.identity.org_deletions',
      'tayzu.identity.org_deletion.outcome',
    );
    for (const outcome of ['requested', 'completed', 'failed', 'cancelled']) {
      expect(outcomes, `org deletion outcome ${outcome}`).toContain(outcome);
    }
  });

  it('identity.organization.delete: each successful request has a span with its host tenant, and a wrong confirmation fails it with error.type CATALOG_VALIDATION_FAILED', () => {
    expect(orgDeletionDrive.requested.size, 'the drive requested deletions').toBeGreaterThan(0);
    for (const tenantId of orgDeletionDrive.requested) {
      const spans = ofTenant('identity.organization.delete', tenantId);
      expect(
        spans.some((span) => !failed(span)),
        `a successful identity.organization.delete span for the requested tenant`,
      ).toBe(true);
    }
    for (const tenantId of orgDeletionDrive.wrongConfirmation) {
      const spans = ofTenant('identity.organization.delete', tenantId);
      expect(spans.length, 'the wrong confirmation has its span').toBeGreaterThan(0);
      for (const span of spans) {
        expect(isErrorStatus(span.status.code), 'the span failed').toBe(true);
        expect(span.attributes['error.type']).toBe('CATALOG_VALIDATION_FAILED');
      }
    }
  });

  it('identity.organization.purge: one span per tenant and step, catalog and auth, and step 1 carries the entities it removed (Q169)', () => {
    expect(orgDeletionDrive.purgedAtOnce.size, 'the drive purged a tenant').toBeGreaterThan(0);
    for (const tenantId of orgDeletionDrive.purgedAtOnce) {
      const spans = ofTenant('identity.organization.purge', tenantId);
      const steps = spans.map((span) => span.attributes['tayzu.identity.org_deletion.step']);
      expect(steps.sort(), 'one span per step').toEqual(['auth', 'catalog']);
      const catalog = spans.find(
        (span) => span.attributes['tayzu.identity.org_deletion.step'] === 'catalog',
      );
      expect(catalog?.attributes['tayzu.identity.org_deletion.entities_removed']).toBe(1);
      for (const span of spans) {
        expect(failed(span), 'a one-pass purge step succeeds').toBe(false);
      }
    }
  });

  it('identity.organization.purge: a failed step fails its span with error.type internal and one sanitized exception', () => {
    expect(orgDeletionDrive.failedAt.size, 'the drive failed a step').toBe(2);
    for (const [tenantId, step] of orgDeletionDrive.failedAt) {
      const spans = ofTenant('identity.organization.purge', tenantId).filter(
        (span) => span.attributes['tayzu.identity.org_deletion.step'] === step,
      );
      const failures = spans.filter(failed);
      expect(failures, `exactly one failed ${step} span`).toHaveLength(1);
      const [span] = failures;
      expect(isErrorStatus(span?.status.code ?? 0), 'the span status is ERROR').toBe(true);
      expect(span?.attributes['error.type']).toBe('internal');
      const exceptions = span?.events.filter((event) => event.name === 'exception') ?? [];
      expect(exceptions).toHaveLength(1);
      expect(exceptions[0]?.attributes ?? {}).not.toHaveProperty(['exception.message']);
    }
  });

  it('identity.organization.cancel_deletion: the cancellation carries the tenant and the operator id', () => {
    expect(orgDeletionDrive.cancelled.size).toBe(1);
    for (const tenantId of orgDeletionDrive.cancelled) {
      const spans = ofTenant('identity.organization.cancel_deletion', tenantId);
      expect(spans, 'one span for the cancellation').toHaveLength(1);
      expect(spans[0]?.attributes['tayzu.identity.operator.id']).toBe(orgDeletionDrive.operatorId);
      expect(failed(spans[0] ?? { attributes: {} }), 'the cancellation succeeded').toBe(false);
    }
  });

  it('catalog.security.org_deletion_cancel_refused covers the four reasons, with the tenant only once its id passed the shape check', () => {
    const records = logRecords(harness, 'catalog.security.org_deletion_cancel_refused').filter(
      (record) => record.attributes['tayzu.identity.operator.id'] === orgDeletionDrive.operatorId,
    );
    const reasons = new Set(
      records.map((record) => record.attributes['tayzu.identity.org_deletion.cancel_refusal']),
    );
    expect(reasons).toEqual(
      new Set(['invalid_tenant', 'no_pending_marker', 'purge_begun', 'purge_date_passed']),
    );
    for (const record of records) {
      const raw = record.attributes['tayzu.identity.org_deletion.cancel_refusal'];
      const reason = typeof raw === 'string' ? raw : '';
      if (reason === 'invalid_tenant') {
        expect(record.attributes, reason).not.toHaveProperty(['tayzu.tenant.id']);
      } else {
        expect(record.attributes['tayzu.tenant.id'], reason).toBe(
          orgDeletionDrive.refused.get(reason),
        );
      }
    }
  });

  it('catalog.audit.org_deletion_requested, _repeated and _notice_failed name the driven tenants', () => {
    const tenantsOf = (event: string) => logValues(harness, event, 'tayzu.tenant.id');
    const requested = tenantsOf('catalog.audit.org_deletion_requested');
    for (const tenantId of orgDeletionDrive.requested) expect(requested).toContain(tenantId);
    const repeated = tenantsOf('catalog.security.org_deletion_repeated');
    for (const tenantId of orgDeletionDrive.repeated) expect(repeated).toContain(tenantId);
    const noticeFailed = tenantsOf('catalog.security.org_deletion_notice_failed');
    expect(orgDeletionDrive.noticeFailed.size, 'a refused send and a failed read').toBe(2);
    for (const tenantId of orgDeletionDrive.noticeFailed) expect(noticeFailed).toContain(tenantId);
  });

  it('catalog.security.org_deletion_failed covers both steps, and catalog.audit.org_deletion_completed reports the entities of the run that emits it (Q169)', () => {
    const failures = logRecords(harness, 'catalog.security.org_deletion_failed');
    for (const [tenantId, step] of orgDeletionDrive.failedAt) {
      expect(
        failures.some(
          (record) =>
            record.attributes['tayzu.tenant.id'] === tenantId &&
            record.attributes['tayzu.identity.org_deletion.step'] === step,
        ),
        `a failed ${step} step is logged`,
      ).toBe(true);
    }
    const completed = (tenantId: string) =>
      logRecords(harness, 'catalog.audit.org_deletion_completed')
        .filter((record) => record.attributes['tayzu.tenant.id'] === tenantId)
        .map((record) => record.attributes['tayzu.identity.org_deletion.entities_removed']);
    for (const tenantId of orgDeletionDrive.purgedAtOnce) {
      expect(completed(tenantId), 'a one-pass purge reports its entity').toEqual([1]);
    }
    for (const [tenantId, step] of orgDeletionDrive.failedAt) {
      if (step === 'auth') {
        expect(completed(tenantId), 'a run resumed after step 1 reports 0').toEqual([0]);
      }
    }
  });

  it('no span or log record carries the text of an injected purge failure', () => {
    const entries = exportedCorpus(harness).filter(
      (entry) => entry.signal.startsWith('span ') || entry.signal.startsWith('log '),
    );
    expect(entries.length).toBeGreaterThan(0);
    for (const marker of [ORG_PURGE_FAILURE_MESSAGE, 'injected purge failure', 'returning title']) {
      expect(leaks(entries, marker), `a signal carries "${marker}"`).toEqual([]);
    }
  });

  it('span coverage: every 045 span is captured, and a declared span with no capture is reported', () => {
    const captured = new Set(harness.spanExporter.getFinishedSpans().map((span) => span.name));
    const missing = (names: ReadonlySet<string>) => SPANS_045.filter((name) => !names.has(name));
    expect(missing(captured), 'every 045 span is captured').toEqual([]);
    const withoutPurge = new Set([...captured].filter((name) => name !== SPANS_045[2]));
    expect(missing(withoutPurge), 'a span no longer emitted is reported').toEqual([SPANS_045[2]]);
  });
});

/** The structural slice of an exported metric batch the identity cardinality guard reads. */
type MetricBatch = readonly {
  readonly scopeMetrics: readonly {
    readonly metrics: readonly {
      readonly descriptor: { readonly name: string };
      readonly dataPoints: readonly { readonly attributes: Readonly<Record<string, unknown>> }[];
    }[];
  }[];
}[];

/**
 * Keys that must never be a `tayzu.identity.*` metric attribute, whatever the contract declares:
 * the invited email (043 task 15.3) and the organization's name (045 task 9.2).
 */
const FORBIDDEN_IDENTITY_METRIC_KEYS: readonly string[] = [
  'tayzu.identity.invitation.email',
  'tayzu.identity.org_deletion.name',
];

/**
 * The cardinality guard of `tayzu.identity.*` metrics: every data point carries only keys of its
 * metric's allowed set, never a forbidden key, and every metric is declared.
 */
function identityMetricOffenders(
  batches: MetricBatch,
  allowedByMetric: ReadonlyMap<string, readonly string[]>,
): { readonly identityMetrics: number; readonly offenders: readonly string[] } {
  const offenders: string[] = [];
  let identityMetrics = 0;
  for (const resourceMetrics of batches) {
    for (const scopeMetrics of resourceMetrics.scopeMetrics) {
      for (const metric of scopeMetrics.metrics) {
        const name = metric.descriptor.name;
        if (!name.startsWith('tayzu.identity.')) continue;
        identityMetrics += 1;
        const allowed = allowedByMetric.get(name);
        if (allowed === undefined) {
          offenders.push(`${name}: not a declared metric`);
          continue;
        }
        for (const point of metric.dataPoints) {
          for (const key of Object.keys(point.attributes)) {
            if (!allowed.includes(key)) offenders.push(`${name}: ${key}`);
            if (FORBIDDEN_IDENTITY_METRIC_KEYS.includes(key)) offenders.push(`${name}: ${key}`);
          }
        }
      }
    }
  }
  return { identityMetrics, offenders };
}

/*
 * Task 15.3 (043): the cardinality guard extends to `tayzu.identity.*` metrics:
 * no attribute key outside the contract's allowed set. A deliberately added
 * `tayzu.identity.invitation.email` attribute makes this fail. The allowed set is
 * the spec side, in `identity-contract-expected.ts`, and the module's own
 * declaration must agree with it. The 002 guard above only inspects
 * `tayzu.auth.*` / `tayzu.authz.*`.
 */
describe('otel-smoke-check, 043: no tayzu.identity.* metric carries an attribute key outside its declared set (task 15.3)', () => {
  let harness: TelemetryTestHarness;

  beforeAll(async () => {
    harness = registeredHarness();
    await harness.forceFlush();
  });

  const allowedByMetric: ReadonlyMap<string, readonly string[]> = new Map(
    EXPECTED_METRICS.map((metric) => [metric.name, metric.attributes] as const),
  );

  it('every tayzu.identity.* data point carries only keys of its declared set, and no invitation email key', () => {
    const { identityMetrics, offenders } = identityMetricOffenders(
      harness.metricExporter.getMetrics(),
      allowedByMetric,
    );
    expect(identityMetrics, 'no tayzu.identity.* metric was captured').toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  /**
   * 045 task 9.2: "a deliberately added `tayzu.identity.org_deletion.name` metric attribute makes
   * it fail". The captured `tayzu.identity.org_deletions` points, each with the organization's
   * name added, go through the same guard: once against the contract's allowed set, and once
   * against an allowed set that declares the key too (a contract edited along with the code).
   */
  describe('045: an organization-name attribute on tayzu.identity.org_deletions fails the guard (task 9.2)', () => {
    const NAME_KEY = 'tayzu.identity.org_deletion.name';

    function withName(): MetricBatch {
      return harness.metricExporter.getMetrics().map((resourceMetrics) => ({
        scopeMetrics: resourceMetrics.scopeMetrics.map((scopeMetrics) => ({
          metrics: scopeMetrics.metrics
            .filter((metric) => metric.descriptor.name === 'tayzu.identity.org_deletions')
            .map((metric) => ({
              descriptor: metric.descriptor,
              dataPoints: metric.dataPoints.map((point) => ({
                attributes: { ...point.attributes, [NAME_KEY]: 'Acme Marker Org' },
              })),
            })),
        })),
      }));
    }

    it('the captured org-deletion points pass the guard as they are', () => {
      const points = dataPointAttributes(harness, 'tayzu.identity.org_deletions');
      expect(points.length, 'tayzu.identity.org_deletions was captured').toBeGreaterThan(0);
      expect(
        identityMetricOffenders(harness.metricExporter.getMetrics(), allowedByMetric),
      ).toMatchObject({ offenders: [] });
    });

    it('the same points with the organization name added fail it', () => {
      const { identityMetrics, offenders } = identityMetricOffenders(withName(), allowedByMetric);
      expect(identityMetrics, 'the org-deletion metric is in the batch').toBeGreaterThan(0);
      expect(offenders).toContain(`tayzu.identity.org_deletions: ${NAME_KEY}`);
    });

    it('they fail it even when the allowed set declares the name', () => {
      const widened = new Map(allowedByMetric);
      widened.set('tayzu.identity.org_deletions', [
        ...(allowedByMetric.get('tayzu.identity.org_deletions') ?? []),
        NAME_KEY,
      ]);
      const { offenders } = identityMetricOffenders(withName(), widened);
      expect(offenders).toContain(`tayzu.identity.org_deletions: ${NAME_KEY}`);
    });
  });

  it.each(EXPECTED_METRICS.map((metric) => [metric.name, metric.attributes] as const))(
    '%s declares exactly its allowed attribute keys in the imported module',
    (name, attributes) => {
      const declared = (
        identityContract.IDENTITY_METRICS as readonly {
          name: string;
          attributes: readonly string[];
        }[]
      ).find((metric) => metric.name === name);
      expect([...(declared?.attributes ?? [])].sort()).toEqual([...attributes].sort());
    },
  );
});

/**
 * Task 15.4 (openspec/changes/archive/2026-10-14-043-identity-lifecycle-and-org-admin; spec scenarios "Invited email
 * never reaches telemetry", "The invitation link never leaves the email", "The email provider's
 * failure never leaks", and the placeholder of Resolved decisions Q107, Q113 and Q119).
 *
 * A marker-leak test across this change's signals, in memory: the markers go through the real
 * operations (invite, resend, an expired and a wrong-token acceptance, a successful acceptance, a
 * rate-limited invite, a credential rotation, status changes, a failing provider) and the exported
 * corpus of the whole run (spans, metric data points, log records) plus every response and error
 * the operations gave back must hold none of them. The Cerbos client is the real one wrapped in a
 * recorder that sees what the decision log would record.
 */
/** The six catalog spans that require `tayzu.catalog.entity.identifier` (Resolved decision Q107). */
const ENTITY_IDENTIFIER_SPANS: readonly string[] = [
  'catalog.entity.create',
  'catalog.entity.upsert',
  'catalog.entity.get',
  'catalog.entity.delete',
  'catalog.entity.status.write',
  'catalog.entity.related.list',
];

describe('otel-smoke-check, 043: marker values never reach a signal (task 15.4)', () => {
  let app: App;
  let pools: HarnessPools;
  let harness: TelemetryTestHarness;
  let adapter: ReturnType<typeof createUserSyncAdapter>;
  let repository: ReturnType<typeof createAuthRepository>;
  let shed: ReturnType<typeof createSsoLinkShed>;
  const real = createCerbosClient({ address: IDENTITY_CERBOS, tls: false });
  const checked: unknown[] = [];
  const recordingAuthz = new Proxy(real, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]): unknown => {
        if (prop === 'checkResources' || prop === 'planResources') checked.push(args[0]);
        return Reflect.apply(value as (...a: unknown[]) => unknown, target, args);
      };
    },
  });
  const recorded = createRecordingEmailSender();

  beforeAll(async () => {
    harness = registeredHarness();
    pools = await harnessPools();
    await runMigrations(pools.authPool);
    app = await createApp({
      ...pools,
      authSecret: TEST_SECRET,
      cerbosAddress: IDENTITY_CERBOS,
      allowedOrigins: [IDENTITY_ORIGIN],
      mountIdentityRoutes: true,
      email: {
        sender: createNonSendingEmailSender(),
        invitationLinkBaseUrl: IDENTITY_ORIGIN,
        passwordResetLinkBaseUrl: IDENTITY_ORIGIN,
        disabledTenantIds: [],
        killSwitch: false,
        recipientKeySecret: IDENTITY_SECRET,
        tenantCap: { max: 1000, windowSeconds: 3600 },
        recipientCap: { max: 1000, windowSeconds: 86_400 },
      },
    });
    adapter = createUserSyncAdapter({
      userSync: createUserSync({ pool: pools.appPool, authz: recordingAuthz }),
    });
    repository = createAuthRepository(pools.authPool);
    shed = createSsoLinkShed({ authPool: pools.authPool });
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  type Sender = Parameters<typeof createEmailTenantGate>[0]['sender'];

  function gateWith(sender: Sender, recipientMax = 1000): EmailTenantGate {
    return createEmailTenantGate({
      disabledTenantIds: [],
      capStore: createInMemoryEmailCapStore({
        tenant: { max: 1000, windowSeconds: 3600 },
        recipient: { max: recipientMax, windowSeconds: 86_400 },
      }),
      sender,
      recipientKeySecret: IDENTITY_SECRET,
    });
  }

  /** Delivers to the recording fake, which the test reads the token from, and to a second sender. */
  function teeTo(second: Sender): Sender {
    return {
      send: async (to, template) => {
        await recorded.send(to, template);
        await second.send(to, template);
      },
    };
  }

  function routerWith(emailGate: EmailTenantGate): IdentityClient {
    return createRouterClient(
      createIdentityRouter({
        auth: app.auth,
        authz: recordingAuthz,
        authRepository: repository,
        withUserLock: createWithUserLock(pools.authPool),
        emailGate,
        invitationLinkBaseUrl: IDENTITY_ORIGIN,
        appPool: pools.appPool,
        userSync: adapter,
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );
  }

  function flow() {
    return createAcceptFlow({
      auth: app.auth,
      authz: recordingAuthz,
      authRepository: repository,
      authPool: pools.authPool,
      userSync: adapter,
      ssoLinkShed: shed,
    });
  }

  async function newTenant(label: string): Promise<BootstrappedTenant> {
    const id = randomUUID();
    return await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: `Marker ${label}`,
      email: `idmarker-${label.toLowerCase()}-${id}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Marker Org ${id}`,
      organizationSlug: `idmarker-${id}`,
      ip: randomIp(),
    });
  }

  function adminContext(tenant: BootstrappedTenant): Record<string, unknown> {
    const headers = new Headers({ cookie: tenant.cookie, 'x-forwarded-for': randomIp() });
    return {
      tenantId: tenant.organizationId,
      actor: { type: 'user', id: tenant.userId },
      principal: { roles: ['admin'] },
      __requestHeaders: headers,
      __stepUpHeaders: headers,
    };
  }

  const markerEmail = (label: string): string => `marker-${label}-${randomUUID()}@example.com`;
  const markerPassword = (): string => `Marker-Pw-${randomUUID()}-Zz9!`;

  function tokenFor(email: string): { token: string; link: string } {
    const message = [...recorded.sent].reverse().find((candidate) => candidate.to === email);
    if (message?.template.kind !== 'InvitationEmail') {
      throw new Error('the invitation email was not sent');
    }
    const token = new URLSearchParams(new URL(message.template.link).hash.slice(1)).get('token');
    return { token: token ?? '', link: message.template.link };
  }

  function acceptHttp(body: Record<string, unknown>) {
    return app.app.inject({
      method: 'POST',
      url: IDENTITY_ACCEPT_PATH,
      headers: {
        'content-type': 'application/json',
        origin: IDENTITY_ORIGIN,
        'x-csrf-token': 'orpc',
        'x-forwarded-for': randomIp(),
      },
      payload: JSON.stringify(body),
    });
  }

  async function rejectionOf(operation: Promise<unknown>): Promise<unknown> {
    try {
      await operation;
    } catch (error) {
      return error;
    }
    throw new Error('the operation was expected to fail');
  }

  /** Everything a caller could read of a response or an error, own properties and causes included. */
  const textOf = (value: unknown): string => inspect(value, { depth: 8, showHidden: true });

  async function expectNoLeak(
    markers: Readonly<Record<string, string>>,
    responses: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    await harness.forceFlush();
    const entries = exportedCorpus(harness);
    expect(entries.length, 'the corpus is not empty').toBeGreaterThan(0);
    for (const [label, marker] of Object.entries(markers)) {
      expect(marker.length, `${label} marker is non-trivial`).toBeGreaterThanOrEqual(6);
      expect(leaks(entries, marker), `${label} must never appear on any signal`).toEqual([]);
      expect(
        JSON.stringify(checked).includes(marker),
        `${label} must never appear in a Cerbos request`,
      ).toBe(false);
      for (const [name, response] of Object.entries(responses)) {
        expect(textOf(response).includes(marker), `${label} must not be in ${name}`).toBe(false);
      }
    }
  }

  it('Invited email never reaches telemetry: an invite, a resend and an expired acceptance', async () => {
    const tenant = await newTenant('Invite');
    const context = adminContext(tenant);
    const router = routerWith(gateWith(teeTo(createNonSendingEmailSender())));
    const email = markerEmail('invited');

    const created = await router.identity.users.invite(
      { body: { email, role: 'member' } },
      { context },
    );
    const resent = await router.identity.users.resendInvitation(
      { params: { invitation: created.invitationId } },
      { context },
    );
    const { token } = tokenFor(email);
    await pools.authPool.query(
      "update auth.invitation set expires_at = now() - interval '1 hour' where id = $1",
      [created.invitationId],
    );
    const expired = await acceptHttp({
      invitationId: created.invitationId,
      token,
      password: markerPassword(),
    });
    expect(expired.statusCode).toBe(404);

    await expectNoLeak(
      { 'invited email': email, 'invitation token': token },
      { invite: created, resend: resent, 'expired acceptance': expired.body },
    );
  }, 120_000);

  it('Invited email never reaches telemetry: a rate-limited invite', async () => {
    const tenant = await newTenant('Limited');
    const context = adminContext(tenant);
    const router = routerWith(gateWith(teeTo(createNonSendingEmailSender()), 1));
    const email = markerEmail('limited');

    await router.identity.users.invite({ body: { email, role: 'member' } }, { context });
    const refused = await rejectionOf(
      router.identity.users.invite({ body: { email, role: 'member' } }, { context }),
    );
    expect(refused).toMatchObject({ code: 'AUTH_RATE_LIMITED' });

    await expectNoLeak({ 'invited email': email }, { 'rate-limited invite': refused });
  }, 120_000);

  it('Invited email never reaches telemetry: an acceptance carrying a marker password and a marker token', async () => {
    const tenant = await newTenant('Accept');
    const router = routerWith(gateWith(teeTo(createNonSendingEmailSender())));
    const email = markerEmail('accepting');
    const password = markerPassword();
    const invited = await router.identity.users.invite(
      { body: { email, role: 'member' } },
      { context: adminContext(tenant) },
    );
    const { token } = tokenFor(email);

    const markerToken = `markertoken${randomUUID().replaceAll('-', '')}`.slice(0, token.length);
    const wrongToken = await acceptHttp({
      invitationId: invited.invitationId,
      token: markerToken,
      password,
    });
    expect(wrongToken.statusCode).toBe(404);
    const accepted = await flow().accept({
      invitationId: invited.invitationId,
      token,
      password,
    });
    expect(accepted.userId).toBeTruthy();

    await expectNoLeak(
      {
        'invited email': email,
        'marker password': password,
        'marker token': markerToken,
        'invitation token': token,
      },
      { 'wrong-token acceptance': wrongToken.body, acceptance: accepted },
    );
  }, 120_000);

  it('Invited email never reaches telemetry: a credential rotation, with the secret as the marker', async () => {
    const tenant = await newTenant('Rotate');
    const context = adminContext(tenant);
    const router = routerWith(gateWith(teeTo(createNonSendingEmailSender())));

    const created = await router.identity.credentials.create(
      { body: { name: 'Marker integration', kind: 'integration' } },
      { context },
    );
    const rotated = await router.identity.credentials.rotate(
      { params: { credential: created.id } },
      { context },
    );
    expect(rotated.secret).not.toBe(created.secret);
    const listed = await router.identity.credentials.list({ query: {} }, { context });

    await expectNoLeak(
      { 'created secret': created.secret, 'rotated secret': rotated.secret },
      { list: listed },
    );
  }, 120_000);

  it('The invitation link never leaves the email: an invite and a resend', async () => {
    const tenant = await newTenant('Link');
    const context = adminContext(tenant);
    const keeper = createNonSendingEmailSender();
    const router = routerWith(gateWith(teeTo(keeper)));
    const email = markerEmail('link');

    const created = await router.identity.users.invite(
      { body: { email, role: 'member' } },
      { context },
    );
    const firstLink = tokenFor(email);
    const resent = await router.identity.users.resendInvitation(
      { params: { invitation: created.invitationId } },
      { context },
    );
    const secondLink = tokenFor(email);
    expect(secondLink.token, 'a resend mails a link with its own token').not.toBe('');

    const markers: Record<string, string> = {
      'first token': firstLink.token,
      'first link': firstLink.link,
      'first id-plus-token fragment': new URL(firstLink.link).hash.slice(1),
      'second token': secondLink.token,
      'second link': secondLink.link,
    };
    await expectNoLeak(markers, {
      invite: created,
      resend: resent,
      'non-sending sender': keeper,
    });
    expect(Object.keys(keeper), 'the non-sending sender keeps nothing').toEqual(['send']);
  }, 120_000);

  it("The email provider's failure never leaks: a failure that contains the recipient address", async () => {
    const tenant = await newTenant('Provider');
    const context = adminContext(tenant);
    const email = markerEmail('provider');
    const failing = createAzureCommunicationEmailSender({
      senderAddress: 'noreply@tayzu.test',
      client: {
        beginSend: () =>
          Promise.reject(new Error(`Invalid recipient ${email}: mailbox unavailable`)),
      },
    });
    const router = routerWith(gateWith(failing));

    let outcome: unknown;
    try {
      outcome = await router.identity.users.invite(
        { body: { email, role: 'member' } },
        { context },
      );
    } catch (error) {
      outcome = error;
    }

    await expectNoLeak({ 'invited email': email }, { 'provider failure': outcome });
  }, 120_000);

  it('the catalog spans, audit events and Cerbos requests of the _user writes carry the placeholder, never the email', async () => {
    const tenant = await newTenant('Writes');
    const context = adminContext(tenant);
    const router = routerWith(gateWith(teeTo(createNonSendingEmailSender())));
    const spansBefore = new Set(harness.spanExporter.getFinishedSpans());
    const logsBefore = new Set(harness.logExporter.getFinishedLogRecords());
    const checksBefore = checked.length;

    // An invite, an acceptance and a status change: each writes the invitee's `_user` row.
    const email = markerEmail('writes');
    const invited = await router.identity.users.invite(
      { body: { email, role: 'member' } },
      { context },
    );
    const { token } = tokenFor(email);
    await flow().accept({ invitationId: invited.invitationId, token, password: markerPassword() });
    await router.identity.users.setStatus(
      { params: { user: email }, body: { status: 'Disabled' } },
      { context },
    );
    await router.identity.users.setStatus(
      { params: { user: email }, body: { status: 'Active' } },
      { context },
    );
    await harness.forceFlush();

    const userSpans = harness.spanExporter
      .getFinishedSpans()
      .filter(
        (span) =>
          !spansBefore.has(span) &&
          ENTITY_IDENTIFIER_SPANS.includes(span.name) &&
          span.attributes['tayzu.catalog.blueprint.identifier'] === '_user',
      );
    expect(
      userSpans.length,
      'the writes produced catalog spans of the _user blueprint',
    ).toBeGreaterThan(0);
    for (const span of userSpans) {
      expect(span.attributes['tayzu.catalog.entity.identifier'], span.name).toBe(
        USER_ENTITY_IDENTIFIER_PLACEHOLDER,
      );
    }

    const audits = [...harness.logExporter.getFinishedLogRecords()].filter(
      (record) =>
        !logsBefore.has(record) &&
        record.eventName === 'catalog.audit.mutation' &&
        record.attributes['tayzu.catalog.blueprint.identifier'] === '_user',
    );
    expect(audits.length, 'the writes produced catalog.audit.mutation events').toBeGreaterThan(0);
    for (const record of audits) {
      expect(record.attributes['tayzu.catalog.resource.identifier']).toBe(
        USER_ENTITY_IDENTIFIER_PLACEHOLDER,
      );
    }

    const entityChecks = checked
      .slice(checksBefore)
      .flatMap(
        (request) =>
          (request as { resources?: { resource: { kind: string; id: string } }[] }).resources ?? [],
      )
      .filter((entry) => entry.resource.kind === 'catalog_entity');
    expect(entityChecks.length, 'the writes made catalog_entity checks').toBeGreaterThan(0);
    expect(
      entityChecks.some((entry) => entry.resource.id === USER_ENTITY_IDENTIFIER_PLACEHOLDER),
      'a _user entity is checked with the placeholder as its resource id',
    ).toBe(true);

    await expectNoLeak({ 'invited email': email });
  }, 120_000);

  /**
   * 045 task 9.2, spec scenario "The organization name never reaches telemetry": GIVEN an
   * organization named with a marker string; WHEN it is deleted, reversed or purged; THEN the
   * marker appears in no exported span, metric or log attribute. One organization per
   * operation, each named with its own marker, through the real request (the identity router),
   * the reversal script (`tayzu_deletion_admin`) and the purge (`tayzu_purge`). The malformed
   * tenant id of an `invalid_tenant` reversal is a marker too: it failed the shape check, so it
   * is untrusted input that no signal may carry (design: the tenant is absent for
   * `invalid_tenant`).
   */
  it('The organization name never reaches telemetry: a request, a reversal and a purge', async () => {
    const router = routerWith(gateWith(teeTo(createNonSendingEmailSender())));
    const telemetry = { shutdown: () => harness.forceFlush() };
    const operatorId = `gh:${String(randomInt(1, 1_000_000_000))}`;
    const env = { ...ORG_DELETION_REVERSAL_ENV, TAYZU_OPERATOR_ID: operatorId };

    async function markerOrganization(label: string) {
      const name = `OrgNameMarker-${label}-${randomUUID()}`;
      const id = randomUUID();
      const tenant = await bootstrapTestTenant(app.auth, {
        pool: testAppPool(),
        name: `Marker ${label}`,
        email: `idmarker-org-${label}-${id}@example.test`,
        password: TEST_PASSWORD,
        organizationName: name,
        organizationSlug: `idmarker-org-${id}`,
        ip: randomIp(),
      });
      const requested = await router.identity.organization.delete(
        { query: { confirmation: tenant.organizationId } },
        { context: adminContext(tenant) },
      );
      return { tenant, name, requested };
    }

    // The request.
    const deleted = await markerOrganization('deleted');

    // The reversal of a request, and a refused one on a malformed tenant id.
    const reversed = await markerOrganization('reversed');
    const cancelled = await cancelOrgDeletionMain({
      tenantId: reversed.tenant.organizationId,
      env,
      pool: (await getDeletionAdminTestDatabase()).pool,
      telemetry,
    });
    expect(cancelled).toEqual({ outcome: 'cancelled' });
    const malformed = `OrgNameMarker invalid ${randomUUID()}`;
    const refused = await cancelOrgDeletionMain({
      tenantId: malformed,
      env,
      pool: (await getDeletionAdminTestDatabase()).pool,
      telemetry,
    });
    expect(refused).toEqual({ outcome: 'refused', reason: 'invalid_tenant' });

    // The purge of a request whose window has passed (both dates move together: the window
    // CHECK of `0012` still holds).
    const purged = await markerOrganization('purged');
    await pools.authPool.query(
      `update tenant_deletion_marker
          set requested_at = requested_at - interval '15 days',
              purge_after = purge_after - interval '15 days'
        where tenant_id = $1 and state = 'pending'`,
      [purged.tenant.organizationId],
    );
    await runPurge({
      pool: (await getPurgeTestDatabase()).pool,
      tenantIds: [purged.tenant.organizationId],
      telemetry,
    });
    const { rows } = await pools.authPool.query<{ state: string }>(
      'select state::text as state from tenant_deletion_marker where tenant_id = $1',
      [purged.tenant.organizationId],
    );
    expect(
      rows.map((row) => row.state),
      'the marker organization was purged',
    ).toEqual(['purged']);

    await expectNoLeak(
      {
        'deleted organization name': deleted.name,
        'reversed organization name': reversed.name,
        'purged organization name': purged.name,
        'malformed tenant id': malformed,
      },
      {
        request: deleted.requested,
        'reversed request': reversed.requested,
        'purged request': purged.requested,
        cancellation: cancelled,
        refusal: refused,
      },
    );
  }, 120_000);
});
