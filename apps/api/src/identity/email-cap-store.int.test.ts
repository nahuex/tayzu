/**
 * Task 14.12 of openspec/changes/archive/2026-10-14-043-identity-lifecycle-and-org-admin (design D4
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
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

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

/**
 * Task 4.3 of openspec/changes/044-password-reset-and-account-recovery (design D16 and the
 * "Caps" bullet of D7; scenario "Reset caps and invitation caps are counted apart").
 *
 * ## Production symbols expected
 *
 * - `./email-cap-store.js`: the `BUCKETS` table gains six rows. The cap scope the mailer
 *   passes to `consume(scope, key)` maps onto the bucket (`RateLimitScope`, kind) of
 *   `@tayzu/auth`:
 *   - `reset_recipient` -> `reset_email_recipient` (kind `email`)
 *   - `reset_ip` -> `reset_email_ip` (kind `ip`)
 *   - `reset_global` -> `reset_email_global` (kind `global`, one constant key)
 *   - `recovery_notice_recipient` -> `recovery_notice_recipient` (kind `email`)
 *   - `account_created_tenant` -> `account_created_notice_tenant` (kind `tenant`)
 *   - `account_created_global` -> `account_created_notice_global` (kind `global`)
 * - A full bucket rejects with `AuthRateLimitedError`; a scope with no row still throws.
 * - The rules of the six buckets are built from `Config` in `createApp` (`server.ts`); this
 *   file builds its own rules, so that wiring is covered by the later config and wiring tasks.
 */
describe('the reset and recovery caps on the shared DB-backed store (044 task 4.3)', () => {
  const RESET_RECIPIENT_MAX = 2;
  const RESET_IP_MAX = 3;
  const RESET_GLOBAL_MAX = 4;
  const NOTICE_RECIPIENT_MAX_044 = 2;
  const ACCOUNT_TENANT_MAX = 3;
  const ACCOUNT_GLOBAL_MAX = 5;

  const RULES_044 = {
    invitation_recipient: { max: RECIPIENT_MAX, window: DAY },
    notice_recipient: { max: NOTICE_RECIPIENT_MAX, window: DAY },
    reset_email_recipient: { max: RESET_RECIPIENT_MAX, window: HOUR },
    reset_email_ip: { max: RESET_IP_MAX, window: HOUR },
    reset_email_global: { max: RESET_GLOBAL_MAX, window: HOUR },
    recovery_notice_recipient: { max: NOTICE_RECIPIENT_MAX_044, window: DAY },
    account_created_notice_tenant: { max: ACCOUNT_TENANT_MAX, window: DAY },
    account_created_notice_global: { max: ACCOUNT_GLOBAL_MAX, window: DAY },
  } as const;

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
      store: createRateLimitBucketStore({ adapter: await adapterOf(dbA), rules: RULES_044 }),
    });
    storeB = createDbEmailCapStore({
      store: createRateLimitBucketStore({ adapter: await adapterOf(dbB), rules: RULES_044 }),
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

  it('Reset caps and invitation caps are counted apart', async () => {
    // GIVEN an address with a full invitation bucket
    const key = `value-${randomUUID()}`;
    for (let hit = 0; hit < RECIPIENT_MAX; hit += 1) {
      await storeA.consume('recipient', key);
    }
    await expect(storeA.consume('recipient', key)).rejects.toBeInstanceOf(AuthRateLimitedError);

    // WHEN it requests a reset THEN the reset bucket still has room
    await expect(storeB.consume('reset_recipient', key)).resolves.toBeUndefined();

    // AND the reverse holds: a full reset bucket leaves the invitation and notice buckets alone
    const other = `value-${randomUUID()}`;
    for (let hit = 0; hit < RESET_RECIPIENT_MAX; hit += 1) {
      await storeA.consume('reset_recipient', other);
    }
    await expect(storeB.consume('reset_recipient', other)).rejects.toBeInstanceOf(
      AuthRateLimitedError,
    );
    await expect(storeB.consume('recipient', other)).resolves.toBeUndefined();
    await expect(storeB.consume('notice_recipient', other)).resolves.toBeUndefined();
    await expect(storeB.consume('recovery_notice_recipient', other)).resolves.toBeUndefined();
  });

  it('The six buckets hold under two store instances over one database', async () => {
    const cases = [
      {
        scope: 'reset_recipient',
        max: RESET_RECIPIENT_MAX,
        bucket: 'reset_email_recipient',
        kind: 'email',
      },
      { scope: 'reset_ip', max: RESET_IP_MAX, bucket: 'reset_email_ip', kind: 'ip' },
      {
        scope: 'reset_global',
        max: RESET_GLOBAL_MAX,
        bucket: 'reset_email_global',
        kind: 'global',
      },
      {
        scope: 'recovery_notice_recipient',
        max: NOTICE_RECIPIENT_MAX_044,
        bucket: 'recovery_notice_recipient',
        kind: 'email',
      },
      {
        scope: 'account_created_tenant',
        max: ACCOUNT_TENANT_MAX,
        bucket: 'account_created_notice_tenant',
        kind: 'tenant',
      },
      {
        scope: 'account_created_global',
        max: ACCOUNT_GLOBAL_MAX,
        bucket: 'account_created_notice_global',
        kind: 'global',
      },
    ] as const;

    for (const { scope, max, bucket, kind } of cases) {
      // Global buckets hold one constant key, so they are compared by behavior, not by row.
      const value = `value-${randomUUID()}`;
      const isGlobal = kind === 'global';
      for (let hit = 0; hit < max; hit += 1) {
        await (hit % 2 === 0 ? storeA : storeB).consume(scope, value);
      }

      // The cap is shared: the next hit is refused whichever store serves it.
      const byA = await rejection(storeA.consume(scope, value));
      const byB = await rejection(storeB.consume(scope, value));
      expect(byA, `${scope} refused by A`).toBeInstanceOf(AuthRateLimitedError);
      expect(byB, `${scope} refused by B`).toBeInstanceOf(AuthRateLimitedError);
      expect((byA as AuthRateLimitedError).code).toBe('AUTH_RATE_LIMITED');
      expect((byA as AuthRateLimitedError).retryAfterSeconds).toBeGreaterThan(0);

      if (!isGlobal) {
        const rows = await rowsWithKey(hashed(bucket, kind, value));
        expect(rows, `${scope}: one row, one shared count`).toHaveLength(1);
        expect(rows[0]?.count).toBe(max);
        expect(rows[0]?.key).toMatch(/^[0-9a-f]{64}$/);
        expect(await rowsLike(value), `${scope}: the raw value is not stored`).toHaveLength(0);
      }
    }
  });

  it('The six buckets never share a count with each other', async () => {
    const value = `value-${randomUUID()}`;
    for (let hit = 0; hit < RESET_RECIPIENT_MAX; hit += 1) {
      await storeA.consume('reset_recipient', value);
    }
    await expect(storeB.consume('reset_recipient', value)).rejects.toBeInstanceOf(
      AuthRateLimitedError,
    );
    await expect(storeB.consume('reset_ip', value)).resolves.toBeUndefined();
    await expect(storeB.consume('account_created_tenant', value)).resolves.toBeUndefined();
  });

  it('an unsupported scope still throws', async () => {
    const value = `value-${randomUUID()}`;

    // The names of the underlying rate-limit scopes are not cap scopes.
    for (const scope of [
      'not_a_scope',
      'reset_email_recipient',
      'reset_email_ip',
      'reset_email_global',
      'account_created_notice_tenant',
      'account_created_notice_global',
      'password_reset_request',
    ]) {
      await expect(storeA.consume(scope, value), scope).rejects.toThrow();
    }

    expect(await rowsLike(value)).toHaveLength(0);
    for (const bucket of [
      'reset_email_recipient',
      'reset_email_ip',
      'account_created_notice_tenant',
    ]) {
      for (const kind of ['tenant', 'email', 'ip', 'user', 'global']) {
        expect(await rowsWithKey(hashed(bucket, kind, value))).toHaveLength(0);
      }
    }
  });
});

/**
 * Task 5.7 of openspec/changes/044-password-reset-and-account-recovery (design D5 "Fixed
 * windows for the two global caps", Resolved decision Q32).
 *
 * ## Production symbols expected
 *
 * - `./email-cap-store.js`: `createDbEmailCapStore(options)` gains two optional options:
 *   - `globalWindowSeconds: { reset_global: number; account_created_global: number }`, the
 *     window of the configured cap of each global bucket (`createApp` passes it). A global
 *     bucket's value becomes `<key>:<floor(now / window)>` before it reaches the bucket
 *     store, so each fixed window is a new row at zero.
 *   - `now: () => number` (epoch milliseconds, default `Date.now`), the injectable clock
 *     that computes the window index.
 * - Only `reset_global` and `account_created_global` change; every other scope keeps
 *   `002`'s semantics (the window slides from the last allowed request, `043` Q66).
 *
 * The bucket store itself reads `Date.now()` for `lastRequest`, so the tests move both the
 * injected clock and a Date-only fake clock together.
 */
describe('fixed windows for the two global caps (044 task 5.7, Q32)', () => {
  const RESET_GLOBAL_MAX_FW = 4;
  const ACCOUNT_GLOBAL_MAX_FW = 5;
  const MINUTE_MS = 60_000;
  const HOUR_MS = HOUR * 1000;
  const DAY_MS = DAY * 1000;

  const RULES_FW = {
    invitation_tenant: { max: 2, window: HOUR },
    invitation_recipient: { max: 2, window: DAY },
    reset_email_recipient: { max: 2, window: HOUR },
    reset_email_ip: { max: 2, window: HOUR },
    reset_email_global: { max: RESET_GLOBAL_MAX_FW, window: HOUR },
    account_created_notice_tenant: { max: 2, window: DAY },
    account_created_notice_global: { max: ACCOUNT_GLOBAL_MAX_FW, window: DAY },
  } as const;

  let db: TestDb;
  let store: EmailCapStore;
  let clock = 0;

  function setClock(ms: number): void {
    clock = ms;
    vi.setSystemTime(ms);
  }

  async function rowsWithKey(key: string): Promise<{ key: string; count: number }[]> {
    return db
      .select({ key: authSchema.rateLimit.key, count: authSchema.rateLimit.count })
      .from(authSchema.rateLimit)
      .where(eq(authSchema.rateLimit.key, key));
  }

  async function countOf(key: string): Promise<number | undefined> {
    return (await rowsWithKey(key))[0]?.count;
  }

  /** A random window start well inside the past, aligned to `windowMs`. */
  function alignedStart(windowMs: number): number {
    const back = 1000 + Math.floor(Math.random() * 100_000);
    return Math.floor(Date.now() / windowMs) * windowMs - back * windowMs;
  }

  beforeAll(async () => {
    db = connect(databaseUrl());
    await runMigrations(db.$client);
    const auth = createAuth({ db, secret: TEST_SECRET });
    const adapter = (
      await (auth.$context as Promise<{ adapter: RateLimitBucketStoreOptions['adapter'] }>)
    ).adapter;
    store = createDbEmailCapStore({
      store: createRateLimitBucketStore({ adapter, rules: RULES_FW }),
      globalWindowSeconds: { reset_global: HOUR, account_created_global: DAY },
      now: () => clock,
    });
  }, 60_000);

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    db.$client.on('error', () => {
      // Expected only during teardown.
    });
    await db.$client.end();
  });

  it('a global bucket at its cap admits again at the next fixed window while traffic continues', async () => {
    const key = `global-${randomUUID()}`;
    const windowStart = alignedStart(HOUR_MS);
    vi.useFakeTimers({ toFake: ['Date'], now: windowStart });

    // GIVEN the bucket filled late in a fixed window
    setClock(windowStart + 50 * MINUTE_MS);
    for (let hit = 0; hit < RESET_GLOBAL_MAX_FW; hit += 1) {
      await store.consume('reset_global', key);
    }
    await expect(store.consume('reset_global', key)).rejects.toBeInstanceOf(AuthRateLimitedError);

    // AND traffic continues inside the window: still refused
    setClock(windowStart + 55 * MINUTE_MS);
    await expect(store.consume('reset_global', key)).rejects.toBeInstanceOf(AuthRateLimitedError);

    // WHEN the next fixed window starts (well under a full window after the last allowed hit)
    setClock(windowStart + HOUR_MS + MINUTE_MS);

    // THEN the cap admits again, up to its maximum, and then refuses again
    for (let hit = 0; hit < RESET_GLOBAL_MAX_FW; hit += 1) {
      await expect(store.consume('reset_global', key), `hit ${String(hit + 1)}`).resolves.toBe(
        undefined,
      );
    }
    await expect(store.consume('reset_global', key)).rejects.toBeInstanceOf(AuthRateLimitedError);
  });

  it('two consumes in one window share one row and the next window writes a new row', async () => {
    const key = `global-${randomUUID()}`;
    const windowStart = alignedStart(HOUR_MS);
    const index = windowStart / HOUR_MS;
    vi.useFakeTimers({ toFake: ['Date'], now: windowStart });

    setClock(windowStart + MINUTE_MS);
    await store.consume('reset_global', key);
    setClock(windowStart + 30 * MINUTE_MS);
    await store.consume('reset_global', key);

    const first = hashed('reset_email_global', 'global', `${key}:${String(index)}`);
    const second = hashed('reset_email_global', 'global', `${key}:${String(index + 1)}`);
    expect(await rowsWithKey(first), 'one row for the window').toHaveLength(1);
    expect(await countOf(first)).toBe(2);
    expect(await rowsWithKey(second), 'no row for the next window yet').toHaveLength(0);
    expect(
      await rowsWithKey(hashed('reset_email_global', 'global', key)),
      'the bare key is never stored',
    ).toHaveLength(0);

    setClock(windowStart + HOUR_MS + MINUTE_MS);
    await store.consume('reset_global', key);

    expect(await rowsWithKey(second), 'the next window writes a new row').toHaveLength(1);
    expect(await countOf(second)).toBe(1);
    expect(await countOf(first), 'the past window row is untouched').toBe(2);
  });

  it("the recipient, IP and tenant buckets keep 002's semantics (a consume just after the window still counts while traffic continues)", async () => {
    const cases = [
      { scope: 'reset_recipient', bucket: 'reset_email_recipient', kind: 'email', window: HOUR },
      { scope: 'reset_ip', bucket: 'reset_email_ip', kind: 'ip', window: HOUR },
      { scope: 'recipient', bucket: 'invitation_recipient', kind: 'email', window: DAY },
      { scope: 'tenant', bucket: 'invitation_tenant', kind: 'tenant', window: HOUR },
      {
        scope: 'account_created_tenant',
        bucket: 'account_created_notice_tenant',
        kind: 'tenant',
        window: DAY,
      },
    ] as const;

    for (const { scope, bucket, kind, window } of cases) {
      const value = `value-${randomUUID()}`;
      const windowMs = window * 1000;
      const windowStart = alignedStart(windowMs);
      vi.useFakeTimers({ toFake: ['Date'], now: windowStart });

      // GIVEN the bucket filled late in a fixed-window slot
      setClock(windowStart + windowMs - 10 * MINUTE_MS);
      await store.consume(scope, value);
      await store.consume(scope, value);

      // WHEN a consume arrives just after the fixed boundary, with traffic continuing
      setClock(windowStart + windowMs + MINUTE_MS);

      // THEN it still counts against the same bucket and is refused
      await expect(
        store.consume(scope, value),
        `${scope} refused after the boundary`,
      ).rejects.toBeInstanceOf(AuthRateLimitedError);
      const rows = await rowsWithKey(hashed(bucket, kind, value));
      expect(rows, `${scope}: one row under the bare value`).toHaveLength(1);
      expect(rows[0]?.count).toBe(2);
      vi.useRealTimers();
    }
  });

  it('the account-created global bucket uses its own window', async () => {
    const key = `global-${randomUUID()}`;
    const dayStart = alignedStart(DAY_MS);
    const dayIndex = dayStart / DAY_MS;
    vi.useFakeTimers({ toFake: ['Date'], now: dayStart });

    // GIVEN both global buckets filled late in an hour of the day
    setClock(dayStart + 5 * HOUR_MS + 50 * MINUTE_MS);
    for (let hit = 0; hit < ACCOUNT_GLOBAL_MAX_FW; hit += 1) {
      await store.consume('account_created_global', key);
    }
    for (let hit = 0; hit < RESET_GLOBAL_MAX_FW; hit += 1) {
      await store.consume('reset_global', key);
    }

    // THEN the row is keyed by the index of the day, not of the hour
    const dayRow = hashed('account_created_notice_global', 'global', `${key}:${String(dayIndex)}`);
    expect(await countOf(dayRow)).toBe(ACCOUNT_GLOBAL_MAX_FW);

    // WHEN the next hour starts but the day goes on
    setClock(dayStart + 6 * HOUR_MS + 10 * MINUTE_MS);

    // THEN the hourly reset cap admits again and the daily account-created cap does not
    await expect(store.consume('reset_global', key)).resolves.toBeUndefined();
    await expect(store.consume('account_created_global', key)).rejects.toBeInstanceOf(
      AuthRateLimitedError,
    );

    // AND the next day starts a new row for the account-created cap
    setClock(dayStart + DAY_MS + MINUTE_MS);
    await expect(store.consume('account_created_global', key)).resolves.toBeUndefined();
    const nextDayRow = hashed(
      'account_created_notice_global',
      'global',
      `${key}:${String(dayIndex + 1)}`,
    );
    expect(await countOf(nextDayRow)).toBe(1);
    expect(await countOf(dayRow)).toBe(ACCOUNT_GLOBAL_MAX_FW);
  });
});
