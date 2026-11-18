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
 */
import { existsSync, readFileSync } from 'node:fs';
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
const ACTOR_LOGIN = /github\.(?:triggering_)?actor\b/;

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
  for (const { index, content } of codeLines(text)) {
    if (ACTOR_LOGIN.test(stripComment(content))) {
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
// Scratch workflows.
// ---------------------------------------------------------------------------

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
        run: |
          if [ -n "$TAYZU_TENANT_ID" ] && ! printf '%s' "$TAYZU_TENANT_ID" | grep -Eq '^[A-Za-z0-9_.:-]{1,128}$'; then
            echo "The tenant id is malformed." >&2
            exit 1
          fi
      - name: Azure login (OIDC)
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
} as const;

function expectRejected(violations: string[], reason: RegExp): void {
  expect(violations.length, 'the rule accepted a violating workflow').toBeGreaterThan(0);
  expect(violations.join('\n')).toMatch(reason);
}

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
