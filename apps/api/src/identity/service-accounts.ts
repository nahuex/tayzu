/**
 * Orchestration of service accounts (`043` design D6).
 *
 * Scaffolded by `043` task 1.4 (design Q30); the rest of its behavior arrives with
 * task group 10.
 */

/** A service-account identifier: `svc-` and a letter, then up to 58 more characters (ADR-0017). */
const SERVICE_ACCOUNT_IDENTIFIER_PATTERN = /^svc-[A-Za-z][A-Za-z0-9_-]{0,58}$/;

/** True when the identifier matches the service-account pattern. Pure; never throws. */
export function isValidServiceAccountIdentifier(identifier: string): boolean {
  return SERVICE_ACCOUNT_IDENTIFIER_PATTERN.test(identifier);
}
