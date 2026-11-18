/**
 * `045` task 7.3 (design D3; Resolved decisions Q41, Q55, Q64, Q70, Q91, Q153,
 * Q155, Q172): the maintenance workflow `.github/workflows/identity-maintenance.yml`.
 *
 * The workflow is the only way the reversal script reaches production, and the
 * way `043`'s `_user` blueprint backfill and reconcile are started. It is
 * `workflow_dispatch` only, runs only from `master`, declares a GitHub
 * `environment` whose required reviewers are the second human (Q153), uses OIDC
 * (`id-token: write`, no stored cloud secret) to start one Azure Container Apps
 * Job per script, chosen by a `choice` input, and hands the job the operator id
 * `gh:` plus the numeric actor id through `env` (Q70). It has no checkout and no
 * setup step. It starts neither out-of-band CLI (`bootstrap-admin`, Q91;
 * `recover-admin-mfa`, Q155) and never the purge, which is scheduled.
 *
 * This file lives in `apps/api/src` only because `.github` is outside every
 * package (like `zap-seed.test.ts`). No YAML parser is a dependency, so the
 * rules below run on a minimal indentation-based reader of the workflow subset
 * GitHub Actions files use (block mappings, block sequences, flow lists and
 * literal or folded block scalars). Each rule is a helper that returns its
 * violations; the real file must have none, and an inline scratch workflow with
 * one violation each shows that every rule rejects what it guards. Task 7.4
 * adds the input, supply-chain, `az` override and `CODEOWNERS` rules here.
 *
 * The choice options are the script names of `apps/api/scripts`
 * (`cancel-org-deletion`, `backfill-user-blueprint`, `reconcile-users`). The
 * operator id reaches the runner as `TAYZU_OPERATOR_ID` in an `env` mapping and
 * the job through the `az containerapp job start` call's `--env-vars`, read
 * from the shell environment (the tenant id travels the same way as
 * `TAYZU_TENANT_ID`, Q172, checked by 7.4).
 *
 * ## Why this fails right now
 *
 * `.github/workflows/identity-maintenance.yml` does not exist, so every case
 * on the real file fails reading it. The scratch cases exercise the helpers,
 * which live in this file, so they pass already.
 *
 * ## Task 7.4 (design D3; Resolved decisions Q64, Q72, Q173)
 *
 * Scenario "The workflow does not interpolate its inputs": no `run:` contains
 * `${{ inputs.* }}`, `github.event.*` or `github.head_ref`; every input is a
 * `choice` or validated; every `uses:` is pinned by a 40-character SHA (a tag,
 * a branch and a local `./` action all fail); and `.github/CODEOWNERS` covers
 * the workflow and `apps/api/scripts/**`. Scenario "...without overrides": the
 * `az containerapp job start` call carries no command, arguments, image or
 * environment override other than the fixed variable names, and no other
 * workflow names the same environment.
 *
 * A non-choice input counts as validated when every `env` variable that carries
 * it is checked, in its job, by a step that (1) comes before the first step
 * that uses an action or calls `az` (so before the Azure login, while the runner
 * holds no OIDC token), (2) has no `if:` and no `continue-on-error`, so it
 * always runs and its failure fails the run, (3) references that variable as
 * `$NAME` or `${NAME}`, (4) contains the catalog's tenant-id pattern
 * `^[A-Za-z0-9_-]{1,64}$` verbatim, and (5) contains `exit 1`. A variable that
 * a later step's own `env` maps from the input bypasses that check and fails,
 * and so does a read of the input anywhere outside an `env` mapping. This is a
 * text rule: it cannot prove the `exit 1` sits on the mismatch branch, which
 * the review of the step's few lines does.
 *
 * The `az` call is read against an allowlist of flags (`--name`/`-n`,
 * `--resource-group`/`-g`, `--env-vars`, and the CLI's harmless `--subscription`,
 * `--output`/`-o` and `--only-show-errors`): `--command`, `--args` and
 * `--image` are named overrides, and every other flag (`--yaml`,
 * `--container-name`, `--cpu`, `--registry-*`) shapes the execution template
 * too. Each `--env-vars` entry is `TAYZU_OPERATOR_ID` or `TAYZU_TENANT_ID`, read
 * from the shell variable of the same name.
 *
 * `CODEOWNERS` is read with GitHub's rules (gitignore-style patterns, the last
 * matching line wins, a line without owners removes ownership): each of the
 * four required paths is probed with real and future file paths, and the last
 * matching line must list `@nahuex` (Q72). The repository has no `CODEOWNERS`
 * yet, so the two real-file `CODEOWNERS` cases fail; the other 7.4 real-file
 * cases hold on the file 7.3 committed.
 *
 * The `exit 1` of a tenant-id check must sit on the branch of the line that
 * holds the pattern (the body of its `if ...; then` up to `else`, `elif` or
 * `fi`, or the command after its `||`), not anywhere in the step: since Q177
 * the first step holds a second check with an `exit 1` of its own.
 *
 * ## Resolved decision Q177 (VCDM fix)
 *
 * `github.actor_id` is the actor of the run's first attempt, so a re-run that
 * someone else starts would be attributed to the first operator. The workflow
 * therefore refuses a run whose `github.triggering_actor` differs from
 * `github.actor`, in its first step ("Validate the inputs"), before the Azure
 * login. The rule reads, in each job, the first step that compares the two and
 * fails unless (1) it is the job's first step and comes before the first step
 * that uses an action or calls `az`, (2) it has no `if:` and no
 * `continue-on-error`, (3) its own `env` maps one variable to exactly
 * `${{ github.actor }}` and one to exactly `${{ github.triggering_actor }}`
 * (neither named `TAYZU_*`), (4) its `run:` compares the two variables as
 * `if [ "$X" != "$Y" ]; then` (or `[[ ]]`) or as `[ "$X" = "$Y" ] ||` (or
 * `==`, `[[ ]]`), in either order, and (5) the mismatch branch (the `if` body
 * or the command after `||`) contains `exit 1`. No `run:` may name
 * `github.actor` or `github.triggering_actor` at all.
 *
 * This narrows 7.3's rule that no code line names `github.actor` or
 * `github.triggering_actor`: a line is exempt only when it is an entry of the
 * `env` mapping of a job's first step, that step comes before the Azure login
 * and performs the comparison above, the entry's key does not start with
 * `TAYZU_`, and its value is exactly one of the two expressions (nothing
 * around it, so not `gh:${{ github.actor }}`). Every other line that names
 * either expression, including the bracket form `github['actor']`, still
 * fails: the operator id, the job's or the workflow's `env`, a later step's
 * `env`, any `if:`, `name:` or `with:`, and any `run:`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const WORKFLOW_PATH = fileURLToPath(
  new URL('../../../.github/workflows/identity-maintenance.yml', import.meta.url),
);

const MAINTENANCE_SCRIPTS = ['backfill-user-blueprint', 'cancel-org-deletion', 'reconcile-users'];

/** The Azure OIDC identifiers `azure/login` takes; none is a stored cloud secret. */
const ENVIRONMENT_SECRETS = new Set([
  'AZURE_CLIENT_ID',
  'AZURE_TENANT_ID',
  'AZURE_SUBSCRIPTION_ID',
]);

const BOOTSTRAP_ADMIN = /bootstrap[-_:. ]?admin/i;
const RECOVER_ADMIN_MFA = /recover[-_:. ]?admin[-_:. ]?mfa/i;

function readWorkflow(): string {
  return readFileSync(WORKFLOW_PATH, 'utf8');
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
  /** 0-based line index where the node starts. */
  line: number;
}

function newNode(key: string | undefined, line: number): YamlNode {
  return { key, value: '', block: undefined, children: [], line };
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
  const root = newNode(undefined, -1);
  const stack: { indent: number; node: YamlNode }[] = [{ indent: -1, node: root }];

  const top = (): YamlNode => stack[stack.length - 1]?.node ?? root;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    if (isSkippable(raw)) continue;
    let indent = indentOf(raw);
    let content = stripComment(raw.trim());

    while (stack.length > 1 && (stack[stack.length - 1]?.indent ?? -1) >= indent) stack.pop();

    if (content === '-' || content.startsWith('- ')) {
      const item = newNode(undefined, i);
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
    const node = newNode(unquote(match[1] ?? ''), i);
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

/** A flow list `[a, b]`, or the scalar items of a block sequence. */
function listOf(node: YamlNode | undefined): string[] {
  if (node === undefined) return [];
  const inline = node.value.trim();
  if (inline.startsWith('[') && inline.endsWith(']')) {
    return inline
      .slice(1, -1)
      .split(',')
      .map((s) => unquote(s))
      .filter((s) => s !== '');
  }
  if (inline !== '') return [inline];
  return node.children.filter((c) => c.key === undefined).map((c) => c.value);
}

function triggerNode(root: YamlNode): YamlNode | undefined {
  return root.children.find((c) => c.key === 'on' || c.key === 'true');
}

function jobsOf(root: YamlNode): YamlNode[] {
  return child(root, 'jobs')?.children ?? [];
}

function stepsOf(job: YamlNode): YamlNode[] {
  return child(job, 'steps')?.children ?? [];
}

function runOf(step: YamlNode): string {
  const run = child(step, 'run');
  return run === undefined ? '' : (run.block ?? run.value);
}

function inputsOf(root: YamlNode): YamlNode[] {
  return child(child(triggerNode(root), 'workflow_dispatch'), 'inputs')?.children ?? [];
}

function choiceInputs(root: YamlNode): YamlNode[] {
  return inputsOf(root).filter((input) => child(input, 'type')?.value === 'choice');
}

function allOptions(root: YamlNode): string[] {
  return inputsOf(root).flatMap((input) => listOf(child(input, 'options')));
}

/** Every `env` mapping: the workflow's, each job's and each step's. */
function envMappings(root: YamlNode): YamlNode[] {
  const found: YamlNode[] = [];
  const rootEnv = child(root, 'env');
  if (rootEnv !== undefined) found.push(rootEnv);
  for (const job of jobsOf(root)) {
    const jobEnv = child(job, 'env');
    if (jobEnv !== undefined) found.push(jobEnv);
    for (const step of stepsOf(job)) {
      const stepEnv = child(step, 'env');
      if (stepEnv !== undefined) found.push(stepEnv);
    }
  }
  return found;
}

/** Lines that are not blank and not a whole-line comment, with their index. */
function codeLines(text: string): { index: number; content: string }[] {
  return text
    .split(/\r?\n/)
    .map((content, index) => ({ index, content }))
    .filter(({ content }) => !isSkippable(content));
}

function normalizeExpression(value: string): string {
  return value
    .trim()
    .replace(/^\$\{\{([\s\S]*)\}\}$/, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// The rules of task 7.3. Each returns its violations; none means it holds.
// ---------------------------------------------------------------------------

function triggerViolations(text: string): string[] {
  const root = parseYaml(text);
  const triggers = root.children.filter((c) => c.key === 'on' || c.key === 'true');
  if (triggers.length !== 1) return ['the workflow declares no single `on:` block'];
  const names = listOf(triggers[0]);
  const declared = names.length > 0 ? names : (triggers[0]?.children ?? []).map((c) => c.key);
  const violations: string[] = [];
  for (const name of declared) {
    if (name !== 'workflow_dispatch')
      violations.push(`trigger other than workflow_dispatch: ${String(name)}`);
  }
  if (!declared.includes('workflow_dispatch'))
    violations.push('workflow_dispatch is not a trigger');
  return violations;
}

const MASTER_CONDITION =
  /(?:github\.ref == 'refs\/heads\/master'|'refs\/heads\/master' == github\.ref)/;

function refConditionViolations(text: string): string[] {
  const jobs = jobsOf(parseYaml(text));
  if (jobs.length === 0) return ['the workflow declares no job'];
  const violations: string[] = [];
  for (const job of jobs) {
    const condition = child(job, 'if');
    const expression = condition === undefined ? '' : normalizeExpression(condition.value);
    if (!MASTER_CONDITION.test(expression)) {
      violations.push(`job ${String(job.key)} has no condition on refs/heads/master`);
    } else if (/\|\||!/.test(expression)) {
      violations.push(`job ${String(job.key)} weakens its refs/heads/master condition`);
    }
  }
  return violations;
}

function environmentViolations(text: string): string[] {
  const jobs = jobsOf(parseYaml(text));
  if (jobs.length === 0) return ['the workflow declares no job'];
  const violations: string[] = [];
  for (const job of jobs) {
    const environment = child(job, 'environment');
    const name =
      environment === undefined
        ? ''
        : environment.value !== ''
          ? environment.value
          : (child(environment, 'name')?.value ?? '');
    if (name === '') {
      violations.push(`job ${String(job.key)} declares no environment`);
    } else if (name.includes('${{')) {
      violations.push(`job ${String(job.key)} computes its environment name`);
    }
  }
  return violations;
}

function permissionViolations(text: string): string[] {
  const root = parseYaml(text);
  const jobs = jobsOf(root);
  const blocks: { owner: string; node: YamlNode }[] = [];
  const violations: string[] = [];
  const rootPermissions = child(root, 'permissions');
  if (rootPermissions !== undefined) blocks.push({ owner: 'workflow', node: rootPermissions });
  for (const job of jobs) {
    const own = child(job, 'permissions');
    if (own !== undefined) blocks.push({ owner: `job ${String(job.key)}`, node: own });
    else if (rootPermissions === undefined) {
      violations.push(`job ${String(job.key)} inherits the default token permissions`);
    }
  }
  let idToken = false;
  for (const { owner, node } of blocks) {
    if (node.value !== '' && node.value !== '{}' && node.value !== 'read-all') {
      violations.push(`${owner} permissions are \`${node.value}\``);
    }
    for (const entry of node.children) {
      const scope = String(entry.key);
      if (entry.value === 'write' && scope === 'id-token') {
        idToken = true;
      } else if (entry.value === 'write') {
        violations.push(`${owner} elevates ${scope}: write`);
      } else if (entry.value !== 'read' && entry.value !== 'none') {
        violations.push(`${owner} sets ${scope} to \`${entry.value}\``);
      }
    }
  }
  if (!idToken) violations.push('no id-token: write permission for OIDC');
  return violations;
}

function secretViolations(text: string): string[] {
  const root = parseYaml(text);
  const jobs = jobsOf(root);
  const ranges = jobs.map((job, index) => ({
    job,
    start: job.line,
    end: jobs[index + 1]?.line ?? Number.POSITIVE_INFINITY,
    hasEnvironment: child(job, 'environment') !== undefined,
  }));
  const violations: string[] = [];
  for (const { index, content } of codeLines(text)) {
    if (/\bsecrets\s*\[|toJSON\(\s*secrets\s*\)|secrets:\s*inherit/i.test(content)) {
      violations.push(`line ${String(index + 1)} exposes secrets wholesale`);
    }
    if (/^\s*(?:-\s+)?(?:creds|client-secret)\s*:/.test(content)) {
      violations.push(`line ${String(index + 1)} passes a stored cloud credential`);
    }
    for (const match of content.matchAll(/\bsecrets\.([A-Za-z_][A-Za-z0-9_-]*)/g)) {
      const name = match[1] ?? '';
      const range = ranges.find((r) => index >= r.start && index < r.end);
      if (!ENVIRONMENT_SECRETS.has(name)) {
        violations.push(`line ${String(index + 1)} references secrets.${name}`);
      } else if (range === undefined || !range.hasEnvironment) {
        violations.push(
          `line ${String(index + 1)} references secrets.${name} outside the environment's job`,
        );
      }
    }
  }
  return violations;
}

const SETUP_COMMAND =
  /(?:^|[\s;&|(])(?:git\s+(?:clone|checkout|fetch|pull|init)|pnpm|npm|npx|yarn|corepack|node|tsx|bun|deno)(?=\s|$)/m;

function stepViolations(text: string): string[] {
  const jobs = jobsOf(parseYaml(text));
  const violations: string[] = [];
  let logins = 0;
  let starts = 0;
  for (const job of jobs) {
    if (child(job, 'uses') !== undefined) {
      violations.push(`job ${String(job.key)} calls a reusable workflow`);
    }
    for (const step of stepsOf(job)) {
      const uses = child(step, 'uses');
      if (uses !== undefined) {
        const action = uses.value.split('@')[0] ?? '';
        if (/(^|\/)checkout$/i.test(action)) violations.push(`checkout step: ${uses.value}`);
        else if (/setup/i.test(action)) violations.push(`setup step: ${uses.value}`);
        else if (action !== 'azure/login') violations.push(`step runs ${uses.value}`);
        else logins += 1;
      }
      const run = runOf(step);
      if (SETUP_COMMAND.test(run)) violations.push('a run step checks out or sets up code');
      if (/\baz\s+containerapp\s+job\s+start\b/.test(run)) starts += 1;
    }
  }
  if (logins !== 1) violations.push(`expected one azure/login step, found ${String(logins)}`);
  if (starts !== 1)
    violations.push(`expected one az containerapp job start, found ${String(starts)}`);
  return violations;
}

const OPERATOR_ID = /^gh:\$\{\{\s*github\.actor_id\s*\}\}$/;
/** `github.actor` or `github.triggering_actor`, dotted or bracketed; not `github.actor_id`. */
const ACTOR_LOGIN =
  /\bgithub\s*(?:\.\s*(?:triggering_)?actor(?![A-Za-z0-9_])|\[\s*['"](?:triggering_)?actor['"]\s*\])/;

/**
 * The only lines that may name the actor login (Q177): the `env` entries of a
 * job's first step, before the Azure login, that compares the two actors, whose
 * key is not `TAYZU_*` and whose value is exactly one of the two expressions.
 */
function actorCheckEnvLines(root: YamlNode): Set<number> {
  const lines = new Set<number>();
  for (const job of jobsOf(root)) {
    const steps = stepsOf(job);
    const first = steps[0];
    if (first === undefined || firstTokenStep(steps) === 0) continue;
    if (!actorComparison(first).compares) continue;
    for (const entry of [
      ...actorEnvEntries(first, ACTOR_VALUE),
      ...actorEnvEntries(first, TRIGGERING_ACTOR_VALUE),
    ]) {
      lines.add(entry.line);
    }
  }
  return lines;
}

function operatorIdViolations(text: string): string[] {
  const root = parseYaml(text);
  const violations: string[] = [];
  const entries = envMappings(root).flatMap((env) =>
    env.children.filter((c) => c.key === 'TAYZU_OPERATOR_ID'),
  );
  if (entries.length === 0) violations.push('no env mapping sets TAYZU_OPERATOR_ID');
  for (const entry of entries) {
    if (!OPERATOR_ID.test(entry.value)) {
      violations.push(`TAYZU_OPERATOR_ID is \`${entry.value}\`, not gh: plus github.actor_id`);
    }
  }
  const exempt = actorCheckEnvLines(root);
  for (const { index, content } of codeLines(text)) {
    if (ACTOR_LOGIN.test(stripComment(content)) && !exempt.has(index)) {
      violations.push(`line ${String(index + 1)} uses the actor login`);
    }
  }
  for (const job of jobsOf(root)) {
    for (const step of stepsOf(job)) {
      const run = runOf(step);
      if (/github\.actor_id|TAYZU_OPERATOR_ID\s*=.*\$\{\{/.test(run)) {
        violations.push('a run step builds the operator id instead of reading it from env');
      }
      if (
        /\baz\s+containerapp\s+job\s+start\b/.test(run) &&
        !/TAYZU_OPERATOR_ID="?\$\{?TAYZU_OPERATOR_ID\b/.test(run)
      ) {
        violations.push('the job start does not pass TAYZU_OPERATOR_ID from env');
      }
    }
  }
  return violations;
}

function choiceViolations(text: string): string[] {
  const choices = choiceInputs(parseYaml(text));
  if (choices.length !== 1) return [`expected one choice input, found ${String(choices.length)}`];
  const options = listOf(child(choices[0], 'options'));
  const sorted = [...options].sort();
  if (JSON.stringify(sorted) !== JSON.stringify(MAINTENANCE_SCRIPTS)) {
    return [`the choice options are [${options.join(', ')}]`];
  }
  return [];
}

function namedCliViolations(text: string, cli: RegExp): string[] {
  const violations: string[] = [];
  for (const option of allOptions(parseYaml(text))) {
    if (cli.test(option)) violations.push(`option ${option} names an out-of-band CLI`);
  }
  text.split(/\r?\n/).forEach((line, index) => {
    if (cli.test(line)) violations.push(`line ${String(index + 1)} names an out-of-band CLI`);
  });
  return violations;
}

function purgeViolations(text: string): string[] {
  const violations: string[] = [];
  for (const option of allOptions(parseYaml(text))) {
    if (/purge/i.test(option)) violations.push(`option ${option} starts the purge`);
  }
  for (const { index, content } of codeLines(text)) {
    if (/purge[-_]job|identity:purge/i.test(stripComment(content))) {
      violations.push(`line ${String(index + 1)} names the purge job`);
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// The rules of task 7.4. Each returns its violations; none means it holds.
// ---------------------------------------------------------------------------

const WORKFLOWS_DIR = fileURLToPath(new URL('../../../.github/workflows/', import.meta.url));
const WORKFLOW_FILE = 'identity-maintenance.yml';
const CODEOWNERS_PATH = fileURLToPath(new URL('../../../.github/CODEOWNERS', import.meta.url));

/** The GitHub environment whose reviewers gate the workflow. */
const MAINTENANCE_ENVIRONMENT = 'identity-maintenance';

/** The catalog's tenant-id pattern (`packages/catalog/src/domain/context.ts`). */
const TENANT_ID_PATTERN = '^[A-Za-z0-9_-]{1,64}$';

/** The only variables the job start may set (Q70, Q172). */
const FIXED_ENV_VARS = new Set(['TAYZU_OPERATOR_ID', 'TAYZU_TENANT_ID']);

/** The owner of the maintenance workflow and the scripts (Q72). */
const CODEOWNER = '@nahuex';

/** The four paths `CODEOWNERS` covers, each probed with present and future files. */
const CODEOWNED_PATHS: { path: string; probes: string[] }[] = [
  {
    path: '.github/workflows/**',
    probes: [
      '.github/workflows/identity-maintenance.yml',
      '.github/workflows/ci.yml',
      '.github/workflows/copilot-setup-steps.yml',
      '.github/workflows/a-future-workflow.yaml',
    ],
  },
  {
    path: '.github/actions/**',
    probes: ['.github/actions/setup/action.yml', '.github/actions/a-future-action/action.yaml'],
  },
  { path: '.github/CODEOWNERS', probes: ['.github/CODEOWNERS'] },
  {
    path: 'apps/api/scripts/**',
    probes: [
      'apps/api/scripts/cancel-org-deletion.ts',
      'apps/api/scripts/backfill-user-blueprint.ts',
      'apps/api/scripts/reconcile-users.ts',
      'apps/api/scripts/bootstrap-admin.ts',
      'apps/api/scripts/recover-admin-mfa.ts',
      'apps/api/scripts/run-script.ts',
      'apps/api/scripts/lib/a-future-module.ts',
    ],
  },
];

function readCodeowners(): string {
  return readFileSync(CODEOWNERS_PATH, 'utf8');
}

/** Every workflow file in `.github/workflows` other than the maintenance one. */
function readOtherWorkflows(): { file: string; text: string }[] {
  return readdirSync(WORKFLOWS_DIR)
    .filter((file) => /\.ya?ml$/.test(file) && file !== WORKFLOW_FILE)
    .map((file) => ({ file, text: readFileSync(`${WORKFLOWS_DIR}${file}`, 'utf8') }));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;
const INPUTS_CONTEXT = /\binputs\s*(?:\.|\[)/;
const EVENT_CONTEXT = /\bgithub\s*(?:\.\s*event(?![A-Za-z0-9_])|\[\s*['"]event['"]\s*\])/;
const HEAD_REF_CONTEXT = /\bgithub\s*(?:\.\s*head_ref\b|\[\s*['"]head_ref['"]\s*\])/;

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
      if (HEAD_REF_CONTEXT.test(run)) {
        violations.push(`a run step of job ${String(job.key)} reads github.head_ref`);
      }
    }
  }
  return violations;
}

const USES_LINE = /^\s*(?:-\s+)?uses\s*:\s*(.*)$/;
const PINNED_ACTION = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^@\s]+)?@[0-9a-f]{40}$/;

function pinViolations(text: string): string[] {
  const violations: string[] = [];
  for (const { index, content } of codeLines(text)) {
    const match = USES_LINE.exec(stripComment(content));
    if (match === null) continue;
    const ref = unquote(match[1] ?? '');
    const line = `line ${String(index + 1)}`;
    if (ref.startsWith('./') || ref.startsWith('../')) {
      violations.push(`${line} uses a local action: ${ref}`);
    } else if (!PINNED_ACTION.test(ref)) {
      violations.push(`${line} uses ${ref}, not pinned by a 40-character commit SHA`);
    }
  }
  return violations;
}

function readsInput(text: string, name: string): boolean {
  const n = escapeRegExp(name);
  return new RegExp(
    `\\binputs\\s*(?:\\.\\s*${n}(?![A-Za-z0-9_-])|\\[\\s*['"]${n}['"]\\s*\\])`,
  ).test(text);
}

function readsVariable(run: string, variable: string): boolean {
  return new RegExp(`\\$\\{?${escapeRegExp(variable)}(?![A-Za-z0-9_])`).test(run);
}

/** The index of the first step that uses an action or calls `az`; validation comes before it. */
function firstTokenStep(steps: YamlNode[]): number {
  const index = steps.findIndex(
    (step) => child(step, 'uses') !== undefined || /(?:^|[\s;&|(])az\s/.test(runOf(step)),
  );
  return index === -1 ? steps.length : index;
}

/**
 * The branch a check line guards: the body of its `if ...; then` up to `else`,
 * `elif` or `fi`, or else the command after its `||`; empty when it has neither.
 */
function branchOf(lines: string[], index: number): string {
  const line = lines[index] ?? '';
  const then = /;\s*then\b(.*)$/.exec(line);
  if (/^\s*(?:el)?if\b/.test(line) && then !== null) {
    const rest = then[1] ?? '';
    const inline = /^(.*?)(?:;\s*)?\b(?:fi|else|elif)\b/.exec(rest);
    if (inline !== null) return inline[1] ?? '';
    const body = [rest];
    for (let j = index + 1; j < lines.length; j += 1) {
      const next = (lines[j] ?? '').trim();
      if (/^(?:fi|else|elif)\b/.test(next)) break;
      body.push(next);
    }
    return body.join('\n');
  }
  const or = line.indexOf('||');
  return or === -1 ? '' : line.slice(or + 2);
}

const EXIT_1 = /\bexit\s+1\b/;

function validatesInput(step: YamlNode, variable: string, input: string): boolean {
  const run = runOf(step);
  const lines = run.split(/\r?\n/);
  const ownEnv = child(child(step, 'env'), variable);
  return (
    child(step, 'uses') === undefined &&
    child(step, 'if') === undefined &&
    child(step, 'continue-on-error') === undefined &&
    (ownEnv === undefined || readsInput(ownEnv.value, input)) &&
    readsVariable(run, variable) &&
    lines.some(
      (line, index) => line.includes(TENANT_ID_PATTERN) && EXIT_1.test(branchOf(lines, index)),
    )
  );
}

function jobValidates(job: YamlNode, variable: string, input: string): boolean {
  const steps = stepsOf(job);
  return steps
    .slice(0, firstTokenStep(steps))
    .some((step) => validatesInput(step, variable, input));
}

function stepLabel(step: YamlNode, index: number): string {
  const name = child(step, 'name')?.value;
  return name === undefined || name === '' ? `#${String(index + 1)}` : `"${name}"`;
}

function inputValidationViolations(text: string): string[] {
  const root = parseYaml(text);
  const jobs = jobsOf(root);
  const violations: string[] = [];
  const envLines = new Set(envMappings(root).flatMap((env) => env.children.map((c) => c.line)));
  const freeInputs = inputsOf(root).filter((input) => child(input, 'type')?.value !== 'choice');

  for (const input of freeInputs) {
    const name = String(input.key);
    let carried = false;

    for (const { index, content } of codeLines(text)) {
      if (readsInput(stripComment(content), name) && !envLines.has(index)) {
        violations.push(`line ${String(index + 1)} reads input ${name} outside an env mapping`);
      }
    }

    for (const entry of child(root, 'env')?.children ?? []) {
      if (!readsInput(entry.value, name)) continue;
      carried = true;
      for (const job of jobs) {
        if (!jobValidates(job, String(entry.key), name)) {
          violations.push(
            `workflow env ${String(entry.key)} carries input ${name} without validation in job ${String(job.key)}`,
          );
        }
      }
    }
    for (const job of jobs) {
      for (const entry of child(job, 'env')?.children ?? []) {
        if (!readsInput(entry.value, name)) continue;
        carried = true;
        if (!jobValidates(job, String(entry.key), name)) {
          violations.push(
            `env ${String(entry.key)} of job ${String(job.key)} carries input ${name} without validation`,
          );
        }
      }
      const steps = stepsOf(job);
      const limit = firstTokenStep(steps);
      steps.forEach((step, index) => {
        for (const entry of child(step, 'env')?.children ?? []) {
          if (!readsInput(entry.value, name)) continue;
          carried = true;
          if (index >= limit || !validatesInput(step, String(entry.key), name)) {
            violations.push(
              `env ${String(entry.key)} of step ${stepLabel(step, index)} carries input ${name} without validation`,
            );
          }
        }
      });
    }

    if (!carried) violations.push(`input ${name} is neither a choice nor validated`);
  }
  return violations;
}

/** Splits a shell command into words, honouring quotes; stops at `;`, `&`, `|`, `)` or `#`. */
function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: string | undefined;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command.charAt(i);
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else if (/[;&|)]/.test(ch) || (ch === '#' && !inWord)) {
      break;
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  return words;
}

const JOB_START = /\baz\s+containerapp\s+job\s+start\b/;
const OVERRIDE_FLAGS = new Set(['--command', '--args', '--image']);
const FLAGS_WITH_VALUE = new Set([
  '--name',
  '-n',
  '--resource-group',
  '-g',
  '--subscription',
  '--output',
  '-o',
]);
const FLAGS_WITHOUT_VALUE = new Set(['--only-show-errors']);

/** The words after `az containerapp job start`, one list per call in a `run:` script. */
function jobStartCalls(run: string): string[][] {
  return run
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = JOB_START.exec(line);
      return match === null ? [] : [shellWords(line.slice(match.index + match[0].length))];
    });
}

function envVarViolations(entry: string): string[] {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(entry);
  if (match === null) return ['the job start passes an --env-vars entry that is not NAME=value'];
  const name = match[1] ?? '';
  const value = match[2] ?? '';
  if (!FIXED_ENV_VARS.has(name)) {
    return [`the job start sets --env-vars ${name}, outside the fixed names`];
  }
  if (value !== `$${name}` && value !== `\${${name}}`) {
    return [`the job start sets --env-vars ${name} from something other than $${name}`];
  }
  return [];
}

function jobStartViolations(text: string): string[] {
  const violations: string[] = [];
  for (const job of jobsOf(parseYaml(text))) {
    for (const step of stepsOf(job)) {
      for (const words of jobStartCalls(runOf(step))) {
        for (let i = 0; i < words.length; i += 1) {
          const word = words[i] ?? '';
          const eq = word.indexOf('=');
          const flag = word.startsWith('-') && eq !== -1 ? word.slice(0, eq) : word;
          const inline = word.startsWith('-') && eq !== -1 ? word.slice(eq + 1) : undefined;
          if (!flag.startsWith('-')) {
            violations.push('the job start takes an unexpected positional argument');
          } else if (OVERRIDE_FLAGS.has(flag)) {
            violations.push(`the job start passes ${flag}, which overrides the job`);
          } else if (flag === '--env-vars') {
            const entries: string[] = inline === undefined ? [] : [inline];
            while (i + 1 < words.length && !(words[i + 1] ?? '').startsWith('-')) {
              i += 1;
              entries.push(words[i] ?? '');
            }
            for (const entry of entries) violations.push(...envVarViolations(entry));
          } else if (FLAGS_WITH_VALUE.has(flag)) {
            if (inline === undefined) {
              if (i + 1 >= words.length) violations.push(`the job start passes ${flag} no value`);
              i += 1;
            }
          } else if (!FLAGS_WITHOUT_VALUE.has(flag) || inline !== undefined) {
            violations.push(`the job start passes ${flag}, which is not an allowed flag`);
          }
        }
      }
    }
  }
  return violations;
}

/** A job's GitHub environment name, from `environment: x` or `environment: { name: x }`. */
function environmentNameOf(job: YamlNode): string {
  const environment = child(job, 'environment');
  if (environment === undefined) return '';
  return environment.value !== '' ? environment.value : (child(environment, 'name')?.value ?? '');
}

/** GitHub environment names are case-insensitive. */
function sharedEnvironmentViolations(others: { file: string; text: string }[]): string[] {
  const violations: string[] = [];
  for (const { file, text } of others) {
    for (const job of jobsOf(parseYaml(text))) {
      if (environmentNameOf(job).trim().toLowerCase() === MAINTENANCE_ENVIRONMENT) {
        violations.push(
          `${file} job ${String(job.key)} names the ${MAINTENANCE_ENVIRONMENT} environment`,
        );
      }
    }
  }
  return violations;
}

/** A `CODEOWNERS` pattern as GitHub reads it (gitignore-style, no negation). */
function codeownersPattern(pattern: string): RegExp {
  let p = pattern;
  const directory = p.endsWith('/');
  if (directory) p = p.slice(0, -1);
  const anchored = p.includes('/');
  if (p.startsWith('/')) p = p.slice(1);
  const last = p.split('/').pop() ?? '';
  let body = '';
  for (let i = 0; i < p.length; i += 1) {
    if (p.startsWith('**/', i)) {
      body += '(?:.*/)?';
      i += 2;
    } else if (p.startsWith('**', i)) {
      body += '.*';
      i += 1;
    } else if (p.charAt(i) === '*') {
      body += '[^/]*';
    } else if (p.charAt(i) === '?') {
      body += '[^/]';
    } else {
      body += escapeRegExp(p.charAt(i));
    }
  }
  const prefix = anchored ? '^' : '^(?:.*/)?';
  const suffix = directory ? '/.*$' : last.includes('*') ? '$' : '(?:/.*)?$';
  return new RegExp(`${prefix}${body}${suffix}`);
}

function codeownersViolations(text: string): string[] {
  const rules = codeLines(text).flatMap(({ content }) => {
    const words = stripComment(content.trim())
      .split(/\s+/)
      .filter((w) => w !== '');
    const [pattern, ...owners] = words;
    return pattern === undefined ? [] : [{ pattern: codeownersPattern(pattern), owners }];
  });
  const violations: string[] = [];
  for (const { path, probes } of CODEOWNED_PATHS) {
    for (const probe of probes) {
      const rule = rules.filter((r) => r.pattern.test(probe)).pop();
      if (rule === undefined) {
        violations.push(`${path} is not covered: no line matches ${probe}`);
      } else if (!rule.owners.includes(CODEOWNER)) {
        violations.push(
          `${path} is not owned by ${CODEOWNER}: the last line matching ${probe} lists [${rule.owners.join(', ')}]`,
        );
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// The rule of Resolved decision Q177: a re-run by another actor is refused.
// ---------------------------------------------------------------------------

const ACTOR_VALUE = /^\$\{\{\s*github\.actor\s*\}\}$/;
const TRIGGERING_ACTOR_VALUE = /^\$\{\{\s*github\.triggering_actor\s*\}\}$/;

/** A step's own `env` entries whose value is exactly the expression; `TAYZU_*` names never count. */
function actorEnvEntries(step: YamlNode, value: RegExp): YamlNode[] {
  return (child(step, 'env')?.children ?? []).filter(
    (entry) => !String(entry.key).startsWith('TAYZU_') && value.test(entry.value),
  );
}

/** A shell reference to a variable: `$NAME` or `${NAME}`, optionally double-quoted. */
function shellRef(name: string): string {
  return `"?\\$(?:${escapeRegExp(name)}|\\{${escapeRegExp(name)}\\})"?(?![A-Za-z0-9_])`;
}

/**
 * Whether a step's `run:` compares its env-mapped actor and triggering actor
 * (`if [ X != Y ]; then` or `[ X = Y ] ||`, either order, `[` or `[[`), and
 * whether the mismatch branch of such a comparison contains `exit 1`.
 */
function actorComparison(step: YamlNode): { compares: boolean; exits: boolean } {
  const actors = actorEnvEntries(step, ACTOR_VALUE).map((e) => String(e.key));
  const triggering = actorEnvEntries(step, TRIGGERING_ACTOR_VALUE).map((e) => String(e.key));
  const lines = runOf(step).split(/\r?\n/);
  let compares = false;
  let exits = false;
  for (const a of actors) {
    for (const t of triggering) {
      if (a === t) continue;
      const x = shellRef(a);
      const y = shellRef(t);
      const differ = new RegExp(
        `^\\s*if\\s+\\[\\[?\\s+(?:${x}\\s+!=\\s+${y}|${y}\\s+!=\\s+${x})\\s+\\]\\]?\\s*;\\s*then\\b`,
      );
      const equal = new RegExp(
        `^\\s*\\[\\[?\\s+(?:${x}\\s+==?\\s+${y}|${y}\\s+==?\\s+${x})\\s+\\]\\]?\\s*\\|\\|`,
      );
      lines.forEach((line, index) => {
        if (!differ.test(line) && !equal.test(line)) return;
        compares = true;
        if (EXIT_1.test(branchOf(lines, index))) exits = true;
      });
    }
  }
  return { compares, exits };
}

function actorCheckViolations(text: string): string[] {
  const jobs = jobsOf(parseYaml(text));
  if (jobs.length === 0) return ['the workflow declares no job'];
  const violations: string[] = [];
  for (const job of jobs) {
    const name = String(job.key);
    const steps = stepsOf(job);
    for (const step of steps) {
      if (ACTOR_LOGIN.test(runOf(step))) {
        violations.push(`a run step of job ${name} interpolates the actor login inside run:`);
      }
    }
    const index = steps.findIndex((step) => actorComparison(step).compares);
    const step = steps[index];
    if (step === undefined) {
      violations.push(`job ${name} does not compare the triggering actor with the actor`);
      continue;
    }
    if (index >= firstTokenStep(steps)) {
      violations.push(`job ${name} compares the actors only after the Azure login`);
      continue;
    }
    if (index !== 0) violations.push(`job ${name} compares the actors outside its first step`);
    if (!actorComparison(step).exits) {
      violations.push(`the actor comparison of job ${name} does not exit 1 on a mismatch`);
    }
    if (child(step, 'if') !== undefined || child(step, 'continue-on-error') !== undefined) {
      violations.push(`the actor comparison of job ${name} can be skipped`);
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Scratch workflows.
// ---------------------------------------------------------------------------

/** The compliant first step's actor mappings (Q177). */
const ACTOR_ENV =
  '        env:\n' +
  '          ACTOR: ${{ github.actor }}\n' +
  '          TRIGGERING_ACTOR: ${{ github.triggering_actor }}\n';

/** The compliant first step's actor comparison (Q177), after its tenant-id check. */
const ACTOR_CHECK =
  '          if [ "$TRIGGERING_ACTOR" != "$ACTOR" ]; then\n' +
  '            echo "This run was started again by another actor; start a new run." >&2\n' +
  '            exit 1\n' +
  '          fi\n';

/** A compliant workflow; the action SHA is a placeholder, not a real pin. */
const COMPLIANT = `name: Identity maintenance

on:
  workflow_dispatch:
    inputs:
      job:
        description: The maintenance script to start
        type: choice
        required: true
        options:
          - cancel-org-deletion
          - backfill-user-blueprint
          - reconcile-users
      tenant_id:
        description: The tenant id (the reversal only)
        type: string
        required: false
        default: ''

permissions:
  contents: read

concurrency:
  group: identity-maintenance
  cancel-in-progress: false

jobs:
  start:
    name: Start the maintenance job
    if: github.ref == 'refs/heads/master'
    runs-on: ubuntu-latest
    environment: identity-maintenance
    permissions:
      id-token: write
    env:
      MAINTENANCE_JOB: \${{ inputs.job }}
      TAYZU_TENANT_ID: \${{ inputs.tenant_id }}
      TAYZU_OPERATOR_ID: gh:\${{ github.actor_id }}
      RESOURCE_GROUP: \${{ vars.MAINTENANCE_RESOURCE_GROUP }}
    steps:
      - name: Validate the tenant id
${ACTOR_ENV}        run: |
          if [ -n "$TAYZU_TENANT_ID" ] && ! printf '%s' "$TAYZU_TENANT_ID" | grep -Eq '^[A-Za-z0-9_-]{1,64}$'; then
            echo "The tenant id is malformed." >&2
            exit 1
          fi
${ACTOR_CHECK}      - name: Azure login (OIDC)
        uses: azure/login@${'a'.repeat(40)} # v2
        with:
          client-id: \${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: \${{ secrets.AZURE_TENANT_ID }}
          subscription-id: \${{ secrets.AZURE_SUBSCRIPTION_ID }}
      - name: Start the Container Apps Job
        run: |
          az containerapp job start \\
            --name "$MAINTENANCE_JOB" \\
            --resource-group "$RESOURCE_GROUP" \\
            --env-vars "TAYZU_OPERATOR_ID=$TAYZU_OPERATOR_ID" "TAYZU_TENANT_ID=$TAYZU_TENANT_ID"
`;

/** The compliant workflow with one text replaced; fails loudly if the text is absent. */
function mutate(from: string, to: string): string {
  if (!COMPLIANT.includes(from)) throw new Error(`scratch mutation target not found: ${from}`);
  return COMPLIANT.replace(from, to);
}

const RULES = {
  trigger: triggerViolations,
  refCondition: refConditionViolations,
  environment: environmentViolations,
  permissions: permissionViolations,
  secrets: secretViolations,
  steps: stepViolations,
  operatorId: operatorIdViolations,
  choice: choiceViolations,
  bootstrapAdmin: (text: string) => namedCliViolations(text, BOOTSTRAP_ADMIN),
  recoverAdminMfa: (text: string) => namedCliViolations(text, RECOVER_ADMIN_MFA),
  purge: purgeViolations,
  actorCheck: actorCheckViolations,
} as const;

function expectRejected(violations: string[], reason: RegExp): void {
  expect(violations.length, 'the rule accepted a violating workflow').toBeGreaterThan(0);
  expect(violations.join('\n')).toMatch(reason);
}

/** The 7.4 rules that read the maintenance workflow alone. */
const WORKFLOW_RULES_7_4 = {
  interpolation: interpolationViolations,
  pins: pinViolations,
  inputs: inputValidationViolations,
  jobStart: jobStartViolations,
} as const;

/** A compliant `CODEOWNERS`, one line per required path. */
const CODEOWNERS_LINES = {
  workflows: '/.github/workflows/** @nahuex',
  actions: '/.github/actions/** @nahuex',
  codeowners: '/.github/CODEOWNERS @nahuex',
  scripts: '/apps/api/scripts/** @nahuex',
} as const;

const COMPLIANT_CODEOWNERS = `# The maintenance workflow, its actions, this file and the scripts (045 D3; Q64, Q72).
${Object.values(CODEOWNERS_LINES).join('\n')}
`;

/** A second workflow that uses an environment of its own. */
const SIBLING_WORKFLOW = `name: Deploy

on:
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - run: echo deploy
`;

// ---------------------------------------------------------------------------
// The real workflow.
// ---------------------------------------------------------------------------

describe('identity-maintenance workflow (the real file)', () => {
  it('exists at .github/workflows/identity-maintenance.yml', () => {
    expect(existsSync(WORKFLOW_PATH)).toBe(true);
  });

  it('has workflow_dispatch as its only trigger', () => {
    expect(triggerViolations(readWorkflow())).toEqual([]);
  });

  it('restricts every job to refs/heads/master with a job condition', () => {
    expect(refConditionViolations(readWorkflow())).toEqual([]);
  });

  it('declares a GitHub environment', () => {
    expect(environmentViolations(readWorkflow())).toEqual([]);
  });

  it('has id-token: write as its only elevated permission', () => {
    expect(permissionViolations(readWorkflow())).toEqual([]);
  });

  it("references no secrets. value other than the environment's", () => {
    expect(secretViolations(readWorkflow())).toEqual([]);
  });

  it('has no checkout and no setup step: one Azure login and one job start', () => {
    expect(stepViolations(readWorkflow())).toEqual([]);
  });

  it('passes gh: plus github.actor_id, never github.actor, as the operator id through env', () => {
    expect(operatorIdViolations(readWorkflow())).toEqual([]);
  });

  it('lists exactly the reversal, the blueprint backfill and the reconcile in its choice input', () => {
    expect(choiceViolations(readWorkflow())).toEqual([]);
  });

  it('names bootstrap-admin in no option and no line', () => {
    expect(namedCliViolations(readWorkflow(), BOOTSTRAP_ADMIN)).toEqual([]);
  });

  it('names recover-admin-mfa in no option and no line', () => {
    expect(namedCliViolations(readWorkflow(), RECOVER_ADMIN_MFA)).toEqual([]);
  });

  it('has no purge option, because the purge is scheduled', () => {
    expect(purgeViolations(readWorkflow())).toEqual([]);
  });
});

describe('The workflow does not interpolate its inputs (the real file, 7.4)', () => {
  it('has no ${{ inputs.* }}, github.event.* or github.head_ref inside any run:', () => {
    expect(interpolationViolations(readWorkflow())).toEqual([]);
  });

  it('pins every uses: by a 40-character commit SHA and uses no local action', () => {
    expect(pinViolations(readWorkflow())).toEqual([]);
  });

  it('has every input a choice or validated against the tenant-id pattern before the Azure login', () => {
    expect(inputValidationViolations(readWorkflow())).toEqual([]);
  });

  it('has a .github/CODEOWNERS file', () => {
    expect(existsSync(CODEOWNERS_PATH)).toBe(true);
  });

  it('has CODEOWNERS cover the workflows, the actions, itself and apps/api/scripts with @nahuex', () => {
    expect(codeownersViolations(readCodeowners())).toEqual([]);
  });
});

describe('The workflow starts only the named jobs without overrides (the real file, 7.4)', () => {
  it('starts the job with no --command, --args or --image and only the fixed --env-vars names', () => {
    expect(jobStartViolations(readWorkflow())).toEqual([]);
  });

  it('is the only workflow that names the identity-maintenance environment', () => {
    const names = jobsOf(parseYaml(readWorkflow())).map(environmentNameOf);
    expect(names).toEqual([MAINTENANCE_ENVIRONMENT]);
    expect(sharedEnvironmentViolations(readOtherWorkflows())).toEqual([]);
  });
});

describe('The workflow refuses a re-run by another actor (the real file, Q177)', () => {
  it('compares the triggering actor with the actor through env in its first step, before the Azure login, with no if: and no continue-on-error, and exits 1 on a mismatch', () => {
    expect(actorCheckViolations(readWorkflow())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The rules on scratch workflows.
// ---------------------------------------------------------------------------

describe('identity-maintenance workflow rules (scratch workflows)', () => {
  it('accept a compliant workflow', () => {
    for (const [name, rule] of Object.entries(RULES)) {
      expect(rule(COMPLIANT), name).toEqual([]);
    }
  });

  it('reject a trigger other than workflow_dispatch', () => {
    expectRejected(
      triggerViolations(
        mutate('on:\n  workflow_dispatch:\n', 'on:\n  push:\n  workflow_dispatch:\n'),
      ),
      /trigger other than workflow_dispatch: push/,
    );
    expectRejected(
      triggerViolations(
        mutate('\npermissions:\n', '\n  schedule:\n    - cron: "0 3 * * *"\n\npermissions:\n'),
      ),
      /trigger other than workflow_dispatch: schedule/,
    );
    expectRejected(
      triggerViolations('on: [workflow_dispatch, workflow_call]\njobs:\n  a:\n    runs-on: x\n'),
      /trigger other than workflow_dispatch: workflow_call/,
    );
    expectRejected(
      triggerViolations('on: pull_request_target\njobs:\n  a:\n    runs-on: x\n'),
      /workflow_dispatch is not a trigger/,
    );
  });

  it('reject a job without the refs/heads/master condition', () => {
    expectRejected(
      refConditionViolations(mutate("    if: github.ref == 'refs/heads/master'\n", '')),
      /job start has no condition on refs\/heads\/master/,
    );
    expectRejected(
      refConditionViolations(mutate("'refs/heads/master'", "'refs/heads/main'")),
      /job start has no condition on refs\/heads\/master/,
    );
    expectRejected(
      refConditionViolations(
        mutate("'refs/heads/master'\n", "'refs/heads/master' || inputs.job != ''\n"),
      ),
      /weakens its refs\/heads\/master condition/,
    );
  });

  it('reject a job without an environment, or with a computed one', () => {
    expectRejected(
      environmentViolations(mutate('    environment: identity-maintenance\n', '')),
      /job start declares no environment/,
    );
    expectRejected(
      environmentViolations(
        mutate('environment: identity-maintenance', 'environment: ${{ inputs.job }}'),
      ),
      /computes its environment name/,
    );
  });

  it('reject an elevated permission other than id-token: write', () => {
    expectRejected(
      permissionViolations(
        mutate('      id-token: write\n', '      id-token: write\n      contents: write\n'),
      ),
      /elevates contents: write/,
    );
    expectRejected(
      permissionViolations(mutate('permissions:\n  contents: read\n', 'permissions: write-all\n')),
      /permissions are `write-all`/,
    );
    expectRejected(
      permissionViolations(mutate('      id-token: write\n', '      contents: read\n')),
      /no id-token: write permission/,
    );
    expectRejected(
      permissionViolations(
        mutate('permissions:\n  contents: read\n', '').replace(
          '    permissions:\n      id-token: write\n',
          '',
        ),
      ),
      /inherits the default token permissions/,
    );
  });

  it("reject a secrets. reference other than the environment's", () => {
    expectRejected(
      secretViolations(
        mutate(
          '      RESOURCE_GROUP:',
          '      GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n      RESOURCE_GROUP:',
        ),
      ),
      /references secrets\.GITHUB_TOKEN/,
    );
    expectRejected(
      secretViolations(
        mutate(
          '          subscription-id:',
          '          creds: ${{ secrets.AZURE_CREDENTIALS }}\n          subscription-id:',
        ),
      ),
      /stored cloud credential/,
    );
    expectRejected(
      secretViolations(
        mutate('      RESOURCE_GROUP:', '      ALL: ${{ toJSON(secrets) }}\n      RESOURCE_GROUP:'),
      ),
      /exposes secrets wholesale/,
    );
    expectRejected(
      secretViolations(
        mutate('\njobs:\n', '\nenv:\n  CLIENT: ${{ secrets.AZURE_CLIENT_ID }}\n\njobs:\n'),
      ),
      /secrets\.AZURE_CLIENT_ID outside the environment's job/,
    );
  });

  it('reject a checkout or setup step', () => {
    expectRejected(
      stepViolations(
        mutate(
          '    steps:\n',
          `    steps:\n      - uses: actions/checkout@${'b'.repeat(40)} # v6\n`,
        ),
      ),
      /checkout step/,
    );
    expectRejected(
      stepViolations(
        mutate('    steps:\n', `    steps:\n      - uses: actions/setup-node@${'c'.repeat(40)}\n`),
      ),
      /setup step/,
    );
    expectRejected(
      stepViolations(mutate('    steps:\n', '    steps:\n      - uses: ./.github/actions/setup\n')),
      /setup step/,
    );
    expectRejected(
      stepViolations(
        mutate('    steps:\n', '    steps:\n      - run: pnpm install --frozen-lockfile\n'),
      ),
      /checks out or sets up code/,
    );
    expectRejected(
      stepViolations(
        mutate(
          '    steps:\n',
          '    steps:\n      - name: Fetch\n        run: git clone https://example.invalid/r.git\n',
        ),
      ),
      /checks out or sets up code/,
    );
    expectRejected(
      stepViolations(mutate('az containerapp job start', 'az containerapp job show')),
      /expected one az containerapp job start, found 0/,
    );
  });

  it('reject an operator id other than gh: plus github.actor_id passed through env', () => {
    expectRejected(
      operatorIdViolations(mutate('gh:${{ github.actor_id }}', 'gh:${{ github.actor }}')),
      /not gh: plus github\.actor_id/,
    );
    expectRejected(
      operatorIdViolations(mutate('gh:${{ github.actor_id }}', 'gh:${{ github.actor }}')),
      /uses the actor login/,
    );
    expectRejected(
      operatorIdViolations(mutate('gh:${{ github.actor_id }}', '${{ github.actor_id }}')),
      /not gh: plus github\.actor_id/,
    );
    expectRejected(
      operatorIdViolations(
        mutate('      TAYZU_OPERATOR_ID: gh:${{ github.actor_id }}\n', '').replace(
          '      - name: Azure login (OIDC)\n',
          '      - run: echo "TAYZU_OPERATOR_ID=gh:${{ github.actor_id }}" >> "$GITHUB_ENV"\n      - name: Azure login (OIDC)\n',
        ),
      ),
      /no env mapping sets TAYZU_OPERATOR_ID/,
    );
    expectRejected(
      operatorIdViolations(
        mutate(
          '"TAYZU_OPERATOR_ID=$TAYZU_OPERATOR_ID" ',
          '"TAYZU_OPERATOR_ID=${{ github.actor_id }}" ',
        ),
      ),
      /builds the operator id/,
    );
    expectRejected(
      operatorIdViolations(mutate('"TAYZU_OPERATOR_ID=$TAYZU_OPERATOR_ID" ', '')),
      /does not pass TAYZU_OPERATOR_ID from env/,
    );
  });

  it("reject github.actor as the operator id even with Q177's actor mappings in place", () => {
    expectRejected(
      operatorIdViolations(mutate('gh:${{ github.actor_id }}', '${{ github.actor }}')),
      /not gh: plus github\.actor_id/,
    );
    expectRejected(
      operatorIdViolations(mutate('gh:${{ github.actor_id }}', '${{ github.actor }}')),
      /uses the actor login/,
    );
    expectRejected(
      operatorIdViolations(
        mutate('gh:${{ github.actor_id }}', 'gh:${{ github.triggering_actor }}'),
      ),
      /uses the actor login/,
    );
    // The operator id moved into the comparison step's own env: a TAYZU_ name is never exempt.
    expectRejected(
      operatorIdViolations(
        mutate(
          '          TRIGGERING_ACTOR: ${{ github.triggering_actor }}\n',
          '          TRIGGERING_ACTOR: ${{ github.triggering_actor }}\n          TAYZU_OPERATOR_ID: ${{ github.actor }}\n',
        ),
      ),
      /line \d+ uses the actor login/,
    );
    // Anything around the expression loses the exemption, even in the comparison step's env.
    expectRejected(
      operatorIdViolations(
        mutate(
          '          TRIGGERING_ACTOR: ${{ github.triggering_actor }}\n',
          '          TRIGGERING_ACTOR: ${{ github.triggering_actor }}\n          OPERATOR: gh:${{ github.actor }}\n',
        ),
      ),
      /line \d+ uses the actor login/,
    );
  });

  it("reject the actor login outside the comparison step's env", () => {
    expectRejected(
      operatorIdViolations(
        mutate('      RESOURCE_GROUP:', '      ACTOR: ${{ github.actor }}\n      RESOURCE_GROUP:'),
      ),
      /line \d+ uses the actor login/,
    );
    expectRejected(
      operatorIdViolations(
        mutate(
          START_STEP,
          `${START_STEP}        env:\n          TRIGGERING_ACTOR: \${{ github.triggering_actor }}\n`,
        ),
      ),
      /line \d+ uses the actor login/,
    );
    expectRejected(
      operatorIdViolations(
        mutate(
          "    if: github.ref == 'refs/heads/master'\n",
          "    if: github.ref == 'refs/heads/master' && github.actor != ''\n",
        ),
      ),
      /line \d+ uses the actor login/,
    );
    expectRejected(
      operatorIdViolations(
        mutate(
          '          ACTOR: ${{ github.actor }}\n',
          "          ACTOR: ${{ github['actor'] }}\n",
        ),
      ),
      /line \d+ uses the actor login/,
    );
    // The mappings are exempt only while their step really compares the two actors.
    expectRejected(operatorIdViolations(mutate(ACTOR_CHECK, '')), /line \d+ uses the actor login/);
  });

  it('reject a choice input that does not list exactly the three maintenance scripts', () => {
    expectRejected(
      choiceViolations(mutate('          - reconcile-users\n', '')),
      /the choice options are/,
    );
    expectRejected(
      choiceViolations(
        mutate(
          '          - reconcile-users\n',
          '          - reconcile-users\n          - other-script\n',
        ),
      ),
      /the choice options are/,
    );
    expectRejected(
      choiceViolations(
        mutate('          - reconcile-users\n', '          - cancel-org-deletion\n'),
      ),
      /the choice options are/,
    );
    expectRejected(
      choiceViolations(mutate('        type: choice\n', '        type: string\n')),
      /expected one choice input, found 0/,
    );
    expectRejected(
      choiceViolations(
        mutate(
          '      tenant_id:\n',
          '      second:\n        type: choice\n        options: [cancel-org-deletion]\n      tenant_id:\n',
        ),
      ),
      /expected one choice input, found 2/,
    );
  });

  it('reject bootstrap-admin as an option or on any line', () => {
    expectRejected(
      RULES.bootstrapAdmin(
        mutate(
          '          - reconcile-users\n',
          '          - reconcile-users\n          - bootstrap-admin\n',
        ),
      ),
      /option bootstrap-admin names an out-of-band CLI/,
    );
    expectRejected(
      RULES.bootstrapAdmin(mutate('\njobs:\n', '\n# bootstrap:admin runs out of band\njobs:\n')),
      /line \d+ names an out-of-band CLI/,
    );
  });

  it('reject recover-admin-mfa as an option or on any line', () => {
    expectRejected(
      RULES.recoverAdminMfa(
        mutate(
          '          - reconcile-users\n',
          '          - reconcile-users\n          - recover-admin-mfa\n',
        ),
      ),
      /option recover-admin-mfa names an out-of-band CLI/,
    );
    expectRejected(
      RULES.recoverAdminMfa(
        mutate(
          '    name: Start the maintenance job\n',
          '    name: Start the maintenance job # not recover-admin-mfa\n',
        ),
      ),
      /line \d+ names an out-of-band CLI/,
    );
  });

  it('reject a purge option', () => {
    expectRejected(
      purgeViolations(
        mutate(
          '          - reconcile-users\n',
          '          - reconcile-users\n          - purge-job\n',
        ),
      ),
      /option purge-job starts the purge/,
    );
    expectRejected(
      purgeViolations(
        mutate('      RESOURCE_GROUP:', '      PURGE: identity:purge\n      RESOURCE_GROUP:'),
      ),
      /names the purge job/,
    );
  });
});

/** The compliant workflow's tenant-id check, the first step. */
const VALIDATION_STEP = COMPLIANT.slice(
  COMPLIANT.indexOf('      - name: Validate the tenant id\n'),
  COMPLIANT.indexOf('      - name: Azure login (OIDC)\n'),
);

const START_STEP = '      - name: Start the Container Apps Job\n';
const RESOURCE_GROUP_ARG = '            --resource-group "$RESOURCE_GROUP" \\\n';
const TENANT_ENV_VAR = '"TAYZU_TENANT_ID=$TAYZU_TENANT_ID"';

const NO_TENANT_VALIDATION =
  /env TAYZU_TENANT_ID of job start carries input tenant_id without validation/;

describe('identity-maintenance workflow rules of 7.4 (scratch texts)', () => {
  it('accept a compliant workflow, CODEOWNERS and sibling workflow', () => {
    expect(VALIDATION_STEP).toMatch(/^ {6}- name: Validate the tenant id\n/);
    for (const [name, rule] of Object.entries(WORKFLOW_RULES_7_4)) {
      expect(rule(COMPLIANT), name).toEqual([]);
    }
    expect(codeownersViolations(COMPLIANT_CODEOWNERS)).toEqual([]);
    expect(codeownersViolations('* @nahuex\n')).toEqual([]);
    expect(
      codeownersViolations(
        '/.github/workflows/ @nahuex\n/.github/actions/ @nahuex\n/.github/CODEOWNERS @nahuex\n/apps/api/scripts/ @nahuex @second-human\n',
      ),
    ).toEqual([]);
    expect(sharedEnvironmentViolations([{ file: 'deploy.yml', text: SIBLING_WORKFLOW }])).toEqual(
      [],
    );
  });

  it('reject ${{ inputs.* }} inside a run:', () => {
    expectRejected(
      interpolationViolations(mutate('--name "$MAINTENANCE_JOB"', '--name "${{ inputs.job }}"')),
      /interpolates inputs\.\*/,
    );
    expectRejected(
      interpolationViolations(mutate(TENANT_ENV_VAR, '"TAYZU_TENANT_ID=${{inputs.tenant_id}}"')),
      /interpolates inputs\.\*/,
    );
    expectRejected(
      interpolationViolations(
        mutate(
          '      - name: Azure login (OIDC)\n',
          `      - run: echo "\${{ inputs['tenant_id'] }}"\n      - name: Azure login (OIDC)\n`,
        ),
      ),
      /interpolates inputs\.\*/,
    );
  });

  it('reject github.event.* inside a run:', () => {
    expectRejected(
      interpolationViolations(
        mutate(TENANT_ENV_VAR, '"TAYZU_TENANT_ID=${{ github.event.inputs.tenant_id }}"'),
      ),
      /reads github\.event\.\*/,
    );
  });

  it('reject github.head_ref inside a run:', () => {
    expectRejected(
      interpolationViolations(
        mutate(
          '            echo "The tenant id is malformed." >&2\n',
          '            echo "Malformed on ${{ github.head_ref }}." >&2\n',
        ),
      ),
      /reads github\.head_ref/,
    );
  });

  it('reject a uses: pinned by a tag or a branch, or by no full SHA', () => {
    const pinned = `azure/login@${'a'.repeat(40)}`;
    expectRejected(
      pinViolations(mutate(pinned, 'azure/login@v3')),
      /azure\/login@v3, not pinned by a 40-character commit SHA/,
    );
    expectRejected(
      pinViolations(mutate(pinned, 'azure/login@main')),
      /azure\/login@main, not pinned by a 40-character commit SHA/,
    );
    expectRejected(
      pinViolations(mutate(pinned, 'azure/login@a641126')),
      /azure\/login@a641126, not pinned by a 40-character commit SHA/,
    );
    expectRejected(
      pinViolations(mutate(pinned, 'azure/login')),
      /azure\/login, not pinned by a 40-character commit SHA/,
    );
  });

  it('reject a local uses: ./', () => {
    expectRejected(
      pinViolations(mutate('    steps:\n', '    steps:\n      - uses: ./.github/actions/setup\n')),
      /uses a local action: \.\/\.github\/actions\/setup/,
    );
  });

  it('reject a tenant-id input with no validation', () => {
    expectRejected(inputValidationViolations(mutate(VALIDATION_STEP, '')), NO_TENANT_VALIDATION);
  });

  it('reject a tenant-id check that runs after the Azure login', () => {
    expectRejected(
      inputValidationViolations(
        mutate(VALIDATION_STEP, '').replace(START_STEP, `${VALIDATION_STEP}${START_STEP}`),
      ),
      NO_TENANT_VALIDATION,
    );
  });

  it('reject a tenant-id check without the tenant-id pattern or without exit 1', () => {
    expectRejected(
      inputValidationViolations(mutate("'^[A-Za-z0-9_-]{1,64}$'", "'^[A-Za-z0-9_.:-]{1,128}$'")),
      NO_TENANT_VALIDATION,
    );
    expectRejected(
      inputValidationViolations(mutate('            exit 1\n', '            true\n')),
      NO_TENANT_VALIDATION,
    );
  });

  it('reject a tenant-id check that can be skipped', () => {
    expectRejected(
      inputValidationViolations(
        mutate(
          '      - name: Validate the tenant id\n',
          "      - name: Validate the tenant id\n        if: env.MAINTENANCE_JOB == 'cancel-org-deletion'\n",
        ),
      ),
      NO_TENANT_VALIDATION,
    );
    expectRejected(
      inputValidationViolations(
        mutate(
          '      - name: Validate the tenant id\n',
          '      - name: Validate the tenant id\n        continue-on-error: true\n',
        ),
      ),
      NO_TENANT_VALIDATION,
    );
  });

  it('reject a tenant id carried by a variable the check does not read', () => {
    expectRejected(
      inputValidationViolations(
        mutate(
          '      TAYZU_TENANT_ID: ${{ inputs.tenant_id }}\n',
          '      TAYZU_TENANT_ID: ${{ inputs.tenant_id }}\n      RAW_TENANT_ID: ${{ inputs.tenant_id }}\n',
        ),
      ),
      /env RAW_TENANT_ID of job start carries input tenant_id without validation/,
    );
    expectRejected(
      inputValidationViolations(
        mutate(
          START_STEP,
          `${START_STEP}        env:\n          TAYZU_TENANT_ID: \${{ inputs.tenant_id }}\n`,
        ),
      ),
      /env TAYZU_TENANT_ID of step "Start the Container Apps Job" carries input tenant_id without validation/,
    );
  });

  it('reject a tenant id read outside an env mapping', () => {
    expectRejected(
      inputValidationViolations(
        mutate(
          '          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}\n',
          '          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}\n          audience: ${{ inputs.tenant_id }}\n',
        ),
      ),
      /line \d+ reads input tenant_id outside an env mapping/,
    );
  });

  it('reject an input that is neither a choice nor validated', () => {
    expectRejected(
      inputValidationViolations(
        mutate(
          '      tenant_id:\n',
          '      reason:\n        description: Why\n        type: string\n      tenant_id:\n',
        ),
      ),
      /input reason is neither a choice nor validated/,
    );
    expectRejected(
      inputValidationViolations(
        mutate('      tenant_id:\n', '      dry_run:\n        type: boolean\n      tenant_id:\n'),
      ),
      /input dry_run is neither a choice nor validated/,
    );
    expectRejected(
      inputValidationViolations(
        mutate(
          '      tenant_id:\n',
          '      reason:\n        type: string\n      tenant_id:\n',
        ).replace(
          '      RESOURCE_GROUP:',
          '      REASON: ${{ inputs.reason }}\n      RESOURCE_GROUP:',
        ),
      ),
      /env REASON of job start carries input reason without validation/,
    );
  });

  it('reject an az call with --command, --args or --image', () => {
    expectRejected(
      jobStartViolations(
        mutate(RESOURCE_GROUP_ARG, `${RESOURCE_GROUP_ARG}            --command "/bin/sh" \\\n`),
      ),
      /passes --command, which overrides the job/,
    );
    expectRejected(
      jobStartViolations(
        mutate(RESOURCE_GROUP_ARG, `${RESOURCE_GROUP_ARG}            --command=/bin/sh \\\n`),
      ),
      /passes --command, which overrides the job/,
    );
    expectRejected(
      jobStartViolations(
        mutate(RESOURCE_GROUP_ARG, `${RESOURCE_GROUP_ARG}            --args "id" \\\n`),
      ),
      /passes --args, which overrides the job/,
    );
    expectRejected(
      jobStartViolations(
        mutate(
          RESOURCE_GROUP_ARG,
          `${RESOURCE_GROUP_ARG}            --image registry.invalid/other:latest \\\n`,
        ),
      ),
      /passes --image, which overrides the job/,
    );
  });

  it('reject an az call with another template flag', () => {
    expectRejected(
      jobStartViolations(
        mutate(RESOURCE_GROUP_ARG, `${RESOURCE_GROUP_ARG}            --yaml template.yaml \\\n`),
      ),
      /passes --yaml, which is not an allowed flag/,
    );
  });

  it('reject an az call with an --env-vars name outside the fixed ones', () => {
    expectRejected(
      jobStartViolations(
        mutate(TENANT_ENV_VAR, `${TENANT_ENV_VAR} "NODE_OPTIONS=--require=/tmp/x.js"`),
      ),
      /sets --env-vars NODE_OPTIONS, outside the fixed names/,
    );
    expectRejected(
      jobStartViolations(mutate(TENANT_ENV_VAR, '"TAYZU_TENANT_ID=$RAW_TENANT_ID"')),
      /sets --env-vars TAYZU_TENANT_ID from something other than \$TAYZU_TENANT_ID/,
    );
  });

  it.each([
    ['.github/workflows/**', CODEOWNERS_LINES.workflows],
    ['.github/actions/**', CODEOWNERS_LINES.actions],
    ['.github/CODEOWNERS', CODEOWNERS_LINES.codeowners],
    ['apps/api/scripts/**', CODEOWNERS_LINES.scripts],
  ])('reject a CODEOWNERS that lacks %s', (path, line) => {
    expectRejected(
      codeownersViolations(COMPLIANT_CODEOWNERS.replace(`${line}\n`, '')),
      new RegExp(`${escapeRegExp(path)} is not covered`),
    );
  });

  it('reject a CODEOWNERS whose last matching line does not list @nahuex', () => {
    expectRejected(
      codeownersViolations(
        COMPLIANT_CODEOWNERS.replace(
          CODEOWNERS_LINES.scripts,
          '/apps/api/scripts/** @someone-else',
        ),
      ),
      /apps\/api\/scripts\/\*\* is not owned by @nahuex/,
    );
    expectRejected(
      codeownersViolations(`${COMPLIANT_CODEOWNERS}/apps/api/scripts/recover-admin-mfa.ts\n`),
      /apps\/api\/scripts\/\*\* is not owned by @nahuex: the last line matching apps\/api\/scripts\/recover-admin-mfa\.ts/,
    );
  });

  it('reject a CODEOWNERS pattern narrower than the required path', () => {
    expectRejected(
      codeownersViolations(
        COMPLIANT_CODEOWNERS.replace(
          CODEOWNERS_LINES.workflows,
          '/.github/workflows/*.yml @nahuex',
        ),
      ),
      /\.github\/workflows\/\*\* is not covered: no line matches \.github\/workflows\/a-future-workflow\.yaml/,
    );
    expectRejected(
      codeownersViolations(
        COMPLIANT_CODEOWNERS.replace(CODEOWNERS_LINES.scripts, '/apps/api/scripts/* @nahuex'),
      ),
      /apps\/api\/scripts\/\*\* is not covered: no line matches apps\/api\/scripts\/lib\/a-future-module\.ts/,
    );
  });

  it('reject another workflow that names the same environment', () => {
    expectRejected(
      sharedEnvironmentViolations([
        {
          file: 'deploy.yml',
          text: SIBLING_WORKFLOW.replace(
            'environment: production',
            'environment: identity-maintenance',
          ),
        },
      ]),
      /deploy\.yml job deploy names the identity-maintenance environment/,
    );
    expectRejected(
      sharedEnvironmentViolations([
        {
          file: 'deploy.yml',
          text: SIBLING_WORKFLOW.replace(
            'environment: production',
            'environment:\n      name: "identity-maintenance"\n      url: https://example.invalid',
          ),
        },
      ]),
      /deploy\.yml job deploy names the identity-maintenance environment/,
    );
    expectRejected(
      sharedEnvironmentViolations([
        {
          file: 'deploy.yml',
          text: SIBLING_WORKFLOW.replace(
            'environment: production',
            'environment: Identity-Maintenance',
          ),
        },
      ]),
      /deploy\.yml job deploy names the identity-maintenance environment/,
    );
  });
});

/** The Q177 check as a step of its own, for moving it after the Azure login. */
const ACTOR_CHECK_STEP = `      - name: Refuse a re-run by another actor\n${ACTOR_ENV}        run: |\n${ACTOR_CHECK}`;

/** The compliant workflow with the Q177 check taken out of its first step. */
function withoutActorCheck(): string {
  return mutate(ACTOR_ENV, '').replace(ACTOR_CHECK, '');
}

const NO_ACTOR_CHECK = /job start does not compare the triggering actor with the actor/;

describe('The workflow refuses a re-run by another actor (scratch workflows, Q177)', () => {
  it('accept a compliant workflow, and the `[ X = Y ] ||` form of the check', () => {
    expect(actorCheckViolations(COMPLIANT)).toEqual([]);
    expect(operatorIdViolations(COMPLIANT)).toEqual([]);
    const orForm = mutate(
      ACTOR_CHECK,
      '          [[ "${ACTOR}" == "${TRIGGERING_ACTOR}" ]] || { echo "Started again by another actor." >&2; exit 1; }\n',
    );
    expect(actorCheckViolations(orForm)).toEqual([]);
    expect(operatorIdViolations(orForm)).toEqual([]);
  });

  it('reject a workflow without the actor check', () => {
    expectRejected(actorCheckViolations(withoutActorCheck()), NO_ACTOR_CHECK);
    // The mappings without the comparison.
    expectRejected(actorCheckViolations(mutate(ACTOR_CHECK, '')), NO_ACTOR_CHECK);
    // The comparison without the mappings: the variables do not come from env.
    expectRejected(actorCheckViolations(mutate(ACTOR_ENV, '')), NO_ACTOR_CHECK);
  });

  it('reject an actor check that runs after the Azure login', () => {
    const moved = withoutActorCheck().replace(START_STEP, `${ACTOR_CHECK_STEP}${START_STEP}`);
    expectRejected(
      actorCheckViolations(moved),
      /job start compares the actors only after the Azure login/,
    );
    // Its env mappings are outside the exemption, so the 7.3 rule rejects them too.
    expectRejected(operatorIdViolations(moved), /line \d+ uses the actor login/);
  });

  it('reject an actor check in a step other than the first one', () => {
    expectRejected(
      actorCheckViolations(
        withoutActorCheck().replace(
          '      - name: Azure login (OIDC)\n',
          `${ACTOR_CHECK_STEP}      - name: Azure login (OIDC)\n`,
        ),
      ),
      /job start compares the actors outside its first step/,
    );
  });

  it('reject ${{ github.triggering_actor }} or ${{ github.actor }} inside run:', () => {
    const triggering = mutate(
      '[ "$TRIGGERING_ACTOR" != "$ACTOR" ]',
      '[ "${{ github.triggering_actor }}" != "$ACTOR" ]',
    );
    expectRejected(
      actorCheckViolations(triggering),
      /a run step of job start interpolates the actor login inside run:/,
    );
    expectRejected(operatorIdViolations(triggering), /line \d+ uses the actor login/);
    expectRejected(
      actorCheckViolations(
        mutate(
          '[ "$TRIGGERING_ACTOR" != "$ACTOR" ]',
          '[ "$TRIGGERING_ACTOR" != "${{ github.actor }}" ]',
        ),
      ),
      /a run step of job start interpolates the actor login inside run:/,
    );
    expectRejected(
      actorCheckViolations(
        mutate(
          '            echo "The tenant id is malformed." >&2\n',
          '            echo "Malformed, ${{ github.triggering_actor }}." >&2\n',
        ),
      ),
      /a run step of job start interpolates the actor login inside run:/,
    );
  });

  it('reject an actor comparison without exit 1 on the mismatch branch', () => {
    expectRejected(
      actorCheckViolations(mutate(ACTOR_CHECK, ACTOR_CHECK.replace('exit 1', 'true'))),
      /the actor comparison of job start does not exit 1 on a mismatch/,
    );
    // The tenant check's exit 1 in the same step does not count for the comparison.
    expectRejected(
      actorCheckViolations(
        mutate(
          ACTOR_CHECK,
          '          if [ "$TRIGGERING_ACTOR" != "$ACTOR" ]; then echo "Another actor." >&2; fi\n',
        ),
      ),
      /the actor comparison of job start does not exit 1 on a mismatch/,
    );
    // Exiting on a match, not a mismatch, is not the comparison the rule accepts.
    expectRejected(
      actorCheckViolations(
        mutate('"$TRIGGERING_ACTOR" != "$ACTOR"', '"$TRIGGERING_ACTOR" = "$ACTOR"'),
      ),
      NO_ACTOR_CHECK,
    );
  });

  it('reject an actor check that can be skipped', () => {
    expectRejected(
      actorCheckViolations(
        mutate(
          '      - name: Validate the tenant id\n',
          "      - name: Validate the tenant id\n        if: env.MAINTENANCE_JOB == 'cancel-org-deletion'\n",
        ),
      ),
      /the actor comparison of job start can be skipped/,
    );
    expectRejected(
      actorCheckViolations(
        mutate(
          '      - name: Validate the tenant id\n',
          '      - name: Validate the tenant id\n        continue-on-error: true\n',
        ),
      ),
      /the actor comparison of job start can be skipped/,
    );
  });
});
