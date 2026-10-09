/**
 * The bootstrap CLI (task 18.4). `bootstrapAdmin` itself lives in
 * `../src/bootstrap-admin.ts` (043 task 4.6); this entry point moves to
 * `apps/api` in task 4.6b. Guarded to run only when executed directly.
 */
import { pathToFileURL } from 'node:url';

import { createPool } from '@tayzu/db';
import { drizzle } from 'drizzle-orm/node-postgres';

import { createAuth } from '../src/auth.js';
import { bootstrapAdmin } from '../src/bootstrap-admin.js';
import * as authSchema from '../src/persistence/schema.js';

// --- CLI entry point (never imported for its side effects; see module doc comment) ---

/** Fails closed: an operator running this script without every required variable set gets an explicit error, not a partial bootstrap. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is not set: bootstrap-admin needs it to run.`);
  }
  return value;
}

async function main(): Promise<void> {
  const pool = createPool(requireEnv('DATABASE_URL'));
  try {
    const auth = createAuth({
      db: drizzle(pool, { schema: authSchema }),
      secret: requireEnv('BETTER_AUTH_SECRET'),
    });
    const result = await bootstrapAdmin(
      auth,
      {
        organizationName: requireEnv('BOOTSTRAP_ORGANIZATION_NAME'),
        organizationSlug: requireEnv('BOOTSTRAP_ORGANIZATION_SLUG'),
        adminName: requireEnv('BOOTSTRAP_ADMIN_NAME'),
        adminEmail: requireEnv('BOOTSTRAP_ADMIN_EMAIL'),
      },
      { operatorId: requireEnv('TAYZU_OPERATOR_ID') },
    );
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
  } finally {
    await pool.end();
  }
}

const isDirectlyExecuted =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectlyExecuted) {
  await main();
}
