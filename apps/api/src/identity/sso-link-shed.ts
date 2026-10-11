/**
 * The SSO link shed core (`043` task 8.5h, design D4 step 7, Resolved decisions
 * Q73, Q86, Q87, Q105, Q112, Q114 and Q120). When a user holds a membership in a
 * tenant other than the one joined, it deletes every non-`credential` account
 * of the user that carries no provenance marker, and the user's sessions.
 *
 * It works on the `tayzu_auth` pool with parameterized SQL inside the
 * `withUserLock` transaction. It builds no Better Auth instance, so no Better
 * Auth hook runs for its deletes: the markers are deleted here and no
 * `account_unlinked` event is emitted.
 */
import { emitIdentityEvent, emitSessionRevoked, type SsoLinkShedPort } from '@tayzu/auth';
import type { Pool, PoolClient } from 'pg';

import { currentAcceptanceContext } from './identity-context.js';
import { createWithUserLock, type WithUserLock } from './user-lock.js';

/** Identifier prefix of the marker of a link the user made (`auth.ts`, Q87). */
const MARKER_PREFIX = 'sso-link:';

export type SsoLinkShedPath = 'acceptance' | 'membership_hook' | 'reconcile';

export interface ShedInput {
  /** The tenant joined. */
  readonly tenantId: string;
  readonly userId: string;
  readonly path: SsoLinkShedPath;
  /** The session that carries an acceptance, kept by this shed. */
  readonly keepSessionId?: string;
}

export interface ShedResult {
  readonly removedLinks: number;
  readonly revokedSessions: number;
}

export interface SsoLinkShed {
  shed(input: ShedInput): Promise<ShedResult>;
  /** The port `createAuth` takes as `ssoLinkShed`. */
  readonly port: SsoLinkShedPort;
}

export interface SsoLinkShedOptions {
  readonly authPool: Pool;
  readonly withUserLock?: WithUserLock;
}

export function createSsoLinkShed(options: SsoLinkShedOptions): SsoLinkShed {
  const withUserLock = options.withUserLock ?? createWithUserLock(options.authPool);

  /** Deletes the user's sessions except `keep`; returns the deleted row ids. */
  async function deleteSessions(
    tx: Pick<PoolClient, 'query'>,
    userId: string,
    keep: string | undefined,
  ): Promise<readonly string[]> {
    const deleted = await tx.query<{ id: string }>(
      'delete from auth.session where user_id = $1 and ($2::text is null or id <> $2) returning id',
      [userId, keep ?? null],
    );
    return deleted.rows.map((row) => row.id);
  }

  async function shed(input: ShedInput): Promise<ShedResult> {
    const { tenantId, userId, keepSessionId } = input;
    const inLock = await withUserLock(userId, async (tx) => {
      const others = await tx.query(
        'select 1 from auth.member where user_id = $1 and organization_id <> $2 limit 1',
        [userId, tenantId],
      );
      if (others.rowCount === 0) return { removed: 0, sessions: [] as readonly string[] };
      const unmarked = await tx.query<{ id: string }>(
        `select a.id from auth.account a
          where a.user_id = $1 and a.provider_id <> 'credential'
            and not exists (
              select 1 from auth.verification v where v.identifier = $2 || a.id)`,
        [userId, MARKER_PREFIX],
      );
      const ids = unmarked.rows.map((row) => row.id);
      if (ids.length === 0) return { removed: 0, sessions: [] as readonly string[] };
      await tx.query('delete from auth.verification where identifier = any($1::text[])', [
        ids.map((id) => `${MARKER_PREFIX}${id}`),
      ]);
      await tx.query('delete from auth.account where id = any($1::text[])', [ids]);
      return { removed: ids.length, sessions: await deleteSessions(tx, userId, keepSessionId) };
    });
    if (inLock.removed === 0) return { removedLinks: 0, revokedSessions: 0 };

    emitIdentityEvent({
      name: 'catalog.security.sso_link_shed',
      severity: 'WARN',
      attributes: {
        'tayzu.tenant.id': tenantId,
        'tayzu.identity.user.id': userId,
        'tayzu.identity.sso_link.path': input.path,
      },
    });
    // A session a callback created through the link while the deletion was in flight (Q106).
    const swept = await deleteSessions(options.authPool, userId, keepSessionId);
    const revoked = [...inLock.sessions, ...swept];
    for (let index = 0; index < revoked.length; index += 1) {
      emitSessionRevoked({ actorId: userId, tenantId, reason: 'sso_link_shed' });
    }
    return { removedLinks: inLock.removed, revokedSessions: revoked.length };
  }

  const port: SsoLinkShedPort = {
    async shed({ tenantId, userId }) {
      const acceptance = currentAcceptanceContext();
      // The acceptance's own member is shed by the acceptance's explicit step (Q120).
      if (acceptance?.tenantId === tenantId && acceptance.userId === userId) return;
      await shed({ tenantId, userId, path: 'membership_hook' });
    },
  };

  return { shed, port };
}
