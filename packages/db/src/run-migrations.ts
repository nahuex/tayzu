/**
 * CLI entry point for `pnpm db:migrate` (design D1, Migration Plan). Applies
 * every pending migration in `migrations/` through the production path
 * (`createPool`), which requires `sslmode=verify-full` (design D5). There are
 * no deployed environments yet: this runs in CI and in the test harness only.
 */
import { createPool, runMigrations } from './index.js';

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim() === '') {
    throw new Error('DATABASE_URL is not set: db:migrate needs a PostgreSQL connection string.');
  }
  return url;
}

const pool = createPool(requireDatabaseUrl());
try {
  await runMigrations(pool);
} finally {
  await pool.end();
}
