/**
 * DAST OpenAPI filter (045 task 8.2, design SEC12). The OpenAPI-driven ZAP API
 * scan requests every operation of the document it is given, so `dast.sh`
 * writes each document through this script, which drops the operations named
 * in `scripts/ci/dast-exclusions.json` (destructive routes). Error messages are
 * fixed and never carry file contents.
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export interface DastExclusion {
  /** An upper-case HTTP method, for example `DELETE`. */
  readonly method: string;
  /** The OpenAPI path template, exactly as the committed document writes it. */
  readonly path: string;
  /** Why the operation is not scanned; never blank. */
  readonly reason: string;
}

const HTTP_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'PUT',
  'POST',
  'DELETE',
  'OPTIONS',
  'HEAD',
  'PATCH',
  'TRACE',
]);
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const LIST_KEYS: ReadonlySet<string> = new Set(['exclusions']);
const ENTRY_KEYS: ReadonlySet<string> = new Set(['method', 'path', 'reason']);
/** Checked before parsing: the list is a handful of entries. */
const MAX_EXCLUSIONS_BYTES = 64 * 1024;

function invalidList(): never {
  throw new Error('DAST exclusion list is malformed');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Rebuilds parsed JSON as null-prototype objects and rejects `__proto__`,
 * `constructor` and `prototype` as a key at every depth.
 */
function safeCopy(value: unknown, onUnsafeKey: () => never): unknown {
  if (Array.isArray(value)) return value.map((item) => safeCopy(item, onUnsafeKey));
  if (!isRecord(value)) return value;
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (UNSAFE_KEYS.has(key)) onUnsafeKey();
    result[key] = safeCopy(value[key], onUnsafeKey);
  }
  return result;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function toExclusion(entry: unknown): DastExclusion {
  if (!isRecord(entry) || !hasOnlyKeys(entry, ENTRY_KEYS)) invalidList();
  const { method, path, reason } = entry;
  if (typeof method !== 'string' || !HTTP_METHODS.has(method)) invalidList();
  if (typeof path !== 'string' || !path.startsWith('/')) invalidList();
  if (typeof reason !== 'string' || reason.trim() === '') invalidList();
  return Object.freeze({ method, path, reason });
}

/**
 * Reads and validates the exclusion list. Fails closed on an oversized or
 * malformed file, an unsafe or unknown key, a method that is not an upper-case
 * HTTP method, a path that is not a template, or a blank reason.
 */
export function readDastExclusions(path: string): readonly DastExclusion[] {
  let parsed: unknown;
  try {
    if (statSync(path).size > MAX_EXCLUSIONS_BYTES) invalidList();
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // A JSON syntax error quotes the file; only the fixed message leaves.
    invalidList();
  }
  const list = safeCopy(parsed, invalidList);
  if (!isRecord(list) || !hasOnlyKeys(list, LIST_KEYS)) invalidList();
  const entries = list['exclusions'];
  if (!Array.isArray(entries)) invalidList();
  return Object.freeze(entries.map(toExclusion));
}

function invalidDocument(): never {
  throw new Error('DAST OpenAPI document is malformed');
}

/**
 * A deep, null-prototype copy of an OpenAPI document without the excluded
 * operations; every other operation and field is kept. A path item left with
 * no operation is dropped, so ZAP never sees an empty path.
 */
export function excludeOperations(
  document: unknown,
  exclusions: readonly DastExclusion[],
): Record<string, unknown> {
  const copy = safeCopy(document, invalidDocument);
  if (!isRecord(copy) || !isRecord(copy['paths'])) invalidDocument();
  const paths = copy['paths'];
  for (const { method, path } of exclusions) {
    const item = paths[path];
    if (!isRecord(item)) continue;
    for (const key of Object.keys(item)) {
      if (key.toUpperCase() === method) Reflect.deleteProperty(item, key);
    }
    if (!Object.keys(item).some((key) => HTTP_METHODS.has(key.toUpperCase()))) {
      Reflect.deleteProperty(paths, path);
    }
  }
  return copy;
}

function main(): void {
  const [exclusionsPath, inputPath, outputPath] = process.argv.slice(2);
  if (exclusionsPath === undefined || inputPath === undefined || outputPath === undefined) {
    console.error(
      'usage: dast-openapi.ts <exclusions.json> <input.openapi.json> <output.openapi.json>',
    );
    process.exit(2);
  }
  try {
    const exclusions = readDastExclusions(exclusionsPath);
    let document: unknown;
    try {
      document = JSON.parse(readFileSync(inputPath, 'utf8'));
    } catch {
      invalidDocument();
    }
    const filtered = excludeOperations(document, exclusions);
    writeFileSync(outputPath, `${JSON.stringify(filtered, null, 2)}\n`);
    console.log(
      `DAST OpenAPI filter: ${String(exclusions.length)} exclusion list entries applied.`,
    );
  } catch (error) {
    console.error(
      error instanceof Error && error.message.startsWith('DAST ')
        ? error.message
        : 'DAST OpenAPI document could not be filtered',
    );
    process.exit(1);
  }
}

const isDirectlyExecuted =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectlyExecuted) {
  main();
}
