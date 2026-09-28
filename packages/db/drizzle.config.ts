/**
 * drizzle-kit configuration (design D1, D4). Each capability owns its table
 * definitions in `packages/<capability>/src/persistence/schema.ts`; this
 * package only globs them to generate and order the migrations it owns, and
 * never imports a capability package (no dependency cycle).
 *
 * `pnpm db:generate` runs `drizzle-kit generate` from this package. Migration
 * SQL is always generated, never hand-written (Migration Plan), except for
 * the custom migrations that Drizzle cannot express (for example the
 * append-only trigger), which are scaffolded with `drizzle-kit generate
 * --custom` and then hand-written.
 */
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: '../*/src/persistence/schema.ts',
  out: './migrations',
});
