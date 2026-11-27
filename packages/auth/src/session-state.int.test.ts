/**
 * Integration test for task 3.9 of `openspec/changes/archive/2026-11-27-003-catalog-ui-core` (design D8,
 * Resolved decision Q13; `specs/catalog-ui-core/spec.md`, requirement "The shell knows the
 * caller's session and enforces its gates").
 *
 * Task 3.9 Verify (this file's part): "`packages/auth/src/session-state.int.test.ts` covers
 * the check order (a gated session of a banned user, a disabled `_user` or a tenant pending
 * deletion is rejected, not gated), a comma-separated role, and an owner without a factor
 * gated".
 *
 * Design D8, quoted: "A new export of `@tayzu/auth`, `resolveSessionState(headers)`, does the
 * work, because the checks it needs are private to `context-resolver.ts`. It runs the
 * resolver's own checks in the resolver's order (the markers, 704-717, then the membership,
 * the open tenant and the `_user` state, 719-762) and reuses their helpers instead of copying
 * them, but where `resolveContext` rejects a marker it records the gate and goes on, so that a
 * gated session that would fail a later check is still the uniform `401`. The membership role
 * is read as stored (a comma-separated list is allowed) and reported as the highest of
 * `owner`, `admin` and `member`; the admin-without-factor gate uses the folded role of
 * `toCerbosRole` (336-339), so an owner counts as an admin."
 *
 * And: "A valid session answers `200` with `Cache-Control: no-store`: `{ user: { id, name,
 * email }, organization: { id, name }, role: "owner" | "admin" | "member", signInMethod:
 * "password" | "visma-connect", mfa: { enrolled: boolean }, gate }`, where `gate` is, in this
 * order of precedence: `password_expired` (an expired temporary-password marker),
 * `password_change_required` (an unexpired one), `mfa_enrolment_required` (the re-enrolment
 * marker, or an admin or owner without an enrolled factor, which the catch-all refuses), or
 * `none`. A failed lookup fails closed (`401`). `signInMethod` is `visma-connect` when the
 * session carries an `ssoSid` (`002` D25) and `password` otherwise".
 *
 * ## Assumed API (the red phase; does not exist yet)
 *
 * `resolveSessionState(headers)` needs the Better Auth instance and the `tayzu_app` pool, the
 * same way `resolveContext(headers)` does, so it is built the way `resolveContext` is
 * (`const resolveContext = createContextResolver({ auth, revocationPool })`, the convention
 * `context-resolver.ts`'s own doc comment names):
 *
 * ```ts
 * export type SessionGate =
 *   | 'none'
 *   | 'password_change_required'
 *   | 'password_expired'
 *   | 'mfa_enrolment_required';
 *
 * export interface SessionState {
 *   readonly user: { readonly id: string; readonly name: string; readonly email: string };
 *   readonly organization: { readonly id: string; readonly name: string };
 *   readonly role: 'owner' | 'admin' | 'member';
 *   readonly signInMethod: 'password' | 'visma-connect';
 *   readonly mfa: { readonly enrolled: boolean };
 *   readonly gate: SessionGate;
 * }
 *
 * export type SessionStateResolver = (headers: Headers) => Promise<SessionState>;
 *
 * // Exported from `@tayzu/auth` (`./index.ts`); `options` is `ContextResolverOptions`.
 * export function createSessionStateResolver(options: ContextResolverOptions): SessionStateResolver;
 * ```
 *
 * The resolved value is exactly the body of D8's `200`, so the route sends it as is. Every case
 * D8 answers with the uniform `401` (no session, an idle or expired one, a banned user, a
 * disabled `_user`, a closed tenant, no active organization, a failed lookup) rejects the way
 * `resolveContext` does: with `AuthContextError`, whose `code` is `CATALOG_CONTEXT_REQUIRED`.
 * This file reads the factory off the package namespace, so it type-checks before the export
 * exists, and fails with an explicit message until it does.
 *
 * ## Harness
 *
 * Same as `context-resolver.int.test.ts`: the shared `DATABASE_URL`, `runMigrations`, a
 * `createAuth` instance, the fixture `tayzu_app` pool as `revocationPool`, real session cookies
 * from `auth.handler` sign-ins with a fresh random `x-forwarded-for`, and a fresh tenant and
 * users per test. Markers, bans, `_user` statuses, roles and deletion markers are written
 * directly, standing in for the operations that write them. Each resolution that follows a
 * write uses a new resolver, so no 5-second cache of an earlier read hides the write.
 */
import { randomInt, randomUUID } from 'node:crypto';

// Import order (design D1 of `001`): the harness registers before `./auth.js` creates its
// instruments, as in every other int test file of this package.
import './__fixtures__/registered-harness.js';

import { runMigrations, withTenantTransaction } from '@tayzu/db';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createAdminUser,
  seedUserRow,
  signInAdminUser,
  testAppPool,
} from './__fixtures__/admin-user.js';
import { TEST_SECRET } from './__fixtures__/test-secret.js';
import { createAuth, type AuthInstance } from './auth.js';
import * as authPackage from './index.js';
import * as authSchema from './persistence/schema.js';

type SessionGate =
  'none' | 'password_change_required' | 'password_expired' | 'mfa_enrolment_required';

interface SessionState {
  readonly user: { readonly id: string; readonly name: string; readonly email: string };
  readonly organization: { readonly id: string; readonly name: string };
  readonly role: 'owner' | 'admin' | 'member';
  readonly signInMethod: 'password' | 'visma-connect';
  readonly mfa: { readonly enrolled: boolean };
  readonly gate: SessionGate;
}

type SessionStateResolverFactory = (options: {
  readonly auth: AuthInstance;
  readonly revocationPool: Pool;
}) => (headers: Headers) => Promise<SessionState>;

/** The export under test, read off the package namespace (see the module doc comment). */
function sessionStateResolverFactory(): SessionStateResolverFactory {
  const factory = (authPackage as unknown as Record<string, unknown>)['createSessionStateResolver'];
  if (typeof factory !== 'function') {
    throw new Error('@tayzu/auth does not export createSessionStateResolver (task 3.9, D8)');
  }
  return factory as SessionStateResolverFactory;
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

function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

const TEST_PASSWORD = 'correct horse battery staple';
const SENTINEL = '9999-12-31T23:59:59.000Z';
const HOUR_MS = 60 * 60 * 1000;

type TestDb = ReturnType<typeof drizzle<typeof authSchema>>;

interface MemberApiSurface {
  createOrganization(args: {
    body: { name: string; slug: string; userId: string };
  }): Promise<{ id: string }>;
  addMember(args: {
    body: { userId: string; organizationId: string; role: 'member' | 'admin' };
  }): Promise<unknown>;
}

interface Organization {
  readonly id: string;
  readonly name: string;
}

interface SignedInSubject {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly cookie: string;
  readonly token: string;
}

type Marker = 'temporary_password' | 'expired_temporary_password' | 'mfa_reenrol';

async function expectContextRequired(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code: 'CATALOG_CONTEXT_REQUIRED' });
}

describe('resolveSessionState: the shell view of its own session (003 task 3.9, design D8)', () => {
  let db: TestDb;
  let auth: AuthInstance;
  let api: MemberApiSurface;

  beforeAll(async () => {
    db = drizzle(databaseUrl(), { schema: authSchema });
    await runMigrations(db.$client);
    auth = createAuth({ db, secret: TEST_SECRET });
    api = auth.api as MemberApiSurface;
  }, 60_000);

  afterAll(async () => {
    db.$client.on('error', () => {
      // Expected only during teardown.
    });
    await db.$client.end();
  });

  /** A new resolver, so no cache of an earlier read applies (see the module doc comment). */
  function resolveSessionState(cookie: string): Promise<SessionState> {
    const resolve = sessionStateResolverFactory()({ auth, revocationPool: testAppPool() });
    return resolve(new Headers({ cookie }));
  }

  /** A tenant whose creator (an owner who is never signed in here) has an Active `_user`. */
  async function newOrganization(): Promise<
    Organization & { readonly ownerId: string; readonly ownerEmail: string }
  > {
    const id = randomUUID();
    const name = `Session State Org ${id}`;
    const owner = await createAdminUser(auth, {
      name: 'Session State Owner',
      email: `session-state-owner-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    const organization = await api.createOrganization({
      body: { name, slug: `session-state-${id}`, userId: owner.userId },
    });
    await seedUserRow(testAppPool(), {
      tenantId: organization.id,
      email: owner.email,
      name: 'Session State Owner',
    });
    return { id: organization.id, name, ownerId: owner.userId, ownerEmail: owner.email };
  }

  /** Signs an already-created user in; one membership makes its tenant the active one. */
  async function signIn(
    user: { readonly userId: string; readonly name: string; readonly email: string },
    password = TEST_PASSWORD,
  ): Promise<SignedInSubject> {
    const signedIn = await signInAdminUser(auth, { email: user.email, password, ip: randomIp() });
    return { ...user, cookie: signedIn.cookie, token: signedIn.token };
  }

  /**
   * A new user of `organization`, with the membership `role` as stored (a comma-separated list
   * is written to `auth.member.role` directly, as Better Auth may store it) and an Active
   * `_user`, signed in.
   */
  async function newSubject(organization: Organization, role: string): Promise<SignedInSubject> {
    const id = randomUUID();
    const name = `Session State Subject ${id}`;
    const created = await createAdminUser(auth, {
      name,
      email: `session-state-${id}@example.test`,
      password: TEST_PASSWORD,
    });
    await api.addMember({
      body: {
        userId: created.userId,
        organizationId: organization.id,
        role: role === 'admin' ? 'admin' : 'member',
      },
    });
    if (role !== 'admin' && role !== 'member') {
      await db.execute(sql`
        update auth.member set role = ${role}
         where organization_id = ${organization.id} and user_id = ${created.userId}
      `);
    }
    await seedUserRow(testAppPool(), { tenantId: organization.id, email: created.email, name });
    return signIn({ userId: created.userId, name, email: created.email });
  }

  /** Writes a marker row the way `044` D11 and `043` Q142 store them (sentinel `expiresAt`). */
  async function writeMarker(userId: string, marker: Marker): Promise<void> {
    const identifier =
      marker === 'mfa_reenrol' ? `mfa-reenrol:${userId}` : `temp-password:${userId}`;
    const value =
      marker === 'mfa_reenrol'
        ? 'mfa-reenrol'
        : new Date(
            Date.now() + (marker === 'temporary_password' ? 48 * HOUR_MS : -HOUR_MS),
          ).toISOString();
    await db.execute(sql`
      insert into auth.verification (id, identifier, value, expires_at)
      values (${randomUUID()}, ${identifier}, ${value}, ${SENTINEL}::timestamptz)
    `);
  }

  async function enrolFactor(userId: string): Promise<void> {
    await db.execute(sql`update auth."user" set two_factor_enabled = true where id = ${userId}`);
  }

  async function ban(userId: string): Promise<void> {
    await db.execute(sql`update auth."user" set banned = true where id = ${userId}`);
  }

  async function disableUserRow(tenantId: string, email: string): Promise<void> {
    await withTenantTransaction(testAppPool(), { tenantId }, async (client) => {
      const result = await client.query(
        `update catalog_entity
            set spec_properties = jsonb_set(spec_properties, '{status}', to_jsonb('Disabled'::text))
          where tenant_id = $1 and identifier = $2`,
        [tenantId, email],
      );
      expect(result.rowCount, 'sanity: the _user row exists').toBe(1);
    });
  }

  /** A `pending` deletion marker (`045` D4), written through the owner connection. */
  async function markPendingDeletion(tenantId: string): Promise<void> {
    await db.$client.query(
      `insert into tenant_deletion_marker (tenant_id, purge_after, requested_by, state)
       values ($1, now() + interval '14 days', $2, 'pending')`,
      [tenantId, `usr-${randomUUID()}`],
    );
  }

  describe('the D8 shape', () => {
    it('a member session resolves to the user, the organization, the role, the sign-in method, the factor state and gate none', async () => {
      const organization = await newOrganization();
      const member = await newSubject(organization, 'member');

      const state = await resolveSessionState(member.cookie);

      expect(state).toEqual({
        user: { id: member.userId, name: member.name, email: member.email },
        organization: { id: organization.id, name: organization.name },
        role: 'member',
        signInMethod: 'password',
        mfa: { enrolled: false },
        gate: 'none',
      });
    }, 60_000);

    it('a session that carries an ssoSid reports signInMethod visma-connect', async () => {
      const organization = await newOrganization();
      const member = await newSubject(organization, 'member');
      await db.execute(sql`
        update auth.session set sso_sid = ${`sid-${randomUUID()}`} where token = ${member.token}
      `);

      const state = await resolveSessionState(member.cookie);

      expect(state.signInMethod).toBe('visma-connect');
      expect(state.gate).toBe('none');
    }, 60_000);

    it('no session rejects as CATALOG_CONTEXT_REQUIRED', async () => {
      const resolve = sessionStateResolverFactory()({ auth, revocationPool: testAppPool() });

      await expectContextRequired(resolve(new Headers()));
    });
  });

  /*
   * The check order: the markers first, then the membership, the open tenant and the `_user`
   * state. A marker only records a gate, so a gated session that fails a later check is the
   * uniform rejection, never a gated answer. Each case first proves the session resolves with
   * its gate, then applies the failing check and resolves again with a new resolver.
   */
  describe('the check order: a gated session that fails a later check is rejected, not gated', () => {
    interface GateCase {
      readonly label: string;
      readonly role: 'member' | 'admin';
      readonly marker?: Marker;
      readonly gate: SessionGate;
    }

    const gates: readonly GateCase[] = [
      {
        label: 'an unexpired temporary password',
        role: 'member',
        marker: 'temporary_password',
        gate: 'password_change_required',
      },
      {
        label: 'an expired temporary password',
        role: 'member',
        marker: 'expired_temporary_password',
        gate: 'password_expired',
      },
      {
        label: 'the re-enrolment marker',
        role: 'member',
        marker: 'mfa_reenrol',
        gate: 'mfa_enrolment_required',
      },
      { label: 'an admin without a factor', role: 'admin', gate: 'mfa_enrolment_required' },
    ];

    const rejections = [
      {
        label: 'a banned user',
        apply: (subject: SignedInSubject): Promise<void> => ban(subject.userId),
      },
      {
        label: 'a disabled _user',
        apply: (subject: SignedInSubject, organization: Organization): Promise<void> =>
          disableUserRow(organization.id, subject.email),
      },
      {
        label: 'a tenant pending deletion',
        apply: (_subject: SignedInSubject, organization: Organization): Promise<void> =>
          markPendingDeletion(organization.id),
      },
    ] as const;

    const cases = gates.flatMap((gate) =>
      rejections.map(
        (rejection) => [`${gate.label}, ${rejection.label}`, gate, rejection] as const,
      ),
    );

    it.each(cases)(
      '%s: rejected as CATALOG_CONTEXT_REQUIRED',
      async (_label, gate, rejection) => {
        const organization = await newOrganization();
        const subject = await newSubject(organization, gate.role);
        if (gate.marker !== undefined) {
          await writeMarker(subject.userId, gate.marker);
        }
        const gated = await resolveSessionState(subject.cookie);
        expect(gated.gate, 'precondition: the session is gated').toBe(gate.gate);

        await rejection.apply(subject, organization);

        await expectContextRequired(resolveSessionState(subject.cookie));
      },
      60_000,
    );
  });

  describe('the role is read as stored and reported as the highest of owner, admin and member', () => {
    it.each([
      ['member,admin', 'admin'],
      ['admin,owner', 'owner'],
      ['owner,member', 'owner'],
      ['member', 'member'],
    ] as const)(
      'a membership stored as %s is reported as %s, and gated by the folded role of toCerbosRole without a factor',
      async (stored, reported) => {
        const organization = await newOrganization();
        const subject = await newSubject(organization, stored);

        const state = await resolveSessionState(subject.cookie);

        expect(state.role).toBe(reported);
        expect(state.mfa).toEqual({ enrolled: false });
        expect(state.gate).toBe(reported === 'member' ? 'none' : 'mfa_enrolment_required');
      },
      60_000,
    );

    it('a comma-separated admin role with an enrolled factor is not gated', async () => {
      const organization = await newOrganization();
      const subject = await newSubject(organization, 'member,admin');
      await enrolFactor(subject.userId);

      const state = await resolveSessionState(subject.cookie);

      expect(state.role).toBe('admin');
      expect(state.mfa).toEqual({ enrolled: true });
      expect(state.gate).toBe('none');
    }, 60_000);
  });

  describe('an owner counts as an admin for the admin-without-factor gate', () => {
    it('an owner without a factor is gated mfa_enrolment_required', async () => {
      const organization = await newOrganization();
      const owner = await signIn({
        userId: organization.ownerId,
        name: 'Session State Owner',
        email: organization.ownerEmail,
      });

      const state = await resolveSessionState(owner.cookie);

      expect(state).toEqual({
        user: { id: owner.userId, name: owner.name, email: owner.email },
        organization: { id: organization.id, name: organization.name },
        role: 'owner',
        signInMethod: 'password',
        mfa: { enrolled: false },
        gate: 'mfa_enrolment_required',
      });
    }, 60_000);

    it('an owner with an enrolled factor is not gated', async () => {
      const organization = await newOrganization();
      const owner = await signIn({
        userId: organization.ownerId,
        name: 'Session State Owner',
        email: organization.ownerEmail,
      });
      await enrolFactor(owner.userId);

      const state = await resolveSessionState(owner.cookie);

      expect(state.role).toBe('owner');
      expect(state.mfa).toEqual({ enrolled: true });
      expect(state.gate).toBe('none');
    }, 60_000);
  });
});
