/**
 * Integration test for task 6.10 of change 043 (`specs/identity-lifecycle-and-org-admin`,
 * design "Invitation caps" and Resolved decision Q66): the production store for the
 * invitation caps and the accept route's limiter is `002`'s DB-backed atomic store
 * (`auth.rate_limit`, hashed keys, no migration), exposed by `@tayzu/auth` as a
 * scope-generic helper.
 *
 * Production symbols this file expects (none exists yet):
 *
 * - `./bucket-store.js` exports `createRateLimitBucketStore(options)`, with
 *   `options = { adapter, rules }`: `adapter` is `(await auth.$context).adapter`
 *   (Better Auth's `DBAdapter`), `rules` maps a scope to `{ window (seconds), max }`.
 * - the store has `consume({ scope, kind, value }) => Promise<{ allowed: boolean;
 *   retryAfterSeconds: number | null }>`. It rejects (throws) for a scope that is not
 *   one of the known scopes with a rule, creating no row. A denial is reported by the
 *   store itself on `002`'s `tayzu.auth.rate_limit.events` metric and
 *   `auth.security.rate_limited` log event, with the scope as the only attribute.
 * - `RateLimitScope` (in `./pre-auth-rate-limit.js`) gains `invitation_accept`,
 *   `invitation_tenant`, `invitation_recipient` and `notice_tenant`.
 * - the bucket key kinds gain `'tenant'`: `kind` is `'ip' | 'email' | 'user' | 'tenant'`.
 *   The stored key is `sha256_hex("<scope>:<kind>:<value>")` (the existing
 *   `hashBucketKey` format), so no raw value is ever persisted.
 *
 * Two store instances are built from two separate Better Auth instances (two
 * connection pools) over the same database, which is what two replicas look like.
 * Each test uses fresh random bucket values, so nothing is shared with other files.
 */
import { createHash, randomUUID } from 'node:crypto';

import type { Attributes } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { runMigrations } from '@tayzu/db';
import type { DBAdapter } from 'better-auth/types';
import { eq, like } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Import order is load-bearing: the telemetry harness registers before the modules
// that create instruments at import time (see pre-auth-rate-limit.int.test.ts).
import { registration, type TelemetryTestHarness } from '../__fixtures__/registered-harness.js';
import { TEST_SECRET } from '../__fixtures__/test-secret.js';
import { createAuth } from '../auth.js';
import * as authSchema from '../persistence/schema.js';
import { createRateLimitBucketStore } from './bucket-store.js';
import type { RateLimitScope } from './pre-auth-rate-limit.js';

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

async function endQuietly(closeable: {
  on(event: 'error', listener: (error: unknown) => void): unknown;
  end(): Promise<void>;
}): Promise<void> {
  closeable.on('error', () => {
    // Expected only during teardown; nothing left to report it to.
  });
  await closeable.end();
}

const NEW_SCOPES = [
  'invitation_accept',
  'invitation_tenant',
  'invitation_recipient',
  'notice_tenant',
] as const satisfies readonly RateLimitScope[];

type NewScope = (typeof NEW_SCOPES)[number];

/** The kind each new scope is keyed by in production. */
const KIND_OF: Record<NewScope, 'ip' | 'tenant' | 'email'> = {
  invitation_accept: 'ip',
  invitation_tenant: 'tenant',
  invitation_recipient: 'email',
  notice_tenant: 'tenant',
};

const MAX = 3;
const WINDOW_SECONDS = 3600;

const RULES = Object.fromEntries(
  NEW_SCOPES.map((scope) => [scope, { window: WINDOW_SECONDS, max: MAX }]),
) as Record<NewScope, { window: number; max: number }>;

interface Bucket {
  readonly scope: NewScope;
  readonly kind: 'ip' | 'tenant' | 'email' | 'user';
  readonly value: string;
}

interface ConsumeOutcome {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number | null;
}

interface BucketStore {
  consume(bucket: {
    readonly scope: string;
    readonly kind: string;
    readonly value: string;
  }): Promise<ConsumeOutcome>;
}

function hashedKey(bucket: Bucket): string {
  return createHash('sha256')
    .update(`${bucket.scope}:${bucket.kind}:${bucket.value}`)
    .digest('hex');
}

function freshBucket(scope: NewScope): Bucket {
  return { scope, kind: KIND_OF[scope], value: `bucket-value-${randomUUID()}` };
}

const METRIC_DATA_POINT_TYPE_SUM = 3;
const RATE_LIMIT_SCOPE_ATTRIBUTE = 'tayzu.auth.rate_limit.scope';

describe('Invitation rate-limit store on 002 auth.rate_limit (task 6.10)', () => {
  let dbA: TestDb;
  let dbB: TestDb;
  let storeA: BucketStore;
  let storeB: BucketStore;
  let adapterA: DBAdapter;
  let harness: TelemetryTestHarness;

  function registeredHarness(): TelemetryTestHarness {
    if ('error' in registration) {
      throw new Error(
        `createTelemetryTestHarness() failed while the test module graph loaded: ${String(registration.error)}`,
        { cause: registration.error },
      );
    }
    return registration.harness;
  }

  async function adapterOf(db: TestDb): Promise<DBAdapter> {
    const auth = createAuth({ db, secret: TEST_SECRET });
    const context = (await (auth.$context as Promise<{ adapter: DBAdapter }>)).adapter;
    return context;
  }

  async function rowsWithKey(key: string): Promise<{ key: string; count: number }[]> {
    return dbA
      .select({ key: authSchema.rateLimit.key, count: authSchema.rateLimit.count })
      .from(authSchema.rateLimit)
      .where(eq(authSchema.rateLimit.key, key));
  }

  beforeAll(async () => {
    dbA = connect(databaseUrl());
    dbB = connect(databaseUrl());
    await runMigrations(dbA.$client);
    adapterA = await adapterOf(dbA);
    const adapterB = await adapterOf(dbB);
    storeA = createRateLimitBucketStore({ adapter: adapterA, rules: RULES });
    storeB = createRateLimitBucketStore({ adapter: adapterB, rules: RULES });
    harness = registeredHarness();
  }, 60_000);

  afterEach(async () => {
    await harness.reset();
  });

  afterAll(async () => {
    await endQuietly(dbA.$client);
    await endQuietly(dbB.$client);
  });

  it.each(NEW_SCOPES)(
    'Two store instances over the same database share one count for scope %s',
    async (scope) => {
      const bucket = freshBucket(scope);

      expect((await storeA.consume(bucket)).allowed).toBe(true);
      expect((await storeB.consume(bucket)).allowed).toBe(true);
      expect((await storeA.consume(bucket)).allowed).toBe(true);

      // The cap is MAX: the fourth hit is refused whichever instance serves it.
      const deniedByB = await storeB.consume(bucket);
      expect(deniedByB.allowed).toBe(false);
      expect(deniedByB.retryAfterSeconds).toBeGreaterThan(0);
      expect((await storeA.consume(bucket)).allowed).toBe(false);

      const rows = await rowsWithKey(hashedKey(bucket));
      expect(rows, 'one row, one shared count').toHaveLength(1);
      expect(rows[0]?.count).toBe(MAX);
    },
  );

  it('Two instances racing for the same bucket never exceed the cap', async () => {
    const bucket = freshBucket('invitation_recipient');

    const outcomes = await Promise.all(
      Array.from({ length: 8 }, (_unused, index) =>
        (index % 2 === 0 ? storeA : storeB).consume(bucket),
      ),
    );

    expect(outcomes.filter((outcome) => outcome.allowed)).toHaveLength(MAX);
    expect(outcomes.filter((outcome) => !outcome.allowed)).toHaveLength(8 - MAX);
  });

  it('Different scopes and different values never share a count', async () => {
    const first = freshBucket('invitation_tenant');
    const sameValueOtherScope: Bucket = { ...first, scope: 'notice_tenant' };
    const otherValue = freshBucket('invitation_tenant');

    for (let hit = 0; hit < MAX; hit += 1) {
      expect((await storeA.consume(first)).allowed).toBe(true);
    }
    expect((await storeA.consume(first)).allowed).toBe(false);

    expect((await storeB.consume(sameValueOtherScope)).allowed).toBe(true);
    expect((await storeB.consume(otherValue)).allowed).toBe(true);
  });

  it.each(NEW_SCOPES)('A key is stored only as a hash for scope %s', async (scope) => {
    const bucket = freshBucket(scope);

    await storeA.consume(bucket);

    const rows = await rowsWithKey(hashedKey(bucket));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toMatch(/^[0-9a-f]{64}$/);
    const leaked = await dbA
      .select({ key: authSchema.rateLimit.key })
      .from(authSchema.rateLimit)
      .where(like(authSchema.rateLimit.key, `%${bucket.value}%`));
    expect(leaked, 'the raw value appears in no stored key').toHaveLength(0);
  });

  it('A key of the tenant kind is stored only as a hash', async () => {
    const tenantId = randomUUID();
    const bucket: Bucket = { scope: 'invitation_tenant', kind: 'tenant', value: tenantId };

    expect((await storeA.consume(bucket)).allowed).toBe(true);

    const rows = await rowsWithKey(hashedKey(bucket));
    expect(rows, 'the tenant kind is accepted and hashed').toHaveLength(1);
    expect(rows[0]?.key).not.toContain(tenantId);
    const leaked = await dbA
      .select({ key: authSchema.rateLimit.key })
      .from(authSchema.rateLimit)
      .where(like(authSchema.rateLimit.key, `%${tenantId}%`));
    expect(leaked).toHaveLength(0);
  });

  it('The new scopes are accepted by the helper', async () => {
    for (const scope of NEW_SCOPES) {
      const outcome = await storeA.consume(freshBucket(scope));
      expect(outcome.allowed, `scope ${scope} is accepted`).toBe(true);
    }
  });

  it('An unknown scope is refused and creates no bucket', async () => {
    const value = `bucket-value-${randomUUID()}`;
    const unknown = { scope: 'not_a_scope', kind: 'ip', value };
    const key = createHash('sha256').update(`not_a_scope:ip:${value}`).digest('hex');

    await expect(storeA.consume(unknown)).rejects.toThrow();

    expect(await rowsWithKey(key)).toHaveLength(0);
  });

  it.each(NEW_SCOPES)(
    'A denial is reported on the rate-limit metric and log event with the scope value %s',
    async (scope) => {
      const bucket = freshBucket(scope);
      for (let hit = 0; hit < MAX; hit += 1) {
        expect((await storeA.consume(bucket)).allowed).toBe(true);
      }
      await harness.forceFlush();
      const eventsBefore = [...harness.logExporter.getFinishedLogRecords()].filter(
        (record) => record.eventName === 'auth.security.rate_limited',
      );
      expect(eventsBefore, 'allowed hits report nothing').toHaveLength(0);

      expect((await storeB.consume(bucket)).allowed).toBe(false);
      await harness.forceFlush();

      const logs = [...harness.logExporter.getFinishedLogRecords()].filter(
        (record) => record.eventName === 'auth.security.rate_limited',
      );
      expect(logs, 'exactly one rate_limited log record').toHaveLength(1);
      expect(logs[0]?.severityNumber).toBe(SeverityNumber.WARN);
      expect(logs[0]?.attributes).toEqual({ [RATE_LIMIT_SCOPE_ATTRIBUTE]: scope });

      const points: { attributes: Attributes; value: number }[] = [];
      for (const resourceMetrics of harness.metricExporter.getMetrics()) {
        for (const scopeMetrics of resourceMetrics.scopeMetrics) {
          for (const metric of scopeMetrics.metrics) {
            if (
              metric.descriptor.name === 'tayzu.auth.rate_limit.events' &&
              // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
              metric.dataPointType === METRIC_DATA_POINT_TYPE_SUM
            ) {
              for (const dataPoint of metric.dataPoints) {
                points.push({ attributes: dataPoint.attributes, value: dataPoint.value });
              }
            }
          }
        }
      }
      expect(points).toHaveLength(1);
      expect(points[0]?.value).toBe(1);
      expect(points[0]?.attributes).toEqual({ [RATE_LIMIT_SCOPE_ATTRIBUTE]: scope });

      const snapshot = JSON.stringify([
        ...[...harness.logExporter.getFinishedLogRecords()].map((r) => [r.attributes, r.body]),
        points.map((p) => p.attributes),
      ]);
      expect(snapshot, 'no bucket value in telemetry').not.toContain(bucket.value);
    },
  );

  // Task 6.10b (Resolved decision Q66). The clock seam is a Date-only fake clock
  // (`vi.useFakeTimers({ toFake: ['Date'] })`): the store reads `Date.now()`, and the
  // pool's real timers stay untouched.
  it('A slow trickle never resets a bucket', async () => {
    const dayWindowSeconds = 24 * 60 * 60;
    const dayStore = createRateLimitBucketStore({
      adapter: adapterA,
      rules: { invitation_recipient: { window: dayWindowSeconds, max: 3 } },
    });
    const bucket = freshBucket('invitation_recipient');
    const justUnderWindowMs = (dayWindowSeconds - 60) * 1000;
    const fullWindowMs = dayWindowSeconds * 1000;
    const start = Date.now();

    vi.useFakeTimers({ toFake: ['Date'], now: start });
    try {
      // GIVEN requests spaced just under 24 hours apart: all three are allowed.
      for (let hit = 0; hit < 3; hit += 1) {
        vi.setSystemTime(start + hit * justUnderWindowMs);
        expect((await dayStore.consume(bucket)).allowed, `request ${String(hit + 1)}`).toBe(true);
      }

      // WHEN the fourth arrives, again just under a window after the third:
      // THEN it is refused, because no quiet full window ever reset the bucket.
      vi.setSystemTime(start + 3 * justUnderWindowMs);
      const fourth = await dayStore.consume(bucket);
      expect(fourth.allowed).toBe(false);
      expect(fourth.retryAfterSeconds).toBeGreaterThan(0);

      // AND a gap of a full window since the last allowed request resets it.
      vi.setSystemTime(start + 2 * justUnderWindowMs + fullWindowMs);
      expect((await dayStore.consume(bucket)).allowed).toBe(true);
      for (let hit = 0; hit < 2; hit += 1) {
        expect((await dayStore.consume(bucket)).allowed).toBe(true);
      }
      expect((await dayStore.consume(bucket)).allowed, 'the fresh bucket caps at 3 again').toBe(
        false,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
