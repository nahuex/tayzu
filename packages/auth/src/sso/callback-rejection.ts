/**
 * Generic rejection of a failed Visma Connect callback (task 19.4, design
 * D24 "Rejection", spec "Visma Connect SSO sign-in").
 *
 * Better Auth answers a failed `/callback/visma-connect` request with a `302`
 * to its error page, and the `error` query parameter differs per cause. Every
 * failure mode is instead mapped to one identical `401 AUTH_SSO_REJECTED`
 * response; the internal cause is recorded only on
 * `auth.security.sso_sign_in_failed` as `tayzu.auth.failure_reason`.
 *
 * The response carries no cookies, no cause and nothing from the request.
 */
import { SeverityNumber } from '@opentelemetry/api-logs';

import { logger } from '../telemetry/instruments.js';
import { VISMA_CONNECT_PROVIDER_ID } from './visma-connect.js';

/** Path of the callback, relative to Better Auth's base path. */
export const SSO_CALLBACK_PATH = `/callback/${VISMA_CONNECT_PROVIDER_ID}`;

/** design.md, Log events table: the closed `tayzu.auth.failure_reason` values for SSO. */
type SsoFailureReason = 'sso_unlinked' | 'sso_state_mismatch' | 'sso_token_invalid';

const FAILURE_REASON_ATTRIBUTE = 'tayzu.auth.failure_reason';

/**
 * Better Auth's own error codes (`error` query parameter of its error
 * redirect) mapped to the design's closed reasons. Anything not listed is an
 * unverifiable or otherwise invalid token/response.
 */
const UNLINKED_CODES: ReadonlySet<string> = new Set([
  'signup_disabled',
  'account_not_linked',
  'unable_to_link_account',
]);
const STATE_CODES: ReadonlySet<string> = new Set([
  'state_mismatch',
  'state_not_found',
  'invalid_state',
  'please_restart_the_process',
]);

function reasonFor(code: string | null): SsoFailureReason {
  if (code !== null && UNLINKED_CODES.has(code)) {
    return 'sso_unlinked';
  }
  if (code !== null && STATE_CODES.has(code)) {
    return 'sso_state_mismatch';
  }
  return 'sso_token_invalid';
}

/** The Better Auth error code carried by a failed callback response, or `null` when it did not fail. */
export function callbackFailureCode(response: Response): { readonly code: string | null } | null {
  const location = response.headers.get('location');
  if (response.status >= 300 && response.status < 400 && location !== null) {
    const error = new URL(location, 'http://localhost').searchParams.get('error');
    return error === null ? null : { code: error };
  }
  return response.status >= 400 ? { code: null } : null;
}

/** Records the internal cause on the log event; never on the response. */
export function recordSsoSignInFailed(code: string | null): void {
  logger.emit({
    eventName: 'auth.security.sso_sign_in_failed',
    severityNumber: SeverityNumber.WARN,
    attributes: { [FAILURE_REASON_ATTRIBUTE]: reasonFor(code) },
  });
}

/** The one response every failure cause receives (spec Conventions: `AUTH_SSO_REJECTED`, 401). */
export function ssoRejectedResponse(): Response {
  return new Response(
    JSON.stringify({ code: 'AUTH_SSO_REJECTED', message: 'Single sign-on was rejected' }),
    { status: 401, headers: { 'content-type': 'application/json' } },
  );
}
