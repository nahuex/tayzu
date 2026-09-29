/**
 * Source-scan test for the task 11.1 fix-up (root CLAUDE.md TLS invariant):
 * "no code path in apps/api builds a pool from a URL except through
 * `createPool`". Every non-test source file under `apps/api/src` is scanned.
 *
 * Forbidden in production code: `new Pool(`, `new Client(`, `drizzle(` fed a
 * connection string or a `connection`/`connectionString` option, and any
 * `databaseUrl` option on `createApp`. Required: `createPool` is used by the
 * bootstrap, and `createApp` takes injected `appPool` and `authPool`.
 *
 * ## Why this fails right now
 *
 * `server.ts` calls `drizzle(options.databaseUrl, ...)` and declares
 * `databaseUrl`; `bootstrap.ts` does not exist.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('.', import.meta.url));

function productionFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__fixtures__') {
        files.push(...productionFiles(path));
      }
    } else if (entry.name.endsWith('.ts') && !/\.(int\.)?test\.ts$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

/** Strips comments so prose mentioning `new Pool(` does not count. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const FORBIDDEN: readonly (readonly [string, RegExp])[] = [
  ['new Pool(', /new\s+Pool\s*\(/],
  ['new Client(', /new\s+Client\s*\(/],
  ['drizzle(<string or url>)', /drizzle\s*(<[^>]*>)?\(\s*(['"`]|[\w.]*[uU]rl\b|process\.env)/],
  ['drizzle({ connection })', /drizzle\s*(<[^>]*>)?\(\s*\{[^}]*connection/],
  ['connectionString', /connectionString/],
  ['databaseUrl option', /databaseUrl/],
];

describe('apps/api builds pools only through createPool (task 11.1 fix-up)', () => {
  const files = productionFiles(SRC);

  it('scans at least server.ts', () => {
    expect(files.some((file) => file.endsWith('server.ts'))).toBe(true);
  });

  it.each(FORBIDDEN)('no production file contains %s', (_label, pattern) => {
    const offenders = files.filter((file) => pattern.test(code(file)));
    expect(offenders.map((file) => file.slice(SRC.length))).toEqual([]);
  });

  it('the bootstrap uses createPool from @tayzu/db', () => {
    const bootstrap = files.find((file) => file.endsWith('bootstrap.ts'));
    expect(bootstrap).toBeDefined();
    expect(code(bootstrap ?? '')).toMatch(/createPool/);
  });

  it('createApp takes injected appPool and authPool', () => {
    const server = code(files.find((file) => file.endsWith('server.ts')) ?? '');
    expect(server).toMatch(/options\.appPool/);
    expect(server).toMatch(/options\.authPool/);
  });
});
