/**
 * Unit test for task 2.7 of openspec/changes/archive/2026-11-27-003-catalog-ui-core (design D4,
 * "A browser-safe contract module"): `catalogContract` and its Zod schemas
 * live in `./contract-definition.ts`, which imports only `@orpc/contract` and
 * `zod`; `./contract.ts` re-exports it and keeps the document generation and
 * drift check; `package.json` gains `"./contract":
 * "./src/api/contract-definition.ts"`.
 *
 * The import walk reads source text with the TypeScript compiler API, so it
 * sees every static `import`, `import type`, `export ... from`, `import x =
 * require(...)`, `import(...)` and `require(...)` of the module and of every
 * relative module it reaches, transitively. Type-only imports count too: the
 * web app typechecks this module without Node types (design D2), so a
 * type-only `node:` import breaks it just as a value import would.
 *
 * Red phase: `./contract-definition.ts` and the `"./contract"` export do not
 * exist yet.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { catalogContract as reExportedCatalogContract } from './contract.js';

const API_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(API_DIR, '..', '..');
const PACKAGE_JSON_PATH = join(PACKAGE_DIR, 'package.json');
const CONTRACT_DEFINITION_PATH = join(API_DIR, 'contract-definition.ts');

/** The only packages the browser-safe module may reach (design D4). */
const ALLOWED_PACKAGES: readonly string[] = ['@orpc/contract', 'zod'];

const RESOLUTION_OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ES2023,
};

interface ImportSite {
  /** The importing file, relative to the package directory. */
  readonly from: string;
  /** The module specifier, or `null` for a non-literal dynamic import. */
  readonly specifier: string | null;
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

/** `@scope/name/sub` -> `@scope/name`, `name/sub` -> `name`. */
function packageNameOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

function moduleSpecifiersOf(filePath: string): (string | null)[] {
  const source = ts.createSourceFile(
    filePath,
    readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.ES2023,
    true,
    ts.ScriptKind.TS,
  );
  const specifiers: (string | null)[] = [];
  const literalOrNull = (node: ts.Node | undefined): string | null =>
    node !== undefined && ts.isStringLiteralLike(node) ? node.text : null;

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined) {
        specifiers.push(literalOrNull(node.moduleSpecifier));
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      specifiers.push(literalOrNull(node.moduleReference.expression));
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      specifiers.push(ts.isLiteralTypeNode(argument) ? literalOrNull(argument.literal) : null);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequire) {
        specifiers.push(literalOrNull(node.arguments[0]));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

function resolveRelative(specifier: string, fromFile: string): string {
  const resolved = ts.resolveModuleName(specifier, fromFile, RESOLUTION_OPTIONS, ts.sys)
    .resolvedModule?.resolvedFileName;
  if (resolved === undefined) {
    throw new Error(`cannot resolve '${specifier}' from ${relative(PACKAGE_DIR, fromFile)}`);
  }
  return resolve(resolved);
}

/**
 * Every non-relative import site reachable from `entry` through relative
 * imports, plus the list of files visited.
 */
function walkImports(entry: string): { external: ImportSite[]; visited: string[] } {
  const external: ImportSite[] = [];
  const visited = new Set<string>();
  const pending = [resolve(entry)];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (visited.has(file)) continue;
    visited.add(file);
    const from = relative(PACKAGE_DIR, file);
    for (const specifier of moduleSpecifiersOf(file)) {
      if (specifier !== null && isRelative(specifier)) {
        pending.push(resolveRelative(specifier, file));
      } else {
        external.push({ from, specifier });
      }
    }
  }
  return { external, visited: [...visited].map((file) => relative(PACKAGE_DIR, file)) };
}

function readPackageExports(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('exports' in parsed)) {
    throw new Error('packages/catalog/package.json has no "exports" field');
  }
  const exportsField = parsed.exports;
  if (typeof exportsField !== 'object' || exportsField === null) {
    throw new Error('packages/catalog/package.json "exports" is not an object map');
  }
  return exportsField as Record<string, unknown>;
}

describe('the import walk itself (controls, so the guard below is never vacuous)', () => {
  it('finds the node: imports and the server-only packages of contract.ts', () => {
    const { external } = walkImports(join(API_DIR, 'contract.ts'));
    const specifiers = external.map((site) => site.specifier);
    expect(specifiers).toContain('node:fs/promises');
    expect(specifiers).toContain('@orpc/openapi');
  });

  it('resolves the package self-reference @tayzu/catalog through package.json exports', () => {
    const resolved = ts.resolveModuleName(
      '@tayzu/catalog',
      join(API_DIR, 'contract-definition-imports.test.ts'),
      RESOLUTION_OPTIONS,
      ts.sys,
    ).resolvedModule?.resolvedFileName;
    expect(resolved === undefined ? undefined : resolve(resolved)).toBe(
      join(PACKAGE_DIR, 'src', 'index.ts'),
    );
  });
});

describe('browser-safe catalog contract module (003 task 2.7, design D4)', () => {
  it('exists at packages/catalog/src/api/contract-definition.ts', () => {
    expect(existsSync(CONTRACT_DEFINITION_PATH)).toBe(true);
  });

  it('imports no node: specifier, directly or through any relative import', () => {
    const { external } = walkImports(CONTRACT_DEFINITION_PATH);
    const nodeImports = external.filter(
      (site) => site.specifier !== null && site.specifier.startsWith('node:'),
    );
    expect(nodeImports).toEqual([]);
  });

  it('imports no package other than @orpc/contract and zod, directly or transitively', () => {
    const { external } = walkImports(CONTRACT_DEFINITION_PATH);
    const disallowed = external.filter(
      (site) =>
        site.specifier === null || !ALLOWED_PACKAGES.includes(packageNameOf(site.specifier)),
    );
    expect(disallowed).toEqual([]);
  });

  it('never reaches the Node-only contract.ts through a relative import', () => {
    const { visited } = walkImports(CONTRACT_DEFINITION_PATH);
    expect(visited).not.toContain(join('src', 'api', 'contract.ts'));
  });

  it('is the target of the "./contract" entry of package.json exports', () => {
    expect(readPackageExports()['./contract']).toBe('./src/api/contract-definition.ts');
  });

  it('resolves @tayzu/catalog/contract to that module through package.json exports', () => {
    const resolved = ts.resolveModuleName(
      '@tayzu/catalog/contract',
      join(API_DIR, 'contract-definition-imports.test.ts'),
      RESOLUTION_OPTIONS,
      ts.sys,
    ).resolvedModule?.resolvedFileName;
    expect(resolved === undefined ? undefined : resolve(resolved)).toBe(CONTRACT_DEFINITION_PATH);
  });

  it('exports catalogContract, and contract.ts re-exports the same object', async () => {
    const definition: Record<string, unknown> = await import('./contract-definition.js');
    expect(definition.catalogContract).toBeDefined();
    expect(reExportedCatalogContract).toBe(definition.catalogContract);
  });
});
