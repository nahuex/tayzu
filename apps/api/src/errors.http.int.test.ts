/**
 * Task 14.5 of openspec/changes/043-identity-lifecycle-and-org-admin (spec
 * "Conventions": reused error codes; "Invitation acceptance": "Acceptance errors do
 * not reveal which failure occurred" and "The accept route is rate-limited";
 * "Every cap answers with the same Retry-After"; design D10).
 *
 * Task 14.5 Verify: "`errors.http.int.test.ts` covers each over the mounted server,
 * the header on each 429, and that the accept route's rejections are all the same
 * 404."
 *
 * Each of: `AUTH_FORBIDDEN` is 403; `AUTH_STEP_UP_REQUIRED` is 403;
 * `AUTH_RATE_LIMITED` is 429 with a `Retry-After` header (the per-tenant and the
 * per-recipient invitation caps, and the accept route's limiter); a foreign or
 * unknown target is 404 `CATALOG_NOT_FOUND`; the accept route's rejections (unknown
 * invitation, wrong token, cancelled, expired) share one status, code and body.
 *
 * ## Harness
 *
 * `createApp` with the identity routes mounted over the harness pools, driven by
 * Fastify injection with a fresh random `x-forwarded-for` per request. The email
 * gate uses an in-memory cap store with a per-tenant cap of 2 and a per-recipient
 * cap of 1, so the caps are reached with a few invitations from fresh tenants; the
 * accept limiter is 2 per window per IP.
 *
 * ## Production symbols expected
 *
 * None new: `createApp` options `mountIdentityRoutes`, `identity.emailGate`,
 * `identity.invitationLinkBaseUrl` and `invitationAcceptRateLimit` (`./server.js`).
 */
import { randomInt, randomUUID } from 'node:crypto';

import { createRecordingEmailSender } from '@tayzu/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bootstrapTestTenant,
  createAdminUser,
  signInAdminUser,
  testAppPool,
  type BootstrappedTenant,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { csrfHeaders } from './__fixtures__/csrf.js';
import { enrolledAdminSession, sessionTokenOfCookie } from './__fixtures__/fresh-mfa.js';
import { harnessPools, type HarnessPools } from './__fixtures__/pools.js';
import { createEmailTenantGate } from './identity/email-tenant-gate.js';
import { createInMemoryEmailCapStore } from './identity/invitation-caps.js';
import { createApp, type App } from './server.js';

const ORIGIN = 'https://app.tayzu.test';
const ACCEPT_PATH = '/v1/auth/invitations/accept';
const ACCEPT_PASSWORD = 'Café-Mañana-Passäphrase-2026!';
const ACCEPT_LIMIT = 2;

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

interface Answer {
  readonly status: number;
  readonly body: string;
  readonly code: unknown;
  readonly retryAfter: string | undefined;
}

interface AccountApiSurface {
  addMember(args: {
    body: { userId: string; organizationId: string; role: 'member' | 'admin' };
  }): Promise<unknown>;
}

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

describe('error mapping over HTTP with the identity routes mounted (task 14.5)', () => {
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
        invitationAcceptRateLimit: { max: ACCEPT_LIMIT, window: 60 },
        identity: {
          emailGate: createEmailTenantGate({
            disabledTenantIds: [],
            recipientKeySecret: TEST_SECRET,
            capStore: createInMemoryEmailCapStore({
              tenant: { max: 2, windowSeconds: 3600 },
              recipient: { max: 1, windowSeconds: 3600 },
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

  /** An MFA-enrolled admin of a fresh tenant whose session carries a fresh MFA marker. */
  async function freshAdmin(): Promise<BootstrappedTenant> {
    const suffix = randomUUID();
    const tenant = await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: 'Errors Http Admin',
      email: `errors-http-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Errors Http Org ${suffix}`,
      organizationSlug: `errors-http-${suffix}`,
      ip: randomIp(),
    });
    return await enrolledAdminSession(app, tenant, { password: TEST_PASSWORD, origin: ORIGIN });
  }

  async function send(
    cookie: string | undefined,
    method: Method,
    url: string,
    body?: Record<string, unknown>,
    ip: string = randomIp(),
  ): Promise<Answer> {
    const response = await app.app.inject({
      method,
      url,
      headers: {
        ...(cookie === undefined ? {} : { cookie }),
        origin: ORIGIN,
        'x-forwarded-for': ip,
        ...csrfHeaders(method),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    let code: unknown;
    try {
      code = response.json<{ code?: unknown }>().code;
    } catch {
      // A non-JSON body leaves the code undefined, which fails the assertions.
    }
    const retryAfter = response.headers['retry-after'];
    return {
      status: response.statusCode,
      body: response.body,
      code,
      retryAfter: typeof retryAfter === 'string' ? retryAfter : undefined,
    };
  }

  async function invite(cookie: string, email: string): Promise<Answer> {
    return await send(cookie, 'POST', '/v1/users/invitations', { email, role: 'member' });
  }

  async function invitationIdOf(answer: Answer): Promise<string> {
    const id = (JSON.parse(answer.body) as { invitationId?: unknown }).invitationId;
    if (typeof id !== 'string') throw new Error(`no invitationId in ${answer.body}`);
    return id;
  }

  function tokenSentTo(email: string): string {
    const template = sender.sent.find((message) => message.to === email)?.template;
    if (template?.kind !== 'InvitationEmail') throw new Error('the invitation email was not sent');
    return new URLSearchParams(new URL(template.link).hash.slice(1)).get('token') ?? '';
  }

  it('AUTH_STEP_UP_REQUIRED is 403 over HTTP', async () => {
    const admin = await freshAdmin();
    await pools.authPool.query('delete from auth.verification where identifier = $1', [
      `step-up-verified:${sessionTokenOfCookie(admin.cookie)}`,
    ]);
    const answer = await invite(admin.cookie, `stepup-${randomUUID()}@example.test`);
    expect(answer.status).toBe(403);
    expect(answer.code).toBe('AUTH_STEP_UP_REQUIRED');
  }, 120_000);

  it('AUTH_FORBIDDEN is 403 over HTTP', async () => {
    const admin = await freshAdmin();
    const created = await createAdminUser(app.auth, {
      name: 'Errors Http Member',
      email: `errors-http-member-${randomUUID()}@example.test`,
      password: TEST_PASSWORD,
    });
    await (app.auth.api as AccountApiSurface).addMember({
      body: { userId: created.userId, organizationId: admin.organizationId, role: 'member' },
    });
    const member = await signInAdminUser(app.auth, {
      email: created.email,
      password: TEST_PASSWORD,
      ip: randomIp(),
    });
    // A password re-entry writes the `password` marker, which satisfies the guard for a user
    // with no factor, so the request reaches authorization, which refuses a member.
    const reentry = await app.app.inject({
      method: 'POST',
      url: '/api/auth/verify-password',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': randomIp(),
        origin: ORIGIN,
        host: 'localhost:3000',
        cookie: member.cookie,
      },
      payload: JSON.stringify({ password: TEST_PASSWORD }),
    });
    expect(reentry.statusCode, reentry.body).toBe(200);

    const answer = await invite(member.cookie, `forbidden-${randomUUID()}@example.test`);
    expect(answer.status).toBe(403);
    expect(answer.code).toBe('AUTH_FORBIDDEN');
  }, 120_000);

  it('an unknown target is 404 CATALOG_NOT_FOUND over HTTP', async () => {
    const admin = await freshAdmin();
    const cancel = await send(admin.cookie, 'POST', `/v1/users/invitations/${randomUUID()}/cancel`);
    expect(cancel.status).toBe(404);
    expect(cancel.code).toBe('CATALOG_NOT_FOUND');
    const status = await send(
      admin.cookie,
      'PUT',
      `/v1/users/nobody-${randomUUID()}@example.test/status`,
      { status: 'Disabled' },
    );
    expect(status.status).toBe(404);
    expect(status.code).toBe('CATALOG_NOT_FOUND');
  }, 120_000);

  it("a foreign target is 404 and looks exactly like an unknown one: another tenant's invitation", async () => {
    const owner = await freshAdmin();
    const other = await freshAdmin();
    const invited = await invite(owner.cookie, `foreign-${randomUUID()}@example.test`);
    expect(invited.status, invited.body).toBeLessThan(300);
    const invitationId = await invitationIdOf(invited);

    const foreign = await send(
      other.cookie,
      'POST',
      `/v1/users/invitations/${invitationId}/cancel`,
    );
    const unknown = await send(
      other.cookie,
      'POST',
      `/v1/users/invitations/${randomUUID()}/cancel`,
    );
    expect(foreign.status).toBe(404);
    expect(foreign.code).toBe('CATALOG_NOT_FOUND');
    expect(foreign.body).toBe(unknown.body);

    // Nothing changed for the owner.
    const row = await pools.authPool.query<{ status: string }>(
      'select status from auth.invitation where id = $1',
      [invitationId],
    );
    expect(row.rows[0]?.status).toBe('pending');
  }, 120_000);

  it('the per-tenant invitation cap is 429 AUTH_RATE_LIMITED with a Retry-After header', async () => {
    const admin = await freshAdmin();
    for (let i = 0; i < 2; i += 1) {
      const allowed = await invite(admin.cookie, `tenant-cap-${randomUUID()}@example.test`);
      expect(allowed.status, allowed.body).toBeLessThan(300);
    }
    const limited = await invite(admin.cookie, `tenant-cap-${randomUUID()}@example.test`);
    expect(limited.status).toBe(429);
    expect(limited.code).toBe('AUTH_RATE_LIMITED');
    expect(limited.retryAfter).toMatch(/^[1-9]\d*$/);
  }, 120_000);

  it('the per-recipient invitation cap is 429 AUTH_RATE_LIMITED with the same Retry-After header', async () => {
    const first = await freshAdmin();
    const second = await freshAdmin();
    const tenantCapped = await freshAdmin();
    for (let i = 0; i < 2; i += 1) {
      await invite(tenantCapped.cookie, `cap-fill-${randomUUID()}@example.test`);
    }
    const tenantLimited = await invite(
      tenantCapped.cookie,
      `cap-fill-${randomUUID()}@example.test`,
    );

    const shared = `shared-${randomUUID()}@example.test`;
    expect((await invite(first.cookie, shared)).status).toBeLessThan(300);
    const limited = await invite(second.cookie, shared);
    expect(limited.status).toBe(429);
    expect(limited.code).toBe('AUTH_RATE_LIMITED');
    expect(limited.retryAfter).toMatch(/^[1-9]\d*$/);
    // "Every cap answers with the same Retry-After": both caps use the same window here.
    expect(limited.retryAfter).toBe(tenantLimited.retryAfter);
  }, 120_000);

  it("the accept route's limiter is 429 AUTH_RATE_LIMITED with a Retry-After header", async () => {
    const ip = randomIp();
    const attempt = (): Promise<Answer> =>
      send(
        undefined,
        'POST',
        ACCEPT_PATH,
        { invitationId: randomUUID(), token: 'x', password: ACCEPT_PASSWORD },
        ip,
      );
    for (let i = 0; i < ACCEPT_LIMIT; i += 1) {
      expect((await attempt()).status).toBe(404);
    }
    const limited = await attempt();
    expect(limited.status).toBe(429);
    expect(limited.code).toBe('AUTH_RATE_LIMITED');
    expect(limited.retryAfter).toMatch(/^[1-9]\d*$/);
  }, 120_000);

  it("the accept route's rejections are all the same 404: unknown, wrong token, cancelled and expired", async () => {
    const admin = await freshAdmin();
    const secondAdmin = await freshAdmin();
    const accept = (invitationId: string, token: string): Promise<Answer> =>
      send(undefined, 'POST', ACCEPT_PATH, { invitationId, token, password: ACCEPT_PASSWORD });

    const wrongEmail = `wrong-${randomUUID()}@example.test`;
    const wrongToken = await invitationIdOf(await invite(admin.cookie, wrongEmail));

    const cancelledEmail = `cancelled-${randomUUID()}@example.test`;
    const cancelledId = await invitationIdOf(await invite(admin.cookie, cancelledEmail));
    const cancelledToken = tokenSentTo(cancelledEmail);
    const cancelled = await send(
      admin.cookie,
      'POST',
      `/v1/users/invitations/${cancelledId}/cancel`,
    );
    expect(cancelled.status, cancelled.body).toBeLessThan(300);

    const expiredEmail = `expired-${randomUUID()}@example.test`;
    const expiredId = await invitationIdOf(await invite(secondAdmin.cookie, expiredEmail));
    const expiredToken = tokenSentTo(expiredEmail);
    await pools.authPool.query(
      `update auth.invitation set expires_at = now() - interval '1 day' where id = $1`,
      [expiredId],
    );

    const answers = [
      await accept(`unknown-${randomUUID()}`, 'whatever'),
      await accept(wrongToken, 'not-the-token'),
      await accept(cancelledId, cancelledToken),
      await accept(expiredId, expiredToken),
    ];
    for (const answer of answers) {
      expect(answer.status, answer.body).toBe(404);
      expect(answer.code).toBe('CATALOG_NOT_FOUND');
      expect(answer.body).toBe(answers[0]?.body);
    }
  }, 120_000);
});
