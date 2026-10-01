/**
 * Keeps each tenant's `_user` entity in step with Better Auth (task 12.2;
 * spec "User and Team system blueprints"; design D22, resolved decisions Q16
 * and Q26). Better Auth hooks call this; it writes through the regular entity
 * service as the `system` actor, the only actor the reserved `_` prefix rule
 * (`domain/reserved.ts`) lets write `_user`.
 */
import type { CerbosClient } from '@tayzu/authz';
import type { Pool } from 'pg';

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
  readonly status?: 'Active' | 'Disabled';
}

export interface UserSync {
  upsertUser(input: UserSyncInput): Promise<void>;
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
      await entities.upsert(
        {
          tenantId: input.tenantId,
          actor: SYSTEM_SYNC_ACTOR,
          principal: { roles: ['admin'] },
        },
        {
          blueprint: '_user',
          identifier: input.email,
          title: input.name,
          mode: 'merge',
          spec: { properties },
        },
      );
    },
  };
}
