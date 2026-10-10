/**
 * The canonical email form (`043` design "Email form", Resolved decisions Q33 and Q60):
 * NFC, trimmed, lower-cased. One pure function, used for the `_user` identifier, the
 * Better Auth email, the invitation email, the cap key and the allowlist domain.
 */
import { ENTITY_IDENTIFIER_PATTERN } from '@tayzu/catalog';

export function canonicalEmail(raw: string): string {
  return raw.normalize('NFC').trim().toLowerCase();
}

/**
 * True when an already-canonical address fits the entity identifier pattern and holds
 * no `/` (the pattern allows it, but it cannot be a path segment).
 */
export function isValidIdentityEmail(canonical: string): boolean {
  return ENTITY_IDENTIFIER_PATTERN.test(canonical) && !canonical.includes('/');
}
