import { fileURLToPath } from 'node:url';
import { configDefaults, defineProject, type UserWorkspaceConfig } from 'vitest/config';

/** Unit tests: pure, no database. */
export const UNIT_TEST_GLOB = 'src/**/*.test.ts';

/** Integration tests: need a real PostgreSQL 16 through `DATABASE_URL`. */
export const INTEGRATION_TEST_GLOB = 'src/**/*.int.test.ts';

const integrationGlobalSetup = fileURLToPath(new URL('./vitest.int.setup.ts', import.meta.url));

/**
 * The Vitest config of one workspace package. It declares two nested
 * projects, `<name> (unit)` and `<name> (int)`:
 *
 * - `vitest run` runs both (`pnpm test`).
 * - `vitest run --project "*unit*"` runs unit tests only (`pnpm test:unit`).
 *
 * The `int` project has a global setup that fails fast when `DATABASE_URL`
 * is missing. Vitest only runs it when the run contains integration tests.
 */
export function definePackageConfig(name: string): UserWorkspaceConfig {
  return defineProject({
    test: {
      name,
      projects: [
        {
          test: {
            name: 'unit',
            environment: 'node',
            include: [UNIT_TEST_GLOB],
            exclude: [...configDefaults.exclude, INTEGRATION_TEST_GLOB],
          },
        },
        {
          test: {
            name: 'int',
            environment: 'node',
            include: [INTEGRATION_TEST_GLOB],
            globalSetup: [integrationGlobalSetup],
            // Integration tests hash passwords and round-trip Postgres and
            // Cerbos; under Turborepo's parallel package runs one shared
            // database and CPU make 5 s (the default) too tight. A timeout
            // is not an assertion: tests still fail on any wrong result.
            testTimeout: 30_000,
            hookTimeout: 60_000,
          },
        },
      ],
    },
  });
}
