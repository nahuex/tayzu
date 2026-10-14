import { resolve } from 'node:path';

import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

/**
 * `043` task 9.1c (design D8, Resolved decision Q78): the machine-credential
 * functions are importable only from `apps/api/src/identity/**` (test files are
 * exempt), through the subpath `@tayzu/auth/machine-credentials` or a relative path
 * to the file. The rule lives in the restriction module of 5.1c
 * (`eslint/identity-restrictions.js`), which merges it with the 5.1c restrictions for
 * `identity-router.ts`, a file both match.
 *
 * Scratch sources are linted with `ESLint#lintText` over the repository's flat
 * config; typed rules and the project service are turned off for them (they do not
 * exist on disk), exactly as in `auth-repository-lint.test.ts`.
 */

const ROOT = resolve(import.meta.dirname, '../../../..');

const eslint = new ESLint({
  cwd: ROOT,
  overrideConfigFile: resolve(ROOT, 'eslint.config.js'),
  overrideConfig: [
    tseslint.configs.disableTypeChecked,
    { languageOptions: { parserOptions: { projectService: false } } },
  ],
});

async function lint(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: resolve(ROOT, filePath) });
  if (result === undefined) throw new Error('no lint result');
  return result.messages
    .filter((m) => m.ruleId === 'no-restricted-syntax' || m.ruleId === 'no-restricted-imports')
    .map((m) => `${m.ruleId ?? ''}: ${m.message}`);
}

const SUBPATH_IMPORT = `
import { createMachineCredential } from '@tayzu/auth/machine-credentials';
export const f = createMachineCredential;
`;
const RELATIVE_IMPORT = `
import { revokeMachineCredential } from '../../../packages/auth/src/machine-credentials.js';
export const f = revokeMachineCredential;
`;
const TYPE_ONLY_IMPORT = `
import type { CreatedMachineCredential } from '@tayzu/auth/machine-credentials';
export type T = CreatedMachineCredential;
`;
const FACTORY_IMPORT = `
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
export const factory = drizzleAdapter;
`;
const MEMBER_READ = `
export async function read(ctx: { adapter: { findOne(a: unknown): Promise<unknown> } }) {
  return ctx.adapter.findOne({ model: 'member', where: [{ field: 'id', value: 'x' }] });
}
`;

describe('machine-credential import lint rule (9.1c)', () => {
  it('an import of the subpath from apps/api/src/server.ts fails', async () => {
    const messages = await lint('apps/api/src/server.ts', SUBPATH_IMPORT);
    expect(messages.some((m) => m.startsWith('no-restricted-imports'))).toBe(true);
  });

  it('a type-only import of the subpath from apps/api/src/server.ts fails', async () => {
    const messages = await lint('apps/api/src/server.ts', TYPE_ONLY_IMPORT);
    expect(messages.some((m) => m.startsWith('no-restricted-imports'))).toBe(true);
  });

  it('a relative import of the file from apps/api/src/server.ts fails', async () => {
    const messages = await lint('apps/api/src/server.ts', RELATIVE_IMPORT);
    expect(messages.some((m) => m.startsWith('no-restricted-imports'))).toBe(true);
  });

  it('an import from apps/api/src/identity/credentials.ts passes', async () => {
    expect(await lint('apps/api/src/identity/credentials.ts', SUBPATH_IMPORT)).toEqual([]);
    expect(await lint('apps/api/src/identity/service-accounts.ts', SUBPATH_IMPORT)).toEqual([]);
  });

  it('an import from a test file passes', async () => {
    for (const path of [
      'apps/api/src/bootstrap-wiring.int.test.ts',
      'apps/api/src/otel-smoke-check.int.test.ts',
      'apps/api/src/identity/credentials.int.test.ts',
    ]) {
      expect(await lint(path, SUBPATH_IMPORT), path).toEqual([]);
      expect(await lint(path, RELATIVE_IMPORT), path).toEqual([]);
    }
  });

  it('identity-router.ts gets both the machine-credential restriction and the adapter restriction', async () => {
    const router = 'apps/api/src/identity-router.ts';

    // Each restriction fails alone.
    expect(
      (await lint(router, SUBPATH_IMPORT)).some((m) => m.startsWith('no-restricted-imports')),
    ).toBe(true);
    expect((await lint(router, RELATIVE_IMPORT)).length).toBeGreaterThan(0);
    expect(
      (await lint(router, MEMBER_READ)).some((m) => m.startsWith('no-restricted-syntax')),
    ).toBe(true);

    // Merged, not replaced: one source with both imports yields two distinct import
    // messages, the adapter-factory one and the machine-credential one.
    const both = await lint(router, `${FACTORY_IMPORT}${SUBPATH_IMPORT}`);
    const importMessages = both.filter((m) => m.startsWith('no-restricted-imports'));
    expect(importMessages.length).toBeGreaterThanOrEqual(2);
    expect(new Set(importMessages).size).toBeGreaterThanOrEqual(2);
    expect(importMessages.some((m) => m.includes('adapter factory'))).toBe(true);
    expect(importMessages.some((m) => !m.includes('adapter factory'))).toBe(true);
  });

  it('the adapter restriction still applies to other identity files beside the new rule', async () => {
    const path = 'apps/api/src/identity/credentials.ts';
    expect(
      (await lint(path, FACTORY_IMPORT)).some((m) => m.startsWith('no-restricted-imports')),
    ).toBe(true);
  });

  it('pnpm lint stays green on the real tree: no restricted import or syntax message', async () => {
    const real = new ESLint({ cwd: ROOT });
    const results = await real.lintFiles(['apps/api/**/*.ts', 'packages/auth/**/*.ts']);
    const restricted = results.flatMap((r) =>
      r.messages
        .filter((m) => m.ruleId === 'no-restricted-syntax' || m.ruleId === 'no-restricted-imports')
        .map((m) => `${r.filePath}:${String(m.line)} ${m.message}`),
    );
    expect(restricted).toEqual([]);
  }, 180_000);
});
