/**
 * Integration test for task 7.2 of `043-identity-lifecycle-and-org-admin`
 * (design D4; spec "Invitation lifecycle").
 *
 * Verify clause: "`invitation-config.int.test.ts` asserts the 48-hour
 * `expiresAt` on a real invitation and the mapped states."
 *
 * Expected production symbols:
 * - `./identity/invitation-state.ts` exports
 *   `toBoundaryInvitationState(invitation: { status: string; expiresAt: Date },
 *   now: Date): 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'expired'`.
 *   Stored `canceled` maps to `cancelled`; `expired` is never stored and is
 *   derived: a stored `pending` whose `expiresAt` is not after `now`.
 * - `./auth.ts` configures `organization({ invitationExpiresIn: 48 * 60 * 60,
 *   cancelPendingInvitationsOnReInvite: true })`.
 *
 * Note: Better Auth's own default for `invitationExpiresIn` is already 48
 * hours, so the expiry test may pass before any change; the re-invite and
 * mapper tests are the red ones.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { runMigrations } from '@tayzu/db';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Import order is load-bearing: the harness registers before `./auth.js`.
import { bootstrapTestTenant } from './__fixtures__/admin-user.js';
import './__fixtures__/registered-harness.js';
import { createAuth, type AuthInstance } from './auth.js';
import * as authSchema from './persistence/schema.js';
import { TEST_SECRET } from './__fixtures__/test-secret.js';

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
    // Expected only during teardown.
  });
  await closeable.end();
}

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

const TEST_PASSWORD = 'correct horse battery staple';
const AUTH_BASE_URL = 'http://localhost:3000/api/auth';
const TEST_ORIGIN = 'http://localhost:3000';
const HOURS_48_MS = 48 * 60 * 60 * 1000;
/** Allowed drift between the request and the stored expiry. */
const TOLERANCE_MS = 60_000;

function handlerOf(auth: AuthInstance): (request: Request) => Promise<Response> {
  return (auth as unknown as { handler: (request: Request) => Promise<Response> }).handler;
}

type InvitationRow = {
  readonly id: string;
  readonly status: string;
  readonly expires_ms: string;
};

async function invite(
  auth: AuthInstance,
  cookie: string,
  organizationId: string,
  email: string,
): Promise<{ id: string; status: number }> {
  const response = await handlerOf(auth)(
    new Request(`${AUTH_BASE_URL}/organization/invite-member`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: TEST_ORIGIN,
        'x-forwarded-for': randomIp(),
      },
      body: JSON.stringify({ email, role: 'member', organizationId }),
    }),
  );
  const text = await response.text();
  if (response.status !== 200) {
    return { id: '', status: response.status };
  }
  const body = JSON.parse(text) as { id: string };
  return { id: body.id, status: response.status };
}

async function findInvitation(db: TestDb, id: string): Promise<InvitationRow | undefined> {
  const result = await db.execute<InvitationRow>(sql`
    select id, status, (extract(epoch from expires_at) * 1000)::text as expires_ms from auth.invitation where id = ${id}
  `);
  return result.rows[0];
}

describe('Better Auth invitation options and the boundary mapper (task 7.2, design D4)', () => {
  let db: TestDb;
  let auth: AuthInstance;

  beforeAll(async () => {
    db = connect(databaseUrl());
    await runMigrations(db.$client);
    auth = createAuth({ db, secret: TEST_SECRET });
  }, 60_000);

  afterAll(async () => {
    await endQuietly(db.$client);
  });

  async function tenant(): Promise<{ cookie: string; organizationId: string }> {
    const t = await bootstrapTestTenant(auth, {
      name: 'Invitation Config Admin',
      email: `inv-config-${randomUUID()}@example.test`,
      password: TEST_PASSWORD,
      organizationName: 'Invitation Config Org',
      organizationSlug: `inv-config-${randomUUID()}`,
      ip: randomIp(),
    });
    return { cookie: t.cookie, organizationId: t.organizationId };
  }

  it('A real invitation expires 48 hours after creation', async () => {
    const { cookie, organizationId } = await tenant();
    const before = Date.now();
    const created = await invite(auth, cookie, organizationId, `bob-${randomUUID()}@example.test`);
    const after = Date.now();
    expect(created.status, 'the admin can create an invitation').toBe(200);

    const row = await findInvitation(db, created.id);
    expect(row?.status).toBe('pending');
    const expiresAt = Number(row?.expires_ms ?? 0);
    expect(expiresAt).toBeGreaterThanOrEqual(before + HOURS_48_MS - TOLERANCE_MS);
    expect(expiresAt).toBeLessThanOrEqual(after + HOURS_48_MS + TOLERANCE_MS);
  });

  it('Re-inviting cancels the previous invitation and creates a new pending one with a fresh 48-hour expiry', async () => {
    const { cookie, organizationId } = await tenant();
    const email = `bob-${randomUUID()}@example.test`;
    const first = await invite(auth, cookie, organizationId, email);
    expect(first.status).toBe(200);

    const before = Date.now();
    const second = await invite(auth, cookie, organizationId, email);
    const after = Date.now();
    expect(second.status, 're-inviting the same email succeeds').toBe(200);
    expect(second.id).not.toBe(first.id);

    const firstRow = await findInvitation(db, first.id);
    expect(firstRow?.status, 'the first invitation is stored as canceled').toBe('canceled');

    const secondRow = await findInvitation(db, second.id);
    expect(secondRow?.status).toBe('pending');
    const expiresAt = Number(secondRow?.expires_ms ?? 0);
    expect(expiresAt).toBeGreaterThanOrEqual(before + HOURS_48_MS - TOLERANCE_MS);
    expect(expiresAt).toBeLessThanOrEqual(after + HOURS_48_MS + TOLERANCE_MS);
  });

  describe('boundary state mapper', () => {
    const now = new Date('2026-10-10T12:00:00.000Z');
    const future = new Date(now.getTime() + 60_000);
    const past = new Date(now.getTime() - 60_000);

    async function mapper(): Promise<
      (invitation: { status: string; expiresAt: Date }, at: Date) => string
    > {
      const mod = (await import('./identity/invitation-state.js')) as {
        toBoundaryInvitationState: (
          invitation: { status: string; expiresAt: Date },
          at: Date,
        ) => string;
      };
      return mod.toBoundaryInvitationState;
    }

    it('maps the stored canceled to cancelled', async () => {
      const map = await mapper();
      expect(map({ status: 'canceled', expiresAt: future }, now)).toBe('cancelled');
    });

    it('derives expired from expiresAt for a pending invitation', async () => {
      const map = await mapper();
      expect(map({ status: 'pending', expiresAt: past }, now)).toBe('expired');
      expect(map({ status: 'pending', expiresAt: now }, now)).toBe('expired');
      expect(map({ status: 'pending', expiresAt: future }, now)).toBe('pending');
    });

    it('keeps accepted, rejected and cancelled as they are even past their expiry', async () => {
      const map = await mapper();
      expect(map({ status: 'accepted', expiresAt: past }, now)).toBe('accepted');
      expect(map({ status: 'rejected', expiresAt: past }, now)).toBe('rejected');
      expect(map({ status: 'canceled', expiresAt: past }, now)).toBe('cancelled');
      expect(map({ status: 'accepted', expiresAt: future }, now)).toBe('accepted');
      expect(map({ status: 'rejected', expiresAt: future }, now)).toBe('rejected');
    });
  });
});
