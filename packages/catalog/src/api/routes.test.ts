/**
 * Unit test for task 9.1's follow-up (openspec/changes/archive/2026-09-28-001-catalog-core,
 * design D11's route table; spec "Published API contract"). No database is
 * needed: generating the OpenAPI document only introspects the contract's
 * Zod schemas and route metadata -- this is a plain `*.test.ts`, not an
 * `*.int.test.ts`.
 *
 * This test loads the generated OpenAPI document the same way
 * `contract-check.test.ts` does, in its "generates a document that declares
 * the real catalog contract" test: `generateOpenApiDocument(catalogContract)`
 * from `./contract.ts` (see that file's module doc comment for the assumed
 * `catalogContract`/`generateOpenApiDocument` shape). `contract-check.test.ts`
 * itself is not modified.
 *
 * D11's route table (quoted verbatim from
 * `openspec/changes/archive/2026-09-28-001-catalog-core/design.md`):
 *
 * | Procedure | OpenAPI route |
 * |---|---|
 * | `blueprints.create` | `POST /v1/blueprints` |
 * | `blueprints.list` | `GET /v1/blueprints` |
 * | `blueprints.get` | `GET /v1/blueprints/{blueprint}` |
 * | `blueprints.update` | `PUT /v1/blueprints/{blueprint}` |
 * | `blueprints.delete` | `DELETE /v1/blueprints/{blueprint}` |
 * | `entities.create` | `POST /v1/blueprints/{blueprint}/entities` |
 * | `entities.list` | `GET /v1/blueprints/{blueprint}/entities` |
 * | `entities.get` | `GET /v1/blueprints/{blueprint}/entities/{entity}` |
 * | `entities.upsert` | `PUT /v1/blueprints/{blueprint}/entities/{entity}` (body `mode: replace\|merge`) |
 * | `entities.delete` | `DELETE /v1/blueprints/{blueprint}/entities/{entity}?detachReferences=` |
 * | `entities.writeStatus` | `PUT /v1/blueprints/{blueprint}/entities/{entity}/status` |
 * | `entities.listRelated` | `GET /v1/blueprints/{blueprint}/entities/{entity}/related?direction=forward\|backward&scope=spec\|status` |
 *
 * The `?...=` suffixes on `entities.delete` and `entities.listRelated` mean
 * those fields are query parameters, not a request body: many HTTP clients
 * and proxies drop a body on `DELETE`/`GET` requests, so D11 puts every
 * non-path input for those two methods in the query string instead. For
 * every operation this test asserts the exact method and path (the path
 * without its `?...` suffix, since a path template never includes a query
 * string), and, for every `GET`/`DELETE` operation, that the OpenAPI
 * operation has no `requestBody` and that every non-path input field is
 * declared as an `in: query` parameter.
 */
import { describe, expect, it } from 'vitest';

import { catalogContract, generateOpenApiDocument } from './contract.js';

interface QueryParamExpectation {
  readonly name: string;
  readonly type?: string;
}

interface OperationExpectation {
  readonly operationId: string;
  readonly method: 'get' | 'post' | 'put' | 'delete';
  readonly path: string;
  /**
   * Present only for `get`/`delete` operations: every non-path input field,
   * expected as an `in: query` parameter. Absent for `post`/`put`, whose
   * non-path fields belong in the JSON body (D11 does not restrict those).
   */
  readonly queryParams?: readonly QueryParamExpectation[];
}

/** D11's route table, quoted in the module doc comment above. */
const OPERATIONS: readonly OperationExpectation[] = [
  { operationId: 'blueprints.create', method: 'post', path: '/v1/blueprints' },
  {
    operationId: 'blueprints.list',
    method: 'get',
    path: '/v1/blueprints',
    queryParams: [{ name: 'pageSize' }, { name: 'cursor' }],
  },
  {
    operationId: 'blueprints.get',
    method: 'get',
    path: '/v1/blueprints/{blueprint}',
    queryParams: [],
  },
  { operationId: 'blueprints.update', method: 'put', path: '/v1/blueprints/{blueprint}' },
  {
    operationId: 'blueprints.delete',
    method: 'delete',
    path: '/v1/blueprints/{blueprint}',
    queryParams: [],
  },
  { operationId: 'entities.create', method: 'post', path: '/v1/blueprints/{blueprint}/entities' },
  {
    operationId: 'entities.list',
    method: 'get',
    path: '/v1/blueprints/{blueprint}/entities',
    queryParams: [{ name: 'pageSize' }, { name: 'cursor' }],
  },
  {
    operationId: 'entities.get',
    method: 'get',
    path: '/v1/blueprints/{blueprint}/entities/{entity}',
    queryParams: [],
  },
  {
    operationId: 'entities.upsert',
    method: 'put',
    path: '/v1/blueprints/{blueprint}/entities/{entity}',
  },
  {
    operationId: 'entities.delete',
    method: 'delete',
    path: '/v1/blueprints/{blueprint}/entities/{entity}',
    queryParams: [{ name: 'detachReferences', type: 'boolean' }],
  },
  {
    operationId: 'entities.writeStatus',
    method: 'put',
    path: '/v1/blueprints/{blueprint}/entities/{entity}/status',
  },
  {
    operationId: 'entities.listRelated',
    method: 'get',
    path: '/v1/blueprints/{blueprint}/entities/{entity}/related',
    queryParams: [
      { name: 'direction' },
      { name: 'scope' },
      { name: 'pageSize' },
      { name: 'cursor' },
    ],
  },
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('D11 route table: method, path and query-vs-body placement (task 9.1 follow-up)', () => {
  it.each(OPERATIONS)(
    '$operationId is routed as $method $path, matching design D11 exactly',
    async ({ operationId, method, path, queryParams }) => {
      const document = await generateOpenApiDocument(catalogContract);

      const pathItem = document.paths?.[path];
      expect(pathItem, `document.paths["${path}"] must exist for ${operationId}`).toBeDefined();

      const operation = (pathItem as Record<string, unknown> | undefined)?.[method];
      expect(
        operation,
        `${method.toUpperCase()} ${path} must exist for ${operationId}`,
      ).toBeDefined();
      expect(isPlainObject(operation)).toBe(true);
      if (!isPlainObject(operation)) return;

      expect(operation['operationId']).toBe(operationId);

      if (queryParams === undefined) return; // POST/PUT: no query-vs-body constraint asserted here.

      // D11: GET and DELETE operations never carry a request body -- every
      // non-path input field must be a query parameter instead, because a
      // body on these methods is not reliably transmitted end to end.
      expect(
        operation['requestBody'],
        `${method.toUpperCase()} ${path} (${operationId}) must not declare a requestBody (design D11)`,
      ).toBeUndefined();

      const parameters = operation['parameters'];
      expect(Array.isArray(parameters)).toBe(true);
      const parameterList = Array.isArray(parameters) ? parameters : [];

      for (const expected of queryParams) {
        const parameter = parameterList.find(
          (candidate): candidate is Record<string, unknown> =>
            isPlainObject(candidate) && candidate['name'] === expected.name,
        );
        expect(
          parameter,
          `${method.toUpperCase()} ${path} (${operationId}) must declare "${expected.name}" as a parameter (design D11)`,
        ).toBeDefined();
        expect(
          parameter?.['in'],
          `${method.toUpperCase()} ${path} (${operationId}): "${expected.name}" must be an "in: query" parameter, not a request-body field (design D11)`,
        ).toBe('query');

        if (expected.type !== undefined) {
          const schema = parameter?.['schema'];
          expect(isPlainObject(schema) ? schema['type'] : undefined).toBe(expected.type);
        }
      }
    },
  );
});
