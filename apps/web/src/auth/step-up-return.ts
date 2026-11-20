/**
 * The Visma Connect step-up return path (design D11, Step-up dialog, D15 and Q14, Q65,
 * Q76): the only value the app keeps in `sessionStorage`, an in-app path under
 * `tayzu.stepUp.returnTo`, written on the click that leaves for Visma Connect and read
 * and deleted by `/step-up/complete`. It always goes through `safeReturnPath`, both ways.
 * Storage that throws never breaks the round trip: the return then lands on `/`.
 */
import { safeReturnPath } from '../lib/return-path.js';

export const STEP_UP_RETURN_KEY = 'tayzu.stepUp.returnTo';

/** The path to store: validated, and `/search` without its query, never stored (Q65). */
function storablePath(path: string): string {
  const safe = safeReturnPath(path);
  return safe === '/search' || safe.startsWith('/search?') ? '/search' : safe;
}

/** Stores `path` (the router's current path and query) as the step-up return path. */
export function saveStepUpReturnPath(path: string): void {
  try {
    window.sessionStorage.setItem(STEP_UP_RETURN_KEY, storablePath(path));
  } catch {
    // Storage is disabled: the return lands on `/`.
  }
}

/** Reads the stored return path once and deletes it; missing, invalid or unreadable is `/`. */
export function takeStepUpReturnPath(): string {
  try {
    const storage = window.sessionStorage;
    const stored = storage.getItem(STEP_UP_RETURN_KEY);
    storage.removeItem(STEP_UP_RETURN_KEY);
    return safeReturnPath(stored);
  } catch {
    return safeReturnPath(undefined);
  }
}
