/**
 * Task 9.4 of openspec/changes/archive/2026-10-14-043-identity-lifecycle-and-org-admin
 * (design D7 and D8; Resolved decision Q20).
 *
 * `rotationDueAt` is computed from the credential's `metadata.rotatedAt`, or from its
 * `createdAt` for a credential never rotated, plus the configured interval (default 90 days).
 * It is a policy default, so a credential is "flagged due" when `rotationDueAt <= now`.
 *
 * Cases (task Verify clause):
 * - a credential rotated 91 days ago is flagged due
 * - a credential rotated yesterday is not
 * - a credential never rotated, created 91 days ago, is flagged due
 * - a credential never rotated, created yesterday, is not
 *
 * ## Production symbols expected
 *
 * - `./credentials.js` exports `DEFAULT_ROTATION_INTERVAL_DAYS` (90) and the pure function
 *   `computeRotationDueAt(args: { rotatedAt?: string; createdAt: Date; intervalDays?: number }): Date`
 *   which returns `new Date(rotatedAt ?? createdAt) + intervalDays days` (`intervalDays` defaults
 *   to `DEFAULT_ROTATION_INTERVAL_DAYS`). An unparseable `rotatedAt` falls back to `createdAt`.
 *   `listCredentials` uses it for `CredentialView.rotationDueAt`.
 *
 * ## Why this fails right now
 *
 * `./credentials.js` exports neither symbol (the viewer returns `rotationDueAt: null`).
 */
import { describe, expect, it } from 'vitest';

import { computeRotationDueAt, DEFAULT_ROTATION_INTERVAL_DAYS } from './credentials.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-12T12:00:00.000Z');

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

function isDue(dueAt: Date): boolean {
  return dueAt.getTime() <= NOW.getTime();
}

describe('rotationDueAt (task 9.4)', () => {
  it('defaults the interval to 90 days', () => {
    expect(DEFAULT_ROTATION_INTERVAL_DAYS).toBe(90);
  });

  it('flags a credential rotated 91 days ago as due', () => {
    const dueAt = computeRotationDueAt({
      rotatedAt: daysAgo(91).toISOString(),
      createdAt: daysAgo(400),
    });
    expect(dueAt.getTime()).toBe(daysAgo(91).getTime() + 90 * DAY_MS);
    expect(isDue(dueAt)).toBe(true);
  });

  it('does not flag a credential rotated yesterday', () => {
    const dueAt = computeRotationDueAt({
      rotatedAt: daysAgo(1).toISOString(),
      createdAt: daysAgo(400),
    });
    expect(dueAt.getTime()).toBe(daysAgo(1).getTime() + 90 * DAY_MS);
    expect(isDue(dueAt)).toBe(false);
  });

  it('flags a never-rotated credential created 91 days ago as due', () => {
    const dueAt = computeRotationDueAt({ createdAt: daysAgo(91) });
    expect(dueAt.getTime()).toBe(daysAgo(91).getTime() + 90 * DAY_MS);
    expect(isDue(dueAt)).toBe(true);
  });

  it('does not flag a never-rotated credential created yesterday', () => {
    const dueAt = computeRotationDueAt({ createdAt: daysAgo(1) });
    expect(dueAt.getTime()).toBe(daysAgo(1).getTime() + 90 * DAY_MS);
    expect(isDue(dueAt)).toBe(false);
  });

  it('counts from rotatedAt, not createdAt, when both exist', () => {
    const dueAt = computeRotationDueAt({
      rotatedAt: daysAgo(1).toISOString(),
      createdAt: daysAgo(91),
    });
    expect(isDue(dueAt)).toBe(false);
  });

  it('honors a configured interval', () => {
    const dueAt = computeRotationDueAt({ createdAt: daysAgo(31), intervalDays: 30 });
    expect(dueAt.getTime()).toBe(daysAgo(31).getTime() + 30 * DAY_MS);
    expect(isDue(dueAt)).toBe(true);
  });
});
