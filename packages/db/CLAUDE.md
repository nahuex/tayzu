# @tayzu/db

PostgreSQL access shared by every capability: the `pg` pool, the tenant
transaction seam for RLS, the migration runner, and the migrations directory.
Global rules are in the root `CLAUDE.md`. Design references: D1, D4, D5 and D12
of `openspec/changes/archive/2026-09-28-001-catalog-core/design.md`.

## Boundaries

- Never import a capability package such as `@tayzu/catalog`. Each capability
  owns its Drizzle table definitions in
  `packages/<capability>/src/persistence/schema.ts`, and `drizzle.config.ts`
  here globs those files. That keeps the dependency graph acyclic.
- This package owns `migrations/` and the order of the migrations in it.

## Migrations (Checkpoint 3)

- Migrations are generated with `drizzle-kit generate` from the table
  definitions. Never hand-write or hand-edit migration SQL. Keep the generated
  down script next to each migration.
- Every new or changed migration stops at **Checkpoint 3**: present the SQL to
  the human and wait for explicit approval before continuing, even when the
  rest of the PR is already approved.
- No roles, grants or RLS policies before `002-auth-and-rbac`.
- Migrations are applied by `pnpm db:migrate` in CI and by the test harness
  only. There are no deployed environments yet.
- Any future migration that adds a table or sequence to schema `auth` must
  grant `tayzu_auth` `SELECT`/`INSERT`/`UPDATE`/`DELETE` (and sequence
  `USAGE`/`SELECT`) on it explicitly, in that same migration: 0003's
  `GRANT ... ON ALL TABLES`/`ALL SEQUENCES` only covers what existed in schema
  `auth` when it ran. `ALTER DEFAULT PRIVILEGES` would cover future objects
  too, but only from the role that creates them, which needs a migrator role
  (task 6.x) — until then, grant explicitly, per migration.

## SQL and tenant transactions

- `withTenantTransaction(ctx, fn)` runs
  `SELECT set_config('app.tenant_id', $1, true), set_config('statement_timeout', $2, true)`.
  `SET LOCAL` cannot take bind parameters, so it is never used with a tenant
  value.
- Parameterized SQL only: Drizzle query builders or the `sql` template tag.
  `sql.raw` is banned by lint.
- Repositories still filter by `tenant_id` explicitly in every query. RLS
  (002) is an extra layer, not a replacement.
- Map database errors by **constraint name**, never by SQLSTATE alone. A
  Postgres error message, `detail` or `where` can embed row values, so it never
  reaches telemetry, logs or a response.

## Connections

- `createPool(url)` requires `sslmode=verify-full` outside the test harness
  and refuses to start otherwise. Only the test harness may connect to a local
  database without TLS.
- `DATABASE_URL` comes from the environment only. Never log it, print it or
  commit it.

## Tests

- Integration tests (`*.int.test.ts`) run against a real PostgreSQL 16 through
  `DATABASE_URL`. `getTestDatabase()` applies the migrations once per run and
  throws an explicit error when the URL is unset.
- Isolation is tenant-per-test: each test generates a random `tenantId`. Never
  truncate or drop shared tables in a test.
- `pnpm --filter @tayzu/db test` runs unit and integration tests;
  `pnpm --filter @tayzu/db test:unit` runs the unit tests only.
