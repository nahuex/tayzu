/**
 * The `_user` and `_team` system blueprints (task 12.1; spec "User and Team
 * system blueprints"; design D9). They are created per tenant at bootstrap
 * through the regular blueprint service, as the `system` actor, which is the
 * only actor the reserved `_` prefix rule lets write them
 * (`domain/reserved.ts`). `identifier` and `title` are entity-level fields, so
 * they are not schema properties.
 */
import type { CerbosClient } from '@tayzu/authz';
import type { Pool } from 'pg';

import { isCatalogError } from '../domain/errors.js';
import { createBlueprintService, type CreateBlueprintInput } from './blueprints.js';

export interface BootstrapSystemBlueprintsOptions {
  readonly pool: Pool;
  readonly authz: CerbosClient;
}

const SYSTEM_BOOTSTRAP_ACTOR = { type: 'system', id: 'tenant-bootstrap' } as const;

const USER_BLUEPRINT: CreateBlueprintInput = {
  identifier: '_user',
  title: { en: 'User' },
  schema: {
    properties: {
      status: { type: 'string', title: { en: 'Status' }, enum: ['Active', 'Disabled'] },
      portRole: { type: 'string', title: { en: 'Port role' }, enum: ['admin', 'member'] },
      contactEmail: { type: 'string', title: { en: 'Contact email' } },
      moderatedBlueprints: {
        type: 'array',
        title: { en: 'Moderated blueprints' },
        items: { type: 'string' },
        uniqueItems: true,
      },
    },
  },
};

const TEAM_BLUEPRINT: CreateBlueprintInput = {
  identifier: '_team',
  title: { en: 'Team' },
  schema: { properties: {} },
};

/**
 * Creates `_user` and `_team` in `tenantId` as the `system` actor. Idempotent:
 * a blueprint that already exists is left untouched.
 */
export async function bootstrapSystemBlueprints(
  { pool, authz }: BootstrapSystemBlueprintsOptions,
  tenantId: string,
): Promise<void> {
  const blueprints = createBlueprintService({ pool, authz });
  const context = {
    tenantId,
    actor: SYSTEM_BOOTSTRAP_ACTOR,
    principal: { roles: ['admin'] },
  };

  for (const definition of [USER_BLUEPRINT, TEAM_BLUEPRINT]) {
    try {
      await blueprints.create(context, definition);
    } catch (error) {
      if (!isCatalogError(error) || error.code !== 'CATALOG_ALREADY_EXISTS') throw error;
    }
  }
}
