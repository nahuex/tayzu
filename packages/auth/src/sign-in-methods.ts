/**
 * The last-sign-in-method guard (task 20.3, design D24 "Unlinking and the
 * last-method invariant"). A user must always keep at least one way to sign
 * in: a password (a `credential` account) or a linked SSO account. Shared by
 * `identity.users.unlinkSsoAccount` and any other unlink or password-removal
 * path, so the rule lives in one place.
 */
const CREDENTIAL_PROVIDER_ID = 'credential';

/**
 * True when deleting `removing` would leave `accounts` (every `account` row of
 * one user) with no password and no linked SSO account.
 */
export function wouldLeaveNoSignInMethod(
  accounts: readonly { readonly id: string }[],
  removing: readonly { readonly id: string }[],
): boolean {
  const removed = new Set(removing.map((a) => a.id));
  return accounts.every((a) => removed.has(a.id));
}

export { CREDENTIAL_PROVIDER_ID };
