/**
 * Task 14.6 of openspec/changes/043-identity-lifecycle-and-org-admin (design D10:
 * "`{user}` is the `_user` entity identifier (an email, or `svc-…`), sent unencoded
 * because `@` is legal in a path segment (Resolved decision Q12) ... and a path
 * containing `%` is a 404 (`002` Q74)").
 *
 * Task 14.6 Verify: "`user-path.http.int.test.ts` covers `PUT /v1/users/{email}/status`
 * and `PUT /v1/users/svc-ci-github/status` resolving, and a `%` path being 404,
 * including the `a%40b` that oRPC's generated client sends (a known limitation,
 * recorded in the "Email in the `{user}` path" ticket)."
 *
 * ## Harness
 *
 * `createApp` with the identity routes mounted over the harness pools, driven by
 * Fastify injection with a fresh random `x-forwarded-for` per request and a fresh
 * tenant (MFA-enrolled admin with a fresh MFA marker) per test.
 *
 * ## Production symbols expected
 *
 * None new: `createApp` options `mountIdentityRoutes` and `identity` (`./server.js`).
 */
import { randomInt, randomUUID } from 'node:crypto';

import { createRecordingEmailSender } from '@tayzu/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bootstrapTestTenant,
  createAdminUser,
  testAppPool,
  type BootstrappedTenant,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { csrfHeaders } from './__fixtures__/csrf.js';
import { enrolledAdminSession } from './__fixtures__/fresh-mfa.js';
import { harnessPools, type HarnessPools } from './__fixtures__/pools.js';
import { createEmailTenantGate } from './identity/email-tenant-gate.js';
import { createInMemoryEmailCapStore } from './identity/invitation-caps.js';
import { createApp, type App } from './server.js';

const ORIGIN = 'https://app.tayzu.test';
const SERVICE_IDENTIFIER = 'svc-ci-github';

interface AccountApiSurface {
  addMember(args: {
    body: { userId: string; organizationId: string; role: 'member' | 'admin' };
  }): Promise<unknown>;
}

interface Answer {
  readonly status: number;
  readonly body: string;
  readonly code: unknown;
}

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

describe('the {user} path segment over HTTP (task 14.6)', () => {
  let app: App;
  let pools: HarnessPools;

  beforeAll(async () => {
    pools = await harnessPools();
    app = await createApp({
      ...pools,
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ORIGIN],
      ...{
        mountIdentityRoutes: true,
        identity: {
          emailGate: createEmailTenantGate({
            disabledTenantIds: [],
            recipientKeySecret: TEST_SECRET,
            capStore: createInMemoryEmailCapStore({
              tenant: { max: 20, windowSeconds: 3600 },
              recipient: { max: 20, windowSeconds: 3600 },
            }),
            sender: createRecordingEmailSender(),
          }),
          invitationLinkBaseUrl: ORIGIN,
        },
      },
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
  }, 60_000);

  async function freshAdmin(): Promise<BootstrappedTenant> {
    const suffix = randomUUID();
    const tenant = await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: 'User Path Admin',
      email: `user-path-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `User Path Org ${suffix}`,
      organizationSlug: `user-path-${suffix}`,
      ip: randomIp(),
    });
    return await enrolledAdminSession(app, tenant, { password: TEST_PASSWORD, origin: ORIGIN });
  }

  async function send(
    cookie: string,
    method: 'POST' | 'PUT',
    url: string,
    body: Record<string, unknown>,
  ): Promise<Answer> {
    const response = await app.app.inject({
      method,
      url,
      headers: {
        cookie,
        origin: ORIGIN,
        'x-forwarded-for': randomIp(),
        ...csrfHeaders(method),
        'content-type': 'application/json',
      },
      payload: JSON.stringify(body),
    });
    let code: unknown;
    try {
      code = response.json<{ code?: unknown }>().code;
    } catch {
      // A non-JSON body leaves the code undefined.
    }
    return { status: response.statusCode, body: response.body, code };
  }

  /** A member of the admin's organization, with an email that holds `@`. */
  async function memberOf(admin: BootstrappedTenant): Promise<string> {
    const created = await createAdminUser(app.auth, {
      name: 'User Path Member',
      email: `member-${randomUUID()}@example.test`,
      password: TEST_PASSWORD,
    });
    await (app.auth.api as AccountApiSurface).addMember({
      body: { userId: created.userId, organizationId: admin.organizationId, role: 'member' },
    });
    return created.email;
  }

  it('PUT /v1/users/{email}/status resolves with the email sent unencoded', async () => {
    const admin = await freshAdmin();
    const email = await memberOf(admin);
    const answer = await send(admin.cookie, 'PUT', `/v1/users/${email}/status`, {
      status: 'Disabled',
    });
    expect(answer.status, answer.body).toBeLessThan(300);
  }, 120_000);

  it('PUT /v1/users/svc-ci-github/status resolves for a service account', async () => {
    const admin = await freshAdmin();
    const created = await send(admin.cookie, 'POST', '/v1/service-accounts', {
      identifier: SERVICE_IDENTIFIER,
    });
    expect(created.status, created.body).toBeLessThan(300);
    const answer = await send(admin.cookie, 'PUT', `/v1/users/${SERVICE_IDENTIFIER}/status`, {
      status: 'Disabled',
    });
    expect(answer.status, answer.body).toBeLessThan(300);
  }, 120_000);

  it('a path containing % is 404, including the a%40b of the generated client', async () => {
    const admin = await freshAdmin();
    const email = await memberOf(admin);
    for (const segment of ['a%40b', encodeURIComponent(email), `svc%2Dci-github`]) {
      const answer = await send(admin.cookie, 'PUT', `/v1/users/${segment}/status`, {
        status: 'Disabled',
      });
      expect(answer.status, `${segment}: ${answer.body}`).toBe(404);
    }
    // The encoded attempts changed nothing: the same member still resolves unencoded.
    const resolved = await send(admin.cookie, 'PUT', `/v1/users/${email}/status`, {
      status: 'Disabled',
    });
    expect(resolved.status, resolved.body).toBeLessThan(300);
  }, 120_000);
});
