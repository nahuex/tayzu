import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/**
 * `003` task 2.3 (design D2, Resolved decision Q40): the `apps/web/**` ESLint block
 * adds `eslint-plugin-react-hooks` and `eslint-plugin-jsx-a11y` (whose rules must fire
 * on ESLint 10), `no-console`, the web `no-restricted-syntax` selectors (re-spreading
 * the `sql.raw` and actor-type ones) and the `no-restricted-imports` entry that allows
 * only `@tayzu/catalog/contract` from the workspace. The test-file override covers
 * `*.test.tsx`.
 *
 * Fixture sources are linted with `ESLint#lintText` over the repository's real flat
 * config, with type information on: the test-file override turns off typed rules
 * (`@typescript-eslint/require-await`), so the typed rules must run to prove it.
 * typescript-eslint's `projectService` rejects a path no tsconfig includes, so every
 * fixture borrows the path of a file that exists on disk and that
 * `apps/web/tsconfig.app.json` includes (`src/`): `app.tsx` for production code and
 * `smoke.test.tsx` for a test file. `lintText` hands the fixture text to the project
 * service, which lints it in place of the file's content; the files on disk are never
 * read or written. Borrowing real paths, rather than inventing new ones, keeps the
 * test independent of `allowDefaultProject` and of files later tasks add.
 */

const ROOT = resolve(import.meta.dirname, '../../..');
const CONFIG_FILE = resolve(ROOT, 'eslint.config.js');

const WEB_SOURCE = 'apps/web/src/app.tsx';
const WEB_TEST = 'apps/web/src/smoke.test.tsx';

const eslint = new ESLint({ cwd: ROOT, overrideConfigFile: CONFIG_FILE });

interface Report {
  ruleId: string | null;
  message: string;
}

async function lint(filePath: string, code: string): Promise<Report[]> {
  const [result] = await eslint.lintText(code, { filePath: resolve(ROOT, filePath) });
  if (result === undefined) throw new Error('no lint result');
  // A fatal message is a parse or configuration error: the fixture is broken.
  expect(result.messages.filter((m) => m.fatal === true)).toEqual([]);
  return result.messages.map((m) => ({ ruleId: m.ruleId, message: m.message }));
}

function ruleIds(reports: Report[]): (string | null)[] {
  return reports.map((r) => r.ruleId);
}

// Messages given by `eslint.config.js` to each selector.
const SQL_RAW_MESSAGE =
  'sql.raw is banned: it bypasses parameterization. Use the sql template tag with bind parameters.';
const ACTOR_TYPE_MESSAGE =
  'Actor type must not select a code path (design D3). Only packages/catalog/src/domain/reserved.ts and packages/catalog/src/service/pipeline.ts may compare it.';
const WEB_HTML_SINK_MESSAGE =
  'Raw HTML sinks are banned in the web app (003 D15): render server strings as React text or through a renderer in src/lib/.';
const WEB_COOKIE_MESSAGE =
  'document.cookie is banned in the web app (003 D15): the session cookie is HttpOnly and owned by the server.';
const WEB_EVAL_MESSAGE =
  'Dynamic code evaluation is banned in the web app (003 D15): the CSP forbids it.';
const WEB_IMPORT_MESSAGE =
  'The web app may import only @tayzu/catalog/contract from the workspace (003 D2): never @tayzu/api, @tayzu/auth, @tayzu/db, @tayzu/authz or any other @tayzu/catalog path.';

const SQL_DECL = `declare const sql: { raw(s: string): unknown };
declare const db: { sql: { raw(s: string): unknown } };
`;
const ACTOR_DECL = `declare const actor: { type: string };
declare const ctx: { principal?: { type: string }; onBehalfOf?: { type: string } };
`;

const SYNTAX_CASES: { name: string; code: string; message: string }[] = [
  {
    name: 'the dangerouslySetInnerHTML attribute',
    code: `export function Raw(): React.JSX.Element {
  return <div dangerouslySetInnerHTML={{ __html: '<b>x</b>' }} />;
}
`,
    message: WEB_HTML_SINK_MESSAGE,
  },
  {
    name: 'document.cookie',
    code: `export const cookie = document.cookie;\n`,
    message: WEB_COOKIE_MESSAGE,
  },
  {
    name: "document['cookie']",
    code: `export const cookie: unknown = document['cookie'];\n`,
    message: WEB_COOKIE_MESSAGE,
  },
  {
    name: 'eval',
    code: `export const value: unknown = eval('1 + 1');\n`,
    message: WEB_EVAL_MESSAGE,
  },
  {
    name: 'new Function',
    code: `export const fn = new Function('return 1');\n`,
    message: WEB_EVAL_MESSAGE,
  },
  {
    name: 'a Function call',
    code: `export const fn = Function('return 1');\n`,
    message: WEB_EVAL_MESSAGE,
  },
  {
    name: 'document.write',
    code: `export function w(): void {\n  document.write('<p>x</p>');\n}\n`,
    message: WEB_HTML_SINK_MESSAGE,
  },
  {
    name: 'document.writeln',
    code: `export function w(): void {\n  document.writeln('<p>x</p>');\n}\n`,
    message: WEB_HTML_SINK_MESSAGE,
  },
  {
    name: 'an innerHTML assignment',
    code: `export function set(el: HTMLElement): void {\n  el.innerHTML = '<p>x</p>';\n}\n`,
    message: WEB_HTML_SINK_MESSAGE,
  },
  {
    name: 'an outerHTML assignment',
    code: `export function set(el: HTMLElement): void {\n  el.outerHTML = '<p>x</p>';\n}\n`,
    message: WEB_HTML_SINK_MESSAGE,
  },
  {
    name: "an el['innerHTML'] assignment",
    code: `export function set(el: HTMLElement): void {\n  el['innerHTML'] = '<p>x</p>';\n}\n`,
    message: WEB_HTML_SINK_MESSAGE,
  },
  {
    name: "an el['outerHTML'] assignment",
    code: `export function set(el: HTMLElement): void {\n  el['outerHTML'] = '<p>x</p>';\n}\n`,
    message: WEB_HTML_SINK_MESSAGE,
  },
  {
    name: 'sql.raw',
    code: `${SQL_DECL}export const q = sql.raw('select 1');\n`,
    message: SQL_RAW_MESSAGE,
  },
  {
    name: "sql['raw']",
    code: `${SQL_DECL}export const q = sql['raw']('select 1');\n`,
    message: SQL_RAW_MESSAGE,
  },
  {
    name: 'db.sql.raw',
    code: `${SQL_DECL}export const q = db.sql.raw('select 1');\n`,
    message: SQL_RAW_MESSAGE,
  },
  {
    name: 'destructuring raw from sql',
    code: `${SQL_DECL}export const { raw } = sql;\n`,
    message: SQL_RAW_MESSAGE,
  },
  {
    name: 'an actor.type comparison',
    code: `${ACTOR_DECL}export const isUser = actor.type === 'user';\n`,
    message: ACTOR_TYPE_MESSAGE,
  },
  {
    name: 'an optional-chain principal?.type comparison',
    code: `${ACTOR_DECL}export const isUser = ctx.principal?.type !== 'user';\n`,
    message: ACTOR_TYPE_MESSAGE,
  },
  {
    name: 'a switch on actor.type',
    code: `${ACTOR_DECL}export function pick(): number {
  switch (actor.type) {
    case 'user':
      return 1;
    default:
      return 0;
  }
}
`,
    message: ACTOR_TYPE_MESSAGE,
  },
  {
    name: 'a switch on onBehalfOf?.type',
    code: `${ACTOR_DECL}export function pick(): number {
  switch (ctx.onBehalfOf?.type) {
    case 'user':
      return 1;
    default:
      return 0;
  }
}
`,
    message: ACTOR_TYPE_MESSAGE,
  },
  {
    name: 'a membership call on actor.type',
    code: `${ACTOR_DECL}export const isHuman = ['user'].includes(actor.type);\n`,
    message: ACTOR_TYPE_MESSAGE,
  },
];

const RESTRICTED_IMPORTS = [
  '@tayzu/api',
  '@tayzu/auth',
  '@tayzu/db',
  '@tayzu/authz',
  '@tayzu/catalog',
  '@tayzu/catalog/contract/internal',
];

const importOf = (specifier: string): string =>
  `import { thing } from '${specifier}';\nexport const value: unknown = thing;\n`;

const ASYNC_WITHOUT_AWAIT = `export async function load(): Promise<number> {\n  return 1;\n}\n`;

describe('web lint rules (003 task 2.3)', () => {
  it('borrows fixture paths that exist and that tsconfig.app.json includes', () => {
    expect(existsSync(resolve(ROOT, WEB_SOURCE))).toBe(true);
    expect(existsSync(resolve(ROOT, WEB_TEST))).toBe(true);
  });

  it('a jsx-a11y rule reports: jsx-a11y/alt-text on an img without alt', async () => {
    const reports = await lint(
      WEB_SOURCE,
      `export function Logo(): React.JSX.Element {\n  return <img src="/logo.png" />;\n}\n`,
    );
    expect(ruleIds(reports)).toContain('jsx-a11y/alt-text');
  });

  it('a react-hooks rule reports: react-hooks/rules-of-hooks on a conditional hook call', async () => {
    const reports = await lint(
      WEB_SOURCE,
      `import { useState } from 'react';

export function useCount(enabled: boolean): number {
  if (enabled) {
    const [count] = useState(0);
    return count;
  }
  return 0;
}
`,
    );
    expect(ruleIds(reports)).toContain('react-hooks/rules-of-hooks');
  });

  it('no-console reports', async () => {
    const reports = await lint(
      WEB_SOURCE,
      `export function log(): void {\n  console.log('hello');\n}\n`,
    );
    expect(ruleIds(reports)).toContain('no-console');
  });

  it.each(SYNTAX_CASES)('no-restricted-syntax reports $name', async ({ code, message }) => {
    const reports = await lint(WEB_SOURCE, code);
    expect(reports).toContainEqual({ ruleId: 'no-restricted-syntax', message });
  });

  it.each(RESTRICTED_IMPORTS)(
    'no-restricted-imports reports an import of %s',
    async (specifier) => {
      const reports = await lint(WEB_SOURCE, importOf(specifier));
      const imports = reports.filter((r) => r.ruleId === 'no-restricted-imports');
      expect(imports).toHaveLength(1);
      expect(imports[0]?.message).toContain(specifier);
      expect(imports[0]?.message).toContain(WEB_IMPORT_MESSAGE);
    },
  );

  it('no-restricted-imports reports a type-only import of @tayzu/api', async () => {
    const reports = await lint(
      WEB_SOURCE,
      `import type { Thing } from '@tayzu/api';\nexport type Value = Thing;\n`,
    );
    expect(ruleIds(reports)).toContain('no-restricted-imports');
  });

  it('an import of @tayzu/catalog/contract does not report', async () => {
    const reports = await lint(WEB_SOURCE, importOf('@tayzu/catalog/contract'));
    expect(ruleIds(reports)).not.toContain('no-restricted-imports');
  });

  it('a *.test.tsx file gets the test override: require-await is off there and on in a non-test file', async () => {
    const source = await lint(WEB_SOURCE, ASYNC_WITHOUT_AWAIT);
    expect(ruleIds(source)).toContain('@typescript-eslint/require-await');

    const test = await lint(WEB_TEST, ASYNC_WITHOUT_AWAIT);
    expect(ruleIds(test)).not.toContain('@typescript-eslint/require-await');
  });
});
