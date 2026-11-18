/**
 * Task 5.5 of openspec/changes/archive/2026-11-18-045-org-deletion-and-data-retention (design D5 "The deletion
 * notice is the eighth fixed template and goes through `043`'s notice controls", Resolved
 * decisions Q27 and Q53).
 *
 * Scenario "Every admin is notified of a pending deletion" (spec, quoted):
 * - **GIVEN** an organization with an owner, two admins and a member
 * - **WHEN** an admin requests deletion
 * - **THEN** each of the three administrators receives exactly one fixed-template email and the
 *   member receives none, and a repeated request sends nothing
 *
 * Task 5.5 adds: the notice goes through the notice dispatcher of `043` (the kill switch, the
 * disabled tenants, the `notice_tenant` cap and the `notice_recipient` bucket), to at most 20
 * administrators resolved on the server from the tenant's memberships; a send failure never
 * blocks the request and logs `catalog.security.org_deletion_notice_failed` (WARN,
 * `tayzu.tenant.id`, no address); a suppression logs `catalog.security.notice_suppressed` with
 * the template `org_deletion`.
 *
 * ## Harness
 *
 * The router of `org-deletion.int.test.ts`: `createIdentityRouter` over a real Better Auth
 * instance, the real auth repository, the `tayzu_app` pool and a real Cerbos, called in
 * process through `createRouterClient` with a host-supplied context. The email gate has its
 * own recording sender, which must stay empty (the notice does not go through the invitation
 * gate). The notice dispatcher is the real `createNoticeDispatcher` over an in-memory cap store
 * with roomy notice caps and a recording (or failing) sender. Every seeded value is random.
 *
 * ## Production symbols expected
 *
 * - `createIdentityRouter` (`../identity-router.js`) gains the option
 *   `notices?: NoticeDispatcher` (the type of `./notices.js`), the dispatcher
 *   `identity.organization.delete` sends the deletion notice through.
 * - `NoticeDispatcher.send` accepts `template: { kind: 'OrgDeletionNotice', purgeDate }`, the
 *   `purgeDate` being the marker's `purge_after` as the ISO 8601 string the route answers
 *   (`purgeAfter`), and derives the template name `org_deletion` from the kind.
 * - `requestOrgDeletion` (`./org-deletion.js`) sends one notice per first request (none on a
 *   repeat while pending) to every `owner` and `admin` member of the tenant, the requester
 *   included, and logs `catalog.security.org_deletion_notice_failed` (WARN, `tayzu.tenant.id`)
 *   when the sender fails, without failing the request.
 *
 * ## Why this fails right now
 *
 * `createIdentityRouter` takes no notice dispatcher and `requestOrgDeletion` sends no notice, so
 * no `OrgDeletionNotice` reaches the sender and no notice event is logged.
 */
// Load-bearing import order (design D1 of `043`): the telemetry harness registers before
// anything that loads `@tayzu/auth` creates its logger.
import { registration, type TelemetryTestHarness } from '../__fixtures__/link-telemetry.js';
import { randomUUID } from 'node:crypto';

import { createRouterClient } from '@orpc/server';
import {
  AuthRateLimitedError,
  authSchema,
  createAuth,
  createRecordingEmailSender,
  type AuthInstance,
  type EmailSender,
} from '@tayzu/auth';
import { createCerbosClient, type CerbosClient } from '@tayzu/authz';
import { createUserSync } from '@tayzu/catalog';
import { runMigrations, withTenantTransaction } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { createAdminUser } from '../../../../packages/auth/src/__fixtures__/admin-user.js';
import {
  TEST_PASSWORD,
  TEST_SECRET,
} from '../../../../packages/auth/src/__fixtures__/test-secret.js';
import { harnessPools } from '../__fixtures__/pools.js';
import { createIdentityRouter } from '../identity-router.js';
import { createAuthRepository, type AuthRepository } from './auth-repository.js';
import type { EmailCapStore } from './email-tenant-gate.js';
import { createEmailTenantGate } from './email-tenant-gate.js';
import { createInMemoryEmailCapStore } from './invitation-caps.js';
import { createNoticeDispatcher } from './notices.js';
import { recipientKey } from './recipient-key.js';
import { createWithUserLock } from './user-lock.js';
import { createUserSyncAdapter } from './user-sync-adapter.js';

const NOTICE_FAILED = 'catalog.security.org_deletion_notice_failed';
const SUPPRESSED = 'catalog.security.notice_suppressed';
const BLOCKED = 'catalog.security.email_tenant_blocked';

interface OrganizationSurface {
  createOrganization(args: {
    body: { name: string; slug: string; userId: string };
  }): Promise<{ id: string }>;
  addMember(args: {
    body: { userId: string; organizationId: string; role: string };
  }): Promise<unknown>;
}

interface OrgDeleteClient {
  identity: {
    organization: {
      delete(
        input: { readonly query: Record<string, unknown> },
        options: { context: Record<string, unknown> },
      ): Promise<{ purgeAfter: string }>;
    };
  };
}

interface Person {
  readonly userId: string;
  readonly email: string;
}

interface Organization {
  readonly tenantId: string;
  readonly owner: Person;
  /** The administrators in membership order (the requester is the first one). */
  readonly admins: readonly Person[];
  readonly member: Person;
  /** Every seeded free-text value: the organization's name and slug and every address. */
  readonly freeText: readonly string[];
}

interface FakeStore extends EmailCapStore {
  readonly consumed: { readonly scope: string; readonly key: string }[];
}

/** Roomy notice caps unless a test lowers one; fixed windows are irrelevant here. */
function noticeStore(limits: Record<string, number> = {}): FakeStore {
  const max: Record<string, number> = {
    notice_tenant: 10_000,
    notice_recipient: 10_000,
    ...limits,
  };
  const counts = new Map<string, number>();
  const consumed: FakeStore['consumed'] = [];
  return {
    consumed,
    consume(scope, key) {
      consumed.push({ scope, key });
      const limit = max[scope];
      if (limit === undefined) {
        return Promise.reject(new Error(`unexpected scope ${scope}`));
      }
      const id = `${scope}:${key}`;
      const count = counts.get(id) ?? 0;
      if (count >= limit) {
        return Promise.reject(new AuthRateLimitedError(3600));
      }
      counts.set(id, count + 1);
      return Promise.resolve();
    },
  };
}

describe('the org-deletion notice (task 5.5, design D5, Resolved decisions Q27, Q53)', () => {
  let harness: TelemetryTestHarness;
  let appPool: Pool;
  let authPool: Pool;
  let auth: AuthInstance;
  let cerbos: CerbosClient;
  let authRepository: AuthRepository;

  beforeAll(async () => {
    if ('error' in registration) {
      throw new Error(`createTelemetryTestHarness() failed: ${String(registration.error)}`, {
        cause: registration.error,
      });
    }
    harness = registration.harness;
    const pools = await harnessPools();
    appPool = pools.appPool;
    authPool = pools.authPool;
    await runMigrations(authPool);
    cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    auth = createAuth({
      db: drizzle(authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync: createUserSyncAdapter({
        userSync: createUserSync({ pool: appPool, authz: cerbos }),
      }),
    });
    authRepository = createAuthRepository(authPool);
  }, 60_000);

  beforeEach(async () => {
    await harness.reset();
  });

  interface ClientOptions {
    readonly sender?: EmailSender;
    readonly store?: FakeStore;
    readonly killSwitch?: boolean;
    readonly disabledTenantIds?: readonly string[];
    readonly secret?: string;
  }

  function freshClient(options: ClientOptions = {}) {
    const sender = createRecordingEmailSender();
    const gateSender = createRecordingEmailSender();
    const store = options.store ?? noticeStore();
    const secret = options.secret ?? `org-deletion-notice-test-only-secret-${randomUUID()}`;
    const notices = createNoticeDispatcher({
      disabledTenantIds: options.disabledTenantIds ?? [],
      capStore: store,
      sender: options.sender ?? sender,
      recipientKeySecret: secret,
      ...(options.killSwitch === undefined ? {} : { killSwitch: options.killSwitch }),
    });
    const router = createIdentityRouter({
      auth,
      authz: cerbos,
      authRepository,
      withUserLock: createWithUserLock(authPool),
      emailGate: createEmailTenantGate({
        disabledTenantIds: [],
        recipientKeySecret: secret,
        capStore: createInMemoryEmailCapStore({
          tenant: { max: 10_000, windowSeconds: 3600 },
          recipient: { max: 10_000, windowSeconds: 86_400 },
        }),
        sender: gateSender,
      }),
      invitationLinkBaseUrl: 'https://app.tayzu.test',
      appPool,
      notices,
    });
    const client = createRouterClient(router, {
      context: (raw: Record<string, unknown>) => raw,
    }) as unknown as OrgDeleteClient;
    return { client, sender, gateSender, store };
  }

  async function person(label: string, suffix: string): Promise<Person> {
    const email = `org-del-notice-${label}-${suffix}-${randomUUID()}@example.test`;
    const created = await createAdminUser(auth, {
      name: `Org Deletion Notice ${label} ${suffix}`,
      email,
      password: TEST_PASSWORD,
    });
    return { userId: created.userId, email };
  }

  /** An organization with an owner, `adminCount` admins and one plain member. */
  async function freshOrganization(adminCount = 2): Promise<Organization> {
    const suffix = randomUUID();
    const api = auth.api as OrganizationSurface;
    const owner = await person('owner', suffix);
    const name = `Org Deletion Notice ${suffix}`;
    const slug = `org-del-notice-${suffix}`;
    const org = await api.createOrganization({ body: { name, slug, userId: owner.userId } });
    const admins: Person[] = [];
    for (let index = 0; index < adminCount; index += 1) {
      const admin = await person(`admin${String(index)}`, suffix);
      await api.addMember({
        body: { userId: admin.userId, organizationId: org.id, role: 'admin' },
      });
      admins.push(admin);
    }
    const member = await person('member', suffix);
    await api.addMember({
      body: { userId: member.userId, organizationId: org.id, role: 'member' },
    });
    return {
      tenantId: org.id,
      owner,
      admins,
      member,
      freeText: [name, slug, owner.email, member.email, ...admins.map((admin) => admin.email)],
    };
  }

  function requesterContext(org: Organization): Record<string, unknown> {
    const requester = org.admins[0];
    if (requester === undefined) throw new Error('no requesting admin');
    return {
      tenantId: org.tenantId,
      actor: { type: 'user', id: requester.userId },
      principal: { roles: ['admin'] },
    };
  }

  async function requestDeletion(client: OrgDeleteClient, org: Organization) {
    return await client.identity.organization.delete(
      { query: { confirmation: org.tenantId } },
      { context: requesterContext(org) },
    );
  }

  async function pendingMarkers(tenantId: string): Promise<readonly { purge_after: Date }[]> {
    return await withTenantTransaction(appPool, { tenantId }, async (db) => {
      const result = await db.query<{ purge_after: Date }>(
        `select purge_after from tenant_deletion_marker where tenant_id = $1 and state = 'pending'`,
        [tenantId],
      );
      return result.rows;
    });
  }

  async function eventsFor(name: string, tenantId: string) {
    await harness.forceFlush();
    return harness.logExporter
      .getFinishedLogRecords()
      .filter(
        (record) => record.eventName === name && record.attributes['tayzu.tenant.id'] === tenantId,
      );
  }

  function countPerRecipient(sent: readonly { readonly to: string }[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const message of sent) counts.set(message.to, (counts.get(message.to) ?? 0) + 1);
    return counts;
  }

  function expectNoFreeText(
    records: readonly { readonly attributes: unknown; readonly body?: unknown }[],
    org: Organization,
  ) {
    for (const record of records) {
      const serialized = JSON.stringify([record.attributes, record.body]);
      for (const text of org.freeText) {
        expect(serialized).not.toContain(text);
      }
      expect(serialized).not.toContain('example.test');
    }
  }

  /** The request answered its purge date and the pending marker carries the same date. */
  async function expectMarkerFor(org: Organization, purgeAfter: string) {
    const markers = await pendingMarkers(org.tenantId);
    expect(markers, 'one pending marker exists').toHaveLength(1);
    expect(new Date(markers[0]?.purge_after ?? 0).toISOString()).toBe(purgeAfter);
  }

  it('Every admin is notified of a pending deletion: the owner and two admins each receive exactly one OrgDeletionNotice with the purge date, the member none, and a repeated request sends nothing', async () => {
    // GIVEN an organization with an owner, two admins and a member
    const org = await freshOrganization(2);
    const { client, sender, gateSender } = freshClient();

    // WHEN an admin requests deletion
    const answer = await requestDeletion(client, org);

    // THEN each of the three administrators receives exactly one fixed-template email
    expect(typeof answer.purgeAfter).toBe('string');
    await expectMarkerFor(org, answer.purgeAfter);
    const administrators = [org.owner, ...org.admins].map((p) => p.email);
    const counts = countPerRecipient(sender.sent);
    for (const address of administrators) {
      expect(counts.get(address), 'one notice per administrator').toBe(1);
    }
    // AND the member receives none
    expect(counts.has(org.member.email), 'the member is not notified').toBe(false);
    expect(sender.sent).toHaveLength(3);
    for (const message of sender.sent) {
      expect(message.template).toEqual({ kind: 'OrgDeletionNotice', purgeDate: answer.purgeAfter });
    }
    // AND the notice does not go through the invitation gate
    expect(gateSender.sent).toEqual([]);

    // AND a repeated request sends nothing
    const repeated = await requestDeletion(client, org);
    expect(repeated.purgeAfter).toBe(answer.purgeAfter);
    expect(sender.sent, 'the repeat sent no second notice').toHaveLength(3);
    expect(gateSender.sent).toEqual([]);
  }, 60_000);

  it('the recipients are resolved on the server from the memberships, at most 20, the longest-standing administrators', async () => {
    // GIVEN an owner and 21 admins: 22 administrators
    const org = await freshOrganization(21);
    const { client, sender } = freshClient();

    const answer = await requestDeletion(client, org);

    await expectMarkerFor(org, answer.purgeAfter);
    expect(sender.sent, 'exactly 20 notices').toHaveLength(20);
    const expected = [org.owner, ...org.admins].slice(0, 20).map((p) => p.email);
    expect(sender.sent.map((message) => message.to).sort()).toEqual([...expected].sort());
    expect(sender.sent.map((message) => message.to)).not.toContain(org.member.email);
    const truncated = (await eventsFor(SUPPRESSED, org.tenantId)).filter(
      (record) => record.attributes['tayzu.identity.notice.suppression'] === 'truncated',
    );
    expect(truncated).toHaveLength(1);
    expect(truncated[0]?.attributes['tayzu.identity.notice.template']).toBe('org_deletion');
    expect(truncated[0]?.attributes['tayzu.identity.notice.dropped']).toBe(2);
  }, 120_000);

  it('a failing sender does not stop the request: it answers its purge date, the marker exists and org_deletion_notice_failed is logged with no address', async () => {
    const org = await freshOrganization(2);
    const failing: EmailSender = { send: () => Promise.reject(new Error('provider down')) };
    const { client } = freshClient({ sender: failing });

    const answer = await requestDeletion(client, org);

    expect(typeof answer.purgeAfter).toBe('string');
    await expectMarkerFor(org, answer.purgeAfter);
    const records = await eventsFor(NOTICE_FAILED, org.tenantId);
    expect(records.length, 'the failure is logged').toBeGreaterThanOrEqual(1);
    for (const record of records) {
      expect(record.severityText).toBe('WARN');
      expect(record.attributes['tayzu.tenant.id']).toBe(org.tenantId);
    }
    expectNoFreeText(records, org);
  }, 60_000);

  it('the kill switch on: the request succeeds, nothing is sent and notice_suppressed is logged with the template org_deletion and the reason global', async () => {
    const org = await freshOrganization(2);
    const { client, sender, store } = freshClient({ killSwitch: true });

    const answer = await requestDeletion(client, org);

    await expectMarkerFor(org, answer.purgeAfter);
    expect(sender.sent).toEqual([]);
    expect(store.consumed, 'no bucket consumed').toEqual([]);
    const records = await eventsFor(SUPPRESSED, org.tenantId);
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record?.severityText).toBe('WARN');
    expect(record?.attributes['tayzu.identity.notice.template']).toBe('org_deletion');
    expect(record?.attributes['tayzu.identity.notice.suppression']).toBe('global');
    expect(record?.attributes['tayzu.identity.notice.dropped']).toBe(3);
    expectNoFreeText(records, org);
  }, 60_000);

  it('a full notice_recipient bucket: the request succeeds, that administrator receives nothing, the others one each, and notice_suppressed is logged with the template org_deletion and the reason recipient', async () => {
    const org = await freshOrganization(2);
    const secret = `org-deletion-notice-test-only-secret-${randomUUID()}`;
    const store = noticeStore({ notice_recipient: 3 });
    const full = org.admins[1];
    if (full === undefined) throw new Error('no second admin');
    // GIVEN the second admin's notice bucket is already full (three notices)
    for (let i = 0; i < 3; i += 1) {
      await store.consume('notice_recipient', recipientKey(full.email, secret));
    }
    store.consumed.length = 0;
    const { client, sender } = freshClient({ store, secret });

    const answer = await requestDeletion(client, org);

    await expectMarkerFor(org, answer.purgeAfter);
    const others = [org.owner, org.admins[0]].map((p) => p?.email);
    expect(sender.sent.map((message) => message.to).sort()).toEqual([...others].sort());
    for (const message of sender.sent) {
      expect(message.template).toEqual({ kind: 'OrgDeletionNotice', purgeDate: answer.purgeAfter });
    }
    const records = await eventsFor(SUPPRESSED, org.tenantId);
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record?.attributes['tayzu.identity.notice.template']).toBe('org_deletion');
    expect(record?.attributes['tayzu.identity.notice.suppression']).toBe('recipient');
    expect(record?.attributes['tayzu.identity.notice.dropped']).toBe(1);
    expectNoFreeText(records, org);
  }, 60_000);

  it('a tenant on the disabled list: the request succeeds, nothing is sent, no bucket is consumed and email_tenant_blocked is logged with the template org_deletion', async () => {
    const org = await freshOrganization(2);
    const { client, sender, store } = freshClient({
      disabledTenantIds: [`tenant-${randomUUID()}`, org.tenantId],
    });

    const answer = await requestDeletion(client, org);

    await expectMarkerFor(org, answer.purgeAfter);
    expect(sender.sent).toEqual([]);
    expect(store.consumed).toEqual([]);
    const records = await eventsFor(BLOCKED, org.tenantId);
    expect(records.length).toBeGreaterThanOrEqual(1);
    for (const record of records) {
      expect(record.severityText).toBe('WARN');
      expect(record.attributes['tayzu.identity.email.template']).toBe('org_deletion');
    }
    expectNoFreeText(records, org);
  }, 60_000);
});
