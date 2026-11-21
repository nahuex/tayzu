/**
 * The web build check (`003-catalog-ui-core` task 2.8; design D3, D10 and SEC09; Q48).
 *
 * It reads the built `dist/` and the app sources and fails when:
 *
 * - `index.html` has an inline `<script>` (no `src`) or any `<style>` element, which
 *   the production CSP (`script-src 'self'`, `style-src 'self' 'nonce-<n>'`) refuses;
 * - any file of `dist/` names a Secret-class variable of `docs/security/secrets.md`;
 * - a source file uses `import.meta.env.VITE_*` (scanned in the sources, because Vite
 *   replaces those expressions at build time);
 * - `index.html` references an `http:` or `https:` origin (same origin only);
 * - the initial JavaScript, every `<script src>` and `<link rel="modulepreload">` of
 *   `index.html`, exceeds the gzip budget. Lazy chunks do not count.
 *
 * Violations carry a rule and a file path only, never file contents. Run directly
 * (`pnpm --filter @tayzu/web check:bundle`), it checks `apps/web/dist` and exits 1 on
 * any violation.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

export type BundleRule =
  | 'inline-script'
  | 'inline-style'
  | 'secret-name'
  | 'vite-env'
  | 'external-origin'
  | 'initial-js-size';

export interface BundleViolation {
  rule: BundleRule;
  /** Posix path relative to `distDir` (relative to `srcDir` for `vite-env`). */
  file: string;
}

export interface BundleCheckResult {
  /** True exactly when `violations` is empty. */
  ok: boolean;
  violations: BundleViolation[];
}

export interface BundleCheckOptions {
  /** The built `dist/`. */
  distDir: string;
  /** The app sources, scanned for `import.meta.env.VITE_*`. */
  srcDir: string;
  /** `docs/security/secrets.md`, the source of the Secret-class names. */
  secretsDocPath: string;
  /** Directories under `srcDir` (posix, relative) that the source scan skips. */
  ignoredSrcDirs?: readonly string[];
}

/** Vite and the design count sizes in kB of 1000 bytes. */
const BYTES_PER_KB = 1000;
/** The initial JavaScript budget, gzip (design D3). */
export const INITIAL_JS_BUDGET_KB = 350;
const INITIAL_JS_BUDGET_BYTES = INITIAL_JS_BUDGET_KB * BYTES_PER_KB;

const INDEX_HTML = 'index.html';
const SECRET_CLASS = 'Secret';
const CLASS_HEADER = 'Class';

/** `import.meta.env.VITE_*`, `import.meta.env?.VITE_*` and `import.meta.env['VITE_*']`. */
const VITE_ENV_USE =
  /import\s*\.\s*meta\s*\.\s*env\s*(?:\?\.|\.)\s*VITE_|import\s*\.\s*meta\s*\.\s*env\s*(?:\?\.)?\s*\[\s*['"`]VITE_/;
/** Any `http:` or `https:` scheme, in any case. */
const EXTERNAL_SCHEME = /https?:/i;
/** An environment variable name, as written in the secrets document. */
const VARIABLE_NAME = /^[A-Z][A-Z0-9_]*$/;
/** One `{A,B,C}` group of a name such as `OTEL_EXPORTER_OTLP_{TRACES,METRICS}_HEADERS`. */
const BRACE_GROUP = /\{([^{}]*)\}/;
/** A markdown table separator row: `| --- | :--: |`. */
const TABLE_SEPARATOR = /^\|(?:\s*:?-+:?\s*\|)+\s*$/;
/** A URL scheme (`https:`, `data:`): a reference that is not a path of the build. */
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

const gzipAsync = promisify(gzip);

/** Thrown on a build the check cannot read; its message never holds file contents. */
export class BundleCheckError extends Error {
  override name = 'BundleCheckError';
}

// ---------------------------------------------------------------------------
// The secrets document
// ---------------------------------------------------------------------------

/** Splits one markdown table row into its trimmed cells, honouring `\|`. */
function tableCells(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return body.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

/** Expands every `{A,B}` group: `X_{A,B}_Y` becomes `X_A_Y` and `X_B_Y`. */
function expandBraces(name: string): string[] {
  const match = BRACE_GROUP.exec(name);
  if (match === null) return [name];
  const head = name.slice(0, match.index);
  const tail = name.slice(match.index + match[0].length);
  return (match[1] ?? '')
    .split(',')
    .flatMap((option) => expandBraces(`${head}${option.trim()}${tail}`));
}

/** The variable names of one cell: every backtick span that is a concrete name. */
function namesInCell(cell: string): string[] {
  const names: string[] = [];
  for (const [, span] of cell.matchAll(/`([^`]+)`/g)) {
    for (const name of expandBraces((span ?? '').trim())) {
      if (VARIABLE_NAME.test(name)) names.push(name);
    }
  }
  return names;
}

/**
 * The variable names of every table row whose `Class` cell is exactly `Secret`, in
 * any table of the document that has a `Class` column (found by its header). The
 * names come from the row's first cell, with `{A,B}` brace groups expanded. Names
 * written with a wildcard (`OTEL_EXPORTER_OTLP_*_HEADERS`) are not concrete and are
 * left out; their expansions are listed on their own rows.
 */
export async function readSecretNames(secretsDocPath: string): Promise<string[]> {
  const lines = (await readFile(secretsDocPath, 'utf8')).split(/\r?\n/);
  const names = new Set<string>();
  let classColumn: number | undefined;
  let inTable = false;

  for (const [index, line] of lines.entries()) {
    if (!line.trim().startsWith('|')) {
      inTable = false;
      classColumn = undefined;
      continue;
    }
    if (!inTable) {
      // A table starts with a header row followed by its separator row.
      if (!TABLE_SEPARATOR.test((lines[index + 1] ?? '').trim())) continue;
      inTable = true;
      const column = tableCells(line).indexOf(CLASS_HEADER);
      classColumn = column === -1 ? undefined : column;
      continue;
    }
    if (classColumn === undefined || TABLE_SEPARATOR.test(line.trim())) continue;
    const cells = tableCells(line);
    if (cells[classColumn] !== SECRET_CLASS) continue;
    for (const name of namesInCell(cells[0] ?? '')) names.add(name);
  }
  return [...names];
}

// ---------------------------------------------------------------------------
// index.html
// ---------------------------------------------------------------------------

interface HtmlElement {
  /** Lower-case tag name. */
  name: string;
  /** Lower-case attribute names to their decoded-as-written values (`''` when bare). */
  attributes: Map<string, string>;
}

/** One attribute: a name, then an optional double-quoted, single-quoted or bare value. */
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y;
const TAG_NAME = /[a-zA-Z][a-zA-Z0-9-]*/y;
/** Elements whose content is raw text, not markup. */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title']);

/**
 * A small HTML start-tag tokenizer: enough for the `index.html` that Vite writes. It
 * skips comments, doctypes and end tags, reads attributes with any quoting, and
 * skips the raw-text content of `<script>`, `<style>`, `<textarea>` and `<title>`, so
 * markup inside them is not mistaken for elements.
 */
function parseStartTags(html: string): HtmlElement[] {
  const elements: HtmlElement[] = [];
  let at = 0;

  while (at < html.length) {
    const open = html.indexOf('<', at);
    if (open === -1) break;

    if (html.startsWith('<!--', open)) {
      const close = html.indexOf('-->', open + 4);
      at = close === -1 ? html.length : close + 3;
      continue;
    }
    if (html.startsWith('<!', open) || html.startsWith('</', open) || html.startsWith('<?', open)) {
      const close = html.indexOf('>', open);
      at = close === -1 ? html.length : close + 1;
      continue;
    }

    TAG_NAME.lastIndex = open + 1;
    const tagName = TAG_NAME.exec(html);
    if (tagName === null) {
      at = open + 1;
      continue;
    }
    const name = tagName[0].toLowerCase();
    const attributes = new Map<string, string>();
    let cursor = TAG_NAME.lastIndex;

    for (;;) {
      while (cursor < html.length && /[\s/]/.test(html.charAt(cursor))) cursor += 1;
      if (cursor >= html.length || html.charAt(cursor) === '>') break;
      ATTRIBUTE.lastIndex = cursor;
      const attribute = ATTRIBUTE.exec(html);
      if (attribute === null) {
        // A stray quote or `<`: skip one character rather than loop forever.
        cursor += 1;
        continue;
      }
      const attributeName = (attribute[1] ?? '').toLowerCase();
      // The first occurrence of an attribute wins, as in a browser.
      if (!attributes.has(attributeName)) {
        attributes.set(attributeName, attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
      }
      cursor = ATTRIBUTE.lastIndex;
    }
    elements.push({ name, attributes });
    at = cursor + 1;

    if (RAW_TEXT_ELEMENTS.has(name)) {
      const close = html.toLowerCase().indexOf(`</${name}`, at);
      at = close === -1 ? html.length : close;
    }
  }
  return elements;
}

function hasRel(element: HtmlElement, rel: string): boolean {
  return (element.attributes.get('rel') ?? '').toLowerCase().split(/\s+/).includes(rel);
}

/** The `src` of every `<script src>` and the `href` of every `<link rel="modulepreload">`. */
function initialScriptReferences(elements: readonly HtmlElement[]): string[] {
  const references: string[] = [];
  for (const element of elements) {
    if (element.name === 'script') {
      const src = element.attributes.get('src');
      if (src !== undefined && src.trim() !== '') references.push(src.trim());
    } else if (element.name === 'link' && hasRel(element, 'modulepreload')) {
      const href = element.attributes.get('href');
      if (href !== undefined && href.trim() !== '') references.push(href.trim());
    }
  }
  return references;
}

/**
 * The file of `distDir` that a same-origin reference of `index.html` names, or
 * `undefined` when it names none (a URL with a scheme, or a path outside `distDir`).
 */
function referencedFile(distDir: string, reference: string): string | undefined {
  if (URL_SCHEME.test(reference) || reference.startsWith('//')) return undefined;
  const path = reference.split(/[?#]/, 1)[0] ?? '';
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return undefined;
  }
  const file = resolve(distDir, `.${decoded.startsWith('/') ? '' : '/'}${decoded}`);
  const inside = relative(distDir, file);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return undefined;
  return file;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * The gzip size of the initial JavaScript, summed over distinct files. A reference
 * that cannot be measured (outside the build, or missing) fails closed as a
 * violation.
 */
async function checkInitialJavaScript(
  distDir: string,
  elements: readonly HtmlElement[],
): Promise<BundleViolation[]> {
  const files = new Set<string>();
  let unmeasurable = false;
  for (const reference of initialScriptReferences(elements)) {
    const file = referencedFile(distDir, reference);
    if (file === undefined || !(await isFile(file))) {
      unmeasurable = true;
    } else {
      files.add(file);
    }
  }

  let totalBytes = 0;
  for (const file of files) {
    totalBytes += (await gzipAsync(await readFile(file))).length;
  }
  return unmeasurable || totalBytes > INITIAL_JS_BUDGET_BYTES
    ? [{ rule: 'initial-js-size', file: INDEX_HTML }]
    : [];
}

async function checkIndexHtml(distDir: string): Promise<BundleViolation[]> {
  const html = await readFile(join(distDir, INDEX_HTML), 'utf8');
  const elements = parseStartTags(html);
  const violations: BundleViolation[] = [];

  const scriptWithoutSrc = elements.some(
    (element) => element.name === 'script' && (element.attributes.get('src') ?? '').trim() === '',
  );
  if (scriptWithoutSrc) violations.push({ rule: 'inline-script', file: INDEX_HTML });
  if (elements.some((element) => element.name === 'style')) {
    violations.push({ rule: 'inline-style', file: INDEX_HTML });
  }
  if (EXTERNAL_SCHEME.test(html)) violations.push({ rule: 'external-origin', file: INDEX_HTML });

  violations.push(...(await checkInitialJavaScript(distDir, elements)));
  return violations;
}

// ---------------------------------------------------------------------------
// Directory scans
// ---------------------------------------------------------------------------

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

/** Every regular file under `root`, as posix paths relative to it, skipping `ignored`. */
async function listFiles(
  root: string,
  ignored: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const files: string[] = [];
  const pending = [''];
  for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
    const entries = await readdir(join(root, directory), { withFileTypes: true });
    for (const entry of entries) {
      const path = directory === '' ? entry.name : `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!ignored.has(path)) pending.push(path);
      } else if (entry.isFile()) {
        files.push(path);
      } else {
        // A symlink or a special file: fail closed instead of skipping it silently.
        throw new BundleCheckError('bundle check: unsupported file type in a scanned directory');
      }
    }
  }
  return files.sort();
}

async function checkSecretNames(
  distDir: string,
  secretNames: readonly string[],
): Promise<BundleViolation[]> {
  const needles = secretNames.map((name) => Buffer.from(name, 'utf8'));
  const violations: BundleViolation[] = [];
  for (const file of await listFiles(distDir)) {
    const content = await readFile(join(distDir, file));
    if (needles.some((needle) => content.includes(needle))) {
      violations.push({ rule: 'secret-name', file });
    }
  }
  return violations;
}

async function checkViteEnv(
  srcDir: string,
  ignoredSrcDirs: readonly string[],
): Promise<BundleViolation[]> {
  const violations: BundleViolation[] = [];
  for (const file of await listFiles(srcDir, new Set(ignoredSrcDirs))) {
    if (VITE_ENV_USE.test(await readFile(join(srcDir, file), 'utf8'))) {
      violations.push({ rule: 'vite-env', file });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Runs every rule over a build and its sources. */
export async function checkBundle(options: BundleCheckOptions): Promise<BundleCheckResult> {
  const secretNames = await readSecretNames(options.secretsDocPath);
  if (secretNames.length === 0) {
    // A document whose tables changed shape must not turn the rule into a no-op.
    throw new BundleCheckError('bundle check: no Secret-class names found in the secrets document');
  }

  const violations = [
    ...(await checkIndexHtml(options.distDir)),
    ...(await checkSecretNames(options.distDir, secretNames)),
    ...(await checkViteEnv(options.srcDir, options.ignoredSrcDirs ?? [])),
  ];
  return { ok: violations.length === 0, violations };
}

const WEB_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const REPO_ROOT = resolve(WEB_ROOT, '../..');

/** The CLI: checks `apps/web/dist`. Messages are fixed text, rule and path only. */
async function main(): Promise<void> {
  try {
    const result = await checkBundle({
      distDir: join(WEB_ROOT, 'dist'),
      srcDir: join(WEB_ROOT, 'src'),
      secretsDocPath: join(REPO_ROOT, 'docs', 'security', 'secrets.md'),
      // Its fixtures hold the banned patterns on purpose.
      ignoredSrcDirs: [
        toPosix(relative(join(WEB_ROOT, 'src'), dirname(fileURLToPath(import.meta.url)))),
      ],
    });
    for (const violation of result.violations) {
      process.stderr.write(`bundle check: ${violation.rule} in ${violation.file}\n`);
    }
    if (!result.ok) {
      process.stderr.write(
        `bundle check failed: ${String(result.violations.length)} violation(s).\n`,
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write('bundle check passed.\n');
  } catch (error) {
    process.stderr.write(
      error instanceof BundleCheckError
        ? `${error.message}\n`
        : 'bundle check: the build or the secrets document could not be read.\n',
    );
    process.exitCode = 1;
  }
}

const isDirectlyExecuted =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectlyExecuted) {
  await main();
}
