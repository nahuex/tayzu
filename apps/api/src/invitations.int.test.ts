/**
 * Task 7.3 of openspec/changes/043-identity-lifecycle-and-org-admin (spec
 * "Invitation lifecycle", "Invitation email is fixed and capped" and "User
 * status has four states"; design D2, D4 "Reaching Better Auth" and "Hooks";
 * Resolved decisions Q42, Q76, Q117 and Q126).
 *
 * Task 7.3 Verify: "`invitations.int.test.ts` mints a real session and covers
 * "Invite sends exactly one email with exactly one link" and "Explicit invite
 * starts a user as invited" (one `_user` write, made by the hook, whose change
 * event carries the admin as `onBehalfOf`, and one
 * `catalog.audit.user_status_changed` with the admin, the status event
 * `created_invited`, `tayzu.identity.invitation.id` equal to the created
 * invitation's id and no email) using the recording fake, "The invitation link
 * never leaves the email" (neither the token nor the id-plus-token link in the
 * response, in any log record or in what the non-sending sender keeps) and a
 * call whose context carries no valid session headers failing closed with
 * nothing created."
 *
 * Scenarios (verbatim from the spec):
 * - "Invite sends exactly one email with exactly one link": WHEN an admin
 *   invites `bob@example.com`, THEN exactly one email is sent to it, AND the
 *   email contains exactly one clickable link, the invitation-accept link, and
 *   states the 48-hour expiry.
 * - "Explicit invite starts a user as invited": WHEN an admin invites
 *   `alice@example.com`, THEN a `_user` entity for it exists with status
 *   `Invited`.
 * - "The invitation link never leaves the email": WHEN an admin invites ... to
 *   `bob@example.com`, THEN the response, every log record and anything the
 *   non-sending sender keeps contain neither the token nor the id-plus-token
 *   link, which only the email carries.
 *
 * ## Harness
 *
 * A real Better Auth instance built with `userSync` (the Q30 adapter over the
 * catalog's `createUserSync`), a real Cerbos container, a real session minted
 * through `bootstrapTestTenant` (the cookie becomes the `Headers` the router
 * context carries), the recording `EmailSender` behind the real
 * `createEmailTenantGate`, and one fresh organization (the tenant) per test.
 *
 * ## Production symbols expected
 *
 * - `createIdentityRouter` (`./identity-router.js`) gains two options:
 *   `emailGate: EmailTenantGate` (`./identity/email-tenant-gate.js`, the one
 *   gate of 6.5c) and `invitationLinkBaseUrl: string` (the trusted
 *   `INVITATION_LINK_BASE_URL`, used with `buildInvitationLink`).
 * - The router gains `identity.users.invite`, input `{ email, role }`, Cerbos
 *   `user` / `invite`. The router context carries the request's session
 *   headers as a web `Headers`; the host key is unspecified by the design, so
 *   this test supplies the same `Headers` under both `__requestHeaders` and
 *   `__stepUpHeaders`. It runs `auth.api.createInvitation({ body, headers })`
 *   inside `runWithIdentityContext({ adminId })`, stores
 *   `digestInvitationToken(token)` in `auth.verification` (identifier
 *   `invitation-accept:<invitationId>`, `expires_at` equal to the invitation's)
 *   and sends one `InvitationEmail` through the gate. Its response carries
 *   neither the token nor the link.
 * - `createAuth` (`packages/auth/src/auth.ts`) gains the organization hook
 *   `afterCreateInvitation`, which calls `userSync.upsertUser({ tenantId,
 *   email, name, change: 'created_invited', invitationId })` (no `userId`).
 *
 * ## Why this fails right now
 *
 * `identity.users.invite` does not exist (`TypeError: ... is not a function`).
 */
// Load-bearing import order (design D1): the telemetry harness registers
// before anything that loads `@tayzu/auth` creates its logger.
import { registration, type TelemetryTestHarness } from './__fixtures__/link-telemetry.js';
import { randomInt, randomUUID } from 'node:crypto';

import { createRouterClient } from '@orpc/server';
import { authSchema, createAuth, createRecordingEmailSender, type AuthInstance } from '@tayzu/auth';
import { createCerbosClient, type CerbosClient } from '@tayzu/authz';
import { createUserSync } from '@tayzu/catalog';
import { runMigrations } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { bootstrapTestTenant } from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { renderInvitationEmail } from '../../../packages/auth/src/identity/email/invitation-email-template.js';
import { verifyInvitationToken } from '../../../packages/auth/src/identity/invitation-token.js';
import { TEST_PASSWORD, TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createAuthRepository } from './identity/auth-repository.js';
import { createEmailTenantGate } from './identity/email-tenant-gate.js';
import { createInMemoryEmailCapStore } from './identity/invitation-caps.js';
import { createUserSyncAdapter } from './identity/user-sync-adapter.js';
import { createIdentityRouter } from './identity-router.js';

const LINK_BASE_URL = 'https://app.tayzu.test';
const STATUS_EVENT = 'catalog.audit.user_status_changed';

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

interface InvitationRow {
  readonly id: string;
  readonly status: string;
  readonly expires_ms: string;
}

interface VerificationRow {
  readonly value: string;
  readonly expires_ms: string;
}

describe('identity.users.invite (task 7.3, design D4, Resolved decisions Q42, Q76, Q117, Q126)', () => {
  let harness: TelemetryTestHarness;
  let authPool: Pool;
  let auth: AuthInstance;
  let cerbos: CerbosClient;
  let userSync: ReturnType<typeof createUserSync>;
  let sender: ReturnType<typeof createRecordingEmailSender>;
  let client: ReturnType<
    typeof createRouterClient<ReturnType<typeof createIdentityRouter>, Record<string, unknown>>
  >;

  beforeAll(async () => {
    if ('error' in registration) {
      throw new Error(`createTelemetryTestHarness() failed: ${String(registration.error)}`, {
        cause: registration.error,
      });
    }
    harness = registration.harness;
    const pools = await harnessPools();
    authPool = pools.authPool;
    await runMigrations(authPool);
    cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    userSync = createUserSync({ pool: pools.appPool, authz: cerbos });
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync: createUserSyncAdapter({ userSync }),
    });
    sender = createRecordingEmailSender();
    const capStore = createInMemoryEmailCapStore({
      tenant: { max: 1000, windowSeconds: 3600 },
      recipient: { max: 1000, windowSeconds: 86_400 },
    });
    client = createRouterClient(
      createIdentityRouter({
        auth,
        authz: cerbos,
        authRepository: createAuthRepository(authPool),
        emailGate: createEmailTenantGate({ disabledTenantIds: [], capStore, sender }),
        invitationLinkBaseUrl: LINK_BASE_URL,
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );
  }, 60_000);

  /** A real admin session for a fresh organization (the tenant). */
  async function freshTenant(): Promise<{
    tenantId: string;
    adminId: string;
    cookie: string;
  }> {
    const id = randomUUID();
    const t = await bootstrapTestTenant(auth, {
      name: 'Invite Admin',
      email: `invite-admin-${id}@example.test`,
      password: TEST_PASSWORD,
      organizationName: 'Invite Org',
      organizationSlug: `invite-${id}`,
      ip: randomIp(),
    });
    return { tenantId: t.organizationId, adminId: t.userId, cookie: t.cookie };
  }

  function context(
    tenant: { tenantId: string; adminId: string },
    headers: Headers | undefined,
  ): Record<string, unknown> {
    return {
      tenantId: tenant.tenantId,
      actor: { type: 'user', id: tenant.adminId },
      principal: { roles: ['admin'] },
      ...(headers === undefined ? {} : { __requestHeaders: headers, __stepUpHeaders: headers }),
    };
  }

  function sessionContext(tenant: {
    tenantId: string;
    adminId: string;
    cookie: string;
  }): Record<string, unknown> {
    return context(tenant, new Headers({ cookie: tenant.cookie, 'x-forwarded-for': randomIp() }));
  }

  async function invitationsOf(tenantId: string, email: string): Promise<readonly InvitationRow[]> {
    const result = await authPool.query<InvitationRow>(
      `select id, status, (extract(epoch from expires_at) * 1000)::text as expires_ms
       from auth.invitation where organization_id = $1 and email = $2`,
      [tenantId, email],
    );
    return result.rows;
  }

  async function verificationOf(invitationId: string): Promise<readonly VerificationRow[]> {
    const result = await authPool.query<VerificationRow>(
      `select value, (extract(epoch from expires_at) * 1000)::text as expires_ms
       from auth.verification where identifier = $1`,
      [`invitation-accept:${invitationId}`],
    );
    return result.rows;
  }

  function emailsTo(email: string) {
    return sender.sent.filter((message) => message.to === email);
  }

  async function logRecords() {
    await harness.forceFlush();
    return [...harness.logExporter.getFinishedLogRecords()];
  }

  it('Invite sends exactly one email with exactly one link: one email to the invitee, one accept link, the 48-hour expiry, and the digest of its token stored', async () => {
    const tenant = await freshTenant();
    const email = `bob-${randomUUID()}@example.test`;

    // WHEN an admin invites `bob@example.com`.
    await client.identity.users.invite(
      { email, role: 'member' },
      { context: sessionContext(tenant) },
    );

    // THEN exactly one email is sent to it...
    const messages = emailsTo(email);
    expect(messages, 'exactly one email to the invitee').toHaveLength(1);
    const template = messages[0]?.template;
    expect(template?.kind).toBe('InvitationEmail');
    if (template?.kind !== 'InvitationEmail') throw new Error('unreachable');

    // ...carrying exactly one link, the invitation-accept link, whose origin is the trusted setting.
    const invitations = await invitationsOf(tenant.tenantId, email);
    expect(invitations, 'one invitation was created').toHaveLength(1);
    const invitationId = invitations[0]?.id ?? '';
    const link = new URL(template.link);
    expect(link.origin).toBe(LINK_BASE_URL);
    const fragment = new URLSearchParams(link.hash.slice(1));
    expect(fragment.get('invitation')).toBe(invitationId);
    const token = fragment.get('token') ?? '';
    expect(token.length).toBeGreaterThan(0);

    const rendered = renderInvitationEmail(template);
    expect(rendered.html.match(/href="/g) ?? [], 'exactly one clickable link').toHaveLength(1);
    expect(rendered.html.match(/https?:\/\//g) ?? [], 'no other URL in the body').toHaveLength(1);
    // ...and states the 48-hour expiry.
    expect(template.expiryText).toMatch(/48/);

    // The token proves mailbox control: only its digest is stored, with the invitation's expiry.
    const stored = await verificationOf(invitationId);
    expect(stored, 'one verification row for the invitation').toHaveLength(1);
    expect(stored[0]?.value).not.toBe(token);
    expect(verifyInvitationToken(token, stored[0]?.value ?? null)).toBe(true);
    expect(stored[0]?.expires_ms).toBe(invitations[0]?.expires_ms);
  }, 60_000);

  it('Explicit invite starts a user as invited: the hook writes one _user as Invited, onBehalfOf the admin, with one status event naming the admin and the invitation', async () => {
    const tenant = await freshTenant();
    const email = `alice-${randomUUID()}@example.test`;
    expect(await userSync.getUser({ tenantId: tenant.tenantId, email })).toBeNull();

    // WHEN an admin invites `alice@example.com`.
    await client.identity.users.invite(
      { email, role: 'member' },
      { context: sessionContext(tenant) },
    );

    // THEN a `_user` entity for it exists with status `Invited`...
    const row = await userSync.getUser({ tenantId: tenant.tenantId, email });
    expect(row, 'a _user entity exists for the invited email').not.toBeNull();
    expect(row?.status).toBe('Invited');

    // ...written once (by the hook), with the admin as `onBehalfOf`.
    const events = await authPool.query<{
      actor_type: string;
      on_behalf_of_type: string | null;
      on_behalf_of_id: string | null;
    }>(
      `select actor_type, on_behalf_of_type, on_behalf_of_id from catalog_change_event
       where tenant_id = $1 and blueprint_identifier = '_user' and resource_identifier = $2
       order by seq`,
      [tenant.tenantId, email],
    );
    expect(events.rows, 'exactly one _user write').toHaveLength(1);
    expect(events.rows[0]?.actor_type).toBe('system');
    expect(events.rows[0]?.on_behalf_of_type).toBe('user');
    expect(events.rows[0]?.on_behalf_of_id).toBe(tenant.adminId);

    // ...and one status event: the admin, `created_invited`, the invitation id, no email.
    const invitations = await invitationsOf(tenant.tenantId, email);
    expect(invitations).toHaveLength(1);
    const statusEvents = (await logRecords()).filter(
      (record) =>
        record.eventName === STATUS_EVENT &&
        record.attributes['tayzu.tenant.id'] === tenant.tenantId,
    );
    const invited = statusEvents.filter(
      (record) => record.attributes['tayzu.identity.user.status.event'] === 'created_invited',
    );
    expect(invited).toHaveLength(1);
    const attributes = invited[0]?.attributes;
    expect(attributes?.['tayzu.actor.id']).toBe(tenant.adminId);
    expect(attributes?.['tayzu.identity.user.status.to']).toBe('Invited');
    expect(attributes?.['tayzu.identity.invitation.id']).toBe(invitations[0]?.id);
    expect(JSON.stringify(attributes)).not.toContain(email);
  }, 60_000);

  it('The invitation link never leaves the email: neither the token nor the id-plus-token link is in the response or in any log record', async () => {
    const tenant = await freshTenant();
    const email = `bob-${randomUUID()}@example.test`;

    // WHEN an admin invites `bob@example.com`.
    const response = await client.identity.users.invite(
      { email, role: 'member' },
      { context: sessionContext(tenant) },
    );

    const template = emailsTo(email)[0]?.template;
    if (template?.kind !== 'InvitationEmail') throw new Error('the invitation email was not sent');
    const link = new URL(template.link);
    const fragment = new URLSearchParams(link.hash.slice(1));
    const token = fragment.get('token') ?? '';
    const invitationId = fragment.get('invitation') ?? '';
    expect(token.length).toBeGreaterThan(0);

    // THEN the response contains neither the token nor the link...
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(template.link);
    expect(serialized).not.toContain('/accept-invitation');
    expect(serialized).not.toContain(`invitation=${invitationId}`);

    // ...nor does any log record.
    for (const record of await logRecords()) {
      const text = JSON.stringify({ body: record.body, attributes: record.attributes });
      expect(text).not.toContain(token);
      expect(text).not.toContain(template.link);
    }
  }, 60_000);

  it('A call whose context carries no valid session headers fails closed with nothing created', async () => {
    const tenant = await freshTenant();

    const noHeaders = `nohdr-${randomUUID()}@example.test`;
    const badSession = `badsess-${randomUUID()}@example.test`;
    const attempts: readonly [string, Record<string, unknown>][] = [
      [noHeaders, context(tenant, undefined)],
      [
        badSession,
        context(tenant, new Headers({ cookie: 'better-auth.session_token=forged.value' })),
      ],
    ];
    for (const [email, callContext] of attempts) {
      const thrown: unknown = await client.identity.users
        .invite({ email, role: 'member' }, { context: callContext })
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(thrown, 'the call must be rejected').toBeDefined();
      expect(await invitationsOf(tenant.tenantId, email), 'no invitation').toEqual([]);
      expect(await userSync.getUser({ tenantId: tenant.tenantId, email }), 'no _user').toBeNull();
      expect(emailsTo(email), 'no email').toEqual([]);
    }
  }, 60_000);

  // Task 7.4 (design D4 "Roles", Resolved decisions Q9 and Q19). Scenarios:
  // - "Inviting with the owner role is rejected" / "A role that is not exactly
  //   member or admin is rejected": the operation fails with
  //   `CATALOG_VALIDATION_FAILED` and no invitation, `_user` entity or email is
  //   created. The role is an exact match: `inviteMember` accepts
  //   comma-separated strings and arrays, so those must be rejected too.
  // - "An admin invitation is logged with its role": `catalog.audit.invitation_created`
  //   is logged with role `admin`.
  // Expected production behavior: `parseInviteInput` (apps/api/src/identity-router.ts)
  // accepts only the strings `member` and `admin`; the invite handler emits the
  // `catalog.audit.invitation_created` log event with `tayzu.tenant.id`,
  // `tayzu.actor.type`, `tayzu.actor.id`, `tayzu.identity.invitation.id` and
  // `tayzu.identity.invitation.role`.
  const REJECTED_ROLES: readonly [string, unknown][] = [
    ['owner', 'owner'],
    ['member,owner', 'member,owner'],
    ["['owner']", ['owner']],
    ['Admin', 'Admin'],
    ['an arbitrary value', 'superuser'],
  ];

  it.each(REJECTED_ROLES)(
    'Inviting with the owner role is rejected: role %s fails with CATALOG_VALIDATION_FAILED and nothing is created',
    async (_label, role) => {
      const tenant = await freshTenant();
      const email = `badrole-${randomUUID()}@example.test`;

      const thrown: unknown = await client.identity.users
        .invite({ email, role }, { context: sessionContext(tenant) })
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(thrown, 'the call must be rejected').toBeDefined();
      expect((thrown as { code?: unknown }).code).toBe('CATALOG_VALIDATION_FAILED');
      expect(await invitationsOf(tenant.tenantId, email), 'no invitation').toEqual([]);
      expect(await userSync.getUser({ tenantId: tenant.tenantId, email }), 'no _user').toBeNull();
      expect(emailsTo(email), 'no email').toEqual([]);
    },
    60_000,
  );

  it('An admin invitation is logged with its role: catalog.audit.invitation_created carries role admin, the admin and the invitation id, and no email', async () => {
    const tenant = await freshTenant();
    const email = `carol-${randomUUID()}@example.test`;

    // WHEN an admin invites `bob@example.com` with role `admin`.
    await client.identity.users.invite(
      { email, role: 'admin' },
      { context: sessionContext(tenant) },
    );

    // THEN `catalog.audit.invitation_created` is logged with role `admin`.
    const invitations = await invitationsOf(tenant.tenantId, email);
    expect(invitations).toHaveLength(1);
    const created = (await logRecords()).filter(
      (record) =>
        record.eventName === 'catalog.audit.invitation_created' &&
        record.attributes['tayzu.tenant.id'] === tenant.tenantId,
    );
    expect(created, 'exactly one invitation_created event').toHaveLength(1);
    const attributes = created[0]?.attributes;
    expect(attributes?.['tayzu.identity.invitation.role']).toBe('admin');
    expect(attributes?.['tayzu.actor.type']).toBe('user');
    expect(attributes?.['tayzu.actor.id']).toBe(tenant.adminId);
    expect(attributes?.['tayzu.identity.invitation.id']).toBe(invitations[0]?.id);
    expect(JSON.stringify(attributes)).not.toContain(email);
  }, 60_000);

  // Task 7.5 (spec "Invitation lifecycle"; design D4, Resolved decision Q42).
  // Scenario "Re-inviting cancels the previous invitation": GIVEN a `pending`
  // invitation to `bob@example.com`, WHEN the admin invites `bob@example.com`
  // again, THEN the first invitation's state becomes `cancelled` and a new
  // `pending` invitation is created with a fresh 48-hour expiry.
  // Stored `cancelled` is Better Auth's `canceled`. The `re_invite` cancel
  // reason (span `identity.invitation.cancel`) is not asserted: the scenario
  // leaves open who emits it, since Better Auth makes the cancel itself.
  it('Re-inviting cancels the previous invitation: the first becomes cancelled and a new pending one has a fresh 48-hour expiry', async () => {
    const tenant = await freshTenant();
    const email = `bob-${randomUUID()}@example.test`;
    const HOURS_48_MS = 48 * 60 * 60 * 1000;
    const TOLERANCE_MS = 60_000;

    // GIVEN a pending invitation to `bob@example.com`.
    const first = await client.identity.users.invite(
      { email, role: 'member' },
      { context: sessionContext(tenant) },
    );
    const firstRows = await invitationsOf(tenant.tenantId, email);
    expect(firstRows).toHaveLength(1);
    expect(firstRows[0]?.id).toBe(first.invitationId);
    expect(firstRows[0]?.status).toBe('pending');

    // WHEN the admin invites `bob@example.com` again.
    const before = Date.now();
    const second = await client.identity.users.invite(
      { email, role: 'member' },
      { context: sessionContext(tenant) },
    );
    const after = Date.now();
    expect(second.invitationId).not.toBe(first.invitationId);

    // THEN the first invitation's state becomes cancelled...
    const rows = await invitationsOf(tenant.tenantId, email);
    expect(rows, 'two invitations exist for the email').toHaveLength(2);
    const previous = rows.find((row) => row.id === first.invitationId);
    expect(previous?.status, 'the first invitation is stored as canceled').toBe('canceled');

    // ...and a new pending invitation exists with a fresh 48-hour expiry.
    const fresh = rows.find((row) => row.id === second.invitationId);
    expect(fresh?.status).toBe('pending');
    const expiresAt = Number(fresh?.expires_ms ?? 0);
    expect(expiresAt).toBeGreaterThanOrEqual(before + HOURS_48_MS - TOLERANCE_MS);
    expect(expiresAt).toBeLessThanOrEqual(after + HOURS_48_MS + TOLERANCE_MS);
    expect(rows.filter((row) => row.status === 'pending')).toHaveLength(1);
  }, 60_000);

  // Task 7.6 (spec "Invitation lifecycle"; design D4 "Resend", D14, Resolved
  // decisions Q47 and Q129). Scenario "Admin can cancel a pending invitation":
  // GIVEN a pending invitation to `bob@example.com`, WHEN the admin cancels it,
  // THEN its state becomes `cancelled` and it can no longer be accepted.
  // Expected production behavior: `identity.users.cancelInvitation`
  // (apps/api/src/identity-router.ts), input `{ invitation: <id> }` (the
  // `{invitation}` path parameter), Cerbos `user` / `invite`, which resolves the
  // invitation of the caller's tenant on the server and cancels it through Better
  // Auth's `cancelInvitation` with the forwarded session headers. Stored
  // `cancelled` is Better Auth's `canceled`. "Can no longer be accepted" is
  // asserted as the stored status leaving `pending`, the only state the
  // acceptance (task 8) takes (spec: only a `pending` invitation is acceptable).
  it('Admin can cancel a pending invitation: its state becomes cancelled and it is no longer pending', async () => {
    const tenant = await freshTenant();
    const email = `bob-${randomUUID()}@example.test`;

    // GIVEN a pending invitation to `bob@example.com`.
    const created = await client.identity.users.invite(
      { email, role: 'member' },
      { context: sessionContext(tenant) },
    );
    const before = await invitationsOf(tenant.tenantId, email);
    expect(before).toHaveLength(1);
    expect(before[0]?.id).toBe(created.invitationId);
    expect(before[0]?.status).toBe('pending');

    // WHEN the admin cancels it.
    await client.identity.users.cancelInvitation(
      { invitation: created.invitationId },
      { context: sessionContext(tenant) },
    );

    // THEN its state becomes cancelled (Better Auth stores `canceled`)...
    const after = await invitationsOf(tenant.tenantId, email);
    expect(after).toHaveLength(1);
    expect(after[0]?.status).toBe('canceled');
    // ...so it is no longer a pending, acceptable invitation.
    expect(after.filter((row) => row.status === 'pending')).toEqual([]);
  }, 60_000);

  // Task 7.7 (spec "Invitation lifecycle"; design D4 "Resend", Resolved
  // decisions Q123 and Q128). Scenario "Resending issues a new link and keeps
  // the expiry": GIVEN a pending invitation to `bob@example.com` created 10
  // hours ago, WHEN the admin resends it, THEN another email is sent to it whose
  // link works and whose earlier link no longer works, AND the invitation's
  // expiry is still 48 hours from its original creation, not from the resend.
  // Task 7.7 Verify adds: the response carries neither the token nor the link.
  // Expected production behavior: `identity.users.resendInvitation`
  // (apps/api/src/identity-router.ts), input `{ invitation: <id> }`, Cerbos
  // `user` / `invite`, which replaces the digest in `auth.verification`
  // (identifier `invitation-accept:<id>`) for the same invitation, leaves
  // `auth.invitation.expires_at` alone and sends one `InvitationEmail` through
  // the gate. "Works" / "no longer works" is asserted with
  // `verifyInvitationToken` against the stored digest.
  it('Resending issues a new link and keeps the expiry: a second email with a working link, the old token no longer verifies, expiresAt is unchanged and the response carries neither token nor link', async () => {
    const tenant = await freshTenant();
    const email = `bob-${randomUUID()}@example.test`;
    const TEN_HOURS_SECONDS = 10 * 60 * 60;

    // GIVEN a pending invitation to `bob@example.com` created 10 hours ago.
    const created = await client.identity.users.invite(
      { email, role: 'member' },
      { context: sessionContext(tenant) },
    );
    await authPool.query(
      `update auth.invitation set expires_at = expires_at - make_interval(secs => $2)
       where id = $1`,
      [created.invitationId, TEN_HOURS_SECONDS],
    );
    await authPool.query(
      `update auth.verification set expires_at = expires_at - make_interval(secs => $2)
       where identifier = $1`,
      [`invitation-accept:${created.invitationId}`, TEN_HOURS_SECONDS],
    );
    const firstTemplate = emailsTo(email)[0]?.template;
    if (firstTemplate?.kind !== 'InvitationEmail') throw new Error('the first email was not sent');
    const oldToken =
      new URLSearchParams(new URL(firstTemplate.link).hash.slice(1)).get('token') ?? '';
    expect(oldToken.length).toBeGreaterThan(0);
    const beforeRows = await invitationsOf(tenant.tenantId, email);
    expect(beforeRows[0]?.status).toBe('pending');
    const expiryBefore = beforeRows[0]?.expires_ms;
    const verificationBefore = await verificationOf(created.invitationId);
    expect(verificationBefore).toHaveLength(1);
    expect(verifyInvitationToken(oldToken, verificationBefore[0]?.value ?? null)).toBe(true);

    // WHEN the admin resends it.
    const response = await client.identity.users.resendInvitation(
      { invitation: created.invitationId },
      { context: sessionContext(tenant) },
    );

    // THEN another email is sent to `bob@example.com`...
    const messages = emailsTo(email);
    expect(messages, 'the invite email and exactly one resend email').toHaveLength(2);
    const template = messages[1]?.template;
    if (template?.kind !== 'InvitationEmail') throw new Error('the resend email was not sent');
    const fragment = new URLSearchParams(new URL(template.link).hash.slice(1));
    expect(fragment.get('invitation')).toBe(created.invitationId);
    const newToken = fragment.get('token') ?? '';
    expect(newToken.length).toBeGreaterThan(0);
    expect(newToken).not.toBe(oldToken);

    // ...whose link works and whose earlier link no longer works.
    const stored = await verificationOf(created.invitationId);
    expect(stored, 'still one verification row for the invitation').toHaveLength(1);
    expect(verifyInvitationToken(newToken, stored[0]?.value ?? null)).toBe(true);
    expect(verifyInvitationToken(oldToken, stored[0]?.value ?? null)).toBe(false);

    // AND the invitation's expiry is unchanged (not reset to now + 48 hours).
    const afterRows = await invitationsOf(tenant.tenantId, email);
    expect(afterRows).toHaveLength(1);
    expect(afterRows[0]?.status).toBe('pending');
    expect(afterRows[0]?.expires_ms).toBe(expiryBefore);
    expect(stored[0]?.expires_ms).toBe(expiryBefore);

    // The response carries neither the token nor the link.
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain(newToken);
    expect(serialized).not.toContain(oldToken);
    expect(serialized).not.toContain(template.link);
    expect(serialized).not.toContain('/accept-invitation');
    expect(serialized).not.toContain(`invitation=${created.invitationId}`);
  }, 60_000);

  // Task 7.8 (spec "Invitation lifecycle"; design D4 "Hooks"). Scenario "A
  // disabled user cannot be invited": GIVEN a `Disabled` user
  // `bob@example.com`, WHEN an admin invites `bob@example.com`, THEN the
  // operation fails and no email is sent.
  // Setup: the `Disabled` `_user` is written through the same Q30 adapter the
  // hooks use (`created_active`, then `admin_disable`), so the status is real.
  // Expected production behavior: `identity.users.invite` (or the
  // `afterCreateInvitation` hook it runs) rejects the invite of an email whose
  // `_user` is `Disabled`, before any email is sent. The error code is not
  // asserted (the scenario only says "fails"). The user stays `Disabled`.
  it('A disabled user cannot be invited: the operation fails, no email is sent and the user stays Disabled', async () => {
    const tenant = await freshTenant();
    const email = `bob-${randomUUID()}@example.test`;

    // GIVEN a `Disabled` user `bob@example.com`.
    const adapter = createUserSyncAdapter({ userSync });
    const base = { tenantId: tenant.tenantId, email, name: 'Bob' };
    await adapter.writeUserChange({ ...base, change: 'created_active' });
    await adapter.writeUserChange({ ...base, change: 'admin_disable' });
    expect((await userSync.getUser({ tenantId: tenant.tenantId, email }))?.status).toBe('Disabled');

    // WHEN an admin invites `bob@example.com`.
    const thrown: unknown = await client.identity.users
      .invite({ email, role: 'member' }, { context: sessionContext(tenant) })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // THEN the operation fails and no email is sent.
    expect(thrown, 'the call must be rejected').toBeDefined();
    expect(emailsTo(email), 'no email').toEqual([]);
    expect((await userSync.getUser({ tenantId: tenant.tenantId, email }))?.status).toBe('Disabled');
  }, 60_000);

  // Task 7.9 (spec "Only an admin may invite a user or change another user's
  // status"; design D4, Cerbos `user` / `invite`). Scenario "Non-admin cannot
  // invite": WHEN an actor without the invite grant attempts to invite a user,
  // THEN the operation is denied with `AUTH_FORBIDDEN`, no invitation is
  // created and `catalog.security.authz_denied` is logged.
  // Runs against the real Cerbos container (`cerbos` above). The caller holds a
  // valid session (the tenant's admin cookie) but the host-resolved principal
  // carries only the `member` role, so the wrapper's Cerbos check must deny
  // before Better Auth is reached.
  it('Non-admin cannot invite: AUTH_FORBIDDEN, no invitation, no _user, no email, and catalog.security.authz_denied is logged', async () => {
    const tenant = await freshTenant();
    const memberId = `member-${randomUUID()}`;
    const email = `denied-${randomUUID()}@example.test`;
    const headers = new Headers({ cookie: tenant.cookie, 'x-forwarded-for': randomIp() });

    // WHEN an actor without the invite grant attempts to invite a user.
    const thrown: unknown = await client.identity.users
      .invite(
        { email, role: 'member' },
        {
          context: {
            tenantId: tenant.tenantId,
            actor: { type: 'user', id: memberId },
            principal: { roles: ['member'] },
            __requestHeaders: headers,
            __stepUpHeaders: headers,
          },
        },
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // THEN the operation is denied with AUTH_FORBIDDEN...
    expect(thrown, 'the call must be rejected').toBeDefined();
    expect((thrown as { code?: unknown }).code).toBe('AUTH_FORBIDDEN');

    // ...no invitation is created (nor a _user, nor an email)...
    expect(await invitationsOf(tenant.tenantId, email), 'no invitation').toEqual([]);
    expect(await userSync.getUser({ tenantId: tenant.tenantId, email }), 'no _user').toBeNull();
    expect(emailsTo(email), 'no email').toEqual([]);

    // ...and catalog.security.authz_denied is logged.
    const denied = (await logRecords()).filter(
      (record) =>
        record.eventName === 'catalog.security.authz_denied' &&
        record.attributes['tayzu.tenant.id'] === tenant.tenantId,
    );
    expect(denied, 'exactly one authz_denied log').toHaveLength(1);
    expect(denied[0]?.attributes).toMatchObject({
      'tayzu.actor.type': 'user',
      'tayzu.actor.id': memberId,
      'tayzu.authz.resource.kind': 'user',
      'tayzu.authz.action': 'invite',
    });
    expect(JSON.stringify(denied[0])).not.toContain(email);
  }, 60_000);

  // Task 7.12 (spec "Invitation lifecycle"; design D2/D4 plugin options, Resolved
  // decisions Q105, Q123). Better Auth's own errors never reach the response as
  // they are: `USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION`, the default
  // `invitationLimit` of 100 pending invitations (FORBIDDEN
  // `INVITATION_LIMIT_REACHED`) and the default `membershipLimit` of 100 members
  // (`addMember` FORBIDDEN) all map to `CATALOG_VALIDATION_FAILED` with no
  // provider text. The acceptance's `member_limit` reason belongs to task 8.7.
  // Expected production behavior: the `identity.users.invite` and
  // `identity.users.create` handlers (apps/api/src/identity-router.ts) catch
  // Better Auth's APIError and rethrow the router's generic
  // `CATALOG_VALIDATION_FAILED` error (fixed message, no provider code or text).
  const PROVIDER_TEXT =
    /already|member|limit|forbidden|INVITATION_LIMIT|USER_IS|reached|organization/i;
  const PLATFORM_LIMIT = 100;

  async function rejection(call: Promise<unknown>): Promise<unknown> {
    const thrown: unknown = await call.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown, 'the call must be rejected').toBeDefined();
    return thrown;
  }

  function expectGenericRejection(thrown: unknown): void {
    expect((thrown as { code?: unknown }).code).toBe('CATALOG_VALIDATION_FAILED');
    const error = thrown as { message?: unknown; data?: unknown; status?: unknown };
    const visible = JSON.stringify({
      code: (thrown as { code?: unknown }).code,
      message: error.message,
      data: error.data,
    }).replace('CATALOG_VALIDATION_FAILED', '');
    expect(visible, 'no provider text and no membership information').not.toMatch(PROVIDER_TEXT);
  }

  async function seedUsers(count: number, tag: string): Promise<readonly string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) ids.push(`seed-${tag}-${i.toString(10)}`);
    await authPool.query(
      `insert into auth."user" (id, name, email, email_verified, created_at, updated_at)
       select id, 'Seed', id || '@example.test', false, now(), now() from unnest($1::text[]) as id`,
      [ids],
    );
    return ids;
  }

  async function memberCount(tenantId: string): Promise<number> {
    const result = await authPool.query<{ n: string }>(
      `select count(*) as n from auth.member where organization_id = $1`,
      [tenantId],
    );
    return Number(result.rows[0]?.n ?? '0');
  }

  it('Inviting an existing member is rejected generically: CATALOG_VALIDATION_FAILED, no provider text, no membership information, nothing created or sent', async () => {
    const tenant = await freshTenant();
    const email = `member-${randomUUID()}@example.test`;
    await client.identity.users.create(
      { email, name: 'Existing Member', role: 'member' },
      { context: sessionContext(tenant) },
    );
    const sentBefore = emailsTo(email).length;

    // WHEN an admin invites an email that already belongs to a member.
    const thrown = await rejection(
      client.identity.users.invite({ email, role: 'member' }, { context: sessionContext(tenant) }),
    );

    // THEN the generic code answers, without Better Auth's text or any membership hint...
    expectGenericRejection(thrown);
    // ...and no invitation or email results.
    expect(await invitationsOf(tenant.tenantId, email), 'no invitation').toEqual([]);
    expect(emailsTo(email).length, 'no email').toBe(sentBefore);
  }, 60_000);

  it('Exceeding 100 pending invitations is rejected generically: CATALOG_VALIDATION_FAILED, no provider text, no invitation or email', async () => {
    const tenant = await freshTenant();
    // GIVEN 100 pending invitations in the organization.
    await authPool.query(
      `insert into auth.invitation (id, organization_id, email, role, status, expires_at, created_at, inviter_id)
       select 'seed-inv-' || $1 || '-' || n, $1, 'pending-' || n || '-' || $1 || '@example.test',
              'member', 'pending', now() + interval '48 hours', now(), $2
       from generate_series(1, $3::int) as n`,
      [tenant.tenantId, tenant.adminId, PLATFORM_LIMIT],
    );
    const pending = await authPool.query<{ n: string }>(
      `select count(*) as n from auth.invitation where organization_id = $1 and status = 'pending'`,
      [tenant.tenantId],
    );
    expect(Number(pending.rows[0]?.n)).toBe(PLATFORM_LIMIT);
    const email = `over-${randomUUID()}@example.test`;

    // WHEN an admin invites a 101st address.
    const thrown = await rejection(
      client.identity.users.invite({ email, role: 'member' }, { context: sessionContext(tenant) }),
    );

    // THEN the generic code answers, with no provider text...
    expectGenericRejection(thrown);
    // ...and nothing is created or sent.
    expect(await invitationsOf(tenant.tenantId, email), 'no invitation').toEqual([]);
    expect(emailsTo(email), 'no email').toEqual([]);
    expect(await userSync.getUser({ tenantId: tenant.tenantId, email }), 'no _user').toBeNull();
  }, 60_000);

  it('identity.users.create in an organization with 100 members is rejected generically: CATALOG_VALIDATION_FAILED, no provider text, no membership', async () => {
    const tenant = await freshTenant();
    // GIVEN an organization with 100 members (the admin plus 99).
    const ids = await seedUsers(PLATFORM_LIMIT - 1, tenant.tenantId.slice(0, 8));
    await authPool.query(
      `insert into auth.member (id, organization_id, user_id, role, created_at)
       select 'seed-mem-' || id, $1, id, 'member', now() from unnest($2::text[]) as id`,
      [tenant.tenantId, ids],
    );
    expect(await memberCount(tenant.tenantId)).toBe(PLATFORM_LIMIT);
    const email = `full-${randomUUID()}@example.test`;

    // WHEN an admin creates a 101st user.
    const thrown = await rejection(
      client.identity.users.create(
        { email, name: 'Over Limit', role: 'member' },
        { context: sessionContext(tenant) },
      ),
    );

    // THEN the generic code answers, with no provider text...
    expectGenericRejection(thrown);
    // ...and no membership and no `_user` entity exist for the address.
    expect(await memberCount(tenant.tenantId), 'still 100 members').toBe(PLATFORM_LIMIT);
    expect(await userSync.getUser({ tenantId: tenant.tenantId, email }), 'no _user').toBeNull();
  }, 60_000);
});
