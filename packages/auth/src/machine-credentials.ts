/**
 * Machine credential creation (task 5.1, design D5; `specs/auth-and-rbac/
 * spec.md`, "Machine credentials").
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
 */
import type { AuthInstance } from './auth.js';

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
