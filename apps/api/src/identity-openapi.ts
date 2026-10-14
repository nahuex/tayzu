/**
 * The identity OpenAPI document (task 14.1c; design D10, Resolved decisions Q43 and Q52).
 * Generated from the identity router's `.route` declarations: paths, methods, path
 * parameters and `x-tayzu-risk` only. There is deliberately no request or response
 * schema (the router hand-parses its input), so the document's DAST value is limited.
 * The invitation-accept route is a plain Fastify route and is not in the router.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isProcedure } from '@orpc/server';
import type { AuthInstance } from '@tayzu/auth';
import type { CerbosClient } from '@tayzu/authz';

import type { AuthRepository } from './identity/auth-repository.js';
import { createIdentityRouter } from './identity-router.js';

/** The committed document, next to `openapi/catalog.openapi.json`. */
export const IDENTITY_OPENAPI_DOCUMENT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'openapi',
  'identity.openapi.json',
);

export interface IdentityContractCheckOptions {
  readonly committedDocumentPath?: string;
}

export interface IdentityContractCheckResult {
  readonly ok: boolean;
  readonly reasons: readonly string[];
}

type Json = Record<string, unknown>;

function isPlainObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Serializes with object keys sorted at every depth, so two generations byte-diff identically. */
export function serializeWithStableKeyOrder(document: unknown): string {
  return `${JSON.stringify(sortKeysDeep(document), null, 2)}\n`;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (isPlainObject(value)) {
    const sorted: Json = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeysDeep(value[key]);
    return sorted;
  }
  return value;
}

/** The router built with inert stand-ins: generating the document never calls a port. */
function inertIdentityRouter(): unknown {
  return createIdentityRouter({
    auth: {} as AuthInstance,
    authz: {} as CerbosClient,
    authRepository: {} as AuthRepository,
    withUserLock: () => Promise.reject(new Error('inert')),
  });
}

/** Every procedure of the router tree, with its dotted path. */
function collectProcedures(node: unknown, prefix = ''): [string, unknown][] {
  if (isProcedure(node)) return [[prefix, node]];
  if (!isPlainObject(node)) return [];
  return Object.entries(node).flatMap(([key, child]) =>
    collectProcedures(child, prefix === '' ? key : `${prefix}.${key}`),
  );
}

export function generateIdentityOpenApiDocument(): Promise<Json> {
  const paths: Record<string, Json> = {};
  for (const [name, procedure] of collectProcedures(inertIdentityRouter())) {
    const { route } = (procedure as { '~orpc': { route: Record<string, unknown> } })['~orpc'];
    const method = route['method'];
    const path = route['path'];
    if (typeof method !== 'string' || typeof path !== 'string') continue;
    const parameters = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
      name: match[1],
      in: 'path',
      required: true,
    }));
    const base: Json = { operationId: name, ...(parameters.length > 0 ? { parameters } : {}) };
    const spec = route['spec'];
    const operation = typeof spec === 'function' ? (spec as (o: Json) => Json)(base) : base;
    (paths[path] ??= {})[method.toLowerCase()] = operation;
  }
  return Promise.resolve({
    openapi: '3.1.1',
    info: { title: 'Tayzu Identity API', version: '0.0.0' },
    paths,
  });
}

/** Diffs the freshly generated document against the committed one. */
export async function checkIdentityContract(
  options: IdentityContractCheckOptions = {},
): Promise<IdentityContractCheckResult> {
  const committedDocumentPath = options.committedDocumentPath ?? IDENTITY_OPENAPI_DOCUMENT_PATH;
  const current = serializeWithStableKeyOrder(await generateIdentityOpenApiDocument());
  try {
    if ((await readFile(committedDocumentPath, 'utf8')) !== current) {
      return {
        ok: false,
        reasons: [
          `The generated identity OpenAPI document drifted from the committed document at ${committedDocumentPath}.`,
        ],
      };
    }
  } catch {
    return {
      ok: false,
      reasons: [
        `Could not read the committed identity OpenAPI document at ${committedDocumentPath}.`,
      ],
    };
  }
  return { ok: true, reasons: [] };
}
