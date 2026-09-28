/**
 * Better Auth schema (task 2.2, design D2/D6). Drizzle table definitions for
 * the plugin set `packages/auth/src/auth.ts` registers (`organization`,
 * `admin`, `twoFactor`, `jwt`, `apiKey`). `@tayzu/db`'s `drizzle.config.ts`
 * globs this file, alongside `packages/catalog/src/persistence/schema.ts`,
 * to generate `migrations/0002_auth_schema.sql`; this package never runs
 * `drizzle-kit` itself and never hand-writes migration SQL (design D1).
 *
 * The table set and every field were derived by calling `getAuthTables`
 * (`@better-auth/core/db`) with exactly this plugin list, and by applying
 * `@better-auth/drizzle-adapter`'s own CLI schema-generator's field-to-column
 * mapping (`generateDrizzleSchema`, PostgreSQL branch) — both checked against
 * the installed `@better-auth/core@1.7.6`/`@better-auth/drizzle-adapter@1.7.6`
 * source, not the docs site (`project.md` §17). `packages/auth/src/auth.ts`
 * never sets `camelCase`, so every table and column name below is the
 * generator's snake_case default (`convertToSnakeCase`), matching this
 * project's existing convention. Two differences from the generator's own
 * literal output, kept for consistency with
 * `packages/catalog/src/persistence/schema.ts` and functionally identical
 * for Better Auth's own queries: unique columns are declared as named
 * table-level `unique(...)` constraints rather than inline, unnamed
 * `.unique()` chains, and the generator's Drizzle "relations" export
 * (`defineRelationsPart`, a `drizzle-orm` 1.0 API) is omitted — the installed
 * `drizzle-orm@0.45.3` does not export it, and nothing here needs it: no
 * query in this codebase goes through Drizzle's relational query builder.
 *
 * Every table lives under Postgres schema `auth` (`pgSchema('auth')`), never
 * `public` (design D2). None of them carry a `tenant_id` column: `tenant_id
 * = organization.id` (design D3), `organization` itself is the tenant and
 * needs no parent scope, and `user`/`session`/`account` are cross-org by
 * design. Grants (`tayzu_auth`'s full CRUD on this schema, and nothing on
 * any `catalog_*` table) are not expressible through Drizzle and land as the
 * hand-written custom SQL companion migration (design D6, Migration Plan
 * step 1) — this file defines no `pgRole`/`pgPolicy`, unlike the catalog
 * schema: Better Auth's own tables are never tenant-scoped rows, so RLS does
 * not apply to them (design D6).
 */
import {
  boolean,
  foreignKey,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

/** Every Better Auth table for this plugin set lives here, never in `public`. */
export const authSchema = pgSchema('auth');

/** `organization`, `admin` and `two-factor` all extend this base user model. */
export const user = authSchema.table(
  'user',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text('image'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    // `admin` plugin fields:
    role: text('role'),
    banned: boolean('banned').default(false),
    banReason: text('ban_reason'),
    banExpires: timestamp('ban_expires', { withTimezone: true }),
    // `two-factor` plugin field:
    twoFactorEnabled: boolean('two_factor_enabled').default(false),
  },
  (t) => [unique('user_email_uq').on(t.email)],
);

/** One row per active session; `activeOrganizationId` is the tenant (design D3). */
export const session = authSchema.table(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .$onUpdate(() => new Date()),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id').notNull(),
    // `organization` plugin field:
    activeOrganizationId: text('active_organization_id'),
    // `admin` plugin field:
    impersonatedBy: text('impersonated_by'),
  },
  (t) => [
    unique('session_token_uq').on(t.token),
    index('session_user_id_idx').on(t.userId),
    foreignKey({
      name: 'session_user_id_fk',
      columns: [t.userId],
      foreignColumns: [user.id],
    }).onDelete('cascade'),
  ],
);

/** One row per linked credential (password, or a future OAuth provider). */
export const account = authSchema.table(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('account_user_id_idx').on(t.userId),
    foreignKey({
      name: 'account_user_id_fk',
      columns: [t.userId],
      foreignColumns: [user.id],
    }).onDelete('cascade'),
  ],
);

/** Short-lived tokens for email verification and similar out-of-band checks. */
export const verification = authSchema.table(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
);

/** `organization` plugin: one row per tenant (design D3, "tenantId = organization.id"). */
export const organization = authSchema.table(
  'organization',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    logo: text('logo'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    metadata: text('metadata'),
  },
  (t) => [unique('organization_slug_uq').on(t.slug)],
);

/** `organization` plugin: an organization/user pair and its role. */
export const member = authSchema.table(
  'member',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull(),
    userId: text('user_id').notNull(),
    role: text('role').notNull().default('member'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('member_organization_id_idx').on(t.organizationId),
    index('member_user_id_idx').on(t.userId),
    foreignKey({
      name: 'member_organization_id_fk',
      columns: [t.organizationId],
      foreignColumns: [organization.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'member_user_id_fk',
      columns: [t.userId],
      foreignColumns: [user.id],
    }).onDelete('cascade'),
  ],
);

/** `organization` plugin: a pending invitation to join an organization. */
export const invitation = authSchema.table(
  'invitation',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id').notNull(),
    email: text('email').notNull(),
    role: text('role'),
    status: text('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    inviterId: text('inviter_id').notNull(),
  },
  (t) => [
    index('invitation_organization_id_idx').on(t.organizationId),
    index('invitation_email_idx').on(t.email),
    foreignKey({
      name: 'invitation_organization_id_fk',
      columns: [t.organizationId],
      foreignColumns: [organization.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'invitation_inviter_id_fk',
      columns: [t.inviterId],
      foreignColumns: [user.id],
    }).onDelete('cascade'),
  ],
);

/** `two-factor` plugin: TOTP secret and backup codes for one user. */
export const twoFactor = authSchema.table(
  'two_factor',
  {
    id: text('id').primaryKey(),
    secret: text('secret').notNull(),
    backupCodes: text('backup_codes').notNull(),
    userId: text('user_id').notNull(),
    verified: boolean('verified').default(true),
    failedVerificationCount: integer('failed_verification_count').default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
  },
  (t) => [
    index('two_factor_secret_idx').on(t.secret),
    index('two_factor_user_id_idx').on(t.userId),
    foreignKey({
      name: 'two_factor_user_id_fk',
      columns: [t.userId],
      foreignColumns: [user.id],
    }).onDelete('cascade'),
  ],
);

/** `jwt` plugin: the signing keyset served at `/jwks` (design D5). */
export const jwks = authSchema.table('jwks', {
  id: text('id').primaryKey(),
  publicKey: text('public_key').notNull(),
  privateKey: text('private_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  alg: text('alg'),
  crv: text('crv'),
});

/** `apiKey` plugin: long-lived machine credentials (design D5). */
export const apikey = authSchema.table(
  'apikey',
  {
    id: text('id').primaryKey(),
    configId: text('config_id').notNull().default('default'),
    name: text('name'),
    start: text('start'),
    referenceId: text('reference_id').notNull(),
    prefix: text('prefix'),
    key: text('key').notNull(),
    refillInterval: integer('refill_interval'),
    refillAmount: integer('refill_amount'),
    lastRefillAt: timestamp('last_refill_at', { withTimezone: true }),
    enabled: boolean('enabled').default(true),
    rateLimitEnabled: boolean('rate_limit_enabled').default(true),
    rateLimitTimeWindow: integer('rate_limit_time_window').default(86_400_000),
    rateLimitMax: integer('rate_limit_max').default(10),
    requestCount: integer('request_count').default(0),
    remaining: integer('remaining'),
    lastRequest: timestamp('last_request', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    permissions: text('permissions'),
    metadata: text('metadata'),
  },
  (t) => [
    index('apikey_config_id_idx').on(t.configId),
    index('apikey_reference_id_idx').on(t.referenceId),
    index('apikey_key_idx').on(t.key),
  ],
);
