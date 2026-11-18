/**
 * `043` task 4.6b: `scripts/ci/dast.sh` follows the moved bootstrap CLI. The
 * script is read as text, like `zap-seed.test.ts` reads the workflow (it needs
 * Docker, so it cannot run here).
 *
 * - The seed receives the `tayzu_app` `DATABASE_URL` and the `tayzu_auth`
 *   `AUTH_DATABASE_URL` as two distinct values, with the Cerbos address, the
 *   origins and a fixed CI operator id as `TAYZU_OPERATOR_ID` (Resolved decision
 *   Q116).
 * - `EMAIL_PROVIDER=none` is exported (6.5, Resolved decision Q96).
 *
 * No production symbol is needed by the cases above: they read `scripts/ci/dast.sh`.
 * The 045 task 8.2 cases at the end import `scripts/ci/dast-openapi.ts`.
 */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const script = readFileSync(
  fileURLToPath(new URL('../../../scripts/ci/dast.sh', import.meta.url)),
  'utf8',
);

/** The `up` function, where the seed runs. */
function upFunction(): string {
  const start = script.indexOf('\nup() {');
  const end = script.indexOf('\n# Loads the seeded session header');
  if (start === -1 || end === -1)
    throw new Error('dast.sh no longer has the shape this test reads');
  return script.slice(start, end);
}

/** The seed invocation (not the `--refresh` one) and everything that precedes it in `up`. */
function seedCommand(): { before: string; command: string } {
  const up = upFunction();
  const at = up.indexOf('scripts/ci/zap-seed.ts');
  if (at === -1) throw new Error('dast.sh no longer runs the seed in up()');
  const lineStart = up.lastIndexOf('log "seeding an organization and a session"', at);
  return {
    before: up.slice(0, lineStart),
    command: up.slice(lineStart, up.indexOf('\n  # What', at)),
  };
}

describe('dast.sh follows the moved bootstrap CLI (task 4.6b)', () => {
  it('the seed no longer receives the tayzu_auth URL as its DATABASE_URL', () => {
    const { command } = seedCommand();

    expect(command).not.toMatch(/DATABASE_URL="?\$\{?AUTH_DATABASE_URL/);
  });

  it('the seed receives distinct DATABASE_URL (tayzu_app) and AUTH_DATABASE_URL (tayzu_auth)', () => {
    const { before } = seedCommand();

    const exportedDatabaseUrls = [...before.matchAll(/export DATABASE_URL="([^"\n]+)"/g)].map(
      (match) => match[1],
    );
    const lastDatabaseUrl = exportedDatabaseUrls.at(-1);
    const authDatabaseUrl = /export AUTH_DATABASE_URL="([^"\n]+)"/.exec(before)?.[1];

    expect(lastDatabaseUrl).toContain('tayzu_app');
    expect(authDatabaseUrl).toContain('tayzu_auth');
    expect(lastDatabaseUrl).not.toBe(authDatabaseUrl);
  });

  it('the seed receives the Cerbos address, the origins and a fixed CI operator id', () => {
    const { before, command } = seedCommand();
    const visible = `${before}\n${command}`;

    expect(visible).toMatch(/export CERBOS_ADDRESS\b/);
    expect(visible).toMatch(/export ALLOWED_ORIGINS=/);
    expect(visible).toMatch(/TAYZU_OPERATOR_ID=["']?[A-Za-z0-9_.:-]{1,128}["']?(\s|$)/);
    expect(visible).not.toMatch(/TAYZU_OPERATOR_ID=["']?[^"'\s]*@/);
  });

  it('EMAIL_PROVIDER=none is exported', () => {
    expect(upFunction()).toMatch(/^\s*export EMAIL_PROVIDER=["']?none["']?\s*$/m);
  });

  it('IDENTITY_TOKEN_HMAC_SECRET is generated and exported without being printed (task 6.7b)', () => {
    const up = upFunction();

    expect(up).toMatch(/^\s*export IDENTITY_TOKEN_HMAC_SECRET="[^"\n]+"\s*$/m);
    expect(up).not.toMatch(/(echo|printf|log)[^\n]*IDENTITY_TOKEN_HMAC_SECRET/);
  });

  it('INVITATION_LINK_BASE_URL is exported equal to the ALLOWED_ORIGINS value, port included (task 6.7b)', () => {
    const up = upFunction();
    const allowed = /^\s*export ALLOWED_ORIGINS="([^"\n]+)"\s*$/m.exec(up)?.[1];
    const link = /^\s*export INVITATION_LINK_BASE_URL="([^"\n]+)"\s*$/m.exec(up)?.[1];

    expect(allowed).toBe('https://localhost:${API_PORT}');
    expect(link).toBe(allowed);
  });

  it('MOUNT_IDENTITY_ROUTES is exported on in up() so the probe reaches the public routes (044 task 14.2)', () => {
    expect(upFunction()).toMatch(/^\s*export MOUNT_IDENTITY_ROUTES=["']?true["']?\s*$/m);
  });

  it('PASSWORD_RESET_LINK_BASE_URL is exported equal to the ALLOWED_ORIGINS value (044 task 14.2)', () => {
    const up = upFunction();
    const allowed = /^\s*export ALLOWED_ORIGINS="([^"\n]+)"\s*$/m.exec(up)?.[1];
    const link = /^\s*export PASSWORD_RESET_LINK_BASE_URL="([^"\n]+)"\s*$/m.exec(up)?.[1];

    expect(link).toBeDefined();
    expect(link).toBe(allowed);
  });

  it('the --refresh call of api-scan keeps DATABASE_URL=unused and gains no new variable', () => {
    const refresh = /DATABASE_URL=unused[^\n]*\n[^\n]*zap-seed\.ts --refresh/.exec(script);

    expect(refresh).not.toBeNull();
    expect(script).not.toMatch(/TAYZU_OPERATOR_ID=[^\n]*--refresh/);
  });
});

/** The body of the `probe` shell function (044 task 14.2). */
function probeFunction(): string {
  const start = script.indexOf('\nprobe() {');
  if (start === -1) return '';
  const end = script.indexOf('\n}\n', start);
  return end === -1 ? '' : script.slice(start, end);
}

/** The lines of the `all)` case of the dispatcher. */
function allCase(): string {
  const start = script.indexOf('\n  all)');
  const end = script.indexOf(';;', start);
  if (start === -1 || end === -1) return '';
  return script.slice(start, end);
}

describe('dast.sh runs the DAST probe (044 task 14.2, design D17)', () => {
  it('the script runs the probe after the ZAP scan', () => {
    const body = probeFunction();
    expect(body).not.toBe('');
    expect(body).toContain('scripts/ci/dast-probe.ts');

    // A `probe` subcommand exists.
    expect(script).toMatch(/^\s*probe\) probe ;;\s*$/m);
    expect(script).toMatch(/usage: dast\.sh [^"\n]*\bprobe\b/);

    // `all` runs scan, then api_scan, then probe.
    const all = allCase();
    expect(all).not.toBe('');
    const scanAt = all.search(/^\s*scan\s*$/m);
    const apiScanAt = all.search(/^\s*api_scan\s*$/m);
    const probeAt = all.search(/^\s*probe\s*$/m);
    expect(scanAt).toBeGreaterThan(-1);
    expect(apiScanAt).toBeGreaterThan(scanAt);
    expect(probeAt).toBeGreaterThan(apiScanAt);
  });

  it('the probe step checks its own responses with dast-coverage.ts', () => {
    const body = probeFunction();
    expect(body).toContain('scripts/ci/dast-coverage.ts');
    expect(body).toContain('--probe');
  });

  it('The probe sends no mail: it runs against the up() stack with EMAIL_PROVIDER=none and never changes it', () => {
    const body = probeFunction();
    expect(body).not.toBe('');
    // The one stack of `up` (non-sending sender) is the target: no second API is started.
    expect(body).not.toMatch(/@tayzu\/api\s+start/);
    expect(body).not.toMatch(/EMAIL_PROVIDER/);

    // Every assignment of EMAIL_PROVIDER in the whole script is `none`.
    const assignments = [...script.matchAll(/EMAIL_PROVIDER=["']?([^"'\s]*)/g)].map((m) => m[1]);
    expect(assignments.length).toBeGreaterThan(0);
    for (const value of assignments) expect(value).toBe('none');
    expect(upFunction()).toMatch(/^\s*export EMAIL_PROVIDER=["']?none["']?\s*$/m);
  });
});

/**
 * 045 task 8.2 (design SEC12, Gates): the OpenAPI-driven API scan would hit
 * `DELETE /v1/organization`, a destructive route, so the route sits on an
 * explicit exclusion list of the scan, which `dast.sh` reads.
 *
 * ## Contract (red phase: neither file exists yet)
 *
 * `scripts/ci/dast-exclusions.json`:
 *
 * ```json
 * { "exclusions": [{ "method": "DELETE", "path": "/v1/organization", "reason": "..." }] }
 * ```
 *
 * `method` is an upper-case HTTP method, `path` an OpenAPI path template exactly
 * as a committed `openapi/*.openapi.json` writes it, `reason` a non-empty text.
 *
 * ```ts
 * // scripts/ci/dast-openapi.ts
 * export interface DastExclusion {
 *   readonly method: string;
 *   readonly path: string;
 *   readonly reason: string;
 * }
 * // Reads and validates the list; throws (fail closed) on a malformed file or
 * // an entry without a method, a path or a non-blank reason.
 * export function readDastExclusions(path: string): readonly DastExclusion[];
 * // A copy of the OpenAPI document without the excluded operations.
 * export function excludeOperations(
 *   document: unknown,
 *   exclusions: readonly DastExclusion[],
 * ): Record<string, unknown>;
 * // main (guarded): tsx scripts/ci/dast-openapi.ts <exclusions.json> <input.openapi.json> <output.openapi.json>
 * ```
 *
 * `dast.sh` defines `EXCLUSIONS_FILE="scripts/ci/dast-exclusions.json"` and, in
 * `prepare_zap`, writes every OpenAPI document ZAP scans through that script
 * instead of copying it, so no committed document reaches ZAP unfiltered.
 */
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const EXCLUSIONS_PATH = join(repoRoot, 'scripts', 'ci', 'dast-exclusions.json');
const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

type OpenApiDocument = { paths: Record<string, Record<string, unknown>> };
type RawExclusion = Record<string, unknown>;

/** Every committed OpenAPI document, by file name. */
function committedDocuments(): [string, OpenApiDocument][] {
  const dir = join(repoRoot, 'openapi');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.openapi.json'))
    .map((name): [string, OpenApiDocument] => [
      name,
      JSON.parse(readFileSync(join(dir, name), 'utf8')) as OpenApiDocument,
    ]);
}

/** `METHOD /path` for every operation of a document. */
function operationKeys(document: OpenApiDocument): string[] {
  return Object.entries(document.paths).flatMap(([path, item]) =>
    Object.keys(item)
      .filter((key) => HTTP_METHODS.has(key.toLowerCase()))
      .map((method) => `${method.toUpperCase()} ${path}`),
  );
}

/** The raw entries of the committed exclusion list. */
function rawExclusions(): RawExclusion[] {
  const parsed = JSON.parse(readFileSync(EXCLUSIONS_PATH, 'utf8')) as Record<string, unknown>;
  const list = parsed['exclusions'];
  expect(Array.isArray(list), 'the list has an "exclusions" array').toBe(true);
  return list as RawExclusion[];
}

/** The body of the `prepare_zap` shell function. */
function prepareZapFunction(): string {
  const start = script.indexOf('\nprepare_zap() {');
  if (start === -1) return '';
  const end = script.indexOf('\n}\n', start);
  return end === -1 ? '' : script.slice(start, end);
}

interface DastExclusion {
  readonly method: string;
  readonly path: string;
  readonly reason: string;
}

/** The expected surface of `scripts/ci/dast-openapi.ts`. */
interface DastOpenApiModule {
  readonly readDastExclusions: (path: string) => readonly DastExclusion[];
  readonly excludeOperations: (
    document: unknown,
    exclusions: readonly DastExclusion[],
  ) => Record<string, unknown>;
}

// The module under test, imported in the 8.2 cases only, so the cases above keep running.
const loadDastOpenApi = async (): Promise<DastOpenApiModule> =>
  (await import('../../../scripts/ci/dast-openapi.js')) satisfies DastOpenApiModule;

describe('dast.sh excludes destructive routes from the API scan (045 task 8.2)', () => {
  it('the exclusion list names DELETE /v1/organization with a reason', () => {
    const entry = rawExclusions().find(
      (candidate) => candidate['method'] === 'DELETE' && candidate['path'] === '/v1/organization',
    );

    expect(entry, 'DELETE /v1/organization is on the list').toBeDefined();
    expect(typeof entry?.['reason']).toBe('string');
    expect(String(entry?.['reason']).trim()).not.toBe('');
  });

  it('dast.sh reads the exclusion list and hands ZAP only filtered OpenAPI documents', () => {
    expect(script).toMatch(/^EXCLUSIONS_FILE="scripts\/ci\/dast-exclusions\.json"$/m);

    // No committed OpenAPI document is copied straight into ZAP's work directory.
    expect(script).not.toMatch(/^\s*cp\b[^\n]*(OPENAPI_FILE|\.openapi\.json)/m);

    // Every document passed to a ZAP API scan is written by the filter, from the list.
    const prepare = prepareZapFunction();
    expect(prepare).not.toBe('');
    const filterLines = prepare
      .split('\n')
      .filter((line) => line.includes('scripts/ci/dast-openapi.ts'));
    expect(filterLines.length).toBeGreaterThan(0);
    for (const line of filterLines) {
      expect(line).toMatch(/\$\{?EXCLUSIONS_FILE\}?/);
    }

    const scanned = [...script.matchAll(/zap-api-scan\.py\s+-t\s+(\S+\.openapi\.json)/g)].map(
      (match) => match[1],
    );
    expect(scanned.length).toBeGreaterThan(0);
    for (const name of scanned) {
      expect(
        filterLines.some((line) => line.includes(`$ZAP_WORK/${String(name)}`)),
        `${String(name)} is written by the filter`,
      ).toBe(true);
    }
  });

  it('the scan excludes DELETE /v1/organization: the filtered document drops it and keeps every other operation', async () => {
    const { excludeOperations, readDastExclusions } = await loadDastOpenApi();
    const exclusions = readDastExclusions(EXCLUSIONS_PATH);
    const excluded = new Set(exclusions.map((entry) => `${entry.method} ${entry.path}`));
    expect(excluded.has('DELETE /v1/organization')).toBe(true);

    const documents = committedDocuments();
    const identity = documents.find(([name]) => name === 'identity.openapi.json')?.[1];
    expect(identity, 'the committed identity document').toBeDefined();
    expect(operationKeys(identity as OpenApiDocument)).toContain('DELETE /v1/organization');

    for (const [name, document] of documents) {
      const filtered = excludeOperations(document, exclusions) as unknown as OpenApiDocument;
      const expected = operationKeys(document).filter((key) => !excluded.has(key));

      expect(operationKeys(filtered).sort(), name).toEqual(expected.sort());
    }
    const filteredIdentity = excludeOperations(identity, exclusions) as unknown as OpenApiDocument;
    expect(filteredIdentity.paths['/v1/organization']?.['delete']).toBeUndefined();
  });

  it('every entry of the exclusion list carries a non-empty reason', async () => {
    const entries = rawExclusions();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const label = `${String(entry['method'])} ${String(entry['path'])}`;
      expect(typeof entry['reason'], label).toBe('string');
      expect(String(entry['reason']).trim(), label).not.toBe('');
    }

    // The reader fails closed on a scratch list whose entry has a blank reason.
    const { readDastExclusions } = await loadDastOpenApi();
    const scratch = join(mkdtempSync(join(tmpdir(), 'dast-exclusions-')), 'exclusions.json');
    writeFileSync(
      scratch,
      JSON.stringify({ exclusions: [{ method: 'DELETE', path: '/v1/organization', reason: ' ' }] }),
    );
    expect(() => readDastExclusions(scratch)).toThrow();
  });

  it('every entry of the exclusion list names a route of a committed OpenAPI document', () => {
    const routes = new Set(committedDocuments().flatMap(([, document]) => operationKeys(document)));
    for (const entry of rawExclusions()) {
      const method = entry['method'];
      const path = entry['path'];
      expect(typeof method).toBe('string');
      expect(String(method)).toMatch(/^[A-Z]+$/);
      expect(typeof path).toBe('string');
      expect(
        routes.has(`${String(method)} ${String(path)}`),
        `${String(method)} ${String(path)}`,
      ).toBe(true);
    }
  });
});
