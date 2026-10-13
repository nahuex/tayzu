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
    expect(images.some((i) => i.startsWith('postgres:16@sha256:'))).toBe(true);
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
