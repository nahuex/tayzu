/**
 * Entity attributes for Cerbos (task 23.2; design Q34, D9, D10, D11).
 *
 * The pipeline calls these before the authorization check, inside a
 * tenant-scoped transaction, so the policy sees `ownerTeam`, `createdBy` and
 * `locked` of the entity itself. A missing row (or another tenant's, which
 * row-level security hides) yields no attributes: the role-only decision then
 * applies and the handler answers `CATALOG_NOT_FOUND`.
 */
import { resolveEffectiveOwnerTeam } from '@tayzu/authz';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import type { CatalogContext } from '../domain/context.js';
import { AuthorizationError } from '../domain/errors.js';
import { inputString } from './pipeline.js';

/** The relation naming an entity's direct owner team. */
const OWNER_TEAM_RELATION = 'ownerTeam';

export type EntityAuthzAttributes = Readonly<Record<string, string | number | boolean>>;

interface EntityAuthzRow extends Record<string, unknown> {
  readonly tenant_id: string;
  readonly created_by_id: string;
  readonly locked: unknown;
  readonly owner_team: string | null;
}

function toAttributes(params: {
  readonly ownerTeam: string | undefined;
  readonly createdBy: string;
  readonly locked: unknown;
  readonly tenantId?: string;
}): EntityAuthzAttributes {
  const owner = resolveEffectiveOwnerTeam({
    config: { directTeamRelation: OWNER_TEAM_RELATION },
    entity: { relations: { [OWNER_TEAM_RELATION]: params.ownerTeam } },
    readInherited: () => undefined,
  });
  const attributes: Record<string, string | number | boolean> = {
    createdBy: params.createdBy,
    locked: params.locked === true,
  };
  if (params.tenantId !== undefined) attributes['tenantId'] = params.tenantId;
  if (owner.kind !== 'None') attributes['ownerTeam'] = owner.teamId;
  return attributes;
}

/** The stored attributes of an existing entity, or `undefined` when it is not visible. */
export async function loadEntityAuthzAttributes(params: {
  readonly ctx: CatalogContext;
  readonly client: PoolClient;
  readonly input: unknown;
}): Promise<EntityAuthzAttributes | undefined> {
  const { ctx, client, input } = params;
  const tx = drizzle(client);
  const result = await tx.execute<EntityAuthzRow>(sql`
    select e.tenant_id, e.created_by_id, e.spec_properties -> 'locked' as locked,
      (
        select t.identifier
        from catalog_entity_relation r
        join catalog_relation_definition d
          on d.tenant_id = r.tenant_id and d.id = r.relation_definition_id
        join catalog_entity t on t.tenant_id = r.tenant_id and t.id = r.target_entity_id
        where r.tenant_id = e.tenant_id and r.source_entity_id = e.id
          and r.scope = 'spec' and d.identifier = ${OWNER_TEAM_RELATION}
        order by r.position
        limit 1
      ) as owner_team
    from catalog_entity e
    join catalog_blueprint b on b.tenant_id = e.tenant_id and b.id = e.blueprint_id
    where e.tenant_id = ${ctx.tenantId}
      and b.identifier = ${inputString(input, 'blueprint')}
      and e.identifier = ${inputString(input, 'identifier')}
  `);
  const row = result.rows[0];
  if (row === undefined) return undefined;
  return toAttributes({
    ownerTeam: row.owner_team ?? undefined,
    createdBy: row.created_by_id,
    locked: row.locked,
    tenantId: row.tenant_id,
  });
}

/** The attributes of the entity a `create` is about to write, read defensively from the untrusted input. */
export function newEntityAuthzAttributes(params: {
  readonly ctx: CatalogContext;
  readonly input: unknown;
}): EntityAuthzAttributes {
  const { ctx, input } = params;
  const spec = readRecord(input, 'spec');
  const properties = readRecord(spec, 'properties');
  const relations = readRecord(spec, 'relations');
  const owner =
    relations !== undefined && Object.hasOwn(relations, OWNER_TEAM_RELATION)
      ? relations[OWNER_TEAM_RELATION]
      : undefined;
  // Fail closed (design Q53): an owner that is not a single identifier is never "no owner".
  if (owner !== undefined && typeof owner !== 'string') throw new AuthorizationError();
  return toAttributes({
    ownerTeam: owner,
    createdBy: ctx.actor.id,
    locked:
      properties !== undefined && Object.hasOwn(properties, 'locked')
        ? properties['locked']
        : false,
    tenantId: ctx.tenantId,
  });
}

function readRecord(source: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof source !== 'object' || source === null || !Object.hasOwn(source, key))
    return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
