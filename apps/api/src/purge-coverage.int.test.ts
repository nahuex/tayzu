/**
 * Integration test for task 6.7 of 045-org-deletion-and-data-retention: the purge's
 * completeness test (design D2, Resolved decisions Q150, Q151, Q163 and Q164). It covers
 * the spec scenario:
 *
 * > #### Scenario: A new table or identifier family cannot escape the purge
 * >
 * > - **WHEN** a table with a `tenant_id` column, an `auth` table that references an
 * >   organization or a user (by foreign key or by column), or a new `auth.verification`
 * >   identifier pattern is added that no purge step covers
 * > - **THEN** the completeness test fails until it is covered or exempted with a reason
 * > - **AND** on the real schema it passes with `mfa-reenrol:` and `invitation-shed:`
 * >   purged, and `password-reset:` and `auth.rate_limit` exempt, each with its reason
 *
 * The classification below is this test's own table, and the checker is this file's
 * `checkCoverage`. The checker is driven by the database catalog, not by a list: it
 * enumerates (1) every table, in every schema, that has a `tenant_id` column, (2) every
 * table of the `auth` schema, (3) every column that references `auth.user` or
 * `auth.organization` by foreign key (any schema) and every `auth` column whose name says
 * it holds a user, organization or tenant id (`apikey.reference_id` and
 * `session.active_organization_id` have no foreign key), and (4) the identifiers it is
 * given, each of which must match a classified `auth.verification` family. Each subject
 * must be `deleted by step 1`, `deleted by step 2`, `deleted by the request (Q170)` (by
 * `identity.organization.delete`, with the tenant's sessions) or `exempt`, with a reason.
 * The checker
 * also fails when a prefix declared by `044`'s `identity/verification-families.int.test.ts`
 * is not a family of the table: that list is not exported (it lives in a test file, which
 * cannot be imported without registering its tests), so it is parsed from the file's
 * source (`DECLARED_PREFIXES`), and the parse itself fails loudly if the list moves.
 *
 * Cases:
 * - The real schema (the shared, migrated database) passes, every Verify family is
 *   classified as the design says, and the scenario's AND clause holds.
 * - The identifiers the real writers produce (the reset token store, the MFA re-enrolment
 *   marker and a Better Auth SSO sign-in start, which writes an `auth-state:<state>` row
 *   to `auth.verification`) are all classified; rows are found by this run's ids only.
 * - A private scratch database, migrated by the harness's `runMigrations` (as `0011`'s
 *   tests do), passes as migrated, and fails once a scratch migration adds a `tenant_id`
 *   table (in `public` and in another schema), an `auth` table referencing a user by
 *   column and an organization by foreign key, or an `auth.verification` row of an
 *   unlisted identifier pattern (in that private database the whole table is scanned).
 * - The checker fails when a declared `044` prefix is missing from the table.
 * - Every `deleted by step N` line is proved on the real schema: one row of that kind is
 *   seeded for a due tenant (the sibling purge tests' shapes), `purgeCatalogStep` and then
 *   `purgeAuthStep` run as `tayzu_purge`, and the row is gone after its step.
 * - Every `deleted by the request (Q170)` line names the request test that proves it
 *   (`identity/org-deletion.int.test.ts`, which seeds the rows as `reauthorization.ts`
 *   writes them, calls `identity.organization.delete` and asserts them gone, and another
 *   tenant's rows kept); this file checks that the named test exists in that file.
 *
 * Every id is random per run; other files' due markers share the database (and a sibling
 * runs a pass over every due tenant), so assertions on the shared database are scoped to
 * this file's rows, and no assertion depends on a row surviving another file's pass.
 */
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { runMigrations } from '@tayzu/db';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  getOwnerPool,
  getPurgeTestDatabase,
  getTestDatabase,
} from '../../../packages/db/src/harness.js';
import { startOidcStub, type OidcStub } from '../../../packages/auth/src/__fixtures__/oidc-stub.js';
import { TEST_SECRET } from '../../../packages/auth/src/__fixtures__/test-secret.js';
import { purgeAuthStep, purgeCatalogStep } from '../scripts/purge-job.js';
import { harnessPools } from './__fixtures__/pools.js';
import { createAuthRepository } from './identity/auth-repository.js';
import { createResetTokenStore } from './identity/reset-token-store.js';
import { createWithUserLock } from './identity/user-lock.js';
import { createApp, type App } from './server.js';

// ---------------------------------------------------------------------------
// The classification (this test's table).

type Coverage =
  'deleted by step 1' | 'deleted by step 2' | 'deleted by the request (Q170)' | 'exempt';

interface Classification {
  readonly coverage: Coverage;
  readonly reason: string;
}

/**
 * Every schema subject, keyed as the checker names it: `tenant table <schema>.<table>`,
 * `auth table auth.<table>` and `reference column <schema>.<table>.<column>`.
 */
const SCHEMA_CLASSIFICATION: Readonly<Record<string, Classification>> = {
  // Tables with a `tenant_id` column (step 1 names the seven catalog tables one by one).
  'tenant table public.catalog_blueprint': {
    coverage: 'deleted by step 1',
    reason: 'tenant catalog data; deleted after the entities and relation definitions',
  },
  'tenant table public.catalog_relation_definition': {
    coverage: 'deleted by step 1',
    reason: 'tenant catalog data; deleted after the entity relations that reference it',
  },
  'tenant table public.catalog_entity': {
    coverage: 'deleted by step 1',
    reason: 'tenant catalog data; deleted after the entity relations that reference it',
  },
  'tenant table public.catalog_entity_relation': {
    coverage: 'deleted by step 1',
    reason: 'tenant catalog data; deleted first (RESTRICT foreign keys)',
  },
  'tenant table public.catalog_change_event': {
    coverage: 'deleted by step 1',
    reason: 'append-only audit rows; the trigger and 0013 admit tayzu_purge for a due tenant',
  },
  'tenant table public.catalog_tenant_sequence': {
    coverage: 'deleted by step 1',
    reason: 'the tenant change-event counter',
  },
  'tenant table public.machine_credential_revocation': {
    coverage: 'deleted by step 1',
    reason: 'the tenant machine-credential revocations',
  },
  'tenant table public.tenant_deletion_marker': {
    coverage: 'exempt',
    reason:
      'the purge own tombstone (design D2): tenant id, state, timestamps and opaque actor ids, ' +
      'no free text; it is what makes a later run find nothing to purge',
  },

  // Every table of the `auth` schema.
  'auth table auth.organization': {
    coverage: 'deleted by step 2',
    reason: 'the tenant organization row, deleted last, after the completion event',
  },
  'auth table auth.member': {
    coverage: 'deleted by step 2',
    reason: 'the tenant memberships, after the users and the organization-keyed rows',
  },
  'auth table auth.invitation': {
    coverage: 'deleted by step 2',
    reason: 'the tenant invitations, before any user (Q163)',
  },
  'auth table auth.apikey': {
    coverage: 'deleted by step 2',
    reason: 'the tenant API keys, by reference_id',
  },
  'auth table auth.session': {
    coverage: 'deleted by step 2',
    reason: 'the sessions of leaving users and the sessions active in the tenant',
  },
  'auth table auth.user': {
    coverage: 'deleted by step 2',
    reason: 'users with no membership outside due tenants, one transaction per user',
  },
  'auth table auth.account': {
    coverage: 'deleted by step 2',
    reason: 'the accounts of leaving users',
  },
  'auth table auth.two_factor': {
    coverage: 'deleted by step 2',
    reason: 'the second factors of leaving users',
  },
  'auth table auth.verification': {
    coverage: 'deleted by step 2',
    reason: 'by identifier family: each family is a line of IDENTIFIER_FAMILIES',
  },
  'auth table auth.rate_limit': {
    coverage: 'exempt',
    reason:
      'Q151: a count and a timestamp under an unsalted SHA-256 of a tenant id, a user id, an ' +
      'IP or a keyed email hash, no personal data in clear, and no grant for tayzu_purge; ' +
      'the rows persist (the erasure statement of 10.3 says so; 044 ticket "Prune ' +
      'auth.rate_limit")',
  },
  'auth table auth.jwks': {
    coverage: 'exempt',
    reason: 'the platform signing keys, neither per tenant nor per user',
  },

  // Columns that reference a user or an organization, by foreign key or by column name.
  'reference column auth.account.user_id': {
    coverage: 'deleted by step 2',
    reason: 'with the leaving user, before the user (foreign key)',
  },
  'reference column auth.apikey.reference_id': {
    coverage: 'deleted by step 2',
    reason: 'the organization id with no foreign key; deleted by reference_id',
  },
  'reference column auth.invitation.organization_id': {
    coverage: 'deleted by step 2',
    reason: 'the tenant invitations, before any user (Q163)',
  },
  'reference column auth.invitation.inviter_id': {
    coverage: 'deleted by step 2',
    reason:
      'an invitation a leaving user sent in a tenant that is not due goes with the user ' +
      '(invitation_inviter_id_fk ON DELETE CASCADE, Q164)',
  },
  'reference column auth.member.organization_id': {
    coverage: 'deleted by step 2',
    reason: 'every membership of the tenant, those of staying users included',
  },
  'reference column auth.member.user_id': {
    coverage: 'deleted by step 2',
    reason:
      'a leaving user membership in another due tenant goes with the user (ON DELETE CASCADE)',
  },
  'reference column auth.session.user_id': {
    coverage: 'deleted by step 2',
    reason: 'the sessions of leaving users',
  },
  'reference column auth.session.active_organization_id': {
    coverage: 'deleted by step 2',
    reason: 'the organization id with no foreign key: sessions of staying users active there',
  },
  'reference column auth.session.impersonated_by': {
    coverage: 'exempt',
    reason:
      'an admin-plugin user id with no foreign key; /admin/impersonate-user is not on the ' +
      'auth route allowlist, so nothing writes it, and the session itself is deleted by its ' +
      'own user_id or active_organization_id',
  },
  'reference column auth.two_factor.user_id': {
    coverage: 'deleted by step 2',
    reason: 'with the leaving user (foreign key)',
  },
};

interface IdentifierFamily extends Classification {
  /** The family's literal prefix, as `044` declares families (`password-reset:`). */
  readonly family: string;
  /** The whole identifier; the random-keyed families are matched by shape, not by prefix. */
  readonly pattern: RegExp;
}

/** Every `auth.verification` identifier family `002`, `043`, `044` and Better Auth write. */
const IDENTIFIER_FAMILIES: readonly IdentifierFamily[] = [
  {
    family: 'invitation-accept:',
    pattern: /^invitation-accept:.+$/,
    coverage: 'deleted by step 2',
    reason: 'the tenant invitation tokens, before the invitations (Q150, Q163)',
  },
  {
    family: 'invitation-shed:',
    pattern: /^invitation-shed:.+$/,
    coverage: 'deleted by step 2',
    reason: 'the tenant shed records, with the invitation tokens (Q150)',
  },
  {
    family: 'temp-password:',
    pattern: /^temp-password:.+$/,
    coverage: 'deleted by step 2',
    reason: 'keyed by a leaving user id, before the user',
  },
  {
    family: 'mfa-reenrol:',
    pattern: /^mfa-reenrol:.+$/,
    coverage: 'deleted by step 2',
    reason: 'keyed by a leaving user id, before the user (Q150, 044 D18)',
  },
  {
    family: 'sso-link:',
    pattern: /^sso-link:.+$/,
    coverage: 'deleted by step 2',
    reason: 'keyed by a leaving user account id, before the account',
  },
  {
    family: 'step-up-verified:',
    pattern: /^step-up-verified:.+$/,
    coverage: 'deleted by step 2',
    reason: 'keyed by session token; the markers go before the sessions they name',
  },
  {
    family: 'sso-reauth-state:',
    pattern: /^sso-reauth-state:.+$/,
    coverage: 'deleted by the request (Q170)',
    reason:
      'Q170: 600 s state keyed by a random value, whose value starts with the session token; ' +
      'identity.organization.delete deletes the rows of the tenant sessions it deletes, on ' +
      'the tayzu_auth pool; step 2 cannot, no 0014 policy joins it and no session is left',
  },
  {
    family: 'sso-reauth-result:',
    pattern: /^sso-reauth-result:.+$/,
    coverage: 'deleted by the request (Q170)',
    reason:
      'Q170: 330 s result keyed by a session token, holding an id_token (personal data); ' +
      'identity.organization.delete deletes it with the tenant sessions, on the tayzu_auth ' +
      'pool; step 2 cannot, no 0014 policy joins it and no session is left',
  },
  {
    family: 'backchannel-logout:',
    pattern: /^backchannel-logout:[^:]+:.+$/,
    coverage: 'exempt',
    reason: 'replay state keyed by the identity provider client and token id, not by tenant',
  },
  {
    family: '2fa-',
    pattern: /^2fa-[A-Za-z0-9_-]{20}$/,
    coverage: 'exempt',
    reason:
      'Better Auth two-factor challenge of an enrolled sign-in: short-lived state keyed by a ' +
      'random value, with its own expiry',
  },
  {
    family: '2fa-attempts-2fa-',
    pattern: /^2fa-attempts-2fa-[A-Za-z0-9_-]{20}$/,
    coverage: 'exempt',
    reason:
      'Better Auth two-factor attempt counter of that challenge: short-lived, keyed by the same ' +
      'random value, with its own expiry',
  },
  {
    family: 'password-reset:',
    pattern: /^password-reset:.+$/,
    coverage: 'exempt',
    reason:
      'Q150: 044 reset token, 30-minute state whose identifier holds neither a tenant nor a ' +
      'user, so no identifier-family policy can join it; cleaned by the next issue',
  },
  {
    family: 'auth-state:',
    pattern: /^auth-state:[A-Za-z0-9_-]{32}$/,
    coverage: 'exempt',
    reason:
      'Better Auth OAuth state an SSO sign-in writes (shown below): 10-minute state keyed by a ' +
      'random value, consumed by the callback, with its own expiry',
  },
];

// ---------------------------------------------------------------------------
// The checker.

type Queryable = Pick<Pool, 'query'>;

/** An `auth` column whose name says it holds a user, organization or tenant id. */
const REFERENCE_COLUMN_NAME = /(^|_)(user|organization|org|tenant|inviter|reference)_id$|_by$/;

/** Every schema subject the catalog shows, as the keys of `SCHEMA_CLASSIFICATION`. */
async function enumerateSchemaSubjects(pool: Queryable): Promise<string[]> {
  const subjects = new Set<string>();

  const tenantTables = await pool.query<{ schema: string; name: string }>(
    `select n.nspname as schema, c.relname as name
       from pg_attribute a
       join pg_class c on c.oid = a.attrelid
       join pg_namespace n on n.oid = c.relnamespace
      where a.attname = 'tenant_id' and a.attnum > 0 and not a.attisdropped
        and c.relkind in ('r', 'p') and not c.relispartition
        and n.nspname not in ('pg_catalog', 'information_schema')
        and n.nspname not like 'pg\\_%'`,
  );
  for (const row of tenantTables.rows) subjects.add(`tenant table ${row.schema}.${row.name}`);

  const authColumns = await pool.query<{ name: string; column: string | null }>(
    `select c.relname as name, a.attname as column
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       left join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      where n.nspname = 'auth' and c.relkind in ('r', 'p') and not c.relispartition`,
  );
  for (const row of authColumns.rows) {
    subjects.add(`auth table auth.${row.name}`);
    if (row.column !== null && REFERENCE_COLUMN_NAME.test(row.column)) {
      subjects.add(`reference column auth.${row.name}.${row.column}`);
    }
  }

  const foreignKeys = await pool.query<{ schema: string; name: string; column: string }>(
    `select n.nspname as schema, c.relname as name, a.attname as column
       from pg_constraint con
       join pg_class c on c.oid = con.conrelid
       join pg_namespace n on n.oid = c.relnamespace
       join pg_class rc on rc.oid = con.confrelid
       join pg_namespace rn on rn.oid = rc.relnamespace
       cross join lateral unnest(con.conkey) as k(attnum)
       join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
      where con.contype = 'f' and rn.nspname = 'auth' and rc.relname in ('user', 'organization')`,
  );
  for (const row of foreignKeys.rows) {
    subjects.add(`reference column ${row.schema}.${row.name}.${row.column}`);
  }

  return [...subjects].sort();
}

interface CoverageInput {
  readonly classification: Readonly<Record<string, Classification>>;
  readonly families: readonly IdentifierFamily[];
  /** The families another change declares (`044`'s `DECLARED_PREFIXES`). */
  readonly declaredPrefixes: readonly string[];
  /** `auth.verification` identifiers seen; each must match a classified family. */
  readonly identifiers: readonly string[];
}

/**
 * The completeness check: resolves to the problems found, empty when every subject the
 * catalog shows, every declared prefix and every identifier is classified with a reason.
 */
async function checkCoverage(pool: Queryable, input: CoverageInput): Promise<string[]> {
  const problems: string[] = [];
  const subjects = await enumerateSchemaSubjects(pool);
  for (const subject of subjects) {
    if (!Object.hasOwn(input.classification, subject)) {
      problems.push(`unclassified: ${subject}`);
    }
  }
  for (const [subject, entry] of Object.entries(input.classification)) {
    if (!subjects.includes(subject)) problems.push(`classified but not in the schema: ${subject}`);
    if (entry.reason.trim() === '') problems.push(`no reason: ${subject}`);
  }
  for (const family of input.families) {
    if (family.reason.trim() === '') problems.push(`no reason: family ${family.family}`);
  }
  for (const prefix of input.declaredPrefixes) {
    if (!input.families.some((family) => family.family === prefix)) {
      problems.push(`declared prefix not classified: ${prefix}`);
    }
  }
  for (const identifier of input.identifiers) {
    if (!input.families.some((family) => family.pattern.test(identifier))) {
      problems.push(`unclassified identifier: ${identifier}`);
    }
  }
  return problems;
}

/** `044`'s declared list, parsed from its test file's source (it is not exported). */
function declaredPrefixesOf044(): string[] {
  const source = readFileSync(
    new URL('./identity/verification-families.int.test.ts', import.meta.url),
    'utf8',
  );
  const list = /const DECLARED_PREFIXES\b[^=]*=\s*\[([^\]]*)\]/.exec(source)?.[1];
  if (list === undefined) {
    throw new Error('DECLARED_PREFIXES was not found in verification-families.int.test.ts');
  }
  return [...list.matchAll(/'([^']*)'/g)].map((match) => match[1] ?? '');
}

const REAL_INPUT: Omit<CoverageInput, 'identifiers' | 'declaredPrefixes'> = {
  classification: SCHEMA_CLASSIFICATION,
  families: IDENTIFIER_FAMILIES,
};

function familyOf(prefix: string): IdentifierFamily | undefined {
  return IDENTIFIER_FAMILIES.find((family) => family.family === prefix);
}

// ---------------------------------------------------------------------------
// Scratch database (pattern of `0011`'s tests and `reconcile-users.int.test.ts`).

const SCRATCH_NAME_PATTERN = /^[a-z0-9_]+$/;

function ownerUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url.trim() === '') {
    throw new Error(
      'DATABASE_URL is not set: the int project global setup should have stopped this run.',
    );
  }
  return url;
}

function scratchUrl(name: string): string {
  const url = new URL(ownerUrl());
  url.pathname = `/${name}`;
  return url.href;
}

/** A random lower-case name, checked before it reaches any DDL. */
function safeName(prefix: string): string {
  const name = `${prefix}${randomUUID().replaceAll('-', '')}`;
  if (!SCRATCH_NAME_PATTERN.test(name)) {
    throw new Error(`generated scratch name is unsafe: ${name}`);
  }
  return name;
}

async function endQuietly(pool: Pool): Promise<void> {
  pool.on('error', () => undefined);
  await pool.end();
}

// ---------------------------------------------------------------------------
// Seeding on the shared database (shapes of `org-purge-catalog` and `org-purge-auth`).

function randomToken(): string {
  return randomBytes(24).toString('hex');
}

async function ownerQuery(statement: string, params: unknown[]): Promise<void> {
  const owner = await getOwnerPool();
  await owner.query(statement, params);
}

async function ownerExists(statement: string, params: unknown[]): Promise<boolean> {
  const owner = await getOwnerPool();
  const { rows } = await owner.query<{ present: boolean }>(
    `select exists (${statement}) as present`,
    params,
  );
  return rows[0]?.present === true;
}

/** One row of every step-1 table for `tenantId`, through `tayzu_app` under the tenant GUC. */
async function seedCatalogRows(tenantId: string): Promise<void> {
  const app = (await getTestDatabase()).pool;
  const actorId = `actor-${randomUUID()}`;
  const [serviceId, teamId, definitionId, apiId, ownersId] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  const client = await app.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    for (const [id, identifier] of [
      [serviceId, 'service'],
      [teamId, 'team'],
    ] as const) {
      await client.query(
        `insert into catalog_blueprint
           (id, tenant_id, identifier, title, schema, version, created_at, created_by_type,
            created_by_id, updated_at, updated_by_type, updated_by_id)
         values ($1, $2, $3, to_jsonb($3::text), '{}'::jsonb, 1, now(), 'user', $4,
                 now(), 'user', $4)`,
        [id, tenantId, identifier, actorId],
      );
    }
    await client.query(
      `insert into catalog_relation_definition
         (id, tenant_id, source_blueprint_id, identifier, title, target_blueprint_id, many, required)
       values ($1, $2, $3, 'owned_by', '"Owned by"'::jsonb, $4, false, false)`,
      [definitionId, tenantId, serviceId, teamId],
    );
    for (const [id, blueprintId, identifier] of [
      [apiId, serviceId, 'api'],
      [ownersId, teamId, 'owners'],
    ] as const) {
      await client.query(
        `insert into catalog_entity
           (id, tenant_id, blueprint_id, identifier, title, spec_properties, generation, version,
            created_at, created_by_type, created_by_id, updated_at, updated_by_type, updated_by_id)
         values ($1, $2, $3, $4, $4, '{}'::jsonb, 1, 1, now(), 'user', $5, now(), 'user', $5)`,
        [id, tenantId, blueprintId, identifier, actorId],
      );
    }
    await client.query(
      `insert into catalog_entity_relation
         (tenant_id, source_entity_id, relation_definition_id, scope, target_entity_id, position)
       values ($1, $2, $3, 'spec', $4, 0)`,
      [tenantId, apiId, definitionId, ownersId],
    );
    await client.query(
      `insert into catalog_change_event
         (tenant_id, seq, occurred_at, actor_type, actor_id, action, resource_kind,
          blueprint_identifier, resource_identifier, version, changed_fields, snapshot)
       values ($1, 1, now(), 'user', $2, 'created', 'entity', 'service', 'api', 1,
               '{}'::text[], '{}'::jsonb)`,
      [tenantId, actorId],
    );
    await client.query('insert into catalog_tenant_sequence (tenant_id, last_seq) values ($1, 1)', [
      tenantId,
    ]);
    await client.query(
      `insert into machine_credential_revocation (credential_id, revoked_at, tenant_id)
       values ($1, now(), $2)`,
      [randomUUID(), tenantId],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/** A pending marker due fifteen days after its request, step 1 not yet recorded. */
async function seedDueMarker(tenantId: string): Promise<void> {
  await ownerQuery(
    `insert into tenant_deletion_marker (tenant_id, requested_at, purge_after, requested_by)
     values ($1, now() - interval '15 days', now() - interval '1 day', $2)`,
    [tenantId, `actor-${randomUUID()}`],
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

async function seedSession(
  userId: string,
  activeOrganizationId: string | null,
): Promise<{ id: string; token: string }> {
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

async function seedVerification(identifier: string, value: string): Promise<string> {
  const id = `verification-${randomUUID()}`;
  await ownerQuery(
    `insert into auth.verification (id, identifier, value, expires_at, created_at, updated_at)
     values ($1, $2, $3, now() + interval '30 minutes', now(), now())`,
    [id, identifier, value],
  );
  return id;
}

/** A row the proof watches: present while `present()` resolves true. */
interface Probe {
  readonly label: string;
  readonly present: () => Promise<boolean>;
}

/** `table` is a fixed `auth` table literal of this file. */
function authRowProbe(table: string, id: string, label: string): Probe {
  return {
    label,
    present: () => ownerExists(`select 1 from auth."${table}" where id = $1`, [id]),
  };
}

/** `table` is a fixed step-1 table literal of this file. */
function tenantRowsProbe(table: string, tenantId: string): Probe {
  return {
    label: `${table} rows of the due tenant`,
    present: () => ownerExists(`select 1 from ${table} where tenant_id = $1`, [tenantId]),
  };
}

const STEP_1_TABLES = [
  'catalog_blueprint',
  'catalog_relation_definition',
  'catalog_entity',
  'catalog_entity_relation',
  'catalog_change_event',
  'catalog_tenant_sequence',
  'machine_credential_revocation',
] as const;

/**
 * The proof world. Once `markDue` runs, `due` is due (step 1 not recorded) and so is
 * `otherDue` (never run here); `other` has no marker.
 *
 * - `leaver` belongs to `due` and `otherDue` only: an account, a second factor, a session
 *   with no active organization and its `step-up-verified:` marker, the `temp-password:`,
 *   `mfa-reenrol:` and `sso-link:` markers, a `password-reset:` row, and an invitation it
 *   sent in `other` (Q164).
 * - `stayer` belongs to `due` and `other`: a session active in `due`, and an invitation it
 *   sent in `due` with its `invitation-accept:` token and `invitation-shed:` record.
 * - `due` has an API key and one row of every step-1 table.
 */
async function seedProofWorld() {
  const due = await seedOrganization();
  const other = await seedOrganization();
  const otherDue = await seedOrganization();
  await seedCatalogRows(due);

  const leaver = await seedUser();
  const leaverDueMember = await seedMember(due, leaver);
  const leaverOtherDueMember = await seedMember(otherDue, leaver);
  const leaverAccount = await seedAccount(leaver);
  const leaverTwoFactor = await seedTwoFactor(leaver);
  const leaverSession = await seedSession(leaver, null);
  const leaverOtherInvitation = await seedInvitation(other, leaver);
  const tempPassword = await seedVerification(`temp-password:${leaver}`, randomToken());
  const mfaReenrol = await seedVerification(`mfa-reenrol:${leaver}`, 'reset');
  const ssoLink = await seedVerification(`sso-link:${leaverAccount}`, leaver);
  const stepUp = await seedVerification(`step-up-verified:${leaverSession.token}`, 'mfa');
  const passwordReset = await seedVerification(
    `password-reset:${randomUUID()}`,
    `${randomToken()}:${leaver}`,
  );

  const stayer = await seedUser();
  const stayerDueMember = await seedMember(due, stayer);
  await seedMember(other, stayer);
  const stayerDueSession = await seedSession(stayer, due);
  const stayerInvitation = await seedInvitation(due, stayer);
  const invitationAccept = await seedVerification(
    `invitation-accept:${stayerInvitation}`,
    randomToken(),
  );
  const invitationShed = await seedVerification(`invitation-shed:${stayerInvitation}`, 'shed');
  const apiKey = await seedApiKey(due);

  const userRow = authRowProbe('user', leaver, 'the leaving user');
  const accountRow = authRowProbe('account', leaverAccount, 'the leaving user account');
  const twoFactorRow = authRowProbe('two_factor', leaverTwoFactor, 'the leaving user 2FA');
  const sessionRow = authRowProbe('session', leaverSession.id, 'the leaving user session');
  const apiKeyRow = authRowProbe('apikey', apiKey, 'the due tenant API key');
  const invitationRow = authRowProbe('invitation', stayerInvitation, 'an invitation of due');
  const tempPasswordRow = authRowProbe('verification', tempPassword, 'temp-password:<userId>');

  /** Keyed like the classification: subjects, then `family <prefix>`. */
  const probes: Record<string, Probe> = {
    'auth table auth.organization': authRowProbe('organization', due, 'the due organization'),
    'auth table auth.member': authRowProbe('member', leaverDueMember, 'the leaver member of due'),
    'auth table auth.invitation': invitationRow,
    'auth table auth.apikey': apiKeyRow,
    'auth table auth.session': sessionRow,
    'auth table auth.user': userRow,
    'auth table auth.account': accountRow,
    'auth table auth.two_factor': twoFactorRow,
    'auth table auth.verification': tempPasswordRow,
    'reference column auth.account.user_id': accountRow,
    'reference column auth.apikey.reference_id': apiKeyRow,
    'reference column auth.invitation.organization_id': invitationRow,
    'reference column auth.invitation.inviter_id': authRowProbe(
      'invitation',
      leaverOtherInvitation,
      'an invitation the leaver sent in a tenant that is not due (Q164)',
    ),
    'reference column auth.member.organization_id': authRowProbe(
      'member',
      stayerDueMember,
      'the stayer member of due',
    ),
    'reference column auth.member.user_id': authRowProbe(
      'member',
      leaverOtherDueMember,
      'the leaver member of another due tenant',
    ),
    'reference column auth.session.user_id': sessionRow,
    'reference column auth.session.active_organization_id': authRowProbe(
      'session',
      stayerDueSession.id,
      'the stayer session active in due',
    ),
    'reference column auth.two_factor.user_id': twoFactorRow,
    'family invitation-accept:': authRowProbe('verification', invitationAccept, 'token'),
    'family invitation-shed:': authRowProbe('verification', invitationShed, 'shed record'),
    'family temp-password:': tempPasswordRow,
    'family mfa-reenrol:': authRowProbe('verification', mfaReenrol, 'mfa-reenrol:<userId>'),
    'family sso-link:': authRowProbe('verification', ssoLink, 'sso-link:<accountId>'),
    'family step-up-verified:': authRowProbe('verification', stepUp, 'step-up marker'),
  };
  for (const table of STEP_1_TABLES) {
    probes[`tenant table public.${table}`] = tenantRowsProbe(table, due);
  }

  return {
    due,
    probes,
    passwordReset: authRowProbe('verification', passwordReset, 'password-reset:<id>'),
    /**
     * Writes the two due markers, after every row exists: a pass another file runs over
     * every due tenant can then only delete rows earlier, never leave a later seed behind.
     */
    markDue: async () => {
      await seedDueMarker(due);
      await seedDueMarker(otherDue);
    },
  };
}

/** Every classification line with this coverage, keyed as the proof world's probes are. */
function linesWith(coverage: Coverage): string[] {
  const subjects = Object.entries(SCHEMA_CLASSIFICATION)
    .filter(([, entry]) => entry.coverage === coverage)
    .map(([subject]) => subject);
  const families = IDENTIFIER_FAMILIES.filter((family) => family.coverage === coverage).map(
    (family) => `family ${family.family}`,
  );
  return [...subjects, ...families].sort();
}

/**
 * The proof of every `deleted by the request (Q170)` line: the title of the request test, in
 * `identity/org-deletion.int.test.ts`, that seeds the rows, calls the request and asserts
 * them gone (and another tenant's kept).
 */
const REQUEST_PROOFS: Readonly<Record<string, string>> = {
  'family sso-reauth-state:':
    "deletes the sso-reauth-state: and sso-reauth-result: rows keyed by the tokens of t1's deleted sessions, and leaves another tenant's rows (Q170)",
  'family sso-reauth-result:':
    "deletes the sso-reauth-state: and sso-reauth-result: rows keyed by the tokens of t1's deleted sessions, and leaves another tenant's rows (Q170)",
};

// ---------------------------------------------------------------------------

describe('purge completeness (task 6.7, spec "A new table or identifier family cannot escape the purge")', () => {
  it('passes on the real schema: every table and column the catalog shows and every 044 prefix is classified', async () => {
    const owner = await getOwnerPool();
    await runMigrations(owner);
    const declaredPrefixes = declaredPrefixesOf044();

    const problems = await checkCoverage(owner, {
      ...REAL_INPUT,
      declaredPrefixes,
      identifiers: [],
    });

    expect(problems).toEqual([]);
  }, 60_000);

  it("reads 044's declared prefixes from verification-families.int.test.ts", () => {
    const declared = declaredPrefixesOf044();
    expect(declared).toContain('password-reset:');
    expect(declared).toContain('mfa-reenrol:');
    for (const prefix of declared) {
      expect(familyOf(prefix), `044 prefix ${prefix} is a family of the table`).toBeDefined();
    }
  });

  it('classifies every family and table the design names, each with its reason (design D2)', async () => {
    const expected: Record<string, Coverage> = {
      'invitation-accept:': 'deleted by step 2',
      'invitation-shed:': 'deleted by step 2',
      'temp-password:': 'deleted by step 2',
      'mfa-reenrol:': 'deleted by step 2',
      'sso-link:': 'deleted by step 2',
      'step-up-verified:': 'deleted by step 2',
      'backchannel-logout:': 'exempt',
      '2fa-': 'exempt',
      '2fa-attempts-2fa-': 'exempt',
      'password-reset:': 'exempt',
      'sso-reauth-state:': 'deleted by the request (Q170)',
      'sso-reauth-result:': 'deleted by the request (Q170)',
    };
    for (const [prefix, coverage] of Object.entries(expected)) {
      expect(familyOf(prefix)?.coverage, `family ${prefix}`).toBe(coverage);
    }
    for (const family of IDENTIFIER_FAMILIES) {
      expect(family.reason.trim(), `reason of ${family.family}`).not.toBe('');
    }
    expect(SCHEMA_CLASSIFICATION['auth table auth.rate_limit']?.coverage).toBe('exempt');
    expect(SCHEMA_CLASSIFICATION['auth table auth.jwks']?.coverage).toBe('exempt');
    for (const subject of [
      'reference column auth.apikey.reference_id',
      'reference column auth.session.active_organization_id',
    ]) {
      expect(SCHEMA_CLASSIFICATION[subject]?.coverage, subject).toBe('deleted by step 2');
    }
    // The two columns without a foreign key are found by the catalog walk itself.
    const subjects = await enumerateSchemaSubjects(await getOwnerPool());
    expect(subjects).toContain('reference column auth.apikey.reference_id');
    expect(subjects).toContain('reference column auth.session.active_organization_id');
  });

  it('on the real schema mfa-reenrol: and invitation-shed: are purged, password-reset: and auth.rate_limit exempt, each with its reason', () => {
    expect(familyOf('mfa-reenrol:')?.coverage).toBe('deleted by step 2');
    expect(familyOf('invitation-shed:')?.coverage).toBe('deleted by step 2');
    expect(familyOf('password-reset:')?.coverage).toBe('exempt');
    expect(familyOf('password-reset:')?.reason).toMatch(/Q150/);
    const rateLimit = SCHEMA_CLASSIFICATION['auth table auth.rate_limit'];
    expect(rateLimit?.coverage).toBe('exempt');
    expect(rateLimit?.reason).toMatch(/Q151/);
  });

  it('fails when a prefix declared by 044 is missing from the table', async () => {
    const owner = await getOwnerPool();
    const declaredPrefixes = declaredPrefixesOf044();
    for (const missing of ['password-reset:', 'mfa-reenrol:']) {
      const problems = await checkCoverage(owner, {
        ...REAL_INPUT,
        families: IDENTIFIER_FAMILIES.filter((family) => family.family !== missing),
        declaredPrefixes,
        identifiers: [],
      });
      expect(problems).toEqual([`declared prefix not classified: ${missing}`]);
    }
  });

  describe('the real writers produce only classified identifiers', () => {
    let app: App;
    let stub: OidcStub;

    beforeAll(async () => {
      const pools = await harnessPools();
      stub = await startOidcStub();
      app = await createApp({
        ...pools,
        authSecret: TEST_SECRET,
        cerbosAddress: 'localhost:3593',
        allowedOrigins: ['http://localhost:3000'],
        sso: {
          discoveryUrl: stub.discoveryUrl,
          clientId: stub.clientId,
          clientSecret: stub.clientSecret,
        },
      });
    }, 60_000);

    afterAll(async () => {
      await app.close();
      await stub.close();
    }, 60_000);

    /** The identifiers of the rows that carry `needle` in their identifier or value. */
    async function identifiersWith(needle: string): Promise<string[]> {
      const owner = await getOwnerPool();
      const { rows } = await owner.query<{ identifier: string }>(
        `select identifier from auth.verification
          where position($1 in identifier) > 0 or position($1 in value) > 0`,
        [needle],
      );
      return rows.map((row) => row.identifier);
    }

    it('an SSO sign-in start writes an auth-state: row, and it and the 044 writers are classified', async () => {
      const { authPool } = await harnessPools();
      const store = createResetTokenStore({ authPool, withUserLock: createWithUserLock(authPool) });
      const resetUser = randomUUID();
      const { id: resetId } = await store.issue(resetUser);
      const mfaUser = randomUUID();
      await createAuthRepository(authPool).writeMfaReenrolMarker(mfaUser);

      const octet = (): string => randomInt(1, 255).toString(10);
      const initiated = await app.app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/social',
        headers: {
          'x-forwarded-for': `10.${octet()}.${octet()}.${octet()}`,
          origin: 'http://localhost:3000',
          host: 'localhost:3000',
          'content-type': 'application/json',
        },
        payload: JSON.stringify({ provider: 'visma-connect', callbackURL: '/' }),
      });
      expect(initiated.statusCode, initiated.body).toBe(200);
      const state = new URL(initiated.json<{ url: string }>().url).searchParams.get('state');
      expect(state).toBeTruthy();

      const oauthState = await identifiersWith(state ?? '');
      expect(oauthState, 'Better Auth stores the OAuth state in auth.verification').toEqual([
        `auth-state:${state ?? ''}`,
      ]);
      const identifiers = [
        ...(await identifiersWith(resetId)),
        ...(await identifiersWith(mfaUser)),
        ...oauthState,
      ];
      expect(identifiers.length).toBeGreaterThanOrEqual(3);

      const problems = await checkCoverage(await getOwnerPool(), {
        ...REAL_INPUT,
        declaredPrefixes: declaredPrefixesOf044(),
        identifiers,
      });
      expect(problems).toEqual([]);
    }, 60_000);
  });

  describe('a scratch migration that no step covers makes the check fail', () => {
    const scratchName = safeName('tayzu_api_purge_coverage_');
    let adminPool: Pool;
    let scratch: Pool;

    beforeAll(async () => {
      adminPool = new Pool({ connectionString: ownerUrl(), max: 1 });
      const privilege = await adminPool.query<{ allowed: boolean }>(
        'select rolcreatedb or rolsuper as allowed from pg_roles where rolname = current_user',
      );
      if (privilege.rows[0]?.allowed !== true) {
        throw new Error(
          'The DATABASE_URL role needs the CREATEDB privilege: this test creates, and then drops, a private scratch database.',
        );
      }
      await adminPool.query(`create database ${scratchName}`);
      scratch = new Pool({ connectionString: scratchUrl(scratchName), max: 2 });
      await runMigrations(scratch);
    }, 120_000);

    afterAll(async () => {
      await endQuietly(scratch);
      await adminPool.query(`drop database if exists ${scratchName} with (force)`);
      await endQuietly(adminPool);
    }, 60_000);

    /** Every identifier of the private database's `auth.verification` (only this file writes). */
    async function scratchIdentifiers(): Promise<string[]> {
      const { rows } = await scratch.query<{ identifier: string }>(
        'select identifier from auth.verification order by identifier',
      );
      return rows.map((row) => row.identifier);
    }

    async function scratchCheck(): Promise<string[]> {
      return checkCoverage(scratch, {
        ...REAL_INPUT,
        declaredPrefixes: declaredPrefixesOf044(),
        identifiers: await scratchIdentifiers(),
      });
    }

    it('passes on the scratch database as migrated', async () => {
      expect(await scratchCheck()).toEqual([]);
    });

    it('fails for a tenant_id table added in public that no step covers', async () => {
      const table = safeName('purge_coverage_probe_');
      await scratch.query(`create table public.${table} (tenant_id text)`);
      try {
        expect(await scratchCheck()).toEqual([`unclassified: tenant table public.${table}`]);
      } finally {
        await scratch.query(`drop table public.${table}`);
      }
      expect(await scratchCheck()).toEqual([]);
    });

    it('fails for a tenant_id table added in another schema', async () => {
      const schema = safeName('purge_coverage_schema_');
      await scratch.query(`create schema ${schema}`);
      await scratch.query(`create table ${schema}.rows (id text, tenant_id text)`);
      try {
        expect(await scratchCheck()).toEqual([`unclassified: tenant table ${schema}.rows`]);
      } finally {
        await scratch.query(`drop schema ${schema} cascade`);
      }
    });

    it('fails for an auth table that references a user by column and an organization by foreign key', async () => {
      const table = safeName('purge_coverage_probe_');
      await scratch.query(
        `create table auth.${table} (
           id text primary key,
           owner_user_id text,
           org text references auth.organization (id)
         )`,
      );
      try {
        expect(await scratchCheck()).toEqual(
          [
            `unclassified: auth table auth.${table}`,
            `unclassified: reference column auth.${table}.org`,
            `unclassified: reference column auth.${table}.owner_user_id`,
          ].sort(),
        );
      } finally {
        await scratch.query(`drop table auth.${table}`);
      }
    });

    it('fails for an unlisted identifier pattern', async () => {
      const listed = `password-reset:${randomUUID()}`;
      const unlisted = `purge-coverage-unlisted:${randomUUID()}`;
      // A known prefix in an unlisted shape is unlisted too: `2fa-` is matched by shape.
      const unlistedShape = `2fa-otp-${randomUUID()}`;
      for (const identifier of [listed, unlisted, unlistedShape]) {
        await scratch.query(
          `insert into auth.verification (id, identifier, value, expires_at, created_at, updated_at)
           values ($1, $2, 'x', now() + interval '5 minutes', now(), now())`,
          [randomUUID(), identifier],
        );
      }
      const problems = await scratchCheck();
      expect(problems.sort()).toEqual(
        [
          `unclassified identifier: ${unlisted}`,
          `unclassified identifier: ${unlistedShape}`,
        ].sort(),
      );
    });
  });

  it('every "deleted by the request (Q170)" line is proved by a request test of org-deletion.int.test.ts', () => {
    expect(Object.keys(REQUEST_PROOFS).sort()).toEqual(linesWith('deleted by the request (Q170)'));
    const source = readFileSync(
      new URL('./identity/org-deletion.int.test.ts', import.meta.url),
      'utf8',
    );
    for (const [line, title] of Object.entries(REQUEST_PROOFS)) {
      expect(source, `${line}: the request test "${title}" exists`).toContain(
        `it(${JSON.stringify(title)}`,
      );
    }
  });

  it('every "deleted by step N" line is deleted by that step on the real schema', async () => {
    const purge = (await getPurgeTestDatabase()).pool;
    const world = await seedProofWorld();

    // Every step line has a probe, and only step lines do.
    const stepLines = [...linesWith('deleted by step 1'), ...linesWith('deleted by step 2')].sort();
    expect(Object.keys(world.probes).sort()).toEqual(stepLines);
    for (const key of stepLines) {
      expect(await world.probes[key]?.present(), `${key} is seeded`).toBe(true);
    }
    await world.markDue();

    await purgeCatalogStep(purge, world.due);
    for (const key of linesWith('deleted by step 1')) {
      const probe = world.probes[key];
      expect(await probe?.present(), `${key}: ${probe?.label ?? ''} is gone after step 1`).toBe(
        false,
      );
    }

    await purgeAuthStep(purge, world.due);
    for (const key of linesWith('deleted by step 2')) {
      const probe = world.probes[key];
      expect(await probe?.present(), `${key}: ${probe?.label ?? ''} is gone after step 2`).toBe(
        false,
      );
    }
    // Exempt (Q150): the leaver's reset row is left alone.
    expect(await world.passwordReset.present(), 'password-reset:<id> is kept').toBe(true);
  }, 60_000);
});
