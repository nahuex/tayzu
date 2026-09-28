/**
 * The catalog oRPC router (task 9.1; design D2, D3, D11). Implements
 * `catalogContract` by delegating to the given services. Tests call it
 * in-process through `createRouterClient(router, { context })` (design D2);
 * no Fastify listener mounts it before 002.
 *
 * `context` here is the raw, unvalidated, host-supplied value handed to the
 * client -- `defineCatalogOperation` (`../service/pipeline.js`) is the only
 * place that ever calls `parseCatalogContext` (design D3). Every service
 * call is wrapped by `run`, which converts a thrown error through
 * `./errors.js`'s `toApiError` before it leaves this module (task 9.2).
 *
 * `./contract.ts`'s path-level leaves (`blueprints.get`/`update`/`delete`,
 * every `entities.*` leaf but `create`/`list`) rename the OpenAPI route's
 * path-parameter field (`blueprint`, `entity`) back to the plain TS service
 * field (`identifier`) here, the other way around from the contract's own
 * `identifier` -> path-parameter rename.
 */
import { implement } from '@orpc/server';

import type { BlueprintService } from '../service/blueprints.js';
import type { EntityService } from '../service/entities.js';
import { catalogContract } from './contract.js';
import { toApiError } from './errors.js';

export interface CatalogRouterServices {
  readonly blueprints: BlueprintService;
  readonly entities: EntityService;
}

/** Runs one service call, converting any thrown error through `toApiError` before it leaves the router (task 9.2). */
async function run<Output>(operation: () => Promise<Output>): Promise<Output> {
  try {
    return await operation();
  } catch (error) {
    throw toApiError(error);
  }
}

/** The raw, host-supplied context every leaf below forwards unvalidated (design D3). */
type RawContext = Record<string, unknown>;

export function createCatalogRouter(services: CatalogRouterServices) {
  const os = implement(catalogContract).$context<RawContext>();

  return {
    blueprints: {
      create: os.blueprints.create.handler(({ context, input }) =>
        run(() => services.blueprints.create(context, input)),
      ),
      list: os.blueprints.list.handler(({ context, input }) =>
        run(() => services.blueprints.list(context, input)),
      ),
      get: os.blueprints.get.handler(({ context, input }) =>
        run(() => services.blueprints.get(context, { identifier: input.blueprint })),
      ),
      update: os.blueprints.update.handler(({ context, input }) =>
        run(() =>
          services.blueprints.update(context, {
            identifier: input.blueprint,
            title: input.title,
            description: input.description,
            icon: input.icon,
            schema: input.schema,
            statusSchema: input.statusSchema,
            relations: input.relations,
            expectedVersion: input.expectedVersion,
          }),
        ),
      ),
      delete: os.blueprints.delete.handler(({ context, input }) =>
        run(() => services.blueprints.delete(context, { identifier: input.blueprint })),
      ),
    },
    entities: {
      create: os.entities.create.handler(({ context, input }) =>
        run(() => services.entities.create(context, input)),
      ),
      list: os.entities.list.handler(({ context, input }) =>
        run(() => services.entities.list(context, input)),
      ),
      get: os.entities.get.handler(({ context, input }) =>
        run(() =>
          services.entities.get(context, { blueprint: input.blueprint, identifier: input.entity }),
        ),
      ),
      upsert: os.entities.upsert.handler(({ context, input }) =>
        run(() =>
          services.entities.upsert(context, {
            blueprint: input.blueprint,
            identifier: input.entity,
            title: input.title,
            icon: input.icon,
            spec: input.spec,
            mode: input.mode,
            expectedVersion: input.expectedVersion,
          }),
        ),
      ),
      delete: os.entities.delete.handler(({ context, input }) =>
        run(() =>
          services.entities.delete(context, {
            blueprint: input.blueprint,
            identifier: input.entity,
            detachReferences: input.detachReferences,
          }),
        ),
      ),
      writeStatus: os.entities.writeStatus.handler(({ context, input }) =>
        run(() =>
          services.entities.writeStatus(context, {
            blueprint: input.blueprint,
            identifier: input.entity,
            properties: input.properties,
            relations: input.relations,
            observedGeneration: input.observedGeneration,
            source: input.source,
          }),
        ),
      ),
      listRelated: os.entities.listRelated.handler(({ context, input }) =>
        run(() =>
          services.entities.listRelated(context, {
            blueprint: input.blueprint,
            identifier: input.entity,
            direction: input.direction,
            scope: input.scope,
            pageSize: input.pageSize,
            cursor: input.cursor,
          }),
        ),
      ),
    },
  };
}
