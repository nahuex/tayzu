/**
 * `043` task 13.12 (`002` VCDM M17, Resolved decision Q95): Dependabot tracks
 * every pinned image digest (`postgres`, Cerbos, ZAP).
 *
 * Dependabot's `docker` ecosystem reads Dockerfiles and compose files; it
 * cannot read a digest that lives only in a shell script or in a workflow
 * `docker run`. So the test requires, for the repository files read as text:
 *
 * - the `docker` ecosystem covers every directory that holds a Dockerfile or
 *   compose file with a pinned digest, and
 * - every pinned digest (wherever it is used: workflow, script, compose) also
 *   sits in at least one such file under a covered directory. A digest pinned
 *   only where no entry reads it fails.
 *
 * This file lives in `apps/api/src` only because `.github` is outside every
 * package (like `zap-seed.test.ts`). No production symbol is needed: the
 * implementer edits `.github/dependabot.yml`, adds a compose file or
 * Dockerfile under `scripts/ci/` that `dast.sh` references, and moves the
 * pins there.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));

const DIGEST = /[a-z0-9][\w./-]*(?::[\w.-]+)?@sha256:[0-9a-f]{64}/g;

interface Entry {
  ecosystem: string;
  directories: string[];
}

/** A minimal reader for the shape of `.github/dependabot.yml` (no YAML parser is a dependency). */
function readEntries(): Entry[] {
  const text = readFileSync(path.join(root, '.github/dependabot.yml'), 'utf8');
  const blocks = text.split(/^ {2}- package-ecosystem:/m).slice(1);
  return blocks.map((block) => {
    const ecosystem = /^\s*([\w-]+)/.exec(block)?.[1] ?? '';
    const directories: string[] = [];
    const single = /^ {4}directory:\s*['"]?([^'"\s#]+)/m.exec(block)?.[1];
    if (single !== undefined) directories.push(single);
    const list = /^ {4}directories:\s*\n((?: {6}- .*\n?)+)/m.exec(block)?.[1];
    if (list !== undefined) {
      for (const line of list.split('\n')) {
        const item = /^ {6}- ['"]?([^'"\s#]+)/.exec(line)?.[1];
        if (item !== undefined) directories.push(item);
      }
    }
    return { ecosystem, directories };
  });
}

function covers(directory: string, entryDir: string): boolean {
  const normalized = (d: string): string => (d === '/' ? '' : d.replace(/\/+$/, ''));
  const dir = normalized(directory);
  if (entryDir.endsWith('/**')) return dir.startsWith(normalized(entryDir.slice(0, -3)));
  if (entryDir.endsWith('/*')) {
    const base = normalized(entryDir.slice(0, -2));
    return dir.startsWith(base + '/') && !dir.slice(base.length + 1).includes('/');
  }
  return dir === normalized(entryDir);
}

function dockerCovers(directory: string): boolean {
  return readEntries().some(
    (entry) => entry.ecosystem === 'docker' && entry.directories.some((d) => covers(directory, d)),
  );
}

const trackedFiles = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(
    (file) =>
      file !== '' &&
      !/^(openspec|docs|\.claude)\//.test(file) &&
      !/\.test\.ts$/.test(file) &&
      !/(^|\/)(pnpm-lock\.yaml|node_modules)/.test(file),
  );

interface Pin {
  file: string;
  image: string;
}

const pins: Pin[] = trackedFiles.flatMap((file) => {
  let content: string;
  try {
    content = readFileSync(path.join(root, file), 'utf8');
  } catch {
    return [];
  }
  return (content.match(DIGEST) ?? []).map((image) => ({ file, image }));
});

const READABLE = /(^|\/)(Dockerfile[^/]*|[^/]*\.Dockerfile|(docker-)?compose[^/]*\.ya?ml)$/;

const readablePins = pins.filter((pin) => READABLE.test(pin.file));

function digestOf(image: string): string {
  return image.slice(image.indexOf('@sha256:') + 1);
}

describe('Dependabot tracks the pinned image digests (task 13.12)', () => {
  it('finds the pinned digests of postgres, Cerbos and ZAP', () => {
    const images = pins.map((pin) => pin.image);
    expect(images.some((i) => i.startsWith('postgres:18@sha256:'))).toBe(true);
    expect(images.some((i) => i.startsWith('ghcr.io/cerbos/cerbos@sha256:'))).toBe(true);
    expect(images.some((i) => i.startsWith('ghcr.io/zaproxy/zaproxy@sha256:'))).toBe(true);
  });

  it('keeps the npm and github-actions ecosystems', () => {
    const ecosystems = readEntries().map((entry) => entry.ecosystem);
    expect(ecosystems).toContain('npm');
    expect(ecosystems).toContain('github-actions');
  });

  it('declares the docker ecosystem with a weekly schedule', () => {
    const text = readFileSync(path.join(root, '.github/dependabot.yml'), 'utf8');
    const block = text.split(/^ {2}- package-ecosystem:/m).find((b) => /^\s*docker\b/.test(b));
    expect(block).toBeDefined();
    expect(block).toMatch(/interval:\s*weekly/);
  });

  it('covers with the docker ecosystem each directory holding a Dockerfile or compose file with a pinned digest', () => {
    const directories = [...new Set(readablePins.map((pin) => path.posix.dirname(pin.file)))];
    expect(directories.length).toBeGreaterThan(0);
    for (const dir of directories) {
      const absolute = dir === '.' ? '/' : `/${dir}`;
      expect({ dir: absolute, covered: dockerCovers(absolute) }).toEqual({
        dir: absolute,
        covered: true,
      });
    }
  });

  it('fails for a digest pinned only where no entry reads it', () => {
    const readable = new Set(
      readablePins
        .filter((pin) => {
          const dir = path.posix.dirname(pin.file);
          return dockerCovers(dir === '.' ? '/' : `/${dir}`);
        })
        .map((pin) => digestOf(pin.image)),
    );
    const unread = [
      ...new Set(pins.filter((pin) => !readable.has(digestOf(pin.image))).map((pin) => pin.image)),
    ];
    expect(unread).toEqual([]);
  });

  it('references the file Dependabot reads from scripts/ci/dast.sh when the pin moved out of the script', () => {
    const script = readFileSync(path.join(root, 'scripts/ci/dast.sh'), 'utf8');
    const inScript = script.match(DIGEST) ?? [];
    if (inScript.length === 0) {
      const moved = readablePins.filter((pin) => pin.file.startsWith('scripts/ci/'));
      expect(moved.length).toBeGreaterThan(0);
      expect(moved.some((pin) => script.includes(path.posix.basename(pin.file)))).toBe(true);
    }
  });
});

/**
 * `003` task 2.2 (design D3, Resolved decision Q43): Dependabot waits 14 days
 * before it proposes a release, and it never bumps Playwright, which moves only
 * together with the sandbox browser (`/opt/pw-browsers`).
 *
 * The cooldown uses Dependabot's documented `cooldown` keys: `default-days`
 * (required here) and the optional `semver-major-days`, `semver-minor-days` and
 * `semver-patch-days`, each of which overrides `default-days` for its update
 * type, so each one present must also be at least 14. `include` and `exclude`
 * would narrow the cooldown to some dependencies, so neither may appear.
 */
const MIN_COOLDOWN_DAYS = 14;

const COOLDOWN_DAY_KEYS = [
  'default-days',
  'semver-major-days',
  'semver-minor-days',
  'semver-patch-days',
] as const;

function unquote(value: string): string {
  return value
    .replace(/\s+#.*$/, '')
    .trim()
    .replace(/^(['"])(.*)\1$/, '$2');
}

/** The text of each `package-ecosystem` entry, keyed by ecosystem. */
function readBlocks(): Map<string, string> {
  const text = readFileSync(path.join(root, '.github/dependabot.yml'), 'utf8');
  const blocks = new Map<string, string>();
  for (const block of text.split(/^ {2}- package-ecosystem:/m).slice(1)) {
    const ecosystem = /^\s*['"]?([\w-]+)/.exec(block)?.[1] ?? '';
    blocks.set(ecosystem, block);
  }
  return blocks;
}

/**
 * The lines nested under `key:` at entry level (four spaces), up to the next
 * line indented four spaces or less. Blank and comment-only lines are dropped.
 * Returns `undefined` when the key is missing.
 */
function section(block: string, key: string): string[] | undefined {
  const lines = block.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^ {4}${key}:\\s*(#.*)?$`).test(line));
  if (start === -1) return undefined;
  const nested: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (!/^ {5}/.test(line)) break;
    nested.push(line);
  }
  return nested;
}

function readCooldown(block: string): Map<string, string> | undefined {
  const lines = section(block, 'cooldown');
  if (lines === undefined) return undefined;
  const cooldown = new Map<string, string>();
  for (const line of lines) {
    const match = /^ {6}([\w-]+):\s*(.*)$/.exec(line);
    if (match?.[1] !== undefined) cooldown.set(match[1], unquote(match[2] ?? ''));
  }
  return cooldown;
}

interface IgnoreRule {
  dependency: string;
  /** Keys other than `dependency-name` (`update-types`, `versions`), which narrow the rule. */
  narrowedBy: string[];
}

function readIgnores(block: string): IgnoreRule[] {
  const lines = section(block, 'ignore') ?? [];
  const rules: IgnoreRule[] = [];
  for (const line of lines) {
    const item = /^ {6}- ([\w-]+):\s*(.*)$/.exec(line);
    if (item?.[1] !== undefined) {
      rules.push({ dependency: '', narrowedBy: [] });
    }
    const current = rules.at(-1);
    const keyed = item ?? /^ {8}([\w-]+):\s*(.*)$/.exec(line);
    if (current === undefined || keyed?.[1] === undefined) continue;
    if (keyed[1] === 'dependency-name') current.dependency = unquote(keyed[2] ?? '');
    else current.narrowedBy.push(keyed[1]);
  }
  return rules;
}

function listUnder(block: string, key: string, indent: number): string[] {
  const lines = section(block, key) ?? [];
  const pad = ' '.repeat(indent);
  return lines
    .map((line) => new RegExp(`^${pad}- (.*)$`).exec(line)?.[1])
    .filter((item): item is string => item !== undefined)
    .map(unquote);
}

describe('Dependabot cooldown and Playwright ignore (003 task 2.2, Q43)', () => {
  it('gives the npm entry a cooldown of at least 14 days', () => {
    const npm = readBlocks().get('npm');
    expect(npm).toBeDefined();
    const cooldown = readCooldown(npm ?? '');
    expect(cooldown).toBeDefined();
    expect(cooldown?.has('default-days')).toBe(true);
    for (const key of COOLDOWN_DAY_KEYS) {
      const value = cooldown?.get(key);
      if (value === undefined) continue;
      expect({ key, value, integer: /^\d+$/.test(value) }).toEqual({ key, value, integer: true });
      expect({ key, atLeast14: Number(value) >= MIN_COOLDOWN_DAYS }).toEqual({
        key,
        atLeast14: true,
      });
    }
    expect(cooldown?.has('include')).toBe(false);
    expect(cooldown?.has('exclude')).toBe(false);
  });

  it('gives every package ecosystem entry a cooldown of at least 14 days', () => {
    const blocks = readBlocks();
    expect([...blocks.keys()]).toEqual(expect.arrayContaining(['npm', 'github-actions', 'docker']));
    for (const [ecosystem, block] of blocks) {
      const cooldown = readCooldown(block);
      expect({ ecosystem, hasCooldown: cooldown !== undefined }).toEqual({
        ecosystem,
        hasCooldown: true,
      });
      const defaultDays = cooldown?.get('default-days');
      expect({ ecosystem, defaultDaysInteger: /^\d+$/.test(defaultDays ?? '') }).toEqual({
        ecosystem,
        defaultDaysInteger: true,
      });
      for (const key of COOLDOWN_DAY_KEYS) {
        const value = cooldown?.get(key);
        if (value === undefined) continue;
        expect({
          ecosystem,
          key,
          value,
          integer: /^\d+$/.test(value),
          atLeast14: Number(value) >= MIN_COOLDOWN_DAYS,
        }).toEqual({ ecosystem, key, value, integer: true, atLeast14: true });
      }
      expect({ ecosystem, include: cooldown?.has('include') ?? false }).toEqual({
        ecosystem,
        include: false,
      });
      expect({ ecosystem, exclude: cooldown?.has('exclude') ?? false }).toEqual({
        ecosystem,
        exclude: false,
      });
    }
  });

  it('ignores every update of @playwright/test and playwright-core in the npm entry', () => {
    const ignores = readIgnores(readBlocks().get('npm') ?? '');
    for (const dependency of ['@playwright/test', 'playwright-core']) {
      const rule = ignores.find((r) => r.dependency === dependency);
      expect({ dependency, ignored: rule !== undefined }).toEqual({ dependency, ignored: true });
      // No `update-types` or `versions`: the package is never bumped by Dependabot.
      expect({ dependency, narrowedBy: rule?.narrowedBy }).toEqual({
        dependency,
        narrowedBy: [],
      });
    }
  });

  it('keeps the @types/node major-version ignore', () => {
    const npm = readBlocks().get('npm') ?? '';
    const rule = readIgnores(npm).find((r) => r.dependency === '@types/node');
    expect(rule).toBeDefined();
    expect(npm).toMatch(
      /dependency-name:\s*['"]?@types\/node['"]?\s*\n\s+update-types:\s*\n\s+- ['"]?version-update:semver-major/,
    );
  });

  it('keeps the existing groups, directories and weekly schedules', () => {
    const blocks = readBlocks();
    const npm = blocks.get('npm') ?? '';
    expect(npm).toMatch(/^ {4}directory:\s*['"]?\/['"]?\s*$/m);
    expect(npm).toMatch(/^ {4}schedule:\s*\n {6}interval:\s*weekly\b/m);
    expect(section(npm, 'groups')?.some((line) => /^ {6}minor-and-patch:/.test(line))).toBe(true);
    const groupTypes = (section(npm, 'groups') ?? [])
      .map((line) => /^ {10}- (.*)$/.exec(line)?.[1])
      .filter((item): item is string => item !== undefined)
      .map(unquote);
    expect(groupTypes).toEqual(expect.arrayContaining(['minor', 'patch']));

    const actions = blocks.get('github-actions') ?? '';
    expect(actions).toMatch(/^ {4}directory:\s*['"]?\/['"]?\s*$/m);
    expect(actions).toMatch(/^ {4}schedule:\s*\n {6}interval:\s*weekly\b/m);

    const docker = blocks.get('docker') ?? '';
    expect(listUnder(docker, 'directories', 6)).toEqual(
      expect.arrayContaining(['/', '/scripts/ci']),
    );
    expect(docker).toMatch(/^ {4}schedule:\s*\n {6}interval:\s*weekly\b/m);
  });
});
