/**
 * @tayzu/auth: Better Auth instance, schema and context resolver.
 */
export {
  createAuth,
  type AuthInstance,
  type CreateAuthOptions,
  type UserSyncPort,
} from './auth.js';
export {
  createContextResolver,
  type ContextResolver,
  type ContextResolverOptions,
  type ResolvedActor,
  type ResolvedContext,
} from './context-resolver.js';
export * as authSchema from './persistence/schema.js';
export { AuthContextError, AuthStepUpError } from './errors.js';
export {
  exchangeMachineToken,
  type ExchangeMachineTokenParams,
  type ExchangedMachineToken,
} from './token-exchange.js';
export {
  createEnrolledStepUpCheck,
  createStepUpGuard,
  type AssertStepUpParams,
  type StepUpGuard,
  type StepUpGuardOptions,
} from './step-up.js';
export { ALLOWED_AUTH_ROUTES, AUTH_BASE_PATH, isAllowedAuthPath } from './http/allowed-routes.js';
export { wouldLeaveNoSignInMethod } from './sign-in-methods.js';
export { emitAccountLinkEvent, type AccountLinkActor } from './account-link-telemetry.js';
export {
  verifyLogoutToken,
  type LogoutTokenExpectation,
  type VerifiedLogoutToken,
} from './sso/backchannel-logout.js';
export {
  withBackchannelLogoutTelemetry,
  type BackchannelLogoutOutcome,
} from './backchannel-logout-telemetry.js';
export { emitRateLimited, type RateLimitScope } from './rate-limit/pre-auth-rate-limit.js';
