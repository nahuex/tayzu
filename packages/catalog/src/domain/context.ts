/**
 * The host-supplied catalog context (spec Conventions, "Catalog context";
 * design D3). `parseCatalogContext` fails closed: it never defaults a
 * missing `tenantId`, never invents an actor, and never accepts a shape it
 * cannot fully validate.
 */
import { CatalogError } from './errors.js';

export type ActorType = 'user' | 'agent' | 'integration' | 'system';

export interface Principal {
  type: ActorType;
  id: string;
}

export interface CatalogContext {
  tenantId: string;
  actor: Principal & { onBehalfOf?: Principal };
}

const TENANT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ACTOR_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * The allowed actor types (spec Conventions). Membership is checked on a
 * value read out with bracket access, never on `<...>.type` itself, so the
 * actor type stays a validated piece of data rather than a code-path switch
 * (design D3).
 */
const ACTOR_TYPES: ReadonlySet<string> = new Set(['user', 'agent', 'integration', 'system']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectContext(reason: 'missing_tenant' | 'invalid_actor'): never {
  throw new CatalogError('CATALOG_CONTEXT_REQUIRED', 'Catalog context is missing or invalid', {
    details: { reason },
  });
}

/**
 * Validates the shape shared by `actor` and `actor.onBehalfOf`. Returns a
 * fresh `Principal`, or `undefined` when the value is not well-formed.
 */
function parsePrincipal(value: unknown): Principal | undefined {
  if (!isRecord(value)) return undefined;

  const type = value['type'];
  const id = value['id'];

  if (typeof type !== 'string' || !ACTOR_TYPES.has(type)) return undefined;
  if (typeof id !== 'string' || !ACTOR_ID_PATTERN.test(id)) return undefined;

  return { type: type as ActorType, id };
}

export function parseCatalogContext(input: unknown): CatalogContext {
  if (!isRecord(input)) rejectContext('missing_tenant');

  const tenantId = input['tenantId'];
  if (typeof tenantId !== 'string' || !TENANT_ID_PATTERN.test(tenantId)) {
    rejectContext('missing_tenant');
  }

  const rawActor = input['actor'];
  const actor = parsePrincipal(rawActor);
  if (!actor) rejectContext('invalid_actor');

  const context: CatalogContext = { tenantId, actor };

  if (isRecord(rawActor) && 'onBehalfOf' in rawActor) {
    const onBehalfOf = parsePrincipal(rawActor['onBehalfOf']);
    if (!onBehalfOf) rejectContext('invalid_actor');
    context.actor = { ...actor, onBehalfOf };
  }

  return context;
}
