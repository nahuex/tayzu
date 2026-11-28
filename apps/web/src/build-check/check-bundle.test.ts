// @vitest-environment node
/**
 * The web build check (task 2.8 of `003-catalog-ui-core`; design D3, D10, SEC09).
 *
 * Assumed API of `./check-bundle.js` (`src/build-check/check-bundle.ts`, Node only):
 *
 * ```ts
 * export type BundleRule =
 *   | 'inline-script'    // index.html has a <script> element without `src`
 *   | 'inline-style'     // index.html has a <style> element
 *   | 'secret-name'      // a file of the build names a Secret-class variable of secrets.md
 *   | 'vite-env'         // a source file uses import.meta.env.VITE_*
 *   | 'external-origin'  // index.html references an http: or https: origin
 *   | 'initial-js-size'; // the initial JavaScript exceeds 350 kB gzip
 *
 * export interface BundleViolation {
 *   rule: BundleRule;
 *   // Posix path relative to `distDir` (relative to `srcDir` for `vite-env`).
 *   file: string;
 * }
 *
 * export interface BundleCheckResult {
 *   ok: boolean; // true exactly when `violations` is empty
 *   violations: BundleViolation[];
 * }
 *
 * export function checkBundle(options: {
 *   distDir: string; // the built `dist/`
 *   srcDir: string; // the app sources scanned for import.meta.env.VITE_*
 *   secretsDocPath: string; // `docs/security/secrets.md`
 * }): Promise<BundleCheckResult>;
 *
 * // The variable names of every table row whose `Class` cell is `Secret`,
 * // with `{A,B}` brace groups expanded.
 * export function readSecretNames(secretsDocPath: string): Promise<string[]>;
 * ```
 *
 * The initial JavaScript is every script that `index.html` loads: each
 * `<script src>` and each `<link rel="modulepreload" href>`, gzip sizes summed.
 * A chunk only reached through a dynamic `import()` is not initial.
 *
 * Fixtures (`__fixtures__/`): `clean/` is a whole build (`bundle/`, named so
 * because `.gitignore` drops every `dist/`) plus its sources (`src/`). Every
 * other directory is an overlay holding only the files that differ from
 * `clean/`; each test copies `clean/` and then its overlay into a fresh
 * temporary directory. The oversized JavaScript is random data generated per
 * test, never a committed file. `secrets.md` is a trimmed copy of the tables
 * of `docs/security/secrets.md`, with one fixture-only Secret row
 * (`TAYZU_FIXTURE_CANARY_SECRET`).
 */
import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import { checkBundle, readSecretNames, type BundleCheckResult } from './check-bundle.js';

const FIXTURES = fileURLToPath(new URL('./__fixtures__/', import.meta.url));
const FIXTURE_SECRETS_DOC = join(FIXTURES, 'secrets.md');
const REAL_SECRETS_DOC = fileURLToPath(
  new URL('../../../../docs/security/secrets.md', import.meta.url),
);

const CANARY_SECRET = 'TAYZU_FIXTURE_CANARY_SECRET';

/** The Secret-class names of `docs/security/secrets.md` that task 2.8 lists. */
const EXPECTED_SECRET_NAMES = [
  'DATABASE_URL',
  'AUTH_DATABASE_URL',
  'BETTER_AUTH_SECRETS',
  'VISMA_CONNECT_CLIENT_SECRET',
  'ACS_CONNECTION_STRING',
  'IDENTITY_TOKEN_HMAC_SECRET',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
  'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
  'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
  // The role URLs of the org-deletion jobs.
  'PURGE_DATABASE_URL',
  'REVERSAL_DATABASE_URL',
];

/** Names whose rows are only Sensitive or Setting, or sit in a table without a Class column. */
const NOT_SECRET_NAMES = [
  'VISMA_CONNECT_CLIENT_ID',
  'BETTER_AUTH_URL',
  'EMAIL_PROVIDER',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'NODE_ENV',
  'TAYZU_OPERATOR_ID',
  'PRE_AUTH_SIGN_IN_RATE_LIMIT_MAX',
];

/** The file names of the clean build (`__fixtures__/clean/bundle/`). */
const ENTRY_CHUNK = 'assets/index-C1eanAaa.js';
const PRELOADED_CHUNK = 'assets/vendor-C1eanBbb.js';
const LAZY_CHUNK = 'assets/route-C1eanDdd.js';

/** Comfortably above 350 kB gzip, whether a kB is 1000 or 1024 bytes. */
const OVER_BUDGET_RANDOM_BYTES = 600_000;
/** Comfortably below 350 kB gzip on its own. */
const UNDER_BUDGET_RANDOM_BYTES = 250_000;
/** Two of these are over the budget together, while each is under it alone. */
const HALF_BUDGET_RANDOM_BYTES = 200_000;
const BUDGET_UPPER_BOUND_BYTES = 350 * 1024;

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Tree {
  distDir: string;
  srcDir: string;
}

/** Copies the clean fixture, then the named overlay, into a fresh temporary directory. */
async function materialize(overlay?: string): Promise<Tree> {
  const root = await mkdtemp(join(tmpdir(), 'tayzu-check-bundle-'));
  tempRoots.push(root);
  await cp(join(FIXTURES, 'clean'), root, { recursive: true });
  if (overlay !== undefined) {
    await cp(join(FIXTURES, overlay), root, { recursive: true, force: true });
  }
  return { distDir: join(root, 'bundle'), srcDir: join(root, 'src') };
}

function check(tree: Tree, secretsDocPath = FIXTURE_SECRETS_DOC): Promise<BundleCheckResult> {
  return checkBundle({ ...tree, secretsDocPath });
}

/** An ES module whose only content is incompressible: random bytes, base64-encoded. */
function incompressibleModule(randomByteCount: number): string {
  return `export const blob = '${randomBytes(randomByteCount).toString('base64')}';\n`;
}

function gzipSize(content: string): number {
  return gzipSync(content).length;
}

function expectPass(result: BundleCheckResult): void {
  expect(result.violations).toEqual([]);
  expect(result.ok).toBe(true);
}

/** The build fails on `rule` alone, and one of its violations names `file`. */
function expectOnlyRule(result: BundleCheckResult, rule: string, file?: string): void {
  expect(result.ok).toBe(false);
  expect(result.violations.length).toBeGreaterThan(0);
  expect(new Set(result.violations.map((violation) => violation.rule))).toEqual(new Set([rule]));
  if (file !== undefined) {
    expect(
      result.violations.map((violation) => ({ rule: violation.rule, file: violation.file })),
    ).toContainEqual({ rule, file });
  }
}

describe('readSecretNames', () => {
  it('reads every Secret-class name of the fixture copy, expanding the per-signal OTLP headers', async () => {
    const names = await readSecretNames(FIXTURE_SECRETS_DOC);

    expect(names).toEqual(expect.arrayContaining([...EXPECTED_SECRET_NAMES, CANARY_SECRET]));
  });

  it('leaves out Sensitive and Setting rows and tables without a Class column', async () => {
    const names = await readSecretNames(FIXTURE_SECRETS_DOC);

    for (const name of NOT_SECRET_NAMES) {
      expect(names).not.toContain(name);
    }
  });

  it('reads the same Secret-class names from the real docs/security/secrets.md', async () => {
    const names = await readSecretNames(REAL_SECRETS_DOC);

    expect(names).toEqual(expect.arrayContaining(EXPECTED_SECRET_NAMES));
    expect(names).not.toContain(CANARY_SECRET);
  });
});

describe('checkBundle', () => {
  it('passes the clean build', async () => {
    expectPass(await check(await materialize()));
  });

  describe('inline script in index.html', () => {
    it('fails a classic inline <script>', async () => {
      const result = await check(await materialize('inline-script'));

      expectOnlyRule(result, 'inline-script', 'index.html');
    });

    it('fails an inline module <script>', async () => {
      const tree = await materialize();
      const indexPath = join(tree.distDir, 'index.html');
      const html = await readFile(indexPath, 'utf8');
      await writeFile(
        indexPath,
        html.replace(
          '</head>',
          `  <script type="module">import '/${ENTRY_CHUNK}';</script>\n  </head>`,
        ),
      );

      const result = await check(tree);

      expectOnlyRule(result, 'inline-script', 'index.html');
    });
  });

  it('fails an inline <style> in index.html', async () => {
    const result = await check(await materialize('inline-style'));

    expectOnlyRule(result, 'inline-style', 'index.html');
  });

  describe('server secret names in dist', () => {
    it('fails a build file that names a Secret-class variable', async () => {
      const result = await check(await materialize('secret-name'));

      expectOnlyRule(result, 'secret-name', 'assets/settings-S3crtNam.js');
    });

    it.each(EXPECTED_SECRET_NAMES)('fails any build file that names %s', async (name) => {
      const tree = await materialize();
      await writeFile(join(tree.distDir, 'assets', 'leak.txt'), `config: ${name}\n`);

      const result = await check(tree);

      expectOnlyRule(result, 'secret-name', 'assets/leak.txt');
    });

    it('takes the names from the given secrets document', async () => {
      const tree = await materialize();
      await writeFile(join(tree.distDir, 'assets', 'leak.txt'), `config: ${CANARY_SECRET}\n`);

      expectOnlyRule(await check(tree, FIXTURE_SECRETS_DOC), 'secret-name', 'assets/leak.txt');
      expectPass(await check(tree, REAL_SECRETS_DOC));
    });
  });

  it('fails a source that uses import.meta.env.VITE_*', async () => {
    const result = await check(await materialize('vite-env'));

    expectOnlyRule(result, 'vite-env', 'config.js');
  });

  describe('external origins in index.html', () => {
    it('fails an https: origin', async () => {
      const result = await check(await materialize('external-origin-https'));

      expectOnlyRule(result, 'external-origin', 'index.html');
    });

    it('fails an http: origin', async () => {
      const result = await check(await materialize('external-origin-http'));

      expectOnlyRule(result, 'external-origin', 'index.html');
    });
  });

  describe('initial JavaScript budget (350 kB gzip)', () => {
    it('fails when the entry script exceeds the budget', async () => {
      const tree = await materialize();
      const entry = incompressibleModule(OVER_BUDGET_RANDOM_BYTES);
      expect(gzipSize(entry)).toBeGreaterThan(BUDGET_UPPER_BOUND_BYTES);
      await writeFile(join(tree.distDir, ENTRY_CHUNK), entry);

      const result = await check(tree);

      expectOnlyRule(result, 'initial-js-size');
    });

    it('fails when the entry and its preloaded chunk exceed the budget together', async () => {
      const tree = await materialize();
      const entry = incompressibleModule(HALF_BUDGET_RANDOM_BYTES);
      const preloaded = incompressibleModule(HALF_BUDGET_RANDOM_BYTES);
      expect(gzipSize(entry)).toBeLessThan(350_000);
      expect(gzipSize(preloaded)).toBeLessThan(350_000);
      expect(gzipSize(entry) + gzipSize(preloaded)).toBeGreaterThan(BUDGET_UPPER_BOUND_BYTES);
      await writeFile(join(tree.distDir, ENTRY_CHUNK), entry);
      await writeFile(join(tree.distDir, PRELOADED_CHUNK), preloaded);

      const result = await check(tree);

      expectOnlyRule(result, 'initial-js-size');
    });

    it('passes when the initial JavaScript is under the budget', async () => {
      const tree = await materialize();
      const entry = incompressibleModule(UNDER_BUDGET_RANDOM_BYTES);
      expect(gzipSize(entry)).toBeGreaterThan(UNDER_BUDGET_RANDOM_BYTES);
      expect(gzipSize(entry)).toBeLessThan(340_000);
      await writeFile(join(tree.distDir, ENTRY_CHUNK), entry);

      expectPass(await check(tree));
    });

    it('does not count a lazily loaded chunk', async () => {
      const tree = await materialize();
      const lazy = incompressibleModule(OVER_BUDGET_RANDOM_BYTES);
      expect(gzipSize(lazy)).toBeGreaterThan(BUDGET_UPPER_BOUND_BYTES);
      await writeFile(join(tree.distDir, LAZY_CHUNK), lazy);

      expectPass(await check(tree));
    });
  });
});
