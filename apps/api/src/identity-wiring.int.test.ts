/**
 * Task 14.11 of openspec/changes/archive/2026-10-14-043-identity-lifecycle-and-org-admin (Resolved
 * decision Q138; design D5 "Sender selection", Q80).
 *
 * Task 14.11 Verify: "`identity-wiring.int.test.ts` (in `apps/api/src/`; every case is
 * built through `createAppFromEnv` with `MOUNT_IDENTITY_ROUTES=true` and observes the
 * sends of the recording sender that `createEmailSender` selects under `NODE_ENV=test`)
 * covers an admin's invite and resend over HTTP each answering 200 and sending one
 * `InvitationEmail` whose link origin is `INVITATION_LINK_BASE_URL`."
 *
 * ## Harness
 *
 * The production bootstrap over the harness pools (as in `step-up.http.int.test.ts`),
 * with `MOUNT_IDENTITY_ROUTES=true`, no `EMAIL_PROVIDER` (so `createEmailSender`
 * selects the recording fake under `NODE_ENV=test`) and an `INVITATION_LINK_BASE_URL`
 * whose origin differs from the API's and from the admin's request origin, so the
 * assertion cannot pass by accident. `./email-sender.js` is wrapped, not replaced: the
 * real `createEmailSender` runs and the sender it returns is captured, which is how the
 * test observes the sends of the sender the production start built. Requests are
 * Fastify injections with a fresh random `x-forwarded-for`; the admin has a fresh MFA
 * verification, so the high-risk `invite` passes step-up. Each case uses a fresh tenant.
 *
 * ## Production symbols expected
 *
 * - `createAppFromEnv` (`./bootstrap.js`) calls `createEmailSender(config)` from
 *   `./email-sender.js` once and passes the sender, `config.invitationLinkBaseUrl`
 *   (Config field names as in `config.ts`), the disabled tenants, the kill switch, the
 *   recipient key secret and the caps through `createApp`'s email settings (replacing
 *   `identity.emailGate`); with the switch on, `createApp` (`./server.js`) builds the
 *   gate of D5 and hands the gate and the link base URL to `createIdentityRouter`.
 */
// Load-bearing import order (design D1): the telemetry harness registers before anything
// that loads `@tayzu/auth` creates its logger (task 14.13 reads log events).
import {
  linkLogEvents,
  registration,
  type TelemetryTestHarness,
} from './__fixtures__/link-telemetry.js';
import { randomInt, randomUUID } from 'node:crypto';

import type { createRecordingEmailSender } from '@tayzu/auth';
import { withTenantTransaction } from '@tayzu/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bootstrapTestTenant,
  createAdminUser,
  signInAdminUser,
  testAppPool,
  type BootstrappedTenant,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { startOidcStub, type OidcStub } from '../../../packages/auth/src/__fixtures__/oidc-stub.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { csrfHeaders } from './__fixtures__/csrf.js';
import {
  enrollTotp,
  enrolledAdminSession,
  sessionTokenOfCookie,
} from './__fixtures__/fresh-mfa.js';
import { harnessPools, type HarnessPools } from './__fixtures__/pools.js';
import {
  ORIGIN as SSO_ORIGIN,
  PROVIDER_ID,
  oidcRoundTrip,
  type Handler,
} from './__fixtures__/sso-shed.js';

const state = vi.hoisted(() => ({
  pools: new Map<string, unknown>(),
  senders: [] as unknown[],
}));

vi.mock('@tayzu/db', async (importActual) => {
  const actual = await importActual<typeof import('@tayzu/db')>();
  return {
    ...actual,
    createPool: vi.fn((url: string) => {
      const role = url.includes('tayzu_auth') ? 'auth' : 'app';
      const real = state.pools.get(role) as object;
      return new Proxy(real, {
        get(target, prop) {
          if (prop === 'end') {
            return () => Promise.resolve();
          }
          const value: unknown = Reflect.get(target, prop, target);
          return typeof value === 'function'
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });
    }),
  };
});

vi.mock('./email-sender.js', async (importActual) => {
  const actual = await importActual<typeof import('./email-sender.js')>();
  return {
    ...actual,
    createEmailSender: vi.fn((config: Parameters<typeof actual.createEmailSender>[0]) => {
      const sender = actual.createEmailSender(config);
      state.senders.push(sender);
      return sender;
    }),
  };
});

import { createAppFromEnv } from './bootstrap.js';
import type { App } from './server.js';

type RecordingSender = ReturnType<typeof createRecordingEmailSender>;

const ORIGIN = 'https://app.tayzu.test';
const LINK_ORIGIN = 'https://accept.tayzu.test';

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

describe('identity email wiring through createAppFromEnv (task 14.11)', () => {
  let app: App;
  let pools: HarnessPools;

  beforeAll(async () => {
    pools = await harnessPools();
    state.pools.set('app', pools.appPool);
    state.pools.set('auth', pools.authPool);
    app = await createAppFromEnv({
      DATABASE_URL: 'postgres://tayzu_app:pw@127.0.0.1:1/tayzu?sslmode=verify-full',
      AUTH_DATABASE_URL: 'postgres://tayzu_auth:pw@127.0.0.1:1/tayzu?sslmode=verify-full',
      BETTER_AUTH_SECRET: TEST_SECRET,
      CERBOS_ADDRESS: 'localhost:3593',
      ALLOWED_ORIGINS: `${ORIGIN},${LINK_ORIGIN}`,
      INVITATION_LINK_BASE_URL: LINK_ORIGIN,
      IDENTITY_TOKEN_HMAC_SECRET: 'wiring-hmac-test-only-secret-0123456789-abcdef',
      MOUNT_IDENTITY_ROUTES: 'true',
      PASSWORD_RESET_LINK_BASE_URL: ORIGIN,
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    state.pools.clear();
  }, 60_000);

  function recordingSender(): RecordingSender {
    expect(
      state.senders,
      'the sender is built once per process, by createEmailSender',
    ).toHaveLength(1);
    return state.senders[0] as RecordingSender;
  }

  async function freshAdmin(): Promise<BootstrappedTenant> {
    const suffix = randomUUID();
    const tenant = await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: 'Identity Wiring Admin',
      email: `identity-wiring-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Identity Wiring ${suffix}`,
      organizationSlug: `identity-wiring-${suffix}`,
      ip: randomIp(),
    });
    return await enrolledAdminSession(app, tenant, { password: TEST_PASSWORD, origin: ORIGIN });
  }

  async function post(
    cookie: string,
    url: string,
    body?: Record<string, unknown>,
  ): Promise<{ status: number; body: string; json: Record<string, unknown> }> {
    const response = await app.app.inject({
      method: 'POST',
      url,
      headers: {
        cookie,
        origin: ORIGIN,
        'x-forwarded-for': randomIp(),
        ...csrfHeaders('POST'),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    let json: Record<string, unknown> = {};
    try {
      json = response.json<Record<string, unknown>>();
    } catch {
      // A non-JSON body leaves the object empty and fails the assertions.
    }
    return { status: response.statusCode, body: response.body, json };
  }

  function sentTo(email: string): readonly { to: string; template: { kind: string } }[] {
    return recordingSender().sent.filter((message) => message.to === email);
  }

  function linkOf(email: string, index: number): URL {
    const template = recordingSender().sent.filter((message) => message.to === email)[index]
      ?.template;
    if (template?.kind !== 'InvitationEmail') throw new Error('no InvitationEmail was sent');
    return new URL(template.link);
  }

  it("an admin's invite over HTTP answers 200 and sends one InvitationEmail whose link origin is INVITATION_LINK_BASE_URL", async () => {
    const admin = await freshAdmin();
    const email = `identity-wiring-invitee-${randomUUID()}@example.test`;

    const answer = await post(admin.cookie, '/v1/users/invitations', { email, role: 'member' });

    expect(answer.status, answer.body).toBe(200);
    expect(typeof answer.json['invitationId']).toBe('string');
    const sent = sentTo(email);
    expect(sent, 'exactly one email to the invitee').toHaveLength(1);
    expect(sent[0]?.template.kind).toBe('InvitationEmail');
    expect(linkOf(email, 0).origin).toBe(LINK_ORIGIN);
  });

  it("an admin's resend over HTTP answers 200 and sends one InvitationEmail whose link origin is INVITATION_LINK_BASE_URL", async () => {
    const admin = await freshAdmin();
    const email = `identity-wiring-resend-${randomUUID()}@example.test`;
    const invited = await post(admin.cookie, '/v1/users/invitations', { email, role: 'member' });
    expect(invited.status, invited.body).toBe(200);
    const invitationId = invited.json['invitationId'];
    expect(typeof invitationId).toBe('string');
    const before = sentTo(email).length;

    const answer = await post(admin.cookie, `/v1/users/invitations/${String(invitationId)}/resend`);

    expect(answer.status, answer.body).toBe(200);
    const after = sentTo(email);
    expect(after.length - before, 'the resend sends exactly one more email').toBe(1);
    expect(after.at(-1)?.template.kind).toBe('InvitationEmail');
    expect(linkOf(email, after.length - 1).origin).toBe(LINK_ORIGIN);
  });
});

/**
 * Task 14.13 (Resolved decision Q138; 6.6 to 6.9): "`identity-wiring.int.test.ts` (14.11)
 * covers `INVITATION_EMAIL_KILL_SWITCH=true` answering an invite with `AUTH_RATE_LIMITED`
 * scope `global`, a tenant in `EMAIL_DISABLED_TENANT_IDS` answering 200 with nothing sent
 * and `catalog.security.email_tenant_blocked` logged, `INVITATION_TENANT_RATE_LIMIT_MAX=1`
 * refusing the second invite with scope `tenant`, and `INVITATION_RECIPIENT_RATE_LIMIT_MAX=1`
 * refusing the same address invited from a second tenant with scope `recipient`."
 *
 * Each case builds its own app through `createAppFromEnv` with the one control set. The
 * admins are created through a plain app (tenant ids are only known afterwards, which the
 * disabled-tenant case needs); sessions live in the database, so the cookie works on the
 * app under test. The refusal scope is read from the `limit_scope` attribute of
 * `catalog.security.invitation_rate_limited` (the response never reveals it).
 *
 * Production symbols expected: none new; `createAppFromEnv` already passes the controls
 * from the configuration (this task proves it). Config fields as in `config.ts`.
 */
describe('identity email gate controls reach production (task 14.13)', () => {
  const RATE_EVENT = 'catalog.security.invitation_rate_limited';
  const BLOCKED_EVENT = 'catalog.security.email_tenant_blocked';
  let pools: HarnessPools;
  let baseApp: App;
  let harness: TelemetryTestHarness;
  const apps: App[] = [];

  async function buildApp(
    extra: Record<string, string>,
  ): Promise<{ app: App; sender: RecordingSender }> {
    const before = state.senders.length;
    const built = await createAppFromEnv({
      DATABASE_URL: 'postgres://tayzu_app:pw@127.0.0.1:1/tayzu?sslmode=verify-full',
      AUTH_DATABASE_URL: 'postgres://tayzu_auth:pw@127.0.0.1:1/tayzu?sslmode=verify-full',
      BETTER_AUTH_SECRET: TEST_SECRET,
      CERBOS_ADDRESS: 'localhost:3593',
      ALLOWED_ORIGINS: `${ORIGIN},${LINK_ORIGIN}`,
      INVITATION_LINK_BASE_URL: LINK_ORIGIN,
      IDENTITY_TOKEN_HMAC_SECRET: 'wiring-hmac-test-only-secret-0123456789-abcdef',
      MOUNT_IDENTITY_ROUTES: 'true',
      PASSWORD_RESET_LINK_BASE_URL: ORIGIN,
      ...extra,
    });
    apps.push(built);
    expect(state.senders.length, 'one sender is built for this app').toBe(before + 1);
    return { app: built, sender: state.senders[before] as RecordingSender };
  }

  beforeAll(async () => {
    if ('error' in registration) {
      throw new Error(`createTelemetryTestHarness() failed: ${String(registration.error)}`, {
        cause: registration.error,
      });
    }
    harness = registration.harness;
    pools = await harnessPools();
    state.pools.set('app', pools.appPool);
    state.pools.set('auth', pools.authPool);
    baseApp = (await buildApp({})).app;
  }, 60_000);

  afterAll(async () => {
    for (const built of apps) await built.close();
    state.pools.clear();
  }, 60_000);

  async function adminOn(target: App): Promise<BootstrappedTenant> {
    const suffix = randomUUID();
    const tenant = await bootstrapTestTenant(baseApp.auth, {
      pool: testAppPool(),
      name: 'Identity Gate Admin',
      email: `identity-gate-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Identity Gate ${suffix}`,
      organizationSlug: `identity-gate-${suffix}`,
      ip: randomIp(),
    });
    return await enrolledAdminSession(target, tenant, {
      password: TEST_PASSWORD,
      origin: ORIGIN,
    });
  }

  async function invite(
    target: App,
    cookie: string,
    email: string,
  ): Promise<{ status: number; body: string; code: unknown }> {
    const response = await target.app.inject({
      method: 'POST',
      url: '/v1/users/invitations',
      headers: {
        cookie,
        origin: ORIGIN,
        'x-forwarded-for': randomIp(),
        ...csrfHeaders('POST'),
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ email, role: 'member' }),
    });
    let code: unknown;
    try {
      code = response.json<{ code?: unknown }>().code;
    } catch {
      // A non-JSON body leaves the code undefined, which fails the assertions.
    }
    return { status: response.statusCode, body: response.body, code };
  }

  async function eventsOf(name: string, tenantId: string) {
    await harness.forceFlush();
    return [...harness.logExporter.getFinishedLogRecords()].filter(
      (record) => record.eventName === name && record.attributes['tayzu.tenant.id'] === tenantId,
    );
  }

  async function limitScopes(tenantId: string): Promise<unknown[]> {
    return (await eventsOf(RATE_EVENT, tenantId)).map(
      (record) => record.attributes['tayzu.identity.invitation.limit_scope'],
    );
  }

  it('INVITATION_EMAIL_KILL_SWITCH=true answers an invite with AUTH_RATE_LIMITED, scope global, and sends nothing', async () => {
    const { app: target, sender } = await buildApp({ INVITATION_EMAIL_KILL_SWITCH: 'true' });
    const admin = await adminOn(target);
    const email = `identity-gate-kill-${randomUUID()}@example.test`;

    const answer = await invite(target, admin.cookie, email);

    expect(answer.status, answer.body).toBe(429);
    expect(answer.code).toBe('AUTH_RATE_LIMITED');
    expect(sender.sent.filter((message) => message.to === email)).toHaveLength(0);
    expect(await limitScopes(admin.organizationId)).toEqual(['global']);
  }, 60_000);

  it('a tenant in EMAIL_DISABLED_TENANT_IDS answers 200, sends nothing and logs catalog.security.email_tenant_blocked', async () => {
    const admin = await adminOn(baseApp);
    const { app: target, sender } = await buildApp({
      EMAIL_DISABLED_TENANT_IDS: admin.organizationId,
    });
    const email = `identity-gate-disabled-${randomUUID()}@example.test`;

    const answer = await invite(target, admin.cookie, email);

    expect(answer.status, answer.body).toBe(200);
    expect(sender.sent.filter((message) => message.to === email)).toHaveLength(0);
    const blocked = await eventsOf(BLOCKED_EVENT, admin.organizationId);
    expect(blocked, 'exactly one email_tenant_blocked event').toHaveLength(1);
    expect(JSON.stringify(blocked[0])).not.toContain(email);
  }, 60_000);

  it('INVITATION_TENANT_RATE_LIMIT_MAX=1 refuses the second invite with scope tenant', async () => {
    const { app: target, sender } = await buildApp({ INVITATION_TENANT_RATE_LIMIT_MAX: '1' });
    const admin = await adminOn(target);
    const first = `identity-gate-tenant-a-${randomUUID()}@example.test`;
    const second = `identity-gate-tenant-b-${randomUUID()}@example.test`;

    const allowed = await invite(target, admin.cookie, first);
    const refused = await invite(target, admin.cookie, second);

    expect(allowed.status, allowed.body).toBe(200);
    expect(refused.status, refused.body).toBe(429);
    expect(refused.code).toBe('AUTH_RATE_LIMITED');
    expect(sender.sent.filter((message) => message.to === first)).toHaveLength(1);
    expect(sender.sent.filter((message) => message.to === second)).toHaveLength(0);
    expect(await limitScopes(admin.organizationId)).toEqual(['tenant']);
  }, 60_000);

  it('INVITATION_RECIPIENT_RATE_LIMIT_MAX=1 refuses the same address invited from a second tenant with scope recipient', async () => {
    const { app: target, sender } = await buildApp({ INVITATION_RECIPIENT_RATE_LIMIT_MAX: '1' });
    const firstAdmin = await adminOn(target);
    const secondAdmin = await adminOn(target);
    const email = `identity-gate-recipient-${randomUUID()}@example.test`;

    const allowed = await invite(target, firstAdmin.cookie, email);
    const refused = await invite(target, secondAdmin.cookie, email);

    expect(allowed.status, allowed.body).toBe(200);
    expect(refused.status, refused.body).toBe(429);
    expect(refused.code).toBe('AUTH_RATE_LIMITED');
    expect(sender.sent.filter((message) => message.to === email)).toHaveLength(1);
    expect(await limitScopes(secondAdmin.organizationId)).toEqual(['recipient']);
    expect(await limitScopes(firstAdmin.organizationId)).toEqual([]);
    const logged = await eventsOf(RATE_EVENT, secondAdmin.organizationId);
    expect(JSON.stringify(logged)).not.toContain(email);
  }, 60_000);
});

/**
 * Task 14.15 (Resolved decisions Q30, Q39 and Q138; 8.5h, 8.5m, 8.15): "`identity-wiring.int.test.ts`
 * (14.11) covers an existing account's acceptance over HTTP removing its unmarked SSO link
 * and the sessions issued through it, with `catalog.security.sso_link_shed` (path
 * `acceptance`) logged, and an accepted `admin` invitation sending one `AdminAcceptedNotice`
 * to each other administrator and none to the invitee."
 *
 * Built through `createAppFromEnv` (SSO configured against the local OIDC stub,
 * `BETTER_AUTH_URL` at the origin the stub round trip uses). The acceptance is the real
 * `POST /v1/auth/invitations/accept`; invitations are made over HTTP and the token is read
 * from the recording sender the production start selected.
 *
 * Production symbols expected: none new; `createApp` (`./server.js`) builds the shed core
 * (`createSsoLinkShed`) once, passes its `port` to `createAuth` and the core to
 * `createAcceptFlow` as `ssoLinkShed`, and builds `createNoticeDispatcher` over the shared
 * store and the sender and passes it to `createAcceptFlow` as `notices`.
 */
describe('the accept route runs the shed and sends the admin notice (task 14.15)', () => {
  const SHED_EVENT = 'catalog.security.sso_link_shed';
  let harness: TelemetryTestHarness;
  let pools: HarnessPools;
  let stub: OidcStub;
  let app: App;
  let sender: RecordingSender;

  beforeAll(async () => {
    if ('error' in registration) {
      throw new Error(`createTelemetryTestHarness() failed: ${String(registration.error)}`, {
        cause: registration.error,
      });
    }
    harness = registration.harness;
    pools = await harnessPools();
    state.pools.set('app', pools.appPool);
    state.pools.set('auth', pools.authPool);
    stub = await startOidcStub();
    const before = state.senders.length;
    app = await createAppFromEnv({
      DATABASE_URL: 'postgres://tayzu_app:pw@127.0.0.1:1/tayzu?sslmode=verify-full',
      AUTH_DATABASE_URL: 'postgres://tayzu_auth:pw@127.0.0.1:1/tayzu?sslmode=verify-full',
      BETTER_AUTH_SECRET: TEST_SECRET,
      BETTER_AUTH_URL: SSO_ORIGIN,
      CERBOS_ADDRESS: 'localhost:3593',
      ALLOWED_ORIGINS: `${ORIGIN},${LINK_ORIGIN},${SSO_ORIGIN}`,
      INVITATION_LINK_BASE_URL: LINK_ORIGIN,
      IDENTITY_TOKEN_HMAC_SECRET: 'wiring-hmac-test-only-secret-0123456789-abcdef',
      MOUNT_IDENTITY_ROUTES: 'true',
      PASSWORD_RESET_LINK_BASE_URL: ORIGIN,
      VISMA_CONNECT_DISCOVERY_URL: stub.discoveryUrl,
      VISMA_CONNECT_CLIENT_ID: stub.clientId,
      VISMA_CONNECT_CLIENT_SECRET: stub.clientSecret,
    });
    expect(state.senders.length, 'one sender is built for this app').toBe(before + 1);
    sender = state.senders[before] as RecordingSender;
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await stub.close();
    state.pools.clear();
  }, 60_000);

  interface AddMemberApi {
    addMember(args: {
      body: { userId: string; role: 'member' | 'admin'; organizationId: string };
    }): Promise<unknown>;
  }

  async function freshAdmin(): Promise<BootstrappedTenant & { email: string }> {
    const suffix = randomUUID();
    const email = `identity-accept-wiring-${suffix}@example.test`;
    const tenant = await bootstrapTestTenant(app.auth, {
      pool: testAppPool(),
      name: 'Identity Accept Admin',
      email,
      password: TEST_PASSWORD,
      organizationName: `Identity Accept ${suffix}`,
      organizationSlug: `identity-accept-${suffix}`,
      ip: randomIp(),
    });
    const session = await enrolledAdminSession(app, tenant, {
      password: TEST_PASSWORD,
      origin: ORIGIN,
    });
    return { ...session, email };
  }

  async function addMember(
    tenantId: string,
    role: 'member' | 'admin',
    label: string,
  ): Promise<{ userId: string; email: string }> {
    const email = `${label}-${randomUUID()}@example.test`;
    const created = await createAdminUser(app.auth, {
      name: label,
      email,
      password: TEST_PASSWORD,
    });
    await (app.auth.api as AddMemberApi).addMember({
      body: { userId: created.userId, role, organizationId: tenantId },
    });
    return { userId: created.userId, email };
  }

  async function invite(
    admin: BootstrappedTenant,
    email: string,
    role: 'member' | 'admin',
  ): Promise<{ invitationId: string; token: string }> {
    const response = await app.app.inject({
      method: 'POST',
      url: '/v1/users/invitations',
      headers: {
        cookie: admin.cookie,
        origin: ORIGIN,
        'x-forwarded-for': randomIp(),
        ...csrfHeaders('POST'),
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ email, role }),
    });
    expect(response.statusCode, response.body).toBe(200);
    const invitationId = response.json<{ invitationId: string }>().invitationId;
    const template = sender.sent.find((message) => message.to === email)?.template;
    if (template?.kind !== 'InvitationEmail') throw new Error('the invitation email was not sent');
    const token = new URLSearchParams(new URL(template.link).hash.slice(1)).get('token') ?? '';
    expect(token.length).toBeGreaterThan(0);
    return { invitationId, token };
  }

  function accept(body: Record<string, unknown>, cookie?: string) {
    return app.app.inject({
      method: 'POST',
      url: '/v1/auth/invitations/accept',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        'x-csrf-token': 'orpc',
        'x-forwarded-for': randomIp(),
        ...(cookie === undefined ? {} : { cookie }),
      },
      payload: JSON.stringify(body),
    });
  }

  it("an existing account's acceptance over HTTP removes its unmarked SSO link and the sessions issued through it, logging catalog.security.sso_link_shed with path acceptance", async () => {
    const first = await freshAdmin();
    const second = await freshAdmin();
    const person = await addMember(first.organizationId, 'member', 'shed-person');
    const sub = `wiring-shed-sub-${randomUUID()}`;
    // A link that pre-dates the marker: no `sso-link:` row, so it is treated as admin-recorded.
    await pools.authPool.query(
      `insert into auth.account (id, account_id, provider_id, user_id, created_at, updated_at)
       values ($1, $2, $3, $4, now(), now())`,
      [randomUUID(), sub, PROVIDER_ID, person.userId],
    );
    stub.setSubject({
      sub,
      email: person.email,
      name: 'Shed Person',
      sid: `sid-${randomUUID()}`,
      claims: { email_verified: true },
    });
    const handler = (app.auth as unknown as { handler: Handler }).handler;
    const sso = await oidcRoundTrip(handler, '/sign-in/social', '');
    const ssoToken = sessionTokenOfCookie(sso.cookie);
    const sessionRows = async (token: string): Promise<number> =>
      (await pools.authPool.query(`select 1 from auth.session where token = $1`, [token])).rows
        .length;
    expect(await sessionRows(ssoToken), 'precondition: the SSO session exists').toBe(1);
    const linkRows = async (): Promise<number> =>
      (
        await pools.authPool.query(
          `select 1 from auth.account where user_id = $1 and provider_id <> 'credential'`,
          [person.userId],
        )
      ).rows.length;
    expect(await linkRows(), 'precondition: the unmarked link exists').toBe(1);
    const pending = await invite(second, person.email, 'member');
    const signedIn = await signInAdminUser(app.auth, {
      email: person.email,
      password: TEST_PASSWORD,
      ip: randomIp(),
    });

    const answer = await accept(pending, signedIn.cookie);

    expect(answer.statusCode, answer.body).toBe(200);
    expect(await linkRows(), 'the link is gone').toBe(0);
    expect(await sessionRows(ssoToken), 'the session issued through the link is gone').toBe(0);
    const events = (await linkLogEvents(harness, SHED_EVENT)).filter(
      (record) => record.attributes['tayzu.identity.user.id'] === person.userId,
    );
    expect(events, 'the event is logged once').toHaveLength(1);
    expect(events[0]?.attributes['tayzu.identity.sso_link.path']).toBe('acceptance');
    expect(events[0]?.attributes['tayzu.tenant.id']).toBe(second.organizationId);
    expect(JSON.stringify(events[0]?.attributes)).not.toContain(sub);
  }, 120_000);

  it('an accepted admin invitation sends one AdminAcceptedNotice to each other administrator and none to the invitee', async () => {
    const owner = await freshAdmin();
    const otherAdmin = await addMember(owner.organizationId, 'admin', 'notice-admin');
    const plain = await addMember(owner.organizationId, 'member', 'notice-plain');
    const invitee = `identity-notice-invitee-${randomUUID()}@example.test`;
    const pending = await invite(owner, invitee, 'admin');

    const answer = await accept({
      ...pending,
      password: 'Café-Mañana-Passäphrase-2026!',
    });

    expect(answer.statusCode, answer.body).toBe(200);
    const notices = sender.sent.filter(
      (message) => message.template.kind === 'AdminAcceptedNotice',
    );
    const countFor = (email: string): number =>
      notices.filter((message) => message.to === email).length;
    expect(countFor(owner.email), 'the owner').toBe(1);
    expect(countFor(otherAdmin.email), 'the other administrator').toBe(1);
    expect(countFor(invitee), 'the invitee').toBe(0);
    expect(countFor(plain.email), 'a plain member').toBe(0);
  }, 120_000);
});

/**
 * Task 14.18 (Resolved decision Q138; 9.5d, 10.8): "`identity-wiring.int.test.ts` (14.11)
 * covers `CREDENTIAL_CAP=1` and `SERVICE_ACCOUNT_CAP=1` each refusing the second creation
 * over HTTP with `CATALOG_VALIDATION_FAILED` and nothing created."
 *
 * Each case builds its own app through `createAppFromEnv` with the one cap set. The first
 * creation succeeds (200); the second is refused and leaves no key and no `_user`.
 *
 * Production symbols expected: none new; `createAppFromEnv` (`./bootstrap.js`) passes
 * `config.credentialCap` and `config.serviceAccountCap` through `createApp` (`./server.js`)
 * to `createIdentityRouter`'s `credentialCap` and `serviceAccountCap` options.
 */
describe('the configured caps reach the identity router (task 14.18)', () => {
  let pools: HarnessPools;
  let baseApp: App;
  const apps: App[] = [];

  async function buildApp(extra: Record<string, string>): Promise<App> {
    const built = await createAppFromEnv({
      DATABASE_URL: 'postgres://tayzu_app:pw@127.0.0.1:1/tayzu?sslmode=verify-full',
      AUTH_DATABASE_URL: 'postgres://tayzu_auth:pw@127.0.0.1:1/tayzu?sslmode=verify-full',
      BETTER_AUTH_SECRET: TEST_SECRET,
      CERBOS_ADDRESS: 'localhost:3593',
      ALLOWED_ORIGINS: `${ORIGIN},${LINK_ORIGIN}`,
      INVITATION_LINK_BASE_URL: LINK_ORIGIN,
      IDENTITY_TOKEN_HMAC_SECRET: 'wiring-hmac-test-only-secret-0123456789-abcdef',
      MOUNT_IDENTITY_ROUTES: 'true',
      PASSWORD_RESET_LINK_BASE_URL: ORIGIN,
      ...extra,
    });
    apps.push(built);
    return built;
  }

  beforeAll(async () => {
    pools = await harnessPools();
    state.pools.set('app', pools.appPool);
    state.pools.set('auth', pools.authPool);
    baseApp = await buildApp({});
  }, 60_000);

  afterAll(async () => {
    for (const built of apps) await built.close();
    state.pools.clear();
  }, 60_000);

  async function adminOn(target: App): Promise<BootstrappedTenant> {
    const suffix = randomUUID();
    const tenant = await bootstrapTestTenant(baseApp.auth, {
      pool: testAppPool(),
      name: 'Identity Cap Admin',
      email: `identity-cap-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Identity Cap ${suffix}`,
      organizationSlug: `identity-cap-${suffix}`,
      ip: randomIp(),
    });
    return await enrolledAdminSession(target, tenant, {
      password: TEST_PASSWORD,
      origin: ORIGIN,
    });
  }

  async function postJson(
    target: App,
    cookie: string,
    url: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: string; code: unknown }> {
    const response = await target.app.inject({
      method: 'POST',
      url,
      headers: {
        cookie,
        origin: ORIGIN,
        'x-forwarded-for': randomIp(),
        ...csrfHeaders('POST'),
        'content-type': 'application/json',
      },
      payload: JSON.stringify(body),
    });
    let code: unknown;
    try {
      code = response.json<{ code?: unknown }>().code;
    } catch {
      // A non-JSON body leaves the code undefined, which fails the assertions.
    }
    return { status: response.statusCode, body: response.body, code };
  }

  async function keyCount(tenantId: string): Promise<number> {
    const result = await pools.authPool.query('select 1 from auth.apikey where reference_id = $1', [
      tenantId,
    ]);
    return result.rows.length;
  }

  async function userEntityCount(tenantId: string, identifier: string): Promise<number> {
    return await withTenantTransaction(pools.appPool, { tenantId }, async (db) => {
      const result = await db.query(
        `select 1 from catalog_entity e
           join catalog_blueprint b on b.tenant_id = e.tenant_id and b.id = e.blueprint_id
          where e.tenant_id = $1 and b.identifier = '_user' and e.identifier = $2`,
        [tenantId, identifier],
      );
      return result.rows.length;
    });
  }

  it('CREDENTIAL_CAP=1 refuses the second credential creation over HTTP with CATALOG_VALIDATION_FAILED and creates nothing', async () => {
    const target = await buildApp({ CREDENTIAL_CAP: '1' });
    const admin = await adminOn(target);

    const first = await postJson(target, admin.cookie, '/v1/credentials', {
      name: 'cap-key-1',
      kind: 'integration',
    });
    expect(first.status, first.body).toBe(200);
    expect(await keyCount(admin.organizationId)).toBe(1);

    const second = await postJson(target, admin.cookie, '/v1/credentials', {
      name: 'cap-key-2',
      kind: 'integration',
    });

    expect(second.status, second.body).not.toBe(200);
    expect(second.code).toBe('CATALOG_VALIDATION_FAILED');
    expect(await keyCount(admin.organizationId), 'no second key').toBe(1);
  }, 120_000);

  it('SERVICE_ACCOUNT_CAP=1 refuses the second service-account creation over HTTP with CATALOG_VALIDATION_FAILED and creates nothing', async () => {
    const target = await buildApp({ SERVICE_ACCOUNT_CAP: '1' });
    const admin = await adminOn(target);
    const firstId = `svc-cap-a-${randomUUID().slice(0, 8)}`;
    const secondId = `svc-cap-b-${randomUUID().slice(0, 8)}`;

    const first = await postJson(target, admin.cookie, '/v1/service-accounts', {
      identifier: firstId,
    });
    expect(first.status, first.body).toBe(200);
    expect(await keyCount(admin.organizationId)).toBe(1);

    const second = await postJson(target, admin.cookie, '/v1/service-accounts', {
      identifier: secondId,
    });

    expect(second.status, second.body).not.toBe(200);
    expect(second.code).toBe('CATALOG_VALIDATION_FAILED');
    expect(await userEntityCount(admin.organizationId, secondId), 'no second _user').toBe(0);
    expect(await keyCount(admin.organizationId), 'no second key').toBe(1);
  }, 120_000);
});

/**
 * Task 13.4 of openspec/changes/044-password-reset-and-account-recovery (design D8 "The notices",
 * hook points; spec "Recovery notices are fixed and carry no link": "A user is told when their
 * password changes", "A user is told when an admin resets their second factor", "Creating a user
 * sends the account-created notice"; "The account-created notice has its own tenant and global
 * caps").
 *
 * Task 13.4 Verify: `identity-wiring.int.test.ts`, new cases "a password change sends one
 * `PasswordChangedNotice`", "`identity.users.create` sends one `AccountCreatedNotice` and stops at
 * the tenant cap", "`identity.users.resetMfa` over HTTP sends one `MfaResetNotice`".
 *
 * Every case is built through `createAppFromEnv` with `MOUNT_IDENTITY_ROUTES=true` and the recording
 * sender `createEmailSender` selects, with roomy global caps (the shared test database keeps those
 * buckets between files). Notices are detached, so the cases wait for the send and then settle
 * before asserting "exactly one".
 *
 * Production symbols expected: none new. `createApp` (`./server.js`) passes an `accountNotices` port
 * (`AccountNoticePort` of `@tayzu/auth`, `notify(kind, { userId })`, backed by the recovery mailer's
 * notice path) to `createAuth`, so `/change-password` success sends `PasswordChangedNotice`.
 */
describe('the recovery notices reach production (task 13.4)', () => {
  let pools: HarnessPools;
  const apps: App[] = [];
  const AUTH_BASE = 'http://localhost:3000/api/auth';
  const NEW_PASSWORD = 'Another-Perfectly-Fine-Passphrase-77!';

  async function buildApp(
    extra: Record<string, string> = {},
  ): Promise<{ app: App; sender: RecordingSender }> {
    const before = state.senders.length;
    const built = await createAppFromEnv({
      DATABASE_URL: 'postgres://tayzu_app:pw@127.0.0.1:1/tayzu?sslmode=verify-full',
      AUTH_DATABASE_URL: 'postgres://tayzu_auth:pw@127.0.0.1:1/tayzu?sslmode=verify-full',
      BETTER_AUTH_SECRET: TEST_SECRET,
      CERBOS_ADDRESS: 'localhost:3593',
      ALLOWED_ORIGINS: `${ORIGIN},${LINK_ORIGIN}`,
      INVITATION_LINK_BASE_URL: LINK_ORIGIN,
      IDENTITY_TOKEN_HMAC_SECRET: 'wiring-hmac-test-only-secret-0123456789-abcdef',
      MOUNT_IDENTITY_ROUTES: 'true',
      PASSWORD_RESET_LINK_BASE_URL: ORIGIN,
      PASSWORD_RESET_GLOBAL_RATE_LIMIT_MAX: '100000',
      PASSWORD_RESET_GLOBAL_RATE_LIMIT_WINDOW_SECONDS: '3600',
      ACCOUNT_CREATED_NOTICE_GLOBAL_RATE_LIMIT_MAX: '100000',
      ACCOUNT_CREATED_NOTICE_GLOBAL_RATE_LIMIT_WINDOW_SECONDS: '86400',
      ...extra,
    });
    apps.push(built);
    expect(state.senders.length, 'one sender is built for this app').toBe(before + 1);
    return { app: built, sender: state.senders[before] as RecordingSender };
  }

  beforeAll(async () => {
    pools = await harnessPools();
    state.pools.set('app', pools.appPool);
    state.pools.set('auth', pools.authPool);
  }, 60_000);

  beforeEach(() => {
    // The breached-password range service reports nothing as breached.
    vi.stubGlobal('fetch', (): Promise<Response> => {
      return Promise.resolve(
        new Response('0000000000000000000000000000000000A:3\r\n', { status: 200 }),
      );
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    for (const built of apps) await built.close();
    state.pools.clear();
  }, 60_000);

  async function adminOn(target: App): Promise<BootstrappedTenant> {
    const suffix = randomUUID();
    const tenant = await bootstrapTestTenant(target.auth, {
      pool: testAppPool(),
      name: 'Identity Notice Admin',
      email: `identity-notice-admin-${suffix}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Identity Notice ${suffix}`,
      organizationSlug: `identity-notice-${suffix}`,
      ip: randomIp(),
    });
    return await enrolledAdminSession(target, tenant, {
      password: TEST_PASSWORD,
      origin: ORIGIN,
    });
  }

  function noticesTo(sender: RecordingSender, address: string, kind: string) {
    return sender.sent.filter(
      (message) => message.to === address && message.template.kind === kind,
    );
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  it('a password change sends one PasswordChangedNotice', async () => {
    const { app: target, sender } = await buildApp();
    const admin = await adminOn(target);
    const handler = (target.auth as unknown as { handler: Handler }).handler;
    const change = (currentPassword: string): Promise<Response> =>
      handler(
        new Request(`${AUTH_BASE}/change-password`, {
          method: 'POST',
          headers: {
            cookie: admin.cookie,
            'content-type': 'application/json',
            'x-forwarded-for': randomIp(),
            origin: ORIGIN,
          },
          body: JSON.stringify({ currentPassword, newPassword: NEW_PASSWORD }),
        }),
      );

    const failed = await change(`wrong-${randomUUID()}`);
    expect(failed.ok, 'a wrong current password is refused').toBe(false);
    await settle();
    expect(
      noticesTo(sender, admin.email, 'PasswordChangedNotice'),
      'a failed change sends none',
    ).toHaveLength(0);

    const changed = await change(TEST_PASSWORD);

    expect(changed.status, await changed.clone().text()).toBe(200);
    await vi.waitFor(() => {
      expect(noticesTo(sender, admin.email, 'PasswordChangedNotice')).toHaveLength(1);
    });
    await settle();
    expect(noticesTo(sender, admin.email, 'PasswordChangedNotice'), 'exactly one').toHaveLength(1);
  }, 120_000);

  it('identity.users.create sends one AccountCreatedNotice and stops at the tenant cap', async () => {
    const { app: target, sender } = await buildApp({
      ACCOUNT_CREATED_NOTICE_TENANT_RATE_LIMIT_MAX: '1',
      ACCOUNT_CREATED_NOTICE_TENANT_RATE_LIMIT_WINDOW_SECONDS: '86400',
    });
    const admin = await adminOn(target);
    const create = async (email: string) =>
      await target.app.inject({
        method: 'POST',
        url: '/v1/users',
        headers: {
          cookie: admin.cookie,
          origin: ORIGIN,
          'x-forwarded-for': randomIp(),
          ...csrfHeaders('POST'),
          'content-type': 'application/json',
        },
        payload: JSON.stringify({ email, name: 'Notice Person', role: 'member' }),
      });
    const first = `identity-created-a-${randomUUID()}@example.test`;
    const second = `identity-created-b-${randomUUID()}@example.test`;

    const firstAnswer = await create(first);

    expect(firstAnswer.statusCode, firstAnswer.body).toBe(200);
    await vi.waitFor(() => {
      expect(noticesTo(sender, first, 'AccountCreatedNotice')).toHaveLength(1);
    });
    await settle();
    expect(noticesTo(sender, first, 'AccountCreatedNotice'), 'exactly one').toHaveLength(1);

    const secondAnswer = await create(second);

    expect(secondAnswer.statusCode, 'the creation still succeeds at the cap').toBe(200);
    await settle();
    expect(noticesTo(sender, second, 'AccountCreatedNotice'), 'the cap suppresses it').toHaveLength(
      0,
    );
  }, 120_000);

  it('identity.users.resetMfa over HTTP sends one MfaResetNotice', async () => {
    const { app: target, sender } = await buildApp();
    const admin = await adminOn(target);
    const email = `identity-mfa-member-${randomUUID()}@example.test`;
    const created = await createAdminUser(target.auth, {
      name: 'Mfa Member',
      email,
      password: TEST_PASSWORD,
    });
    await (
      target.auth.api as {
        addMember(args: {
          body: { userId: string; role: 'member'; organizationId: string };
        }): Promise<unknown>;
      }
    ).addMember({
      body: { userId: created.userId, role: 'member', organizationId: admin.organizationId },
    });
    const memberSession = await signInAdminUser(target.auth, {
      email,
      password: TEST_PASSWORD,
      ip: randomIp(),
    });
    await enrollTotp(target, { password: TEST_PASSWORD, enrollmentCookie: memberSession.cookie });

    const answer = await target.app.inject({
      method: 'POST',
      url: `/v1/users/${email}/mfa/reset`,
      headers: {
        cookie: admin.cookie,
        origin: ORIGIN,
        'x-forwarded-for': randomIp(),
        ...csrfHeaders('POST'),
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ reason: 'device_replaced' }),
    });

    expect(answer.statusCode, answer.body).toBe(200);
    await vi.waitFor(() => {
      expect(noticesTo(sender, email, 'MfaResetNotice')).toHaveLength(1);
    });
    await settle();
    expect(noticesTo(sender, email, 'MfaResetNotice'), 'exactly one').toHaveLength(1);
  }, 120_000);
});
