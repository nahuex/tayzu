/**
 * Backfill of the `_user` blueprint extension, run once per existing tenant
 * (`043` design D1 and D9). Run with `pnpm --filter @tayzu/api
 * identity:backfill-user-blueprint`.
 *
 * It lists tenants from `auth.organization` through the `tayzu_auth` pool
 * (row-level security blocks enumerating tenants through `tayzu_app`) and
 * brings each tenant's `_user` forward through `blueprints.update` as the
 * `system` actor, one tenant at a time. A tenant already on the builder's
 * schema is skipped, which makes a second run a no-op. Any other failure
 * propagates and fails the run.
 */
import { realpathSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

import { createCerbosClient } from '@tayzu/authz';
import { buildUserBlueprintInput, createBlueprintService } from '@tayzu/catalog';
import { createPool } from '@tayzu/db';
import type { Pool } from 'pg';

import { runScript } from './run-script.js';
import { loadScriptConfig } from './script-config.js';

export interface BackfillOptions {
  /** Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Pools the host already built; when given, the script does not end them. */
  readonly appPool?: Pool;
  readonly authPool?: Pool;
}

const SYSTEM_ACTOR = { type: 'system', id: 'backfill-user-blueprint' } as const;
const CERBOS_TLS_LOOPBACK_ONLY = /^(localhost|127\.0\.0\.1|\[::1\]):\d+$/;

export async function main(options: BackfillOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const config = loadScriptConfig('backfill-user-blueprint', env);
  const appPool = options.appPool ?? createPool(config.DATABASE_URL);
  let authPool = options.authPool;
  try {
    authPool ??= createPool(config.AUTH_DATABASE_URL);
    const auth = authPool;
    await runScript(
      'backfill-user-blueprint',
      async () => {
        const authz = createCerbosClient({
          address: config.CERBOS_ADDRESS,
          tls: !CERBOS_TLS_LOOPBACK_ONLY.test(config.CERBOS_ADDRESS),
        });
        const blueprints = createBlueprintService({ pool: appPool, authz });
        const desired = buildUserBlueprintInput();
        // The service stores `required` as `[]` when the input omits it, so the
        // comparison is against the stored form of the builder's schema.
        const storedForm = { required: [], ...desired.schema };
        const tenants = await auth.query<{ id: string }>(
          'select id from auth.organization order by id',
        );
        for (const { id: tenantId } of tenants.rows) {
          const context = { tenantId, actor: SYSTEM_ACTOR, principal: { roles: ['admin'] } };
          const current = await blueprints.get(context, { identifier: desired.identifier });
          if (isDeepStrictEqual(current.schema, storedForm)) continue;
          await blueprints.update(context, desired);
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
      `backfill failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    );
    process.exitCode = 1;
  });
}
