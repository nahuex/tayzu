/**
 * Playwright configuration of the e2e suite (003 design D16 and D2, task 10.1). The
 * suite runs against the stack of `scripts/ci/e2e.sh` (`pnpm e2e`), never on its own.
 *
 * - Chromium only, from `PLAYWRIGHT_BROWSERS_PATH` when it is set (the sandbox's
 *   `/opt/pw-browsers`, revision 1243, which `@playwright/test` 1.63.0 expects).
 * - The app is reached over `https:` through the stack's TLS proxy. Chromium trusts
 *   only the run's throwaway CA, by the SPKI hash of its certificate (and of the
 *   proxy's), read from `$E2E_STATE_DIR/tls/` when this file loads. TLS errors are
 *   never ignored wholesale.
 * - No retry, and a trace only for a failed test. A trace or a report can hold the
 *   run's random credentials, so both are written to the state directory, outside the
 *   repository, and CI keeps them 3 days (D2).
 */
import { createHash, X509Certificate } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { defineConfig, devices } from '@playwright/test';

import { readSeed, seedFilePath } from './e2e/fixtures/seed-file.js';

/** The state directory of the running stack; fails closed outside `e2e.sh`. */
function stateDir(): string {
  const dir = process.env['E2E_STATE_DIR'];
  if (dir === undefined || dir.trim() === '' || !isAbsolute(dir)) {
    throw new Error('E2E_STATE_DIR is not set: run the suite through scripts/ci/e2e.sh.');
  }
  return dir;
}

/** The base64 SHA-256 of a certificate's SubjectPublicKeyInfo, as Chromium expects it. */
function spkiHash(path: string): string {
  const certificate = new X509Certificate(readFileSync(path));
  const spki = certificate.publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest('base64');
}

/** The app's https origin: the seed's, else the one `e2e.sh` exports. */
function appOrigin(): string {
  const origin = existsSync(seedFilePath()) ? readSeed().appOrigin : process.env['E2E_BASE_URL'];
  if (origin === undefined || new URL(origin).protocol !== 'https:') {
    throw new Error('The e2e base URL must be the https origin of the TLS proxy.');
  }
  return origin;
}

const STATE_DIR = stateDir();
const TLS_DIR = join(STATE_DIR, 'tls');
const TRUSTED_SPKI = [spkiHash(join(TLS_DIR, 'ca.crt')), spkiHash(join(TLS_DIR, 'proxy.crt'))];

export default defineConfig({
  testDir: 'e2e',
  outputDir: join(STATE_DIR, 'playwright', 'test-results'),
  forbidOnly: true,
  retries: 0,
  // One seeded stack, shared users and single-use TOTP codes: one worker, in order.
  fullyParallel: false,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: join(STATE_DIR, 'playwright', 'report') }],
  ],
  use: {
    baseURL: appOrigin(),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [`--ignore-certificate-errors-spki-list=${TRUSTED_SPKI.join(',')}`],
        },
      },
    },
  ],
});
