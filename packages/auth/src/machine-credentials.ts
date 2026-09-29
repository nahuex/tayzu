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
import { withTenantTransaction, type createPool } from '@tayzu/db';

import type { AuthInstance } from './auth.js';
import { AuthContextError } from './errors.js';

/** design D5: the fixed kinds a machine credential can be created with. */
export type MachineCredentialActorKind = 'integration' | 'agent';

export interface CreateMachineCredentialParams {
  /** The calling admin's session cookie, forwarded so Better Auth's own admin-only check runs. */
  readonly headers: Headers;
  readonly organizationId: string;
  readonly name: string;
  readonly actorKind: MachineCredentialActorKind;
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
    headers: Headers;
    body: {
      configId: string;
      name: string;
      organizationId: string;
      metadata: Record<string, unknown>;
    };
  }): Promise<CreateApiKeyResult>;
  getApiKey(args: {
    headers: Headers;
    query: { configId: string; id: string };
  }): Promise<{ readonly referenceId: string }>;
  updateApiKey(args: {
    headers: Headers;
    body: {
      configId: string;
      keyId: string;
      enabled: boolean;
    };
  }): Promise<unknown>;
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
  const created = await apiOf(auth).createApiKey({
    headers: params.headers,
    body: {
      configId: MACHINE_CREDENTIAL_CONFIG_ID,
      name: params.name,
      organizationId: params.organizationId,
      metadata: { [ACTOR_KIND_METADATA_KEY]: params.actorKind },
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
  /** The calling admin's session cookie, forwarded so Better Auth's own admin-only check runs. */
  readonly headers: Headers;
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
  // Authorize first: a caller Better Auth rejects must leave no revocation
  // row (a non-admin could otherwise deny service to any credential).
  // `getApiKey` runs the organization permission check scoped to the
  // caller's session and to the credential's own organization, and throws
  // Better Auth's own error. The credential must belong to the host tenant.
  const existing = await apiOf(auth).getApiKey({
    headers: params.headers,
    query: { configId: MACHINE_CREDENTIAL_CONFIG_ID, id: params.id },
  });
  if (existing.referenceId !== params.tenantId) {
    throw new AuthContextError();
  }
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
    headers: params.headers,
    body: {
      configId: MACHINE_CREDENTIAL_CONFIG_ID,
      keyId: params.id,
      enabled: false,
    },
  });
}
