/**
 * The invitation acceptance as a sequence of idempotent steps with no
 * transaction around it (`043` design D4, Resolved decisions Q89, Q105, Q112,
 * Q116, Q118, Q120, Q122 and Q127). The token is verified without consuming
 * it and consumed last; an attempt compensates only what it created.
 *
 * The admin notice (8.15) is a later task's: this flow only reserves its slot.
 */
import { ORPCError } from '@orpc/server';
import type { Pool } from 'pg';

import type { CerbosClient } from '@tayzu/authz';

import {
  AuthStepUpError,
  emitIdentityEvent,
  isIdle,
  toCerbosRole,
  verifyInvitationToken,
  withIdentitySpan,
  type AuthInstance,
  type StepUpGuard,
} from '@tayzu/auth';

import type { Reauthorization } from '../reauthorization.js';
import type { AuthRepository, InvitationRead } from './auth-repository.js';
import { runWithAcceptanceContext } from './identity-context.js';
import { parseIdentityInput, type InputSchema } from './parse-input.js';
import type { ShedResult, SsoLinkShed } from './sso-link-shed.js';
import type { UserSyncAdapter } from './user-sync-adapter.js';

type Step =
  | 'create_user'
  | 'add_member'
  | 'shed'
  | 'user_step'
  | 'join_owed'
  | 'email_verified'
  | 'consume'
  | 'consume_in_transaction'
  | 'admin_notice';

export interface AcceptFlowOptions {
  readonly auth: AuthInstance;
  /** Cerbos, asked whether the inviter may still invite (8.5f); the flow fails closed on it. */
  readonly authz: CerbosClient;
  readonly authRepository: AuthRepository;
  /** The `tayzu_auth` pool: the token row of `auth.verification`. */
  readonly authPool: Pool;
  readonly userSync: UserSyncAdapter;
  /** The shed core run as the `shed` step of an existing-account attempt (8.5h). */
  readonly ssoLinkShed?: SsoLinkShed;
  /** The step-up guard of an `admin` acceptance by an existing account (8.5d). */
  readonly stepUp?: StepUpGuard;
  /** The identity provider's re-authorization, for sessions that carry an `ssoSid`. */
  readonly reauthorization?: Reauthorization;
  /** Test seam, awaited immediately before each step; a throw fails that step. */
  readonly onStep?: (step: Step) => void | Promise<void>;
}

export interface AcceptInput {
  readonly invitationId: string;
  readonly token: string;
  /** The password of the new-account path. */
  readonly password?: string;
  /** The already validated session of the existing-account path (opaque ids). */
  readonly session?: {
    readonly userId: string;
    readonly sessionId: string;
    /** The request's headers, handed to the step-up guard. */
    readonly headers?: Headers;
  };
  /**
   * The request's headers. When given without `session`, the flow reads the
   * session itself, applying the idle and banned checks (8.5e).
   */
  readonly headers?: Headers;
}

interface AuthApiSurface {
  getSession(args: { headers: Headers; query: { disableRefresh: true } }): Promise<{
    session: { id: string; updatedAt: Date };
    user: { id: string; banned?: boolean | null };
  } | null>;
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

/** `addMember` refused the join: the organization is at its membership limit. */
class MemberLimitError extends Error {}

/** The consumption changed no row: a lost race, which compensates nothing. */
class ConsumeConflictError extends Error {}

/** The public body: an allowlist of exactly these fields (design D4 "Acceptance"). */
const ACCEPT_BODY_SCHEMA: InputSchema = {
  body: {
    invitationId: { kind: 'string', maxLength: 64, pattern: /^[A-Za-z0-9_-]+$/ },
    token: { kind: 'string', maxLength: 256 },
    password: { kind: 'string', maxLength: 1024, optional: true },
  },
};

/** The constant logged in place of an attacker-controlled invitation id. */
const INVALID_ID = 'invalid';

function tokenIdentifier(invitationId: string): string {
  return `invitation-accept:${invitationId}`;
}

export function createAcceptFlow(options: AcceptFlowOptions): {
  accept(input: AcceptInput): Promise<{ userId: string }>;
  acceptRequest(request: {
    body: unknown;
    session?: AcceptInput['session'];
    headers?: Headers;
  }): Promise<{ userId: string }>;
} {
  const { authRepository: repository, authPool, userSync } = options;
  const api = options.auth.api as AuthApiSurface;

  const step = async (name: Step): Promise<void> => {
    await options.onStep?.(name);
  };

  /** Fails closed with `AUTH_STEP_UP_REQUIRED` unless a fresh step-up is on the session. */
  async function requireStepUp(
    tenantId: string,
    userId: string,
    headers: Headers | undefined,
  ): Promise<void> {
    const { stepUp, reauthorization } = options;
    const requestHeaders = headers ?? new Headers();
    if (stepUp === undefined) throw new AuthStepUpError();
    const returned =
      reauthorization === undefined ? null : await reauthorization.lookup(requestHeaders);
    try {
      await stepUp({
        headers: requestHeaders,
        tenantId,
        actor: { type: 'user', id: userId },
        route: { riskLevel: 'high' },
        operation: 'identity.invitation.accept',
        ...(returned === null ? {} : { reauthorization: returned }),
      });
    } catch (error) {
      if (!(error instanceof AuthStepUpError)) throw error;
      const reauthorizationUrl =
        reauthorization === undefined ? null : await reauthorization.start(requestHeaders);
      if (reauthorizationUrl === null) throw error;
      throw new ORPCError('AUTH_STEP_UP_REQUIRED', {
        status: 403,
        message: error.message,
        data: { reauthorizationUrl },
      });
    }
  }

  /**
   * Reads the caller's session like `resolveContext` does (`disableRefresh`, so
   * the read cannot extend a session about to idle out); an idle or banned
   * session counts as none. `resolveContext` has no banned check until 13.4.
   */
  async function readSession(headers: Headers): Promise<AcceptInput['session']> {
    // The `/get-session` before hook refuses an idle session with an error;
    // that refusal means no session, as in `resolveContext`.
    const found = await api
      .getSession({ headers, query: { disableRefresh: true } })
      .catch(() => null);
    if (found === null || isIdle(found.session.updatedAt) || found.user.banned === true) {
      return undefined;
    }
    return { userId: found.user.id, sessionId: found.session.id, headers };
  }

  /**
   * The inviter must still be an unbanned, `Active` member of the organization
   * whom Cerbos lets `invite` a `user` (Q63, Q108). Any failure to know is a no.
   */
  async function inviterMayStillInvite(invitation: InvitationRead): Promise<boolean> {
    try {
      const { organizationId: tenantId, inviterId } = invitation;
      const member = await repository.memberOf(tenantId, inviterId);
      if (member === undefined) return false;
      if ((await repository.memberBanned(tenantId, inviterId)) !== false) return false;
      const inviter = await repository.globalUserById(inviterId);
      if (inviter === undefined) return false;
      if ((await userSync.readStatus({ tenantId, email: inviter.email })) !== 'Active') {
        return false;
      }
      const result = await options.authz.checkResources({
        principal: {
          id: inviterId,
          roles: [toCerbosRole(member.role)],
          attr: { tenantId },
        },
        resources: [
          { resource: { kind: 'user', id: 'new', attr: { tenantId } }, actions: ['invite'] },
        ],
      });
      return result.results[0]?.isAllowed('invite') === true;
    } catch {
      return false;
    }
  }

  /** Logs the specific reason and returns the uniform rejection (design D4 step 5). */
  function deny(invitationId: string, reason: string): AcceptanceNotFoundError {
    emitIdentityEvent({
      name: 'catalog.security.invitation_acceptance_denied',
      severity: 'WARN',
      attributes: {
        'tayzu.identity.invitation.id': invitationId,
        'tayzu.identity.invitation.denial_reason': reason,
      },
    });
    return notFound();
  }

  async function accept(rawInput: AcceptInput): Promise<{ userId: string }> {
    const input: AcceptInput =
      rawInput.session === undefined && rawInput.headers !== undefined
        ? { ...rawInput, session: await readSession(rawInput.headers) }
        : rawInput;
    const invitation = await repository.globalInvitationById(input.invitationId);
    if (invitation === undefined) {
      // The same digest comparison as a wrong token, so timing does not reveal existence.
      verifyInvitationToken(input.token, null);
      throw deny(input.invitationId, 'not_found');
    }
    // The state is derived at the boundary: `canceled` reads as cancelled, `expired` from `expiresAt`.
    if (invitation.status === 'accepted') throw deny(invitation.id, 'already_accepted');
    if (invitation.status === 'canceled') throw deny(invitation.id, 'cancelled');
    if (invitation.status === 'rejected') throw deny(invitation.id, 'rejected');
    if (invitation.expiresAt.getTime() <= Date.now()) throw deny(invitation.id, 'expired');
    const stored = await authPool.query<{ value: string }>(
      'select value from auth.verification where identifier = $1',
      [tokenIdentifier(invitation.id)],
    );
    const digest = stored.rows[0]?.value ?? null;
    if (!verifyInvitationToken(input.token, digest)) throw deny(invitation.id, 'token_mismatch');
    const { organizationId: tenantId, email } = invitation;
    if ((await userSync.readStatus({ tenantId, email })) === 'Disabled') {
      throw deny(invitation.id, 'disabled_user');
    }
    if (!(await inviterMayStillInvite(invitation))) {
      throw deny(invitation.id, 'inviter_not_active_admin');
    }
    const role = invitation.role === 'admin' ? 'admin' : 'member';

    const existing = await repository.globalUserByEmail(email);
    if (existing !== undefined && input.session?.userId !== existing.id) {
      // The match is on the account of the invitation email only, with no
      // verified-email condition (Q38).
      throw deny(
        invitation.id,
        input.session === undefined ? 'session_required' : 'email_mismatch',
      );
    }
    if (existing === undefined && input.password === undefined) throw notFound();
    // Only after the session, the email and the token have passed (8.5d).
    if (existing !== undefined && role === 'admin')
      await requireStepUp(tenantId, existing.id, input.session?.headers);

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
      // The token delete and the `accepted` write are one short transaction.
      const client = await authPool.connect();
      try {
        await client.query('begin');
        const deleted = await client.query(
          'delete from auth.verification where identifier = $1 and value = $2',
          [tokenIdentifier(invitation.id), digest],
        );
        if ((deleted.rowCount ?? 0) === 0) throw new ConsumeConflictError();
        if (!(await repository.markInvitationAccepted(tenantId, invitation.id, client))) {
          throw new ConsumeConflictError();
        }
        await step('consume_in_transaction');
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    };

    /**
     * Once the `_user` step has run, revokes the accepting session and the session an
     * earlier attempt's shed recorded, when this attempt's shed removed a link or the
     * record exists (Q106, Q122, 8.5m), then deletes the record. The join is final (Q118),
     * so a failure is logged with opaque ids, keeps the record and does not stop the
     * acceptance (Q115, G9-5).
     */
    const revokeKeptSessions = async (
      userId: string,
      shedResult: ShedResult | undefined,
    ): Promise<void> => {
      const shed = options.ssoLinkShed;
      if (shed === undefined) return;
      try {
        const recorded = await shed.recordedSession(invitation.id);
        if ((shedResult?.removedLinks ?? 0) === 0 && recorded === undefined) return;
        const sessionIds = new Set<string>();
        if (input.session !== undefined) sessionIds.add(input.session.sessionId);
        if (recorded !== undefined) sessionIds.add(recorded);
        for (const sessionId of sessionIds) {
          await shed.revokeSession({ tenantId, userId, sessionId });
        }
        await shed.clearRecord(invitation.id);
      } catch {
        emitIdentityEvent({
          name: 'catalog.security.accepting_session_revocation_failed',
          severity: 'WARN',
          attributes: {
            'tayzu.tenant.id': tenantId,
            'tayzu.identity.invitation.id': invitation.id,
            'tayzu.identity.user.id': userId,
          },
        });
      }
    };

    const joinSteps = async (userId: string): Promise<void> => {
      let shedResult: ShedResult | undefined;
      await step('add_member');
      const before = await repository.memberOf(tenantId, userId);
      if (before === undefined) {
        try {
          await api.addMember({ body: { userId, role, organizationId: tenantId } });
        } catch (error) {
          // Better Auth answers FORBIDDEN past the membership limit.
          if ((error as { status?: unknown } | null)?.status === 'FORBIDDEN') {
            throw new MemberLimitError();
          }
          throw error;
        }
        createdMemberId = (await repository.memberOf(tenantId, userId))?.id;
      }
      if (existing !== undefined) {
        await step('shed');
        // Every attempt sheds once the membership exists, before the token is consumed (Q105).
        shedResult = await options.ssoLinkShed?.shed({
          tenantId,
          userId,
          path: 'acceptance',
          invitationId: invitation.id,
          ...(input.session !== undefined && { keepSessionId: input.session.sessionId }),
        });
      }
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
      await revokeKeptSessions(userId, shedResult);
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
      if (error instanceof MemberLimitError) {
        await compensate();
        throw deny(invitation.id, 'member_limit');
      }
      if (error instanceof ConsumeConflictError) {
        deny(invitation.id, 'consume_conflict');
        if (existing === undefined && role === 'admin') await step('admin_notice');
        throw notFound();
      }
      // Existing account: nothing is deleted once the `_user` step has run (Q118).
      if (existing === undefined || !progress.userStepRan) await compensate();
      throw acceptanceFailed();
    }
    // The invitee acts on a public route: they are the actor (Q116), on both paths.
    emitIdentityEvent({
      name: 'catalog.audit.invitation_accepted',
      severity: 'INFO',
      attributes: {
        'tayzu.tenant.id': tenantId,
        'tayzu.identity.invitation.id': invitation.id,
        'tayzu.actor.type': 'user',
        'tayzu.actor.id': userId,
        'tayzu.identity.user.id': userId,
      },
    });
    if (existing === undefined && role === 'admin') await step('admin_notice');
    return { userId };
  }

  /** The service function behind the public route: parses the raw body, then accepts. */
  async function acceptRequest(request: {
    body: unknown;
    session?: AcceptInput['session'];
    headers?: Headers;
  }): Promise<{ userId: string }> {
    let parsed: Record<string, unknown>;
    try {
      parsed = parseIdentityInput(ACCEPT_BODY_SCHEMA, { body: request.body }).body;
    } catch (error) {
      return withIdentitySpan(
        'identity.invitation.accept',
        { 'tayzu.identity.invitation.id': INVALID_ID },
        () => {
          emitIdentityEvent({
            name: 'catalog.security.invitation_acceptance_denied',
            severity: 'WARN',
            attributes: {
              'tayzu.identity.invitation.id': INVALID_ID,
              'tayzu.identity.invitation.denial_reason': 'malformed_request',
            },
          });
          throw error;
        },
      );
    }
    const invitationId = parsed['invitationId'] as string;
    return withIdentitySpan(
      'identity.invitation.accept',
      { 'tayzu.identity.invitation.id': invitationId },
      () =>
        accept({
          invitationId,
          token: parsed['token'] as string,
          ...(parsed['password'] !== undefined && { password: parsed['password'] as string }),
          ...(request.session !== undefined && { session: request.session }),
          ...(request.headers !== undefined && { headers: request.headers }),
        }),
    );
  }

  return { accept, acceptRequest };
}
