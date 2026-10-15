/**
 * Task 15.6 of openspec/changes/archive/2026-10-14-043-identity-lifecycle-and-org-admin (design.md, Observability
 * contract; Resolved decisions Q116, Q117 and Q126). Scenarios, quoted from
 * `specs/identity-lifecycle-and-org-admin/spec.md`, requirement "Security-relevant events are
 * logged":
 *
 * #### Scenario: Each lifecycle action emits its declared event
 * - WHEN each of the actions above is executed once
 * - THEN its declared event is observed with its required attributes and no email, token, name
 *   or secret
 *
 * #### Scenario: Every status change names its principal
 * - WHEN a status is changed by an admin's status change, invitation, user creation or
 *   service-account creation, by a first sign-in, by an acceptance, by a ban, by the reconcile
 *   and by the bootstrap
 * - THEN each change is logged as `catalog.audit.user_status_changed` with its status event, the
 *   admin, the user or the invitee as its actor, the operator's opaque id in place of an actor
 *   for the reconcile and the bootstrap, and no actor for the ban, and with no email
 * - AND the invitation's status write names the invitation's id as its subject, a service
 *   account's names the service account's id, and every other names the user's id
 *
 * #### Scenario: The acceptance and the bootstrap name who acted
 * - WHEN an invitation is accepted, and the bootstrap user is created
 * - THEN the acceptance's audit event names the invitee as its actor, the bootstrap's names the
 *   operator's opaque id (the refusal without an operator id is 4.6b's case)
 *
 * ## Production symbols expected
 *
 * None new: every module imported here exists (15.2 produced the signals). If a producer still
 * attributes an event to the `system` actor, or omits a required attribute, the matching test
 * fails on an assertion. Tests that already pass on arrival are expected.
 *
 * ## Import order (design D1)
 *
 * `./__fixtures__/link-telemetry.js` registers the telemetry harness while the module graph
 * loads, so it stays the first same-package import.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { registration, type TelemetryTestHarness } from './__fixtures__/link-telemetry.js';

import { createRouterClient } from '@orpc/server';
import {
  authSchema,
  createAllowlistEmailSender,
  createAuth,
  createRecordingEmailSender,
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
  signInAdminUser,
  type BootstrappedTenant,
  testAppPool,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { startOidcStub, type OidcStub } from '../../../packages/auth/src/__fixtures__/oidc-stub.js';
import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { harnessPools, type HarnessPools } from './__fixtures__/pools.js';
import { oidcRoundTrip, poolFailing } from './__fixtures__/sso-shed.js';
import { createAcceptFlow, type AcceptFlowOptions } from './identity/accept-flow.js';
import { createAuthRepository } from './identity/auth-repository.js';
import { createEmailTenantGate, type EmailTenantGate } from './identity/email-tenant-gate.js';
import { createInMemoryEmailCapStore } from './identity/invitation-caps.js';
import { createNoticeDispatcher } from './identity/notices.js';
import { createSsoLinkShed } from './identity/sso-link-shed.js';
import { createUserSyncAdapter } from './identity/user-sync-adapter.js';
import { createWithUserLock } from './identity/user-lock.js';
import { createIdentityRouter } from './identity-router.js';
import { createApp, type App } from './server.js';
import { main as bootstrapAdminMain } from '../scripts/bootstrap-admin.js';
import { main as reconcileUsersMain } from '../scripts/reconcile-users.js';

const TEST_PASSWORD = 'correct horse battery staple';
const ACCEPT_PASSWORD = 'Café-Mañana-Passäphrase-2026!';
const ORIGIN = 'https://app.tayzu.test';
const AUTH_ORIGIN = 'http://localhost:3000';
const AUTH_BASE_URL = `${AUTH_ORIGIN}/api/auth`;
const ACCEPT_PATH = '/v1/auth/invitations/accept';
const CERBOS = 'localhost:3593';
const SECRET = 'events-043-test-only-secret-0123456789-abcdef';
const OPERATOR_ID = 'gh:151515';
const PROVIDER_ID = 'visma-connect';

const ACTOR_ID = 'tayzu.actor.id';
const ACTOR_TYPE = 'tayzu.actor.type';
const TENANT = 'tayzu.tenant.id';
const OPERATOR = 'tayzu.identity.operator.id';
const USER_ID = 'tayzu.identity.user.id';
const INVITATION_ID = 'tayzu.identity.invitation.id';
const SERVICE_ACCOUNT_ID = 'tayzu.identity.service_account.id';
const STATUS_EVENT_KEY = 'tayzu.identity.user.status.event';
const STATUS_TO = 'tayzu.identity.user.status.to';

type Attributes = Readonly<Record<string, unknown>>;

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

interface BanApi {
  createUser(args: {
    body: { name: string; email: string; password: string; role: string };
  }): Promise<unknown>;
  banUser(args: { body: { userId: string }; headers: Headers }): Promise<unknown>;
}

type WebHandler = (request: Request) => Promise<Response>;

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

function handlerOf(auth: AuthInstance): WebHandler {
  return (auth as unknown as { handler: WebHandler }).handler;
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
function poolAs(url: string, role: 'tayzu_app' | 'tayzu_auth'): Pool {
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

describe('Security-relevant events are logged (task 15.6)', () => {
  let harness: TelemetryTestHarness;
  let app: App;
  let stub: OidcStub;
  let pools: HarnessPools;
  let sso: { discoveryUrl: string; clientId: string; clientSecret: string };
  const authz = createCerbosClient({ address: CERBOS, tls: false });
  const sender = createRecordingEmailSender();
  const appSender = createRecordingEmailSender();
  let adapter: ReturnType<typeof createUserSyncAdapter>;
  let userSync: ReturnType<typeof createUserSync>;
  let repository: ReturnType<typeof createAuthRepository>;
  let shed: ReturnType<typeof createSsoLinkShed>;

  beforeAll(async () => {
    harness = registeredHarness();
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
      cerbosAddress: CERBOS,
      allowedOrigins: [ORIGIN],
      sso,
      mountIdentityRoutes: true,
      email: {
        sender: appSender,
        invitationLinkBaseUrl: ORIGIN,
        disabledTenantIds: [],
        killSwitch: false,
        recipientKeySecret: SECRET,
        tenantCap: { max: 1000, windowSeconds: 3600 },
        recipientCap: { max: 1000, windowSeconds: 86_400 },
      },
    });
    userSync = createUserSync({ pool: pools.appPool, authz });
    adapter = createUserSyncAdapter({ userSync });
    repository = createAuthRepository(pools.authPool);
    shed = createSsoLinkShed({ authPool: pools.authPool });
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await stub.close();
  });

  // ---- harness helpers -------------------------------------------------------------------

  /** The attributes of every record of `name` whose attributes include all of `where`. */
  async function events(name: string, where: Attributes): Promise<Attributes[]> {
    await harness.forceFlush();
    return [...harness.logExporter.getFinishedLogRecords()]
      .filter(
        (record) =>
          record.eventName === name &&
          Object.entries(where).every(([key, value]) => record.attributes[key] === value),
      )
      .map((record) => ({ ...record.attributes }));
  }

  /** The one record of `name` that matches `where`. */
  async function only(name: string, where: Attributes): Promise<Attributes> {
    const found = await events(name, where);
    expect(found, `exactly one "${name}" for ${JSON.stringify(where)}`).toHaveLength(1);
    const [first] = found;
    if (first === undefined) throw new Error('unreachable');
    return first;
  }

  /** No attribute of the records holds any of the forbidden strings (emails, names, secrets). */
  function expectNoLeak(attributes: Attributes, forbidden: readonly string[]): void {
    const serialized = JSON.stringify(attributes);
    for (const value of forbidden) {
      expect(serialized, `attributes must not hold "${value}"`).not.toContain(value);
    }
  }

  function gateWith(
    options: { disabledTenantIds?: readonly string[]; killSwitch?: boolean } = {},
  ): EmailTenantGate {
    return createEmailTenantGate({
      disabledTenantIds: options.disabledTenantIds ?? [],
      capStore: createInMemoryEmailCapStore({
        tenant: { max: 1000, windowSeconds: 3600 },
        recipient: { max: 1000, windowSeconds: 86_400 },
      }),
      sender,
      recipientKeySecret: SECRET,
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
        invitationLinkBaseUrl: ORIGIN,
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
      name: `Events ${label}`,
      email: `events-${label}-${id}@example.test`,
      password: TEST_PASSWORD,
      organizationName: `Events ${id}`,
      organizationSlug: `events-${id}`,
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

  const emailOf = (label: string): string => `events-${label}-${randomUUID()}@example.test`;

  function tokenFor(email: string): string {
    const message = [...sender.sent].reverse().find((candidate) => candidate.to === email);
    if (message?.template.kind !== 'InvitationEmail') {
      throw new Error('the invitation email was not sent');
    }
    return new URLSearchParams(new URL(message.template.link).hash.slice(1)).get('token') ?? '';
  }

  interface Invited {
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
    return { email, invitationId: created.invitationId, token: tokenFor(email) };
  }

  function acceptHttp(body: Record<string, unknown>, cookie?: string) {
    return app.app.inject({
      method: 'POST',
      url: ACCEPT_PATH,
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

  async function userIdOf(email: string): Promise<string> {
    const found = await pools.authPool.query<{ id: string }>(
      'select id from auth."user" where email = $1',
      [email],
    );
    const id = found.rows[0]?.id;
    if (id === undefined) throw new Error('the user row was not found');
    return id;
  }

  async function existingAccount(): Promise<{ userId: string; email: string; cookie: string }> {
    const email = emailOf('existing');
    const created = await createAdminUser(app.auth, {
      name: 'Events Existing',
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
      [randomUUID(), `events-sub-${randomUUID()}`, PROVIDER_ID, existing.userId],
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

  async function insertInvitation(
    tenantId: string,
    email: string,
    inviterId: string,
  ): Promise<string> {
    const id = `inv-${randomUUID()}`;
    await pools.authPool.query(
      `insert into auth.invitation (id, organization_id, email, role, status, expires_at, created_at, inviter_id)
       values ($1, $2, $3, 'member', 'pending', now() + interval '48 hours', now(), $4)`,
      [id, tenantId, email, inviterId],
    );
    return id;
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

  // ---- Each lifecycle action emits its declared event ------------------------------------

  it('Each lifecycle action emits its declared event: invitation creation, resend and every cancellation carry the tenant and the acting admin, never the system actor', async () => {
    const tenant = await newTenant('invites');
    const context = adminContext(tenant);
    const client = routerWith(gateWith());
    const forbidden: string[] = [];

    // creation and resend (tenant, actor type and acting admin)
    const first = await invite(client, tenant, emailOf('first'));
    forbidden.push(first.email, first.token);
    const created = await only('catalog.audit.invitation_created', {
      [INVITATION_ID]: first.invitationId,
    });
    expect(created).toMatchObject({
      [TENANT]: tenant.organizationId,
      [ACTOR_TYPE]: 'user',
      [ACTOR_ID]: tenant.userId,
      'tayzu.identity.invitation.role': 'member',
    });
    await client.identity.users.resendInvitation(
      { params: { invitation: first.invitationId } },
      { context },
    );
    const resent = await only('catalog.audit.invitation_resent', {
      [INVITATION_ID]: first.invitationId,
    });
    expect(resent).toMatchObject({
      [TENANT]: tenant.organizationId,
      [ACTOR_TYPE]: 'user',
      [ACTOR_ID]: tenant.userId,
    });

    // an admin cancel
    await client.identity.users.cancelInvitation(
      { params: { invitation: first.invitationId } },
      { context },
    );
    const cancelled = await only('catalog.audit.invitation_cancelled', {
      [INVITATION_ID]: first.invitationId,
    });
    expect(cancelled).toMatchObject({
      [TENANT]: tenant.organizationId,
      [ACTOR_ID]: tenant.userId,
      'tayzu.identity.invitation.reason': 'admin_cancel',
    });

    // a re-invite cancels the first invitation to the address
    const address = emailOf('reinvite');
    const original = await invite(client, tenant, address);
    await invite(client, tenant, address);
    forbidden.push(address);
    expect(
      await only('catalog.audit.invitation_cancelled', { [INVITATION_ID]: original.invitationId }),
    ).toMatchObject({
      [TENANT]: tenant.organizationId,
      [ACTOR_ID]: tenant.userId,
      'tayzu.identity.invitation.reason': 're_invite',
    });

    // creating the user cancels the pending invitation (user_created); the creation is audited
    const moot = emailOf('moot');
    const pending = await invite(client, tenant, moot);
    const createdUser = await client.identity.users.create(
      { body: { email: moot, name: 'Moot Person Name', role: 'member' } },
      { context },
    );
    forbidden.push(moot, 'Moot Person Name');
    expect(
      await only('catalog.audit.invitation_cancelled', { [INVITATION_ID]: pending.invitationId }),
    ).toMatchObject({
      [TENANT]: tenant.organizationId,
      [ACTOR_ID]: tenant.userId,
      'tayzu.identity.invitation.reason': 'user_created',
    });
    const userCreated = await only('catalog.audit.user_created', { [USER_ID]: createdUser.userId });
    expect(userCreated).toMatchObject({
      [TENANT]: tenant.organizationId,
      [ACTOR_ID]: tenant.userId,
      'tayzu.identity.user.role': 'member',
      'tayzu.identity.user.source': 'admin',
    });
    expect(userCreated).not.toHaveProperty(OPERATOR);

    // disabling a user cancels the invitations to them and by them, as the admin
    const toMember = await insertInvitation(
      tenant.organizationId,
      createdUser.email,
      tenant.userId,
    );
    const byMember = await insertInvitation(
      tenant.organizationId,
      emailOf('by-member'),
      createdUser.userId,
    );
    await client.identity.users.setStatus(
      { params: { user: createdUser.email }, body: { status: 'Disabled' } },
      { context },
    );
    expect(
      await only('catalog.audit.invitation_cancelled', { [INVITATION_ID]: toMember }),
    ).toMatchObject({
      [TENANT]: tenant.organizationId,
      [ACTOR_ID]: tenant.userId,
      'tayzu.identity.invitation.reason': 'user_disabled',
    });
    expect(
      await only('catalog.audit.invitation_cancelled', { [INVITATION_ID]: byMember }),
    ).toMatchObject({
      [TENANT]: tenant.organizationId,
      [ACTOR_ID]: tenant.userId,
      'tayzu.identity.invitation.reason': 'inviter_disabled',
    });

    for (const attributes of [created, resent, cancelled, userCreated]) {
      expectNoLeak(attributes, forbidden);
    }
  }, 180_000);

  it('Each lifecycle action emits its declared event: status change, service-account creation, disable, enable and deletion, credential creation, rotation and revocation, and a refused create', async () => {
    const tenant = await newTenant('accounts');
    const context = adminContext(tenant);
    const client = routerWith(gateWith());

    // a refused create: one conflict event with its reason, the tenant and the acting admin
    const member = await client.identity.users.create(
      { body: { email: emailOf('member'), name: 'Events Member Name', role: 'member' } },
      { context },
    );
    await expect(
      client.identity.users.create(
        { body: { email: member.email, name: 'Again', role: 'member' } },
        { context },
      ),
    ).rejects.toBeDefined();
    const conflict = await only('catalog.security.identity_conflict_refused', {
      [TENANT]: tenant.organizationId,
      'tayzu.identity.conflict.reason': 'account_exists',
    });
    expect(conflict[ACTOR_ID]).toBe(tenant.userId);
    expectNoLeak(conflict, [member.email, 'Events Member Name']);

    // the admin's status change
    await client.identity.users.setStatus(
      { params: { user: member.email }, body: { status: 'Disabled' } },
      { context },
    );
    const disabledEvent = await only('catalog.audit.user_status_changed', {
      [USER_ID]: member.userId,
      [STATUS_EVENT_KEY]: 'admin_disable',
    });
    expect(disabledEvent).toMatchObject({
      [TENANT]: tenant.organizationId,
      [ACTOR_ID]: tenant.userId,
    });

    // a service account: creation, disable, enable and deletion
    const identifier = `svc-events-${randomUUID().slice(0, 8)}`;
    await client.identity.serviceAccounts.create({ body: { identifier } }, { context });
    expect(
      await only('catalog.audit.service_account_created', { [SERVICE_ACCOUNT_ID]: identifier }),
    ).toMatchObject({
      [TENANT]: tenant.organizationId,
      [ACTOR_ID]: tenant.userId,
    });
    await client.identity.users.setStatus(
      { params: { user: identifier }, body: { status: 'Disabled' } },
      { context },
    );
    await client.identity.users.setStatus(
      { params: { user: identifier }, body: { status: 'Active' } },
      { context },
    );
    for (const [event, to] of [
      ['admin_disable', 'Disabled'],
      ['admin_enable', 'Active'],
    ] as const) {
      expect(
        await only('catalog.audit.user_status_changed', {
          [SERVICE_ACCOUNT_ID]: identifier,
          [STATUS_EVENT_KEY]: event,
        }),
      ).toMatchObject({
        [TENANT]: tenant.organizationId,
        [ACTOR_ID]: tenant.userId,
        [STATUS_TO]: to,
      });
    }
    await client.identity.serviceAccounts.delete({ params: { user: identifier } }, { context });
    expect(
      await only('catalog.audit.service_account_deleted', { [SERVICE_ACCOUNT_ID]: identifier }),
    ).toMatchObject({
      [TENANT]: tenant.organizationId,
      [ACTOR_ID]: tenant.userId,
    });

    // credentials: creation, rotation, revocation
    const credential = await client.identity.credentials.create(
      { body: { name: 'Events credential name', kind: 'integration' } },
      { context },
    );
    const createdCredential = await only('catalog.audit.credential_created', {
      'tayzu.identity.credential.id': credential.id,
    });
    expect(createdCredential).toMatchObject({
      [TENANT]: tenant.organizationId,
      [ACTOR_ID]: tenant.userId,
      'tayzu.identity.credential.kind': 'integration',
    });
    const rotated = await client.identity.credentials.rotate(
      { params: { credential: credential.id } },
      { context },
    );
    const rotation = await only('catalog.audit.credential_rotated', {
      'tayzu.identity.credential.old_id': credential.id,
    });
    expect(rotation).toMatchObject({
      [TENANT]: tenant.organizationId,
      [ACTOR_ID]: tenant.userId,
      'tayzu.identity.credential.new_id': rotated.id,
    });
    await client.identity.credentials.revoke({ params: { credential: rotated.id } }, { context });
    const revoked = await only('catalog.security.credential_revoked', {
      'tayzu.identity.credential.id': rotated.id,
    });
    expect(revoked).toMatchObject({ [TENANT]: tenant.organizationId, [ACTOR_ID]: tenant.userId });

    for (const attributes of [createdCredential, rotation, revoked]) {
      expectNoLeak(attributes, ['Events credential name', rotated.secret, credential.secret]);
    }
  }, 180_000);

  it('Each lifecycle action emits its declared event: a recipient refused by the allowlist, an email suppressed for a disabled tenant, and a suppressed or truncated notice', async () => {
    const templates: readonly EmailTemplate[] = [
      { kind: 'InvitationEmail', link: `${ORIGIN}/#id=x&token=y`, expiryText: '48 hours' },
      { kind: 'AdminAcceptedNotice' },
    ];
    const allowlisted = createAllowlistEmailSender(createRecordingEmailSender(), ['allowed.test']);
    const blockedAddress = `someone-${randomUUID()}@blocked.test`;
    for (const template of templates) {
      await expect(allowlisted.send(blockedAddress, template)).rejects.toBeDefined();
    }
    await harness.forceFlush();
    const blocked = await events('catalog.security.email_recipient_blocked', {});
    const blockedTemplates = new Set(
      blocked.map((attributes) => attributes['tayzu.identity.email.template']),
    );
    expect(blockedTemplates).toContain('invitation');
    expect(blockedTemplates).toContain('admin_accepted');
    for (const attributes of blocked) expectNoLeak(attributes, [blockedAddress]);

    // an email suppressed for a disabled demo tenant
    const tenant = await newTenant('demo');
    const client = routerWith(gateWith({ disabledTenantIds: [tenant.organizationId] }));
    const suppressedAddress = emailOf('suppressed');
    await client.identity.users.invite(
      { body: { email: suppressedAddress, role: 'member' } },
      { context: adminContext(tenant) },
    );
    const tenantBlocked = await only('catalog.security.email_tenant_blocked', {
      [TENANT]: tenant.organizationId,
    });
    expect(tenantBlocked['tayzu.identity.email.template']).toBe('invitation');
    expectNoLeak(tenantBlocked, [suppressedAddress]);

    // a notice suppressed (global kill switch, truncated to the first twenty recipients)
    const noticeTenant = `events-notice-${randomUUID()}`;
    const recipients = Array.from({ length: 21 }, (_, index) => ({
      email: `notice-${String(index)}-${randomUUID()}@example.test`,
      memberSince: new Date(Date.UTC(2020, 0, 1 + index)),
    }));
    await createNoticeDispatcher({
      disabledTenantIds: [],
      capStore: { consume: () => Promise.resolve() },
      sender: createRecordingEmailSender(),
      recipientKeySecret: SECRET,
      killSwitch: true,
    }).send({ tenantId: noticeTenant, template: { kind: 'AdminAcceptedNotice' }, recipients });
    const suppressions = await events('catalog.security.notice_suppressed', {
      [TENANT]: noticeTenant,
    });
    const kinds = new Set(
      suppressions.map((attributes) => attributes['tayzu.identity.notice.suppression']),
    );
    expect(kinds).toContain('global');
    expect(kinds).toContain('truncated');
    for (const attributes of suppressions) {
      expect(attributes['tayzu.identity.notice.template']).toBe('admin_accepted');
      expectNoLeak(
        attributes,
        recipients.map((recipient) => recipient.email),
      );
    }
  }, 120_000);

  it('Each lifecycle action emits its declared event: a banned sign-in attempt', async () => {
    const tenant = await newTenant('banned-sign-in');
    await pools.authPool.query('update auth."user" set banned = true where id = $1', [
      tenant.userId,
    ]);

    const response = await handlerOf(app.auth)(
      new Request(`${AUTH_BASE_URL}/sign-in/email`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: AUTH_ORIGIN,
          'x-forwarded-for': randomIp(),
        },
        body: JSON.stringify({ email: tenant.email, password: TEST_PASSWORD }),
      }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);

    const attempt = await only('catalog.security.banned_sign_in_attempt', {
      [USER_ID]: tenant.userId,
    });
    expect(attempt['tayzu.identity.sign_in.channel']).toBe('local');
    expectNoLeak(attempt, [tenant.email]);
  }, 60_000);

  it('Each lifecycle action emits its declared event: an SSO link shed, and the session revocations with the reason sso_link_shed, also for an admin unlink', async () => {
    const tenant = await newTenant('shed');
    const other = await newTenant('shed-other');
    const client = routerWith(gateWith());

    // a shed on an acceptance that joins a second tenant
    const linked = await linkedExistingAccount(other);
    const joining = await invite(client, tenant, linked.email);
    const accepting = await sessionIdOf(linked.cookie);
    const second = await signInAdminUser(app.auth, {
      email: linked.email,
      password: TEST_PASSWORD,
      ip: randomIp(),
    });
    expect(await sessionIdOf(second.cookie)).not.toBe(accepting);
    await flowWith().accept({
      invitationId: joining.invitationId,
      token: joining.token,
      session: { userId: linked.userId, sessionId: accepting },
    });
    const shedEvent = await only('catalog.security.sso_link_shed', { [USER_ID]: linked.userId });
    expect(shedEvent).toMatchObject({
      [TENANT]: tenant.organizationId,
      'tayzu.identity.sso_link.path': 'acceptance',
    });
    expectNoLeak(shedEvent, [linked.email]);
    const shedRevocations = await events('auth.security.session_revoked', {
      [ACTOR_ID]: linked.userId,
      'tayzu.auth.revocation.reason': 'sso_link_shed',
    });
    expect(
      shedRevocations.length,
      'the other session is revoked with the shed reason',
    ).toBeGreaterThan(0);

    // an admin unlink revokes the target's sessions with the same reason
    const person = await existingAccount();
    await (app.auth.api as MemberAdminApi).addMember({
      body: { userId: person.userId, organizationId: tenant.organizationId, role: 'member' },
    });
    const subject = `events-link-${randomUUID()}`;
    await client.identity.users.linkSsoAccount(
      { params: { user: person.email }, body: { subject } },
      { context: adminContext(tenant) },
    );
    await client.identity.users.unlinkSsoAccount(
      { params: { user: person.email } },
      { context: adminContext(tenant) },
    );
    const unlinkRevocations = await events('auth.security.session_revoked', {
      [ACTOR_ID]: person.userId,
      'tayzu.auth.revocation.reason': 'sso_link_shed',
    });
    expect(unlinkRevocations.length, 'the admin unlink revokes the session').toBeGreaterThan(0);
    for (const attributes of unlinkRevocations) expectNoLeak(attributes, [person.email, subject]);
  }, 180_000);

  it('Each lifecycle action emits its declared event: a failed provenance marker write', async () => {
    const linker = await newTenant('marker');
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
      sub: `events-marker-${randomUUID()}`,
      email: linker.email,
      name: 'Events Marker',
      sid: `sid-${randomUUID()}`,
      claims: { email_verified: true },
    });
    const trip = await oidcRoundTrip(handlerOf(failing), '/link-social', linker.cookie);
    expect(trip.response.status, 'the callback fails').toBeGreaterThanOrEqual(400);

    const failed = await only('catalog.security.sso_link_marker_failed', {
      [USER_ID]: linker.userId,
    });
    expectNoLeak(failed, [linker.email]);
  }, 120_000);

  it('Each lifecycle action emits its declared event: an acceptance compensation that failed, and a failed revocation of the accepting session', async () => {
    const tenant = await newTenant('flow');
    const client = routerWith(gateWith());

    const doomed = await invite(client, tenant, emailOf('doomed'));
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
        password: ACCEPT_PASSWORD,
      }),
    ).rejects.toBeDefined();
    const compensation = await only('catalog.security.invitation_accept_compensation_failed', {
      [INVITATION_ID]: doomed.invitationId,
    });
    expectNoLeak(compensation, [doomed.email, doomed.token, ACCEPT_PASSWORD]);

    const other = await newTenant('flow-other');
    const linked = await linkedExistingAccount(other);
    const joining = await invite(client, tenant, linked.email);
    const sessionId = await sessionIdOf(linked.cookie);
    await flowWith({
      ssoLinkShed: {
        ...shed,
        revokeSession: () => Promise.reject(new Error('injected revoke failure')),
      },
    }).accept({
      invitationId: joining.invitationId,
      token: joining.token,
      session: { userId: linked.userId, sessionId },
    });
    const revocation = await only('catalog.security.accepting_session_revocation_failed', {
      [INVITATION_ID]: joining.invitationId,
    });
    expect(revocation).toMatchObject({ [TENANT]: tenant.organizationId, [USER_ID]: linked.userId });
    expectNoLeak(revocation, [linked.email, joining.token]);
  }, 180_000);

  // ---- The acceptance and the bootstrap name who acted -----------------------------------

  it('The acceptance and the bootstrap name who acted: the acceptance names the invitee as its actor, with the invitation, the user, the path and the role', async () => {
    const tenant = await newTenant('accepted');
    const client = routerWith(gateWith());
    const invited = await invite(client, tenant, emailOf('invitee'));

    const response = await acceptHttp({
      invitationId: invited.invitationId,
      token: invited.token,
      password: ACCEPT_PASSWORD,
    });
    expect(response.statusCode, response.body).toBeLessThan(300);
    const inviteeId = await userIdOf(invited.email);

    const accepted = await only('catalog.audit.invitation_accepted', {
      [INVITATION_ID]: invited.invitationId,
    });
    expect(accepted).toMatchObject({
      [TENANT]: tenant.organizationId,
      [ACTOR_TYPE]: 'user',
      [ACTOR_ID]: inviteeId,
      [USER_ID]: inviteeId,
      'tayzu.identity.invitation.role': 'member',
      'tayzu.identity.invitation.path': 'new_account',
    });
    expect(accepted[ACTOR_ID]).not.toBe(tenant.userId);
    expectNoLeak(accepted, [invited.email, invited.token, ACCEPT_PASSWORD]);
  }, 120_000);

  it('The acceptance and the bootstrap name who acted: the bootstrap names the operator, not an actor', async () => {
    const slug = `events-bootstrap-${randomUUID()}`;
    const adminEmail = emailOf('bootstrap');
    const bootstrapApp = poolAs(ownerDatabaseUrl(), 'tayzu_app');
    const bootstrapAuth = poolAs(ownerDatabaseUrl(), 'tayzu_auth');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await bootstrapAdminMain({
        env: {
          NODE_ENV: 'test',
          DATABASE_URL: ownerDatabaseUrl(),
          AUTH_DATABASE_URL: ownerDatabaseUrl(),
          BETTER_AUTH_SECRET: TEST_SECRET,
          CERBOS_ADDRESS: CERBOS,
          ALLOWED_ORIGINS: AUTH_ORIGIN,
          BOOTSTRAP_ORGANIZATION_NAME: 'Events Bootstrap',
          BOOTSTRAP_ORGANIZATION_SLUG: slug,
          BOOTSTRAP_ADMIN_NAME: 'Events Bootstrap Admin',
          BOOTSTRAP_ADMIN_EMAIL: adminEmail,
          TAYZU_OPERATOR_ID: OPERATOR_ID,
        },
        appPool: bootstrapApp,
        authPool: bootstrapAuth,
      });
    } finally {
      log.mockRestore();
      await endQuietly(bootstrapApp);
      await endQuietly(bootstrapAuth);
    }

    const org = await pools.authPool.query<{ id: string }>(
      'select id from auth.organization where slug = $1',
      [slug],
    );
    const tenantId = org.rows[0]?.id;
    if (tenantId === undefined) throw new Error('the bootstrap organization was not found');
    const userId = await userIdOf(adminEmail);

    const created = await only('catalog.audit.user_created', { [TENANT]: tenantId });
    expect(created).toMatchObject({
      [OPERATOR]: OPERATOR_ID,
      [USER_ID]: userId,
      'tayzu.identity.user.source': 'bootstrap',
    });
    expect(created).not.toHaveProperty(ACTOR_ID);
    expectNoLeak(created, [adminEmail, 'Events Bootstrap Admin']);

    // Every status change names its principal: the bootstrap writes as the operator.
    const status = await only('catalog.audit.user_status_changed', {
      [TENANT]: tenantId,
      [USER_ID]: userId,
    });
    expect(status).toMatchObject({
      [OPERATOR]: OPERATOR_ID,
      [STATUS_EVENT_KEY]: 'created_active',
      [STATUS_TO]: 'Active',
    });
    expect(status).not.toHaveProperty(ACTOR_ID);
    expectNoLeak(status, [adminEmail]);
  }, 180_000);

  it('Each lifecycle action emits its declared event: a reconcile run names the operator and, as a status writer, writes as the operator', async () => {
    // The reconcile reads every tenant: it runs against a private scratch database.
    const name = `tayzu_api_events_reconcile_${randomUUID().replaceAll('-', '')}`;
    const adminPool = new Pool({ connectionString: ownerDatabaseUrl(), max: 1 });
    await adminPool.query(`create database ${name}`);
    const ownerScratch = new Pool({ connectionString: databaseUrlFor(name) });
    const scratchApp = poolAs(databaseUrlFor(name), 'tayzu_app');
    const scratchAuthPool = poolAs(databaseUrlFor(name), 'tayzu_auth');
    const ran: { tenantId: string; memberId: string; memberEmail: string }[] = [];
    try {
      await runMigrations(ownerScratch);
      // No `userSync`: a membership added here writes no `_user` row, which the reconcile repairs.
      const scratchAuth = createAuth({
        db: drizzle(scratchAuthPool, { schema: authSchema }),
        secret: TEST_SECRET,
      });
      const api = scratchAuth.api as ScratchAuthApi;
      const owner = await createAdminUser(scratchAuth, {
        name: 'Events Reconcile Owner',
        email: emailOf('reconcile-owner'),
        password: TEST_PASSWORD,
      });
      const org = await api.createOrganization({
        body: {
          name: 'Events Reconcile',
          slug: `events-reconcile-${randomUUID()}`,
          userId: owner.userId,
        },
      });
      const tenantId = org.id;
      const memberEmail = emailOf('reconcile-member');
      const member = await createAdminUser(scratchAuth, {
        name: 'Events Reconcile Member',
        email: memberEmail,
        password: TEST_PASSWORD,
      });
      const memberId = member.userId;
      await api.addMember({ body: { userId: memberId, organizationId: tenantId, role: 'member' } });

      await reconcileUsersMain({
        env: {
          NODE_ENV: 'test',
          DATABASE_URL: databaseUrlFor(name),
          AUTH_DATABASE_URL: databaseUrlFor(name),
          CERBOS_ADDRESS: CERBOS,
          TAYZU_OPERATOR_ID: OPERATOR_ID,
        },
        appPool: scratchApp,
        authPool: scratchAuthPool,
      });
      ran.push({ tenantId, memberId, memberEmail });
    } finally {
      await endQuietly(scratchApp);
      await endQuietly(scratchAuthPool);
      await endQuietly(ownerScratch);
      await adminPool.query(`drop database if exists ${name} with (force)`);
      await endQuietly(adminPool);
    }

    const [scratch] = ran;
    if (scratch === undefined) throw new Error('the reconcile did not run');
    const { tenantId, memberId, memberEmail } = scratch;
    const reconciled = await only('catalog.audit.users_reconciled', { [TENANT]: tenantId });
    expect(reconciled[OPERATOR]).toBe(OPERATOR_ID);
    expect(reconciled).not.toHaveProperty(ACTOR_ID);
    expect(typeof reconciled['tayzu.identity.reconcile.created']).toBe('number');
    expect(typeof reconciled['tayzu.identity.reconcile.orphans']).toBe('number');
    expect(reconciled['tayzu.identity.reconcile.created']).toBeGreaterThanOrEqual(1);

    const status = await only('catalog.audit.user_status_changed', {
      [TENANT]: tenantId,
      [USER_ID]: memberId,
    });
    expect(status).toMatchObject({
      [OPERATOR]: OPERATOR_ID,
      [STATUS_EVENT_KEY]: 'created_active',
      [STATUS_TO]: 'Active',
    });
    expect(status).not.toHaveProperty(ACTOR_ID);
    expectNoLeak(status, [memberEmail]);
    expectNoLeak(reconciled, [memberEmail]);
  }, 240_000);

  // ---- Every status change names its principal -------------------------------------------

  it('Every status change names its principal: one user_status_changed for each status writer, with its principal, its status event, its subject and no email', async () => {
    const tenant = await newTenant('writers');
    const context = adminContext(tenant);
    const client = routerWith(gateWith());
    const emails: string[] = [];

    // 1. the invitation's hook: the admin, with the invitation's id as the subject and no user id
    const invited = await invite(client, tenant, emailOf('writer-invited'));
    emails.push(invited.email);
    const invitation = await only('catalog.audit.user_status_changed', {
      [INVITATION_ID]: invited.invitationId,
    });
    expect(invitation).toMatchObject({
      [TENANT]: tenant.organizationId,
      [ACTOR_ID]: tenant.userId,
      [STATUS_EVENT_KEY]: 'created_invited',
      [STATUS_TO]: 'Invited',
    });
    expect(invitation).not.toHaveProperty(USER_ID);
    expect(invitation).not.toHaveProperty(OPERATOR);

    // 2. the acceptance: the invitee
    const response = await acceptHttp({
      invitationId: invited.invitationId,
      token: invited.token,
      password: ACCEPT_PASSWORD,
    });
    expect(response.statusCode, response.body).toBeLessThan(300);
    const inviteeId = await userIdOf(invited.email);
    const acceptance = await only('catalog.audit.user_status_changed', {
      [USER_ID]: inviteeId,
      [STATUS_EVENT_KEY]: 'invitation_accepted',
    });
    expect(acceptance).toMatchObject({
      [TENANT]: tenant.organizationId,
      [ACTOR_ID]: inviteeId,
      [STATUS_TO]: 'Active',
    });
    expect(acceptance).not.toHaveProperty(OPERATOR);

    // 3. users.create: the admin, the user's id
    const created = await client.identity.users.create(
      { body: { email: emailOf('writer-created'), name: 'Writer Created', role: 'member' } },
      { context },
    );
    emails.push(created.email);
    const creation = await only('catalog.audit.user_status_changed', {
      [USER_ID]: created.userId,
      [STATUS_EVENT_KEY]: 'created_active',
    });
    expect(creation).toMatchObject({
      [TENANT]: tenant.organizationId,
      [ACTOR_ID]: tenant.userId,
      [STATUS_TO]: 'Active',
    });
    expect(creation).not.toHaveProperty(OPERATOR);

    // 4. setStatus: the admin
    await client.identity.users.setStatus(
      { params: { user: created.email }, body: { status: 'Disabled' } },
      { context },
    );
    const change = await only('catalog.audit.user_status_changed', {
      [USER_ID]: created.userId,
      [STATUS_EVENT_KEY]: 'admin_disable',
    });
    expect(change).toMatchObject({
      [TENANT]: tenant.organizationId,
      [ACTOR_ID]: tenant.userId,
      [STATUS_TO]: 'Disabled',
    });

    // 5. serviceAccounts.create: the admin, the service account's id as the subject
    const identifier = `svc-writers-${randomUUID().slice(0, 8)}`;
    await client.identity.serviceAccounts.create({ body: { identifier } }, { context });
    const service = await only('catalog.audit.user_status_changed', {
      [SERVICE_ACCOUNT_ID]: identifier,
    });
    expect(service).toMatchObject({
      [TENANT]: tenant.organizationId,
      [ACTOR_ID]: tenant.userId,
      [STATUS_EVENT_KEY]: 'created_active',
      [STATUS_TO]: 'Active',
    });
    expect(service).not.toHaveProperty(USER_ID);

    // 6. the first sign-in: the user themselves
    const member = await existingAccount();
    emails.push(member.email);
    await (app.auth.api as MemberAdminApi).addMember({
      body: { userId: member.userId, organizationId: tenant.organizationId, role: 'member' },
    });
    await userSync.upsertUser({
      tenantId: tenant.organizationId,
      email: member.email,
      name: 'Writer Member',
      status: 'Staged',
    });
    await signInAdminUser(app.auth, {
      email: member.email,
      password: TEST_PASSWORD,
      ip: randomIp(),
    });
    const firstSignIn = await only('catalog.audit.user_status_changed', {
      [USER_ID]: member.userId,
      [STATUS_EVENT_KEY]: 'first_sign_in',
    });
    expect(firstSignIn).toMatchObject({
      [TENANT]: tenant.organizationId,
      [ACTOR_ID]: member.userId,
      [STATUS_TO]: 'Active',
    });
    expect(firstSignIn).not.toHaveProperty(OPERATOR);

    // 7. the ban hook: no actor and no operator
    const banned = await existingAccount();
    emails.push(banned.email);
    await (app.auth.api as MemberAdminApi).addMember({
      body: { userId: banned.userId, organizationId: tenant.organizationId, role: 'member' },
    });
    // The hook runs on an endpoint call (it needs a request context): the admin plugin's ban.
    const platformAdmin = emailOf('platform-admin');
    const banApi = app.auth.api as BanApi;
    await banApi.createUser({
      body: {
        name: 'Events Platform Admin',
        email: platformAdmin,
        password: TEST_PASSWORD,
        role: 'admin',
      },
    });
    const platformSession = await signInAdminUser(app.auth, {
      email: platformAdmin,
      password: TEST_PASSWORD,
      ip: randomIp(),
    });
    await banApi.banUser({
      body: { userId: banned.userId },
      headers: new Headers({ cookie: platformSession.cookie }),
    });
    const ban = await only('catalog.audit.user_status_changed', {
      [USER_ID]: banned.userId,
      [STATUS_EVENT_KEY]: 'admin_disable',
    });
    expect(ban).toMatchObject({ [TENANT]: tenant.organizationId, [STATUS_TO]: 'Disabled' });
    expect(ban).not.toHaveProperty(ACTOR_ID);
    expect(ban).not.toHaveProperty(OPERATOR);

    for (const attributes of [
      invitation,
      acceptance,
      creation,
      change,
      service,
      firstSignIn,
      ban,
    ]) {
      expectNoLeak(attributes, [...emails, 'Writer Created', 'Writer Member']);
    }
    // 8 and 9, the reconcile and the bootstrap, are asserted in the two tests above, each in the
    // operator form with no actor.
  }, 240_000);
});
