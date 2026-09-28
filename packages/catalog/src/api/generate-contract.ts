/**
 * CLI entry point for `pnpm contract:generate` (task 9.3; design D11).
 * Regenerates `openapi/catalog.openapi.json` from `catalogContract`, with
 * stable key order, and writes it to disk. Run with `tsx` (root CLAUDE.md).
 * Never edit the generated file by hand.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { generateOpenApiDocument, OPENAPI_DOCUMENT_PATH, serializeWithStableKeyOrder } from './contract.js';

const document = await generateOpenApiDocument();
await mkdir(dirname(OPENAPI_DOCUMENT_PATH), { recursive: true });
await writeFile(OPENAPI_DOCUMENT_PATH, serializeWithStableKeyOrder(document), 'utf8');
