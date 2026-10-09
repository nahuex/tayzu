/**
 * Fixture for task 10.2 (002 design D12; spec catalog-core "Incompatible
 * entities the caller cannot read are redacted" and the blueprint-deletion
 * equivalent).
 *
 * Wraps the real Cerbos client. Every batch `checkResources` whose resources
 * are all of kind `catalog_entity` is answered from `readable` by the
 * `resource.id` it receives (an id is allowed iff it is in the set, for any
 * action): by identifier (the fixed placeholder for a `_user` entity, Q119)
 * for an entity operation's own check (`pipeline.ts:372`) and for
 * `mayUpdateReferrer`'s check (`entities.ts:884`), and by position for the
 * D12 redaction batch. A blueprint operation's own check (`catalog_blueprint`)
 * still reaches the real policies, like every request that is not all
 * `catalog_entity`. The wiring is the unit under test, not Cerbos policy
 * content: the current policies have no rule that hides some entities from an
 * admin.
 */
import type { CerbosClient } from '@tayzu/authz';

import { authz } from './authz-test-helpers.js';

export interface RedactionBatch {
  readonly ids: readonly string[];
  readonly attrTenantIds: readonly unknown[];
}

interface BatchRequest {
  readonly resources: readonly {
    readonly resource: {
      readonly kind: string;
      readonly id: string;
      readonly attr?: Readonly<Record<string, unknown>>;
    };
  }[];
}

export function redactingAuthz(readable: ReadonlySet<string>): {
  readonly client: CerbosClient;
  readonly batches: RedactionBatch[];
} {
  const batches: RedactionBatch[] = [];
  const client = new Proxy(authz, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (prop === 'checkResources') {
        return (request: BatchRequest) => {
          const isRedactionBatch =
            request.resources.length > 0 &&
            request.resources.every((entry) => entry.resource.kind === 'catalog_entity');
          if (!isRedactionBatch) {
            return (value as (r: BatchRequest) => Promise<unknown>).call(target, request);
          }
          batches.push({
            ids: request.resources.map((entry) => entry.resource.id),
            attrTenantIds: request.resources.map((entry) => entry.resource.attr?.['tenantId']),
          });
          return Promise.resolve({
            cerbosCallId: 'redaction-test',
            results: request.resources.map(({ resource }) => ({
              resource: { kind: resource.kind, id: resource.id },
              isAllowed: () => readable.has(resource.id),
            })),
          });
        };
      }
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
  return { client, batches };
}
