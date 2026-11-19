import { fileURLToPath } from 'node:url';
import { configDefaults, defineProject, type UserWorkspaceConfig } from 'vitest/config';

/** Unit tests: pure, no database. */
export const UNIT_TEST_GLOB = 'src/**/*.test.ts';

/** Web component tests: jsdom, `.ts` and `.tsx`. */
export const WEB_TEST_GLOB = 'src/**/*.test.{ts,tsx}';

/** Integration tests: need a real PostgreSQL 18 through `DATABASE_URL`. */
export const INTEGRATION_TEST_GLOB = 'src/**/*.int.test.ts';

const integrationGlobalSetup = fileURLToPath(new URL('./vitest.int.setup.ts', import.meta.url));

/** Per-worker stub of the breached-password range query (task 8.1a). */
const integrationFetchStub = fileURLToPath(new URL('./vitest.int.stub.mjs', import.meta.url));

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
            setupFiles: [integrationFetchStub],
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

/**
 * The Vitest config of the web app (`apps/web`). It declares one nested
 * project, `<name> (unit)`, so `pnpm test:unit` (`--project "*unit*"`)
 * selects it like the other packages' unit projects. Tests run under jsdom,
 * and the setup file (owned by the `test-writer`) registers the
 * `@testing-library/jest-dom` matchers. There is no `int` project: component
 * tests replace the network with a fake `fetch` and never need a database.
 */
export function defineWebPackageConfig(name: string): UserWorkspaceConfig {
  return defineProject({
    test: {
      name,
      projects: [
        {
          test: {
            name: 'unit',
            environment: 'jsdom',
            include: [WEB_TEST_GLOB],
            setupFiles: ['src/__fixtures__/setup-tests.ts'],
          },
        },
      ],
    },
  });
}
