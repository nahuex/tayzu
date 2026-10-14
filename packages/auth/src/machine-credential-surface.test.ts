import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * `043` task 13.1 (Resolved decision Q78, task 9.1c): `createMachineCredential` and
 * `revokeMachineCredential` are reachable only through `identity.credentials.*` and
 * `identity.serviceAccounts.*`. They are exported only on the subpath
 * `@tayzu/auth/machine-credentials`, never from the `@tayzu/auth` index, and no file
 * outside `apps/api/src/identity/**` (and tests) uses them.
 */

const ROOT = resolve(import.meta.dirname, '../../..');
const FUNCTION_NAMES = ['createMachineCredential', 'revokeMachineCredential'] as const;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function isTestFile(path: string): boolean {
  return (
    /\.test\.[cm]?[tj]sx?$/.test(path) ||
    path.split(sep).includes('__fixtures__') ||
    path.split(sep).includes('__tests__')
  );
}

/** Code lines only: comment lines are dropped so prose mentions are not callers. */
function codeOf(path: string): string {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => {
      const t = line.trimStart();
      return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'));
    })
    .join('\n');
}

describe('machine-credential surface (13.1)', () => {
  it('createMachineCredential and revokeMachineCredential are not exported from the @tayzu/auth index', async () => {
    const index = (await import('./index.js')) as Record<string, unknown>;
    for (const name of FUNCTION_NAMES) {
      expect(Object.keys(index), name).not.toContain(name);
      expect(index[name], name).toBeUndefined();
    }
    const source = codeOf(resolve(import.meta.dirname, 'index.ts'));
    expect(source).not.toMatch(/machine-credentials/);
  });

  it('both functions are exported from the subpath @tayzu/auth/machine-credentials', async () => {
    const pkg = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'),
    ) as { exports: Record<string, string> };
    expect(pkg.exports['./machine-credentials']).toBe('./src/machine-credentials.ts');

    const subpath = (await import('@tayzu/auth/machine-credentials')) as Record<string, unknown>;
    for (const name of FUNCTION_NAMES) {
      expect(typeof subpath[name], name).toBe('function');
    }
  });

  it('no file outside apps/api/src/identity/** and the tests calls or imports them', () => {
    const identityDir = resolve(ROOT, 'apps/api/src/identity') + sep;
    const own = resolve(ROOT, 'packages/auth/src/machine-credentials.ts');
    const offenders: string[] = [];
    for (const top of ['apps', 'packages']) {
      for (const file of sourceFiles(resolve(ROOT, top))) {
        if (file === own || isTestFile(file) || file.startsWith(identityDir)) continue;
        const code = codeOf(file);
        const usesFunction = FUNCTION_NAMES.some((name) => new RegExp(`\\b${name}\\b`).test(code));
        const importsValue =
          /import\s+(?!type\b)[^;]*from\s+['"][^'"]*machine-credentials(\.js)?['"]/.test(code);
        if (usesFunction || importsValue) offenders.push(relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
