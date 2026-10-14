/**
 * Orchestration of org API credentials: viewer, create, rotate and revoke
 * (`043` design D7 and D8). The viewer (task 9.2) lives here; the rest arrives
 * with task group 9.
 */
import { emitIdentityEvent, recordIdentityMetric, type AuthInstance } from '@tayzu/auth';
import { createMachineCredential, revokeMachineCredential } from '@tayzu/auth/machine-credentials';
import { withTenantTransaction } from '@tayzu/db';
import type { Pool, PoolClient } from 'pg';

import type { ApiKeyRead, AuthRepository } from './auth-repository.js';

/** The `configId` of every org-owned machine credential. */
const MACHINE_CREDENTIAL_CONFIG_ID = 'machine-credential';

/** No first characters of a secret are stored, so the prefix identifies nothing (D7). */
const CREDENTIAL_PREFIX = 'tayzu_mc_';

const DEFAULT_PAGE_SIZE = 100;

/** Policy default: a credential is due for rotation this many days after its last rotation. */
export const DEFAULT_ROTATION_INTERVAL_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_CREDENTIAL_CAP = 200;

export type CredentialKind = 'service_account' | 'integration' | 'agent';

export interface CredentialView {
  readonly id: string;
  readonly name: string;
  readonly kind: CredentialKind;
  readonly prefix: string;
  readonly createdAt: Date;
  readonly lastRequest: Date | null;
  readonly enabled: boolean;
  readonly rotationDueAt: Date;
  readonly createdBy?: string;
}

export interface ApiKeyMetadata {
  actorKind?: string;
  role?: string;
  userId?: string;
  createdBy?: string;
  rotatedAt?: string;
}

/** Reads the key metadata from the adapter's object or from a JSON string; anything else is empty. */
export function readApiKeyMetadata(value: unknown): ApiKeyMetadata {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (typeof parsed !== 'object' || parsed === null) return {};
  const source = parsed as Record<string, unknown>;
  const result: ApiKeyMetadata = {};
  for (const field of ['actorKind', 'role', 'userId', 'createdBy', 'rotatedAt'] as const) {
    const entry = Object.hasOwn(source, field) ? source[field] : undefined;
    if (typeof entry === 'string') result[field] = entry;
  }
  return result;
}

/**
 * When the credential is due for rotation: `metadata.rotatedAt` (or `createdAt` for a credential
 * never rotated, or whose `rotatedAt` is unparseable) plus the interval.
 */
export function computeRotationDueAt(args: {
  rotatedAt?: string;
  createdAt: Date;
  intervalDays?: number;
}): Date {
  const rotated = args.rotatedAt === undefined ? undefined : new Date(args.rotatedAt);
  const base = rotated !== undefined && !Number.isNaN(rotated.getTime()) ? rotated : args.createdAt;
  return new Date(base.getTime() + (args.intervalDays ?? DEFAULT_ROTATION_INTERVAL_DAYS) * DAY_MS);
}

/** Pages through every `machine-credential` key of the tenant to the end. */
export async function readAllApiKeys(
  authRepository: AuthRepository,
  tenantId: string,
  options: { pageSize?: number } = {},
): Promise<ApiKeyRead[]> {
  const limit = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const keys: ApiKeyRead[] = [];
  let cursor: string | undefined;
  do {
    const page = await authRepository.listApiKeys(tenantId, {
      limit,
      configId: MACHINE_CREDENTIAL_CONFIG_ID,
      ...(cursor === undefined ? {} : { cursor }),
    });
    keys.push(...page.keys);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return keys;
}

/** A tenant-scoped client already inside a transaction, such as the one that holds an advisory lock. */
export type TenantClient = Pick<PoolClient, 'query'>;

/** Reads the revoked credential ids on `client`, which the caller scoped to the tenant. */
export async function readRevokedIdsOn(
  client: TenantClient,
  tenantId: string,
): Promise<Set<string>> {
  const result = await client.query<{ credential_id: string }>(
    'select credential_id from machine_credential_revocation where tenant_id = $1',
    [tenantId],
  );
  return new Set(result.rows.map((r) => r.credential_id));
}

export async function readRevokedIds(appPool: Pool, tenantId: string): Promise<Set<string>> {
  return withTenantTransaction(appPool, { tenantId }, (client) =>
    readRevokedIdsOn(client, tenantId),
  );
}

/** The identifiers, among `identifiers`, of the tenant's `_user` entities whose status is `Disabled`. */
async function readDisabledAccounts(
  appPool: Pool,
  tenantId: string,
  identifiers: string[],
): Promise<Set<string>> {
  if (identifiers.length === 0) return new Set();
  const rows = await withTenantTransaction(appPool, { tenantId }, async (client) => {
    const result = await client.query<{ identifier: string }>(
      `select e.identifier from catalog_entity e
         join catalog_blueprint b on b.tenant_id = e.tenant_id and b.id = e.blueprint_id
        where e.tenant_id = $1 and b.identifier = '_user'
          and e.identifier = any($2::text[])
          and e.spec_properties ->> 'status' = 'Disabled'`,
      [tenantId, identifiers],
    );
    return result.rows;
  });
  return new Set(rows.map((r) => r.identifier));
}

/** The page of the viewer: non-revoked credentials first, at most `cap` entries. */
export async function listCredentials(args: {
  authRepository: AuthRepository;
  appPool: Pool;
  tenantId: string;
  cap: number;
}): Promise<{ credentials: CredentialView[]; truncated: boolean }> {
  const [keys, revoked] = await Promise.all([
    readAllApiKeys(args.authRepository, args.tenantId),
    readRevokedIds(args.appPool, args.tenantId),
  ]);
  const byAge = (a: ApiKeyRead, b: ApiKeyRead): number =>
    a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);
  const ordered = [
    ...keys.filter((k) => !revoked.has(k.id)).sort(byAge),
    ...keys.filter((k) => revoked.has(k.id)).sort(byAge),
  ];
  const page = ordered.slice(0, args.cap).map((key) => ({
    key,
    metadata: readApiKeyMetadata(key.metadata),
  }));
  const disabledAccounts = await readDisabledAccounts(
    args.appPool,
    args.tenantId,
    page.flatMap(({ metadata }) => (metadata.userId === undefined ? [] : [metadata.userId])),
  );
  const credentials = page.map(({ key, metadata }): CredentialView => {
    const kind: CredentialKind =
      metadata.userId !== undefined
        ? 'service_account'
        : metadata.actorKind === 'agent'
          ? 'agent'
          : 'integration';
    return {
      id: key.id,
      name: key.name ?? '',
      kind,
      prefix: CREDENTIAL_PREFIX,
      createdAt: key.createdAt,
      lastRequest: key.lastRequest,
      enabled:
        key.enabled &&
        !revoked.has(key.id) &&
        !(metadata.userId !== undefined && disabledAccounts.has(metadata.userId)),
      rotationDueAt: computeRotationDueAt({
        createdAt: key.createdAt,
        ...(metadata.rotatedAt === undefined ? {} : { rotatedAt: metadata.rotatedAt }),
      }),
      ...(metadata.createdBy === undefined ? {} : { createdBy: metadata.createdBy }),
    };
  });
  return { credentials, truncated: ordered.length > args.cap };
}

/** The identifier prefix every service account carries (Resolved decision Q90). */
const SERVICE_ACCOUNT_PREFIX = 'svc-';

/** Same code as the catalog's not-found: a human, an unknown id and another tenant's account look alike. */
export class CredentialTargetNotFoundError extends Error {
  readonly code = 'CATALOG_NOT_FOUND' as const;

  constructor() {
    super('The requested resource was not found');
    this.name = 'CredentialTargetNotFoundError';
  }
}

/** Generic on purpose: never names the service account. */
export class CredentialConflictError extends Error {
  readonly code = 'CATALOG_VALIDATION_FAILED' as const;

  constructor() {
    super('The request input is invalid');
    this.name = 'CredentialConflictError';
  }
}

/** Whether the tenant has a `_user` that is a service account (`accountKind == "service"`) with this identifier. */
export async function serviceAccountExists(
  appPool: Pool,
  tenantId: string,
  identifier: string,
): Promise<boolean> {
  if (!identifier.startsWith(SERVICE_ACCOUNT_PREFIX)) return false;
  return withTenantTransaction(appPool, { tenantId }, (client) =>
    serviceAccountExistsOn(client, tenantId, identifier),
  );
}

/** Same check as `serviceAccountExists`, on a client the caller scoped to the tenant. */
export async function serviceAccountExistsOn(
  client: TenantClient,
  tenantId: string,
  identifier: string,
): Promise<boolean> {
  if (!identifier.startsWith(SERVICE_ACCOUNT_PREFIX)) return false;
  const result = await client.query<{ one: number }>(
    `select 1 as one from catalog_entity e
       join catalog_blueprint b on b.tenant_id = e.tenant_id and b.id = e.blueprint_id
      where e.tenant_id = $1 and b.identifier = '_user' and e.identifier = $2
        and e.spec_properties ->> 'accountKind' = 'service'`,
    [tenantId, identifier],
  );
  return result.rows.length > 0;
}

/** The kind of an existing credential; a key bound to a service account is `service_account` (Q145). */
export async function credentialKindOf(
  authRepository: AuthRepository,
  tenantId: string,
  credentialId: string,
): Promise<'service_account' | 'integration' | 'agent' | undefined> {
  const key = await authRepository.apiKeyById(tenantId, credentialId);
  if (key === undefined) return undefined;
  const metadata = readApiKeyMetadata(key.metadata);
  if (metadata.userId !== undefined) return 'service_account';
  return metadata.actorKind === 'integration' || metadata.actorKind === 'agent'
    ? metadata.actorKind
    : undefined;
}

/** Counts one credential mutation (`tayzu.identity.credential_mutations`). */
export function recordCredentialMutation(
  tenantId: string,
  kind: 'service_account' | 'integration' | 'agent',
  mutation: 'created' | 'rotated' | 'revoked',
): void {
  recordIdentityMetric('tayzu.identity.credential_mutations', 1, {
    'tayzu.tenant.id': tenantId,
    'tayzu.identity.credential.kind': kind,
    'tayzu.identity.credential.mutation': mutation,
  });
}

/** The key `name`: 1 to 32 characters of `[A-Za-z0-9 _.-]` (the plugin allows 32). */
export const CREDENTIAL_NAME_PATTERN = /^[A-Za-z0-9 _.-]{1,32}$/;

/**
 * Creates an integration or agent credential for the tenant, headerless (task 9.1b), with the
 * acting admin as `userId` and recorded as `createdBy`. The secret is returned once.
 */
export async function createCredential(args: {
  readonly auth: AuthInstance;
  readonly tenantId: string;
  readonly adminId: string;
  readonly name: string;
  readonly kind: 'integration' | 'agent';
  /** The `svc-…` identifier of the service account to bind; needs `authRepository` and `appPool`. */
  readonly userId?: string;
  readonly authRepository?: AuthRepository;
  readonly appPool?: Pool;
  /** The most non-revoked credentials the tenant may hold (Q56). */
  readonly cap?: number;
}): Promise<{ readonly id: string; readonly secret: string }> {
  const { userId, appPool, authRepository } = args;
  const cap = args.cap ?? DEFAULT_CREDENTIAL_CAP;
  // Fail closed when the host did not wire the lookups the cap and the binding need.
  if (appPool === undefined || authRepository === undefined) {
    throw new CredentialConflictError();
  }
  return withTenantTransaction(appPool, { tenantId: args.tenantId }, async (lockClient) => {
    if (userId !== undefined) {
      // Serialized per service account (D8): rotation and deletion take the same lock.
      await lockClient.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `service-account:${args.tenantId}:${userId}`,
      ]);
      if (!(await serviceAccountExistsOn(lockClient, args.tenantId, userId))) {
        throw new CredentialTargetNotFoundError();
      }
    }
    // Per-tenant lock (Q56): concurrent creates cannot overshoot the cap.
    await lockClient.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `credential-cap:${args.tenantId}`,
    ]);
    const [keys, revoked] = await Promise.all([
      readAllApiKeys(authRepository, args.tenantId),
      readRevokedIdsOn(lockClient, args.tenantId),
    ]);
    const active = keys.filter((key) => !revoked.has(key.id));
    if (active.length >= cap) throw new CredentialConflictError();
    // Resolved decision Q40: one active credential per service account.
    if (
      userId !== undefined &&
      active.some((k) => readApiKeyMetadata(k.metadata).userId === userId)
    ) {
      throw new CredentialConflictError();
    }
    return insertCredential(args);
  });
}

async function insertCredential(args: {
  readonly auth: AuthInstance;
  readonly tenantId: string;
  readonly adminId: string;
  readonly name: string;
  readonly kind: 'integration' | 'agent';
  readonly userId?: string;
}): Promise<{ readonly id: string; readonly secret: string }> {
  const created = await createMachineCredential(args.auth, {
    userId: args.adminId,
    organizationId: args.tenantId,
    name: args.name,
    actorKind: args.kind,
    metadata: {
      createdBy: args.adminId,
      ...(args.userId === undefined ? {} : { userId: args.userId }),
    },
  });
  return { id: created.id, secret: created.secret };
}

/**
 * Rotates a credential (design D8): creates the new key with the old key's `actorKind` and
 * `userId`, the rotating admin as `createdBy` and the time as `rotatedAt`, then retires the old
 * one through the revocation list. The new secret is returned once.
 */
export async function rotateCredential(args: {
  readonly auth: AuthInstance;
  readonly authRepository: AuthRepository;
  readonly appPool: Pool;
  readonly tenantId: string;
  readonly adminId: string;
  /** The id of the credential to rotate, already resolved inside the tenant. */
  readonly credentialId: string;
  /** The most non-revoked credentials the tenant may hold; rotating a revoked one counts (Q56). */
  readonly cap?: number;
}): Promise<{ readonly id: string; readonly secret: string }> {
  const cap = args.cap ?? DEFAULT_CREDENTIAL_CAP;
  const old = await args.authRepository.apiKeyById(args.tenantId, args.credentialId);
  if (old === undefined) throw new CredentialTargetNotFoundError();
  const metadata = readApiKeyMetadata(old.metadata);
  const actorKind = metadata.actorKind;
  if (actorKind !== 'integration' && actorKind !== 'agent') {
    throw new CredentialConflictError();
  }
  // Serialized per service account, or per credential when unbound (D8, Q40): creation and
  // deletion take the same service-account lock.
  const lockKey =
    metadata.userId === undefined
      ? `credential:${args.tenantId}:${old.id}`
      : `service-account:${args.tenantId}:${metadata.userId}`;
  return withTenantTransaction(args.appPool, { tenantId: args.tenantId }, async (lockClient) => {
    await lockClient.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);
    // A deletion that held the lock first removed the account: nothing may be bound to it again.
    if (
      metadata.userId !== undefined &&
      !(await serviceAccountExistsOn(lockClient, args.tenantId, metadata.userId))
    ) {
      throw new CredentialTargetNotFoundError();
    }
    // The revocation state is read under the lock, so a concurrent rotation is seen.
    const revoked = await readRevokedIdsOn(lockClient, args.tenantId);
    if (revoked.has(old.id)) {
      // A revoked credential is rotatable only when its service account has no active one.
      if (metadata.userId === undefined) throw new CredentialConflictError();
      // Restoring a non-revoked credential counts like a creation (Q56, Q149): same cap lock.
      await lockClient.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `credential-cap:${args.tenantId}`,
      ]);
      const [keys, revokedNow] = await Promise.all([
        readAllApiKeys(args.authRepository, args.tenantId),
        readRevokedIdsOn(lockClient, args.tenantId),
      ]);
      const active = keys.filter((k) => !revokedNow.has(k.id));
      const accountId = metadata.userId;
      if (
        active.length >= cap ||
        active.some((k) => readApiKeyMetadata(k.metadata).userId === accountId)
      ) {
        throw new CredentialConflictError();
      }
    }
    const created = await createMachineCredential(args.auth, {
      userId: args.adminId,
      organizationId: args.tenantId,
      name: old.name ?? '',
      actorKind,
      role: 'member',
      metadata: {
        createdBy: args.adminId,
        rotatedAt: new Date().toISOString(),
        ...(metadata.userId === undefined ? {} : { userId: metadata.userId }),
      },
    });
    try {
      await revokeMachineCredential(args.auth, {
        userId: args.adminId,
        id: old.id,
        pool: args.appPool,
        tenantId: args.tenantId,
      });
    } catch (error) {
      // Compensation: no second usable credential may survive a failed retirement.
      try {
        await revokeMachineCredential(args.auth, {
          userId: args.adminId,
          id: created.id,
          pool: args.appPool,
          tenantId: args.tenantId,
        });
      } catch {
        // Two usable credentials may remain: signal it with opaque identifiers only.
        emitIdentityEvent({
          name: 'catalog.security.credential_rotation_incomplete',
          severity: 'WARN',
          attributes: {
            'tayzu.tenant.id': args.tenantId,
            'tayzu.actor.id': args.adminId,
            'tayzu.identity.credential.old_id': old.id,
            'tayzu.identity.credential.new_id': created.id,
          },
        });
      }
      throw error;
    }
    emitIdentityEvent({
      name: 'catalog.audit.credential_rotated',
      severity: 'INFO',
      attributes: {
        'tayzu.tenant.id': args.tenantId,
        'tayzu.actor.id': args.adminId,
        'tayzu.identity.credential.old_id': old.id,
        'tayzu.identity.credential.new_id': created.id,
      },
    });
    return { id: created.id, secret: created.secret };
  });
}

/**
 * Revokes a credential permanently (design D8): the revocation row and the disable are
 * idempotent in the helper, so revoking an already revoked credential is a no-op.
 */
export async function revokeCredential(args: {
  readonly auth: AuthInstance;
  readonly appPool: Pool;
  readonly tenantId: string;
  readonly adminId: string;
  readonly credentialId: string;
}): Promise<void> {
  await revokeMachineCredential(args.auth, {
    userId: args.adminId,
    id: args.credentialId,
    pool: args.appPool,
    tenantId: args.tenantId,
  });
  emitIdentityEvent({
    name: 'catalog.security.credential_revoked',
    severity: 'WARN',
    attributes: {
      'tayzu.tenant.id': args.tenantId,
      'tayzu.actor.id': args.adminId,
      'tayzu.identity.credential.id': args.credentialId,
    },
  });
}
