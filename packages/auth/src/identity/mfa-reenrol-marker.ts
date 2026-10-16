import { MARKER_EXPIRES_AT_SENTINEL } from './temporary-password.js';

/**
 * The `mfa-reenrol:<userId>` marker of an MFA reset (044 design D11, Resolved decision Q17):
 * a session of a user holding it is confined to second-factor enrolment. The one production
 * writer is `writeMfaReenrolMarker` in `apps/api`; this module holds the constants and the
 * reader and clearer the hooks use. Its rows carry `MARKER_EXPIRES_AT_SENTINEL`, so Better
 * Auth's cleanup of expired verification rows never removes them.
 */
export { MARKER_EXPIRES_AT_SENTINEL };

/** The constant row value; the marker carries no data. */
export const MFA_REENROL_MARKER_VALUE = 'mfa-reenrol';

export function mfaReenrolMarkerIdentifier(userId: string): string {
  return `mfa-reenrol:${userId}`;
}

/** The adapter surface the reader and clearer need. */
interface MarkerAdapter {
  findOne(args: {
    readonly model: 'verification';
    where: { field: string; value: string }[];
  }): Promise<unknown>;
  deleteMany(args: {
    readonly model: 'verification';
    where: { field: string; value: string }[];
  }): Promise<unknown>;
}

/** Whether the user holds the marker. A failed lookup reads as held (fail closed). */
export async function hasMfaReenrolMarker(
  adapter: MarkerAdapter,
  userId: string,
): Promise<boolean> {
  try {
    const row = await adapter.findOne({
      model: 'verification',
      where: [{ field: 'identifier', value: mfaReenrolMarkerIdentifier(userId) }],
    });
    return row !== null && row !== undefined;
  } catch {
    return true;
  }
}

/** Removes the user's marker; an absent marker is not an error. */
export async function clearMfaReenrolMarker(adapter: MarkerAdapter, userId: string): Promise<void> {
  await adapter.deleteMany({
    model: 'verification',
    where: [{ field: 'identifier', value: mfaReenrolMarkerIdentifier(userId) }],
  });
}
