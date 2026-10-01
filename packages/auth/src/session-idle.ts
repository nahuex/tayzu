/**
 * The 12-hour idle timeout, shared by `resolveContext` (task 3.2, design D3)
 * and the `/api/auth/*` before hook (task 27.3, design Q75, Q7).
 */

/** design D3, Resolved decision Q7: the idle-timeout window, in milliseconds. */
export const IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000;

/** Whether a session last used at `updatedAt` has been idle past the window. */
export function isIdle(updatedAt: Date, now: number = Date.now()): boolean {
  return now - updatedAt.getTime() > IDLE_TIMEOUT_MS;
}
