/**
 * The session-bound client stores (design D12, State, and Q69). Sign-out and an
 * `unauthenticated` answer reset them, after clearing the query cache. Theme and locale
 * are device preferences, not session state, and stay.
 *
 * No session-bound store exists yet: the step-up dialog store (group 8) adds its reset
 * here.
 */
export function resetSessionStores(): void {
  // Nothing to reset yet.
}
