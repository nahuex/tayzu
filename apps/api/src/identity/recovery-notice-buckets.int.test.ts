/**
 * Task 7.4 of openspec/changes/044-password-reset-and-account-recovery.
 *
 * Scenarios (verbatim from the specs):
 * - `identity-lifecycle-and-org-admin` delta, "Creating a user sends the account-created notice
 *   outside these buckets": GIVEN an address whose invitation bucket and admin-notice bucket are
 *   both full, WHEN an admin creates a user for that address through `identity.users.create`,
 *   THEN the operation succeeds and the fixed account-created notice is sent, because it is
 *   counted in the recovery-notice buckets.
 * - `password-reset-and-account-recovery`, "Notices and reset emails count apart": GIVEN a
 *   recipient who received 10 notices in a day, WHEN they request a reset, THEN the reset email
 *   is sent.
 *
 * Everything runs over the real DB-backed cap store (`createDbEmailCapStore` over
 * `createRateLimitBucketStore`), so the buckets are the real rows of `auth.rate_limit`. Every
 * address and tenant is fresh and random, so tests run in parallel with no truncation.
 *
 * ## Production symbols expected
 *
 * All of them exist after tasks 4.3, 5.x and 7.3: `createDbEmailCapStore`
 * (`./email-cap-store.js`), `createRecoveryMailer` (`./recovery-mailer.js`), `recipientKey`
 * (`./recipient-key.js`), `createIdentityRouter` with `recoveryMailer` (`../identity-router.js`).
 * The test is expected to pass on arrival.
 */
import { createHash, randomUUID } from 'node:crypto';

import { createRouterClient } from '@orpc/server';
import {
  AuthRateLimitedError,
  authSchema,
  createAuth,
  createRateLimitBucketStore,
  createRecordingEmailSender,
  type AuthInstance,
  type RateLimitBucketStoreOptions,
} from '@tayzu/auth';
import { createCerbosClient } from '@tayzu/authz';
import { runMigrations } from '@tayzu/db';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import { createAdminUser } from '../../../../packages/auth/src/__fixtures__/admin-user.js';
import {
  TEST_PASSWORD,
  TEST_SECRET,
} from '../../../../packages/auth/src/__fixtures__/test-secret.js';
import { harnessPools } from '../__fixtures__/pools.js';
import { createIdentityRouter } from '../identity-router.js';
import { createAuthRepository } from './auth-repository.js';
import { createDbEmailCapStore } from './email-cap-store.js';
import type { EmailCapStore } from './email-tenant-gate.js';
import { createRecoveryMailer } from './recovery-mailer.js';
import { recipientKey } from './recipient-key.js';
import { createWithUserLock } from './user-lock.js';

const HMAC_SECRET = 'recovery-notice-buckets-test-only-secret-0123456789';
const DAY = 86_400;
const HOUR = 3600;
const INVITATION_RECIPIENT_MAX = 3;
const ADMIN_NOTICE_RECIPIENT_MAX = 3;
const RECOVERY_NOTICE_RECIPIENT_MAX = 10;
const RESET_RECIPIENT_MAX = 3;

const RULES = {
  invitation_recipient: { max: INVITATION_RECIPIENT_MAX, window: DAY },
  notice_recipient: { max: ADMIN_NOTICE_RECIPIENT_MAX, window: DAY },
  reset_email_recipient: { max: RESET_RECIPIENT_MAX, window: HOUR },
  reset_email_ip: { max: 1000, window: HOUR },
  reset_email_global: { max: 100_000, window: HOUR },
  recovery_notice_recipient: { max: RECOVERY_NOTICE_RECIPIENT_MAX, window: DAY },
  account_created_notice_tenant: { max: 1000, window: DAY },
  account_created_notice_global: { max: 100_000, window: DAY },
} as const;

interface CreateOrganizationSurface {
  createOrganization(args: {
    body: { name: string; slug: string; userId: string };
  }): Promise<{ id: string }>;
}

function hashed(scope: string, kind: string, value: string): string {
  return createHash('sha256').update(`${scope}:${kind}:${value}`).digest('hex');
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('the recovery-notice buckets are apart from 043 and the reset buckets (044 task 7.4)', () => {
  let authPool: Pool;
  let auth: AuthInstance;
  let capStore: EmailCapStore;
  let db: ReturnType<typeof drizzle<typeof authSchema>>;

  beforeAll(async () => {
    const pools = await harnessPools();
    authPool = pools.authPool;
    await runMigrations(authPool);
    db = drizzle(authPool, { schema: authSchema });
    auth = createAuth({ db, secret: TEST_SECRET });
    const adapter = (
      await (auth.$context as Promise<{ adapter: RateLimitBucketStoreOptions['adapter'] }>)
    ).adapter;
    capStore = createDbEmailCapStore({
      store: createRateLimitBucketStore({ adapter, rules: RULES }),
    });
  }, 60_000);

  async function freshTenantId(): Promise<string> {
    const id = randomUUID();
    const owner = await createAdminUser(auth, {
      name: 'Tenant Owner',
      email: `owner-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    const org = await (auth.api as CreateOrganizationSurface).createOrganization({
      body: { name: 'Notice Buckets Org', slug: `notice-buckets-${id}`, userId: owner.userId },
    });
    return org.id;
  }

  function mailerWith(sender: ReturnType<typeof createRecordingEmailSender>) {
    return createRecoveryMailer({
      disabledTenantIds: [],
      capStore,
      sender,
      recipientKeySecret: HMAC_SECRET,
    });
  }

  async function countOf(bucket: string, kind: string, value: string): Promise<number> {
    const rows = await db
      .select({ count: authSchema.rateLimit.count })
      .from(authSchema.rateLimit)
      .where(eq(authSchema.rateLimit.key, hashed(bucket, kind, value)));
    return rows[0]?.count ?? 0;
  }

  it('Creating a user sends the account-created notice outside these buckets', async () => {
    const tenantId = await freshTenantId();
    const email = `squatted-${randomUUID()}@example.test`;
    const key = recipientKey(email, HMAC_SECRET);

    // GIVEN an address whose invitation bucket and admin-notice bucket are both full
    for (let hit = 0; hit < INVITATION_RECIPIENT_MAX; hit += 1) {
      await capStore.consume('recipient', key);
    }
    for (let hit = 0; hit < ADMIN_NOTICE_RECIPIENT_MAX; hit += 1) {
      await capStore.consume('notice_recipient', key);
    }
    expect(await rejection(capStore.consume('recipient', key))).toBeInstanceOf(
      AuthRateLimitedError,
    );
    expect(await rejection(capStore.consume('notice_recipient', key))).toBeInstanceOf(
      AuthRateLimitedError,
    );

    // WHEN an admin creates a user for that address through `identity.users.create`
    const sender = createRecordingEmailSender();
    const client = createRouterClient(
      createIdentityRouter({
        auth,
        authz: createCerbosClient({ address: 'localhost:3593', tls: false }),
        authRepository: createAuthRepository(authPool),
        withUserLock: createWithUserLock(authPool),
        recoveryMailer: mailerWith(sender),
      }),
      { context: (raw: Record<string, unknown>) => raw },
    );
    const result = await client.identity.users.create(
      { body: { email, name: 'Squatted', role: 'member' } },
      {
        context: {
          tenantId,
          actor: { type: 'user', id: `caller-${randomUUID()}` },
          principal: { roles: ['admin'] },
        },
      },
    );

    // THEN the operation succeeds and the fixed account-created notice is sent...
    expect(result.email).toBe(email);
    await vi.waitFor(() => {
      expect(sender.sent).toHaveLength(1);
    });
    expect(sender.sent[0]?.to).toBe(email);
    expect(sender.sent[0]?.template).toEqual({ kind: 'AccountCreatedNotice' });

    // ...because it is counted in the recovery-notice bucket, not in the 043 buckets.
    expect(await countOf('recovery_notice_recipient', 'email', key)).toBe(1);
    expect(await countOf('invitation_recipient', 'email', key)).toBe(INVITATION_RECIPIENT_MAX);
    expect(await countOf('notice_recipient', 'email', key)).toBe(ADMIN_NOTICE_RECIPIENT_MAX);
  }, 60_000);

  it('Notices and reset emails count apart', async () => {
    const address = `recipient-${randomUUID()}@example.test`;
    const key = recipientKey(address, HMAC_SECRET);
    const userId = randomUUID();
    const tenantIds = [randomUUID()];
    const sender = createRecordingEmailSender();
    const mailer = mailerWith(sender);

    // GIVEN a recipient who received 10 notices in a day
    for (let notice = 0; notice < RECOVERY_NOTICE_RECIPIENT_MAX; notice += 1) {
      await mailer.sendNotice({ kind: 'PasswordChangedNotice', address, userId, tenantIds });
    }
    expect(sender.sent).toHaveLength(RECOVERY_NOTICE_RECIPIENT_MAX);
    // the notice bucket is full: an eleventh notice is not sent
    await mailer.sendNotice({ kind: 'PasswordChangedNotice', address, userId, tenantIds });
    expect(sender.sent).toHaveLength(RECOVERY_NOTICE_RECIPIENT_MAX);

    // WHEN they request a reset
    const admission = await mailer.admitResetEmail({
      address,
      userId,
      tenantIds,
      ipKey: `ip-${randomUUID()}`,
    });

    // THEN the reset email is sent
    expect(admission.admitted).toBe(true);
    if (admission.admitted) {
      admission.send('https://app.example.test/reset-password#reset=id&token=marker');
    }
    await mailer.drain();
    expect(sender.sent).toHaveLength(RECOVERY_NOTICE_RECIPIENT_MAX + 1);
    expect(sender.sent.at(-1)?.template.kind).toBe('PasswordResetEmail');
    expect(await countOf('reset_email_recipient', 'email', key)).toBe(1);
  }, 60_000);

  it('the reverse holds: a full reset bucket does not suppress a notice', async () => {
    const address = `reverse-${randomUUID()}@example.test`;
    const userId = randomUUID();
    const tenantIds = [randomUUID()];
    const sender = createRecordingEmailSender();
    const mailer = mailerWith(sender);

    for (let request = 0; request < RESET_RECIPIENT_MAX; request += 1) {
      const admission = await mailer.admitResetEmail({
        address,
        userId,
        tenantIds,
        ipKey: `ip-${randomUUID()}`,
      });
      expect(admission.admitted).toBe(true);
    }
    const refused = await mailer.admitResetEmail({
      address,
      userId,
      tenantIds,
      ipKey: `ip-${randomUUID()}`,
    });
    expect(refused.admitted).toBe(false);

    await mailer.sendNotice({ kind: 'MfaChangedNotice', address, userId, tenantIds });

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.template).toEqual({ kind: 'MfaChangedNotice' });
  }, 60_000);
});
