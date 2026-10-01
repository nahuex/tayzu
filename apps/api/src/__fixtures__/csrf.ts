/**
 * CSRF header helper for apps/api integration tests (task 11.5, design D13).
 *
 * `createApp` registers oRPC's `SimpleCsrfProtectionHandlerPlugin`, which
 * requires `x-csrf-token: orpc` on every mutating `/v1` route. Tests that make
 * legitimate mutating requests spread `csrfHeaders(method)` into their headers.
 * Read-only methods get no header, so they keep exercising the exemption.
 */
export const CSRF_HEADERS: Readonly<Record<string, string>> = { 'x-csrf-token': 'orpc' };

export function csrfHeaders(method: string): Record<string, string> {
  const upper = method.toUpperCase();
  return upper === 'GET' || upper === 'HEAD' || upper === 'OPTIONS' ? {} : { ...CSRF_HEADERS };
}
