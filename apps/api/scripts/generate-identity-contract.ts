/**
 * CLI entry point for `contract:generate` (task 14.1c): writes
 * `openapi/identity.openapi.json`. Never edit the generated file by hand.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  generateIdentityOpenApiDocument,
  IDENTITY_OPENAPI_DOCUMENT_PATH,
  serializeWithStableKeyOrder,
} from '../src/identity-openapi.js';

const document = await generateIdentityOpenApiDocument();
await mkdir(dirname(IDENTITY_OPENAPI_DOCUMENT_PATH), { recursive: true });
await writeFile(IDENTITY_OPENAPI_DOCUMENT_PATH, serializeWithStableKeyOrder(document), 'utf8');
