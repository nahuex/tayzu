/**
 * The strict codec of the stored reset token value (`044` design D3):
 * `v1:<digest>:<userId>:<failures>`. Pure, no I/O. Anything that is not exactly
 * that shape parses to `null` (a non-match).
 */
export interface ResetTokenValue {
  digest: string;
  userId: string;
  failures: number;
}

const VERSION = 'v1';
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const COUNTER_PATTERN = /^(?:0|[1-9][0-9]*)$/;

export function formatResetTokenValue(value: ResetTokenValue): string {
  return `${VERSION}:${value.digest}:${value.userId}:${String(value.failures)}`;
}

export function parseResetTokenValue(raw: string): ResetTokenValue | null {
  const parts = raw.split(':');
  if (parts.length !== 4) return null;
  const [version, digest, userId, counter] = parts;
  if (version !== VERSION) return null;
  if (digest === undefined || !DIGEST_PATTERN.test(digest)) return null;
  if (userId === undefined || userId === '') return null;
  if (counter === undefined || !COUNTER_PATTERN.test(counter)) return null;
  const failures = Number(counter);
  if (!Number.isSafeInteger(failures)) return null;
  return { digest, userId, failures };
}
