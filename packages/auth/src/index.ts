/**
 * @tayzu/auth: Better Auth instance, schema and context resolver.
 */
export {
  createAuth,
  type AuthInstance,
  type CreateAuthOptions,
  type MembershipAddedIntent,
  type UserSyncChange,
  type UserSyncPort,
} from './auth.js';
export { createNonSendingEmailSender } from './identity/email/non-sending-sender.js';
export {
  createRecordingEmailSender,
  type EmailSender,
  type EmailTemplate,
} from './identity/email/sender.js';
export {
  createAzureCommunicationEmailSender,
  parseAzureEmailConfig,
} from './identity/email/azure-communication-email.js';
export { nextStatus, type StatusEvent, type UserStatus } from './identity/user-status.js';
export {
  createContextResolver,
  type ContextResolver,
  type ContextResolverOptions,
  type ResolvedActor,
  type ResolvedContext,
} from './context-resolver.js';
export * as authSchema from './persistence/schema.js';
export { AuthContextError, AuthRateLimitedError, AuthStepUpError } from './errors.js';
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
export { emitInternalError } from './internal-error-telemetry.js';
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
export {
  emitIdentityEvent,
  recordIdentityMetric,
  withIdentitySpan,
  type IdentityAttributes,
  type IdentitySeverity,
} from './telemetry/identity-telemetry.js';
export {
  IDENTITY_LOG_EVENTS,
  IDENTITY_METRICS,
  IDENTITY_SPANS,
} from './telemetry/identity-contract.js';
export {
  bootstrapAdmin,
  type BootstrapAdminOptions,
  type BootstrapAdminParams,
  type BootstrapAdminResult,
} from './bootstrap-admin.js';
