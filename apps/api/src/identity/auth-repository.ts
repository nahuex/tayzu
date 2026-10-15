/**
 * The only module through which the identity code reads `apikey`, `invitation`,
 * `member`, `session`, `user` and `account` (043 design D14, Resolved decision Q69).
 *
 * The `auth` schema has no row-level security, so every function on a tenant-keyed
 * model requires a `tenantId` and filters by it. `user` and `account` hold no tenant:
 * their readers, and the two global reads of tenant-keyed models, are named `global…`.
 * All SQL is parameterized and no read selects the hashed `key` column.
 */
import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

/** The only API-key configuration identity manages (design D8). */
const MACHINE_CREDENTIAL_CONFIG_ID = 'machine-credential';

export interface ApiKeyRead {
  readonly id: string;
  readonly name: string | null;
  readonly referenceId: string;
  readonly enabled: boolean;
  readonly createdAt: Date;
  readonly lastRequest: Date | null;
  /** Raw column value: a JSON string from SQL; the reader accepts an object too. */
  readonly metadata: unknown;
}

export interface InvitationRead {
  readonly id: string;
  readonly organizationId: string;
  readonly email: string;
  readonly inviterId: string;
  readonly status: string;
  readonly expiresAt: Date;
  /** The invited role as stored (`member` or `admin`); null when none was set. */
  readonly role: string | null;
}

export interface MemberRead {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly role: string;
}

export interface UserRead {
  readonly id: string;
  readonly email: string;
}

export interface SessionRead {
  readonly id: string;
  readonly userId: string;
  readonly activeOrganizationId: string;
}

export interface AccountRead {
  readonly id: string;
  readonly providerId: string;
  readonly accountId: string;
  readonly userId: string;
}

/** An owner or admin of a tenant, as the admin notice needs them. */
export interface AdminRecipientRead {
  readonly email: string;
  readonly memberSince: Date;
}

export interface AuthRepository {
  listApiKeys: (
    tenantId: string,
    page: { limit: number; cursor?: string; configId?: string },
  ) => Promise<{ keys: ApiKeyRead[]; nextCursor?: string }>;
  apiKeyById: (tenantId: string, keyId: string) => Promise<ApiKeyRead | undefined>;
  invitationById: (tenantId: string, invitationId: string) => Promise<InvitationRead | undefined>;
  /** The `pending` invitations of the tenant to the (canonical) email. */
  pendingInvitationsByEmail: (tenantId: string, email: string) => Promise<InvitationRead[]>;
  /** The `pending` invitations of the tenant created by the inviter. */
  pendingInvitationsByInviter: (tenantId: string, inviterId: string) => Promise<InvitationRead[]>;
  listMembers: (tenantId: string) => Promise<MemberRead[]>;
  /** The owners and admins of the tenant other than `excludeUserId`, with their membership dates. */
  adminRecipients: (tenantId: string, excludeUserId: string) => Promise<AdminRecipientRead[]>;
  memberOf: (tenantId: string, userId: string) => Promise<MemberRead | undefined>;
  userInTenant: (tenantId: string, userId: string) => Promise<UserRead | undefined>;
  sessionsOf: (tenantId: string, userId: string) => Promise<SessionRead[]>;
  /** Deletes one membership of the tenant; true when a row went. */
  deleteMember: (tenantId: string, memberId: string) => Promise<boolean>;
  /** Deletes the user's sessions whose active organization is the tenant; rows deleted. */
  deleteSessionsOf: (tenantId: string, userId: string) => Promise<number>;
  /**
   * Sets a `pending` invitation of the tenant to `accepted`; true when a row changed.
   * `db` lets the acceptance run it inside its own transaction.
   */
  markInvitationAccepted: (
    tenantId: string,
    invitationId: string,
    db?: Pick<Pool, 'query'>,
  ) => Promise<boolean>;
  /** Sets a `pending` invitation of the tenant to `canceled` (Better Auth's spelling); true when a row changed. */
  markInvitationCancelled: (tenantId: string, invitationId: string) => Promise<boolean>;
  globalUserByEmail: (email: string) => Promise<UserRead | undefined>;
  globalUserById: (userId: string) => Promise<UserRead | undefined>;
  /** Whether a member of the tenant is banned; `undefined` when the user is not a member. */
  memberBanned: (tenantId: string, userId: string) => Promise<boolean | undefined>;
  globalAccountByKey: (providerId: string, accountId: string) => Promise<AccountRead | undefined>;
  globalAccountsOf: (userId: string) => Promise<AccountRead[]>;
  globalInvitationById: (invitationId: string) => Promise<InvitationRead | undefined>;
  /** Tenant ids only, one per membership of the user. */
  globalMembershipTenantsOf: (userId: string) => Promise<string[]>;

  // Verification section: the `password-reset:` rows of `auth.verification` (044 design D3).
  // Each statement runs on `db`, the connection that holds the per-user lock.

  /** Deletes the user's `password-reset:` rows (the user id is the third `:` field of `value`). */
  deleteResetTokensOf: (userId: string, db: Pick<Pool, 'query'>) => Promise<number>;
  /** Deletes every expired `password-reset:` row. */
  deleteExpiredResetTokens: (db: Pick<Pool, 'query'>) => Promise<number>;
  /** Inserts `password-reset:<id>` with the stored value, expiring `ttlSeconds` from now. */
  insertResetToken: (
    row: { id: string; value: string; ttlSeconds: number },
    db: Pick<Pool, 'query'>,
  ) => Promise<void>;
  /** Reads `password-reset:<id>`; `expired` is decided by the database clock. */
  findResetToken: (
    id: string,
    db: Pick<Pool, 'query'>,
  ) => Promise<{ value: string; expired: boolean } | undefined>;
  /**
   * One atomic statement adding one to the counter in `value` where it is below 5.
   * Returns the new count, or `undefined` when no row was updated.
   */
  incrementResetTokenFailures: (id: string, db: Pick<Pool, 'query'>) => Promise<number | undefined>;
  /** Deletes `password-reset:<id>`. */
  deleteResetToken: (id: string, db: Pick<Pool, 'query'>) => Promise<boolean>;
}

interface ApiKeyRow {
  id: string;
  name: string | null;
  reference_id: string;
  enabled: boolean | null;
  created_at: Date;
  last_request: Date | null;
  metadata: unknown;
}
interface InvitationRow {
  id: string;
  organization_id: string;
  email: string;
  inviter_id: string;
  status: string;
  expires_at: Date;
  role: string | null;
}
interface MemberRow {
  id: string;
  organization_id: string;
  user_id: string;
  role: string;
}
interface SessionRow {
  id: string;
  user_id: string;
  active_organization_id: string;
}
interface AccountRow {
  id: string;
  provider_id: string;
  account_id: string;
  user_id: string;
}

const toApiKey = (r: ApiKeyRow): ApiKeyRead => ({
  id: r.id,
  name: r.name,
  referenceId: r.reference_id,
  enabled: r.enabled !== false,
  createdAt: r.created_at,
  lastRequest: r.last_request,
  metadata: r.metadata,
});
const toInvitation = (r: InvitationRow): InvitationRead => ({
  id: r.id,
  organizationId: r.organization_id,
  email: r.email,
  inviterId: r.inviter_id,
  status: r.status,
  expiresAt: r.expires_at,
  role: r.role,
});
const toMember = (r: MemberRow): MemberRead => ({
  id: r.id,
  organizationId: r.organization_id,
  userId: r.user_id,
  role: r.role,
});
const toSession = (r: SessionRow): SessionRead => ({
  id: r.id,
  userId: r.user_id,
  activeOrganizationId: r.active_organization_id,
});
const toAccount = (r: AccountRow): AccountRead => ({
  id: r.id,
  providerId: r.provider_id,
  accountId: r.account_id,
  userId: r.user_id,
});

/** Fails closed: a tenant-keyed function never runs without a non-empty tenant id. */
function requireTenant(tenantId: unknown): asserts tenantId is string {
  if (typeof tenantId !== 'string' || tenantId === '') {
    throw new Error('auth repository: a tenantId is required');
  }
}

export function createAuthRepository(authPool: Pool): AuthRepository {
  const MEMBER_COLUMNS = 'id, organization_id, user_id, role';
  // Never selects the hashed `key` column.
  const API_KEY_COLUMNS = 'id, name, reference_id, enabled, created_at, last_request, metadata';
  const INVITATION_COLUMNS = 'id, organization_id, email, inviter_id, status, expires_at, role';

  return {
    async listApiKeys(tenantId, page) {
      requireTenant(tenantId);
      // Keyset paging on the id; one extra row tells whether the end was reached.
      const result = await authPool.query<ApiKeyRow>(
        `select ${API_KEY_COLUMNS} from auth.apikey
         where reference_id = $1 and ($2::text is null or id > $2)
           and ($4::text is null or config_id = $4)
         order by id limit $3`,
        [tenantId, page.cursor ?? null, page.limit + 1, page.configId ?? null],
      );
      const rows = result.rows.slice(0, page.limit);
      const last = rows[rows.length - 1];
      const hasMore = result.rows.length > page.limit;
      return {
        keys: rows.map(toApiKey),
        ...(hasMore && last !== undefined ? { nextCursor: last.id } : {}),
      };
    },

    async apiKeyById(tenantId, keyId) {
      requireTenant(tenantId);
      const result = await authPool.query<ApiKeyRow>(
        `select ${API_KEY_COLUMNS} from auth.apikey
         where reference_id = $1 and id = $2 and config_id = $3`,
        [tenantId, keyId, MACHINE_CREDENTIAL_CONFIG_ID],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : toApiKey(row);
    },

    async invitationById(tenantId, invitationId) {
      requireTenant(tenantId);
      const result = await authPool.query<InvitationRow>(
        `select ${INVITATION_COLUMNS} from auth.invitation where organization_id = $1 and id = $2`,
        [tenantId, invitationId],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : toInvitation(row);
    },

    async pendingInvitationsByEmail(tenantId, email) {
      requireTenant(tenantId);
      const result = await authPool.query<InvitationRow>(
        `select ${INVITATION_COLUMNS} from auth.invitation
         where organization_id = $1 and lower(email) = lower($2) and status = 'pending'
         order by id`,
        [tenantId, email],
      );
      return result.rows.map(toInvitation);
    },

    async pendingInvitationsByInviter(tenantId, inviterId) {
      requireTenant(tenantId);
      const result = await authPool.query<InvitationRow>(
        `select ${INVITATION_COLUMNS} from auth.invitation
         where organization_id = $1 and inviter_id = $2 and status = 'pending'
         order by id`,
        [tenantId, inviterId],
      );
      return result.rows.map(toInvitation);
    },

    async listMembers(tenantId) {
      requireTenant(tenantId);
      const result = await authPool.query<MemberRow>(
        `select ${MEMBER_COLUMNS} from auth.member where organization_id = $1 order by id`,
        [tenantId],
      );
      return result.rows.map(toMember);
    },

    async adminRecipients(tenantId, excludeUserId) {
      requireTenant(tenantId);
      const result = await authPool.query<{ email: string; created_at: Date }>(
        `select u.email, m.created_at from auth.member m
         join auth."user" u on u.id = m.user_id
         where m.organization_id = $1 and m.user_id <> $2 and m.role in ('owner', 'admin')
         order by m.created_at, m.id`,
        [tenantId, excludeUserId],
      );
      return result.rows.map((r) => ({ email: r.email, memberSince: r.created_at }));
    },

    async memberOf(tenantId, userId) {
      requireTenant(tenantId);
      const result = await authPool.query<MemberRow>(
        `select ${MEMBER_COLUMNS} from auth.member where organization_id = $1 and user_id = $2`,
        [tenantId, userId],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : toMember(row);
    },

    async userInTenant(tenantId, userId) {
      requireTenant(tenantId);
      const result = await authPool.query<UserRead>(
        `select u.id, u.email from auth."user" u
         where u.id = $2
           and exists (select 1 from auth.member m where m.organization_id = $1 and m.user_id = u.id)`,
        [tenantId, userId],
      );
      return result.rows[0];
    },

    async sessionsOf(tenantId, userId) {
      requireTenant(tenantId);
      const result = await authPool.query<SessionRow>(
        `select id, user_id, active_organization_id from auth.session
         where active_organization_id = $1 and user_id = $2 order by id`,
        [tenantId, userId],
      );
      return result.rows.map(toSession);
    },

    async deleteMember(tenantId, memberId) {
      requireTenant(tenantId);
      const result = await authPool.query(
        'delete from auth.member where organization_id = $1 and id = $2',
        [tenantId, memberId],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async deleteSessionsOf(tenantId, userId) {
      requireTenant(tenantId);
      const result = await authPool.query(
        'delete from auth.session where active_organization_id = $1 and user_id = $2',
        [tenantId, userId],
      );
      return result.rowCount ?? 0;
    },

    async markInvitationAccepted(tenantId, invitationId, db = authPool) {
      requireTenant(tenantId);
      const result = await db.query(
        `update auth.invitation set status = 'accepted'
         where organization_id = $1 and id = $2 and status = 'pending'`,
        [tenantId, invitationId],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async markInvitationCancelled(tenantId, invitationId) {
      requireTenant(tenantId);
      const result = await authPool.query(
        `update auth.invitation set status = 'canceled'
         where organization_id = $1 and id = $2 and status = 'pending'`,
        [tenantId, invitationId],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async globalUserByEmail(email) {
      const result = await authPool.query<UserRead>(
        'select id, email from auth."user" where email = $1',
        [email],
      );
      return result.rows[0];
    },

    async globalUserById(userId) {
      const result = await authPool.query<UserRead>(
        'select id, email from auth."user" where id = $1',
        [userId],
      );
      return result.rows[0];
    },

    async memberBanned(tenantId, userId) {
      requireTenant(tenantId);
      const result = await authPool.query<{ banned: boolean | null }>(
        `select u.banned from auth."user" u
         where u.id = $2
           and exists (select 1 from auth.member m where m.organization_id = $1 and m.user_id = u.id)`,
        [tenantId, userId],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : row.banned === true;
    },

    async globalAccountByKey(providerId, accountId) {
      const result = await authPool.query<AccountRow>(
        `select id, provider_id, account_id, user_id from auth.account
         where provider_id = $1 and account_id = $2`,
        [providerId, accountId],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : toAccount(row);
    },

    async globalAccountsOf(userId) {
      const result = await authPool.query<AccountRow>(
        `select id, provider_id, account_id, user_id from auth.account
         where user_id = $1 order by id`,
        [userId],
      );
      return result.rows.map(toAccount);
    },

    async globalInvitationById(invitationId) {
      const result = await authPool.query<InvitationRow>(
        `select ${INVITATION_COLUMNS} from auth.invitation where id = $1`,
        [invitationId],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : toInvitation(row);
    },

    async globalMembershipTenantsOf(userId) {
      const result = await authPool.query<{ organization_id: string }>(
        'select organization_id from auth.member where user_id = $1',
        [userId],
      );
      return result.rows.map((r) => r.organization_id);
    },

    async deleteResetTokensOf(userId, db) {
      const result = await db.query(
        `delete from auth.verification
         where identifier like 'password-reset:%' and split_part(value, ':', 3) = $1`,
        [userId],
      );
      return result.rowCount ?? 0;
    },

    async deleteExpiredResetTokens(db) {
      const result = await db.query(
        `delete from auth.verification
         where identifier like 'password-reset:%' and expires_at <= now()`,
      );
      return result.rowCount ?? 0;
    },

    async insertResetToken(row, db) {
      await db.query(
        `insert into auth.verification (id, identifier, value, expires_at, created_at, updated_at)
         values ($1, $2, $3, now() + make_interval(secs => $4), now(), now())`,
        [randomUUID(), `password-reset:${row.id}`, row.value, row.ttlSeconds],
      );
    },

    async findResetToken(id, db) {
      const result = await db.query<{ value: string; expired: boolean }>(
        `select value, expires_at <= now() as expired
         from auth.verification where identifier = $1`,
        [`password-reset:${id}`],
      );
      return result.rows[0];
    },

    async incrementResetTokenFailures(id, db) {
      // The counter is the last `:` field; the pattern admits only 0..4, so the cast is safe.
      const result = await db.query<{ failures: number }>(
        `update auth.verification
         set value = left(value, length(value) - 1) || (right(value, 1)::int + 1)::text,
             updated_at = now()
         where identifier = $1 and value ~ '^v1:[0-9a-f]{64}:[^:]+:[0-4]$'
         returning right(value, 1)::int as failures`,
        [`password-reset:${id}`],
      );
      return result.rows[0]?.failures;
    },

    async deleteResetToken(id, db) {
      const result = await db.query('delete from auth.verification where identifier = $1', [
        `password-reset:${id}`,
      ]);
      return (result.rowCount ?? 0) > 0;
    },
  };
}
