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

/**
 * `043` task 3.3 (design D2): an `Active` user never regresses to `Invited` or
 * `Staged`, and the rejection carries the catalog validation code without a
 * dependency on `@tayzu/catalog`.
 */
describe('nextStatus: Active never regresses', () => {
  it.each(['created_invited', 'created_staged'] as const)(
    'Active never regresses to invited or staged: %s from Active throws StatusTransitionError',
    (event) => {
      expect(() => nextStatus('Active', event)).toThrow(StatusTransitionError);
    },
  );

  it.each(['created_invited', 'created_staged'] as const)(
    'Active never regresses to invited or staged: the %s error code is CATALOG_VALIDATION_FAILED',
    (event) => {
      let thrown: unknown;
      try {
        nextStatus('Active', event);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(StatusTransitionError);
      expect((thrown as StatusTransitionError).code).toBe('CATALOG_VALIDATION_FAILED');
    },
  );
});

/**
 * `043` task 3.4 (design D2): the admin events. `admin_disable` moves a staged,
 * invited or active user to `Disabled`; `admin_enable` is only valid from
 * `Disabled` and always lands on `Active`.
 */
describe('nextStatus: admin events', () => {
  it.each(['Staged', 'Invited', 'Active'] as const)(
    'Disable and re-enable: admin_disable from %s gives Disabled',
    (current) => {
      expect(nextStatus(current, 'admin_disable')).toBe('Disabled');
    },
  );

  it('Disable and re-enable: an active user is disabled and then re-enabled to Active', () => {
    const disabled = nextStatus('Active', 'admin_disable');
    expect(disabled).toBe('Disabled');
    expect(nextStatus(disabled, 'admin_enable')).toBe('Active');
  });

  it('Disable and re-enable: admin_enable from Disabled gives Active', () => {
    expect(nextStatus('Disabled', 'admin_enable')).toBe('Active');
  });

  it.each([null, 'Staged', 'Invited', 'Active'] as const)(
    'admin_enable is rejected from a non-Disabled status: %s throws StatusTransitionError',
    (current) => {
      expect(() => nextStatus(current, 'admin_enable')).toThrow(StatusTransitionError);
    },
  );
});

/**
 * `043` task 3.5 (design D2): the full `(status, event)` matrix. The expected table
 * is written out cell by cell from the design's transition table, so a cell that is
 * not listed as allowed must be an explicit `StatusTransitionError`, never
 * `undefined` and never a silent value.
 */
describe('nextStatus: exhaustive matrix', () => {
  const statuses = [null, 'Staged', 'Invited', 'Active', 'Disabled'] as const;
  const events = [
    'created_staged',
    'created_invited',
    'created_active',
    'invitation_accepted',
    'first_sign_in',
    'admin_disable',
    'admin_enable',
  ] as const;

  type Cell = (typeof statuses)[number];
  type Expected = 'Staged' | 'Invited' | 'Active' | 'Disabled' | 'rejected';

  const expected: Record<(typeof events)[number], Record<'none' | NonNullable<Cell>, Expected>> = {
    created_staged: {
      none: 'Staged',
      Staged: 'rejected',
      Invited: 'rejected',
      Active: 'rejected',
      Disabled: 'rejected',
    },
    created_invited: {
      none: 'Invited',
      Staged: 'Invited',
      Invited: 'Invited',
      Active: 'rejected',
      Disabled: 'rejected',
    },
    created_active: {
      none: 'Active',
      Staged: 'rejected',
      Invited: 'rejected',
      Active: 'rejected',
      Disabled: 'rejected',
    },
    invitation_accepted: {
      none: 'rejected',
      Staged: 'Active',
      Invited: 'Active',
      Active: 'rejected',
      Disabled: 'rejected',
    },
    first_sign_in: {
      none: 'rejected',
      Staged: 'Active',
      Invited: 'Active',
      Active: 'rejected',
      Disabled: 'rejected',
    },
    admin_disable: {
      none: 'rejected',
      Staged: 'Disabled',
      Invited: 'Disabled',
      Active: 'Disabled',
      Disabled: 'rejected',
    },
    admin_enable: {
      none: 'rejected',
      Staged: 'rejected',
      Invited: 'rejected',
      Active: 'rejected',
      Disabled: 'Active',
    },
  };

  const cells = events.flatMap((event) =>
    statuses.map((status) => ({
      event,
      status,
      want: expected[event][status ?? 'none'],
    })),
  );

  it('covers 5 statuses against 7 events', () => {
    expect(cells).toHaveLength(35);
  });

  it.each(cells)('cell ($status, $event) is $want', ({ status, event, want }) => {
    if (want === 'rejected') {
      expect(() => nextStatus(status, event)).toThrow(StatusTransitionError);
      return;
    }
    expect(nextStatus(status, event)).toBe(want);
  });

  it('never returns undefined for any cell', () => {
    for (const { status, event, want } of cells) {
      if (want === 'rejected') continue;
      expect(nextStatus(status, event)).toBeDefined();
    }
  });
});
