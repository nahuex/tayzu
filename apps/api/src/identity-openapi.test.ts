/**
 * Task 14.1c (openspec/changes/043-identity-lifecycle-and-org-admin, design D10,
 * Resolved decisions Q43 and Q52): the second committed OpenAPI document,
 * `openapi/identity.openapi.json`, generated from the identity router's `.route`
 * declarations. No database is needed, so this is a plain `*.test.ts`.
 *
 * ## Module under test and assumed API (red phase: it does not exist yet)
 *
 * ```ts
 * // apps/api/src/identity-openapi.ts
 * export const IDENTITY_OPENAPI_DOCUMENT_PATH: string; // <repo>/openapi/identity.openapi.json
 * export function serializeWithStableKeyOrder(document: unknown): string;
 * // Generated from the identity router's route declarations (method, path, spec);
 * // the default router is the real one built with inert stand-ins for its ports.
 * export function generateIdentityOpenApiDocument(): Promise<Record<string, unknown>>;
 * export interface IdentityContractCheckOptions {
 *   readonly committedDocumentPath?: string; // defaults to IDENTITY_OPENAPI_DOCUMENT_PATH
 * }
 * export function checkIdentityContract(
 *   options?: IdentityContractCheckOptions,
 * ): Promise<{ readonly ok: boolean; readonly reasons: readonly string[] }>;
 * ```
 *
 * `apps/api/package.json` gains the scripts `contract:generate` and
 * `contract:check` (the root `turbo run` picks them up); the scripts are thin
 * wrappers over the functions above and exit non-zero when the check fails.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  checkIdentityContract,
  generateIdentityOpenApiDocument,
  IDENTITY_OPENAPI_DOCUMENT_PATH,
  serializeWithStableKeyOrder,
} from './identity-openapi.js';

const run = promisify(execFile);
const apiDir = join(dirname(fileURLToPath(import.meta.url)), '..');

const THIRTEEN_ROUTES: readonly (readonly [string, string])[] = [
  ['post', '/v1/credentials'],
  ['post', '/v1/credentials/{credential}/rotate'],
  ['post', '/v1/credentials/{credential}/revoke'],
  ['get', '/v1/credentials'],
  ['post', '/v1/service-accounts'],
  ['delete', '/v1/service-accounts/{user}'],
  ['post', '/v1/users'],
  ['post', '/v1/users/invitations'],
  ['post', '/v1/users/invitations/{invitation}/cancel'],
  ['post', '/v1/users/invitations/{invitation}/resend'],
  ['post', '/v1/users/{user}/sso-account'],
  ['put', '/v1/users/{user}/status'],
  ['delete', '/v1/users/{user}/sso-account'],
];

const HIGH_RISK = new Set([
  'post /v1/credentials',
  'post /v1/credentials/{credential}/rotate',
  'post /v1/credentials/{credential}/revoke',
  'post /v1/service-accounts',
  'delete /v1/service-accounts/{user}',
  'post /v1/users',
  'post /v1/users/invitations',
  'post /v1/users/{user}/sso-account',
  'put /v1/users/{user}/status',
  'delete /v1/users/{user}/sso-account',
]);

type Operation = Record<string, unknown> & {
  parameters?: { name: string; in: string }[];
};
type Document = { paths: Record<string, Record<string, Operation>> };

function tempFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'identity-openapi-')), name);
}

function operations(document: Document): [string, string, Operation][] {
  return Object.entries(document.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, operation]): [string, string, Operation] => [
      method.toLowerCase(),
      path,
      operation,
    ]),
  );
}

describe('identity OpenAPI document (task 14.1c; design D10, Q43, Q52)', () => {
  it('contract:generate produces the committed file', async () => {
    await run('pnpm', ['run', 'contract:generate'], { cwd: apiDir });

    const generated = await generateIdentityOpenApiDocument();
    expect(readFileSync(IDENTITY_OPENAPI_DOCUMENT_PATH, 'utf8')).toBe(
      serializeWithStableKeyOrder(generated),
    );
  }, 120_000);

  it('contract:check passes on the committed file', async () => {
    const result = await checkIdentityContract();
    expect(result.reasons).toEqual([]);
    expect(result.ok).toBe(true);

    // The package script exits zero (a non-zero exit makes `run` reject).
    await run('pnpm', ['run', 'contract:check'], { cwd: apiDir });
  }, 120_000);

  it('contract:check fails after a route path is changed in a scratch edit', async () => {
    const document = structuredClone(
      (await generateIdentityOpenApiDocument()) as unknown as Document,
    );
    const statusRoute = document.paths['/v1/users/{user}/status'];
    expect(statusRoute).toBeDefined();
    document.paths['/v1/users/{user}/state'] = statusRoute as Record<string, Operation>;
    delete document.paths['/v1/users/{user}/status'];

    const committedDocumentPath = tempFile('path-drift.openapi.json');
    writeFileSync(committedDocumentPath, serializeWithStableKeyOrder(document));

    const result = await checkIdentityContract({ committedDocumentPath });
    expect(result.ok).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('contract:check fails after a route risk spec is changed in a scratch edit', async () => {
    const document = structuredClone(
      (await generateIdentityOpenApiDocument()) as unknown as Document,
    );
    const operation = document.paths['/v1/users/{user}/status']?.['put'];
    expect(operation?.['x-tayzu-risk']).toBe('high');
    delete operation?.['x-tayzu-risk'];

    const committedDocumentPath = tempFile('risk-drift.openapi.json');
    writeFileSync(committedDocumentPath, serializeWithStableKeyOrder(document));

    const result = await checkIdentityContract({ committedDocumentPath });
    expect(result.ok).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('lists the thirteen routes with their methods and paths and not the accept route', async () => {
    const document = (await generateIdentityOpenApiDocument()) as unknown as Document;
    const listed = operations(document).map(([method, path]) => `${method} ${path}`);

    expect(listed.sort()).toEqual(THIRTEEN_ROUTES.map(([m, p]) => `${m} ${p}`).sort());
    expect(Object.keys(document.paths)).not.toContain('/v1/auth/invitations/accept');
  });

  it('carries path parameters and x-tayzu-risk', async () => {
    const document = (await generateIdentityOpenApiDocument()) as unknown as Document;

    for (const [method, path, operation] of operations(document)) {
      const declared = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
      const inPath = (operation.parameters ?? [])
        .filter((parameter) => parameter.in === 'path')
        .map((parameter) => parameter.name);
      expect(inPath.sort(), `${method} ${path}`).toEqual(declared.sort());

      if (HIGH_RISK.has(`${method} ${path}`)) {
        expect(operation['x-tayzu-risk'], `${method} ${path}`).toBe('high');
      } else {
        expect(operation['x-tayzu-risk'], `${method} ${path}`).toBeUndefined();
      }
    }
  });

  it('the document contains no schema object', async () => {
    const document = await generateIdentityOpenApiDocument();
    const serialized = serializeWithStableKeyOrder(document);
    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value !== null && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
          keys.add(key);
          walk(child);
        }
      }
    };
    walk(document);

    for (const forbidden of ['schema', 'schemas', 'requestBody', 'components', '$ref']) {
      expect(keys.has(forbidden), forbidden).toBe(false);
    }
    expect(serialized).not.toContain('"$ref"');
  });
});
