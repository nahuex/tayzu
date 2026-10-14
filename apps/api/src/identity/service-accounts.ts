/**
 * Orchestration of service accounts (`043` design D6).
 *
 * Scaffolded by `043` task 1.4 (design Q30); the rest of its behavior arrives with
 * task group 10.
 */
import {
  emitIdentityEvent,
  recordIdentityMetric,
  withIdentitySpan,
  type AuthInstance,
} from '@tayzu/auth';
import { createMachineCredential, revokeMachineCredential } from '@tayzu/auth/machine-credentials';
import type { CerbosClient } from '@tayzu/authz';
import { createEntityService, type EntityService } from '@tayzu/catalog';
import { withTenantTransaction } from '@tayzu/db';
import type { Pool } from 'pg';

import type { AuthRepository } from './auth-repository.js';
import {
  CredentialConflictError,
  CredentialTargetNotFoundError,
  DEFAULT_CREDENTIAL_CAP,
  readAllApiKeys,
  readApiKeyMetadata,
  readRevokedIds,
  recordCredentialMutation,
  serviceAccountExists,
} from './credentials.js';
import type { UserSyncAdapter } from './user-sync-adapter.js';

/** The actor that reads back the created `_user` entity. */
const SYSTEM_READER = { type: 'system', id: 'service-accounts' } as const;

/** A service-account identifier: `svc-` and a letter, then up to 58 more characters (ADR-0017). */
const SERVICE_ACCOUNT_IDENTIFIER_PATTERN = /^svc-[A-Za-z][A-Za-z0-9_-]{0,58}$/;

/** True when the identifier matches the service-account pattern. Pure; never throws. */
export function isValidServiceAccountIdentifier(identifier: string): boolean {
  return SERVICE_ACCOUNT_IDENTIFIER_PATTERN.test(identifier);
}

/** The most service accounts a tenant holds by default (Resolved decision Q56). */
export const DEFAULT_SERVICE_ACCOUNT_CAP = 50;

/** The fixed key label: the plugin limits a key name to 32 characters and the identifier can run to 63. */
const SERVICE_ACCOUNT_KEY_NAME = 'Service account key';

type EntityOutput = Awaited<ReturnType<EntityService['get']>>;

/**
 * Creates a service account (design D6): the Active `_user` entity as `system` on behalf of the
 * admin, then its organization-owned key, all under the per-service-account lock. A surviving
 * non-revoked key bound to the identifier refuses the creation before anything is written.
 */
export async function createServiceAccount(args: {
  readonly auth: AuthInstance;
  readonly authz: CerbosClient;
  readonly appPool: Pool;
  readonly authRepository: AuthRepository;
  readonly userSync: UserSyncAdapter;
  readonly tenantId: string;
  readonly adminId: string;
  readonly identifier: string;
  /** The most service accounts the tenant may hold (Q56). */
  readonly cap?: number;
  /** The most non-revoked credentials the tenant may hold, the new key included (Q56, Q138). */
  readonly credentialCap?: number;
}): Promise<{ user: EntityOutput; clientId: string; clientSecret: string }> {
  const { tenantId, adminId, identifier } = args;
  if (!isValidServiceAccountIdentifier(identifier)) throw new CredentialConflictError();
  return await withIdentitySpan(
    'identity.service_account.create',
    { 'tayzu.identity.service_account.id': identifier },
    () =>
      withTenantTransaction(args.appPool, { tenantId }, async (lockClient) => {
        await lockClient.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `service-account:${tenantId}:${identifier}`,
        ]);
        // Per-tenant lock (Q56): concurrent creates cannot overshoot the cap.
        await lockClient.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `service-account-cap:${tenantId}`,
        ]);
        const count = await lockClient.query<{ n: string }>(
          `select count(*)::text as n
             from catalog_entity e
             join catalog_blueprint b on b.tenant_id = e.tenant_id and b.id = e.blueprint_id
            where e.tenant_id = $1 and b.identifier = '_user'
              and e.spec_properties ->> 'accountKind' = 'service'`,
          [tenantId],
        );
        if (Number(count.rows[0]?.n) >= (args.cap ?? DEFAULT_SERVICE_ACCOUNT_CAP)) {
          throw new CredentialConflictError();
        }
        // Same lock as `identity.credentials.create` (Q138): the key counts against the cap.
        await lockClient.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `credential-cap:${tenantId}`,
        ]);
        const [keys, revoked] = await Promise.all([
          readAllApiKeys(args.authRepository, tenantId),
          readRevokedIds(args.appPool, tenantId),
        ]);
        if (
          keys.filter((key) => !revoked.has(key.id)).length >=
          (args.credentialCap ?? DEFAULT_CREDENTIAL_CAP)
        ) {
          throw new CredentialConflictError();
        }
        // Resolved decision Q40: the new account must not inherit a surviving credential.
        if (
          keys.some(
            (key) => !revoked.has(key.id) && readApiKeyMetadata(key.metadata).userId === identifier,
          )
        ) {
          throw new CredentialConflictError();
        }
        await args.userSync.writeUserChange({
          tenantId,
          email: identifier,
          name: identifier,
          portRole: 'member',
          change: 'created_active',
          userId: identifier,
          accountKind: 'service',
          principal: { kind: 'admin', id: adminId },
          onBehalfOf: { type: 'user', id: adminId },
        });
        const entities = createEntityService({ pool: args.appPool, authz: args.authz });
        let key: Awaited<ReturnType<typeof createMachineCredential>>;
        try {
          key = await createMachineCredential(args.auth, {
            userId: adminId,
            organizationId: tenantId,
            name: SERVICE_ACCOUNT_KEY_NAME,
            actorKind: 'integration',
            role: 'member',
            metadata: { createdBy: adminId, userId: identifier },
          });
        } catch (error) {
          // Compensation: no service account without a credential is left behind.
          await entities.delete(
            {
              tenantId,
              actor: { ...SYSTEM_READER, onBehalfOf: { type: 'user', id: adminId } },
              principal: { roles: ['admin'] },
            },
            { blueprint: '_user', identifier, detachReferences: true },
          );
          throw error;
        }
        const user = await entities.get(
          { tenantId, actor: SYSTEM_READER, principal: { roles: ['admin'] } },
          { blueprint: '_user', identifier },
        );
        emitIdentityEvent({
          name: 'catalog.audit.service_account_created',
          severity: 'INFO',
          attributes: {
            'tayzu.tenant.id': tenantId,
            'tayzu.actor.id': adminId,
            'tayzu.identity.service_account.id': identifier,
          },
        });
        recordIdentityMetric('tayzu.identity.service_accounts', 1, {
          'tayzu.tenant.id': tenantId,
          'tayzu.identity.service_account.mutation': 'created',
        });
        recordCredentialMutation(tenantId, 'service_account', 'created');
        return { user, clientId: key.id, clientSecret: key.secret };
      }),
  );
}

/**
 * Deletes a service account (design D6, Resolved decisions Q40, Q90): under the per-service-account
 * lock, revokes every non-revoked key bound to the identifier, then removes the `_user` entity as
 * `system` on behalf of the admin, detaching the relations that target it.
 */
export async function deleteServiceAccount(args: {
  readonly auth: AuthInstance;
  readonly authz: CerbosClient;
  readonly appPool: Pool;
  readonly authRepository: AuthRepository;
  readonly tenantId: string;
  readonly adminId: string;
  readonly identifier: string;
}): Promise<void> {
  const { tenantId, adminId, identifier } = args;
  // A human, an unknown id and another tenant's account look alike (Q62).
  if (!(await serviceAccountExists(args.appPool, tenantId, identifier))) {
    throw new CredentialTargetNotFoundError();
  }
  await withIdentitySpan(
    'identity.service_account.delete',
    { 'tayzu.identity.service_account.id': identifier },
    () =>
      withTenantTransaction(args.appPool, { tenantId }, async (lockClient) => {
        await lockClient.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `service-account:${tenantId}:${identifier}`,
        ]);
        const [keys, revoked] = await Promise.all([
          readAllApiKeys(args.authRepository, tenantId),
          readRevokedIds(args.appPool, tenantId),
        ]);
        for (const key of keys) {
          if (revoked.has(key.id) || readApiKeyMetadata(key.metadata).userId !== identifier) {
            continue;
          }
          await revokeMachineCredential(args.auth, {
            userId: adminId,
            id: key.id,
            pool: args.appPool,
            tenantId,
          });
        }
        await createEntityService({ pool: args.appPool, authz: args.authz }).delete(
          {
            tenantId,
            actor: { ...SYSTEM_READER, onBehalfOf: { type: 'user', id: adminId } },
            principal: { roles: ['admin'] },
          },
          { blueprint: '_user', identifier, detachReferences: true },
        );
        emitIdentityEvent({
          name: 'catalog.audit.service_account_deleted',
          severity: 'INFO',
          attributes: {
            'tayzu.tenant.id': tenantId,
            'tayzu.actor.id': adminId,
            'tayzu.identity.service_account.id': identifier,
          },
        });
        recordIdentityMetric('tayzu.identity.service_accounts', 1, {
          'tayzu.tenant.id': tenantId,
          'tayzu.identity.service_account.mutation': 'deleted',
        });
      }),
  );
}
