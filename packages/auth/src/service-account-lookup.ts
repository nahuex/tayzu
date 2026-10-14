/**
 * The `_user` lookup behind the machine token exchange (task 14.16, Resolved
 * decision Q138; design D13 machine branch, Q40). It reads the service
 * account's bound `_user` under the credential's tenant, so the exchange can
 * refuse a `Disabled` or deleted service account (task 11.7).
 */
import { withTenantTransaction, type createPool } from '@tayzu/db';

import type { ExchangeMachineTokenPorts } from './token-exchange.js';

/** Builds the `serviceAccountLookup` port over a `tayzu_app` pool. */
export function createServiceAccountLookup(
  pool: ReturnType<typeof createPool>,
): NonNullable<ExchangeMachineTokenPorts['serviceAccountLookup']> {
  return ({ tenantId, userId }) =>
    withTenantTransaction(pool, { tenantId }, async (client) => {
      const result = await client.query<{ properties: Record<string, unknown> }>(
        `select e.spec_properties as properties
           from catalog_entity e
           join catalog_blueprint b on b.tenant_id = e.tenant_id and b.id = e.blueprint_id
          where e.tenant_id = $1 and b.identifier = '_user' and e.identifier = $2`,
        [tenantId, userId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        return null;
      }
      const status = row.properties['status'];
      return { status: typeof status === 'string' ? status : '', properties: row.properties };
    });
}
