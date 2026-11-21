/**
 * The session-bound client stores (design D12, State, and Q69). Sign-out and an
 * `unauthenticated` answer reset them, after clearing the query cache. Theme and locale
 * are device preferences, not session state, and stay.
 */
import { resetStepUpStore } from './step-up.js';

export function resetSessionStores(): void {
  // An open step-up dialog closes, the call waiting on it fails as cancelled, and a
  // pending step-up return notice is dropped.
  resetStepUpStore();
}
