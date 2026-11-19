/**
 * The oRPC contract (task 9.1, 9.3; design D2, D3, D11; spec "Published API
 * contract"). Contract-first: every procedure's input/output is a Zod
 * schema, the routes mirror design D11's table exactly (percent-encoding an
 * entity identifier containing `/` only matters once an actual HTTP
 * transport exists, from 002 onward -- there is none in 001, design D2), and
 * the three high-risk leaves (`blueprints.update`, `blueprints.delete`,
 * `entities.delete`) carry `x-tayzu-risk: high`.
 *
 * The context (`tenantId`, `actor`) is host-supplied only and never a field
 * of any input schema here (design D3). `./contract.ts`'s `checkContract`
 * (task 9.3) enforces that independently of `catalogContract` ever
 * regressing.
 *
 * Input schemas stay structural and permissive (for example
 * `schema.properties` is `Record<string, unknown>`): the authoritative
 * meta-validation is `domain/blueprint-definition.ts`'s hand-written parser
 * (design D6), run by the service layer inside the tenant transaction. This
 * layer's job is the public shape, not re-implementing that validation.
 * Output schemas are precise: they mirror `../service/blueprints.ts` and
 * `../service/entities.ts`'s plain TS interfaces field for field, since
 * their values always come from this package's own output builders.
 *
 * design D11's route table places the resource identifier in the URL as a
 * named path parameter (`{blueprint}`, `{entity}`), which is what
 * `OpenAPIGenerator` needs the input schema's property to be literally named
 * (`@orpc/openapi`'s `checkParamsSchema`). Every plain TS service interface
 * (`GetBlueprintInput.identifier`, `GetEntityInput.identifier`, ...) and
 * every in-process caller in 001 uses `identifier` instead (there is no HTTP
 * transport to extract a URL segment from yet). `withBlueprintPathParam` and
 * `withEntityPathParam` bridge the two with a `z.preprocess` rename, so the
 * same schema accepts either key: `@orpc/zod/zod4`'s converter resolves a
 * preprocess pipe's "input" JSON Schema to its wrapped object schema (not to
 * "any"), so the renamed field still satisfies `checkParamsSchema`.
 *
 * This module is browser-safe (003 design D4): its imports, type-only ones
 * included, are only `@orpc/contract` and `zod`, so `@tayzu/web` can consume
 * it through the `@tayzu/catalog/contract` export. The OpenAPI document
 * generation and drift check stay in `./contract.ts`, which re-exports
 * `catalogContract`.
 */
import { oc, type OpenAPI } from '@orpc/contract';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

/** `Record<string, string>` (`CreateBlueprintInput.title`): loose on input, the domain owns locale/length rules (D6). */
const localizedTextInputSchema = z.record(z.string(), z.string());

/** `domain/localized-text.ts`'s `LocalizedText`: `en` required, `es` optional. */
const localizedTextOutputSchema = z.object({ en: z.string(), es: z.string().optional() });

/** `CreateBlueprintInput.schema`/`statusSchema`: structural only (D6 owns the property-schema subset). */
const propertySchemaInputSchema = z.object({
  properties: z.record(z.string(), z.unknown()).optional(),
  required: z.array(z.string()).optional(),
});

const relationDefinitionInputSchema = z.object({
  title: localizedTextInputSchema,
  target: z.string(),
  many: z.boolean().optional(),
  required: z.boolean().optional(),
});

const relationsInputSchema = z.record(z.string(), relationDefinitionInputSchema).optional();

const stringFormatOutputSchema = z.enum(['date-time', 'url', 'email', 'markdown', 'yaml']);

/** `domain/property-schema.ts`'s `StringPropertyDefinition`. */
const stringPropertyOutputSchema = z.object({
  type: z.literal('string'),
  title: localizedTextOutputSchema,
  format: stringFormatOutputSchema.optional(),
  minLength: z.number().optional(),
  maxLength: z.number().optional(),
  pattern: z.string().optional(),
  enum: z.array(z.string()).optional(),
  default: z.string().optional(),
});

/** `domain/property-schema.ts`'s `NumberPropertyDefinition`. */
const numberPropertyOutputSchema = z.object({
  type: z.enum(['number', 'integer']),
  title: localizedTextOutputSchema,
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  enum: z.array(z.number()).optional(),
  default: z.number().optional(),
});

/** `domain/property-schema.ts`'s `BooleanPropertyDefinition`. */
const booleanPropertyOutputSchema = z.object({
  type: z.literal('boolean'),
  title: localizedTextOutputSchema,
  default: z.boolean().optional(),
});

/** `domain/property-schema.ts`'s `ArrayItemDefinition`: the property schemas above, minus `title`. */
const arrayItemOutputSchema = z.union([
  stringPropertyOutputSchema.omit({ title: true }),
  numberPropertyOutputSchema.omit({ title: true }),
  booleanPropertyOutputSchema.omit({ title: true }),
]);

/** `domain/property-schema.ts`'s `ArrayPropertyDefinition`. */
const arrayPropertyOutputSchema = z.object({
  type: z.literal('array'),
  title: localizedTextOutputSchema,
  items: arrayItemOutputSchema,
  minItems: z.number().optional(),
  maxItems: z.number().optional(),
  uniqueItems: z.boolean().optional(),
});

/** `domain/property-schema.ts`'s `ObjectPropertyDefinition`. */
const objectPropertyOutputSchema = z.object({
  type: z.literal('object'),
  title: localizedTextOutputSchema,
});

/** `domain/property-schema.ts`'s `PropertyDefinition` union. */
const propertyDefinitionOutputSchema = z.union([
  stringPropertyOutputSchema,
  numberPropertyOutputSchema,
  booleanPropertyOutputSchema,
  arrayPropertyOutputSchema,
  objectPropertyOutputSchema,
]);

/** `domain/blueprint-definition.ts`'s `ParsedPropertySchema`. */
const propertySchemaOutputSchema = z.object({
  properties: z.record(z.string(), propertyDefinitionOutputSchema),
  required: z.array(z.string()),
});

/** `domain/relation-definition.ts`'s `RelationDefinition`. */
const relationDefinitionOutputSchema = z.object({
  title: localizedTextOutputSchema,
  target: z.string(),
  many: z.boolean(),
  required: z.boolean(),
});

const actorTypeOutputSchema = z.enum(['user', 'agent', 'integration', 'system']);

/** `domain/context.ts`'s `Principal`, used bare for `onBehalfOf`. */
const principalOutputSchema = z.object({ type: actorTypeOutputSchema, id: z.string() });

/** `domain/context.ts`'s `CatalogContext['actor']`: a `Principal` plus an optional delegating `Principal`. */
const actorOutputSchema = principalOutputSchema.extend({
  onBehalfOf: principalOutputSchema.optional(),
});

/** `../service/blueprints.ts`'s `BlueprintOutput`. */
const blueprintOutputSchema = z.object({
  identifier: z.string(),
  title: localizedTextOutputSchema,
  description: localizedTextOutputSchema.optional(),
  icon: z.string().optional(),
  schema: propertySchemaOutputSchema,
  statusSchema: propertySchemaOutputSchema.optional(),
  relations: z.record(z.string(), relationDefinitionOutputSchema),
  version: z.number().int(),
  createdAt: z.string(),
  createdBy: actorOutputSchema,
  updatedAt: z.string(),
  updatedBy: actorOutputSchema,
});

const blueprintListOutputSchema = z.object({
  items: z.array(blueprintOutputSchema).readonly(),
  cursor: z.string().optional(),
});

const relationValueOutputSchema = z.union([z.string(), z.array(z.string())]);

/** `../service/entities.ts`'s `EntitySpecWriteInput`: loose, the domain validates cardinality and shape. */
const entitySpecWriteInputSchema = z
  .object({
    properties: z.record(z.string(), z.unknown()).optional(),
    relations: z.record(z.string(), z.unknown()).optional(),
  })
  .optional();

/** `../service/entities.ts`'s `EntityStatusOutput`. */
const entityStatusOutputSchema = z.object({
  properties: z.record(z.string(), z.unknown()),
  relations: z.record(z.string(), relationValueOutputSchema),
  observedGeneration: z.number().int(),
  observedAt: z.string(),
  source: z.string(),
});

/** `../service/entities.ts`'s `EntityOutput`. */
const entityOutputSchema = z.object({
  blueprint: z.string(),
  identifier: z.string(),
  title: z.string(),
  icon: z.string().optional(),
  spec: z.object({
    properties: z.record(z.string(), z.unknown()),
    relations: z.record(z.string(), relationValueOutputSchema),
  }),
  status: entityStatusOutputSchema.nullable(),
  generation: z.number().int(),
  version: z.number().int(),
  createdAt: z.string(),
  createdBy: actorOutputSchema,
  updatedAt: z.string(),
  updatedBy: actorOutputSchema,
});

const entityListOutputSchema = z.object({
  items: z.array(entityOutputSchema).readonly(),
  cursor: z.string().optional(),
});

/** `../service/entities.ts`'s `UpsertEntityOutput`. */
const upsertEntityOutputSchema = entityOutputSchema.extend({
  outcome: z.enum(['created', 'updated', 'unchanged']),
});

const relatedEntitySummaryOutputSchema = z.object({
  blueprint: z.string(),
  identifier: z.string(),
  title: z.string(),
});

/** `../service/entities.ts`'s `RelatedEntityItem`. */
const relatedEntityItemOutputSchema = z.object({
  relation: z.string(),
  scope: z.enum(['spec', 'status']),
  sourceBlueprint: z.string(),
  entity: relatedEntitySummaryOutputSchema,
});

const listRelatedOutputSchema = z.object({
  items: z.array(relatedEntityItemOutputSchema).readonly(),
  cursor: z.string().optional(),
});

/** 003 design D5: a ranked top-N list, so no cursor and no count. */
const searchEntitiesOutputSchema = z.object({
  items: z
    .array(
      z.object({
        blueprint: z.string(),
        identifier: z.string(),
        title: z.string(),
        match: z.enum(['identifier', 'title']),
      }),
    )
    .readonly(),
});

// ---------------------------------------------------------------------------
// Path-parameter bridging (see the module doc comment above)
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Renames a raw input's `identifier` field to `pathParam` before Zod
 * validates it, unless `pathParam` is already present (a future HTTP caller
 * supplying it straight from the URL) or `identifier` is absent.
 */
function renameIdentifierTo(pathParam: string): (raw: unknown) => unknown {
  return (raw) => {
    if (!isPlainObject(raw) || pathParam in raw || !('identifier' in raw)) return raw;
    const { identifier, ...rest } = raw;
    return { ...rest, [pathParam]: identifier };
  };
}

/** A blueprint-level leaf (`GetBlueprintInput`, `DeleteBlueprintInput`, `UpdateBlueprintInput`): path `{blueprint}`. */
function withBlueprintPathParam<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.preprocess(
    renameIdentifierTo('blueprint'),
    z.object({ blueprint: z.string(), ...shape }),
  );
}

/** An entity-level leaf (`GetEntityInput`, ...): path `{blueprint}/entities/{entity}`. `blueprint` needs no rename. */
function withEntityPathParam<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.preprocess(
    renameIdentifierTo('entity'),
    z.object({ blueprint: z.string(), entity: z.string(), ...shape }),
  );
}

// ---------------------------------------------------------------------------
// Input schemas (`../service/blueprints.ts`, `../service/entities.ts`)
// ---------------------------------------------------------------------------

const createBlueprintInputSchema = z.object({
  identifier: z.string(),
  title: localizedTextInputSchema,
  description: localizedTextInputSchema.optional(),
  icon: z.string().optional(),
  schema: propertySchemaInputSchema,
  statusSchema: propertySchemaInputSchema.optional(),
  relations: relationsInputSchema,
});

/**
 * Integer query fields arrive over HTTP as strings (design D13 query-string
 * parity). Only a canonical decimal integer string is converted; anything
 * else is left for `z.number().int()` to reject. The preprocess keeps the
 * JSON Schema type `integer` in the generated document.
 */
const queryIntegerSchema = z.preprocess(
  (raw) => (typeof raw === 'string' && /^-?\d{1,15}$/.test(raw) ? Number(raw) : raw),
  z.number().int(),
);

const listBlueprintsInputSchema = z.object({
  pageSize: queryIntegerSchema.optional(),
  cursor: z.string().optional(),
});

const getBlueprintInputSchema = withBlueprintPathParam({});

const updateBlueprintInputSchema = withBlueprintPathParam({
  title: localizedTextInputSchema,
  description: localizedTextInputSchema.optional(),
  icon: z.string().optional(),
  schema: propertySchemaInputSchema,
  statusSchema: propertySchemaInputSchema.optional(),
  relations: relationsInputSchema,
  expectedVersion: z.number().int().optional(),
});

const deleteBlueprintInputSchema = withBlueprintPathParam({});

const createEntityInputSchema = z.object({
  blueprint: z.string(),
  identifier: z.string(),
  title: z.string(),
  icon: z.string().optional(),
  spec: entitySpecWriteInputSchema,
});

/** 003 design D6: `sort` defaults to `identifier`, `order` to `asc` (the service applies the defaults). */
const listEntitiesInputSchema = z.object({
  blueprint: z.string(),
  pageSize: queryIntegerSchema.optional(),
  cursor: z.string().optional(),
  sort: z.enum(['identifier', 'title', 'updatedAt']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

const getEntityInputSchema = withEntityPathParam({});

const upsertEntityInputSchema = withEntityPathParam({
  title: z.string(),
  icon: z.string().optional(),
  spec: entitySpecWriteInputSchema,
  mode: z.enum(['replace', 'merge']),
  expectedVersion: z.number().int().optional(),
});

/**
 * Query-string booleans arrive as the strings `"true"`/`"false"`; anything
 * else is left for `z.boolean()` to reject. The preprocess keeps the JSON
 * Schema type `boolean` in the generated document.
 */
const queryBooleanSchema = z.preprocess(
  (raw) => (raw === 'true' ? true : raw === 'false' ? false : raw),
  z.boolean(),
);

/**
 * `entities.delete` uses `inputStructure: 'detailed'` (design D13): the
 * runtime reads `params` and `query` separately, so `detachReferences` comes
 * from the query string. The preprocess also accepts the flat shape every
 * in-process caller uses (`blueprint`, `identifier`/`entity`,
 * `detachReferences`) and rewrites it to `{ params, query }`.
 */
const deleteEntityInputSchema = z.preprocess(
  (raw) => {
    if (!isPlainObject(raw) || 'params' in raw || 'query' in raw) return raw;
    const { blueprint, identifier, entity, detachReferences } = raw;
    return {
      params: { blueprint, entity: entity ?? identifier },
      query: detachReferences === undefined ? {} : { detachReferences },
    };
  },
  z.object({
    params: z.object({ blueprint: z.string(), entity: z.string() }),
    query: z.object({ detachReferences: queryBooleanSchema.optional() }).default({}),
  }),
);

const writeEntityStatusInputSchema = withEntityPathParam({
  properties: z.record(z.string(), z.unknown()).optional(),
  relations: z.record(z.string(), z.unknown()).optional(),
  observedGeneration: z.number().int(),
  source: z.string(),
});

const listRelatedInputSchema = withEntityPathParam({
  direction: z.enum(['forward', 'backward']),
  scope: z.enum(['spec', 'status', 'both']).optional(),
  pageSize: queryIntegerSchema.optional(),
  cursor: z.string().optional(),
});

/**
 * 003 design D5: `q` is required and `limit` optional. Their bounds (2 to 100
 * characters after trimming and NFC normalization, a limit of at most 50) are
 * checked by the service, as `pageSize` is, so the error codes and issue
 * paths stay the catalog's own.
 */
const searchEntitiesInputSchema = z.object({
  q: z.string(),
  limit: queryIntegerSchema.optional(),
});

// ---------------------------------------------------------------------------
// The contract (design D11)
// ---------------------------------------------------------------------------

/** design D11: "High-risk procedures ... carry `x-tayzu-risk: high` in the OpenAPI document." */
function markHighRisk(current: OpenAPI.OperationObject): OpenAPI.OperationObject {
  const marked = { ...current, 'x-tayzu-risk': 'high' };
  return marked;
}

export const catalogContract = oc.router({
  blueprints: {
    create: oc
      .route({ method: 'POST', path: '/v1/blueprints' })
      .input(createBlueprintInputSchema)
      .output(blueprintOutputSchema),
    list: oc
      .route({ method: 'GET', path: '/v1/blueprints' })
      .input(listBlueprintsInputSchema)
      .output(blueprintListOutputSchema),
    get: oc
      .route({ method: 'GET', path: '/v1/blueprints/{blueprint}' })
      .input(getBlueprintInputSchema)
      .output(blueprintOutputSchema),
    update: oc
      .route({ method: 'PUT', path: '/v1/blueprints/{blueprint}', spec: markHighRisk })
      .input(updateBlueprintInputSchema)
      .output(blueprintOutputSchema),
    delete: oc
      .route({ method: 'DELETE', path: '/v1/blueprints/{blueprint}', spec: markHighRisk })
      .input(deleteBlueprintInputSchema)
      .output(z.void()),
  },
  entities: {
    create: oc
      .route({ method: 'POST', path: '/v1/blueprints/{blueprint}/entities' })
      .input(createEntityInputSchema)
      .output(entityOutputSchema),
    list: oc
      .route({ method: 'GET', path: '/v1/blueprints/{blueprint}/entities' })
      .input(listEntitiesInputSchema)
      .output(entityListOutputSchema),
    get: oc
      .route({ method: 'GET', path: '/v1/blueprints/{blueprint}/entities/{entity}' })
      .input(getEntityInputSchema)
      .output(entityOutputSchema),
    upsert: oc
      .route({ method: 'PUT', path: '/v1/blueprints/{blueprint}/entities/{entity}' })
      .input(upsertEntityInputSchema)
      .output(upsertEntityOutputSchema),
    delete: oc
      .route({
        method: 'DELETE',
        path: '/v1/blueprints/{blueprint}/entities/{entity}',
        inputStructure: 'detailed',
        spec: markHighRisk,
      })
      .input(deleteEntityInputSchema)
      .output(z.void()),
    writeStatus: oc
      .route({ method: 'PUT', path: '/v1/blueprints/{blueprint}/entities/{entity}/status' })
      .input(writeEntityStatusInputSchema)
      .output(entityOutputSchema),
    listRelated: oc
      .route({ method: 'GET', path: '/v1/blueprints/{blueprint}/entities/{entity}/related' })
      .input(listRelatedInputSchema)
      .output(listRelatedOutputSchema),
  },
  search: {
    entities: oc
      .route({ method: 'GET', path: '/v1/search/entities' })
      .input(searchEntitiesInputSchema)
      .output(searchEntitiesOutputSchema),
  },
});
