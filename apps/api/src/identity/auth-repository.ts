/**
 * The only module through which the identity code reads `apikey`, `invitation`,
 * `member`, `session`, `user` and `account` (043 design D14, Resolved decision Q69).
 *
 * The `auth` schema has no row-level security, so every function on a tenant-keyed
 * model requires a `tenantId` and filters by it. `user` and `account` hold no tenant:
 * their readers, and the two global reads of tenant-keyed models, are named `global…`.
 * All SQL is parameterized and no read selects the hashed `key` column.
 */
import type { Pool } from 'pg';

export interface ApiKeyRead {
  readonly id: string;
  readonly name: string | null;
  readonly referenceId: string;
}

export interface InvitationRead {
  readonly id: string;
  readonly organizationId: string;
  readonly email: string;
  readonly status: string;
  readonly expiresAt: Date;
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

export interface AuthRepository {
  listApiKeys: (
    tenantId: string,
    page: { limit: number; cursor?: string },
  ) => Promise<{ keys: ApiKeyRead[]; nextCursor?: string }>;
  apiKeyById: (tenantId: string, keyId: string) => Promise<ApiKeyRead | undefined>;
  invitationById: (tenantId: string, invitationId: string) => Promise<InvitationRead | undefined>;
  listMembers: (tenantId: string) => Promise<MemberRead[]>;
  memberOf: (tenantId: string, userId: string) => Promise<MemberRead | undefined>;
  userInTenant: (tenantId: string, userId: string) => Promise<UserRead | undefined>;
  sessionsOf: (tenantId: string, userId: string) => Promise<SessionRead[]>;
  /** Deletes one membership of the tenant; true when a row went. */
  deleteMember: (tenantId: string, memberId: string) => Promise<boolean>;
  /** Deletes the user's sessions whose active organization is the tenant; rows deleted. */
  deleteSessionsOf: (tenantId: string, userId: string) => Promise<number>;
  globalUserByEmail: (email: string) => Promise<UserRead | undefined>;
  globalUserById: (userId: string) => Promise<UserRead | undefined>;
  globalAccountByKey: (providerId: string, accountId: string) => Promise<AccountRead | undefined>;
  globalAccountsOf: (userId: string) => Promise<AccountRead[]>;
  globalInvitationById: (invitationId: string) => Promise<InvitationRead | undefined>;
  /** Tenant ids only, one per membership of the user. */
  globalMembershipTenantsOf: (userId: string) => Promise<string[]>;
}

interface ApiKeyRow {
  id: string;
  name: string | null;
  reference_id: string;
}
interface InvitationRow {
  id: string;
  organization_id: string;
  email: string;
  status: string;
  expires_at: Date;
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
});
const toInvitation = (r: InvitationRow): InvitationRead => ({
  id: r.id,
  organizationId: r.organization_id,
  email: r.email,
  status: r.status,
  expiresAt: r.expires_at,
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
  const INVITATION_COLUMNS = 'id, organization_id, email, status, expires_at';

  return {
    async listApiKeys(tenantId, page) {
      requireTenant(tenantId);
      // Keyset paging on the id; one extra row tells whether the end was reached.
      const result = await authPool.query<ApiKeyRow>(
        `select id, name, reference_id from auth.apikey
         where reference_id = $1 and ($2::text is null or id > $2)
         order by id limit $3`,
        [tenantId, page.cursor ?? null, page.limit + 1],
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
        'select id, name, reference_id from auth.apikey where reference_id = $1 and id = $2',
        [tenantId, keyId],
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

    async listMembers(tenantId) {
      requireTenant(tenantId);
      const result = await authPool.query<MemberRow>(
        `select ${MEMBER_COLUMNS} from auth.member where organization_id = $1 order by id`,
        [tenantId],
      );
      return result.rows.map(toMember);
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
  };
}
