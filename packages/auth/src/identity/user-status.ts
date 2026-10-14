/**
 * The user status state machine (`043` design D2): Staged, Invited, Active and
 * Disabled, and the events that move between them. Pure, no I/O.
 *
 * Exhaustive: every `(status, event)` pair not in the table throws
 * `StatusTransitionError`, and the table covers every event by type.
 */
export type UserStatus = 'Staged' | 'Invited' | 'Active' | 'Disabled';

export type StatusEvent =
  | 'created_staged'
  | 'created_invited'
  | 'created_active'
  | 'invitation_accepted'
  | 'first_sign_in'
  | 'admin_disable'
  | 'admin_enable';

/**
 * Thrown for a `(status, event)` pair the table does not allow. Package-local,
 * structural-shape error (`@tayzu/auth` does not depend on `@tayzu/catalog`).
 * It carries no status, event or tenant data.
 */
export class StatusTransitionError extends Error {
  readonly code = 'CATALOG_VALIDATION_FAILED';

  constructor() {
    super('The status transition is not allowed');
    this.name = 'StatusTransitionError';
  }
}

interface Transition {
  /** Allowed current statuses; `null` is "the entity does not exist yet". */
  readonly from: readonly (UserStatus | null)[];
  readonly to: UserStatus;
}

const TRANSITIONS: Record<StatusEvent, Transition> = {
  created_staged: { from: [null], to: 'Staged' },
  created_invited: { from: [null, 'Staged', 'Invited'], to: 'Invited' },
  created_active: { from: [null], to: 'Active' },
  invitation_accepted: { from: ['Staged', 'Invited'], to: 'Active' },
  first_sign_in: { from: ['Staged', 'Invited'], to: 'Active' },
  admin_disable: { from: ['Staged', 'Invited', 'Active'], to: 'Disabled' },
  admin_enable: { from: ['Disabled'], to: 'Active' },
};

/** Returns the status after `event`, or throws `StatusTransitionError`. */
export function nextStatus(current: UserStatus | null, event: StatusEvent): UserStatus {
  const transition = TRANSITIONS[event];
  if (!transition.from.includes(current)) {
    throw new StatusTransitionError();
  }
  return transition.to;
}
