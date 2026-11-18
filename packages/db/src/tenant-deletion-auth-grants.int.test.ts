/**
 * Integration test for task 2.3 of 045-org-deletion-and-data-retention
 * (migration `0014_tenant_deletion_auth_grants`, Checkpoint 3): the Better
 * Auth side of the deletion access model (design D1 and D2, Resolved
 * decisions Q49, Q59, Q65, Q150 and Q151).
 *
 * Every role acts through the harness's own pools (`harness.ts`):
 * `getPurgeTestDatabase()` runs as `tayzu_purge`, `getAuthTestDatabase()` as
 * `tayzu_auth`. `getOwnerPool()` is the raw `DATABASE_URL` role, which
 * bypasses row-level security and inherits the table owner's privileges: it
 * seeds the markers (a due marker needs a `requested_at` in the past) and the
 * Better Auth rows, and reads back what really happened.
 *
 * The tenant id is the organization id (`auth.organization.id`), so a marker
 * for a tenant is a marker for the organization of the same id.
 *
 * A refusal is an error with SQLSTATE 42501 (privilege or row-level
 * security) or P0001, or a statement that touches no row; in every case the
 * rows are read back through the owner pool to prove that nothing changed.
 * Each refusal case also asserts a precondition that holds only once the
 * migration exists (`USAGE` on `auth`, the grant, or a sibling row the purge
 * role can delete), so that a refusal is never satisfied merely by the purge
 * role having no access to the schema at all.
 *
 * Every id, email, slug, token and key is random per run (the shared
 * database keeps rows between runs), and nothing is truncated.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';

import { getAuthTestDatabase, getOwnerPool, getPurgeTestDatabase } from './harness.js';

const PURGE_ROLE = 'tayzu_purge';

/** The Better Auth tables purge step 2 deletes from, named one by one (task 2.3). */
const AUTH_TABLES = [
  'organization',
  'member',
  'invitation',
  'apikey',
  'session',
  'user',
  'account',
  'two_factor',
  'verification',
] as const;

type AuthTable = (typeof AUTH_TABLES)[number];

const ALL_TABLE_PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
] as const;

/** SQLSTATEs that count as a refusal: privilege or RLS (42501), a raised exception (P0001). */
const REFUSAL_CODES = ['42501', 'P0001'];

/** The identifier families of `auth.verification` (design D1, D2, Q150). */
const family = {
  invitationAccept: (invitationId: string) => `invitation-accept:${invitationId}`,
  invitationShed: (invitationId: string) => `invitation-shed:${invitationId}`,
  stepUpVerified: (sessionToken: string) => `step-up-verified:${sessionToken}`,
  tempPassword: (userId: string) => `temp-password:${userId}`,
  mfaReenrol: (userId: string) => `mfa-reenrol:${userId}`,
  ssoLink: (accountId: string) => `sso-link:${accountId}`,
  passwordReset: (id: string) => `password-reset:${id}`,
};

/** `auth."<table>"`; `table` is always one of the fixed `AUTH_TABLES` literals. */
function qualified(table: AuthTable): string {
  return `auth."${table}"`;
}

function randomToken(): string {
  return randomBytes(24).toString('hex');
}

async function purgePool(): Promise<Pool> {
  return (await getPurgeTestDatabase()).pool;
}

async function authPool(): Promise<Pool> {
  return (await getAuthTestDatabase()).pool;
}

/** Runs `fn` in one transaction; commits on success, rolls back and rethrows on error. */
async function transaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    try {
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  } finally {
    client.release();
  }
}

function sqlState(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

interface Outcome {
  /** SQLSTATE of the refusal, or `undefined` when the statement ran. */
  readonly code: string | undefined;
  readonly rowCount: number;
  readonly rows: Record<string, unknown>[];
}

/**
 * Runs one statement in its own transaction and reports its outcome. A
 * database error becomes `code`; any other error (a bug in this test) is
 * rethrown.
 */
async function attempt(pool: Pool, statement: string, params: unknown[] = []): Promise<Outcome> {
  try {
    return await transaction(pool, async (client) => {
      const result = await client.query<Record<string, unknown>>(statement, params);
      return { code: undefined, rowCount: result.rowCount ?? 0, rows: result.rows };
    });
  } catch (error) {
    const code = sqlState(error);
    if (code === undefined) {
      throw error;
    }
    return { code, rowCount: 0, rows: [] };
  }
}

/** Refused by a privilege or a policy: a refusal SQLSTATE, or no row touched. */
function expectRefused(outcome: Outcome, label: string): void {
  if (outcome.code === undefined) {
    expect(outcome.rowCount, `${label}: touches no row`).toBe(0);
  } else {
    expect(REFUSAL_CODES, `${label}: refused with SQLSTATE ${outcome.code}`).toContain(
      outcome.code,
    );
  }
}

/** One Better Auth row, by table and primary key. */
interface AuthRow {
  readonly table: AuthTable;
  readonly id: string;
  readonly label: string;
}

function deleteById(table: AuthTable): string {
  return `delete from ${qualified(table)} where id = $1`;
}

/** The ids among `ids` still present in `table`, read through the owner pool. */
async function ownerIds(table: AuthTable, ids: readonly string[]): Promise<string[]> {
  const owner = await getOwnerPool();
  const { rows } = await owner.query<{ id: string }>(
    `select id from ${qualified(table)} where id = any($1::text[]) order by id`,
    [[...ids]],
  );
  return rows.map((row) => row.id);
}

async function expectPresent(rows: readonly AuthRow[], label: string): Promise<void> {
  for (const row of rows) {
    expect(await ownerIds(row.table, [row.id]), `${label}: ${row.label} is intact`).toEqual([
      row.id,
    ]);
  }
}

async function expectGone(rows: readonly AuthRow[], label: string): Promise<void> {
  for (const row of rows) {
    expect(await ownerIds(row.table, [row.id]), `${label}: ${row.label} is gone`).toEqual([]);
  }
}

/** Attempts, as `tayzu_purge`, to delete each row by id; every attempt must be refused. */
async function expectPurgeCannotDelete(rows: readonly AuthRow[], label: string): Promise<void> {
  const purge = await purgePool();
  for (const row of rows) {
    expectRefused(await attempt(purge, deleteById(row.table), [row.id]), `${label}: ${row.label}`);
  }
  await expectPresent(rows, label);
}

// ---------------------------------------------------------------------------
// Privilege inspection, through the owner pool.

async function tablePrivileges(role: string, table: string): Promise<string[]> {
  const owner = await getOwnerPool();
  const granted: string[] = [];
  for (const privilege of ALL_TABLE_PRIVILEGES) {
    const { rows } = await owner.query<{ granted: boolean }>(
      'select has_table_privilege($1, $2, $3) as granted',
      [role, table, privilege],
    );
    if (rows[0]?.granted === true) {
      granted.push(privilege);
    }
  }
  return granted.sort();
}

/** The table-level privileges granted to `role` itself (not through PUBLIC) in the table's ACL. */
async function explicitGrants(role: string, table: string): Promise<string[]> {
  const owner = await getOwnerPool();
  const { rows } = await owner.query<{ privilege: string }>(
    `select acl.privilege_type::text as privilege
       from pg_class c, aclexplode(c.relacl) acl
      where c.oid = $2::regclass
        and acl.grantee = (select oid from pg_roles where rolname = $1)
      order by 1`,
    [role, table],
  );
  return rows.map((row) => row.privilege);
}

async function schemaPrivileges(
  role: string,
  schema: string,
): Promise<{ usage: boolean; create: boolean }> {
  const owner = await getOwnerPool();
  const { rows } = await owner.query<{ usage: boolean; create: boolean }>(
    `select has_schema_privilege($1, $2, 'USAGE') as usage,
            has_schema_privilege($1, $2, 'CREATE') as create`,
    [role, schema],
  );
  return rows[0] ?? { usage: false, create: false };
}

async function expectPurgeHasAuthUsage(): Promise<void> {
  expect(
    (await schemaPrivileges(PURGE_ROLE, 'auth')).usage,
    'tayzu_purge has USAGE on schema auth (migration 0014)',
  ).toBe(true);
}

async function expectPurgeGrantedOnAuthTables(): Promise<void> {
  await expectPurgeHasAuthUsage();
  for (const table of AUTH_TABLES) {
    expect(await tablePrivileges(PURGE_ROLE, qualified(table)), `grant on auth.${table}`).toEqual([
      'DELETE',
      'SELECT',
    ]);
  }
}

async function rowSecurityEnabled(table: AuthTable): Promise<boolean> {
  const owner = await getOwnerPool();
  const { rows } = await owner.query<{ enabled: boolean }>(
    'select relrowsecurity as enabled from pg_class where oid = $1::regclass',
    [qualified(table)],
  );
  return rows[0]?.enabled === true;
}

// ---------------------------------------------------------------------------
// Seeding, through the owner pool. Every value is random per run.

type MarkerState = 'pending' | 'cancelled' | 'purged';

interface MarkerSeed {
  readonly state: MarkerState;
  /** `purge_after` one day in the past (due) or fourteen days ahead. */
  readonly due: boolean;
}

/** Same shape as `tenant-deletion-grants.int.test.ts`: inside the `CHECK` window. */
async function seedMarker(tenantId: string, seed: MarkerSeed): Promise<void> {
  const owner = await getOwnerPool();
  const purged = seed.state === 'purged';
  await owner.query(
    `insert into tenant_deletion_marker
       (tenant_id, requested_at, purge_after, requested_by, state,
        catalog_purged_at, auth_purged_at, cancelled_at, cancelled_by)
     values ($1,
             now() - make_interval(days => $2::int),
             now() - make_interval(days => $2::int) + make_interval(days => 14),
             $3, $4::text,
             case when $5::boolean then now() - interval '1 hour' end,
             case when $5::boolean then now() - interval '1 hour' end,
             case when $4::text = 'cancelled' then now() - interval '1 hour' end,
             case when $4::text = 'cancelled' then $6::text end)`,
    [
      tenantId,
      seed.due ? 15 : 0,
      `actor-${randomUUID()}`,
      seed.state,
      purged,
      `gh:${String(Math.floor(Math.random() * 1_000_000_000))}`,
    ],
  );
}

async function ownerQuery(statement: string, params: unknown[]): Promise<void> {
  const owner = await getOwnerPool();
  await owner.query(statement, params);
}

async function seedOrganization(): Promise<string> {
  const id = `org-${randomUUID()}`;
  await ownerQuery(
    'insert into auth.organization (id, name, slug, created_at) values ($1, $2, $3, now())',
    [id, 'Org', `slug-${id}`],
  );
  return id;
}

async function seedUser(): Promise<string> {
  const id = `user-${randomUUID()}`;
  await ownerQuery(
    `insert into auth."user" (id, name, email, email_verified, created_at, updated_at)
     values ($1, 'User', $2, true, now(), now())`,
    [id, `${id}@example.test`],
  );
  return id;
}

async function seedMember(organizationId: string, userId: string): Promise<string> {
  const id = `member-${randomUUID()}`;
  await ownerQuery(
    `insert into auth.member (id, organization_id, user_id, role, created_at)
     values ($1, $2, $3, 'member', now())`,
    [id, organizationId, userId],
  );
  return id;
}

interface SeededSession {
  readonly id: string;
  readonly token: string;
}

async function seedSession(
  userId: string,
  activeOrganizationId: string | null,
): Promise<SeededSession> {
  const id = `session-${randomUUID()}`;
  const token = randomToken();
  await ownerQuery(
    `insert into auth.session (id, expires_at, token, created_at, updated_at, user_id, active_organization_id)
     values ($1, now() + interval '1 day', $2, now(), now(), $3, $4)`,
    [id, token, userId, activeOrganizationId],
  );
  return { id, token };
}

async function seedAccount(userId: string): Promise<string> {
  const id = `account-${randomUUID()}`;
  await ownerQuery(
    `insert into auth.account (id, account_id, provider_id, user_id, created_at, updated_at)
     values ($1, $2, 'visma-connect', $3, now(), now())`,
    [id, `subject-${randomUUID()}`, userId],
  );
  return id;
}

async function seedTwoFactor(userId: string): Promise<string> {
  const id = `two-factor-${randomUUID()}`;
  await ownerQuery(
    'insert into auth.two_factor (id, secret, backup_codes, user_id) values ($1, $2, $3, $4)',
    [id, randomToken(), randomToken(), userId],
  );
  return id;
}

async function seedInvitation(organizationId: string, inviterId: string): Promise<string> {
  const id = `invitation-${randomUUID()}`;
  await ownerQuery(
    `insert into auth.invitation (id, organization_id, email, role, status, expires_at, created_at, inviter_id)
     values ($1, $2, $3, 'member', 'pending', now() + interval '7 days', now(), $4)`,
    [id, organizationId, `invitee-${randomUUID()}@example.test`, inviterId],
  );
  return id;
}

async function seedApiKey(organizationId: string): Promise<string> {
  const id = `apikey-${randomUUID()}`;
  await ownerQuery(
    `insert into auth.apikey (id, name, reference_id, key, config_id, created_at, updated_at)
     values ($1, 'key', $2, $3, 'default', now(), now())`,
    [id, organizationId, randomToken()],
  );
  return id;
}

/** `farFuture` matches the `mfa-reenrol:` and `sso-link:` markers, which never expire. */
async function seedVerification(
  identifier: string,
  value: string,
  farFuture = false,
): Promise<string> {
  const id = `verification-${randomUUID()}`;
  await ownerQuery(
    `insert into auth.verification (id, identifier, value, expires_at, created_at, updated_at)
     values ($1, $2, $3,
             case when $4::boolean then timestamptz '9999-12-31 23:59:59+00'
                  else now() + interval '30 minutes' end,
             now(), now())`,
    [id, identifier, value, farFuture],
  );
  return id;
}

/**
 * The user-keyed rows of `userId`, in the order step 2 deletes them (the
 * verification rows first, because their policies join the user, the
 * account and the session; the user last). The session has no active
 * organization, so only the user predicate can admit it.
 */
async function seedUserRows(userId: string): Promise<AuthRow[]> {
  const accountId = await seedAccount(userId);
  const twoFactorId = await seedTwoFactor(userId);
  const session = await seedSession(userId, null);
  return [
    {
      table: 'verification',
      id: await seedVerification(family.tempPassword(userId), randomToken()),
      label: 'temp-password:<userId>',
    },
    {
      table: 'verification',
      id: await seedVerification(family.mfaReenrol(userId), 'reset', true),
      label: 'mfa-reenrol:<userId>',
    },
    {
      table: 'verification',
      id: await seedVerification(family.ssoLink(accountId), userId, true),
      label: 'sso-link:<accountId>',
    },
    {
      table: 'verification',
      id: await seedVerification(family.stepUpVerified(session.token), 'mfa'),
      label: 'step-up-verified:<sessionToken>',
    },
    { table: 'session', id: session.id, label: 'session' },
    { table: 'account', id: accountId, label: 'account' },
    { table: 'two_factor', id: twoFactorId, label: 'two_factor' },
    { table: 'user', id: userId, label: 'user' },
  ];
}

/**
 * A sole member of a due tenant, with one `temp-password:` row: the control
 * that shows the user predicate admits the purge role at all.
 */
async function seedDueControlUser(dueTenantId: string): Promise<AuthRow> {
  const userId = await seedUser();
  await seedMember(dueTenantId, userId);
  return {
    table: 'verification',
    id: await seedVerification(family.tempPassword(userId), randomToken()),
    label: 'control temp-password:<userId> of a sole member of a due tenant',
  };
}

async function expectPurgeDeletesControl(control: AuthRow): Promise<void> {
  const purge = await purgePool();
  expect(
    await attempt(purge, deleteById(control.table), [control.id]),
    `${control.label} is deleted by tayzu_purge`,
  ).toMatchObject({ code: undefined, rowCount: 1 });
  await expectGone([control], 'control');
}

// ---------------------------------------------------------------------------

describe('tayzu_purge on the Better Auth tables (migration 0014, task 2.3)', () => {
  it('tayzu_purge has USAGE on schema auth and no CREATE on it', async () => {
    expect(await schemaPrivileges(PURGE_ROLE, 'auth')).toEqual({ usage: true, create: false });
  });

  it('each of the nine tables has row-level security and its own explicit GRANT SELECT, DELETE to tayzu_purge', async () => {
    for (const table of AUTH_TABLES) {
      expect(await rowSecurityEnabled(table), `auth.${table} has row-level security`).toBe(true);
      expect(
        await explicitGrants(PURGE_ROLE, qualified(table)),
        `explicit grant on auth.${table}`,
      ).toEqual(['DELETE', 'SELECT']);
      expect(
        await tablePrivileges(PURGE_ROLE, qualified(table)),
        `privileges on auth.${table}`,
      ).toEqual(['DELETE', 'SELECT']);
    }
  });

  it('tayzu_purge cannot touch any other auth table (jwks, rate_limit and any later one)', async () => {
    await expectPurgeHasAuthUsage();
    const owner = await getOwnerPool();
    const { rows } = await owner.query<{ name: string }>(
      `select c.relname::text as name
         from pg_class c
        where c.relnamespace = 'auth'::regnamespace
          and c.relkind in ('r', 'p', 'v', 'm', 'f')
          and c.relname <> all($1::text[])
        order by 1`,
      [[...AUTH_TABLES]],
    );
    const others = rows.map((row) => row.name);
    expect(others, 'the other auth tables include jwks and rate_limit').toEqual(
      expect.arrayContaining(['jwks', 'rate_limit']),
    );
    for (const name of others) {
      const table = `auth."${name}"`;
      expect(await tablePrivileges(PURGE_ROLE, table), `table privileges on ${table}`).toEqual([]);
      const columns = await owner.query<{ any: boolean }>(
        `select has_any_column_privilege($1, $2, 'SELECT')
             or has_any_column_privilege($1, $2, 'INSERT')
             or has_any_column_privilege($1, $2, 'UPDATE')
             or has_any_column_privilege($1, $2, 'REFERENCES') as any`,
        [PURGE_ROLE, table],
      );
      expect(columns.rows, `column privileges on ${table}`).toEqual([{ any: false }]);
    }
    const sequences = await owner.query<{ name: string }>(
      `select c.relname::text as name
         from pg_class c
        where c.relnamespace = 'auth'::regnamespace and c.relkind = 'S'
          and (has_sequence_privilege($1, c.oid, 'USAGE')
               or has_sequence_privilege($1, c.oid, 'SELECT')
               or has_sequence_privilege($1, c.oid, 'UPDATE'))`,
      [PURGE_ROLE],
    );
    expect(sequences.rows, 'no auth sequence privilege').toEqual([]);
  });

  it('tayzu_purge deletes the Better Auth rows of a due tenant and of a user whose memberships are all in due tenants, and the verification rows by family (mfa-reenrol: and invitation-shed: included)', async () => {
    const due = await seedOrganization();
    await seedMarker(due, { state: 'pending', due: true });
    const notDue = await seedOrganization();

    // A sole member of the due tenant: every user-keyed row goes.
    const leaving = await seedUser();
    const leavingMember = await seedMember(due, leaving);
    const leavingRows = await seedUserRows(leaving);
    const leavingActive = await seedSession(leaving, due);
    const leavingActiveStepUp = await seedVerification(
      family.stepUpVerified(leavingActive.token),
      'password',
    );

    // A user who stays (also a member of a tenant that is not due): only the
    // org-keyed rows of the due tenant go.
    const staying = await seedUser();
    const stayingDueMember = await seedMember(due, staying);
    const stayingOtherMember = await seedMember(notDue, staying);
    const stayingDueSession = await seedSession(staying, due);
    const stayingDueStepUp = await seedVerification(
      family.stepUpVerified(stayingDueSession.token),
      'mfa',
    );
    const stayingOtherSession = await seedSession(staying, notDue);

    const invitation = await seedInvitation(due, leaving);
    const invitationAccept = await seedVerification(family.invitationAccept(invitation), 'token');
    const invitationShed = await seedVerification(
      family.invitationShed(invitation),
      stayingDueSession.id,
    );
    const apiKey = await seedApiKey(due);

    const purge = await purgePool();
    const steps: [string, string, unknown[]][] = [
      // The org's invitation tokens and shed records, before the invitations.
      ['invitation-accept:<invitationId>', deleteById('verification'), [invitationAccept]],
      ['invitation-shed:<invitationId>', deleteById('verification'), [invitationShed]],
      ['invitation', deleteById('invitation'), [invitation]],
      ['apikey by reference_id', 'delete from auth.apikey where reference_id = $1', [due]],
      // The leaving user, while its membership still exists: the
      // verification rows first, then the user-keyed rows, the user last.
      ...leavingRows
        .filter((row) => row.table === 'verification')
        .map((row): [string, string, unknown[]] => [row.label, deleteById(row.table), [row.id]]),
      [
        'step-up-verified:<sessionToken> of an active-org session',
        deleteById('verification'),
        [leavingActiveStepUp],
      ],
      ['sessions by user_id', 'delete from auth.session where user_id = $1', [leaving]],
      ['account by user_id', 'delete from auth.account where user_id = $1', [leaving]],
      ['two_factor by user_id', 'delete from auth.two_factor where user_id = $1', [leaving]],
      ['user', deleteById('user'), [leaving]],
      // The sessions of users who stay, by active_organization_id, after
      // their step-up markers.
      [
        'step-up-verified:<sessionToken> of a staying user',
        deleteById('verification'),
        [stayingDueStepUp],
      ],
      [
        'sessions by active_organization_id',
        'delete from auth.session where active_organization_id = $1',
        [due],
      ],
      ['members', 'delete from auth.member where organization_id = $1', [due]],
      ['organization', deleteById('organization'), [due]],
    ];

    const outcomes: Record<string, { code: string | undefined; rowCount: number }> = {};
    for (const [label, statement, params] of steps) {
      const { code, rowCount } = await attempt(purge, statement, params);
      outcomes[label] = { code, rowCount };
    }

    const ok = (rowCount: number) => ({ code: undefined, rowCount });
    expect(outcomes).toEqual({
      'invitation-accept:<invitationId>': ok(1),
      'invitation-shed:<invitationId>': ok(1),
      invitation: ok(1),
      'apikey by reference_id': ok(1),
      'temp-password:<userId>': ok(1),
      'mfa-reenrol:<userId>': ok(1),
      'sso-link:<accountId>': ok(1),
      'step-up-verified:<sessionToken>': ok(1),
      'step-up-verified:<sessionToken> of an active-org session': ok(1),
      'sessions by user_id': ok(2),
      'account by user_id': ok(1),
      'two_factor by user_id': ok(1),
      user: ok(1),
      'step-up-verified:<sessionToken> of a staying user': ok(1),
      'sessions by active_organization_id': ok(1),
      // The leaving user's membership went with the user (ON DELETE CASCADE).
      members: ok(1),
      organization: ok(1),
    });

    await expectGone(
      [
        ...leavingRows,
        { table: 'member', id: leavingMember, label: 'membership of the leaving user' },
        { table: 'session', id: leavingActive.id, label: 'active-org session of the leaving user' },
        { table: 'verification', id: leavingActiveStepUp, label: 'its step-up marker' },
        { table: 'member', id: stayingDueMember, label: 'due membership of the staying user' },
        { table: 'session', id: stayingDueSession.id, label: 'due session of the staying user' },
        { table: 'verification', id: stayingDueStepUp, label: 'its step-up marker' },
        { table: 'invitation', id: invitation, label: 'invitation' },
        { table: 'verification', id: invitationAccept, label: 'invitation-accept:' },
        { table: 'verification', id: invitationShed, label: 'invitation-shed:' },
        { table: 'apikey', id: apiKey, label: 'apikey' },
        { table: 'organization', id: due, label: 'organization' },
      ],
      'due tenant',
    );
    await expectPresent(
      [
        { table: 'user', id: staying, label: 'the staying user' },
        { table: 'member', id: stayingOtherMember, label: 'its other membership' },
        { table: 'session', id: stayingOtherSession.id, label: 'its other-tenant session' },
        { table: 'organization', id: notDue, label: 'the tenant that is not due' },
      ],
      'tenant that is not due',
    );
  });

  it('tayzu_purge cannot read or delete a password-reset: row, even one naming a due user in its value', async () => {
    const due = await seedOrganization();
    await seedMarker(due, { state: 'pending', due: true });
    const userId = await seedUser();
    await seedMember(due, userId);
    const control: AuthRow = {
      table: 'verification',
      id: await seedVerification(family.tempPassword(userId), randomToken()),
      label: 'control temp-password:<userId>',
    };
    const resetId = randomUUID();
    const reset: AuthRow = {
      table: 'verification',
      // `044`'s reset row: a random id, a digest and the user id in `value`.
      id: await seedVerification(
        family.passwordReset(resetId),
        `${randomToken()}:${String(Date.now())}:${userId}`,
      ),
      label: 'password-reset:<id>',
    };

    const purge = await purgePool();
    const read = await attempt(
      purge,
      'select id from auth.verification where id = any($1::text[])',
      [[control.id, reset.id]],
    );
    expect(read, 'tayzu_purge reads the control row and not the password-reset: row').toEqual({
      code: undefined,
      rowCount: 1,
      rows: [{ id: control.id }],
    });

    expectRefused(
      await attempt(purge, deleteById('verification'), [reset.id]),
      'delete password-reset: by id',
    );
    expectRefused(
      await attempt(purge, 'delete from auth.verification where identifier = $1', [
        family.passwordReset(resetId),
      ]),
      'delete password-reset: by identifier',
    );
    expectRefused(
      await attempt(
        purge,
        `delete from auth.verification
          where identifier like 'password-reset:%' and split_part(value, ':', 3) = $1`,
        [userId],
      ),
      "delete the user's password-reset: rows by value",
    );
    await expectPresent([reset], 'password-reset:');
    await expectPurgeDeletesControl(control);
  });

  it('tayzu_purge cannot read or delete any auth.rate_limit row', async () => {
    await expectPurgeHasAuthUsage();
    expect(await tablePrivileges(PURGE_ROLE, 'auth.rate_limit'), 'no grant (Q151)').toEqual([]);

    const owner = await getOwnerPool();
    const id = `rate-limit-${randomUUID()}`;
    await owner.query(
      'insert into auth.rate_limit (id, key, count, last_request) values ($1, $2, 1, now())',
      [id, randomBytes(32).toString('hex')],
    );

    const purge = await purgePool();
    const read = await attempt(purge, 'select id from auth.rate_limit where id = $1', [id]);
    expect(REFUSAL_CODES, `read refused with SQLSTATE ${String(read.code)}`).toContain(read.code);
    expectRefused(
      await attempt(purge, 'delete from auth.rate_limit where id = $1', [id]),
      'delete',
    );
    expectRefused(await attempt(purge, 'delete from auth.rate_limit'), 'delete every row');

    const { rows } = await owner.query<{ count: number }>(
      'select count(*)::int as count from auth.rate_limit where id = $1',
      [id],
    );
    expect(rows, 'the rate_limit row is intact').toEqual([{ count: 1 }]);
  });

  it('tayzu_purge can read but not delete a member row of a tenant that is not due', async () => {
    const tenants = {
      'no marker': await seedOrganization(),
      'a pending marker not yet due': await seedOrganization(),
    };
    await seedMarker(tenants['a pending marker not yet due'], { state: 'pending', due: false });

    const purge = await purgePool();
    for (const [label, tenantId] of Object.entries(tenants)) {
      const userId = await seedUser();
      const memberId = await seedMember(tenantId, userId);

      const read = await attempt(
        purge,
        'select id, organization_id, user_id from auth.member where id = $1',
        [memberId],
      );
      expect(read, `${label}: the member row is readable`).toEqual({
        code: undefined,
        rowCount: 1,
        rows: [{ id: memberId, organization_id: tenantId, user_id: userId }],
      });

      expectRefused(await attempt(purge, deleteById('member'), [memberId]), `${label}: delete`);
      expectRefused(
        await attempt(purge, 'delete from auth.member where organization_id = $1', [tenantId]),
        `${label}: delete by organization_id`,
      );
      await expectPresent([{ table: 'member', id: memberId, label: 'member' }], label);
    }
  });

  it('tayzu_purge cannot delete the rows of a tenant that is not due', async () => {
    await expectPurgeGrantedOnAuthTables();
    const tenants = {
      'no marker': await seedOrganization(),
      'a pending marker not yet due': await seedOrganization(),
      'a cancelled marker': await seedOrganization(),
      'a purged marker': await seedOrganization(),
    };
    await seedMarker(tenants['a pending marker not yet due'], { state: 'pending', due: false });
    await seedMarker(tenants['a cancelled marker'], { state: 'cancelled', due: true });
    await seedMarker(tenants['a purged marker'], { state: 'purged', due: true });

    for (const [label, tenantId] of Object.entries(tenants)) {
      const userId = await seedUser();
      const memberId = await seedMember(tenantId, userId);
      const userRows = await seedUserRows(userId);
      const session = await seedSession(userId, tenantId);
      const invitation = await seedInvitation(tenantId, userId);
      const rows: AuthRow[] = [
        {
          table: 'verification',
          id: await seedVerification(family.invitationAccept(invitation), 'token'),
          label: 'invitation-accept:<invitationId>',
        },
        {
          table: 'verification',
          id: await seedVerification(family.invitationShed(invitation), session.id),
          label: 'invitation-shed:<invitationId>',
        },
        {
          table: 'verification',
          id: await seedVerification(family.stepUpVerified(session.token), 'mfa'),
          label: 'step-up-verified:<sessionToken> of an active-org session',
        },
        { table: 'invitation', id: invitation, label: 'invitation' },
        { table: 'apikey', id: await seedApiKey(tenantId), label: 'apikey' },
        { table: 'session', id: session.id, label: 'session by active_organization_id' },
        ...userRows,
        { table: 'member', id: memberId, label: 'member' },
        { table: 'organization', id: tenantId, label: 'organization' },
      ];
      await expectPurgeCannotDelete(rows, label);
    }
  });

  it('tayzu_purge cannot delete the rows of a user who also belongs to a tenant that is not due (the predicate sees the other membership)', async () => {
    const due = await seedOrganization();
    await seedMarker(due, { state: 'pending', due: true });
    const notDue = await seedOrganization();
    await seedMarker(notDue, { state: 'pending', due: false });
    const control = await seedDueControlUser(due);

    const userId = await seedUser();
    const dueMember = await seedMember(due, userId);
    const otherMember = await seedMember(notDue, userId);
    const userRows = await seedUserRows(userId);

    const purge = await purgePool();
    const memberships = await attempt(
      purge,
      'select id from auth.member where user_id = $1 order by id',
      [userId],
    );
    expect(memberships.rows, 'tayzu_purge sees both memberships').toEqual(
      [{ id: dueMember }, { id: otherMember }].sort((a, b) => a.id.localeCompare(b.id)),
    );

    await expectPurgeCannotDelete(userRows, 'user with a membership in a tenant that is not due');
    await expectPurgeDeletesControl(control);
  });

  it('tayzu_purge cannot delete the rows of a user with no membership', async () => {
    const due = await seedOrganization();
    await seedMarker(due, { state: 'pending', due: true });
    const control = await seedDueControlUser(due);

    const userId = await seedUser();
    const userRows = await seedUserRows(userId);

    await expectPurgeCannotDelete(userRows, 'user with no membership');
    await expectPurgeDeletesControl(control);
  });
});

describe('tayzu_auth keeps full access to every tenant on the nine tables (migration 0014, Q59, Q65)', () => {
  it('tayzu_auth reads, inserts, updates and deletes the rows of every tenant, due or not, with row-level security on', async () => {
    for (const table of AUTH_TABLES) {
      expect(await rowSecurityEnabled(table), `auth.${table} has row-level security`).toBe(true);
    }

    const tenants = {
      'a due tenant': `org-${randomUUID()}`,
      'a tenant with a pending marker not yet due': `org-${randomUUID()}`,
      'a tenant with no marker': `org-${randomUUID()}`,
    };
    await seedMarker(tenants['a due tenant'], { state: 'pending', due: true });
    await seedMarker(tenants['a tenant with a pending marker not yet due'], {
      state: 'pending',
      due: false,
    });

    const pool = await authPool();
    for (const [label, organizationId] of Object.entries(tenants)) {
      const userId = `user-${randomUUID()}`;
      const ids: Record<AuthTable, string> = {
        organization: organizationId,
        user: userId,
        member: `member-${randomUUID()}`,
        invitation: `invitation-${randomUUID()}`,
        apikey: `apikey-${randomUUID()}`,
        session: `session-${randomUUID()}`,
        account: `account-${randomUUID()}`,
        two_factor: `two-factor-${randomUUID()}`,
        verification: `verification-${randomUUID()}`,
      };

      const inserts: [AuthTable, string, unknown[]][] = [
        [
          'organization',
          'insert into auth.organization (id, name, slug, created_at) values ($1, $2, $3, now())',
          [ids.organization, 'Org', `slug-${ids.organization}`],
        ],
        [
          'user',
          `insert into auth."user" (id, name, email, email_verified, created_at, updated_at)
           values ($1, 'User', $2, true, now(), now())`,
          [ids.user, `${ids.user}@example.test`],
        ],
        [
          'member',
          `insert into auth.member (id, organization_id, user_id, role, created_at)
           values ($1, $2, $3, 'member', now())`,
          [ids.member, organizationId, userId],
        ],
        [
          'invitation',
          `insert into auth.invitation (id, organization_id, email, role, status, expires_at, created_at, inviter_id)
           values ($1, $2, $3, 'member', 'pending', now() + interval '7 days', now(), $4)`,
          [ids.invitation, organizationId, `invitee-${randomUUID()}@example.test`, userId],
        ],
        [
          'apikey',
          `insert into auth.apikey (id, name, reference_id, key, config_id, created_at, updated_at)
           values ($1, 'key', $2, $3, 'default', now(), now())`,
          [ids.apikey, organizationId, randomToken()],
        ],
        [
          'session',
          `insert into auth.session (id, expires_at, token, created_at, updated_at, user_id, active_organization_id)
           values ($1, now() + interval '1 day', $2, now(), now(), $3, $4)`,
          [ids.session, randomToken(), userId, organizationId],
        ],
        [
          'account',
          `insert into auth.account (id, account_id, provider_id, user_id, created_at, updated_at)
           values ($1, $2, 'credential', $3, now(), now())`,
          [ids.account, `subject-${randomUUID()}`, userId],
        ],
        [
          'two_factor',
          'insert into auth.two_factor (id, secret, backup_codes, user_id) values ($1, $2, $3, $4)',
          [ids.two_factor, randomToken(), randomToken(), userId],
        ],
        [
          'verification',
          `insert into auth.verification (id, identifier, value, expires_at, created_at, updated_at)
           values ($1, $2, 'token', now() + interval '1 day', now(), now())`,
          [ids.verification, family.invitationAccept(ids.invitation)],
        ],
      ];
      const updates: Record<AuthTable, string> = {
        organization: "update auth.organization set name = 'Renamed' where id = $1",
        user: 'update auth."user" set name = \'Renamed\', updated_at = now() where id = $1',
        member: "update auth.member set role = 'admin' where id = $1",
        invitation: "update auth.invitation set status = 'canceled' where id = $1",
        apikey: "update auth.apikey set name = 'renamed', updated_at = now() where id = $1",
        session: 'update auth.session set updated_at = now() where id = $1',
        account: 'update auth.account set updated_at = now() where id = $1',
        two_factor: 'update auth.two_factor set failed_verification_count = 1 where id = $1',
        verification: 'update auth.verification set updated_at = now() where id = $1',
      };
      /** Children before parents, so no delete is a cascade. */
      const deleteOrder: readonly AuthTable[] = [
        'verification',
        'two_factor',
        'account',
        'session',
        'apikey',
        'invitation',
        'member',
        'user',
        'organization',
      ];

      const outcome: Record<string, { code: string | undefined; rowCount: number }> = {};
      for (const [table, statement, params] of inserts) {
        const { code, rowCount } = await attempt(pool, statement, params);
        outcome[`insert ${table}`] = { code, rowCount };
      }
      for (const table of AUTH_TABLES) {
        const { code, rowCount } = await attempt(
          pool,
          `select id from ${qualified(table)} where id = $1`,
          [ids[table]],
        );
        outcome[`select ${table}`] = { code, rowCount };
      }
      for (const table of AUTH_TABLES) {
        const { code, rowCount } = await attempt(pool, updates[table], [ids[table]]);
        outcome[`update ${table}`] = { code, rowCount };
      }
      for (const table of deleteOrder) {
        const { code, rowCount } = await attempt(pool, deleteById(table), [ids[table]]);
        outcome[`delete ${table}`] = { code, rowCount };
      }

      const expected: Record<string, { code: undefined; rowCount: number }> = {};
      for (const verb of ['insert', 'select', 'update', 'delete']) {
        for (const table of AUTH_TABLES) {
          expected[`${verb} ${table}`] = { code: undefined, rowCount: 1 };
        }
      }
      expect(outcome, label).toEqual(expected);
    }
  });
});
