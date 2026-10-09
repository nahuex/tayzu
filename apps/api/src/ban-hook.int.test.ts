/**
 * Task 4.5 of openspec/changes/043-identity-lifecycle-and-org-admin (design D2,
 * Resolved decisions Q102 and Q117).
 *
 * Spec scenario "The ban hook never re-enables a user":
 *
 * - GIVEN a user who belongs to `t1` and `t2`, disabled in `t1` by an admin of `t1`
 *   and not banned
 * - WHEN the user enrols a second factor from a session of `t2`, or any other update
 *   leaves the user not banned
 * - THEN the user stays `Disabled` in `t1` and `Active` in `t2`, and the hook writes
 *   nothing
 *
 * Task 4.5 Verify: banning sets `Disabled` on every membership, each write emitting one
 * `catalog.audit.user_status_changed` with `admin_disable`, the banned user's id as
 * `tayzu.identity.user.id` and no actor attribute; a repeated `banned: true` for a
 * `Disabled` user is a no-op and emits none; an update with `banned: false` (an unban
 * included) writes nothing and leaves every status as it was; enrolling a second factor
 * for an `Active` user does not throw and leaves the status `Active`; and the two-tenant
 * case above (`Disabled` in `t1` through the adapter with `admin_disable`, not banned,
 * enrolling TOTP from a session of `t2`).
 *
 * ## Harness
 *
 * `createAuth` is built with the real adapter over `createUserSync` (the shape
 * `user-sync.int.test.ts` uses), so Better Auth's `user.update.after` hook is the code
 * under test. Each test uses fresh organizations (the tenants) and fresh users, so
 * tests never touch each other's rows; the audit events are filtered by those ids.
 *
 * ## Production symbols expected
 *
 * Nothing new is imported: the change is inside the `databaseHooks.user.update.after`
 * hook of `createAuth` (`@tayzu/auth`, `packages/auth/src/auth.ts`), which must write
 * `admin_disable` only when `banned === true` and nothing otherwise.
 *
 * ## Why this fails right now
 *
 * The hook writes `admin_enable` whenever `banned === false`. An unban, or a TOTP
 * enrolment of a user who is not banned, therefore revives a `Disabled` `_user`
 * (assertion failures on the status and on the emitted events).
 */
// Load-bearing import order (design D1): the telemetry harness registers before
// anything that loads `@tayzu/auth` creates its logger.
import { registration, type TelemetryTestHarness } from './__fixtures__/link-telemetry.js';
import { randomInt, randomUUID } from 'node:crypto';

import { createAuth, authSchema, type AuthInstance } from '@tayzu/auth';
import { createCerbosClient } from '@tayzu/authz';
import { createUserSync } from '@tayzu/catalog';
import { runMigrations } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { beforeAll, describe, expect, it } from 'vitest';

import { harnessPools } from './__fixtures__/pools.js';
import { createUserSyncAdapter, type UserSyncAdapter } from './identity/user-sync-adapter.js';
import {
  createAdminUser,
  signInAdminUser,
} from '../../../packages/auth/src/__fixtures__/admin-user.js';
import { TEST_SECRET, TEST_PASSWORD } from '../../../packages/auth/src/__fixtures__/test-secret.js';

const EVENT_NAME = 'catalog.audit.user_status_changed';

interface AuthApiSurface {
  createOrganization(args: {
    body: { name: string; slug: string; userId: string };
  }): Promise<{ id: string }>;
  addMember(args: {
    body: { userId: string; organizationId: string; role: string };
  }): Promise<unknown>;
  createUser(args: {
    body: { name: string; email: string; password: string; role: string };
  }): Promise<{ user: { id: string; email: string } }>;
  banUser(args: { body: { userId: string }; headers: Headers }): Promise<unknown>;
  unbanUser(args: { body: { userId: string }; headers: Headers }): Promise<unknown>;
  setActiveOrganization(args: {
    body: { organizationId: string };
    headers: Headers;
  }): Promise<unknown>;
  enableTwoFactor(args: {
    body: { password: string; method: 'totp' };
    headers: Headers;
  }): Promise<{ totpURI: string }>;
  generateTOTP(args: { body: { secret: string } }): Promise<{ code: string }>;
  verifyTOTP(args: { body: { code: string }; headers: Headers }): Promise<unknown>;
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 Base32 decoder (no padding), as `mfa.int.test.ts` uses to recover the raw TOTP secret. */
function decodeBase32(encoded: string): Uint8Array {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of encoded) {
    if (char === '=') break;
    const value = BASE32_ALPHABET.indexOf(char.toUpperCase());
    if (value === -1) throw new Error('invalid base32 character in TOTP secret');
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

function rawSecretFromTotpUri(totpURI: string): string {
  const secret = new URL(totpURI).searchParams.get('secret');
  if (secret === null) throw new Error('expected a secret query parameter on the TOTP URI');
  return new TextDecoder().decode(decodeBase32(secret));
}

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

describe('The ban hook never re-enables a user (task 4.5)', () => {
  let harness: TelemetryTestHarness;
  let auth: AuthInstance;
  let api: AuthApiSurface;
  let adapter: UserSyncAdapter;
  let userSync: ReturnType<typeof createUserSync>;
  let adminHeaders: Headers;

  beforeAll(async () => {
    if ('error' in registration) {
      throw new Error(`createTelemetryTestHarness() failed: ${String(registration.error)}`, {
        cause: registration.error,
      });
    }
    harness = registration.harness;
    const pools = await harnessPools();
    await runMigrations(pools.authPool);
    const cerbos = createCerbosClient({ address: 'localhost:3593', tls: false });
    userSync = createUserSync({ pool: pools.appPool, authz: cerbos });
    adapter = createUserSyncAdapter({ userSync });
    auth = createAuth({
      db: drizzle(pools.authPool, { schema: authSchema }),
      secret: TEST_SECRET,
      userSync: adapter,
    });
    api = auth.api as AuthApiSurface;

    // banUser / unbanUser need an authenticated platform admin.
    const adminEmail = `ban-admin-${randomUUID()}@example.test`;
    await api.createUser({
      body: { name: 'Ban Admin', email: adminEmail, password: TEST_PASSWORD, role: 'admin' },
    });
    const session = await signInAdminUser(auth, {
      email: adminEmail,
      password: TEST_PASSWORD,
      ip: randomIp(),
    });
    adminHeaders = new Headers({ cookie: session.cookie });
  }, 60_000);

  /** An organization (the tenant) with its own owner. */
  async function createOrg(): Promise<string> {
    const id = randomUUID();
    const owner = await createAdminUser(auth, {
      name: 'Ban Owner',
      email: `ban-owner-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    const org = await api.createOrganization({
      body: { name: 'Ban Org', slug: `ban-org-${id}`, userId: owner.userId },
    });
    return org.id;
  }

  /** A user who is a member of every given tenant, so each has an `Active` `_user`. */
  async function createMember(
    tenantIds: readonly string[],
  ): Promise<{ userId: string; email: string }> {
    const member = await createAdminUser(auth, {
      name: 'Ban Member',
      email: `ban-member-${randomUUID()}@example.test`,
      password: TEST_PASSWORD,
    });
    for (const organizationId of tenantIds) {
      await api.addMember({ body: { userId: member.userId, organizationId, role: 'member' } });
    }
    return member;
  }

  async function status(tenantId: string, email: string): Promise<string | undefined> {
    return (await userSync.getUser({ tenantId, email }))?.status;
  }

  /** The `user_status_changed` events about one user, in emission order. */
  async function eventsAbout(userId: string): Promise<readonly Record<string, unknown>[]> {
    await harness.forceFlush();
    return [...harness.logExporter.getFinishedLogRecords()]
      .filter(
        (record) =>
          record.eventName === EVENT_NAME && record.attributes['tayzu.identity.user.id'] === userId,
      )
      .map((record) => ({ ...record.attributes }));
  }

  /** Enrols a TOTP factor from the session cookie (enable, then verify a computed code). */
  async function enrolTotp(cookie: string): Promise<void> {
    const headers = new Headers({ cookie });
    const enabled = await api.enableTwoFactor({
      body: { password: TEST_PASSWORD, method: 'totp' },
      headers,
    });
    const { code } = await api.generateTOTP({
      body: { secret: rawSecretFromTotpUri(enabled.totpURI) },
    });
    await api.verifyTOTP({ body: { code }, headers });
  }

  it('banning sets Disabled on every membership, each write emitting one admin_disable with the user id and no actor attribute', async () => {
    const t1 = await createOrg();
    const t2 = await createOrg();
    const member = await createMember([t1, t2]);
    const before = (await eventsAbout(member.userId)).length;

    await api.banUser({ body: { userId: member.userId }, headers: adminHeaders });

    expect(await status(t1, member.email)).toBe('Disabled');
    expect(await status(t2, member.email)).toBe('Disabled');
    const events = (await eventsAbout(member.userId)).slice(before);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event['tayzu.tenant.id']).sort()).toEqual([t1, t2].sort());
    for (const event of events) {
      expect(event['tayzu.identity.user.status.event']).toBe('admin_disable');
      expect(event['tayzu.identity.user.status.to']).toBe('Disabled');
      expect(event['tayzu.identity.user.id']).toBe(member.userId);
      expect(event).not.toHaveProperty(['tayzu.actor.id']);
      expect(event).not.toHaveProperty(['tayzu.identity.operator.id']);
    }
  }, 60_000);

  it('a repeated banned: true for a Disabled user is a no-op and emits none', async () => {
    const t1 = await createOrg();
    const member = await createMember([t1]);
    await api.banUser({ body: { userId: member.userId }, headers: adminHeaders });
    expect(await status(t1, member.email)).toBe('Disabled');
    const before = (await eventsAbout(member.userId)).length;

    await api.banUser({ body: { userId: member.userId }, headers: adminHeaders });

    expect(await status(t1, member.email)).toBe('Disabled');
    expect((await eventsAbout(member.userId)).length).toBe(before);
  }, 60_000);

  it('an update with banned: false (an unban) writes nothing and leaves every status as it was', async () => {
    const t1 = await createOrg();
    const t2 = await createOrg();
    const member = await createMember([t1, t2]);
    await api.banUser({ body: { userId: member.userId }, headers: adminHeaders });
    const before = (await eventsAbout(member.userId)).length;

    await api.unbanUser({ body: { userId: member.userId }, headers: adminHeaders });

    expect(await status(t1, member.email)).toBe('Disabled');
    expect(await status(t2, member.email)).toBe('Disabled');
    expect((await eventsAbout(member.userId)).length).toBe(before);
  }, 60_000);

  it('an unban of a user who was never banned writes nothing and leaves Active as it was', async () => {
    const t1 = await createOrg();
    const member = await createMember([t1]);
    const before = (await eventsAbout(member.userId)).length;

    await api.unbanUser({ body: { userId: member.userId }, headers: adminHeaders });

    expect(await status(t1, member.email)).toBe('Active');
    expect((await eventsAbout(member.userId)).length).toBe(before);
  }, 60_000);

  it('enrolling a second factor for an Active user does not throw and leaves the status Active', async () => {
    const t1 = await createOrg();
    const member = await createMember([t1]);
    const session = await signInAdminUser(auth, {
      email: member.email,
      password: TEST_PASSWORD,
      ip: randomIp(),
    });
    const before = (await eventsAbout(member.userId)).length;

    await expect(enrolTotp(session.cookie)).resolves.toBeUndefined();

    expect(await status(t1, member.email)).toBe('Active');
    expect((await eventsAbout(member.userId)).length).toBe(before);
  }, 60_000);

  it('a user Disabled in t1 only (not banned) who enrols TOTP from a session of t2 stays Disabled in t1 and Active in t2', async () => {
    const t1 = await createOrg();
    const t2 = await createOrg();
    const member = await createMember([t1, t2]);
    const session = await signInAdminUser(auth, {
      email: member.email,
      password: TEST_PASSWORD,
      ip: randomIp(),
    });
    // What `setStatus` (11.2) does: the status event through the adapter, with no ban.
    await adapter.writeUserChange({
      tenantId: t1,
      email: member.email,
      name: 'Ban Member',
      userId: member.userId,
      change: 'admin_disable',
    });
    expect(await status(t1, member.email), 'precondition: Disabled in t1').toBe('Disabled');
    const before = (await eventsAbout(member.userId)).length;

    // A session of t2: a user with two memberships has no active organization yet.
    await api.setActiveOrganization({
      body: { organizationId: t2 },
      headers: new Headers({ cookie: session.cookie }),
    });
    await enrolTotp(session.cookie);

    expect(await status(t1, member.email)).toBe('Disabled');
    expect(await status(t2, member.email)).toBe('Active');
    expect((await eventsAbout(member.userId)).length, 'the hook wrote nothing').toBe(before);
  }, 60_000);
});
