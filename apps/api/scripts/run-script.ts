/**
 * Shared entry point of every maintenance script (`043` task 2.0, Resolved
 * decision Q79). It starts telemetry the way `src/telemetry.ts` does, asserts
 * the database role of each pool the script was given, runs the script and
 * shuts the SDK down (which flushes the exporters) in a `finally`.
 */
import type { Pool } from 'pg';

import { startTelemetry } from '../src/telemetry.js';

export interface ScriptRoleCheck {
  /** Asked `SELECT current_user`. */
  readonly pool: Pick<Pool, 'query'>;
  /** The roles the script declares it expects on this pool. */
  readonly roles: readonly string[];
}

export interface RunScriptOptions {
  /** Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly roles?: readonly ScriptRoleCheck[];
}

/** Refuses to run as a role the script did not declare. The message carries no role names. */
async function assertRoles(checks: readonly ScriptRoleCheck[]): Promise<void> {
  for (const { pool, roles } of checks) {
    const result = await pool.query<{ current_user: string }>('SELECT current_user');
    const user = result.rows[0]?.current_user;
    if (user === undefined || !roles.includes(user)) {
      throw new Error('script database role is not one of its declared roles');
    }
  }
}

export async function runScript<T>(
  _name: string,
  fn: () => Promise<T> | T,
  options: RunScriptOptions = {},
): Promise<T> {
  const telemetry = startTelemetry(options.env ?? process.env);
  try {
    await assertRoles(options.roles ?? []);
    return await fn();
  } finally {
    await telemetry?.shutdown();
  }
}
