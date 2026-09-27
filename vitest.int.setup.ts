/**
 * Global setup of every package's `int` Vitest project. Vitest runs it once,
 * and only when the run contains at least one `*.int.test.ts` file, so unit
 * runs never need a database.
 */
export const MISSING_DATABASE_URL_MESSAGE = [
  'DATABASE_URL is not set. Integration tests (*.int.test.ts) need a real PostgreSQL 16 database.',
  'Export a connection string before running them, for example:',
  '  export DATABASE_URL=postgres://<user>:<password>@localhost:5432/tayzu_test',
  'To run only the unit tests, use `pnpm test:unit`. See CLAUDE.md, "Running tests".',
].join('\n');

export default function setup(): void {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim() === '') {
    throw new Error(MISSING_DATABASE_URL_MESSAGE);
  }
}
