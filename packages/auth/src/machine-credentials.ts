/**
 * Machine credential creation and revocation (tasks 5.1-5.2, design D5;
 * `specs/auth-and-rbac/spec.md`, "Machine credentials").
 *
 * "The system MUST let an organization admin create a named machine
 * credential of a fixed kind (`integration` or `agent`, chosen at creation):
 * a client id and a client secret, generated once, returned only in the
 * creation response, and stored hashed thereafter." Design D5: "The
 * long-lived credential is an `apiKey` plugin key, config `machine-
 * credential` (`references: "organization"`, `defaultPrefix: "tayzu_mc_"`),
 * created by an admin. Its `id` is the client id; its generated key is the
 * client secret, shown once, hashed thereafter (Better Auth default --
 * `disableKeyHashing` is never set)." and "`actorKind` (`integration` or
 * `agent`) is fixed at credential-creation time via the config's `metadata`,
 * never chosen by the caller of `POST /v1/auth/token`."
 *
 * `createMachineCredential(auth, params)` is a thin wrapper around `auth.api.
 * createApiKey`, scoped to the `machine-credential` config `./auth.ts`
 * registers. "Admin-only" is enforced by Better Auth's own organization
 * permission check (`checkOrgApiKeyPermission`, `@better-auth/
 * api-key@1.7.6`'s installed source), triggered because `references:
 * "organization"` requires an authorized session for the target
 * organization -- this module does not reimplement that check. `actorKind`
 * is written into the key's `metadata` (design D5's own mechanism) and
 * returned from this module's own field, never read back from the caller
 * later: `POST /v1/auth/token` (task 5.3) is the only place that later reads
 * it back, off the stored key, not off this response.
 *
 * `revokeMachineCredential(auth, params)` (task 5.2) is the matching
 * revocation wrapper: "there is no in-place rotation, only
 * revoke-and-recreate." It disables the key through `auth.api.updateApiKey`
 * (Better Auth's own `"update"` action of `checkOrgApiKeyPermission`), which
 * makes the key fail `auth.api.verifyApiKey` -- the exact call `POST
 * /v1/auth/token` (task 5.3) makes on every request.
 */
import { API_KEY_ERROR_CODES } from '@better-auth/api-key';
import { APIError } from 'better-auth/api';
import { withTenantTransaction, type createPool } from '@tayzu/db';

import type { AuthInstance } from './auth.js';
import { AuthContextError } from './errors.js';
import { organizationAccess } from './org-access.js';

/** design D5: the fixed kinds a machine credential can be created with. */
export type MachineCredentialActorKind = 'integration' | 'agent';

export interface CreateMachineCredentialParams {
  /**
   * The acting admin's Better Auth user id, forwarded as `body.userId` so
   * Better Auth's own organization-permission check runs (task 9.1b, Q29).
   */
  readonly userId: string;
  readonly organizationId: string;
  readonly name: string;
  readonly actorKind: MachineCredentialActorKind;
  /** Q28: every machine credential is `member`; any other value is rejected. */
  readonly role?: 'member';
  /** Supplied by the caller: the bound service account's `svc-…` id, the acting admin's opaque id and, for a rotation, its ISO time. */
  readonly metadata?: {
    readonly userId?: string;
    readonly createdBy?: string;
    readonly rotatedAt?: string;
  };
}

export interface CreatedMachineCredential {
  /** The credential's client id (`POST /v1/auth/token`'s `id`). */
  readonly id: string;
  /** The credential's client secret, shown once, in this response only. */
  readonly secret: string;
  readonly name: string | null;
  readonly actorKind: MachineCredentialActorKind;
  readonly organizationId: string;
}

/** design D5: the one `apiKey` plugin config this task registers. */
const MACHINE_CREDENTIAL_CONFIG_ID = 'machine-credential';

/** design D5: `actorKind` is fixed at creation via the config's `metadata`. */
const ACTOR_KIND_METADATA_KEY = 'actorKind';

/** Q28: the fixed role, stored on the credential metadata next to `actorKind`. */
const ROLE_METADATA_KEY = 'role';
const MACHINE_CREDENTIAL_ROLE = 'member';

/**
 * The narrow slice of `auth.api.createApiKey`'s installed response
 * (`@better-auth/api-key@1.7.6`, `dist/index-BJOGXZav.d.mts`) this module
 * reads.
 */
interface CreateApiKeyResult {
  readonly id: string;
  readonly key: string;
  readonly name: string | null;
  readonly referenceId: string;
}

interface AuthApiSurface {
  createApiKey(args: {
    body: {
      userId: string;
      configId: string;
      name: string;
      organizationId: string;
      metadata: Record<string, unknown>;
    };
  }): Promise<CreateApiKeyResult>;
  updateApiKey(args: {
    body: {
      userId: string;
      configId: string;
      keyId: string;
      enabled: boolean;
    };
  }): Promise<unknown>;
}

interface AdapterSurface {
  findOne<T>(args: {
    model: string;
    where: readonly { field: string; value: string }[];
  }): Promise<T | null>;
}

function contextOf(auth: AuthInstance): Promise<{ readonly adapter: AdapterSurface }> {
  return auth.$context as Promise<{ readonly adapter: AdapterSurface }>;
}

/** `@better-auth/api-key@1.7.6`'s model name for the `apiKey` table. */
const API_KEY_TABLE_NAME = 'apikey';

function roleOf(
  name: string,
): (typeof organizationAccess.roles)[keyof typeof organizationAccess.roles] | undefined {
  return Object.hasOwn(organizationAccess.roles, name)
    ? organizationAccess.roles[name as keyof typeof organizationAccess.roles]
    : undefined;
}

/**
 * Runs the same organization-permission check Better Auth's `updateApiKey`
 * runs, ahead of the revocation row, so a refused caller writes no row.
 */
async function requireApiKeyPermission(
  auth: AuthInstance,
  userId: string,
  organizationId: string,
  action: 'update',
): Promise<void> {
  const { adapter } = await contextOf(auth);
  const member = await adapter.findOne<{ readonly role: string }>({
    model: 'member',
    where: [
      { field: 'userId', value: userId },
      { field: 'organizationId', value: organizationId },
    ],
  });
  if (member === null) {
    throw APIError.from('FORBIDDEN', API_KEY_ERROR_CODES.USER_NOT_MEMBER_OF_ORGANIZATION);
  }
  const allowed = roleOf(member.role)?.authorize({ apiKey: [action] }).success === true;
  if (!allowed) {
    throw APIError.from('FORBIDDEN', API_KEY_ERROR_CODES.INSUFFICIENT_API_KEY_PERMISSIONS);
  }
}

function apiOf(auth: AuthInstance): AuthApiSurface {
  return auth.api as AuthApiSurface;
}

/**
 * Creates a machine credential under the `machine-credential` config,
 * fixing its `actorKind` at creation time. Throws whatever `auth.api.
 * createApiKey` throws on a non-admin/non-member caller (Better Auth's own
 * `checkOrgApiKeyPermission`).
 */
export async function createMachineCredential(
  auth: AuthInstance,
  params: CreateMachineCredentialParams,
): Promise<CreatedMachineCredential> {
  // Q28: fail closed before any row is written; a machine credential is never admin.
  if (params.role !== undefined && (params.role as string) !== MACHINE_CREDENTIAL_ROLE) {
    throw new AuthContextError();
  }
  const created = await apiOf(auth).createApiKey({
    body: {
      userId: params.userId,
      configId: MACHINE_CREDENTIAL_CONFIG_ID,
      name: params.name,
      organizationId: params.organizationId,
      metadata: {
        ...(params.metadata?.userId === undefined ? {} : { userId: params.metadata.userId }),
        ...(params.metadata?.createdBy === undefined
          ? {}
          : { createdBy: params.metadata.createdBy }),
        ...(params.metadata?.rotatedAt === undefined
          ? {}
          : { rotatedAt: params.metadata.rotatedAt }),
        [ACTOR_KIND_METADATA_KEY]: params.actorKind,
        [ROLE_METADATA_KEY]: MACHINE_CREDENTIAL_ROLE,
      },
    },
  });
  return {
    id: created.id,
    secret: created.key,
    name: created.name,
    actorKind: params.actorKind,
    organizationId: created.referenceId,
  };
}

/**
 * Revocation (task 5.2, design D5). "The admin MUST be able to revoke a
 * credential; there is no in-place rotation, only revoke-and-recreate."
 */
export interface RevokeMachineCredentialParams {
  /** The acting admin's Better Auth user id, forwarded as `body.userId` (task 9.1b, Q29). */
  readonly userId: string;
  /** The credential's client id (`CreatedMachineCredential['id']`). */
  readonly id: string;
}

/** A `tayzu_app` pool (the type `@tayzu/db`'s `createPool` returns). */
type AppPool = ReturnType<typeof createPool>;

/**
 * Where the revocation row is written (task 5.6, design D21): a `tayzu_app`
 * pool and the tenant from the trusted host context, never from input. Both
 * are required: no call can skip the revocation list.
 */
export interface RevocationListTarget {
  readonly pool: AppPool;
  readonly tenantId: string;
}

/**
 * Revokes a machine credential by disabling it through Better Auth's own
 * `updateApiKey`, scoped to the `machine-credential` config. Disabling a key
 * makes it fail `auth.api.verifyApiKey` (Better Auth's own behavior), which
 * `POST /v1/auth/token` (task 5.3) relies on as its own revocation check.
 * Throws whatever Better Auth throws on a non-admin/non-member caller
 * (`checkOrgApiKeyPermission`) or an unknown credential id.
 */
export async function revokeMachineCredential(
  auth: AuthInstance,
  params: RevokeMachineCredentialParams & RevocationListTarget,
): Promise<void> {
  // Authorize first: a caller Better Auth would reject must leave no
  // revocation row (a non-admin could otherwise deny service to any
  // credential). The key is read at adapter level, filtered by the host
  // tenant and the config, so a foreign or unknown id is `AuthContextError`.
  const { adapter } = await contextOf(auth);
  const existing = await adapter.findOne<{ readonly id: string }>({
    model: API_KEY_TABLE_NAME,
    where: [
      { field: 'id', value: params.id },
      { field: 'referenceId', value: params.tenantId },
      { field: 'configId', value: MACHINE_CREDENTIAL_CONFIG_ID },
    ],
  });
  if (existing === null) {
    throw new AuthContextError();
  }
  await requireApiKeyPermission(auth, params.userId, params.tenantId, 'update');
  // Ordering (design D21): the apiKey row (`auth` schema, `tayzu_auth`) and
  // the revocation row (`public`, `tayzu_app`) live on different roles and
  // cannot share a transaction. The revocation row is written BEFORE the
  // disable, so a failure of the disable leaves the credential on the
  // revocation list (rejected by the resolver), never the reverse. A repeat
  // is idempotent (`ON CONFLICT DO NOTHING`; `tayzu_app` has no UPDATE).
  await withTenantTransaction(params.pool, { tenantId: params.tenantId }, async (client) => {
    await client.query(
      `insert into machine_credential_revocation (credential_id, revoked_at, tenant_id)
       values ($1, now(), $2) on conflict do nothing`,
      [params.id, params.tenantId],
    );
  });
  await apiOf(auth).updateApiKey({
    body: {
      userId: params.userId,
      configId: MACHINE_CREDENTIAL_CONFIG_ID,
      keyId: params.id,
      enabled: false,
    },
  });
}
