/**
 * The invitation acceptance as a sequence of idempotent steps with no
 * transaction around it (`043` design D4, Resolved decisions Q89, Q105, Q112,
 * Q116, Q118, Q120, Q122 and Q127). The token is verified without consuming
 * it and consumed last; an attempt compensates only what it created.
 *
 * The inviter check, the shed, the session revocation and the admin notice are
 * later tasks' (8.5f, 8.5h, 8.5m, 8.15): this flow only reserves their slots.
 */
import type { Pool } from 'pg';

import { emitIdentityEvent, verifyInvitationToken, type AuthInstance } from '@tayzu/auth';

import type { AuthRepository } from './auth-repository.js';
import { runWithAcceptanceContext } from './identity-context.js';
import type { UserSyncAdapter } from './user-sync-adapter.js';

type Step =
  | 'create_user'
  | 'add_member'
  | 'shed'
  | 'user_step'
  | 'join_owed'
  | 'email_verified'
  | 'consume'
  | 'admin_notice';

export interface AcceptFlowOptions {
  readonly auth: AuthInstance;
  readonly authRepository: AuthRepository;
  /** The `tayzu_auth` pool: the token row of `auth.verification`. */
  readonly authPool: Pool;
  readonly userSync: UserSyncAdapter;
  /** Test seam, awaited immediately before each step; a throw fails that step. */
  readonly onStep?: (step: Step) => void | Promise<void>;
}

export interface AcceptInput {
  readonly invitationId: string;
  readonly token: string;
  /** The password of the new-account path. */
  readonly password?: string;
  /** The already validated session of the existing-account path (opaque ids). */
  readonly session?: { readonly userId: string; readonly sessionId: string };
}

interface AuthApiSurface {
  createUser(args: {
    body: { name: string; email: string; password: string; role: 'user' };
  }): Promise<{ user: { id: string } }>;
  addMember(args: {
    body: { userId: string; role: 'member' | 'admin'; organizationId: string };
  }): Promise<unknown>;
}

/** The uniform rejection: same code and text as the catalog's not-found. */
class AcceptanceNotFoundError extends Error {
  readonly code = 'CATALOG_NOT_FOUND' as const;

  constructor() {
    super('The requested resource was not found');
    this.name = 'AcceptanceNotFoundError';
  }
}

function notFound(): AcceptanceNotFoundError {
  return new AcceptanceNotFoundError();
}

/** Fixed text, so that no cause reaches the response. */
function acceptanceFailed(): Error {
  return new Error('The invitation could not be accepted');
}

/** The consumption changed no row: a lost race, which compensates nothing. */
class ConsumeConflictError extends Error {}

function tokenIdentifier(invitationId: string): string {
  return `invitation-accept:${invitationId}`;
}

export function createAcceptFlow(options: AcceptFlowOptions): {
  accept(input: AcceptInput): Promise<{ userId: string }>;
} {
  const { authRepository: repository, authPool, userSync } = options;
  const api = options.auth.api as AuthApiSurface;

  const step = async (name: Step): Promise<void> => {
    await options.onStep?.(name);
  };

  async function accept(input: AcceptInput): Promise<{ userId: string }> {
    const invitation = await repository.globalInvitationById(input.invitationId);
    if (invitation === undefined) throw notFound();
    const stored = await authPool.query<{ value: string }>(
      'select value from auth.verification where identifier = $1',
      [tokenIdentifier(invitation.id)],
    );
    const digest = stored.rows[0]?.value ?? null;
    if (!verifyInvitationToken(input.token, digest)) throw notFound();
    const { organizationId: tenantId, email } = invitation;
    const role = invitation.role === 'admin' ? 'admin' : 'member';

    const existing = await repository.globalUserByEmail(email);
    if (existing !== undefined && input.session?.userId !== existing.id) throw notFound();
    if (existing === undefined && input.password === undefined) throw notFound();

    let createdUserId: string | undefined;
    let createdMemberId: string | undefined;
    const progress = { userStepRan: false };

    const logCompensationFailure = (): void => {
      emitIdentityEvent({
        name: 'catalog.security.invitation_accept_compensation_failed',
        severity: 'WARN',
        attributes: { 'tayzu.identity.invitation.id': invitation.id },
      });
    };

    /** Deletes a user this attempt created; its accounts, sessions and memberships cascade. */
    const deleteUser = async (id: string): Promise<void> => {
      await authPool.query('delete from auth."user" where id = $1', [id]);
    };

    /** The token proves the mailbox, so no verification flow is needed (Q38). */
    const markEmailVerified = async (id: string): Promise<void> => {
      await authPool.query('update auth."user" set email_verified = true where id = $1', [id]);
    };

    /** Deletes, in reverse order and each idempotently, what this attempt created. */
    const compensate = async (): Promise<void> => {
      if (createdMemberId !== undefined) {
        try {
          await repository.deleteMember(tenantId, createdMemberId);
        } catch {
          logCompensationFailure();
        }
      }
      if (createdUserId !== undefined) {
        try {
          await deleteUser(createdUserId);
        } catch {
          logCompensationFailure();
        }
      }
    };

    const consume = async (): Promise<void> => {
      await step('consume');
      const result = await authPool.query(
        'delete from auth.verification where identifier = $1 and value = $2',
        [tokenIdentifier(invitation.id), digest],
      );
      if ((result.rowCount ?? 0) === 0) throw new ConsumeConflictError();
    };

    const joinSteps = async (userId: string): Promise<void> => {
      await step('add_member');
      const before = await repository.memberOf(tenantId, userId);
      if (before === undefined) {
        await api.addMember({ body: { userId, role, organizationId: tenantId } });
        createdMemberId = (await repository.memberOf(tenantId, userId))?.id;
      }
      if (existing !== undefined) await step('shed');
      await step('user_step');
      await userSync.writeUserChange({
        tenantId,
        email,
        name: email,
        portRole: role,
        userId,
        change: { intent: 'membership_added', banned: false },
        principal: { kind: 'user', id: userId },
        onBehalfOf: { type: 'user', id: userId },
      });
      progress.userStepRan = true;
      if (existing !== undefined) {
        await step('join_owed');
        await step('email_verified');
        await markEmailVerified(userId);
      }
      await consume();
    };

    let userId: string;
    try {
      if (existing !== undefined) {
        userId = existing.id;
        await runWithAcceptanceContext({ tenantId, userId }, () => joinSteps(userId));
      } else {
        await step('create_user');
        const created = await api.createUser({
          body: { name: email, email, password: input.password ?? '', role: 'user' },
        });
        userId = created.user.id;
        createdUserId = userId;
        await markEmailVerified(userId);
        await runWithAcceptanceContext({ tenantId, userId }, () => joinSteps(userId));
      }
    } catch (error) {
      if (error instanceof ConsumeConflictError) {
        emitIdentityEvent({
          name: 'catalog.security.invitation_acceptance_denied',
          severity: 'WARN',
          attributes: {
            'tayzu.identity.invitation.id': invitation.id,
            'tayzu.identity.invitation.denial_reason': 'consume_conflict',
          },
        });
        if (existing === undefined && role === 'admin') await step('admin_notice');
        throw notFound();
      }
      // Existing account: nothing is deleted once the `_user` step has run (Q118).
      if (existing === undefined || !progress.userStepRan) await compensate();
      throw acceptanceFailed();
    }
    if (existing === undefined && role === 'admin') await step('admin_notice');
    return { userId };
  }

  return { accept };
}
