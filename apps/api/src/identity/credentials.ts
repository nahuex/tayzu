/**
 * Orchestration of org API credentials: viewer, create, rotate and revoke
 * (`043` design D7 and D8). The viewer (task 9.2) lives here; the rest arrives
 * with task group 9.
 */
import { withTenantTransaction } from '@tayzu/db';
import type { Pool } from 'pg';

import type { ApiKeyRead, AuthRepository } from './auth-repository.js';

/** The `configId` of every org-owned machine credential. */
const MACHINE_CREDENTIAL_CONFIG_ID = 'machine-credential';

/** No first characters of a secret are stored, so the prefix identifies nothing (D7). */
const CREDENTIAL_PREFIX = 'tayzu_mc_';

const DEFAULT_PAGE_SIZE = 100;

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
  /** Computed by task 9.4. */
  readonly rotationDueAt: Date | null;
  readonly createdBy?: string;
}

export interface ApiKeyMetadata {
  actorKind?: string;
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
  for (const field of ['actorKind', 'userId', 'createdBy', 'rotatedAt'] as const) {
    const entry = Object.hasOwn(source, field) ? source[field] : undefined;
    if (typeof entry === 'string') result[field] = entry;
  }
  return result;
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

async function readRevokedIds(appPool: Pool, tenantId: string): Promise<Set<string>> {
  const rows = await withTenantTransaction(appPool, { tenantId }, async (client) => {
    const result = await client.query<{ credential_id: string }>(
      'select credential_id from machine_credential_revocation where tenant_id = $1',
      [tenantId],
    );
    return result.rows;
  });
  return new Set(rows.map((r) => r.credential_id));
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
      rotationDueAt: null,
      ...(metadata.createdBy === undefined ? {} : { createdBy: metadata.createdBy }),
    };
  });
  return { credentials, truncated: ordered.length > args.cap };
}
