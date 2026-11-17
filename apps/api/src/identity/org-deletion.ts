/**
 * Org deletion (`045` design D1, D4, D6): phase 1 of the two-phase deletion of a tenant
 * (revoke now, record the deletion marker, notify the admins) behind
 * `identity.organization.delete`. Filled in by the tasks of group 5.
 */
import { emitIdentityEvent, emitSessionRevoked, type AuthInstance } from '@tayzu/auth';
import { revokeMachineCredential } from '@tayzu/auth/machine-credentials';
import { withTenantTransaction } from '@tayzu/db';
import type { Pool } from 'pg';

import type { AuthRepository } from './auth-repository.js';
import { readAllApiKeys } from './credentials.js';
import type { NoticeDispatcher } from './notices.js';
import { IdentityInputError, type InputSchema } from './parse-input.js';

/**
 * The detailed input of `identity.organization.delete` (design D6): the confirmation travels
 * in the query string only, so a body is refused by the strict parser.
 */
export const ORG_DELETION_INPUT_SCHEMA = {
  query: { confirmation: { kind: 'string', maxLength: 64 } },
} as const satisfies InputSchema;

/** The default deletion window in days (design D1, Resolved decision Q21). */
export const DEFAULT_ORG_DELETION_WINDOW_DAYS = 14;

export interface RequestOrgDeletionOptions {
  /** The host tenant (`ctx.tenantId`), never a value read from input. */
  readonly tenantId: string;
  /** The requesting admin's opaque id (`ctx.actor.id`), stored as `requested_by`. */
  readonly actorId: string;
  /** The parsed `query.confirmation`: the organization identifier the caller typed. */
  readonly confirmation: string;
  /** Days from the request to `purge_after`; the marker's CHECK bounds it to 7..14. */
  readonly windowDays: number;
  readonly auth: AuthInstance;
  /** The `tayzu_app` pool: the marker and the revocation list are written through it. */
  readonly appPool: Pool;
  readonly authRepository: AuthRepository;
  /** Cancels one pending invitation of the tenant the way `043` does (reason `org_deletion`). */
  readonly cancelInvitation: (invitationId: string) => Promise<void>;
  /** The notice dispatcher of `043` for the deletion notice (design D5); without it, none is sent. */
  readonly notices?: NoticeDispatcher;
}

/**
 * The answer of `identity.organization.delete`: the pending marker's `purge_after`, as ISO 8601.
 */
export interface OrgDeletionRequested {
  readonly purgeAfter: string;
}

/** The pending marker of the tenant, and whether this call is the one that inserted it. */
interface PendingMarker {
  readonly purgeAfter: string;
  readonly inserted: boolean;
}

/**
 * Records the tenant's pending marker, or finds the one already pending (design D1, the
 * repeated request). `on conflict ... do nothing` against the one-pending partial unique index
 * makes two concurrent first requests end with one marker: the loser waits for the winner's
 * commit, inserts nothing, and reads the winner's row. Fails closed if no pending row is found.
 */
async function recordPendingMarker(options: RequestOrgDeletionOptions): Promise<PendingMarker> {
  const { tenantId } = options;
  return await withTenantTransaction(options.appPool, { tenantId }, async (client) => {
    // `purge_after` is computed in SQL from the transaction clock that also sets the
    // `requested_at` default, so both come from one `now()` (design D1).
    const inserted = await client.query<{ purge_after: Date }>(
      `insert into tenant_deletion_marker (tenant_id, purge_after, requested_by)
       values ($1, now() + make_interval(days => $2), $3)
       on conflict (tenant_id) where state = 'pending' do nothing
       returning purge_after`,
      [tenantId, options.windowDays, options.actorId],
    );
    const insertedRow = inserted.rows[0];
    if (insertedRow !== undefined) {
      return { purgeAfter: new Date(insertedRow.purge_after).toISOString(), inserted: true };
    }
    const pending = await client.query<{ purge_after: Date }>(
      `select purge_after from tenant_deletion_marker
       where tenant_id = $1 and state = 'pending'`,
      [tenantId],
    );
    const pendingRow = pending.rows[0];
    if (pendingRow === undefined) {
      throw new Error('org deletion: no pending marker after insert');
    }
    return { purgeAfter: new Date(pendingRow.purge_after).toISOString(), inserted: false };
  });
}

/**
 * Phase 1 of org deletion (design D1 "Phase 1, request"). The confirmation must name the host
 * tenant; anything else fails with `CATALOG_VALIDATION_FAILED` before any write. Then, in
 * order: the marker (its own tenant transaction, as `tayzu_app`), the audit event when this
 * call inserted the marker, the sessions, the machine credentials and the pending invitations.
 * The marker cannot share a transaction with the `auth` schema writes (another role and pool),
 * so it commits first, and the event follows it at once so that no marker exists without its
 * `requested` event. A repeat while pending inserts nothing, logs
 * `catalog.security.org_deletion_repeated` instead, and returns the pending date, but re-runs
 * the idempotent revocations, completing a first request that failed half-way. Last, and only
 * when this call inserted the marker, the deletion notice goes to every owner and admin of the
 * tenant (design D5); a failed send never fails the request.
 */
export async function requestOrgDeletion(
  options: RequestOrgDeletionOptions,
): Promise<OrgDeletionRequested> {
  const { tenantId, actorId } = options;
  if (options.confirmation !== tenantId) {
    throw new IdentityInputError();
  }
  const marker = await recordPendingMarker(options);
  if (marker.inserted) {
    emitIdentityEvent({
      name: 'catalog.audit.org_deletion_requested',
      severity: 'INFO',
      attributes: { 'tayzu.tenant.id': tenantId, 'tayzu.actor.id': actorId },
    });
  } else {
    emitIdentityEvent({
      name: 'catalog.security.org_deletion_repeated',
      severity: 'WARN',
      attributes: { 'tayzu.tenant.id': tenantId, 'tayzu.actor.id': actorId },
    });
  }
  const revokedSessionUsers = await options.authRepository.deleteTenantSessions(tenantId);
  for (const userId of revokedSessionUsers) {
    emitSessionRevoked({ actorId: userId, tenantId, reason: 'admin_action' });
  }
  for (const credential of await readAllApiKeys(options.authRepository, tenantId)) {
    await revokeMachineCredential(options.auth, {
      userId: actorId,
      id: credential.id,
      pool: options.appPool,
      tenantId,
    });
  }
  for (const invitation of await options.authRepository.pendingInvitationsOf(tenantId)) {
    await options.cancelInvitation(invitation.id);
  }
  if (marker.inserted) {
    await sendDeletionNotice(options, marker.purgeAfter);
  }
  return { purgeAfter: marker.purgeAfter };
}

/**
 * Sends the fixed `OrgDeletionNotice` to every owner and admin of the tenant, the requester
 * included, resolved here from the memberships (design D5, Resolved decisions Q27, Q53). The
 * dispatcher applies the notice controls; every failure, including the recipients' read, is
 * logged as `catalog.security.org_deletion_notice_failed` with the tenant alone and never
 * fails the request, whose access revocation has already happened.
 */
async function sendDeletionNotice(
  options: RequestOrgDeletionOptions,
  purgeDate: string,
): Promise<void> {
  const { notices, tenantId } = options;
  if (notices === undefined) return;
  const reportFailure = () => {
    emitIdentityEvent({
      name: 'catalog.security.org_deletion_notice_failed',
      severity: 'WARN',
      attributes: { 'tayzu.tenant.id': tenantId },
    });
  };
  try {
    const recipients = await options.authRepository.administratorsOf(tenantId);
    await notices.send({
      tenantId,
      template: { kind: 'OrgDeletionNotice', purgeDate },
      recipients,
      onSendFailure: reportFailure,
    });
  } catch {
    reportFailure();
  }
}
