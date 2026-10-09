import { describe, expect, it } from 'vitest';

import { nextStatus, StatusTransitionError } from './user-status.js';

/**
 * `043` task 3.1 (design D2): the creation events of the pure user-status state
 * machine. `current` is `null` for an entity that does not exist yet.
 */
describe('nextStatus: creation events', () => {
  it('New entity without a status starts staged', () => {
    expect(nextStatus(null, 'created_staged')).toBe('Staged');
  });

  it('Explicit invite starts a user as invited', () => {
    expect(nextStatus(null, 'created_invited')).toBe('Invited');
  });

  it('Explicit invite starts a user as invited, from a staged user', () => {
    expect(nextStatus('Staged', 'created_invited')).toBe('Invited');
  });

  it('Explicit invite starts a user as invited, re-inviting an invited user', () => {
    expect(nextStatus('Invited', 'created_invited')).toBe('Invited');
  });

  it('A user created by an admin is active', () => {
    expect(nextStatus(null, 'created_active')).toBe('Active');
  });
});

/**
 * `043` task 3.2 (design D2): the activation events. Limiting `first_sign_in` to a
 * user with exactly one membership is the hook's rule (4.4), not the table's.
 */
describe('nextStatus: activation events', () => {
  it.each(['Staged', 'Invited'] as const)(
    'First sign-in activates a staged or invited user: first_sign_in from %s',
    (current) => {
      expect(nextStatus(current, 'first_sign_in')).toBe('Active');
    },
  );

  it.each(['Staged', 'Invited'] as const)(
    'First sign-in activates a staged or invited user: invitation_accepted from %s',
    (current) => {
      expect(nextStatus(current, 'invitation_accepted')).toBe('Active');
    },
  );

  it('A disabled user is not revived by signing in', () => {
    expect(() => nextStatus('Disabled', 'first_sign_in')).toThrow(StatusTransitionError);
  });

  it('A disabled user is not revived by a pending invitation', () => {
    expect(() => nextStatus('Disabled', 'invitation_accepted')).toThrow(StatusTransitionError);
  });
});
