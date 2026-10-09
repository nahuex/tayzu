/**
 * Reconcile of members and `_user` rows (`043` design D1, D9, Q50, Q62, Q84 and
 * Q124). Run with `pnpm --filter @tayzu/api identity:reconcile-users`.
 *
 * Per tenant it creates the `_user` row of every member that has none (through
 * the adapter of D2 and the `membership_added` intent, so a banned user ends
 * `Disabled`), leaves an existing row untouched, and removes the orphans: an
 * `Active` human row with no member whose `updatedAt` is more than an hour old.
 * Organizations and members are listed on the `tayzu_auth` pool (enumerating
 * tenants is cross-tenant by nature); `_user` writes go through `tayzu_app`.
 * Every write is attributed to the operator (`TAYZU_OPERATOR_ID`).
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { emitIdentityEvent, withIdentitySpan } from '@tayzu/auth';
import { createCerbosClient } from '@tayzu/authz';
import { createEntityService, createUserSync } from '@tayzu/catalog';
import { createPool } from '@tayzu/db';
import type { Pool } from 'pg';

import { createUserSyncAdapter } from '../src/identity/user-sync-adapter.js';
import { runScript } from './run-script.js';
import { loadScriptConfig } from './script-config.js';

export interface ReconcileOptions {
  /** Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Pools the host already built; when given, the script does not end them. */
  readonly appPool?: Pool;
  readonly authPool?: Pool;
  /** The clock seam of the orphan grace period. */
  readonly now?: () => Date;
}

const CERBOS_TLS_LOOPBACK_ONLY = /^(localhost|127\.0\.0\.1|\[::1\]):\d+$/;
const ORPHAN_GRACE_MS = 60 * 60 * 1000;
const SYSTEM_ACTOR_ID = 'reconcile-users';

interface MemberRow {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: string;
  readonly banned: boolean | null;
}

/** design Q2: `owner`/`admin` organization roles map to `portRole` `admin`. */
function portRoleFor(role: string): 'admin' | 'member' {
  return role === 'owner' || role === 'admin' ? 'admin' : 'member';
}

export async function main(options: ReconcileOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const config = loadScriptConfig('reconcile-users', env);
  const operatorId = config.TAYZU_OPERATOR_ID;
  const appPool = options.appPool ?? createPool(config.DATABASE_URL);
  let authPool = options.authPool;
  try {
    authPool ??= createPool(config.AUTH_DATABASE_URL);
    const auth = authPool;
    await runScript(
      'reconcile-users',
      async () => {
        const authz = createCerbosClient({
          address: config.CERBOS_ADDRESS,
          tls: !CERBOS_TLS_LOOPBACK_ONLY.test(config.CERBOS_ADDRESS),
        });
        const userSync = createUserSync({ pool: appPool, authz });
        const adapter = createUserSyncAdapter({ userSync });
        const entities = createEntityService({ pool: appPool, authz });
        const onBehalfOf = { type: 'user', id: operatorId } as const;

        const tenants = await auth.query<{ id: string }>(
          'select id from auth.organization order by id',
        );
        for (const { id: tenantId } of tenants.rows) {
          await withIdentitySpan(
            'identity.user.reconcile',
            { 'tayzu.tenant.id': tenantId, 'tayzu.identity.operator.id': operatorId },
            async () => {
              const members = await auth.query<MemberRow>(
                `select u.id, u.email, u.name, m.role, u.banned
                   from auth.member m
                   join auth."user" u on u.id = m.user_id
                  where m.organization_id = $1
                  order by u.id`,
                [tenantId],
              );

              let created = 0;
              for (const member of members.rows) {
                if ((await userSync.getUser({ tenantId, email: member.email })) !== null) continue;
                await adapter.writeUserChange({
                  tenantId,
                  email: member.email,
                  name: member.name,
                  portRole: portRoleFor(member.role),
                  userId: member.id,
                  change: { intent: 'membership_added', banned: member.banned === true },
                  principal: { kind: 'operator', id: operatorId },
                  onBehalfOf,
                });
                created += 1;
              }

              const memberEmails = new Set(members.rows.map((member) => member.email));
              const context = {
                tenantId,
                actor: { type: 'system', id: SYSTEM_ACTOR_ID, onBehalfOf },
                principal: { roles: ['admin'] },
              };
              const cutoff = now().getTime() - ORPHAN_GRACE_MS;
              const orphans: string[] = [];
              let cursor: string | undefined;
              do {
                let page;
                try {
                  page = await entities.list(context, {
                    blueprint: '_user',
                    ...(cursor === undefined ? {} : { cursor }),
                  });
                } catch (error) {
                  // A tenant that has no `_user` blueprint yet has no rows either.
                  if ((error as { code?: unknown }).code === 'CATALOG_NOT_FOUND') break;
                  throw error;
                }
                for (const row of page.items) {
                  const properties = row.spec.properties;
                  if (
                    properties['status'] === 'Active' &&
                    properties['accountKind'] !== 'service' &&
                    !memberEmails.has(row.identifier) &&
                    Date.parse(row.updatedAt) < cutoff
                  ) {
                    orphans.push(row.identifier);
                  }
                }
                cursor = page.cursor;
              } while (cursor !== undefined);

              for (const identifier of orphans) {
                await entities.delete(context, {
                  blueprint: '_user',
                  identifier,
                  detachReferences: true,
                });
              }

              emitIdentityEvent({
                name: 'catalog.audit.users_reconciled',
                severity: 'INFO',
                attributes: {
                  'tayzu.tenant.id': tenantId,
                  'tayzu.identity.operator.id': operatorId,
                  'tayzu.identity.reconcile.created': created,
                  'tayzu.identity.reconcile.orphans': orphans.length,
                },
              });
            },
          );
        }
      },
      {
        env,
        roles: [
          { pool: appPool, roles: ['tayzu_app'] },
          { pool: auth, roles: ['tayzu_auth'] },
        ],
      },
    );
  } finally {
    if (options.appPool === undefined) await appPool.end();
    if (options.authPool === undefined) await authPool?.end();
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((error: unknown) => {
    // Only the message: never the stack or the environment.
    process.stderr.write(
      `reconcile failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    );
    process.exitCode = 1;
  });
}
