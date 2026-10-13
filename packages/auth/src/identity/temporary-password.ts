import { randomInt } from 'node:crypto';

/**
 * The shared generator of system-generated temporary passwords (`043` Resolved
 * decision Q136), used by `identity.users.create` and the first-admin bootstrap.
 * Compliant with the password policy of `password-policy.ts` by construction:
 * one character of each required class, the rest drawn from all classes, then a
 * CSPRNG shuffle so the guaranteed characters sit at uniformly random positions.
 * The alphabets are plain ASCII, so no refused character can appear, and a
 * 24-character random draw is never on the common-password denylist.
 */

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%^&*-_=+?';
const ALL = UPPER + LOWER + DIGITS + SYMBOLS;

const TEMPORARY_PASSWORD_LENGTH = 24;

function pick(alphabet: string): string {
  return alphabet.charAt(randomInt(alphabet.length));
}

/** A single-use, policy-compliant temporary password; never persisted or logged. */
export function generateTemporaryPassword(): string {
  const chars = [pick(UPPER), pick(LOWER), pick(DIGITS), pick(SYMBOLS)];
  while (chars.length < TEMPORARY_PASSWORD_LENGTH) chars.push(pick(ALL));
  // Fisher-Yates with a CSPRNG index.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    const tmp = chars[i] as string;
    chars[i] = chars[j] as string;
    chars[j] = tmp;
  }
  return chars.join('');
}

/** Identifier of the `auth.verification` marker that forces a password change (Resolved decision Q36). */
export function temporaryPasswordMarkerIdentifier(userId: string): string {
  return `temp-password:${userId}`;
}

/** The routes a session under an unexpired marker may reach on `/api/auth/*`. */
export const TEMPORARY_PASSWORD_ALLOWED_PATHS: readonly string[] = [
  '/change-password',
  '/sign-out',
  '/get-session',
];

/** The adapter surface the marker lookup needs. */
interface MarkerLookupAdapter {
  findOne(args: {
    readonly model: 'verification';
    where: { field: string; value: string }[];
  }): Promise<{ readonly expiresAt?: unknown } | null>;
}

/** Whether the user holds an unexpired temporary-password marker. Rejects if the lookup fails. */
export async function hasActiveTemporaryPasswordMarker(
  adapter: MarkerLookupAdapter,
  userId: string,
): Promise<boolean> {
  const row = await adapter.findOne({
    model: 'verification',
    where: [{ field: 'identifier', value: temporaryPasswordMarkerIdentifier(userId) }],
  });
  return (
    row !== null &&
    (row.expiresAt instanceof Date || typeof row.expiresAt === 'string') &&
    new Date(row.expiresAt).getTime() > Date.now()
  );
}
