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
});
