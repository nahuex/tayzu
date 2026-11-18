/**
 * Integration test for task 6.2 of 045-org-deletion-and-data-retention: purge
 * step 2, the Better Auth data (design D2 step 2, Resolved decisions Q150,
 * Q161, Q162, Q163 and Q164), run as `tayzu_purge` under migration `0014`'s
 * policies. It covers the spec scenario:
 *
 * > #### Scenario: Users with no other membership are removed, others are kept
 * >
 * > - **GIVEN** a user who belongs only to `t1` and another who belongs to `t1` and `t2`
 * > - **WHEN** `t1` is purged
 * > - **THEN** the first user and their account, session and second-factor rows are
 * >   gone, together with the verification rows keyed by that user (the
 * >   temporary-password, MFA re-enrolment and SSO-link markers), and the second user
 * >   keeps their account and their membership in `t2`
 *
 * and the rest of 6.2's Verify clause: an `sso-link:` row goes before its
 * account and a `mfa-reenrol:` row before its user (`0014` joins both to the
 * account and to the user's memberships, so a row deleted after them would be
 * left behind), a `step-up-verified:` marker of one of the removed user's
 * sessions is gone, an invitation token and an `invitation-shed:` record are
 * gone, an invitation the removed user sent leaves no token or shed record
 * behind (Q163: the invitations go before any user, whose deletion cascades to
 * them), a `password-reset:` row of the removed user is left alone (exempt,
 * Q150), a membership added between the check and the delete keeps the user
 * (the seam), and a session of a staying user whose active organization is
 * the purged tenant is deleted. Step 2 records `auth_purged_at = now()` and
 * `state = 'purged'` in one transaction, only after every auth delete and only
 * when `catalog_purged_at` is set (Q161), and a second run is a no-op.
 *
 * Expected production API (added to the module of task 6.1, beside
 * `purgeCatalogStep`):
 *
 * ```ts
 * // apps/api/scripts/purge-job.ts
 * export interface PurgeAuthOptions {
 *   // Failure seam (design "Failure seams ... between a membership check and a
 *   // delete"): awaited for each user the step has found with no membership
 *   // outside due tenants, after that check and before the user's own
 *   // transaction (which re-checks the memberships) begins, holding no lock on
 *   // the user's rows. A throw interrupts the step before the marker is written.
 *   readonly beforeUserDeleted?: (userId: string) => void | Promise<void>;
 * }
 * export function purgeAuthStep(
 *   pool: Pool, // a `tayzu_purge` pool
 *   tenantId: string, // the organization id
 *   options?: PurgeAuthOptions,
 * ): Promise<unknown>; // the resolved value is not asserted here
 * ```
 *
 * Task 6.3 (design D2, Resolved decision Q79) extends this file: step 2 logs
 * `catalog.audit.org_deletion_completed` (INFO, exactly `tayzu.tenant.id` and
 * `tayzu.identity.org_deletion.entities_removed`) immediately before the
 * organization row is deleted, covering the AND clause of the spec scenario:
 *
 * > #### Scenario: Purge removes tenant data after the window
 * >
 * > - **GIVEN** `t1`'s purge date has passed
 * > - **WHEN** the purge job runs
 * > - **THEN** `t1`'s catalog entities, blueprints, relations, change events, credential
 * >   revocation rows, invitations, API keys, members and organization row are gone
 * > - **AND** a `catalog.audit.org_deletion_completed` event was logged before the
 * >   organization row was removed
 *
 * and that the record is exported by the time the purge's run function
 * returns (it runs inside `runScript`, whose `finally` flushes through
 * `RunScriptOptions.telemetry`). The telemetry harness registers before
 * `../scripts/purge-job.js` loads (import order, design D1 of `043`). Expected
 * additions to `apps/api/scripts/purge-job.ts`:
 *
 * ```ts
 * export interface PurgeAuthOptions {
 *   readonly beforeUserDeleted?: (userId: string) => void | Promise<void>;
 *   // Step 1's `CatalogPurgeResult.entitiesRemoved`, carried into the record's
 *   // `tayzu.identity.org_deletion.entities_removed`; `runPurge` passes it.
 *   readonly entitiesRemoved?: number;
 *   // Ordering seam: awaited once, after `catalog.audit.org_deletion_completed`
 *   // is emitted and immediately before `delete from auth.organization`.
 *   readonly beforeOrganizationDeleted?: () => void | Promise<void>;
 * }
 * export interface RunPurgeOptions {
 *   readonly pool: Pool; // a `tayzu_purge` pool
 *   // The tenants to purge; task 6.6 defaults it to every due tenant. Tests pass
 *   // their own, so a run never purges another test file's due tenant.
 *   readonly tenantIds?: readonly string[];
 *   readonly env?: RunScriptOptions['env'];
 *   readonly telemetry?: Telemetry; // forwarded to `runScript`
 * }
 * // Inside `runScript('purge-job', ..., { telemetry, ... })`: for each tenant,
 * // `purgeCatalogStep`, then `purgeAuthStep` with step 1's `entitiesRemoved`.
 * export function runPurge(options: RunPurgeOptions): Promise<unknown>;
 * ```
 *
 * Seeding and every read go through the owner pool (it alone can write a due
 * marker and it bypasses row-level security, so it sees what really
 * happened). Every id is random per run; other test files' due markers share
 * the database, so every assertion is scoped to this file's rows.
 */
// Load-bearing import order (design D1 of `043`): the telemetry harness registers before
// `../scripts/purge-job.js` (and anything it loads) obtains its logger.
import { registration, type TelemetryTestHarness } from './__fixtures__/link-telemetry.js';
import { randomBytes, randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { getOwnerPool, getPurgeTestDatabase } from '../../../packages/db/src/harness.js';
import { purgeAuthStep, runPurge } from '../scripts/purge-job.js';
import type { Telemetry } from './telemetry.js';

type AuthTable =
  | 'organization'
  | 'member'
  | 'invitation'
  | 'apikey'
  | 'session'
  | 'user'
  | 'account'
  | 'two_factor'
  | 'verification';

/** One Better Auth row, by table and primary key. */
interface AuthRow {
  readonly table: AuthTable;
  readonly id: string;
  readonly label: string;
}

function authRow(table: AuthTable, id: string, label: string): AuthRow {
  return { table, id, label };
}

function randomToken(): string {
  return randomBytes(24).toString('hex');
}

async function purgePool(): Promise<Pool> {
  return (await getPurgeTestDatabase()).pool;
}

async function ownerQuery(statement: string, params: unknown[]): Promise<void> {
  const owner = await getOwnerPool();
  await owner.query(statement, params);
}

// ---------------------------------------------------------------------------
// Seeding, through the owner pool (same shapes as `tenant-deletion-auth-grants.int.test.ts`).

/**
 * A pending marker due fifteen days after its request (inside the `CHECK`
 * window), with step 1 recorded an hour ago when `catalogPurged` is set.
 */
async function seedDueMarker(tenantId: string, catalogPurged: boolean): Promise<void> {
  await ownerQuery(
    `insert into tenant_deletion_marker
       (tenant_id, requested_at, purge_after, requested_by, catalog_purged_at)
     values ($1, now() - interval '15 days', now() - interval '1 day', $2,
             case when $3::boolean then now() - interval '1 hour' end)`,
    [tenantId, `actor-${randomUUID()}`, catalogPurged],
  );
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

/** The user-keyed rows of a user with an account, a second factor and the three markers. */
interface SeededUserRows {
  readonly user: AuthRow;
  readonly account: AuthRow;
  readonly twoFactor: AuthRow;
  readonly tempPassword: AuthRow;
  readonly mfaReenrol: AuthRow;
  readonly ssoLink: AuthRow;
}

async function seedUserRows(userId: string): Promise<SeededUserRows> {
  const accountId = await seedAccount(userId);
  return {
    user: { table: 'user', id: userId, label: 'user' },
    account: { table: 'account', id: accountId, label: 'account' },
    twoFactor: { table: 'two_factor', id: await seedTwoFactor(userId), label: 'two_factor' },
    tempPassword: {
      table: 'verification',
      id: await seedVerification(`temp-password:${userId}`, randomToken()),
      label: 'temp-password:<userId>',
    },
    mfaReenrol: {
      table: 'verification',
      id: await seedVerification(`mfa-reenrol:${userId}`, 'reset', true),
      label: 'mfa-reenrol:<userId>',
    },
    ssoLink: {
      table: 'verification',
      id: await seedVerification(`sso-link:${accountId}`, userId, true),
      label: 'sso-link:<accountId>',
    },
  };
}

function userRowList(rows: SeededUserRows): AuthRow[] {
  return [
    rows.ssoLink,
    rows.mfaReenrol,
    rows.tempPassword,
    rows.account,
    rows.twoFactor,
    rows.user,
  ];
}

interface SeededInvitation {
  readonly invitation: AuthRow;
  readonly token: AuthRow;
  readonly shed: AuthRow;
}

async function seedInvitationWithToken(
  organizationId: string,
  inviterId: string,
): Promise<SeededInvitation> {
  const invitationId = await seedInvitation(organizationId, inviterId);
  return {
    invitation: { table: 'invitation', id: invitationId, label: 'invitation' },
    token: {
      table: 'verification',
      id: await seedVerification(`invitation-accept:${invitationId}`, randomToken()),
      label: 'invitation-accept:<invitationId>',
    },
    shed: {
      table: 'verification',
      id: await seedVerification(`invitation-shed:${invitationId}`, 'shed'),
      label: 'invitation-shed:<invitationId>',
    },
  };
}

/**
 * The scenario's world. `t1` is due with step 1 recorded (unless
 * `catalogPurged` is false); `t2` has no marker.
 *
 * - `leaver` belongs only to `t1`: user-keyed rows, a session with no active
 *   organization and its `step-up-verified:` marker, a `password-reset:` row,
 *   and an invitation it sent in `t1` with its token and shed record (Q163).
 * - `stayer` belongs to `t1` and `t2`: user-keyed rows, a session active in
 *   `t1` and one active in `t2`, and an invitation it sent in `t1` with its
 *   token and shed record.
 * - Each tenant has an API key.
 */
async function seedWorld(catalogPurged = true) {
  const t1 = await seedOrganization();
  const t2 = await seedOrganization();
  await seedDueMarker(t1, catalogPurged);

  const leaverId = await seedUser();
  const leaverT1Member = await seedMember(t1, leaverId);
  const leaver = await seedUserRows(leaverId);
  const leaverSession = await seedSession(leaverId, null);
  const leaverStepUp: AuthRow = {
    table: 'verification',
    id: await seedVerification(`step-up-verified:${leaverSession.token}`, 'mfa'),
    label: 'step-up-verified:<sessionToken> of the leaver',
  };
  const leaverPasswordReset: AuthRow = {
    table: 'verification',
    id: await seedVerification(`password-reset:${randomUUID()}`, `${randomToken()}:${leaverId}`),
    label: 'password-reset:<id> of the leaver',
  };
  const leaverInvitation = await seedInvitationWithToken(t1, leaverId);

  const stayerId = await seedUser();
  const stayerT1Member = await seedMember(t1, stayerId);
  const stayerT2Member = await seedMember(t2, stayerId);
  const stayer = await seedUserRows(stayerId);
  const stayerT1Session = await seedSession(stayerId, t1);
  const stayerT2Session = await seedSession(stayerId, t2);
  const stayerInvitation = await seedInvitationWithToken(t1, stayerId);

  const t1ApiKey = await seedApiKey(t1);
  const t2ApiKey = await seedApiKey(t2);

  return {
    t1,
    t2,
    leaverId,
    leaver,
    leaverT1Member: authRow('member', leaverT1Member, 'leaver member of t1'),
    leaverSession: authRow('session', leaverSession.id, 'leaver session'),
    leaverStepUp,
    leaverPasswordReset,
    leaverInvitation,
    stayerId,
    stayer,
    stayerT1Member: authRow('member', stayerT1Member, 'stayer member of t1'),
    stayerT2Member: authRow('member', stayerT2Member, 'stayer member of t2'),
    stayerT1Session: authRow('session', stayerT1Session.id, 'stayer session active in t1'),
    stayerT2Session: authRow('session', stayerT2Session.id, 'stayer session active in t2'),
    stayerInvitation,
    t1Organization: authRow('organization', t1, 'organization t1'),
    t2Organization: authRow('organization', t2, 'organization t2'),
    t1ApiKey: authRow('apikey', t1ApiKey, 'API key of t1'),
    t2ApiKey: authRow('apikey', t2ApiKey, 'API key of t2'),
  };
}

type World = Awaited<ReturnType<typeof seedWorld>>;

/** Every row of `t1` the step must delete, and every row of the leaver. */
function rowsToBeDeleted(world: World): AuthRow[] {
  return [
    world.leaverInvitation.token,
    world.leaverInvitation.shed,
    world.leaverInvitation.invitation,
    world.stayerInvitation.token,
    world.stayerInvitation.shed,
    world.stayerInvitation.invitation,
    world.leaverStepUp,
    world.leaverSession,
    ...userRowList(world.leaver),
    world.t1ApiKey,
    world.stayerT1Session,
    world.leaverT1Member,
    world.stayerT1Member,
    world.t1Organization,
  ];
}

/** Every row the step must keep. */
function rowsToBeKept(world: World): AuthRow[] {
  return [
    world.leaverPasswordReset,
    ...userRowList(world.stayer),
    world.stayerT2Member,
    world.stayerT2Session,
    world.t2ApiKey,
    world.t2Organization,
  ];
}

// ---------------------------------------------------------------------------
// Reads, through the owner pool.

async function ownerHas(row: AuthRow): Promise<boolean> {
  const owner = await getOwnerPool();
  // `row.table` is one of the fixed `AuthTable` literals.
  const { rows } = await owner.query<{ present: boolean }>(
    `select exists (select 1 from auth."${row.table}" where id = $1) as present`,
    [row.id],
  );
  return rows[0]?.present === true;
}

async function expectGone(rows: readonly AuthRow[], label: string): Promise<void> {
  for (const row of rows) {
    expect(await ownerHas(row), `${label}: ${row.label} (${row.table}) is gone`).toBe(false);
  }
}

async function expectPresent(rows: readonly AuthRow[], label: string): Promise<void> {
  for (const row of rows) {
    expect(await ownerHas(row), `${label}: ${row.label} (${row.table}) is kept`).toBe(true);
  }
}

interface MarkerRow {
  readonly state: string;
  /** Text forms, so two reads compare at full microsecond precision. */
  readonly catalog_purged_at: string | null;
  readonly auth_purged_at: string | null;
  /** `auth_purged_at` lies within the run (between `$2` and the read). */
  readonly auth_purged_in_run: boolean | null;
  readonly auth_after_catalog: boolean | null;
}

async function ownerNow(): Promise<string> {
  const owner = await getOwnerPool();
  const { rows } = await owner.query<{ now: string }>('select clock_timestamp()::text as now');
  return rows[0]?.now ?? '';
}

async function ownerMarkers(tenantId: string, runStartedAt: string): Promise<MarkerRow[]> {
  const owner = await getOwnerPool();
  const { rows } = await owner.query<MarkerRow>(
    `select state::text as state,
            catalog_purged_at::text as catalog_purged_at,
            auth_purged_at::text as auth_purged_at,
            auth_purged_at >= $2::timestamptz and auth_purged_at <= clock_timestamp()
              as auth_purged_in_run,
            auth_purged_at >= catalog_purged_at as auth_after_catalog
       from tenant_deletion_marker where tenant_id = $1`,
    [tenantId, runStartedAt],
  );
  return rows;
}

/** The marker after a completed step 2: purged, with `auth_purged_at` from this run. */
async function expectPurgedMarker(tenantId: string, runStartedAt: string): Promise<string> {
  const markers = await ownerMarkers(tenantId, runStartedAt);
  expect(markers).toHaveLength(1);
  const [marker] = markers;
  expect(marker).toMatchObject({
    state: 'purged',
    auth_purged_in_run: true,
    auth_after_catalog: true,
  });
  expect(marker?.catalog_purged_at).not.toBeNull();
  return marker?.auth_purged_at ?? '';
}

async function expectPendingMarker(tenantId: string, label: string): Promise<void> {
  const markers = await ownerMarkers(tenantId, '-infinity');
  expect(markers, label).toHaveLength(1);
  expect(markers[0], label).toMatchObject({ state: 'pending', auth_purged_at: null });
}

class SeamFailure extends Error {
  constructor() {
    super('failure seam: step 2 interrupted');
    this.name = 'SeamFailure';
  }
}

// ---------------------------------------------------------------------------

describe('Users with no other membership are removed, others are kept (Better Auth side, step 2)', () => {
  it('removes the user who belongs only to t1 with their account, session, second factor and verification rows, and keeps the user who also belongs to t2', async () => {
    const world = await seedWorld();
    await expectPresent([...rowsToBeDeleted(world), ...rowsToBeKept(world)], 'before the purge');
    const runStartedAt = await ownerNow();

    await purgeAuthStep(await purgePool(), world.t1);

    await expectGone(
      [...userRowList(world.leaver), world.leaverSession, world.leaverT1Member],
      'the user who belongs only to t1',
    );
    await expectPresent(
      [world.stayer.user, world.stayer.account, world.stayerT2Member],
      'the user who belongs to t1 and t2',
    );
    await expectGone([world.stayerT1Member], 'the membership in t1 of the user who stays');
    await expectPurgedMarker(world.t1, runStartedAt);
  });

  it("deletes an sso-link: row before its account and a mfa-reenrol: row before its user (neither is left behind), and keeps the staying user's", async () => {
    const world = await seedWorld();

    await purgeAuthStep(await purgePool(), world.t1);

    await expectGone(
      [world.leaver.ssoLink, world.leaver.mfaReenrol, world.leaver.tempPassword],
      'verification rows keyed by the removed user',
    );
    await expectGone([world.leaver.account, world.leaver.user], 'the rows those rows join');
    await expectPresent(
      [
        world.stayer.ssoLink,
        world.stayer.mfaReenrol,
        world.stayer.tempPassword,
        world.stayer.twoFactor,
      ],
      'verification and second-factor rows of the user who stays',
    );
  });

  it("deletes the step-up-verified: marker of a removed user's session", async () => {
    const world = await seedWorld();

    await purgeAuthStep(await purgePool(), world.t1);

    await expectGone([world.leaverStepUp, world.leaverSession], 'step-up marker and its session');
  });

  it('deletes an invitation token and its invitation-shed: record with the invitation', async () => {
    const world = await seedWorld();

    await purgeAuthStep(await purgePool(), world.t1);

    await expectGone(
      [
        world.stayerInvitation.token,
        world.stayerInvitation.shed,
        world.stayerInvitation.invitation,
      ],
      'invitation of t1 sent by the user who stays',
    );
  });

  it('an invitation the removed user sent leaves no token or shed record behind (Q163)', async () => {
    const world = await seedWorld();

    await purgeAuthStep(await purgePool(), world.t1);

    await expectGone(
      [
        world.leaverInvitation.token,
        world.leaverInvitation.shed,
        world.leaverInvitation.invitation,
      ],
      'invitation of t1 sent by the removed user',
    );
  });

  it('leaves a password-reset: row of a removed user alone (exempt, Q150)', async () => {
    const world = await seedWorld();

    await purgeAuthStep(await purgePool(), world.t1);

    await expectGone([world.leaver.user], 'the removed user');
    await expectPresent([world.leaverPasswordReset], 'exempt family');
  });

  it("deletes the staying user's session whose active organization is the purged tenant, and keeps their other session", async () => {
    const world = await seedWorld();

    await purgeAuthStep(await purgePool(), world.t1);

    await expectGone([world.stayerT1Session], 'session active in the purged tenant');
    await expectPresent([world.stayerT2Session], 'session active in t2');
  });

  it("deletes t1's API keys, members and organization row and nothing of t2", async () => {
    const world = await seedWorld();

    await purgeAuthStep(await purgePool(), world.t1);

    await expectGone(rowsToBeDeleted(world), 't1');
    await expectPresent(rowsToBeKept(world), 'kept rows');
  });

  it('keeps a user whose membership in another tenant is added between the check and the delete (seam)', async () => {
    const world = await seedWorld();
    const t3 = await seedOrganization();
    const latecomerId = await seedUser();
    await seedMember(world.t1, latecomerId);
    const latecomer = await seedUserRows(latecomerId);
    const added: AuthRow[] = [];
    const seen: string[] = [];

    await purgeAuthStep(await purgePool(), world.t1, {
      beforeUserDeleted: async (userId: string) => {
        seen.push(userId);
        if (userId === latecomerId) {
          added.push(
            authRow(
              'member',
              await seedMember(t3, latecomerId),
              'membership in t3 added by the seam',
            ),
          );
        }
      },
    });

    expect(seen, 'the seam ran for the user found with no other membership').toContain(latecomerId);
    expect(added, 'the seam added the membership once').toHaveLength(1);
    await expectPresent(
      [...userRowList(latecomer), ...added],
      'the user with a membership added in between',
    );
    await expectGone(userRowList(world.leaver), 'the user who belongs only to t1');
  });

  it('records auth_purged_at = now() and state = purged only after every auth delete: an interrupted run leaves the marker pending, and the next run completes', async () => {
    const world = await seedWorld();
    const pool = await purgePool();

    await expect(
      purgeAuthStep(pool, world.t1, {
        beforeUserDeleted: (userId: string) => {
          if (userId === world.leaverId) {
            throw new SeamFailure();
          }
        },
      }),
    ).rejects.toThrow();

    await expectPendingMarker(world.t1, 'marker after the interrupted run');
    await expectPresent(
      [world.leaver.user, world.t1Organization],
      'the user and the organization row',
    );

    const runStartedAt = await ownerNow();
    await purgeAuthStep(pool, world.t1);

    await expectGone(rowsToBeDeleted(world), 't1 after the resumed run');
    await expectPresent(rowsToBeKept(world), 'kept rows after the resumed run');
    await expectPurgedMarker(world.t1, runStartedAt);
  });

  it('does not mark the tenant purged while catalog_purged_at is not set (Q161)', async () => {
    const world = await seedWorld(false);

    await purgeAuthStep(await purgePool(), world.t1).catch(() => undefined);

    await expectPendingMarker(world.t1, 'marker with step 1 not recorded');
  });

  it('a second run is a no-op: it does not fail, deletes nothing and keeps the marker', async () => {
    const world = await seedWorld();
    const pool = await purgePool();
    const runStartedAt = await ownerNow();
    await purgeAuthStep(pool, world.t1);
    const first = await expectPurgedMarker(world.t1, runStartedAt);

    // A rejection fails the test: the second run must not fail.
    await purgeAuthStep(pool, world.t1);

    expect(await expectPurgedMarker(world.t1, runStartedAt)).toBe(first);
    await expectGone(rowsToBeDeleted(world), 't1 after the second run');
    await expectPresent(rowsToBeKept(world), 'kept rows after the second run');
  });
});

// ---------------------------------------------------------------------------
// Task 6.3: `catalog.audit.org_deletion_completed`.

const COMPLETED_EVENT = 'catalog.audit.org_deletion_completed';

function registeredHarness(): TelemetryTestHarness {
  if ('error' in registration) {
    throw new Error(`createTelemetryTestHarness() failed: ${String(registration.error)}`, {
      cause: registration.error,
    });
  }
  return registration.harness;
}

/** The exported completion records of `tenantId` (other tests of this file purge other tenants). */
function completedRecords(harness: TelemetryTestHarness, tenantId: string) {
  return harness.logExporter
    .getFinishedLogRecords()
    .filter(
      (record) =>
        record.eventName === COMPLETED_EVENT && record.attributes['tayzu.tenant.id'] === tenantId,
    );
}

/** One blueprint and `count` entities of `tenantId`, through the owner pool. */
async function seedCatalogEntities(tenantId: string, count: number): Promise<void> {
  const actorId = `actor-${randomUUID()}`;
  const blueprintId = randomUUID();
  await ownerQuery(
    `insert into catalog_blueprint
       (id, tenant_id, identifier, title, schema, version, created_at, created_by_type,
        created_by_id, updated_at, updated_by_type, updated_by_id)
     values ($1, $2, 'service', '"Service"'::jsonb, '{}'::jsonb, 1, now(), 'user', $3,
             now(), 'user', $3)`,
    [blueprintId, tenantId, actorId],
  );
  for (let index = 0; index < count; index += 1) {
    await ownerQuery(
      `insert into catalog_entity
         (id, tenant_id, blueprint_id, identifier, title, spec_properties, generation, version,
          created_at, created_by_type, created_by_id, updated_at, updated_by_type, updated_by_id)
       values ($1, $2, $3, $4, $4, '{}'::jsonb, 1, 1, now(), 'user', $5, now(), 'user', $5)`,
      [randomUUID(), tenantId, blueprintId, `entity-${String(index)}`, actorId],
    );
  }
}

async function ownerEntityCount(tenantId: string): Promise<number> {
  const owner = await getOwnerPool();
  const { rows } = await owner.query<{ count: number }>(
    'select count(*)::int as count from catalog_entity where tenant_id = $1',
    [tenantId],
  );
  return rows[0]?.count ?? -1;
}

/** The free text of the world: the organization's slug and the users' emails. */
function freeText(world: World): string[] {
  return [`slug-${world.t1}`, `${world.leaverId}@example.test`, `${world.stayerId}@example.test`];
}

function expectCompletedRecord(
  harness: TelemetryTestHarness,
  world: World,
  entitiesRemoved: number,
): void {
  const records = completedRecords(harness, world.t1);
  expect(records, `exactly one ${COMPLETED_EVENT} for t1`).toHaveLength(1);
  const [record] = records;
  expect(record?.severityText, 'the declared severity').toBe('INFO');
  expect(record?.attributes, 'exactly the declared attributes').toEqual({
    'tayzu.tenant.id': world.t1,
    'tayzu.identity.org_deletion.entities_removed': entitiesRemoved,
  });
  const serialized = JSON.stringify({ body: record?.body, attributes: record?.attributes });
  for (const text of freeText(world)) {
    expect(serialized, 'no organization slug or user email').not.toContain(text);
  }
}

describe('Purge removes tenant data after the window: catalog.audit.org_deletion_completed is logged before the organization row is removed (task 6.3)', () => {
  it("step 2 logs exactly one INFO catalog.audit.org_deletion_completed with exactly the tenant and step 1's entities_removed and no free text, while the organization row still exists (beforeOrganizationDeleted seam), and the row is gone afterwards", async () => {
    const harness = registeredHarness();
    const world = await seedWorld();
    const atSeam: {
      readonly records: number;
      readonly organizationPresent: boolean;
      readonly membersPresent: boolean;
    }[] = [];

    await purgeAuthStep(await purgePool(), world.t1, {
      entitiesRemoved: 7,
      beforeOrganizationDeleted: async () => {
        await harness.forceFlush();
        atSeam.push({
          records: completedRecords(harness, world.t1).length,
          organizationPresent: await ownerHas(world.t1Organization),
          membersPresent:
            (await ownerHas(world.leaverT1Member)) || (await ownerHas(world.stayerT1Member)),
        });
      },
    });

    expect(
      atSeam,
      'immediately before the organization delete: the record is exported, the organization row still exists and the members are already gone',
    ).toEqual([{ records: 1, organizationPresent: true, membersPresent: false }]);
    await expectGone([world.t1Organization], 'the organization row after the step');
    await harness.forceFlush();
    expectCompletedRecord(harness, world, 7);
  });

  it('runPurge runs the due tenant through both steps inside runScript: the record carries the entities step 1 removed and is exported by the time runPurge returns', async () => {
    const harness = registeredHarness();
    const world = await seedWorld(false);
    await seedCatalogEntities(world.t1, 3);
    let returned = false;
    const atShutdown: { readonly records: number; readonly returned: boolean }[] = [];
    const telemetry: Telemetry = {
      shutdown: async () => {
        await harness.forceFlush();
        atShutdown.push({ records: completedRecords(harness, world.t1).length, returned });
      },
    };
    const runStartedAt = await ownerNow();

    await runPurge({ pool: await purgePool(), tenantIds: [world.t1], telemetry });
    returned = true;

    expect(
      atShutdown,
      "runScript's final flush ran once, before runPurge returned, with the record already emitted",
    ).toEqual([{ records: 1, returned: false }]);
    expectCompletedRecord(harness, world, 3);
    expect(await ownerEntityCount(world.t1), "t1's catalog entities").toBe(0);
    await expectGone(rowsToBeDeleted(world), 't1 after the run');
    await expectPresent(rowsToBeKept(world), 'kept rows after the run');
    await expectPurgedMarker(world.t1, runStartedAt);
  });
});
