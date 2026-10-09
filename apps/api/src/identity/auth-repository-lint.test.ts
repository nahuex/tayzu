import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

/**
 * `043` task 5.1c (design D14, Resolved decision Q69): a lint rule bans direct,
 * model-keyed adapter access to `apikey`, `invitation`, `member`, `session`, `user`
 * and `account` from `apps/api/src/identity/**` and `apps/api/src/identity-router.ts`,
 * outside `auth-repository.ts`; it also bans the internal adapter's `findAccount…`
 * reads and the import of the adapter factory there, and keeps the existing
 * `sql.raw` and `actor.type` bans firing on the same paths.
 *
 * The scratch sources are linted with `ESLint#lintText` over the repository's flat
 * config (which imports the restriction module `eslint/identity-restrictions.js`).
 * The restrictions under test are not typed rules, so the typed rules and the
 * project service are turned off for the scratch files (they do not exist on disk).
 */

const ROOT = resolve(import.meta.dirname, '../../../..');
const IDENTITY_DIR = 'apps/api/src/identity';

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

const CREDENTIALS = `${IDENTITY_DIR}/credentials.ts`;
const ROUTER = 'apps/api/src/identity-router.ts';
const REPOSITORY = `${IDENTITY_DIR}/auth-repository.ts`;

const MODELS = ['apikey', 'invitation', 'member', 'session', 'user', 'account'] as const;

const readOf = (model: string): string => `
export async function read(ctx: { adapter: { findOne(a: unknown): Promise<unknown> } }) {
  return ctx.adapter.findOne({ model: '${model}', where: [{ field: 'id', value: 'x' }] });
}
`;

describe('adapter access lint rule (5.1c)', () => {
  it('the restriction module exists at eslint/identity-restrictions.js', () => {
    expect(existsSync(resolve(ROOT, 'eslint/identity-restrictions.js'))).toBe(true);
  });

  it.each(MODELS)('a direct %s read in credentials.ts fails', async (model) => {
    const messages = await lint(CREDENTIALS, readOf(model));
    expect(messages.length).toBeGreaterThan(0);
  });

  it('a direct member read in identity-router.ts fails (awaited call chain, findMany)', async () => {
    const code = `
export async function authorizeTarget(authContext: () => Promise<{ adapter: { findMany(a: unknown): Promise<unknown[]> } }>) {
  return (await authContext()).adapter.findMany({
    model: 'member',
    where: [{ field: 'userId', value: 'u' }],
  });
}
`;
    const messages = await lint(ROUTER, code);
    expect(messages.length).toBeGreaterThan(0);
  });

  it('a write on a restricted model (create, update, delete) fails', async () => {
    for (const method of ['create', 'update', 'delete', 'deleteMany', 'count']) {
      const code = `
export async function write(ctx: { adapter: Record<string, (a: unknown) => Promise<unknown>> }) {
  return ctx.adapter.${method}({ model: 'session', where: [{ field: 'id', value: 'x' }] });
}
`;
      const messages = await lint(`${IDENTITY_DIR}/invitations.ts`, code);
      expect(messages.length, method).toBeGreaterThan(0);
    }
  });

  it('the same read inside auth-repository.ts passes', async () => {
    expect(await lint(REPOSITORY, readOf('member'))).toEqual([]);
    expect(await lint(REPOSITORY, readOf('apikey'))).toEqual([]);
  });

  it('a read of another model passes', async () => {
    expect(await lint(CREDENTIALS, readOf('organization'))).toEqual([]);
    expect(await lint(ROUTER, readOf('verification'))).toEqual([]);
  });

  it('internal-adapter deleteUserSessions and updateUser calls pass', async () => {
    const code = `
export async function f(internal: {
  deleteUserSessions(id: string): Promise<void>;
  updateUser(id: string, data: unknown): Promise<unknown>;
}) {
  await internal.deleteUserSessions('u');
  await internal.updateUser('u', { banned: true });
}
`;
    expect(await lint(ROUTER, code)).toEqual([]);
    expect(await lint(CREDENTIALS, code)).toEqual([]);
  });

  it('internal-adapter findAccountByKey and findAccounts in identity-router.ts fail', async () => {
    const byKey = `
export async function f(internal: { findAccountByKey(k: unknown): Promise<unknown> }) {
  return internal.findAccountByKey({ providerId: 'p', accountId: 'a' });
}
`;
    const many = `
export async function f(internal: { findAccounts(id: string): Promise<unknown[]> }) {
  return internal.findAccounts('u');
}
`;
    expect((await lint(ROUTER, byKey)).length).toBeGreaterThan(0);
    expect((await lint(ROUTER, many)).length).toBeGreaterThan(0);
  });

  it('findAccountByKey and findAccounts also fail through an awaited context chain', async () => {
    const code = `
export async function f(authContext: () => Promise<{ internalAdapter: { findAccounts(id: string): Promise<unknown[]> } }>) {
  return (await authContext()).internalAdapter.findAccounts('u');
}
`;
    expect((await lint(ROUTER, code)).length).toBeGreaterThan(0);
  });

  it('findAccountByKey and findAccounts inside auth-repository.ts pass', async () => {
    const code = `
export async function f(internal: {
  findAccountByKey(k: unknown): Promise<unknown>;
  findAccounts(id: string): Promise<unknown[]>;
}) {
  await internal.findAccountByKey({ providerId: 'p', accountId: 'a' });
  return internal.findAccounts('u');
}
`;
    expect(await lint(REPOSITORY, code)).toEqual([]);
  });

  it('importing the adapter factory in the scoped paths fails', async () => {
    const code = `
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
export const factory = drizzleAdapter;
`;
    expect((await lint(CREDENTIALS, code)).length).toBeGreaterThan(0);
    expect((await lint(ROUTER, code)).length).toBeGreaterThan(0);
  });

  it('the sql.raw ban still fires on a scratch source inside the scoped paths', async () => {
    const code = `
import { sql } from 'drizzle-orm';
export const q = sql.raw('select 1');
`;
    for (const path of [CREDENTIALS, ROUTER, REPOSITORY]) {
      const messages = await lint(path, code);
      expect(
        messages.some((m) => m.includes('sql.raw is banned')),
        path,
      ).toBe(true);
    }
  });

  it('the actor.type ban still fires on a scratch source inside the scoped paths', async () => {
    const code = `
export function f(actor: { type: string }) {
  return actor.type === 'user';
}
`;
    for (const path of [CREDENTIALS, ROUTER, REPOSITORY]) {
      const messages = await lint(path, code);
      expect(
        messages.some((m) => m.includes('Actor type must not select a code path')),
        path,
      ).toBe(true);
    }
  });

  it('the rule does not apply outside the scoped paths', async () => {
    expect(await lint('apps/api/src/server.ts', readOf('member'))).toEqual([]);
    expect(await lint('apps/api/scripts/backfill.ts', readOf('member'))).toEqual([]);
  });

  it('the real scoped tree lints clean under the real config', async () => {
    const real = new ESLint({ cwd: ROOT });
    const results = await real.lintFiles([
      'apps/api/src/identity/**/*.ts',
      'apps/api/src/identity-router.ts',
    ]);
    const restricted = results.flatMap((r) =>
      r.messages
        .filter((m) => m.ruleId === 'no-restricted-syntax' || m.ruleId === 'no-restricted-imports')
        .map((m) => `${r.filePath}:${String(m.line)} ${m.message}`),
    );
    expect(restricted).toEqual([]);
  }, 120_000);
});
