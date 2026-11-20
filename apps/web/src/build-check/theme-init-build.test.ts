// @vitest-environment node
/**
 * The emitted `theme-init.js` (task 5.6, design D12, D10, Q28, Q46 and Q61).
 *
 * Q46: "`theme-init.js` ships with no comment: its commented source lives under `src/`,
 * and a small plugin in `vite.config.ts` minifies it with Vite's own transform and emits
 * it unhashed at the build root (still a classic external script under `script-src
 * 'self'` and a root build file of Q28 with `no-cache`)." Q61 left `public/theme-init.js`
 * as an empty placeholder until this task.
 *
 * Assumed API of `../../vite.config.js` (`apps/web/vite.config.ts`):
 *
 * ```ts
 * import type { Plugin } from 'vite';
 *
 * // Named `tayzu:theme-init`. In a build it reads `src/state/theme-init.js`, resolved
 * // from `vite.config.ts` itself (never from the build `root`), minifies it with Vite's
 * // own API (no new dependency), and emits the result as the asset `theme-init.js` at
 * // the build root: no hash, no directory, no comment, still a classic script.
 * export function themeInitPlugin(): Plugin;
 *
 * // The default export stays the `defineConfig` function, and its `plugins` include
 * // `themeInitPlugin()` for a build.
 * ```
 *
 * The test runs a real Vite build with `write: false` over a throwaway root (a minimal
 * `index.html` and one module), with only this plugin, and inspects the output in memory:
 * no `dist/` and no earlier build are needed. The minified file is then run in a Node `vm`
 * context with a minimal browser stand-in (`window`, `localStorage`, `matchMedia` and
 * `document.documentElement.classList` / `className`), so the shipped bytes are checked
 * to behave like the source that `src/state/theme.test.tsx` evaluates in jsdom.
 */
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

import { build, type ConfigEnv, type Plugin, type PluginOption, type UserConfig } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import viteConfig, { themeInitPlugin } from '../../vite.config.js';

const WEB_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SOURCE_PATH = join(WEB_ROOT, 'src/state/theme-init.js');
const PUBLIC_PLACEHOLDER = join(WEB_ROOT, 'public/theme-init.js');
const INDEX_HTML = join(WEB_ROOT, 'index.html');

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** One file of the build output, as Vite returns it with `write: false`. */
interface OutputFile {
  fileName: string;
  type: 'asset' | 'chunk';
  text: string;
}

let buildRoot: string;
let outputs: OutputFile[];

function textOf(
  item: { type: 'asset'; source: string | Uint8Array } | { type: 'chunk'; code: string },
): string {
  if (item.type === 'chunk') return item.code;
  return typeof item.source === 'string' ? item.source : new TextDecoder().decode(item.source);
}

async function buildWithPlugin(): Promise<OutputFile[]> {
  const result = await build({
    configFile: false,
    root: buildRoot,
    logLevel: 'silent',
    plugins: [themeInitPlugin()],
    build: { write: false, emptyOutDir: false },
  });
  const list = Array.isArray(result) ? result : [result];
  return list.flatMap((entry) =>
    'output' in entry
      ? entry.output.map((item) => ({
          fileName: item.fileName,
          type: item.type,
          text: textOf(item),
        }))
      : [],
  );
}

function emitted(): OutputFile {
  const file = outputs.find((item) => item.fileName === 'theme-init.js');
  if (file === undefined) throw new Error('the build emitted no theme-init.js at its root');
  return file;
}

async function flattenPlugins(options: PluginOption[] | undefined): Promise<Plugin[]> {
  const plugins: Plugin[] = [];
  for (const option of options ?? []) {
    const resolved = await option;
    if (Array.isArray(resolved)) {
      plugins.push(...(await flattenPlugins(resolved)));
    } else if (resolved !== null && resolved !== undefined && resolved !== false) {
      plugins.push(resolved);
    }
  }
  return plugins;
}

async function resolvedConfig(env: ConfigEnv): Promise<UserConfig> {
  const exported: unknown = viteConfig;
  if (typeof exported !== 'function')
    throw new Error('vite.config.ts no longer exports a function');
  return await (exported as (env: ConfigEnv) => UserConfig | Promise<UserConfig>)(env);
}

/** A `classList` over a set of tokens, plus `className`, for the `vm` stand-in. */
function fakeDocumentElement(): {
  classList: object;
  className: string;
  has: (token: string) => boolean;
} {
  const tokens = new Set<string>();
  const classList = {
    add: (...names: string[]) => {
      for (const name of names) tokens.add(name);
    },
    remove: (...names: string[]) => {
      for (const name of names) tokens.delete(name);
    },
    toggle: (name: string, force?: boolean) => {
      const on = force ?? !tokens.has(name);
      if (on) tokens.add(name);
      else tokens.delete(name);
      return on;
    },
    contains: (name: string) => tokens.has(name),
  };
  return {
    classList,
    get className() {
      return [...tokens].join(' ');
    },
    set className(value: string) {
      tokens.clear();
      for (const name of value.split(/\s+/)) if (name !== '') tokens.add(name);
    },
    has: (token) => tokens.has(token),
  };
}

type StorageMode = 'available' | 'getItem throws' | 'getter throws';

/** Runs `code` as a classic script in a `vm` context; returns whether `<html>` is dark. */
function runInBrowserStandIn(
  code: string,
  options: { stored: string | null; prefersDark: boolean; storage?: StorageMode },
): boolean {
  const documentElement = fakeDocumentElement();
  const denied = (): never => {
    throw new Error('SecurityError');
  };
  const storage = {
    getItem: (key: string) =>
      options.storage === 'getItem throws'
        ? denied()
        : key === 'tayzu.theme'
          ? options.stored
          : null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  const sandbox: Record<string, unknown> = {
    document: { documentElement },
    matchMedia: (query: string) => ({
      media: query,
      matches: query === DARK_QUERY && options.prefersDark,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
    }),
  };
  Object.defineProperty(sandbox, 'localStorage', {
    configurable: true,
    enumerable: true,
    get: () => (options.storage === 'getter throws' ? denied() : storage),
  });
  sandbox['window'] = sandbox;
  sandbox['self'] = sandbox;
  const context = createContext(sandbox);
  runInContext(code, context);
  return documentElement.has('dark');
}

beforeAll(async () => {
  buildRoot = await mkdtemp(join(tmpdir(), 'tayzu-theme-init-'));
  await writeFile(
    join(buildRoot, 'index.html'),
    [
      '<!doctype html>',
      '<html lang="en">',
      '  <head>',
      '    <script src="/theme-init.js"></script>',
      '  </head>',
      '  <body>',
      '    <script type="module" src="./main.js"></script>',
      '  </body>',
      '</html>',
      '',
    ].join('\n'),
  );
  await writeFile(join(buildRoot, 'main.js'), "document.title = 'Tayzu';\n");
  outputs = await buildWithPlugin();
}, 60_000);

afterAll(async () => {
  await rm(buildRoot, { recursive: true, force: true });
});

describe('the theme-init plugin (Q46)', () => {
  it('is named tayzu:theme-init', () => {
    expect(themeInitPlugin().name).toBe('tayzu:theme-init');
  });

  it('emits theme-init.js unhashed at the build root, as the only theme-init file', () => {
    const file = emitted();

    expect(file.type).toBe('asset');
    expect(file.text.trim()).not.toBe('');
    expect(outputs.filter((item) => item.fileName.includes('theme-init'))).toEqual([file]);
  });

  it('ships no comment, while its source under src/ is commented', async () => {
    const source = await readFile(SOURCE_PATH, 'utf8');
    expect(source).toMatch(/\/\*|\/\//);

    const shipped = emitted().text;

    expect(shipped).not.toMatch(/\/\*/);
    expect(shipped).not.toMatch(/\/\//);
    expect(shipped).not.toMatch(/<!--/);
  });

  it('is minified: shorter than its source, with no indented line', async () => {
    const source = await readFile(SOURCE_PATH, 'utf8');
    const shipped = emitted().text;

    expect(shipped.length).toBeLessThan(source.length);
    expect(shipped).not.toMatch(/\n[ \t]+\S/);
  });

  it('stays a classic script that index.html loads by its unhashed root path', () => {
    const shipped = emitted().text;
    expect(shipped).not.toMatch(/^\s*(import|export)\b/m);
    expect(shipped).not.toMatch(/\bimport\s*\(/);

    const html = outputs.find((item) => item.fileName === 'index.html');
    expect(html).toBeDefined();
    expect(html?.text).toContain('<script src="/theme-init.js"></script>');
  });

  it.each([
    ['dark', false, true],
    ['light', true, false],
    ['system', true, true],
    ['system', false, false],
    [null, true, true],
    ['DARK', false, false],
    ['auto', true, true],
  ] as const)(
    'behaves as its source once minified: stored %j, dark preference %s',
    (stored, prefersDark, dark) => {
      expect(runInBrowserStandIn(emitted().text, { stored, prefersDark })).toBe(dark);
    },
  );

  it.each([
    ['getItem throws', true, true],
    ['getItem throws', false, false],
    ['getter throws', true, true],
    ['getter throws', false, false],
  ] as const)(
    'once minified, does not throw and follows the preference when %s (dark preference %s)',
    (storage, prefersDark, dark) => {
      let result: boolean | undefined;
      expect(() => {
        result = runInBrowserStandIn(emitted().text, { stored: 'dark', prefersDark, storage });
      }).not.toThrow();
      expect(result).toBe(dark);
    },
  );
});

describe('the app build wiring (Q46, Q61)', () => {
  it('registers the plugin in the app config for a build', async () => {
    const config = await resolvedConfig({
      command: 'build',
      mode: 'production',
      isPreview: false,
      isSsrBuild: false,
    });

    const names = (await flattenPlugins(config.plugins)).map((plugin) => plugin.name);

    expect(names).toContain('tayzu:theme-init');
  });

  it('no longer ships a public/ placeholder that would shadow the emitted file', async () => {
    await expect(access(PUBLIC_PLACEHOLDER)).rejects.toThrow();
  });

  it('keeps index.html loading /theme-init.js as a blocking classic script in <head>', async () => {
    const html = await readFile(INDEX_HTML, 'utf8');
    const head = /<head>([\s\S]*)<\/head>/.exec(html)?.[1] ?? '';

    expect(head).toContain('<script src="/theme-init.js"></script>');
  });
});
