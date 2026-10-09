import { describe, expect, it } from 'vitest';

import { nextStatus } from './user-status.js';

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
