/** Invitation states as exposed at the API boundary (design D4). */
export type BoundaryInvitationState = 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'expired';

/**
 * Maps Better Auth's stored invitation status to the boundary state:
 * `canceled` becomes `cancelled`, and `expired` (never stored) is derived
 * from a pending invitation whose `expiresAt` is not after `now`.
 */
export function toBoundaryInvitationState(
  invitation: { status: string; expiresAt: Date },
  now: Date,
): BoundaryInvitationState {
  switch (invitation.status) {
    case 'canceled':
      return 'cancelled';
    case 'accepted':
      return 'accepted';
    case 'rejected':
      return 'rejected';
    default:
      return invitation.expiresAt.getTime() > now.getTime() ? 'pending' : 'expired';
  }
}
