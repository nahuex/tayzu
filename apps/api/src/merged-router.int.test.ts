/**
 * Task 14.1 of openspec/changes/043-identity-lifecycle-and-org-admin (design D10
 * "API contract").
 *
 * Task 14.1 Verify (the part of this file): "`merged-router.int.test.ts` covers
 * one handler serving a catalog route and an identity route, the step-up
 * interceptor and the error mapping applying to both, and a `Retry-After` set
 * through `ResponseHeadersPlugin` on an identity 429 and absent from a catalog
 * answer."
 *
 * D10: `createApp` merges the identity router with the catalog router into
 * **one** router handed to the one `OpenAPIHandler` of `server.ts`, so the
 * interceptor chain (step-up, the error mapping, `ResponseHeadersPlugin`) reaches
 * both and no second handler exists. The switch that keeps the routes off by
 * default is task 14.3, not this task: here the merged routes are reachable
 * through `createApp`.
 *
 * ## Harness
 *
 * `createApp` over the real pools, Cerbos and Better Auth, driven with
 * `app.app.inject`. Each test bootstraps its own tenant (fresh organization, a
 * random email) and an MFA-enrolled admin (`enrolledAdminSession`); a session
 * without a fresh verification is that session with its
 * `step-up-verified:<token>` row deleted (the pattern of
 * `bootstrap-wiring.int.test.ts`). Every mutating call carries the CSRF header.
 * The identity 429 is the invitation tenant cap (D5, 6.6): the email gate's cap
 * store is configured with a tenant maximum of zero, so the first `invite`
 * answers `AUTH_RATE_LIMITED` with a `Retry-After` of one hour.
 *
 * ## Production symbols expected
 *
 * - `createApp` (`./server.js`) merges the identity router (`createIdentityRouter`
 *   of `./identity-router.js`) with the catalog router into the single router of
 *   its one `OpenAPIHandler`, and builds the identity router from its own pools,
 *   Cerbos client, Better Auth instance and Q30 adapter.
 * - `CreateAppOptions.identity?: { emailGate?: EmailTenantGate;
 *   invitationLinkBaseUrl?: string }` (new): the email path of the invitation
 *   operations, which the host builds from configuration (the same two options
 *   `createIdentityRouter` already has). The test passes it through a spread so
 *   that this file type-checks before the option exists.
 *
 * ## Why this fails right now
 *
 * `createApp` mounts only the catalog router, so every identity route answers
 * like an unknown path (an assertion failure on the status).
 */
// Load-bearing import order (design D1): the telemetry harness registers
// before anything that loads `@tayzu/auth` creates its logger.
import './__fixtures__/link-telemetry.js';
import { randomInt, randomUUID } from 'node:crypto';

import { createRecordingEmailSender } from '@tayzu/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import {
  bootstrapTestTenant,
  testAppPool,
  type BootstrappedTenant,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { csrfHeaders } from './__fixtures__/csrf.js';
import {
  enrolledAdminSession,
  freshMfaSessionCookie,
  sessionTokenOfCookie,
} from './__fixtures__/fresh-mfa.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createEmailTenantGate } from './identity/email-tenant-gate.js';
import { createInMemoryEmailCapStore } from './identity/invitation-caps.js';
import { createApp, type App } from './server.js';

const TEST_PASSWORD = 'correct horse battery staple';
const ORIGIN = 'https://app.tayzu.test';
const LINK_BASE_URL = 'https://app.tayzu.test';
const CREDENTIALS_PATH = '/v1/credentials';

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

interface ErrorBody {
  readonly code: string;
  readonly status: number;
}

describe('the identity router is merged with the catalog router into one handler (task 14.1, design D10)', () => {
  let app: App;
  let authPool: Pool;

  beforeAll(async () => {
    const pools = await harnessPools();
    authPool = pools.authPool;
    // The tenant cap is zero: the first invitation email is refused with the cap's `Retry-After`.
    const capStore = createInMemoryEmailCapStore({
      tenant: { max: 0, windowSeconds: 3600 },
      recipient: { max: 1000, windowSeconds: 86_400 },
    });
    app = await createApp({
      ...pools,
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ORIGIN],
      // Spread so this file type-checks before `CreateAppOptions.identity` exists.
      ...{
        // Task 14.3: the identity routes are off by default; this file exercises them.
        mountIdentityRoutes: true,
        identity: {
          emailGate: createEmailTenantGate({
            disabledTenantIds: [],
            capStore,
            sender: createRecordingEmailSender(),
          }),
          invitationLinkBaseUrl: LINK_BASE_URL,
        },
      },
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
  }, 60_000);

  async function provisionTenant(): Promise<BootstrappedTenant> {
    const suffix = randomUUID();
    return bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: 'Merged Router Admin',
      email: `merged-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Merged Org ${suffix}`,
      organizationSlug: `merged-org-${suffix}`,
      ip: randomIp(),
    });
  }

  /** An MFA-enrolled admin whose session carries a fresh verification. */
  async function freshAdminCookie(): Promise<string> {
    const tenant = await provisionTenant();
    return freshMfaSessionCookie(app, {
      email: tenant.email,
      password: TEST_PASSWORD,
      enrollmentCookie: tenant.cookie,
      origin: ORIGIN,
    });
  }

  /** An MFA-enrolled admin whose session has no fresh verification. */
  async function staleAdminCookie(): Promise<string> {
    const tenant = await enrolledAdminSession(app, await provisionTenant(), {
      password: TEST_PASSWORD,
      origin: ORIGIN,
    });
    await authPool.query('delete from auth.verification where identifier = $1', [
      `step-up-verified:${sessionTokenOfCookie(tenant.cookie)}`,
    ]);
    return tenant.cookie;
  }

  function send(
    cookie: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    body?: unknown,
  ) {
    return app.app.inject({
      method,
      url,
      headers: {
        cookie,
        origin: ORIGIN,
        ...csrfHeaders(method),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  }

  it('one handler serves a catalog route and an identity route for the same session', async () => {
    const cookie = await freshAdminCookie();

    const catalog = await send(cookie, 'GET', '/v1/blueprints');
    const identity = await send(cookie, 'GET', CREDENTIALS_PATH);

    expect(catalog.statusCode, 'the catalog route is served').toBe(200);
    expect(identity.statusCode, 'the identity route is served by the same handler').toBe(200);
    expect(identity.json<{ credentials: unknown[] }>().credentials).toEqual([]);
  }, 60_000);

  it('the step-up interceptor applies to a catalog route and to an identity route', async () => {
    const cookie = await staleAdminCookie();

    // A high-risk catalog route and a high-risk identity route, both without a fresh verification.
    const catalog = await send(
      cookie,
      'DELETE',
      `/v1/blueprints/step-up-${randomUUID().slice(0, 8)}`,
    );
    const identity = await send(
      cookie,
      'PUT',
      `/v1/users/nobody-${randomUUID()}@example.test/status`,
      {
        status: 'Disabled',
      },
    );

    for (const response of [catalog, identity]) {
      expect(response.statusCode).toBe(403);
      expect(response.json<ErrorBody>().code).toBe('AUTH_STEP_UP_REQUIRED');
    }
    // The interceptor runs only on high-risk routes: a read-only identity route is still served.
    expect((await send(cookie, 'GET', CREDENTIALS_PATH)).statusCode).toBe(200);
  }, 60_000);

  it('the error mapping applies to a catalog route and to an identity route', async () => {
    const cookie = await freshAdminCookie();

    const catalog = await send(cookie, 'GET', `/v1/blueprints/missing-${randomUUID().slice(0, 8)}`);
    const identity = await send(cookie, 'POST', `/v1/users/invitations/${randomUUID()}/cancel`);

    for (const response of [catalog, identity]) {
      expect(response.statusCode).toBe(404);
      expect(response.json<ErrorBody>().code).toBe('CATALOG_NOT_FOUND');
      expect(response.json<ErrorBody>().status).toBe(404);
    }
  }, 60_000);

  it('Retry-After is set through ResponseHeadersPlugin on an identity 429 and absent from a catalog answer', async () => {
    const cookie = await freshAdminCookie();

    // The tenant cap is zero, so the invitation is refused as rate limited.
    const limited = await send(cookie, 'POST', '/v1/users/invitations', {
      email: `limited-${randomUUID()}@example.test`,
      role: 'member',
    });

    expect(limited.statusCode).toBe(429);
    expect(limited.json<ErrorBody>().code).toBe('AUTH_RATE_LIMITED');
    expect(limited.headers['retry-after']).toBe('3600');

    // A catalog error and a catalog success carry no such header.
    const catalogError = await send(
      cookie,
      'GET',
      `/v1/blueprints/missing-${randomUUID().slice(0, 8)}`,
    );
    const catalogOk = await send(cookie, 'GET', '/v1/blueprints');
    expect(catalogError.statusCode).toBe(404);
    expect(catalogError.headers['retry-after']).toBeUndefined();
    expect(catalogOk.statusCode).toBe(200);
    expect(catalogOk.headers['retry-after']).toBeUndefined();
  }, 60_000);
});
