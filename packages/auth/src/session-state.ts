/**
 * The shell's view of its own session (003 design D8, Resolved decisions Q13 and Q54):
 * `createSessionStateResolver(options)` returns `resolveSessionState(headers)`, the body of
 * `GET /v1/me`.
 *
 * It runs `resolveContext`'s session-cookie checks, in its order and through the same
 * `SessionChecks` (`./context-resolver.ts`): the session read (idle, expiry, `banned`), the
 * markers, then the active organization, the membership, the open tenant and the `_user`
 * state. Where `resolveContext` refuses a marker, this records the gate and goes on, so a
 * gated session that fails a later check is still the uniform rejection. A failed marker
 * lookup is that rejection too (Q54): a gate it could not confirm is never reported.
 *
 * Every rejection is `AuthContextError` (`CATALOG_CONTEXT_REQUIRED`). Only the session is
 * read: an `authorization` header is dropped before Better Auth sees the headers, so a
 * machine bearer token is no session at all.
 */
import {
  createSessionChecks,
  toCerbosRole,
  type ContextResolverOptions,
  type SessionResult,
} from './context-resolver.js';
import { AuthContextError } from './errors.js';

export type SessionGate =
  'none' | 'password_change_required' | 'password_expired' | 'mfa_enrolment_required';

export type SessionRole = 'owner' | 'admin' | 'member';

export interface SessionState {
  readonly user: { readonly id: string; readonly name: string; readonly email: string };
  readonly organization: { readonly id: string; readonly name: string };
  readonly role: SessionRole;
  readonly signInMethod: 'password' | 'visma-connect';
  readonly mfa: { readonly enrolled: boolean };
  readonly gate: SessionGate;
}

export type SessionStateResolver = (headers: Headers) => Promise<SessionState>;

/** The highest of `owner`, `admin` and `member` in a stored (possibly comma-separated) role. */
function highestRole(memberRole: string): SessionRole {
  const roles = memberRole.split(',').map((role) => role.trim());
  if (roles.includes('owner')) return 'owner';
  return roles.includes('admin') ? 'admin' : 'member';
}

function signInMethodOf(result: SessionResult): SessionState['signInMethod'] {
  const { ssoSid } = result.session;
  return typeof ssoSid === 'string' && ssoSid !== '' ? 'visma-connect' : 'password';
}

export function createSessionStateResolver(options: ContextResolverOptions): SessionStateResolver {
  const checks = createSessionChecks(options);

  return async (headers: Headers): Promise<SessionState> => {
    const sessionHeaders = new Headers(headers);
    sessionHeaders.delete('authorization');

    const result = await checks.readSession(sessionHeaders);
    const markerGate = await checks.markerGate(result.user.id).catch(() => {
      throw new AuthContextError();
    });
    const { tenantId, memberRole, email } = await checks.admitSession(result);
    const organizationName = await checks.organizationName(tenantId);
    const { name } = result.user;
    if (typeof name !== 'string') {
      throw new AuthContextError();
    }

    const enrolled = result.user.twoFactorEnabled === true;
    // Q43 of `002`: the catch-all refuses an admin (an owner folds to admin) without a factor.
    const gate: SessionGate =
      markerGate ??
      (toCerbosRole(memberRole) === 'admin' && !enrolled ? 'mfa_enrolment_required' : 'none');

    return {
      user: { id: result.user.id, name, email },
      organization: { id: tenantId, name: organizationName },
      role: highestRole(memberRole),
      signInMethod: signInMethodOf(result),
      mfa: { enrolled },
      gate,
    };
  };
}
