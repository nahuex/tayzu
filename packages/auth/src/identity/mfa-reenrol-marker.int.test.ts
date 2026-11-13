/**
 * Task 9.1 of openspec/changes/044-password-reset-and-account-recovery (design D11, Resolved
 * decision Q17): the `mfa-reenrol:<userId>` marker constants and the adapter-based reader and
 * clearer the hooks use. Rows are seeded with the module's constants through the adapter (test
 * seeding only; the one production writer is `writeMfaReenrolMarker` in `apps/api`).
 *
 * ## Production symbols expected
 *
 * - `./mfa-reenrol-marker.ts`:
 *   - `mfaReenrolMarkerIdentifier(userId): string` -> `mfa-reenrol:<userId>`
 *   - `MFA_REENROL_MARKER_VALUE: string` (the constant row value)
 *   - `hasMfaReenrolMarker(adapter, userId): Promise<boolean>` -- a failed lookup RESOLVES
 *     `true` ("reads as held", fail closed)
 *   - `clearMfaReenrolMarker(adapter, userId): Promise<void>`
 * - `./temporary-password.ts`: exports `MARKER_EXPIRES_AT_SENTINEL` (a `Date`, `9999-12-31`),
 *   the sentinel shared by every marker.
 *
 * The adapter is the real Better Auth adapter (`$context.adapter`); the rows are written with
 * `$context.internalAdapter.createVerificationValue`.
 */
import { randomUUID } from 'node:crypto';

import { runMigrations } from '@tayzu/db';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Import order is load-bearing (design D1): the harness registers before `../auth.js`.
import '../__fixtures__/registered-harness.js';
import { TEST_SECRET } from '../__fixtures__/test-secret.js';
import { createAuth, type AuthInstance } from '../auth.js';
import * as authSchema from '../persistence/schema.js';
import {
  clearMfaReenrolMarker,
  hasMfaReenrolMarker,
  MFA_REENROL_MARKER_VALUE,
  mfaReenrolMarkerIdentifier,
} from './mfa-reenrol-marker.js';
import { MARKER_EXPIRES_AT_SENTINEL, writeTemporaryPasswordMarker } from './temporary-password.js';

type MarkerAdapter = Parameters<typeof hasMfaReenrolMarker>[0];

interface BetterAuthContext {
  readonly adapter: MarkerAdapter;
  readonly internalAdapter: {
    createVerificationValue(data: {
      identifier: string;
      value: string;
      expiresAt: Date;
    }): Promise<unknown>;
    findVerificationValue(identifier: string): Promise<unknown>;
  };
}

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim() === '') {
    throw new Error(
      'DATABASE_URL is not set: the int project global setup should have stopped this run.',
    );
  }
  return url;
}

describe('the mfa-reenrol marker (task 9.1, D11, Q17)', () => {
  let db: ReturnType<typeof drizzle<typeof authSchema>>;
  let auth: AuthInstance;
  let context: BetterAuthContext;

  beforeAll(async () => {
    db = drizzle(databaseUrl(), { schema: authSchema });
    await runMigrations(db.$client);
    auth = createAuth({ db, secret: TEST_SECRET });
    context = (await (auth as unknown as { $context: Promise<unknown> })
      .$context) as BetterAuthContext;
  }, 60_000);

  afterAll(async () => {
    db.$client.on('error', () => {
      // Expected only during teardown; nothing left to report it to.
    });
    await db.$client.end();
  });

  async function seedMarker(userId: string): Promise<void> {
    await context.internalAdapter.createVerificationValue({
      identifier: mfaReenrolMarkerIdentifier(userId),
      value: MFA_REENROL_MARKER_VALUE,
      expiresAt: MARKER_EXPIRES_AT_SENTINEL,
    });
  }

  async function markerRows(userId: string): Promise<number> {
    const result = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from auth.verification where identifier = ${`mfa-reenrol:${userId}`}`,
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  it('the identifier is mfa-reenrol:<userId>', () => {
    const userId = randomUUID();
    expect(mfaReenrolMarkerIdentifier(userId)).toBe(`mfa-reenrol:${userId}`);
    expect(typeof MFA_REENROL_MARKER_VALUE).toBe('string');
    expect(MFA_REENROL_MARKER_VALUE.length).toBeGreaterThan(0);
  });

  it("the sentinel equals the temporary-password marker's", async () => {
    expect(MARKER_EXPIRES_AT_SENTINEL).toBeInstanceOf(Date);
    expect(MARKER_EXPIRES_AT_SENTINEL.toISOString()).toBe('9999-12-31T23:59:59.000Z');

    const userId = randomUUID();
    await writeTemporaryPasswordMarker(context.internalAdapter, userId);
    const stored = await db.execute<{ expires_at: string | Date }>(
      sql`select expires_at from auth.verification where identifier = ${`temp-password:${userId}`}`,
    );
    const storedValue = stored.rows[0]?.expires_at;
    if (storedValue === undefined) throw new Error('temporary-password marker row is missing');
    const storedTime = new Date(storedValue).getTime();
    expect(storedTime).toBe(MARKER_EXPIRES_AT_SENTINEL.getTime());

    await seedMarker(userId);
    const marker = await db.execute<{ expires_at: string | Date }>(
      sql`select expires_at from auth.verification where identifier = ${`mfa-reenrol:${userId}`}`,
    );
    const markerValue = marker.rows[0]?.expires_at;
    if (markerValue === undefined) throw new Error('mfa-reenrol marker row is missing');
    expect(new Date(markerValue).getTime()).toBe(storedTime);
  });

  it('has is false without a row and true with one', async () => {
    const userId = randomUUID();
    const other = randomUUID();
    expect(await hasMfaReenrolMarker(context.adapter, userId)).toBe(false);

    await seedMarker(userId);
    expect(await hasMfaReenrolMarker(context.adapter, userId)).toBe(true);
    expect(await hasMfaReenrolMarker(context.adapter, other), "another user's id").toBe(false);
  });

  it('clear removes it', async () => {
    const userId = randomUUID();
    const other = randomUUID();
    await seedMarker(userId);
    await seedMarker(other);

    await clearMfaReenrolMarker(context.adapter, userId);

    expect(await markerRows(userId)).toBe(0);
    expect(await hasMfaReenrolMarker(context.adapter, userId)).toBe(false);
    expect(await markerRows(other), "another user's marker stays").toBe(1);

    // Clearing an absent marker is not an error.
    await expect(clearMfaReenrolMarker(context.adapter, userId)).resolves.toBeUndefined();
  });

  it("Better Auth's opportunistic cleanup does not remove it", async () => {
    const userId = randomUUID();
    await seedMarker(userId);

    await context.internalAdapter.findVerificationValue(`unrelated-identifier-${randomUUID()}`);

    expect(await markerRows(userId), 'the cleanup did not remove the marker').toBe(1);
    expect(await hasMfaReenrolMarker(context.adapter, userId)).toBe(true);
  });

  it('a failed lookup reads as held', async () => {
    const failing = new Proxy(
      {},
      {
        get: () => () => Promise.reject(new Error('the lookup failed')),
      },
    ) as MarkerAdapter;

    expect(await hasMfaReenrolMarker(failing, randomUUID())).toBe(true);
  });
});
