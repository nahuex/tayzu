/**
 * Global setup of every package's `int` Vitest project. Vitest runs it once,
 * and only when the run contains at least one `*.int.test.ts` file, so unit
 * runs never need a database.
 *
 * It fails fast when `DATABASE_URL` is missing, then migrates that database
 * before any test file starts (design D12, "Migrations are applied once per
 * run"). Migrating up front also creates the cluster-wide roles before any
 * test file migrates a scratch database of its own: two first migrations on
 * different databases of a fresh cluster would otherwise race on
 * `CREATE ROLE`.
 */
import { prepareTestDatabase } from './packages/db/src/harness.js';

export const MISSING_DATABASE_URL_MESSAGE = [
  'DATABASE_URL is not set. Integration tests (*.int.test.ts) need a real PostgreSQL 16 database.',
  'Export a connection string before running them, for example:',
  '  export DATABASE_URL=postgres://<user>:<password>@localhost:5432/tayzu_test',
  'To run only the unit tests, use `pnpm test:unit`. See CLAUDE.md, "Running tests".',
].join('\n');

export default async function setup(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim() === '') {
    throw new Error(MISSING_DATABASE_URL_MESSAGE);
  }
  await prepareTestDatabase();
}
