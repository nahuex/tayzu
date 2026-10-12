/**
 * Orchestration of service accounts (`043` design D6).
 *
 * Scaffolded by `043` task 1.4 (design Q30); the rest of its behavior arrives with
 * task group 10.
 */
import { emitIdentityEvent, withIdentitySpan, type AuthInstance } from '@tayzu/auth';
import { createMachineCredential } from '@tayzu/auth/machine-credentials';
import type { CerbosClient } from '@tayzu/authz';
import { createEntityService, type EntityService } from '@tayzu/catalog';
import { withTenantTransaction } from '@tayzu/db';
import type { Pool } from 'pg';

import type { AuthRepository } from './auth-repository.js';
import {
  CredentialConflictError,
  readAllApiKeys,
  readApiKeyMetadata,
  readRevokedIds,
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
        const [keys, revoked] = await Promise.all([
          readAllApiKeys(args.authRepository, tenantId),
          readRevokedIds(args.appPool, tenantId),
        ]);
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
        return { user, clientId: key.id, clientSecret: key.secret };
      }),
  );
}
