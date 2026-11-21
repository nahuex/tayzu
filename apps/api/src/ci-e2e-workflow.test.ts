/**
 * `003` task 10.11 (design D2 and D16, Resolved decisions Q38 and Q91): the `e2e`
 * job of `.github/workflows/ci.yml` and the e2e step of `scripts/ci/local.sh`.
 *
 * Both files are outside every package, so, like `zap-seed.test.ts`,
 * `dast-script.test.ts` and `identity-maintenance-workflow.test.ts`, this text test
 * lives in `apps/api/src`. No YAML parser is a dependency, so the workflow is read
 * with a minimal indentation-based reader of the subset GitHub Actions files use
 * (the one of `identity-maintenance-workflow.test.ts`).
 *
 * ## Contract (red phase: neither the job nor the local step exists yet)
 *
 * `.github/workflows/ci.yml` gains a job keyed `e2e`, on an `ubuntu-*` runner, whose
 * steps are, in this order:
 *
 * 1. `actions/checkout@<40-hex SHA>` (the SHA every other job uses) with
 *    `persist-credentials: false`;
 * 2. `uses: ./.github/actions/setup` (pnpm, Node, `pnpm install --frozen-lockfile`;
 *    every action it uses is pinned by SHA);
 * 3. a `run:` step starting the pinned Cerbos image, the
 *    `ghcr.io/cerbos/cerbos@sha256:<digest>` the `test` job runs, publishing
 *    `3592:3592` and `3593:3593` and mounting `$GITHUB_WORKSPACE/policies`;
 * 4. a `run:` step waiting for `http://localhost:3592/_cerbos/health` and failing
 *    with `exit 1` when it never answers (`e2e.sh up` checks it once);
 * 5. a `run:` step installing Chromium with the pinned Playwright of `@tayzu/web`
 *    (`@playwright/test` at an exact version): `pnpm --filter @tayzu/web exec
 *    playwright install --with-deps chromium`, `pnpm --dir apps/web exec …`, or
 *    `pnpm exec playwright install --with-deps chromium` with
 *    `working-directory: apps/web`. Never `npx`, `pnpm dlx` or a `playwright@<v>`;
 * 6. a step whose `run:` is exactly `pnpm e2e` (`bash scripts/ci/e2e.sh all`);
 * 7. `actions/upload-artifact@<40-hex SHA>` (the SHA the `sbom` job uses) with
 *    `if: failure()` (nothing else), `retention-days: 3`, and a `path` under
 *    `<state dir>/playwright` (the report and the traces of `playwright.config.ts`),
 *    where the state dir is `${{ runner.temp }}/tayzu-e2e` (`e2e.sh`'s default) unless
 *    the job or the step sets `E2E_STATE_DIR`. Never the state dir itself: a failed
 *    run keeps `seed.json` and the TLS keys there.
 *
 * PostgreSQL 18 (reading of the task's "PostgreSQL 18 service"): it is the
 * container `e2e.sh up` starts from the `postgres:18` digest of
 * `scripts/ci/Dockerfile.images` (the digest the `test` job's service runs), with
 * `ssl=on` and a per-run CA, so every connection is `sslmode=verify-full`. A GitHub
 * service container starts before the checkout and cannot be given that run's
 * certificate, so the job declares **no** `services:`, no `DATABASE_URL` and no
 * `E2E_PG_IMAGE` override. Docker is available on GitHub's Ubuntu runners.
 *
 * The job reads no `secrets.*` (every credential is random per run, D16), declares no
 * `write` permission, and no `run:` in the workflow interpolates `${{ inputs.* }}` or
 * reads `github.event.*`.
 *
 * `scripts/ci/local.sh` gains, after the `dast` step, a step whose description names
 * `e2e` and whose command is a shell function defined in `local.sh`. When no
 * Playwright Chromium is installed, the function prints a line containing `SKIP` and
 * returns `$SKIP_EXIT_CODE` (77) before it runs anything else; otherwise it runs
 * `bash "$SCRIPT_DIR/e2e.sh" all`, which exits 77 without Docker, so `step` prints
 * `SKIPPED:` as it does for DAST.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const WORKFLOW_PATH = join(repoRoot, '.github', 'workflows', 'ci.yml');
const SETUP_ACTION_PATH = join(repoRoot, '.github', 'actions', 'setup', 'action.yml');
const LOCAL_SH_PATH = join(repoRoot, 'scripts', 'ci', 'local.sh');
const E2E_SH_PATH = join(repoRoot, 'scripts', 'ci', 'e2e.sh');
const IMAGES_PATH = join(repoRoot, 'scripts', 'ci', 'Dockerfile.images');
const WEB_PACKAGE_PATH = join(repoRoot, 'apps', 'web', 'package.json');

const E2E_JOB = 'e2e';
const CERBOS_IMAGE = /ghcr\.io\/cerbos\/cerbos@sha256:[0-9a-f]{64}/;
const POSTGRES_18_IMAGE = /^postgres:18@sha256:[0-9a-f]{64}$/;
const CERBOS_HEALTH_URL = 'http://localhost:3592/_cerbos/health';
const DEFAULT_STATE_DIR = '${{ runner.temp }}/tayzu-e2e';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

// ---------------------------------------------------------------------------
// A minimal reader for the YAML subset of a GitHub Actions workflow.
// ---------------------------------------------------------------------------

interface YamlNode {
  /** The mapping key, unquoted; `undefined` for a sequence item. */
  key: string | undefined;
  /** The inline scalar after `key:` or `- `, comment stripped and unquoted. */
  value: string;
  /** The content of a `|` or `>` block scalar, dedented. */
  block: string | undefined;
  children: YamlNode[];
}

function newNode(key: string | undefined): YamlNode {
  return { key, value: '', block: undefined, children: [] };
}

/** Removes a trailing ` # comment` that is outside quotes. */
function stripComment(content: string): string {
  let quote: string | undefined;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content.charAt(i);
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(content.charAt(i - 1)))) {
      return content.slice(0, i).trimEnd();
    }
  }
  return content;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

const KEY_LINE = /^("[^"]*"|'[^']*'|[^\s"'#\-[{][^:]*?|-[^\s:][^:]*?)\s*:(?=\s|$)\s*(.*)$/;

function indentOf(raw: string): number {
  return raw.length - raw.trimStart().length;
}

function isSkippable(raw: string): boolean {
  return /^\s*(#.*)?$/.test(raw);
}

function parseYaml(text: string): YamlNode {
  const lines = text.split(/\r?\n/);
  const root = newNode(undefined);
  const stack: { indent: number; node: YamlNode }[] = [{ indent: -1, node: root }];

  const top = (): YamlNode => stack[stack.length - 1]?.node ?? root;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    if (isSkippable(raw)) continue;
    let indent = indentOf(raw);
    let content = stripComment(raw.trim());

    while (stack.length > 1 && (stack[stack.length - 1]?.indent ?? -1) >= indent) stack.pop();

    if (content === '-' || content.startsWith('- ')) {
      const item = newNode(undefined);
      top().children.push(item);
      stack.push({ indent, node: item });
      const rest = content.slice(1).trimStart();
      indent += content.length - rest.length;
      content = rest;
      if (content === '') continue;
      if (!KEY_LINE.test(content)) {
        item.value = unquote(content);
        continue;
      }
    }

    const match = KEY_LINE.exec(content);
    if (match === null) {
      // A continuation of a multi-line plain scalar: append to the parent.
      const parent = top();
      parent.value = `${parent.value} ${unquote(content)}`.trim();
      continue;
    }
    const node = newNode(unquote(match[1] ?? ''));
    const value = match[2] ?? '';
    top().children.push(node);
    stack.push({ indent, node });

    if (/^[|>][-+0-9]*$/.test(value)) {
      const blockLines: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j] ?? '';
        if (next.trim() !== '' && indentOf(next) <= indent) break;
        blockLines.push(next);
        j += 1;
      }
      const nonBlank = blockLines.filter((l) => l.trim() !== '');
      const base = nonBlank.length === 0 ? 0 : Math.min(...nonBlank.map(indentOf));
      node.block = blockLines.map((l) => l.slice(base)).join('\n');
      i = j - 1;
    } else {
      node.value = unquote(value);
    }
  }
  return root;
}

function child(node: YamlNode | undefined, key: string): YamlNode | undefined {
  return node?.children.find((c) => c.key === key);
}

function textOf(node: YamlNode | undefined): string {
  return node === undefined ? '' : (node.block ?? node.value);
}

function jobsOf(root: YamlNode): YamlNode[] {
  return child(root, 'jobs')?.children ?? [];
}

function stepsOf(job: YamlNode | undefined): YamlNode[] {
  return child(job, 'steps')?.children ?? [];
}

function runOf(step: YamlNode): string {
  return textOf(child(step, 'run'));
}

function usesOf(step: YamlNode): string {
  return child(step, 'uses')?.value ?? '';
}

function withOf(step: YamlNode, key: string): string {
  return textOf(child(child(step, 'with'), key));
}

/** `${{ failure() }}` and `failure()` are the same condition. */
function normalizeExpression(value: string): string {
  return value
    .trim()
    .replace(/^\$\{\{([\s\S]*)\}\}$/, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `${{runner.temp}}` and `${{ runner.temp }}` are the same path. */
function normalizePath(value: string): string {
  return value.trim().replace(/\$\{\{\s*([^}]*?)\s*\}\}/g, '${{ $1 }}');
}

function workflow(): YamlNode {
  return parseYaml(read(WORKFLOW_PATH));
}

function jobOf(root: YamlNode, key: string): YamlNode | undefined {
  return jobsOf(root).find((job) => job.key === key);
}

function e2eJob(): YamlNode | undefined {
  return jobOf(workflow(), E2E_JOB);
}

/** The e2e job's steps, failing the case with a clear message when the job is missing. */
function e2eSteps(): YamlNode[] {
  const job = e2eJob();
  expect(job, `ci.yml has a job keyed "${E2E_JOB}"`).toBeDefined();
  return stepsOf(job);
}

function findStep(steps: readonly YamlNode[], test: (step: YamlNode) => boolean): number {
  return steps.findIndex(test);
}

function isCheckout(step: YamlNode): boolean {
  return usesOf(step).startsWith('actions/checkout@');
}

function isSetup(step: YamlNode): boolean {
  return usesOf(step) === './.github/actions/setup';
}

function isCerbosStart(step: YamlNode): boolean {
  return /\bdocker\s+run\b/.test(runOf(step)) && CERBOS_IMAGE.test(runOf(step));
}

function isCerbosWait(step: YamlNode): boolean {
  return runOf(step).includes(CERBOS_HEALTH_URL) && !isCerbosStart(step);
}

function isPnpmE2e(step: YamlNode): boolean {
  return runOf(step).trim() === 'pnpm e2e';
}

function isUpload(step: YamlNode): boolean {
  return usesOf(step).startsWith('actions/upload-artifact@');
}

/** The pnpm invocations of the pinned Playwright that install Chromium with its deps. */
const PLAYWRIGHT_INSTALL_FILTERED =
  /^pnpm\s+(?:--filter[= ]@tayzu\/web|--dir[= ]apps\/web|-C\s+apps\/web)\s+exec\s+playwright\s+install\s+--with-deps\s+chromium\s*$/;
const PLAYWRIGHT_INSTALL_IN_WEB =
  /^pnpm\s+exec\s+playwright\s+install\s+--with-deps\s+chromium\s*$/;

function isPlaywrightInstall(step: YamlNode): boolean {
  return /\bplaywright\b[^\n]*\binstall\b/.test(runOf(step));
}

// ---------------------------------------------------------------------------
// Rules over the whole workflow text. Each returns its violations.
// ---------------------------------------------------------------------------

const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;
const INPUTS_CONTEXT = /\binputs\s*(?:\.|\[)/;
const EVENT_CONTEXT = /\bgithub\s*(?:\.\s*event(?![A-Za-z0-9_])|\[\s*['"]event['"]\s*\])/;

function interpolationViolations(text: string): string[] {
  const violations: string[] = [];
  for (const job of jobsOf(parseYaml(text))) {
    for (const step of stepsOf(job)) {
      const run = runOf(step);
      for (const match of run.matchAll(EXPRESSION)) {
        if (INPUTS_CONTEXT.test(match[1] ?? '')) {
          violations.push(`a run step of job ${String(job.key)} interpolates inputs.*`);
        }
      }
      if (EVENT_CONTEXT.test(run)) {
        violations.push(`a run step of job ${String(job.key)} reads github.event.*`);
      }
    }
  }
  return violations;
}

const PINNED_ACTION = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^@\s]+)?@[0-9a-f]{40}$/;
const USES_LINE = /^\s*(?:-\s+)?uses\s*:\s*(.*)$/;

/** Every remote `uses:` of a composite action file, as text. */
function compositeUses(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) => !isSkippable(line))
    .map((line) => USES_LINE.exec(stripComment(line)))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => unquote(match[1] ?? ''));
}

/**
 * The job's actions: a remote one is pinned by a 40-character commit SHA; the only
 * local one is the shared setup action, whose own actions are pinned the same way.
 */
function pinViolations(job: YamlNode | undefined, setupActionText: string): string[] {
  const violations: string[] = [];
  for (const step of stepsOf(job)) {
    const ref = usesOf(step);
    if (ref === '') continue;
    if (ref === './.github/actions/setup') {
      for (const inner of compositeUses(setupActionText)) {
        if (!PINNED_ACTION.test(inner)) {
          violations.push(`the setup action uses ${inner}, not pinned by a commit SHA`);
        }
      }
    } else if (ref.startsWith('./') || ref.startsWith('../')) {
      violations.push(`the job uses the local action ${ref}`);
    } else if (!PINNED_ACTION.test(ref)) {
      violations.push(`the job uses ${ref}, not pinned by a 40-character commit SHA`);
    }
  }
  return violations;
}

/** The refs (`owner/repo@sha`) another job of the workflow uses for `action`. */
function refsElsewhere(root: YamlNode, action: string): Set<string> {
  const refs = new Set<string>();
  for (const job of jobsOf(root)) {
    if (job.key === E2E_JOB) continue;
    for (const step of stepsOf(job)) {
      const ref = usesOf(step);
      if (ref.startsWith(`${action}@`)) refs.add(ref);
    }
  }
  return refs;
}

/** Every `env` mapping the e2e step of `job` sees: the workflow's, the job's, the step's. */
function envFor(root: YamlNode, job: YamlNode | undefined, step: YamlNode | undefined): YamlNode[] {
  return [
    child(root, 'env'),
    child(job, 'env'),
    step === undefined ? undefined : child(step, 'env'),
  ].filter((env): env is YamlNode => env !== undefined);
}

// ---------------------------------------------------------------------------
// local.sh
// ---------------------------------------------------------------------------

/** The lines the shell runs: comments and blank lines dropped, `\` continuations joined. */
function shellCodeLines(text: string): string[] {
  return text
    .replace(/\\\n\s*/g, ' ')
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'));
}

/** `step "<desc>" <command…>` lines at the top level of local.sh, with their index. */
function stepLines(lines: readonly string[]): { index: number; desc: string; command: string }[] {
  const found: { index: number; desc: string; command: string }[] = [];
  lines.forEach((line, index) => {
    const match = /^(?:advisory_)?step\s+"([^"]*)"\s+(.*)$/.exec(line);
    if (match !== null)
      found.push({ index, desc: match[1] ?? '', command: (match[2] ?? '').trim() });
  });
  return found;
}

/** The body of a shell function `name() { … }` defined at column 0, or undefined. */
function functionBody(text: string, name: string): string | undefined {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^${name}\\s*\\(\\)\\s*\\{\\s*$`).test(line));
  if (start === -1) return undefined;
  const end = lines.findIndex((line, index) => index > start && line === '}');
  if (end === -1) return undefined;
  return lines.slice(start + 1, end).join('\n');
}

function e2eLocalStep(): { index: number; desc: string; command: string } | undefined {
  return stepLines(shellCodeLines(read(LOCAL_SH_PATH))).find((s) => /\be2e\b/i.test(s.desc));
}

const SKIP_RETURN = /\b(?:return|exit)\s+(?:"?\$\{?SKIP_EXIT_CODE\}?"?|77)\b/;
const RUNS_E2E_SH = /^\s*bash\s+"\$\{?SCRIPT_DIR\}?\/e2e\.sh"\s+all\s*$/;

// ---------------------------------------------------------------------------
// The tests.
// ---------------------------------------------------------------------------

describe('the e2e CI job (003 task 10.11, design D2)', () => {
  it('ci.yml has a job keyed e2e on an Ubuntu runner, where Docker is available', () => {
    const job = e2eJob();

    expect(job, `ci.yml has a job keyed "${E2E_JOB}"`).toBeDefined();
    expect(child(job, 'runs-on')?.value ?? '').toMatch(/^ubuntu-/);
  });

  it('every action of the e2e job is pinned by a 40-character commit SHA, the one the other jobs use', () => {
    const root = workflow();
    const job = jobOf(root, E2E_JOB);
    expect(job, `ci.yml has a job keyed "${E2E_JOB}"`).toBeDefined();
    const steps = stepsOf(job);

    expect(pinViolations(job, read(SETUP_ACTION_PATH))).toEqual([]);
    for (const action of ['actions/checkout', 'actions/upload-artifact']) {
      const used = steps.map(usesOf).filter((ref) => ref.startsWith(`${action}@`));
      expect(used, `the e2e job uses ${action}`).not.toEqual([]);
      const elsewhere = refsElsewhere(root, action);
      for (const ref of used) {
        expect(ref).toMatch(PINNED_ACTION);
        // One pin per action across the workflow, so Dependabot moves them together.
        if (elsewhere.size > 0) expect([...elsewhere]).toContain(ref);
      }
    }
  });

  it('the first step is the checkout, with persist-credentials: false, then the shared setup action', () => {
    const steps = e2eSteps();
    const checkoutAt = findStep(steps, isCheckout);
    const setupAt = findStep(steps, isSetup);

    expect(checkoutAt, 'an actions/checkout step').toBe(0);
    const checkout = steps[checkoutAt];
    expect(checkout === undefined ? '' : withOf(checkout, 'persist-credentials')).toBe('false');
    expect(setupAt, 'a ./.github/actions/setup step').toBeGreaterThan(checkoutAt);
    // One checkout only, so no later step fetches the repository with credentials.
    expect(steps.filter(isCheckout)).toHaveLength(1);
  });

  it('the job starts the pinned Cerbos image of the test job, after the checkout, and waits for its health before pnpm e2e', () => {
    const root = workflow();
    const steps = e2eSteps();
    const testJobDigests = stepsOf(jobOf(root, 'test'))
      .map((step) => CERBOS_IMAGE.exec(runOf(step))?.[0])
      .filter((image): image is string => image !== undefined);
    expect(testJobDigests, 'the test job starts a pinned Cerbos image').not.toEqual([]);

    const startAt = findStep(steps, isCerbosStart);
    expect(startAt, 'a step running the pinned Cerbos image').toBeGreaterThan(-1);
    const start = runOf(steps[startAt] ?? newNode(undefined));
    expect(CERBOS_IMAGE.exec(start)?.[0]).toBe(testJobDigests[0]);
    // e2e.sh reaches Cerbos at localhost:3593 and its health at localhost:3592.
    expect(start).toMatch(/-p\s+3592:3592\b/);
    expect(start).toMatch(/-p\s+3593:3593\b/);
    // It serves the repository's policies, so it starts after the checkout.
    expect(start).toMatch(/\$\{?GITHUB_WORKSPACE\}?\/policies:\/policies/);
    expect(startAt).toBeGreaterThan(findStep(steps, isCheckout));

    const waitAt = findStep(steps, isCerbosWait);
    expect(waitAt, `a step polling ${CERBOS_HEALTH_URL}`).toBeGreaterThan(startAt);
    expect(runOf(steps[waitAt] ?? newNode(undefined))).toMatch(/\bexit\s+1\b/);
    expect(waitAt).toBeLessThan(findStep(steps, isPnpmE2e));
  });

  it('PostgreSQL 18 is the pinned container of e2e.sh, behind verified TLS: the job declares no service, DATABASE_URL or image override', () => {
    const root = workflow();
    const job = e2eJob();
    expect(job, `ci.yml has a job keyed "${E2E_JOB}"`).toBeDefined();

    // e2e.sh starts postgres from the `postgres` stage of Dockerfile.images, the
    // postgres:18 digest the test job's service runs.
    const pinned = /^FROM\s+(\S+)\s+AS\s+postgres\s*$/m.exec(read(IMAGES_PATH))?.[1] ?? '';
    expect(pinned).toMatch(POSTGRES_18_IMAGE);
    expect(textOf(child(child(child(jobOf(root, 'test'), 'services'), 'postgres'), 'image'))).toBe(
      pinned,
    );
    expect(read(E2E_SH_PATH)).toMatch(
      /^PG_IMAGE="\$\{E2E_PG_IMAGE:-\$\(pinned_image postgres\)\}"$/m,
    );
    expect(read(E2E_SH_PATH)).toContain('sslmode=verify-full');

    // A service container starts before the checkout and cannot hold the run's CA.
    expect(child(job, 'services'), 'the e2e job declares no services').toBeUndefined();
    expect(child(job, 'container'), 'the e2e job runs on the runner itself').toBeUndefined();
    const pnpmE2e = stepsOf(job).find(isPnpmE2e);
    for (const env of envFor(root, job, pnpmE2e)) {
      const keys = env.children.map((c) => c.key);
      expect(keys).not.toContain('DATABASE_URL');
      expect(keys).not.toContain('AUTH_DATABASE_URL');
      expect(keys).not.toContain('E2E_PG_IMAGE');
    }
  });

  it('Chromium is installed with its system dependencies by the pinned Playwright of @tayzu/web, after the setup and before pnpm e2e', () => {
    const steps = e2eSteps();
    const installAt = findStep(steps, isPlaywrightInstall);
    expect(installAt, 'a playwright install step').toBeGreaterThan(-1);
    const install = steps[installAt] ?? newNode(undefined);
    const command = runOf(install).trim();
    const workingDirectory = textOf(child(install, 'working-directory')).replace(/\/$/, '');

    // The binary of the workspace's own @playwright/test, never a downloaded one.
    expect(command).not.toMatch(/\b(?:npx|dlx|bunx|yarn)\b/);
    expect(command).not.toMatch(/playwright@/);
    const viaFilter = PLAYWRIGHT_INSTALL_FILTERED.test(command);
    const inWebPackage =
      PLAYWRIGHT_INSTALL_IN_WEB.test(command) && /^(?:\.\/)?apps\/web$/.test(workingDirectory);
    expect(
      viaFilter || inWebPackage,
      `"${command}" installs chromium --with-deps through pnpm exec in @tayzu/web`,
    ).toBe(true);

    const pkg = JSON.parse(read(WEB_PACKAGE_PATH)) as {
      devDependencies?: Record<string, string>;
    };
    expect(pkg.devDependencies?.['@playwright/test'] ?? '').toMatch(/^\d+\.\d+\.\d+$/);

    expect(installAt).toBeGreaterThan(findStep(steps, isSetup));
    expect(installAt).toBeLessThan(findStep(steps, isPnpmE2e));
  });

  it('the job runs pnpm e2e once, after Cerbos and the browser are ready', () => {
    const steps = e2eSteps();
    const e2eAt = findStep(steps, isPnpmE2e);

    expect(e2eAt, 'a step whose run is exactly `pnpm e2e`').toBeGreaterThan(-1);
    expect(steps.filter(isPnpmE2e)).toHaveLength(1);
    expect(e2eAt).toBeGreaterThan(findStep(steps, isCerbosWait));
    expect(e2eAt).toBeGreaterThan(findStep(steps, isPlaywrightInstall));
  });

  it("the Playwright report is uploaded only on failure, from the state directory's playwright folder, and kept 3 days", () => {
    const root = workflow();
    const job = e2eJob();
    const steps = e2eSteps();
    const uploads = steps.filter(isUpload);
    expect(uploads, 'one actions/upload-artifact step').toHaveLength(1);
    const upload = uploads[0] ?? newNode(undefined);

    expect(normalizeExpression(child(upload, 'if')?.value ?? '')).toBe('failure()');
    expect(withOf(upload, 'retention-days')).toBe('3');
    expect(steps.indexOf(upload)).toBeGreaterThan(findStep(steps, isPnpmE2e));

    // The state directory e2e.sh writes to: E2E_STATE_DIR when the job sets it,
    // else ${RUNNER_TEMP}/tayzu-e2e. playwright.config.ts writes the report and the
    // traces under its playwright/ folder; seed.json and tls/ stay out of the upload.
    const pnpmE2e = steps.find(isPnpmE2e);
    const override = envFor(root, job, pnpmE2e)
      .map((env) => child(env, 'E2E_STATE_DIR')?.value)
      .filter((value): value is string => value !== undefined)
      .at(-1);
    const stateDir = normalizePath(override ?? DEFAULT_STATE_DIR).replace(/\/$/, '');
    const paths = withOf(upload, 'path')
      .split('\n')
      .map(normalizePath)
      .filter((path) => path !== '');
    expect(paths, 'the upload names a path').not.toEqual([]);
    for (const path of paths) {
      expect(
        path.startsWith('!') ||
          path === `${stateDir}/playwright` ||
          path.startsWith(`${stateDir}/playwright/`),
        path,
      ).toBe(true);
      expect(path).not.toMatch(/seed\.json|\/tls\b|\.\./);
    }
  });

  it('the e2e job reads no repository secret and asks for no write permission (credentials are random per run, D16)', () => {
    const text = read(WORKFLOW_PATH);
    const job = e2eJob();
    expect(job, `ci.yml has a job keyed "${E2E_JOB}"`).toBeDefined();

    const permissions = child(job, 'permissions');
    const grants = [permissions?.value ?? '', ...(permissions?.children.map((c) => c.value) ?? [])];
    for (const grant of grants) expect(grant).not.toMatch(/write/);

    const start = text.indexOf(`\n  ${E2E_JOB}:\n`);
    const next = /\n {2}[A-Za-z0-9_-]+:\n/g;
    next.lastIndex = start + 1;
    const end = next.exec(text)?.index ?? text.length;
    expect(text.slice(start, end)).not.toMatch(/\bsecrets\s*(?:\.|\[)/);
  });

  it('no run step of the workflow interpolates ${{ inputs.* }} or reads github.event.*', () => {
    expect(e2eJob(), `ci.yml has a job keyed "${E2E_JOB}"`).toBeDefined();
    expect(interpolationViolations(read(WORKFLOW_PATH))).toEqual([]);
  });
});

describe('the rules of this file reject what they guard', () => {
  it('the interpolation rule rejects inputs.* and github.event.* inside run', () => {
    const scratch = [
      'jobs:',
      '  e2e:',
      '    steps:',
      '      - run: echo "${{ inputs.target }}"',
      '      - run: |',
      '          echo "${{ github.event.pull_request.title }}"',
      '      - name: fine',
      '        env:',
      '          TITLE: ${{ github.event.pull_request.title }}',
      '        run: echo "$TITLE"',
    ].join('\n');

    expect(interpolationViolations(scratch)).toEqual([
      'a run step of job e2e interpolates inputs.*',
      'a run step of job e2e reads github.event.*',
    ]);
  });

  it('the pin rule rejects a tag, a branch, a short SHA and a foreign local action', () => {
    const scratch = parseYaml(
      [
        'steps:',
        '  - uses: actions/checkout@v4',
        '  - uses: actions/upload-artifact@main',
        '  - uses: actions/setup-node@8207627',
        '  - uses: ./.github/actions/other',
        '  - uses: ./.github/actions/setup',
        '  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      ].join('\n'),
    );

    expect(pinViolations(scratch, '    - uses: pnpm/action-setup@v6')).toEqual([
      'the job uses actions/checkout@v4, not pinned by a 40-character commit SHA',
      'the job uses actions/upload-artifact@main, not pinned by a 40-character commit SHA',
      'the job uses actions/setup-node@8207627, not pinned by a 40-character commit SHA',
      'the job uses the local action ./.github/actions/other',
      'the setup action uses pnpm/action-setup@v6, not pinned by a commit SHA',
    ]);
  });
});

describe('local.sh runs the e2e stack after dast (003 task 10.11, design D2)', () => {
  it('local.sh has an e2e step after the dast step, run through step() so that exit 77 is a SKIP', () => {
    const lines = shellCodeLines(read(LOCAL_SH_PATH));
    const steps = stepLines(lines);
    const dast = steps.find((s) => /\bdast\.sh"\s+all\b/.test(s.command));
    const e2e = e2eLocalStep();

    expect(dast, 'the dast step').toBeDefined();
    expect(e2e, 'a step whose description names e2e').toBeDefined();
    expect(e2e?.index ?? -1).toBeGreaterThan(dast?.index ?? Number.MAX_SAFE_INTEGER);
    // step(), not advisory_step(): a failure is fatal, and 77 prints SKIPPED.
    expect(lines[e2e?.index ?? -1] ?? '').toMatch(/^step\s+"/);
    expect(read(LOCAL_SH_PATH)).toMatch(/^SKIP_EXIT_CODE=77$/m);
  });

  it('without Docker the step is an explicit SKIP: it runs e2e.sh all, which exits 77 before anything else', () => {
    const local = read(LOCAL_SH_PATH);
    const e2e = e2eLocalStep();
    expect(e2e, 'a step whose description names e2e').toBeDefined();
    const name = e2e?.command.split(/\s+/)[0] ?? '';
    const body = functionBody(local, name);
    expect(body, `local.sh defines the function ${name}() the e2e step runs`).toBeDefined();

    expect(shellCodeLines(body ?? '').some((line) => RUNS_E2E_SH.test(line))).toBe(true);
    const script = read(E2E_SH_PATH);
    const dockerCheck = script.indexOf('if ! docker info');
    expect(dockerCheck).toBeGreaterThan(-1);
    expect(script.slice(dockerCheck)).toMatch(/^\s*exit 77\s*$/m);
    expect(dockerCheck).toBeLessThan(script.indexOf('case "${1:-}" in'));
  });

  it('without a Playwright Chromium the step prints an explicit SKIP and returns 77 before it runs e2e.sh', () => {
    const local = read(LOCAL_SH_PATH);
    const e2e = e2eLocalStep();
    expect(e2e, 'a step whose description names e2e').toBeDefined();
    const name = e2e?.command.split(/\s+/)[0] ?? '';
    const lines = shellCodeLines(functionBody(local, name) ?? '');
    expect(lines, `local.sh defines the function ${name}() the e2e step runs`).not.toEqual([]);

    const runAt = lines.findIndex((line) => RUNS_E2E_SH.test(line));
    const before = lines.slice(0, runAt === -1 ? lines.length : runAt);
    expect(runAt, 'the function runs e2e.sh all').toBeGreaterThan(-1);
    expect(before.join('\n'), 'a Chromium check before e2e.sh').toMatch(/chromium/i);
    expect(
      before.some((line) => /\becho\b[^\n]*\bSKIP/.test(line)),
      'an echoed SKIP line',
    ).toBe(true);
    expect(
      before.some((line) => SKIP_RETURN.test(line)),
      'return "$SKIP_EXIT_CODE"',
    ).toBe(true);
  });
});
