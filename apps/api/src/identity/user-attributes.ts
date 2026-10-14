/**
 * Reads the `_user` attributes the identity policies depend on (`043` design D3, Resolved
 * decision Q62): `accountKind`, `portRole` and `moderatedBlueprints`. The read is
 * tenant-scoped and parameterized; a missing row answers `undefined`.
 */
import { withTenantTransaction } from '@tayzu/db';
import type { Pool } from 'pg';

import type { ResolvedIdentityAttributes } from './identity-target.js';

interface UserPropertiesRow {
  account_kind: string | null;
  port_role: string | null;
  moderated_blueprints: unknown;
}

/** The `_user` of the tenant with this identifier (an email, or a `svc-…` identifier). */
export async function readUserAttributes(
  appPool: Pool,
  tenantId: string,
  identifier: string,
): Promise<ResolvedIdentityAttributes | undefined> {
  const row = await withTenantTransaction(appPool, { tenantId }, async (client) => {
    const result = await client.query<UserPropertiesRow>(
      `select e.spec_properties ->> 'accountKind' as account_kind,
              e.spec_properties ->> 'portRole' as port_role,
              e.spec_properties -> 'moderatedBlueprints' as moderated_blueprints
         from catalog_entity e
         join catalog_blueprint b on b.tenant_id = e.tenant_id and b.id = e.blueprint_id
        where e.tenant_id = $1 and b.identifier = '_user' and e.identifier = $2`,
      [tenantId, identifier],
    );
    return result.rows[0];
  });
  if (row === undefined) return undefined;
  const moderated = Array.isArray(row.moderated_blueprints)
    ? row.moderated_blueprints.filter((value): value is string => typeof value === 'string')
    : [];
  return {
    accountKind: row.account_kind ?? 'standard',
    ...(row.port_role === null ? {} : { portRole: row.port_role }),
    moderatedBlueprints: moderated,
  };
}
