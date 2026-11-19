/**
 * The catalog contract's Node-only half (task 9.3; design D11): OpenAPI
 * document generation and the drift check behind `pnpm contract:check`.
 *
 * `catalogContract` itself, with every Zod schema, lives in
 * `./contract-definition.ts`, the browser-safe module of 003 design D4, and
 * is re-exported here so server-side callers keep importing
 * `./contract.js`.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AnyContractRouter, OpenAPI } from '@orpc/contract';
import { OpenAPIGenerator } from '@orpc/openapi';
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4';

import { catalogContract } from './contract-definition.js';

export { catalogContract } from './contract-definition.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// OpenAPI generation and drift checking (task 9.3, design D11)
// ---------------------------------------------------------------------------

/** The committed contract document (design D11: "`pnpm contract:generate` writes `openapi/catalog.openapi.json`"). */
export const OPENAPI_DOCUMENT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'openapi',
  'catalog.openapi.json',
);

const openApiGenerator = new OpenAPIGenerator({
  schemaConverters: [new ZodToJsonSchemaConverter()],
});

export async function generateOpenApiDocument(
  router: AnyContractRouter = catalogContract,
): Promise<OpenAPI.Document> {
  return openApiGenerator.generate(router, {
    info: { title: 'Tayzu Catalog API', version: '0.0.0' },
  });
}

/**
 * Serializes `document` with object keys sorted at every depth (arrays keep
 * their own order; design D11's "stable key order"), so two generations of
 * the same contract byte-diff identically regardless of property insertion
 * order.
 */
export function serializeWithStableKeyOrder(document: unknown): string {
  return `${JSON.stringify(sortKeysDeep(document), null, 2)}\n`;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (isPlainObject(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep(value[key]);
    }
    return sorted;
  }
  return value;
}

export interface ContractCheckOptions {
  readonly router?: AnyContractRouter;
  readonly committedDocumentPath?: string;
}

export interface ContractCheckResult {
  readonly ok: boolean;
  readonly reasons: readonly string[];
}

const FORBIDDEN_CONTEXT_FIELDS = ['tenantId', 'actor'] as const;

/** Recursively collects every JSON Schema property name reachable from `schema` (objects, arrays, and union branches). */
function collectSchemaPropertyNames(schema: unknown, names: Set<string>): void {
  if (!isPlainObject(schema)) return;

  const properties = schema['properties'];
  if (isPlainObject(properties)) {
    for (const [key, value] of Object.entries(properties)) {
      names.add(key);
      collectSchemaPropertyNames(value, names);
    }
  }

  if ('items' in schema) collectSchemaPropertyNames(schema['items'], names);

  for (const combinator of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = schema[combinator];
    if (Array.isArray(branches)) {
      for (const branch of branches) collectSchemaPropertyNames(branch, names);
    }
  }
}

/**
 * Spec "Contract cannot carry the tenant"; design D3: scans every operation's
 * request schema (path/query parameters and JSON body) for a property
 * literally named `tenantId` or `actor`, at any depth.
 */
function findForbiddenContextFields(document: OpenAPI.Document): string[] {
  const reasons: string[] = [];
  const paths = document.paths ?? {};

  for (const [path, methods] of Object.entries(paths)) {
    if (!isPlainObject(methods)) continue;

    for (const [method, operation] of Object.entries(methods)) {
      if (!isPlainObject(operation)) continue;

      const names = new Set<string>();
      const parameters = operation['parameters'];
      if (Array.isArray(parameters)) {
        for (const parameter of parameters) {
          if (isPlainObject(parameter) && typeof parameter['name'] === 'string') {
            names.add(parameter['name']);
          }
        }
      }

      const requestBody = operation['requestBody'];
      if (isPlainObject(requestBody)) {
        const content = requestBody['content'];
        if (isPlainObject(content)) {
          for (const mediaType of Object.values(content)) {
            if (isPlainObject(mediaType)) collectSchemaPropertyNames(mediaType['schema'], names);
          }
        }
      }

      for (const forbidden of FORBIDDEN_CONTEXT_FIELDS) {
        if (names.has(forbidden)) {
          reasons.push(
            `${method.toUpperCase()} ${path}: request carries "${forbidden}", which must be host-supplied only (design D3)`,
          );
        }
      }
    }
  }

  return reasons;
}

/**
 * Regenerates the document from `options.router` and diffs its
 * stable-key-order serialization against the file at
 * `options.committedDocumentPath` (design D11: "`pnpm contract:check`
 * regenerates it to a temp file and fails on any diff"). Independently scans
 * for a forbidden `tenantId`/`actor` field. `ok` is `false` if either check
 * finds anything.
 */
export async function checkContract(
  options: ContractCheckOptions = {},
): Promise<ContractCheckResult> {
  const router = options.router ?? catalogContract;
  const committedDocumentPath = options.committedDocumentPath ?? OPENAPI_DOCUMENT_PATH;

  const reasons: string[] = [];

  const current = await generateOpenApiDocument(router);
  const currentSerialized = serializeWithStableKeyOrder(current);

  try {
    const committedSerialized = await readFile(committedDocumentPath, 'utf8');
    if (committedSerialized !== currentSerialized) {
      reasons.push(
        `The generated OpenAPI document drifted from the committed document at ${committedDocumentPath}.`,
      );
    }
  } catch {
    reasons.push(`Could not read the committed OpenAPI document at ${committedDocumentPath}.`);
  }

  reasons.push(...findForbiddenContextFields(current));

  return { ok: reasons.length === 0, reasons };
}
