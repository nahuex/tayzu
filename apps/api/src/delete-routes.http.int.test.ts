/**
 * Task 14.6b of openspec/changes/043-identity-lifecycle-and-org-admin (design D10 and
 * task 14.1: every identity route declares `inputStructure: 'detailed'`; the two
 * `DELETE` routes carry their target in the path and no body; Resolved decisions Q31
 * and Q62: a foreign, a human-for-a-service-account and an unknown target look alike).
 *
 * Task 14.6b Verify: "`delete-routes.http.int.test.ts` covers each `DELETE` route
 * reading its target from the path, and a foreign or unknown target answering the same
 * `CATALOG_NOT_FOUND` with nothing changed."
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
const SSO_PROVIDER = 'visma-connect';

type Method = 'POST' | 'PUT' | 'DELETE';

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

describe('the DELETE identity routes read their target from the path (task 14.6b)', () => {
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
      name: 'Delete Routes Admin',
      email: `delete-routes-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Delete Routes Org ${suffix}`,
      organizationSlug: `delete-routes-${suffix}`,
      ip: randomIp(),
    });
    return await enrolledAdminSession(app, tenant, { password: TEST_PASSWORD, origin: ORIGIN });
  }

  async function send(
    cookie: string,
    method: Method,
    url: string,
    body?: Record<string, unknown>,
  ): Promise<Answer> {
    const response = await app.app.inject({
      method,
      url,
      headers: {
        cookie,
        origin: ORIGIN,
        'x-forwarded-for': randomIp(),
        ...csrfHeaders(method),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    let code: unknown;
    try {
      code = response.json<{ code?: unknown }>().code;
    } catch {
      // A non-JSON body leaves the code undefined.
    }
    return { status: response.statusCode, body: response.body, code };
  }

  function serviceIdentifier(): string {
    return `svc-del-${randomUUID().slice(0, 8)}`;
  }

  async function createServiceAccount(admin: BootstrappedTenant): Promise<string> {
    const identifier = serviceIdentifier();
    const created = await send(admin.cookie, 'POST', '/v1/service-accounts', { identifier });
    expect(created.status, created.body).toBeLessThan(300);
    return identifier;
  }

  /**
   * Whether the admin's tenant still resolves the entity. The probe sets the status the
   * entity already has, so an existing target answers a rejected transition (400) and
   * nothing is changed by the probe; only a missing one answers 404.
   */
  async function resolves(admin: BootstrappedTenant, identifier: string): Promise<boolean> {
    const answer = await send(admin.cookie, 'PUT', `/v1/users/${identifier}/status`, {
      status: 'Active',
    });
    if (answer.status === 404) {
      expect(answer.code).toBe('CATALOG_NOT_FOUND');
      return false;
    }
    expect(answer.status, answer.body).toBeLessThan(500);
    return true;
  }

  /** A member of the admin's organization with a password and a linked SSO account. */
  async function linkedMemberOf(admin: BootstrappedTenant): Promise<{ email: string; id: string }> {
    const created = await createAdminUser(app.auth, {
      name: 'Delete Routes Member',
      email: `member-${randomUUID()}@example.test`,
      password: TEST_PASSWORD,
    });
    await (app.auth.api as AccountApiSurface).addMember({
      body: { userId: created.userId, organizationId: admin.organizationId, role: 'member' },
    });
    await pools.authPool.query(
      `insert into auth.account (id, account_id, provider_id, user_id, created_at, updated_at)
       values ($1, $2, $3, $4, now(), now())`,
      [randomUUID(), `sub-${randomUUID()}`, SSO_PROVIDER, created.userId],
    );
    return { email: created.email, id: created.userId };
  }

  async function ssoLinkCount(userId: string): Promise<number> {
    const result = await pools.authPool.query<{ n: string }>(
      'select count(*)::text as n from auth.account where user_id = $1 and provider_id = $2',
      [userId, SSO_PROVIDER],
    );
    return Number(result.rows[0]?.n ?? '0');
  }

  it('DELETE /v1/service-accounts/{user} deletes the service account named in the path', async () => {
    const admin = await freshAdmin();
    const target = await createServiceAccount(admin);
    const bystander = await createServiceAccount(admin);

    const answer = await send(admin.cookie, 'DELETE', `/v1/service-accounts/${target}`);
    expect(answer.status, answer.body).toBeLessThan(300);

    expect(await resolves(admin, target)).toBe(false);
    expect(await resolves(admin, bystander)).toBe(true);
  }, 120_000);

  it('DELETE /v1/users/{user}/sso-account unlinks the account of the user named in the path', async () => {
    const admin = await freshAdmin();
    const target = await linkedMemberOf(admin);
    const bystander = await linkedMemberOf(admin);

    const answer = await send(admin.cookie, 'DELETE', `/v1/users/${target.email}/sso-account`);
    expect(answer.status, answer.body).toBeLessThan(300);

    expect(await ssoLinkCount(target.id)).toBe(0);
    expect(await ssoLinkCount(bystander.id)).toBe(1);
  }, 120_000);

  it('DELETE /v1/service-accounts/{user}: a foreign or unknown target answers the same CATALOG_NOT_FOUND and nothing changes', async () => {
    const owner = await freshAdmin();
    const other = await freshAdmin();
    const target = await createServiceAccount(owner);

    const foreign = await send(other.cookie, 'DELETE', `/v1/service-accounts/${target}`);
    const unknown = await send(
      other.cookie,
      'DELETE',
      `/v1/service-accounts/${serviceIdentifier()}`,
    );
    expect(foreign.status).toBe(404);
    expect(foreign.code).toBe('CATALOG_NOT_FOUND');
    expect(unknown.status).toBe(404);
    expect(unknown.code).toBe('CATALOG_NOT_FOUND');
    expect(foreign.body).toBe(unknown.body);

    // Nothing changed for the owner.
    expect(await resolves(owner, target)).toBe(true);
  }, 120_000);

  it('DELETE /v1/service-accounts/{user}: a human user of the tenant answers like an unknown target', async () => {
    const admin = await freshAdmin();
    const member = await linkedMemberOf(admin);

    const human = await send(admin.cookie, 'DELETE', `/v1/service-accounts/${member.email}`);
    const unknown = await send(
      admin.cookie,
      'DELETE',
      `/v1/service-accounts/${serviceIdentifier()}`,
    );
    expect(human.status).toBe(404);
    expect(human.code).toBe('CATALOG_NOT_FOUND');
    expect(human.body).toBe(unknown.body);
    expect(await resolves(admin, member.email)).toBe(true);
  }, 120_000);

  it('DELETE /v1/users/{user}/sso-account: a foreign or unknown target answers the same CATALOG_NOT_FOUND and nothing changes', async () => {
    const owner = await freshAdmin();
    const other = await freshAdmin();
    const target = await linkedMemberOf(owner);

    const foreign = await send(other.cookie, 'DELETE', `/v1/users/${target.email}/sso-account`);
    const unknown = await send(
      other.cookie,
      'DELETE',
      `/v1/users/nobody-${randomUUID()}@example.test/sso-account`,
    );
    expect(foreign.status).toBe(404);
    expect(foreign.code).toBe('CATALOG_NOT_FOUND');
    expect(unknown.status).toBe(404);
    expect(unknown.code).toBe('CATALOG_NOT_FOUND');
    expect(foreign.body).toBe(unknown.body);

    // The link of the owner's member is untouched.
    expect(await ssoLinkCount(target.id)).toBe(1);
  }, 120_000);
});
