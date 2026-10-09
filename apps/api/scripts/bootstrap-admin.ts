/**
 * The bootstrap-admin CLI (`043` task 4.6b, design D2 and D9; Resolved
 * decisions Q51, Q116 and Q117). Run by an operator out of band with
 * `pnpm --filter @tayzu/api bootstrap:admin`. `bootstrapAdmin` itself lives in
 * `@tayzu/auth`; the CLI lives here because it needs the adapter of D2.
 *
 * It builds Better Auth the way `createApp` does (the `tayzu_auth` pool, the
 * `tayzu_app` pool and Cerbos) and hands the operator to the adapter as the
 * principal of every `_user` write the membership hook makes.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { authSchema, bootstrapAdmin, createAuth, type UserSyncPort } from '@tayzu/auth';
import { createCerbosClient } from '@tayzu/authz';
import { createUserSync } from '@tayzu/catalog';
import { createPool } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

import { createUserSyncAdapter } from '../src/identity/user-sync-adapter.js';
import { runScript } from './run-script.js';
import { loadScriptConfig } from './script-config.js';

export interface BootstrapAdminCliOptions {
  /** Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Pools the host already built; when given, the script does not end them. */
  readonly appPool?: Pool;
  readonly authPool?: Pool;
}

const CERBOS_TLS_LOOPBACK_ONLY = /^(localhost|127\.0\.0\.1|\[::1\]):\d+$/;

/** Fails closed naming the variable only, never its value. */
function requireEnv(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is required.`);
  }
  return value;
}

export async function main(options: BootstrapAdminCliOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const config = loadScriptConfig('bootstrap-admin', env);
  const operatorId = config.TAYZU_OPERATOR_ID;
  const allowedOrigins = requireEnv(env, 'ALLOWED_ORIGINS')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');
  const params = {
    organizationName: requireEnv(env, 'BOOTSTRAP_ORGANIZATION_NAME'),
    organizationSlug: requireEnv(env, 'BOOTSTRAP_ORGANIZATION_SLUG'),
    adminName: requireEnv(env, 'BOOTSTRAP_ADMIN_NAME'),
    adminEmail: requireEnv(env, 'BOOTSTRAP_ADMIN_EMAIL'),
  };
  const appPool = options.appPool ?? createPool(config.DATABASE_URL);
  let authPool = options.authPool;
  try {
    authPool ??= createPool(config.AUTH_DATABASE_URL);
    const auth = authPool;
    await runScript(
      'bootstrap-admin',
      async () => {
        const authz = createCerbosClient({
          address: config.CERBOS_ADDRESS,
          tls: !CERBOS_TLS_LOOPBACK_ONLY.test(config.CERBOS_ADDRESS),
        });
        const adapter = createUserSyncAdapter({
          userSync: createUserSync({ pool: appPool, authz }),
        });
        // The membership hook makes the single `_user` write; it is attributed to the operator.
        const userSync: UserSyncPort = {
          upsertUser: (input) =>
            adapter.upsertUser({
              ...input,
              principal: { kind: 'operator', id: operatorId },
              onBehalfOf: { type: 'user', id: operatorId },
            }),
        };
        const betterAuth = createAuth({
          db: drizzle(auth, { schema: authSchema }),
          secret: config.BETTER_AUTH_SECRET,
          trustedOrigins: allowedOrigins,
          userSync,
        });
        const result = await bootstrapAdmin(betterAuth, params, { operatorId });
        if (result.created) {
          // The one and only time this temporary password is ever shown
          // (design D22): printed directly to the operator's own terminal, never
          // logged through `@tayzu/observability` or emailed.
          console.log(
            `Bootstrapped organization "${result.organizationSlug}". Sign in as ${result.adminEmail} with this one-time temporary password and change it immediately: ${result.temporaryPassword ?? ''}`,
          );
        } else {
          console.log(
            `Organization "${result.organizationSlug}" is already bootstrapped; nothing to do.`,
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
      `bootstrap failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    );
    process.exitCode = 1;
  });
}
