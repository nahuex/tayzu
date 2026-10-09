/**
 * Keeps each tenant's `_user` entity in step with Better Auth (task 12.2;
 * spec "User and Team system blueprints"; design D22, resolved decisions Q16
 * and Q26). Better Auth hooks call this; it writes through the regular entity
 * service as the `system` actor, the only actor the reserved `_` prefix rule
 * (`domain/reserved.ts`) lets write `_user`.
 */
import type { CerbosClient } from '@tayzu/authz';
import type { Pool } from 'pg';

import type { Principal } from '../domain/context.js';
import { CatalogError } from '../domain/errors.js';
import { createEntityService } from './entities.js';
import { bootstrapSystemBlueprints } from './system-blueprints.js';

export interface UserSyncInput {
  /** The Better Auth organization id. */
  readonly tenantId: string;
  readonly email: string;
  readonly name: string;
  /** Display-only Visma Connect email (design D24), merged into `spec.properties.contactEmail`. */
  readonly contactEmail?: string;
  /** Omitted fields keep their stored value (merge upsert). */
  readonly portRole?: 'admin' | 'member';
  readonly status?: 'Staged' | 'Invited' | 'Active' | 'Disabled';
  /** The principal an admin-initiated write is attributed to (design D2, Q10). */
  readonly onBehalfOf?: Principal;
  /** For an existing row: the version the caller read; a stale one is a version conflict. */
  readonly expectedVersion?: number;
  /** Create the row instead of upserting it: an existing row is `CATALOG_ALREADY_EXISTS`. */
  readonly createOnly?: boolean;
}

/** The stored status and entity version of a tenant's `_user` entity. */
export interface UserReadModel {
  readonly status: 'Staged' | 'Invited' | 'Active' | 'Disabled';
  readonly version: number;
}

export interface UserSync {
  upsertUser(input: UserSyncInput): Promise<void>;
  /** Reads the `_user` entity addressed by `email`, or `null` when it does not exist. */
  getUser(input: {
    readonly tenantId: string;
    readonly email: string;
  }): Promise<UserReadModel | null>;
}

export interface CreateUserSyncOptions {
  readonly pool: Pool;
  readonly authz: CerbosClient;
}

const SYSTEM_SYNC_ACTOR = { type: 'system', id: 'user-sync' } as const;

/**
 * Creates the tenant's system blueprints first when missing (idempotent): the
 * tenant only exists once its organization does, so nothing else has
 * bootstrapped them yet.
 */
export function createUserSync(options: CreateUserSyncOptions): UserSync {
  const entities = createEntityService(options);
  return {
    async upsertUser(input) {
      await bootstrapSystemBlueprints(options, input.tenantId);
      const properties: Record<string, unknown> = {};
      if (input.status !== undefined) properties['status'] = input.status;
      if (input.portRole !== undefined) properties['portRole'] = input.portRole;
      if (input.contactEmail !== undefined) properties['contactEmail'] = input.contactEmail;
      const context = {
        tenantId: input.tenantId,
        actor:
          input.onBehalfOf === undefined
            ? SYSTEM_SYNC_ACTOR
            : { ...SYSTEM_SYNC_ACTOR, onBehalfOf: input.onBehalfOf },
        principal: { roles: ['admin'] },
      };
      const write = {
        blueprint: '_user',
        identifier: input.email,
        title: input.name,
        spec: { properties },
      };
      if (input.createOnly === true) {
        await entities.create(context, write);
        return;
      }
      await entities.upsert(context, {
        ...write,
        mode: 'merge',
        ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
      });
    },
    async getUser(input) {
      try {
        const entity = await entities.get(
          {
            tenantId: input.tenantId,
            actor: SYSTEM_SYNC_ACTOR,
            principal: { roles: ['admin'] },
          },
          { blueprint: '_user', identifier: input.email },
        );
        return {
          status: entity.spec.properties['status'] as UserReadModel['status'],
          version: entity.version,
        };
      } catch (error) {
        if (error instanceof CatalogError && error.code === 'CATALOG_NOT_FOUND') return null;
        throw error;
      }
    },
  };
}
