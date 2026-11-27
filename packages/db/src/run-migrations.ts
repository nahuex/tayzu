/**
 * CLI entry point for `pnpm db:migrate` (design D1, Migration Plan). Applies
 * every pending migration in `migrations/` through the production path
 * (`createPool`), which requires `sslmode=verify-full` (design D5). There are
 * no deployed environments yet: this runs in CI and in the test harness only.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createPool, runMigrations } from './index.js';

const MIGRATION_URL_MISSING_MESSAGE =
  "MIGRATION_DATABASE_URL is not set: db:migrate needs the migration role's connection string.";

/**
 * Returns the migration role's connection string (design D1, Q5). Reads
 * `MIGRATION_DATABASE_URL` only, and never falls back to `DATABASE_URL`, so no
 * environment can migrate through the runtime URL by accident. A set value is
 * returned unchanged; a blank one counts as unset.
 */
export function resolveMigrationUrl(env: Readonly<Record<string, string | undefined>>): string {
  const url = env.MIGRATION_DATABASE_URL;
  if (url === undefined || url.trim() === '') {
    throw new Error(MIGRATION_URL_MISSING_MESSAGE);
  }
  return url;
}

/** True only when this file is the script Node was asked to run. */
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
  const pool = createPool(resolveMigrationUrl(process.env));
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
}
