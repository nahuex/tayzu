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
 *
 * ## 003-catalog-ui-core task 3.3 (design D5, D6)
 *
 * `openspec/changes/003-catalog-ui-core/design.md`, quoted verbatim:
 *
 * D6, Input: "`sort`: `identifier` (default), `title` or `updatedAt`; `order`: `asc`
 * (default) or `desc`. Both are query-string enums in the contract and the committed
 * document."
 *
 * D5, Procedure: "`search.entities`, `GET /v1/search/entities`, in the catalog contract
 * (the thirteenth catalog procedure). Input (query string): `q` (required), `limit`
 * (optional). Output: `{ items: [{ blueprint, identifier, title, match }] }`, where
 * `match` is `identifier` or `title`; no cursor (a ranked top-N list, not a page) and no
 * count. It is a `GET`, so it carries no CSRF header and is not `x-tayzu-risk: high`."
 *
 * D5, Limits: "`q` is trimmed and NFC-normalized, then must be 2 to 100 characters, with
 * no control character; `limit` defaults to 20 and is at most 50." D5 checks these in
 * the service (failing with `CATALOG_VALIDATION_FAILED` / `CATALOG_LIMIT_EXCEEDED`), so
 * the document is not required to carry them; the cases below only require that any
 * such constraint the document does carry agrees with D5 and D6.
 *
 * The operationId convention is the procedure key path joined with `.` (`entities.list`,
 * `blueprints.get`, ...), so the new procedure is `search.entities`. Design D3 / root
 * CLAUDE.md: `tenantId` and `actor` are host-supplied, never part of any input.
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

// ---------------------------------------------------------------------------
// 003-catalog-ui-core task 3.3 (design D5, D6)
// ---------------------------------------------------------------------------

const ENTITIES_LIST_PATH = '/v1/blueprints/{blueprint}/entities';
const SEARCH_ENTITIES_PATH = '/v1/search/entities';
const FORBIDDEN_CONTEXT_FIELDS = ['tenantId', 'actor'] as const;

/** Loads `document.paths[path].get`, asserting it exists and is an object. */
async function loadGetOperation(path: string): Promise<Record<string, unknown>> {
  const document = await generateOpenApiDocument(catalogContract);
  const pathItem = document.paths?.[path];
  expect(pathItem, `document.paths["${path}"] must exist`).toBeDefined();
  const operation = (pathItem as Record<string, unknown> | undefined)?.['get'];
  expect(isPlainObject(operation), `GET ${path} must exist`).toBe(true);
  return isPlainObject(operation) ? operation : {};
}

/** The parameter named `name`, asserted to exist and to be `in: query`. */
function queryParameter(
  operation: Record<string, unknown>,
  name: string,
  label: string,
): Record<string, unknown> {
  const parameters = operation['parameters'];
  const parameterList: unknown[] = Array.isArray(parameters) ? parameters : [];
  const parameter = parameterList.find(
    (candidate): candidate is Record<string, unknown> =>
      isPlainObject(candidate) && candidate['name'] === name,
  );
  expect(parameter, `${label} must declare the "${name}" parameter`).toBeDefined();
  expect(parameter?.['in'], `${label}: "${name}" must be an "in: query" parameter`).toBe('query');
  return parameter ?? {};
}

function parameterSchema(parameter: Record<string, unknown>): Record<string, unknown> {
  const schema = parameter['schema'];
  expect(isPlainObject(schema), `parameter "${String(parameter['name'])}" must have a schema`).toBe(
    true,
  );
  return isPlainObject(schema) ? schema : {};
}

/** The JSON schema of the operation's `200` `application/json` response. */
function okResponseSchema(operation: Record<string, unknown>): Record<string, unknown> {
  const responses = operation['responses'];
  const ok = isPlainObject(responses) ? responses['200'] : undefined;
  const content = isPlainObject(ok) ? ok['content'] : undefined;
  const json = isPlainObject(content) ? content['application/json'] : undefined;
  const schema = isPlainObject(json) ? json['schema'] : undefined;
  expect(isPlainObject(schema), 'the 200 response must declare an application/json schema').toBe(
    true,
  );
  return isPlainObject(schema) ? schema : {};
}

/** Every object key, and every string in a `required` array or a `name` field, at any depth. */
function collectNames(value: unknown, names: Set<string>): void {
  if (Array.isArray(value)) {
    for (const element of value) collectNames(element, names);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    names.add(key);
    if (key === 'name' && typeof child === 'string') names.add(child);
    if (key === 'required' && Array.isArray(child)) {
      for (const entry of child) if (typeof entry === 'string') names.add(entry);
    }
    collectNames(child, names);
  }
}

describe('entities.list sorting in the contract (003 task 3.3, design D6)', () => {
  it('declares "sort" as an optional query enum of identifier, title and updatedAt, defaulting to identifier', async () => {
    const operation = await loadGetOperation(ENTITIES_LIST_PATH);
    expect(operation['operationId']).toBe('entities.list');

    const label = `GET ${ENTITIES_LIST_PATH} (entities.list)`;
    const sort = queryParameter(operation, 'sort', label);
    expect(sort['required'], `${label}: "sort" is optional (design D6)`).not.toBe(true);

    const schema = parameterSchema(sort);
    expect(schema['type']).toBe('string');
    expect(schema['enum']).toEqual(['identifier', 'title', 'updatedAt']);
    if ('default' in schema) {
      expect(schema['default'], `${label}: the default sort is identifier (design D6)`).toBe(
        'identifier',
      );
    }
  });

  it('declares "order" as an optional query enum of asc and desc, defaulting to asc', async () => {
    const operation = await loadGetOperation(ENTITIES_LIST_PATH);
    expect(operation['operationId']).toBe('entities.list');

    const label = `GET ${ENTITIES_LIST_PATH} (entities.list)`;
    const order = queryParameter(operation, 'order', label);
    expect(order['required'], `${label}: "order" is optional (design D6)`).not.toBe(true);

    const schema = parameterSchema(order);
    expect(schema['type']).toBe('string');
    expect(schema['enum']).toEqual(['asc', 'desc']);
    if ('default' in schema) {
      expect(schema['default'], `${label}: the default order is asc (design D6)`).toBe('asc');
    }
  });

  it('keeps pageSize and cursor as query parameters and has no request body', async () => {
    const operation = await loadGetOperation(ENTITIES_LIST_PATH);
    const label = `GET ${ENTITIES_LIST_PATH} (entities.list)`;

    expect(operation['requestBody'], `${label} must not declare a requestBody`).toBeUndefined();
    queryParameter(operation, 'pageSize', label);
    queryParameter(operation, 'cursor', label);
    queryParameter(operation, 'sort', label);
    queryParameter(operation, 'order', label);
  });
});

describe('search.entities in the contract (003 task 3.3, design D5)', () => {
  const label = `GET ${SEARCH_ENTITIES_PATH} (search.entities)`;

  it('is routed as GET /v1/search/entities with operationId search.entities and no request body', async () => {
    const operation = await loadGetOperation(SEARCH_ENTITIES_PATH);

    expect(operation['operationId']).toBe('search.entities');
    expect(operation['requestBody'], `${label} must not declare a requestBody`).toBeUndefined();
  });

  it('takes exactly the query parameters q (required string) and limit (optional integer)', async () => {
    const operation = await loadGetOperation(SEARCH_ENTITIES_PATH);

    const parameters = operation['parameters'];
    expect(Array.isArray(parameters), `${label} must declare parameters`).toBe(true);
    const parameterList: unknown[] = Array.isArray(parameters) ? parameters : [];
    const declared = parameterList
      .map((parameter) =>
        isPlainObject(parameter) ? `${String(parameter['in'])}:${String(parameter['name'])}` : '',
      )
      .sort();
    expect(declared).toEqual(['query:limit', 'query:q']);

    const q = queryParameter(operation, 'q', label);
    expect(q['required'], `${label}: "q" is required (design D5)`).toBe(true);
    const qSchema = parameterSchema(q);
    expect(qSchema['type']).toBe('string');
    if ('minLength' in qSchema) expect(qSchema['minLength']).toBe(2);
    if ('maxLength' in qSchema) expect(qSchema['maxLength']).toBe(100);

    const limit = queryParameter(operation, 'limit', label);
    expect(limit['required'], `${label}: "limit" is optional (design D5)`).not.toBe(true);
    const limitSchema = parameterSchema(limit);
    expect(limitSchema['type']).toBe('integer');
    if ('default' in limitSchema) expect(limitSchema['default']).toBe(20);
  });

  it('returns { items: [{ blueprint, identifier, title, match }] } with no cursor and no count', async () => {
    const operation = await loadGetOperation(SEARCH_ENTITIES_PATH);
    const schema = okResponseSchema(operation);

    expect(schema['type']).toBe('object');
    const properties = schema['properties'];
    expect(isPlainObject(properties)).toBe(true);
    if (!isPlainObject(properties)) return;
    expect(Object.keys(properties), `${label}: no cursor and no count (design D5)`).toEqual([
      'items',
    ]);
    expect(schema['required']).toEqual(['items']);

    const items = properties['items'];
    expect(isPlainObject(items) ? items['type'] : undefined).toBe('array');
    const item = isPlainObject(items) ? items['items'] : undefined;
    expect(isPlainObject(item)).toBe(true);
    if (!isPlainObject(item)) return;

    expect(item['type']).toBe('object');
    const itemProperties = item['properties'];
    expect(isPlainObject(itemProperties)).toBe(true);
    if (!isPlainObject(itemProperties)) return;
    expect(Object.keys(itemProperties).sort()).toEqual([
      'blueprint',
      'identifier',
      'match',
      'title',
    ]);
    const itemRequired = item['required'];
    expect(
      Array.isArray(itemRequired) ? [...(itemRequired as unknown[])].sort() : itemRequired,
    ).toEqual(['blueprint', 'identifier', 'match', 'title']);

    for (const field of ['blueprint', 'identifier', 'title'] as const) {
      const fieldSchema = itemProperties[field];
      expect(isPlainObject(fieldSchema) ? fieldSchema['type'] : undefined).toBe('string');
    }
    const match = itemProperties['match'];
    expect(isPlainObject(match) ? match['type'] : undefined).toBe('string');
    expect(isPlainObject(match) ? match['enum'] : undefined).toEqual(['identifier', 'title']);
  });

  it('is not x-tayzu-risk: high', async () => {
    const operation = await loadGetOperation(SEARCH_ENTITIES_PATH);

    expect(operation['operationId']).toBe('search.entities');
    expect(operation['x-tayzu-risk'], `${label} is a GET and not high-risk (design D5)`).not.toBe(
      'high',
    );
  });
});

describe('neither entities.list nor search.entities declares tenantId or actor (003 task 3.3, design D3)', () => {
  it.each([
    { operationId: 'entities.list', path: ENTITIES_LIST_PATH },
    { operationId: 'search.entities', path: SEARCH_ENTITIES_PATH },
  ])(
    '$operationId carries no tenantId or actor in its parameters or request body',
    async ({ operationId, path }) => {
      const operation = await loadGetOperation(path);
      expect(operation['operationId']).toBe(operationId);

      const parameterNames = new Set<string>();
      collectNames(operation['parameters'], parameterNames);
      const bodyNames = new Set<string>();
      collectNames(operation['requestBody'], bodyNames);

      for (const forbidden of FORBIDDEN_CONTEXT_FIELDS) {
        expect(
          parameterNames.has(forbidden),
          `GET ${path} (${operationId}) parameters must not carry "${forbidden}"`,
        ).toBe(false);
        expect(
          bodyNames.has(forbidden),
          `GET ${path} (${operationId}) request body must not carry "${forbidden}"`,
        ).toBe(false);
      }
    },
  );
});
