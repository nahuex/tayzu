/**
 * The `UserSyncPort` adapter (`043` design D2, Resolved decisions Q10, Q30 and
 * Q83). Every `_user` status writer goes through it: it reads the current
 * status and version, derives the next status with `nextStatus`, and writes it
 * with the version it read. A version conflict or a create race re-reads and
 * retries a bounded number of times before it fails closed.
 */
import {
  emitIdentityEvent,
  nextStatus,
  type StatusEvent,
  type UserStatus,
  type UserSyncPort,
} from '@tayzu/auth';
import type { UserSync, UserReadModel } from '@tayzu/catalog';

import { currentIdentityContext } from './identity-context.js';

/** Retries after the first attempt (Q83). */
const MAX_RETRIES = 3;

type UpsertInput = Parameters<UserSyncPort['upsertUser']>[0];

export interface UserSyncAdapter extends UserSyncPort {
  /**
   * The acceptance's entry point: same input as `upsertUser`, and it returns
   * the status event it wrote, or `undefined` when it wrote nothing. `userId`
   * is absent only for the invitation hook's `created_invited` write, which
   * passes `invitationId` instead (Resolved decisions Q120 and Q126).
   */
  readonly writeUserChange: (
    input: UpsertInput & { readonly userId?: string; readonly invitationId?: string },
  ) => Promise<StatusEvent | undefined>;
}

export interface CreateUserSyncAdapterOptions {
  readonly userSync: UserSync;
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null
    ? (error as { code?: unknown }).code
    : undefined;
}

/** The event the `membership_added` intent maps to; a hook never revives a user. */
function membershipEvent(current: UserStatus | null): StatusEvent | undefined {
  if (current === null) return 'created_active';
  return current === 'Staged' || current === 'Invited' ? 'invitation_accepted' : undefined;
}

/** The status each event leads to (the target column of the `@tayzu/auth` transition table). */
const EVENT_TARGET: Record<StatusEvent, UserStatus> = {
  created_staged: 'Staged',
  created_invited: 'Invited',
  created_active: 'Active',
  invitation_accepted: 'Active',
  first_sign_in: 'Active',
  admin_disable: 'Disabled',
  admin_enable: 'Active',
};

/** A redundant event (the status already is its target) writes and emits nothing. */
function isRedundant(event: StatusEvent, current: UserStatus | null): boolean {
  return current === EVENT_TARGET[event];
}

/** Emits `catalog.audit.user_status_changed` (Resolved decisions Q117 and Q126): identifiers only. */
function emitStatusChanged(
  input: UpsertInput,
  from: UserStatus | null,
  to: UserStatus,
  event: StatusEvent,
): void {
  const service = input.accountKind === 'service';
  const { principal } = input;
  emitIdentityEvent({
    name: 'catalog.audit.user_status_changed',
    severity: 'INFO',
    attributes: {
      'tayzu.tenant.id': input.tenantId,
      ...(from === null ? {} : { 'tayzu.identity.user.status.from': from }),
      'tayzu.identity.user.status.to': to,
      'tayzu.identity.user.status.event': event,
      'tayzu.identity.user.account_kind': service ? 'service' : 'standard',
      ...(input.userId === undefined
        ? input.invitationId === undefined
          ? {}
          : { 'tayzu.identity.invitation.id': input.invitationId }
        : service
          ? { 'tayzu.identity.service_account.id': input.userId }
          : { 'tayzu.identity.user.id': input.userId }),
      ...(principal === undefined
        ? {}
        : principal.kind === 'operator'
          ? { 'tayzu.identity.operator.id': principal.id }
          : { 'tayzu.actor.id': principal.id }),
    },
  });
}

export function createUserSyncAdapter(options: CreateUserSyncAdapterOptions): UserSyncAdapter {
  const { userSync } = options;

  /** Writes one event: read, derive, write; retried on a conflict. Returns the event written, if any. */
  async function writeEvent(
    input: UpsertInput,
    pick: (current: UserReadModel | null) => StatusEvent | undefined,
  ): Promise<StatusEvent | undefined> {
    for (let attempt = 0; ; attempt += 1) {
      const current = await userSync.getUser({ tenantId: input.tenantId, email: input.email });
      const event = pick(current);
      if (event === undefined || isRedundant(event, current?.status ?? null)) return undefined;
      // A first sign-in with no `_user` row writes and emits nothing (Q133).
      if (event === 'first_sign_in' && current === null) return undefined;
      const status = nextStatus(current?.status ?? null, event);
      try {
        await userSync.upsertUser({
          tenantId: input.tenantId,
          email: input.email,
          name: input.name,
          ...(input.contactEmail === undefined ? {} : { contactEmail: input.contactEmail }),
          ...(input.portRole === undefined ? {} : { portRole: input.portRole }),
          status,
          ...(input.onBehalfOf === undefined ? {} : { onBehalfOf: input.onBehalfOf }),
          ...(current === null ? { createOnly: true } : { expectedVersion: current.version }),
        });
        // An event that leaves the status as it was (`created_invited` for an Invited row) is not a change.
        if (current?.status !== status) {
          emitStatusChanged(input, current?.status ?? null, status, event);
        }
        return event;
      } catch (error) {
        const code = errorCode(error);
        const conflict = code === 'CATALOG_VERSION_CONFLICT' || code === 'CATALOG_ALREADY_EXISTS';
        if (!conflict || attempt >= MAX_RETRIES) throw error;
      }
    }
  }

  async function writeUserChange(rawInput: UpsertInput): Promise<StatusEvent | undefined> {
    // A hook write inside an admin's operation is attributed to that admin (Q10, Q117).
    const admin = currentIdentityContext();
    const input: UpsertInput =
      admin === undefined || rawInput.onBehalfOf !== undefined || rawInput.principal !== undefined
        ? rawInput
        : {
            ...rawInput,
            onBehalfOf: { type: 'user', id: admin.adminId },
            principal: { kind: 'admin', id: admin.adminId },
          };
    const { change } = input;
    if (change === undefined) {
      // Display data and role only: no status is written, and a member with no
      // row gets none (the reconcile and the membership hook create rows).
      const existing = await userSync.getUser({ tenantId: input.tenantId, email: input.email });
      if (existing === null) return undefined;
      await userSync.upsertUser({
        tenantId: input.tenantId,
        email: input.email,
        name: input.name,
        ...(input.contactEmail === undefined ? {} : { contactEmail: input.contactEmail }),
        ...(input.portRole === undefined ? {} : { portRole: input.portRole }),
      });
      return undefined;
    }
    if (typeof change === 'string') {
      return await writeEvent(input, () => change);
    }
    const first = await writeEvent(input, (current) => membershipEvent(current?.status ?? null));
    if (first !== 'created_active' || !change.banned) return first;
    // A banned member with no row is created, then disabled.
    return (await writeEvent(input, () => 'admin_disable')) ?? first;
  }

  return {
    async upsertUser(input) {
      await writeUserChange(input);
    },
    writeUserChange,
  };
}
