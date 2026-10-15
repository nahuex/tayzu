/**
 * Task 14.8 of openspec/changes/archive/2026-10-14-043-identity-lifecycle-and-org-admin (the HTTP twin of the
 * in-process cross-tenant matrix, tasks 12.1, 12.5, 12.6 and 12.9; spec requirement
 * "Targets belong to the caller's tenant": every target MUST belong to the host's `tenantId`,
 * otherwise `CATALOG_NOT_FOUND`, identical to a nonexistent id; Resolved decisions Q25, Q31, Q62).
 *
 * Task 14.8 Verify: "`cross-tenant.http.int.test.ts` covers one request per route over the
 * mounted server, compares each response of a route with a target of `t2` to the unknown-id
 * response, and for the target-less routes (invite, `users.create`, `serviceAccounts.create`,
 * `credentials.list`) asserts that the write lands only in `t1` and that the list omits `t2`'s
 * credentials."
 *
 * ## Harness
 *
 * `createApp` with the identity routes mounted over the harness pools (same wiring as
 * `delete-routes.http.int.test.ts`), driven by Fastify injection with a fresh random
 * `x-forwarded-for` per request. Two fresh tenants per test (an MFA-enrolled admin with a fresh MFA
 * marker each). Every `t2` fixture is created over HTTP by `t2`'s admin; `t1`'s admin calls.
 *
 * ## Production symbols expected
 *
 * None new: `createApp` options `mountIdentityRoutes` and `identity` (`./server.js`). The behavior
 * already exists; these tests are expected to pass on arrival (a regression guard).
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
const ACCEPT_PATH = '/v1/auth/invitations/accept';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

interface AccountApiSurface {
  addMember(args: {
    body: { userId: string; organizationId: string; role: 'member' | 'admin' };
  }): Promise<unknown>;
}

interface Answer {
  readonly status: number;
  readonly body: string;
  readonly code: unknown;
  readonly json: Record<string, unknown>;
}

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

describe('cross-tenant requests over HTTP, called by the admin of t1 (task 14.8)', () => {
  let app: App;
  let pools: HarnessPools;
  let sender: ReturnType<typeof createRecordingEmailSender>;

  beforeAll(async () => {
    pools = await harnessPools();
    sender = createRecordingEmailSender();
    app = await createApp({
      ...pools,
      authSecret: TEST_SECRET,
      cerbosAddress: 'localhost:3593',
      allowedOrigins: [ORIGIN],
      ...{
        mountIdentityRoutes: true,
        ...{ identityTokenHmacSecret: 'mount-wiring-test-only-secret-0123456789-abcdef' },
        identity: {
          emailGate: createEmailTenantGate({
            disabledTenantIds: [],
            recipientKeySecret: TEST_SECRET,
            capStore: createInMemoryEmailCapStore({
              tenant: { max: 100, windowSeconds: 3600 },
              recipient: { max: 100, windowSeconds: 3600 },
            }),
            sender,
          }),
          invitationLinkBaseUrl: ORIGIN,
        },
      },
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
  }, 60_000);

  async function freshAdmin(label: string): Promise<BootstrappedTenant> {
    const suffix = randomUUID();
    const tenant = await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: `Cross Tenant Http ${label}`,
      email: `cross-http-${label}-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Cross Http ${label} ${suffix}`,
      organizationSlug: `cross-http-${label}-${suffix}`,
      ip: randomIp(),
    });
    return await enrolledAdminSession(app, tenant, { password: TEST_PASSWORD, origin: ORIGIN });
  }

  async function twoTenants(): Promise<{ t1: BootstrappedTenant; t2: BootstrappedTenant }> {
    const t1 = await freshAdmin('t1');
    const t2 = await freshAdmin('t2');
    return { t1, t2 };
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
    let json: Record<string, unknown> = {};
    try {
      json = response.json<Record<string, unknown>>();
    } catch {
      // A non-JSON body leaves the object empty.
    }
    return { status: response.statusCode, body: response.body, code: json['code'], json };
  }

  function ok(answer: Answer): void {
    expect(answer.status, answer.body).toBeGreaterThanOrEqual(200);
    expect(answer.status, answer.body).toBeLessThan(300);
  }

  /** A foreign target answers exactly like an unknown one: 404 `CATALOG_NOT_FOUND`, same body. */
  function expectLikeUnknown(foreign: Answer, unknown: Answer): void {
    expect(unknown.status, unknown.body).toBe(404);
    expect(unknown.code).toBe('CATALOG_NOT_FOUND');
    expect(foreign.status, foreign.body).toBe(404);
    expect(foreign.code).toBe('CATALOG_NOT_FOUND');
    expect(foreign.body, 'same body as the unknown id').toBe(unknown.body);
  }

  async function invite(admin: BootstrappedTenant, email: string): Promise<string> {
    const answer = await send(admin.cookie, 'POST', '/v1/users/invitations', {
      email,
      role: 'member',
    });
    ok(answer);
    const id = answer.json['invitationId'];
    if (typeof id !== 'string') throw new Error(`no invitationId in ${answer.body}`);
    return id;
  }

  function tokenSentTo(email: string): string {
    const template = sender.sent.find((message) => message.to === email)?.template;
    if (template?.kind !== 'InvitationEmail') throw new Error('the invitation email was not sent');
    return new URLSearchParams(new URL(template.link).hash.slice(1)).get('token') ?? '';
  }

  function emailsTo(email: string): number {
    return sender.sent.filter((message) => message.to === email).length;
  }

  async function createServiceAccount(admin: BootstrappedTenant): Promise<string> {
    const identifier = `svc-x14-${randomUUID().slice(0, 8)}`;
    ok(await send(admin.cookie, 'POST', '/v1/service-accounts', { identifier }));
    return identifier;
  }

  async function createCredential(admin: BootstrappedTenant): Promise<string> {
    const answer = await send(admin.cookie, 'POST', '/v1/credentials', {
      name: 'Cross tenant credential',
      kind: 'integration',
    });
    ok(answer);
    const id = answer.json['id'];
    if (typeof id !== 'string') throw new Error(`no credential id in ${answer.body}`);
    return id;
  }

  async function memberOfTenant(admin: BootstrappedTenant): Promise<string> {
    const created = await createAdminUser(app.auth, {
      name: 'Cross Http Member',
      email: `cross-http-member-${randomUUID()}@example.test`,
      password: TEST_PASSWORD,
    });
    await (app.auth.api as AccountApiSurface).addMember({
      body: { userId: created.userId, organizationId: admin.organizationId, role: 'member' },
    });
    return created.email;
  }

  async function invitationRow(id: string): Promise<unknown> {
    const result = await pools.authPool.query<Record<string, unknown>>(
      'select * from auth.invitation where id = $1',
      [id],
    );
    const verification = await pools.authPool.query<Record<string, unknown>>(
      'select * from auth.verification where identifier = $1',
      [`invitation-accept:${id}`],
    );
    return { invitation: result.rows, verification: verification.rows };
  }

  async function keys(tenantId: string): Promise<readonly { id: string; enabled: boolean }[]> {
    const result = await pools.authPool.query<{ id: string; enabled: boolean }>(
      'select id, enabled from auth.apikey where reference_id = $1 order by id',
      [tenantId],
    );
    return result.rows;
  }

  async function membersOf(tenantId: string): Promise<readonly string[]> {
    const result = await pools.authPool.query<{ user_id: string }>(
      'select user_id from auth.member where organization_id = $1 order by user_id',
      [tenantId],
    );
    return result.rows.map((row) => row.user_id);
  }

  async function accountsOf(email: string): Promise<readonly Record<string, unknown>[]> {
    const result = await pools.authPool.query<Record<string, unknown>>(
      `select a.* from auth.account a join auth."user" u on u.id = a.user_id
        where u.email = $1 order by a.id`,
      [email],
    );
    return result.rows;
  }

  // ---- Routes with a target ------------------------------------------------------------------

  it.each([['cancel'], ['resend']] as const)(
    "POST /v1/users/invitations/{invitation}/%s on t2's invitation answers like an unknown id and changes nothing",
    async (operation) => {
      const { t1, t2 } = await twoTenants();
      const email = `cross-http-${operation}-${randomUUID()}@example.test`;
      const invitationId = await invite(t2, email);
      const before = await invitationRow(invitationId);
      const emailsBefore = emailsTo(email);

      const foreign = await send(
        t1.cookie,
        'POST',
        `/v1/users/invitations/${invitationId}/${operation}`,
      );
      const unknown = await send(
        t1.cookie,
        'POST',
        `/v1/users/invitations/${randomUUID()}/${operation}`,
      );

      expectLikeUnknown(foreign, unknown);
      expect(await invitationRow(invitationId), 'invitation and token unchanged').toEqual(before);
      expect(emailsTo(email), 'no email sent').toBe(emailsBefore);
    },
    120_000,
  );

  it('PUT /v1/users/{user}/status on a user of t2 answers like an unknown user and changes nothing', async () => {
    const { t1, t2 } = await twoTenants();
    const email = await memberOfTenant(t2);

    const foreign = await send(t1.cookie, 'PUT', `/v1/users/${email}/status`, {
      status: 'Disabled',
    });
    const unknown = await send(
      t1.cookie,
      'PUT',
      `/v1/users/nobody-${randomUUID()}@example.test/status`,
      { status: 'Disabled' },
    );

    expectLikeUnknown(foreign, unknown);
    // t2's own admin still sees the user Active: probing with the status it already has is a
    // rejected transition (not a 404) and changes nothing.
    const probe = await send(t2.cookie, 'PUT', `/v1/users/${email}/status`, { status: 'Active' });
    expect(probe.status, probe.body).not.toBe(404);
    expect(probe.status, probe.body).toBeLessThan(500);
  }, 120_000);

  it('POST /v1/users/{user}/sso-account on a user of t2 answers like an unknown user and links nothing', async () => {
    const { t1, t2 } = await twoTenants();
    const email = await memberOfTenant(t2);
    const accountsBefore = await accountsOf(email);
    const subject = `sub-${randomUUID()}`;

    const foreign = await send(t1.cookie, 'POST', `/v1/users/${email}/sso-account`, { subject });
    const unknown = await send(
      t1.cookie,
      'POST',
      `/v1/users/nobody-${randomUUID()}@example.test/sso-account`,
      { subject },
    );

    expectLikeUnknown(foreign, unknown);
    expect(await accountsOf(email), 'accounts unchanged').toEqual(accountsBefore);
    const linked = await pools.authPool.query('select 1 from auth.account where account_id = $1', [
      subject,
    ]);
    expect(linked.rows, 'the sub was not linked').toHaveLength(0);
  }, 120_000);

  it('DELETE /v1/users/{user}/sso-account on a user of t2 answers like an unknown user and unlinks nothing', async () => {
    const { t1, t2 } = await twoTenants();
    const email = await memberOfTenant(t2);
    const subject = `sub-${randomUUID()}`;
    ok(await send(t2.cookie, 'POST', `/v1/users/${email}/sso-account`, { subject }));
    const accountsBefore = await accountsOf(email);

    const foreign = await send(t1.cookie, 'DELETE', `/v1/users/${email}/sso-account`);
    const unknown = await send(
      t1.cookie,
      'DELETE',
      `/v1/users/nobody-${randomUUID()}@example.test/sso-account`,
    );

    expectLikeUnknown(foreign, unknown);
    expect(await accountsOf(email), 'the link is intact').toEqual(accountsBefore);
  }, 120_000);

  it("DELETE /v1/service-accounts/{user} on t2's service account answers like an unknown id and deletes nothing", async () => {
    const { t1, t2 } = await twoTenants();
    const identifier = await createServiceAccount(t2);
    const keysBefore = await keys(t2.organizationId);

    const foreign = await send(t1.cookie, 'DELETE', `/v1/service-accounts/${identifier}`);
    const unknown = await send(
      t1.cookie,
      'DELETE',
      `/v1/service-accounts/svc-nobody-${randomUUID().slice(0, 8)}`,
    );

    expectLikeUnknown(foreign, unknown);
    expect(await keys(t2.organizationId), 'the credential is intact').toEqual(keysBefore);
    const probe = await send(t2.cookie, 'PUT', `/v1/users/${identifier}/status`, {
      status: 'Active',
    });
    expect(probe.status, 'the service account still resolves in t2').not.toBe(404);
  }, 120_000);

  it.each([['rotate'], ['revoke']] as const)(
    "POST /v1/credentials/{credential}/%s on t2's credential answers like an unknown id and leaves it enabled",
    async (operation) => {
      const { t1, t2 } = await twoTenants();
      const credentialId = await createCredential(t2);
      const t2Before = await keys(t2.organizationId);
      expect(t2Before.map((key) => key.id)).toEqual([credentialId]);

      const foreign = await send(t1.cookie, 'POST', `/v1/credentials/${credentialId}/${operation}`);
      const unknown = await send(t1.cookie, 'POST', `/v1/credentials/${randomUUID()}/${operation}`);

      expectLikeUnknown(foreign, unknown);
      expect(await keys(t2.organizationId), 'the credential is unchanged and enabled').toEqual(
        t2Before,
      );
      expect(t2Before[0]?.enabled).toBe(true);
      expect(await keys(t1.organizationId), 't1 gained no key').toEqual([]);
    },
    120_000,
  );

  it("POST /v1/credentials with a userId of t2's service account answers like an unknown userId and writes nothing", async () => {
    const { t1, t2 } = await twoTenants();
    const identifier = await createServiceAccount(t2);
    const t2Before = await keys(t2.organizationId);

    const foreign = await send(t1.cookie, 'POST', '/v1/credentials', {
      name: 'Cross tenant',
      kind: 'integration',
      userId: identifier,
    });
    const unknown = await send(t1.cookie, 'POST', '/v1/credentials', {
      name: 'Cross tenant',
      kind: 'integration',
      userId: `svc-nobody-${randomUUID().slice(0, 8)}`,
    });

    expectLikeUnknown(foreign, unknown);
    expect(await keys(t1.organizationId), 'nothing written to t1').toEqual([]);
    expect(await keys(t2.organizationId), 'nothing written to t2').toEqual(t2Before);
  }, 120_000);

  it("POST /v1/auth/invitations/accept with t1's session and a t2 invitation answers like an unknown invitation and creates no membership", async () => {
    const { t1, t2 } = await twoTenants();
    const email = `cross-http-accept-${randomUUID()}@example.test`;
    const invitationId = await invite(t2, email);
    const token = tokenSentTo(email);
    const before = await invitationRow(invitationId);
    const t1Members = await membersOf(t1.organizationId);
    const t2Members = await membersOf(t2.organizationId);

    const accept = async (body: Record<string, unknown>) =>
      await app.app.inject({
        method: 'POST',
        url: ACCEPT_PATH,
        headers: {
          cookie: t1.cookie,
          origin: ORIGIN,
          'x-forwarded-for': randomIp(),
          'content-type': 'application/json',
          ...csrfHeaders('POST'),
        },
        payload: JSON.stringify(body),
      });
    const foreign = await accept({ invitationId, token });
    const unknown = await accept({ invitationId: randomUUID(), token });

    expect(unknown.statusCode, unknown.body).toBe(404);
    expect(foreign.statusCode, foreign.body).toBe(404);
    expect(foreign.body, 'the uniform rejection').toBe(unknown.body);
    expect(await invitationRow(invitationId), 'the invitation is untouched').toEqual(before);
    expect(await membersOf(t1.organizationId), 't1 gained no member').toEqual(t1Members);
    expect(await membersOf(t2.organizationId), 't2 gained no member').toEqual(t2Members);
  }, 120_000);

  // ---- Routes without a target ---------------------------------------------------------------

  it('POST /v1/users/invitations lands only in t1 and rejects a body that names t2', async () => {
    const { t1, t2 } = await twoTenants();
    const email = `cross-http-invite-${randomUUID()}@example.test`;

    const invitationId = await invite(t1, email);

    const rows = await pools.authPool.query<{ id: string; organization_id: string }>(
      'select id, organization_id from auth.invitation where email = $1',
      [email],
    );
    expect(rows.rows).toEqual([{ id: invitationId, organization_id: t1.organizationId }]);

    const named = `cross-http-named-${randomUUID()}@example.test`;
    const rejected = await send(t1.cookie, 'POST', '/v1/users/invitations', {
      email: named,
      role: 'member',
      organizationId: t2.organizationId,
    });
    expect(rejected.status, rejected.body).toBe(400);
    expect(rejected.code).toBe('CATALOG_VALIDATION_FAILED');
    const none = await pools.authPool.query('select 1 from auth.invitation where email = $1', [
      named,
    ]);
    expect(none.rows, 'no invitation in either tenant').toHaveLength(0);
    expect(emailsTo(named)).toBe(0);
  }, 120_000);

  it('POST /v1/users writes only the host tenant', async () => {
    const { t1, t2 } = await twoTenants();
    const email = `cross-http-create-${randomUUID()}@example.test`;
    const t2Before = await membersOf(t2.organizationId);

    const created = await send(t1.cookie, 'POST', '/v1/users', {
      email,
      name: 'Cross Http Created',
      role: 'member',
    });
    ok(created);
    const userId = created.json['userId'];
    expect(typeof userId).toBe('string');

    const memberships = await pools.authPool.query<{ organization_id: string }>(
      'select organization_id from auth.member where user_id = $1',
      [userId],
    );
    expect(memberships.rows.map((row) => row.organization_id)).toEqual([t1.organizationId]);
    expect(await membersOf(t2.organizationId), 't2 gained no member').toEqual(t2Before);
    // t2's admin cannot see the user: the same 404 as an unknown one.
    const probe = await send(t2.cookie, 'PUT', `/v1/users/${email}/status`, { status: 'Active' });
    expect(probe.status, probe.body).toBe(404);
    expect(probe.code).toBe('CATALOG_NOT_FOUND');
  }, 120_000);

  it("POST /v1/service-accounts lands only in t1: the key is t1's and t2 neither has the entity nor a key", async () => {
    const { t1, t2 } = await twoTenants();
    const identifier = `svc-x14-${randomUUID().slice(0, 8)}`;
    const t2Before = await keys(t2.organizationId);

    const created = await send(t1.cookie, 'POST', '/v1/service-accounts', { identifier });
    ok(created);

    const t1Keys = await keys(t1.organizationId);
    expect(t1Keys.map((key) => key.id)).toEqual([created.json['clientId']]);
    expect(await keys(t2.organizationId), 'no key in t2').toEqual(t2Before);
    const inT1 = await send(t1.cookie, 'PUT', `/v1/users/${identifier}/status`, {
      status: 'Active',
    });
    expect(inT1.status, 'the entity is in t1').not.toBe(404);
    const inT2 = await send(t2.cookie, 'PUT', `/v1/users/${identifier}/status`, {
      status: 'Active',
    });
    expect(inT2.status, 'no entity in t2').toBe(404);
    expect(inT2.code).toBe('CATALOG_NOT_FOUND');
  }, 120_000);

  it("GET /v1/credentials omits t2's credentials and POST /v1/credentials writes only t1's referenceId", async () => {
    const { t1, t2 } = await twoTenants();
    const own = await createCredential(t1);
    const foreign = await createCredential(t2);

    const created = await send(t1.cookie, 'POST', '/v1/credentials', {
      name: 'Created in t1',
      kind: 'integration',
    });
    ok(created);
    const createdId = created.json['id'] as string;
    const stored = await pools.authPool.query<{ reference_id: string }>(
      'select reference_id from auth.apikey where id = $1',
      [createdId],
    );
    expect(stored.rows.map((row) => row.reference_id)).toEqual([t1.organizationId]);

    const listed = await send(t1.cookie, 'GET', '/v1/credentials');
    ok(listed);
    const ids = (listed.json['credentials'] as readonly { id: string }[]).map((c) => c.id).sort();
    expect(ids).toEqual([own, createdId].sort());
    expect(ids).not.toContain(foreign);
    expect(listed.body).not.toContain(foreign);

    const theirs = await send(t2.cookie, 'GET', '/v1/credentials');
    ok(theirs);
    expect((theirs.json['credentials'] as readonly { id: string }[]).map((c) => c.id)).toEqual([
      foreign,
    ]);
  }, 120_000);
});
