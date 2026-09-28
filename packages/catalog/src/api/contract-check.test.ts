/**
 * Unit tests for task 9.3 (openspec/changes/archive/2026-09-28-001-catalog-core, design D11;
 * spec "Published API contract"). No database is needed: generating and
 * diffing the OpenAPI document only introspects the contract's Zod schemas
 * and route metadata, it never opens a connection or runs a query -- this is
 * a plain `*.test.ts`, not an `*.int.test.ts`.
 *
 * ## Module under test and assumed API
 *
 * `./contract.ts` does not exist yet (red phase). This test assumes the
 * following exported shape (see `./router.int.test.ts`'s doc comment for
 * `catalogContract` and `generateOpenApiDocument`, which this file also
 * relies on):
 *
 * ```ts
 * // ./contract.ts
 * import type { OpenAPI, AnyContractRouter } from '@orpc/contract';
 *
 * export const catalogContract: AnyContractRouter; // the 12 procedures, design D11
 *
 * // Absolute path to the repo-root committed file (design D11:
 * // "`pnpm contract:generate` writes `openapi/catalog.openapi.json`").
 * export const OPENAPI_DOCUMENT_PATH: string;
 *
 * export function generateOpenApiDocument(
 *   router?: AnyContractRouter,          // defaults to `catalogContract`
 * ): Promise<OpenAPI.Document>;
 *
 * // Serializes `document` with object keys sorted at every depth (arrays
 * // keep their own order) -- design D11's "stable key order" -- so two
 * // generations of the same contract byte-diff identically regardless of
 * // property insertion order.
 * export function serializeWithStableKeyOrder(document: unknown): string;
 *
 * export interface ContractCheckOptions {
 *   readonly router?: AnyContractRouter;        // defaults to `catalogContract`
 *   readonly committedDocumentPath?: string;    // defaults to `OPENAPI_DOCUMENT_PATH`
 * }
 * export interface ContractCheckResult {
 *   readonly ok: boolean;
 *   readonly reasons: readonly string[]; // empty iff `ok`
 * }
 *
 * // Regenerates the document from `options.router` and diffs its
 * // stable-key-order serialization against the file at
 * // `options.committedDocumentPath` (design D11: "`pnpm contract:check`
 * // regenerates it to a temp file and fails on any diff"). Independently,
 * // scans every operation's request schema (path/query parameters and JSON
 * // body) for a property literally named `tenantId` or `actor` at any depth
 * // (spec "Contract cannot carry the tenant"; design D3: "No procedure input
 * // MAY carry `tenantId` or `actor`"), and folds any violation into
 * // `reasons` as well. `ok` is `false` if either check finds anything.
 * export function checkContract(options?: ContractCheckOptions): Promise<ContractCheckResult>;
 * ```
 *
 * The real `pnpm contract:check` script (design D11) is expected to call
 * `checkContract()` with no arguments and exit non-zero when `result.ok` is
 * `false`; this test asserts the `ContractCheckResult` those exit codes are
 * computed from, since spawning a child process to observe an actual exit
 * code would test the wrapping script, not this module.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { oc } from '@orpc/contract';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  catalogContract,
  checkContract,
  generateOpenApiDocument,
  OPENAPI_DOCUMENT_PATH,
  serializeWithStableKeyOrder,
} from './contract.js';

function tempFilePath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-contract-check-'));
  return join(dir, name);
}

/**
 * Deep-clones `document` and adds a property to `blueprints.create`'s input
 * schema (`POST /v1/blueprints`, design D11) -- "mutating a copy of an input
 * schema" (task 9.3's Verify clause) -- so the mutated copy no longer matches
 * what the real, unchanged contract generates. Falls back to mutating the
 * document's `info.description` if the generator shapes the request body
 * differently than assumed, so the test still exercises "any diff" (design
 * D11) even under an unexpected (but still D11-compliant) OpenAPI shape.
 */
function mutateInputSchemaCopy(document: unknown): unknown {
  const mutated = structuredClone(document) as {
    info?: { description?: string };
    paths?: Record<
      string,
      Record<
        string,
        {
          requestBody?: {
            content?: Record<string, { schema?: { properties?: Record<string, unknown> } }>;
          };
        }
      >
    >;
  };
  const schema =
    mutated.paths?.['/v1/blueprints']?.['post']?.requestBody?.content?.['application/json']?.schema;
  if (schema) {
    schema.properties = { ...(schema.properties ?? {}), __driftMarker: { type: 'string' } };
  } else {
    mutated.info = {
      ...mutated.info,
      description: `${mutated.info?.description ?? ''} DRIFT-MARKER-${randomUUID()}`,
    };
  }
  return mutated;
}

describe('contract generation and drift checking (design D11; task 9.3)', () => {
  it('Contract drift fails CI', async () => {
    const current = await generateOpenApiDocument();
    const mutatedCommitted = mutateInputSchemaCopy(current);

    const committedDocumentPath = tempFilePath('mutated.openapi.json');
    writeFileSync(committedDocumentPath, serializeWithStableKeyOrder(mutatedCommitted));

    const result = await checkContract({ committedDocumentPath });

    expect(result.ok).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('an unmutated regeneration of the current contract reports no drift against itself', async () => {
    const current = await generateOpenApiDocument();

    const committedDocumentPath = tempFilePath('unmutated.openapi.json');
    writeFileSync(committedDocumentPath, serializeWithStableKeyOrder(current));

    const result = await checkContract({ committedDocumentPath });

    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('Contract cannot carry the tenant', async () => {
    // A standalone, minimal contract whose input declares `tenantId`
    // (spec "Contract cannot carry the tenant"; design D3). Not part of the
    // real `catalogContract`, which never does this by construction -- this
    // proves the *checker* catches it, independently of `catalogContract`
    // ever regressing.
    const leakyContract = oc.router({
      fake: {
        leak: oc
          .route({ method: 'POST', path: '/v1/fake' })
          .input(z.object({ tenantId: z.string(), value: z.string() }))
          .output(z.object({ ok: z.boolean() })),
      },
    });

    const leakyDocument = await generateOpenApiDocument(leakyContract);
    // Written verbatim as "committed", so this assertion is isolated to the
    // tenant-field scan: there is deliberately no drift to also fail on.
    const committedDocumentPath = tempFilePath('leaky.openapi.json');
    writeFileSync(committedDocumentPath, serializeWithStableKeyOrder(leakyDocument));

    const result = await checkContract({ router: leakyContract, committedDocumentPath });

    expect(result.ok).toBe(false);
    expect(result.reasons.some((reason: string) => reason.toLowerCase().includes('tenantid'))).toBe(
      true,
    );
  });

  it('an `actor` field in a procedure input also fails the check', async () => {
    const leakyContract = oc.router({
      fake: {
        leak: oc
          .route({ method: 'POST', path: '/v1/fake-actor' })
          .input(
            z.object({ actor: z.object({ type: z.string(), id: z.string() }), value: z.string() }),
          )
          .output(z.object({ ok: z.boolean() })),
      },
    });

    const leakyDocument = await generateOpenApiDocument(leakyContract);
    const committedDocumentPath = tempFilePath('leaky-actor.openapi.json');
    writeFileSync(committedDocumentPath, serializeWithStableKeyOrder(leakyDocument));

    const result = await checkContract({ router: leakyContract, committedDocumentPath });

    expect(result.ok).toBe(false);
    expect(result.reasons.some((reason: string) => reason.toLowerCase().includes('actor'))).toBe(
      true,
    );
  });

  it('the committed openapi/catalog.openapi.json passes the check', async () => {
    // No overrides: the real committed file (`OPENAPI_DOCUMENT_PATH`) against
    // the real `catalogContract`, exactly what `pnpm contract:check` runs.
    // `OPENAPI_DOCUMENT_PATH` is referenced (not just imported) so this test
    // also documents where the committed file is expected to live.
    expect(OPENAPI_DOCUMENT_PATH.endsWith('openapi/catalog.openapi.json')).toBe(true);

    const result = await checkContract();

    expect(result.reasons).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('generates a document that declares the real catalog contract', async () => {
    const document = await generateOpenApiDocument(catalogContract);
    expect(document.paths?.['/v1/blueprints']).toBeDefined();
    expect(document.paths?.['/v1/blueprints/{blueprint}/entities/{entity}']).toBeDefined();
  });
});
