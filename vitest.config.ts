import { defineConfig } from 'vitest/config';

/**
 * Root Vitest entry point: one project per workspace package. Each package's
 * own `vitest.config.ts` (see `vitest.shared.ts`) declares nested `unit` and
 * `int` projects. `pnpm test` runs the packages through Turborepo instead;
 * this config is for `pnpm test:projects` and editor integrations.
 */
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
  },
});
