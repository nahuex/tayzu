/**
 * Task 14.12 of openspec/changes/043-identity-lifecycle-and-org-admin (design D4
 * "Invitation email caps", Resolved decisions Q15, Q101 and Q138; tasks 6.6, 6.7, 6.10
 * and 6.12b).
 *
 * Verify: "`email-cap-store.int.test.ts` covers two stores over one database sharing one
 * count per scope, the send past the per-recipient cap being refused with
 * `AUTH_RATE_LIMITED` and `Retry-After`, and every key stored only as a hash."
 *
 * ## Production symbols expected (none exists yet)
 *
 * - `./email-cap-store.js` exports `createDbEmailCapStore(options)`, with
 *   `options = { store: RateLimitBucketStore }` (`createRateLimitBucketStore` of
 *   `@tayzu/auth`, built by `createApp` with the rules of the configuration), returning
 *   an `EmailCapStore` (`./email-tenant-gate.js`): `consume(scope, key): Promise<void>`.
 * - It maps the scopes the gate and the dispatcher use onto the buckets of 6.10:
 *   `tenant` -> `invitation_tenant` (kind `tenant`), `recipient` -> `invitation_recipient`
 *   (kind `email`, the value is the HMAC key already), `notice_tenant` -> `notice_tenant`
 *   (kind `tenant`) and `notice_recipient` -> `notice_recipient` (kind `email`).
 * - A full bucket rejects with `AuthRateLimitedError` carrying the bucket's
 *   `retryAfterSeconds`. A scope it does not know rejects with an error and creates no row.
 *
 * Two stores are built from two Better Auth instances (two pools) over the same
 * database, which is what two replicas look like. Every test uses fresh random values.
 */
import { createHash, randomUUID } from 'node:crypto';

import {
  authSchema,
  AuthRateLimitedError,
  createAuth,
  createRateLimitBucketStore,
  createRecordingEmailSender,
  type EmailTemplate,
  type RateLimitBucketStoreOptions,
} from '@tayzu/auth';
import { runMigrations } from '@tayzu/db';
import { eq, like } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TEST_SECRET } from '../../../../packages/auth/src/__fixtures__/test-secret.js';
import { createDbEmailCapStore } from './email-cap-store.js';
import { createEmailTenantGate, type EmailCapStore } from './email-tenant-gate.js';
import { createNoticeDispatcher } from './notices.js';
import { recipientKey } from './recipient-key.js';

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim() === '') {
    throw new Error(
      'DATABASE_URL is not set: the int project global setup should have stopped this run.',
    );
  }
  return url;
}

function connect(url: string): ReturnType<typeof drizzle<typeof authSchema>> {
  return drizzle(url, { schema: authSchema });
}

type TestDb = ReturnType<typeof connect>;

const HMAC_SECRET = 'email-cap-store-test-only-secret-0123456789-abcdef';
const TENANT_MAX = 4;
const RECIPIENT_MAX = 3;
const NOTICE_TENANT_MAX = 5;
const NOTICE_RECIPIENT_MAX = 3;
const HOUR = 3600;
const DAY = 86_400;

const RULES = {
  invitation_tenant: { max: TENANT_MAX, window: HOUR },
  invitation_recipient: { max: RECIPIENT_MAX, window: DAY },
  notice_tenant: { max: NOTICE_TENANT_MAX, window: HOUR },
  notice_recipient: { max: NOTICE_RECIPIENT_MAX, window: DAY },
} as const;

const INVITATION: EmailTemplate = {
  kind: 'InvitationEmail',
  link: 'https://app.example.test/accept-invitation#invitation=id-1&token=marker-token-1',
  expiryText: '48 hours',
};

const NOTICE: Extract<EmailTemplate, { kind: 'AdminAcceptedNotice' }> = {
  kind: 'AdminAcceptedNotice',
};

function hashed(scope: string, kind: string, value: string): string {
  return createHash('sha256').update(`${scope}:${kind}:${value}`).digest('hex');
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('the email caps on the shared DB-backed store (task 14.12, Q138)', () => {
  let dbA: TestDb;
  let dbB: TestDb;
  let storeA: EmailCapStore;
  let storeB: EmailCapStore;

  async function adapterOf(db: TestDb): Promise<RateLimitBucketStoreOptions['adapter']> {
    const auth = createAuth({ db, secret: TEST_SECRET });
    return (await (auth.$context as Promise<{ adapter: RateLimitBucketStoreOptions['adapter'] }>))
      .adapter;
  }

  async function rowsWithKey(key: string): Promise<{ key: string; count: number }[]> {
    return dbA
      .select({ key: authSchema.rateLimit.key, count: authSchema.rateLimit.count })
      .from(authSchema.rateLimit)
      .where(eq(authSchema.rateLimit.key, key));
  }

  async function rowsLike(fragment: string): Promise<{ key: string }[]> {
    return dbA
      .select({ key: authSchema.rateLimit.key })
      .from(authSchema.rateLimit)
      .where(like(authSchema.rateLimit.key, `%${fragment}%`));
  }

  beforeAll(async () => {
    dbA = connect(databaseUrl());
    dbB = connect(databaseUrl());
    await runMigrations(dbA.$client);
    storeA = createDbEmailCapStore({
      store: createRateLimitBucketStore({ adapter: await adapterOf(dbA), rules: RULES }),
    });
    storeB = createDbEmailCapStore({
      store: createRateLimitBucketStore({ adapter: await adapterOf(dbB), rules: RULES }),
    });
  }, 60_000);

  afterAll(async () => {
    for (const db of [dbA, dbB]) {
      db.$client.on('error', () => {
        // Expected only during teardown.
      });
      await db.$client.end();
    }
  });

  it('Two stores over one database share one count per scope', async () => {
    const cases = [
      { scope: 'tenant', bucket: 'invitation_tenant', kind: 'tenant', max: TENANT_MAX },
      { scope: 'recipient', bucket: 'invitation_recipient', kind: 'email', max: RECIPIENT_MAX },
      { scope: 'notice_tenant', bucket: 'notice_tenant', kind: 'tenant', max: NOTICE_TENANT_MAX },
      {
        scope: 'notice_recipient',
        bucket: 'notice_recipient',
        kind: 'email',
        max: NOTICE_RECIPIENT_MAX,
      },
    ] as const;
    for (const { scope, bucket, kind, max } of cases) {
      const value = `value-${randomUUID()}`;
      for (let hit = 0; hit < max; hit += 1) {
        await (hit % 2 === 0 ? storeA : storeB).consume(scope, value);
      }

      // The cap is shared: the next hit is refused whichever store serves it.
      const byA = await rejection(storeA.consume(scope, value));
      const byB = await rejection(storeB.consume(scope, value));
      expect(byA, `${scope} refused by A`).toBeInstanceOf(AuthRateLimitedError);
      expect(byB, `${scope} refused by B`).toBeInstanceOf(AuthRateLimitedError);

      const rows = await rowsWithKey(hashed(bucket, kind, value));
      expect(rows, `${scope}: one row, one shared count`).toHaveLength(1);
      expect(rows[0]?.count).toBe(max);
    }
  });

  it('The scopes never share a count', async () => {
    const value = `value-${randomUUID()}`;
    for (let hit = 0; hit < RECIPIENT_MAX; hit += 1) {
      await storeA.consume('recipient', value);
    }
    await expect(storeB.consume('recipient', value)).rejects.toBeInstanceOf(AuthRateLimitedError);

    // The notices' own recipient bucket (Q101) is untouched by the invitations.
    await expect(storeB.consume('notice_recipient', value)).resolves.toBeUndefined();
  });

  it('A full bucket refuses with AUTH_RATE_LIMITED and the bucket Retry-After', async () => {
    const value = `value-${randomUUID()}`;
    for (let hit = 0; hit < RECIPIENT_MAX; hit += 1) {
      await storeA.consume('recipient', value);
    }

    const error = await rejection(storeB.consume('recipient', value));

    expect(error).toBeInstanceOf(AuthRateLimitedError);
    const limited = error as AuthRateLimitedError;
    expect(limited.code).toBe('AUTH_RATE_LIMITED');
    expect(limited.retryAfterSeconds).toBeGreaterThan(0);
    expect(limited.retryAfterSeconds).toBeLessThanOrEqual(DAY);
  });

  it('An unknown scope is refused and creates no row', async () => {
    const value = `value-${randomUUID()}`;

    await expect(storeA.consume('not_a_scope', value)).rejects.toThrow();

    expect(await rowsLike(value)).toHaveLength(0);
    for (const kind of ['tenant', 'email', 'ip', 'user']) {
      expect(await rowsWithKey(hashed('not_a_scope', kind, value))).toHaveLength(0);
    }
  });

  it('The send past the per-recipient cap is refused through the gate and nothing is sent', async () => {
    // GIVEN two gates (two replicas) over two stores on one database
    const sender = createRecordingEmailSender();
    const gateOf = (capStore: EmailCapStore) =>
      createEmailTenantGate({
        disabledTenantIds: [],
        capStore,
        sender,
        recipientKeySecret: HMAC_SECRET,
      });
    const gateA = gateOf(storeA);
    const gateB = gateOf(storeB);
    const to = `invitee-${randomUUID()}@example.test`;

    // AND three invitations to the address from three tenants, over both replicas
    for (let hit = 0; hit < RECIPIENT_MAX; hit += 1) {
      await (hit % 2 === 0 ? gateA : gateB).send({
        tenantId: `tenant-${randomUUID()}`,
        to,
        template: INVITATION,
      });
    }
    expect(sender.sent).toHaveLength(RECIPIENT_MAX);

    // WHEN a fourth is attempted from a fourth tenant on either replica
    const refusedByA = await rejection(
      gateA.send({ tenantId: `tenant-${randomUUID()}`, to, template: INVITATION }),
    );
    const refusedByB = await rejection(
      gateB.send({ tenantId: `tenant-${randomUUID()}`, to, template: INVITATION }),
    );

    // THEN it fails with AUTH_RATE_LIMITED and a Retry-After, and nothing is sent
    for (const refused of [refusedByA, refusedByB]) {
      expect(refused).toBeInstanceOf(AuthRateLimitedError);
      expect((refused as AuthRateLimitedError).code).toBe('AUTH_RATE_LIMITED');
      expect((refused as AuthRateLimitedError).retryAfterSeconds).toBeGreaterThan(0);
    }
    expect(sender.sent).toHaveLength(RECIPIENT_MAX);
  });

  it('The notice dispatcher uses the same shared store for its own buckets', async () => {
    // GIVEN the per-recipient notice bucket of an administrator filled through replica A
    const sender = createRecordingEmailSender();
    const email = `admin-${randomUUID()}@example.test`;
    const key = recipientKey(email, HMAC_SECRET);
    for (let hit = 0; hit < NOTICE_RECIPIENT_MAX; hit += 1) {
      await storeA.consume('notice_recipient', key);
    }
    const dispatcher = createNoticeDispatcher({
      disabledTenantIds: [],
      capStore: storeB,
      sender,
      recipientKeySecret: HMAC_SECRET,
    });

    // WHEN replica B dispatches a notice to that administrator
    await dispatcher.send({
      tenantId: `tenant-${randomUUID()}`,
      template: NOTICE,
      recipients: [{ email, memberSince: new Date() }],
    });

    // THEN the bucket filled by A suppresses it
    expect(sender.sent).toHaveLength(0);
  });

  it('Every key is stored only as a hash', async () => {
    const tenant = `tenant-${randomUUID()}`;
    const email = `invitee-${randomUUID()}@example.test`;
    const key = recipientKey(email, HMAC_SECRET);

    await storeA.consume('tenant', tenant);
    await storeA.consume('recipient', key);
    await storeA.consume('notice_tenant', tenant);
    await storeA.consume('notice_recipient', key);

    for (const [bucket, kind, value] of [
      ['invitation_tenant', 'tenant', tenant],
      ['invitation_recipient', 'email', key],
      ['notice_tenant', 'tenant', tenant],
      ['notice_recipient', 'email', key],
    ] as const) {
      const rows = await rowsWithKey(hashed(bucket, kind, value));
      expect(rows, `${bucket} stored under its hash`).toHaveLength(1);
      expect(rows[0]?.key).toMatch(/^[0-9a-f]{64}$/);
    }
    for (const raw of [tenant, key, email, email.split('@')[0] ?? email]) {
      expect(await rowsLike(raw), 'the raw value appears in no stored key').toHaveLength(0);
    }
  });
});
