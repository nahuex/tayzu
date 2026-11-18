/**
 * The deletion-marker lookup (`045` design D4): a tenant with a `pending` or a
 * `purged` deletion marker is closed to every principal and to invitation
 * acceptance; a `cancelled` marker (a tombstone) does not close it.
 *
 * The marker is read as `tayzu_app` inside the tenant's own transaction, so the
 * `tenant_isolation` policy of migration `0013` shows only that tenant's rows.
 */
import { withTenantTransaction, type createPool } from '@tayzu/db';

import { emitIdentityEvent } from './telemetry/identity-telemetry.js';
import { principalRejectionsCounter } from './telemetry/instruments.js';

/**
 * Resolves `true` when the tenant has a `pending` or a `purged` marker, `false`
 * for none or only `cancelled` ones. Rejects on a lookup failure, which every
 * caller treats as closed (fail closed).
 */
export type TenantDeletionLookup = (tenantId: string) => Promise<boolean>;

/** Builds the lookup over a `tayzu_app` pool. */
export function createTenantDeletionLookup(
  pool: ReturnType<typeof createPool>,
): TenantDeletionLookup {
  return (tenantId) =>
    withTenantTransaction(pool, { tenantId }, async (client) => {
      const result = await client.query(
        `select 1 from tenant_deletion_marker
          where tenant_id = $1 and state in ('pending', 'purged')
          limit 1`,
        [tenantId],
      );
      return result.rows.length > 0;
    });
}

/**
 * Logs `catalog.security.principal_rejected` with the reason
 * `tenant_pending_deletion` and counts it (design D4). Only the reason and the
 * actor type, never the tenant or the credential.
 */
export function emitTenantPendingDeletionRejection(actorType: string): void {
  const attributes = {
    'tayzu.identity.rejection.reason': 'tenant_pending_deletion',
    'tayzu.actor.type': actorType,
  };
  principalRejectionsCounter.add(1, attributes);
  emitIdentityEvent({ name: 'catalog.security.principal_rejected', severity: 'WARN', attributes });
}
