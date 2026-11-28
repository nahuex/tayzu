/**
 * The Fastify bootstrap (task 11.1, design D13). One Fastify instance mounts
 * two handlers: Better Auth's own catch-all route (`/api/auth/*`) and the
 * catalog's `OpenAPIHandler` (`/v1/*`).
 *
 * Every `/v1/*` request's context comes only from `resolveContext`
 * (`@tayzu/auth`); nothing in the body, path or query is ever read for
 * `tenantId` or `actor`. `createApp` reads no environment: the process entry
 * point hands it explicit options. Later group 11 tasks add CORS, CSRF,
 * headers, body limits, rate limiting, the route allowlist and error mapping.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import fastifyCors from '@fastify/cors';
import fastifyHelmet, { type FastifyHelmetOptions } from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import { OpenAPIHandler } from '@orpc/openapi/fastify';
import { ORPCError } from '@orpc/server';
import { ResponseHeadersPlugin, SimpleCsrfProtectionHandlerPlugin } from '@orpc/server/plugins';
import {
  authSchema,
  createAuth,
  createContextResolver,
  createEnrolledStepUpCheck,
  createSessionStateResolver,
  createRateLimitBucketStore,
  createServiceAccountLookup,
  createStepUpGuard,
  createTenantDeletionLookup,
  emitInternalError,
  emitRateLimited,
  exchangeMachineToken,
  AuthStepUpError,
  isAllowedAuthPath,
  verifyLogoutToken,
  withBackchannelLogoutTelemetry,
  withIdentitySpan,
  type AuthInstance,
  type BackchannelLogoutOutcome,
  type CreateAuthOptions,
  type EmailSender,
  type RateLimitBucketStoreOptions,
  type ResetFactorInput,
} from '@tayzu/auth';
import { createCerbosClient } from '@tayzu/authz';
import type { createPool } from '@tayzu/db';
import {
  createBlueprintService,
  createCatalogRouter,
  createEntityService,
  createUserSync,
} from '@tayzu/catalog';
import { drizzle } from 'drizzle-orm/node-postgres';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { createIdentityRouter } from './identity-router.js';
import { createAcceptFlow } from './identity/accept-flow.js';
import { createAcceptRateLimitPreHandler } from './identity/accept-rate-limit.js';
import { createAuthRepository } from './identity/auth-repository.js';
import { createDbEmailCapStore } from './identity/email-cap-store.js';
import { createEmailTenantGate } from './identity/email-tenant-gate.js';
import { createWithUserLock } from './identity/user-lock.js';
import { IdentityInputError } from './identity/parse-input.js';
import { applyNoCacheHeaders } from './identity/no-cache.js';
import { createPasswordResetConfirmFlow } from './identity/password-reset-confirm.js';
import { createPasswordResetRequestFlow } from './identity/password-reset-request.js';
import { createRecoveryEligibility } from './identity/recovery-eligibility.js';
import { createRecoveryMailer, type RecoveryMailer } from './identity/recovery-mailer.js';
import { createResetTokenStore } from './identity/reset-token-store.js';
import { createMfaResetService } from './identity/mfa-reset.js';
import { createMailerNoticePort } from './identity/mfa-reset-notice.js';
import { createNoticeDispatcher } from './identity/notices.js';
import { createSsoLinkShed } from './identity/sso-link-shed.js';
import { createUserSyncAdapter } from './identity/user-sync-adapter.js';
import { errorMappingInterceptor, toOrpcError } from './error-mapping.js';
import { createReauthorization, type Reauthorization } from './reauthorization.js';
import { assertDiscoverable } from './sso-discovery.js';
import { DEFAULT_SPA_FALLBACK_RATE_LIMIT, registerSpaFallback } from './spa-fallback.js';
import { assignStyleNonce, styleNonceOf } from './style-nonce.js';
import { TEST_TRUST_PROXY, type TrustProxy } from './trust-proxy.js';
import { registerWebStatic } from './web-static.js';

type Pool = ReturnType<typeof createPool>;

export interface CreateAppOptions {
  /** Pool running as `tayzu_app` (RLS applies), built by the host. Not ended by `close`. */
  readonly appPool: Pool;
  /** Pool running as `tayzu_auth` (design D6), built by the host. Not ended by `close`. */
  readonly authPool: Pool;
  /** Better Auth's secret, from the host's environment. */
  readonly authSecret: string;
  /** `host:port` of the Cerbos gRPC endpoint. */
  readonly cerbosAddress: string;
  /** Explicit CORS origin allowlist: exact matches only, never `*` or a reflected origin. */
  readonly allowedOrigins: readonly string[];
  /**
   * Public base URL (Q40): forwarded to `createAuth` as `baseURL` and used to
   * build the web `Request` URL. Omitted only in the test harness.
   */
  readonly baseUrl?: string;
  /**
   * Maximum request body in bytes (D13), enforced by Fastify with a 413 before
   * any handler runs. Omitted: Fastify's default (1 MiB).
   */
  readonly bodyLimit?: number;
  /**
   * Per-principal budget for `/v1/*` (D13). The bucket key is
   * `${tenantId}:${actor.type}:${actor.id}` from `resolveContext`; omitted: no limiter.
   */
  readonly rateLimit?: { readonly max: number; readonly timeWindowMs: number };
  /**
   * Budget for `POST /v1/auth/token` (D20), independent of `rateLimit`. The
   * bucket key is the caller's IP plus the body's client id; omitted: no limiter.
   */
  readonly machineCredentialRateLimit?: CreateAuthOptions['machineCredentialRateLimit'];
  readonly tokenExchangeRateLimit?: { readonly max: number; readonly timeWindowMs: number };
  /** Visma Connect SSO (D23), forwarded to `createAuth`; omitted: SSO is not registered. */
  readonly sso?: CreateAuthOptions['sso'];
  /** Better Auth's pre-auth limits (D20), forwarded to `createAuth`; omitted: none. */
  readonly preAuthRateLimit?: CreateAuthOptions['rateLimit'];
  /** Back-channel logout budget per source IP per minute (D26, Q32); omitted: 600. */
  readonly backchannelLogoutRateLimitPerMinute?: number;
  /**
   * Limit of the public re-authorization callback (043 task 13.9), per caller IP on the
   * DB-backed store, consumed before the callback's database `delete`. `window` is in
   * seconds; omitted: no limiter.
   */
  readonly reauthorizationMaxPendingPerSession?: number;
  /** Defaults to 10 per 60 seconds when omitted (043 task 14.20). */
  readonly reauthorizationCallbackRateLimit?: { readonly max: number; readonly window: number };
  /** Limit of the public invitation-accept route, per caller IP; `window` is in seconds. */
  readonly invitationAcceptRateLimit?: { readonly max: number; readonly window: number };
  /**
   * 043 task 14.11 (D5, Q138): the email settings of the production start. With the
   * identity routes mounted they are required (044 D9, Q36 N4): `createApp` builds the one
   * gate from them and hands the gate and the link base URL to the identity router.
   */
  readonly email?: {
    readonly sender: EmailSender;
    readonly invitationLinkBaseUrl?: string;
    /** 044 task 6.1 (D9): the origin of the emailed reset link (`PASSWORD_RESET_LINK_BASE_URL`). */
    readonly passwordResetLinkBaseUrl?: string;
    /** 044 task 6.4 (D4, D9): the minimum duration of a reset request answer, in ms (default 400). */
    readonly passwordResetMinResponseMs?: number;
    readonly disabledTenantIds: readonly string[];
    readonly killSwitch: boolean;
    /** 044 task 6.3 (D5): the mailer's admission refuses a recipient domain off this list. */
    readonly recipientDomainAllowlist?: readonly string[];
    readonly recipientKeySecret?: string;
    readonly tenantCap: { readonly max: number; readonly windowSeconds: number };
    readonly recipientCap: { readonly max: number; readonly windowSeconds: number };
    /** The notices' buckets (Q101, 6.12b); the defaults are 60 per hour and 3 per 24 hours. */
    readonly noticeTenantCap?: { readonly max: number; readonly windowSeconds: number };
    readonly noticeRecipientCap?: { readonly max: number; readonly windowSeconds: number };
    /** 044 task 4.3 (D16): the reset and recovery buckets, built from `Config` by the production start. */
    readonly passwordResetRequestRateLimit?: {
      readonly max: number;
      readonly windowSeconds: number;
    };
    readonly passwordResetConfirmRateLimit?: {
      readonly max: number;
      readonly windowSeconds: number;
    };
    readonly passwordResetRecipientCap?: { readonly max: number; readonly windowSeconds: number };
    readonly passwordResetIpCap?: { readonly max: number; readonly windowSeconds: number };
    readonly passwordResetGlobalCap?: { readonly max: number; readonly windowSeconds: number };
    readonly recoveryNoticeRecipientCap?: { readonly max: number; readonly windowSeconds: number };
    readonly accountCreatedNoticeTenantCap?: {
      readonly max: number;
      readonly windowSeconds: number;
    };
    readonly accountCreatedNoticeGlobalCap?: {
      readonly max: number;
      readonly windowSeconds: number;
    };
  };
  /**
   * 043 task 14.3 (D15): mounts the identity routes (the accept route and the identity
   * procedures). Omitted: off, and each answers like an unknown `/v1` path.
   */
  readonly mountIdentityRoutes?: boolean;
  /**
   * `IDENTITY_TOKEN_HMAC_SECRET` (Q147, O-5): the secret of the recipient key. With the
   * identity routes mounted, `createApp` refuses to start without it (or `email.recipientKeySecret`).
   */
  readonly identityTokenHmacSecret?: string;
  /** 043 task 14.18 (Q138): the credential and service-account caps handed to the identity router. */
  readonly credentialCap?: number;
  readonly serviceAccountCap?: number;
  /** 045 D1 (Q21): the org-deletion window in days, validated by `loadConfig` (7 to 14). */
  readonly orgDeletionWindowDays?: number;
  /**
   * 003 D9 (Q21): the absolute path of the web build (`WEB_DIST_DIR`). Omitted: the API
   * alone, every answer exactly as before. Set: the Visma Connect re-authorization
   * callback answers `303` to a fixed `/step-up/complete` path instead of JSON (D11, Q14),
   * and the build's assets, root build files and SPA fallback are served (D9,
   * `web-static.ts`, `spa-fallback.ts`).
   */
  readonly webDistDir?: string;
  /**
   * 003 D9 "Rate limit": the SPA fallback's own bucket, keyed by the client address and
   * counting only requests answered with the app. Defaults to 300 per minute. Ignored
   * without `webDistDir`.
   */
  readonly spaFallbackRateLimit?: { readonly max: number; readonly timeWindowMs: number };
  /**
   * 043 task 14.3b: called once with the Fastify instance, before any hook or route is
   * registered. Lets a host or a test observe the route table (`onRoute`) or add a route.
   */
  readonly configureApp?: (app: FastifyInstance) => void | Promise<void>;
  /**
   * 048 D2 (Q6): which peers may set the client address through `X-Forwarded-For`. The
   * production start passes `createTrustProxy({ hops, cidrs })` built from
   * `TRUST_PROXY_HOPS` and `TRUST_PROXY_CIDRS`; omitted, the test list
   * (`TEST_TRUST_PROXY`), which `loadConfig` keeps only under `NODE_ENV=test`.
   */
  readonly trustProxy?: TrustProxy;
}

export interface App {
  /** The Fastify instance; never listening until the host calls `listen`. */
  readonly app: FastifyInstance;
  /** The same Better Auth instance mounted at `/api/auth/*`. */
  readonly auth: AuthInstance;
  /** Closes Fastify only; the host owns the injected pools. */
  close(): Promise<void>;
}

/** Better Auth's runtime `handler` (`AuthInstance` types its surface as `unknown`). */
interface AuthHandlerSurface {
  handler(request: Request): Promise<Response>;
}

/** The slice of `auth.api.getSession` the MFA enrollment gate reads. */
interface AuthSessionSurface {
  getSession(args: {
    headers: Headers;
  }): Promise<{ user?: { twoFactorEnabled?: boolean | null } } | null>;
}

const STEP_UP_HEADERS = '__stepUpHeaders';
/** Resolved decision Q42: the key `identity-router.ts` reads the request's session headers from. */
const REQUEST_HEADERS = '__requestHeaders';

interface StepUpHandlerContext {
  readonly [STEP_UP_HEADERS]: Headers;
  readonly tenantId: string;
  readonly actor: { readonly type: string; readonly id: string };
}

const TOKEN_EXCHANGE_PATH = '/v1/auth/token';
/** 003 D8: the shell's view of its own session. */
const ME_PATH = '/v1/me';
/** 003 "Observability contract": the gate attribute of `identity.session.me`. */
const SESSION_GATE = 'tayzu.identity.session.gate';
const INVITATION_ACCEPT_PATH = '/v1/auth/invitations/accept';
const PASSWORD_RESET_REQUEST_PATH = '/v1/auth/password-reset/request';
const PASSWORD_RESET_CONFIRM_PATH = '/v1/auth/password-reset/confirm';
/** Default budget of the public accept route, per caller IP (window in seconds). */
const DEFAULT_INVITATION_ACCEPT_RATE_LIMIT = { max: 10, window: 60 } as const;
const DEFAULT_REAUTHORIZATION_CALLBACK_RATE_LIMIT = { max: 10, window: 60 } as const;
/** Skew added to the token's `exp` for the replay record's lifetime (D26). */
const LOGOUT_JTI_SKEW_SECONDS = 30;
/** Generous per-IP floor (D26): high enough not to drop legitimate logout bursts. */
const DEFAULT_BACKCHANNEL_LOGOUT_MAX_PER_MINUTE = 600;
const BACKCHANNEL_LOGOUT_PATH = '/v1/auth/visma-connect/backchannel-logout';
/** Q36: where Visma Connect returns from a step-up re-authorization. */
const REAUTH_CALLBACK_PATH = '/v1/auth/visma-connect/reauthorize/callback';
/**
 * 003 D11 (Q14): where the callback sends the browser back when the web app is served.
 * Constants only, never derived from the request or the OIDC state (no open redirect).
 */
const STEP_UP_COMPLETE_LOCATION = '/step-up/complete';
const STEP_UP_FAILED_LOCATION = '/step-up/complete?result=failed';
const STEP_UP_RATE_LIMITED_LOCATION = '/step-up/complete?result=rate_limited';

/**
 * 003 D10 (ADR-0026, Q5, Q25): the exact directive list, with no helmet defaults, so
 * neither `upgrade-insecure-requests` nor `script-src-attr` is sent. `style-src` carries
 * the per-response nonce (Q15, task 4.5) through a directive function; `script-src` has
 * none, which is why helmet's `enableCSPNonces` (hex, and on `script-src` too) is unused.
 */
const CSP_DIRECTIVES = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': [
    "'self'",
    (_req: IncomingMessage, res: ServerResponse) => `'nonce-${styleNonceOf(res)}'`,
  ],
  'img-src': ["'self'"],
  'font-src': ["'self'"],
  'connect-src': ["'self'"],
  'media-src': ["'none'"],
  'object-src': ["'none'"],
  'frame-src': ["'none'"],
  'worker-src': ["'none'"],
  'manifest-src': ["'self'"],
  'base-uri': ["'none'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
};

/**
 * 003 D10: `X-Frame-Options: DENY` (matching `frame-ancestors 'none'`) and COEP
 * `require-corp`; COOP and CORP `same-origin`, `Referrer-Policy: no-referrer` and the
 * rest are helmet's defaults. HSTS is 002's (task 11.12).
 */
const SECURITY_HEADERS: FastifyHelmetOptions = {
  contentSecurityPolicy: { useDefaults: false, directives: CSP_DIRECTIVES },
  xFrameOptions: { action: 'deny' },
  crossOriginEmbedderPolicy: { policy: 'require-corp' },
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  referrerPolicy: { policy: 'no-referrer' },
  strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true },
};

/** 003 D10: every powerful feature off; no `interest-cohort` (a Chromium console error). */
const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=()';

/** Q74: the path of the request target, without its query. Every guard keys on this. */
/** A configured cap as the bucket store's rule. */
function ruleOf(cap: { readonly max: number; readonly windowSeconds: number }) {
  return { max: cap.max, window: cap.windowSeconds };
}

function pathnameOf(request: FastifyRequest): string {
  return request.url.split('?', 1)[0] ?? '';
}

function isTokenExchange(request: FastifyRequest): boolean {
  return request.method === 'POST' && pathnameOf(request) === TOKEN_EXCHANGE_PATH;
}

/** A resolution's outcome, kept so a rejection is answered, never rethrown unhandled. */
type Resolution<T> = { readonly value: T } | { readonly error: unknown };

/**
 * Runs `resolve` at most once per request over its headers: the rate-limit key generator
 * and the handler share the result.
 */
function oncePerRequest<T>(
  resolve: (headers: Headers) => Promise<T>,
): (request: FastifyRequest) => Promise<Resolution<T>> {
  const resolutions = new WeakMap<FastifyRequest, Promise<Resolution<T>>>();
  return (request) => {
    let pending = resolutions.get(request);
    if (pending === undefined) {
      pending = resolve(toWebHeaders(request)).then(
        (value): Resolution<T> => ({ value }),
        (error: unknown): Resolution<T> => ({ error }),
      );
      resolutions.set(request, pending);
    }
    return pending;
  };
}

const CERBOS_TLS_LOOPBACK_ONLY = /^(localhost|127\.0\.0\.1|\[::1\]):\d+$/;

function toWebHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') {
      headers.set(name, value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
    }
  }
  return headers;
}

function toWebRequest(request: FastifyRequest, baseUrl: string | undefined): Request {
  const headers = toWebHeaders(request);
  // Better Auth keys its pre-auth rate-limit buckets by `x-forwarded-for`. Replace
  // whatever the caller sent with the address Fastify resolved from the real peer
  // (honoring `trustProxy`), so a spoofed or multi-hop header cannot pick a bucket.
  headers.set('x-forwarded-for', request.ip);
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  let body: string | undefined;
  if (hasBody && request.body !== undefined && request.body !== null) {
    body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
    headers.delete('content-length');
  }
  return new Request(
    new URL(request.url, baseUrl ?? `http://${request.headers.host ?? 'localhost'}`),
    {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
    },
  );
}

type EmailOptions = NonNullable<CreateAppOptions['email']>;

export async function createApp(options: CreateAppOptions): Promise<App> {
  // Q48, D23: a configured provider that cannot be discovered fails startup.
  const ssoIssuer =
    options.sso === undefined ? undefined : await assertDiscoverable(options.sso.discoveryUrl);
  // The auth handle runs on the host's `tayzu_auth` pool; the catalog and
  // revocation pool run as `tayzu_app` so RLS applies.
  const authDb = drizzle(options.authPool, { schema: authSchema });
  const appPool = options.appPool;

  const authz = createCerbosClient({
    address: options.cerbosAddress,
    tls: !CERBOS_TLS_LOOPBACK_ONLY.test(options.cerbosAddress),
  });
  // Q30: the status adapter every `_user` writer goes through.
  const userSync = createUserSyncAdapter({ userSync: createUserSync({ pool: appPool, authz }) });

  // Q30: the shed core is built once; `createAuth` takes its port, the accept flow the core.
  const ssoLinkShed = createSsoLinkShed({ authPool: options.authPool });
  // The recovery mailer needs the cap store, which needs `auth`; the port reads it late.
  const accountNoticeMailer: { current?: RecoveryMailer } = {};
  const accountNoticeRepository = createAuthRepository(options.authPool);
  const accountNotices: NonNullable<CreateAuthOptions['accountNotices']> = {
    async notify(kind, { userId }) {
      try {
        const mailer = accountNoticeMailer.current;
        if (mailer === undefined) return;
        const user = await accountNoticeRepository.globalUserById(userId);
        if (user === undefined) return;
        const tenantIds = await accountNoticeRepository.globalMembershipTenantsOf(userId);
        await mailer.sendNotice({ kind, address: user.email, userId, tenantIds });
      } catch {
        // A notice never fails the password change that triggered it.
      }
    },
  };
  const auth = createAuth({
    db: authDb,
    userSync,
    accountNotices,
    ssoLinkShed: ssoLinkShed.port,
    secret: options.authSecret,
    ...(options.baseUrl === undefined ? {} : { baseURL: options.baseUrl }),
    trustedOrigins: options.allowedOrigins,
    ...(options.sso === undefined ? {} : { sso: options.sso }),
    ...(options.preAuthRateLimit === undefined ? {} : { rateLimit: options.preAuthRateLimit }),
    ...(options.machineCredentialRateLimit === undefined
      ? {}
      : { machineCredentialRateLimit: options.machineCredentialRateLimit }),
  });
  const resolveContext = createContextResolver({ auth, revocationPool: appPool });
  const serviceAccountLookup = createServiceAccountLookup(appPool);
  const tenantDeletionLookup = createTenantDeletionLookup(appPool);

  const { email } = options;
  const recipientKeySecret =
    options.identityTokenHmacSecret === undefined
      ? email?.recipientKeySecret
      : options.identityTokenHmacSecret;
  // Q147 runs first; then the email path must exist whenever the identity routes mount
  // (D9 startup rules, Q36 N4). Only variable names are named, never values.
  let mountedEmail:
    | {
        readonly settings: EmailOptions;
        readonly secret: string;
        readonly resetLinkBaseUrl: string;
      }
    | undefined;
  if (options.mountIdentityRoutes === true) {
    if (recipientKeySecret === undefined || recipientKeySecret === '') {
      throw new Error('IDENTITY_TOKEN_HMAC_SECRET is required to mount the identity routes.');
    }
    if (email === undefined) {
      throw new Error('EMAIL_PROVIDER is required to mount the identity routes.');
    }
    const resetLinkBaseUrl = email.passwordResetLinkBaseUrl;
    if (resetLinkBaseUrl === undefined || resetLinkBaseUrl === '') {
      throw new Error('PASSWORD_RESET_LINK_BASE_URL is required to mount the identity routes.');
    }
    if ((email.sender as EmailSender | undefined) === undefined) {
      throw new Error(
        'EMAIL_PROVIDER must configure an email sender to mount the identity routes.',
      );
    }
    mountedEmail = { settings: email, secret: recipientKeySecret, resetLinkBaseUrl };
  }
  /** The gate, the notice dispatcher and the recovery mailer, over one shared cap store (Q138). */
  const buildEmailPath = async (settings: EmailOptions, secret: string) => {
    const capStore = createDbEmailCapStore({
      globalWindowSeconds: {
        reset_global: (settings.passwordResetGlobalCap ?? { windowSeconds: 3600 }).windowSeconds,
        account_created_global: (
          settings.accountCreatedNoticeGlobalCap ?? { windowSeconds: 86_400 }
        ).windowSeconds,
      },
      store: createRateLimitBucketStore({
        adapter: ((await auth.$context) as { adapter: RateLimitBucketStoreOptions['adapter'] })
          .adapter,
        rules: {
          invitation_tenant: ruleOf(settings.tenantCap),
          invitation_recipient: ruleOf(settings.recipientCap),
          notice_tenant: ruleOf(settings.noticeTenantCap ?? { max: 60, windowSeconds: 3600 }),
          notice_recipient: ruleOf(
            settings.noticeRecipientCap ?? { max: 3, windowSeconds: 86_400 },
          ),
          reset_email_recipient: ruleOf(
            settings.passwordResetRecipientCap ?? { max: 5, windowSeconds: 3600 },
          ),
          reset_email_ip: ruleOf(settings.passwordResetIpCap ?? { max: 10, windowSeconds: 3600 }),
          reset_email_global: ruleOf(
            settings.passwordResetGlobalCap ?? { max: 600, windowSeconds: 3600 },
          ),
          recovery_notice_recipient: ruleOf(
            settings.recoveryNoticeRecipientCap ?? { max: 10, windowSeconds: 86_400 },
          ),
          account_created_notice_tenant: ruleOf(
            settings.accountCreatedNoticeTenantCap ?? { max: 20, windowSeconds: 86_400 },
          ),
          account_created_notice_global: ruleOf(
            settings.accountCreatedNoticeGlobalCap ?? { max: 1000, windowSeconds: 86_400 },
          ),
        },
      }),
    });
    const shared = {
      disabledTenantIds: settings.disabledTenantIds,
      capStore,
      sender: settings.sender,
      recipientKeySecret: secret,
      killSwitch: settings.killSwitch,
    };
    return {
      emailGate: createEmailTenantGate(shared),
      notices: createNoticeDispatcher(shared),
      recoveryMailer: createRecoveryMailer({
        ...shared,
        ...(settings.recipientDomainAllowlist !== undefined && {
          recipientDomainAllowlist: settings.recipientDomainAllowlist,
        }),
      }),
    };
  };
  // Mounted: always built. Not mounted: built only when the host configured it, for the
  // account notices of Better Auth's own password changes.
  const identityEmail =
    mountedEmail === undefined
      ? undefined
      : {
          ...(await buildEmailPath(mountedEmail.settings, mountedEmail.secret)),
          settings: mountedEmail.settings,
          resetLinkBaseUrl: mountedEmail.resetLinkBaseUrl,
        };
  if (identityEmail !== undefined) {
    accountNoticeMailer.current = identityEmail.recoveryMailer;
  } else if (email !== undefined && recipientKeySecret !== undefined) {
    accountNoticeMailer.current = (await buildEmailPath(email, recipientKeySecret)).recoveryMailer;
  }

  // D10: one router, one handler, one interceptor chain for the catalog and identity routes.
  const router = {
    ...createCatalogRouter({
      blueprints: createBlueprintService({ pool: appPool, authz }),
      entities: createEntityService({ pool: appPool, authz }),
    }),
    ...(identityEmail === undefined
      ? {}
      : createIdentityRouter({
          auth,
          authz,
          authRepository: createAuthRepository(options.authPool),
          withUserLock: createWithUserLock(options.authPool),
          appPool,
          userSync,
          emailGate: identityEmail.emailGate,
          notices: identityEmail.notices,
          ...(identityEmail.settings.invitationLinkBaseUrl === undefined
            ? {}
            : { invitationLinkBaseUrl: identityEmail.settings.invitationLinkBaseUrl }),
          recoveryMailer: identityEmail.recoveryMailer,
          mfaReset: createMfaResetService({
            authPool: options.authPool,
            notices: createMailerNoticePort({
              authRepository: createAuthRepository(options.authPool),
              recoveryMailer: identityEmail.recoveryMailer,
            }),
          }),
          ...(options.credentialCap === undefined ? {} : { credentialCap: options.credentialCap }),
          ...(options.serviceAccountCap === undefined
            ? {}
            : { serviceAccountCap: options.serviceAccountCap }),
          ...(options.orgDeletionWindowDays === undefined
            ? {}
            : { orgDeletionWindowDays: options.orgDeletionWindowDays }),
        })),
  };
  // D4: the guard runs after context resolution and before the operation, for
  // every procedure whose route spec carries `x-tayzu-risk: high`. The caller's
  // headers travel in the handler context, under a private key.
  const stepUpGuard = createStepUpGuard({
    auth,
    ...(options.sso === undefined ? {} : { sso: options.sso }),
  });
  // Q36: the SSO step-up flow. The callback's absolute URL is built on the
  // host's `BETTER_AUTH_URL` (Q64), falling back to the first allowed origin
  // only when it is unset (test); never on a request header.
  const callbackBase = options.baseUrl ?? options.allowedOrigins[0];
  const reauthorization: Reauthorization | undefined =
    options.sso === undefined || callbackBase === undefined
      ? undefined
      : createReauthorization({
          auth,
          authPool: options.authPool,
          discoveryUrl: options.sso.discoveryUrl,
          clientId: options.sso.clientId,
          clientSecret: options.sso.clientSecret,
          redirectUri: new URL(REAUTH_CALLBACK_PATH, callbackBase).toString(),
          ...(options.reauthorizationMaxPendingPerSession === undefined
            ? {}
            : { maxPendingPerSession: options.reauthorizationMaxPendingPerSession }),
        });
  const openApiHandler = new OpenAPIHandler(router, {
    clientInterceptors: [
      errorMappingInterceptor,
      async (interceptorOptions) => {
        const { context, path, procedure } = interceptorOptions;
        const route = procedure['~orpc'].route;
        const resolvedSpec = typeof route.spec === 'function' ? route.spec({}) : route.spec;
        const stepUpContext = context as unknown as StepUpHandlerContext;
        const highRisk =
          resolvedSpec !== undefined &&
          (resolvedSpec as Record<string, unknown>)['x-tayzu-risk'] === 'high';
        const headers = stepUpContext[STEP_UP_HEADERS];
        // A result recorded by the re-auth callback reaches the guard (D25, Q36).
        const returned =
          highRisk && reauthorization !== undefined ? await reauthorization.lookup(headers) : null;
        try {
          await stepUpGuard({
            headers,
            tenantId: stepUpContext.tenantId,
            actor: stepUpContext.actor,
            route: { ...(highRisk ? { riskLevel: 'high' as const } : {}) },
            operation: path.join('.'),
            ...(returned === null ? {} : { reauthorization: returned }),
          });
        } catch (error) {
          const reauthorizationUrl =
            error instanceof AuthStepUpError && reauthorization !== undefined
              ? await reauthorization.start(headers)
              : null;
          if (reauthorizationUrl === null) {
            throw error;
          }
          throw new ORPCError('AUTH_STEP_UP_REQUIRED', {
            status: 403,
            message: error instanceof Error ? error.message : 'Step-up required',
            data: { reauthorizationUrl },
          });
        }
        return interceptorOptions.next();
      },
    ],
    // D13: custom-header CSRF check (default `x-csrf-token: orpc`) on every
    // mutating route. Fail closed: only an explicit GET/HEAD route is exempt.
    plugins: [
      new ResponseHeadersPlugin(),
      new SimpleCsrfProtectionHandlerPlugin({
        exclude: ({ procedure }) => {
          const method = procedure['~orpc'].route.method;
          return method === 'GET' || method === 'HEAD';
        },
      }),
    ],
  });

  // 048 D2: only a configured proxy hop may set the client address via
  // `X-Forwarded-For`; an untrusted peer's header is never read, and at most the
  // configured number of hops is skipped. `request.ip` is the resolved address.
  const trustProxy = options.trustProxy ?? TEST_TRUST_PROXY;
  const app = Fastify({
    trustProxy: typeof trustProxy === 'function' ? trustProxy : [...trustProxy],
    ...(options.bodyLimit === undefined ? {} : { bodyLimit: options.bodyLimit }),
  });
  await options.configureApp?.(app);
  // 003 D10: one strict, self-only policy and header set on every response (HTML,
  // JSON, assets and 404s), whether or not `webDistDir` is set. Registered ahead
  // of the Q74 hook so that its 404 carries the headers too: helmet's hooks and
  // the `Permissions-Policy` hook only write response headers and never read the
  // request target. HSTS (task 11.12): one year, subdomains included.
  // Q15, task 4.5: the style nonce is drawn first, so helmet's `style-src` directive
  // function and the SPA fallback read the same value. It never reads the request.
  app.addHook('onRequest', async (_request, reply) => {
    assignStyleNonce(reply.raw);
  });
  await app.register(fastifyHelmet, SECURITY_HEADERS);
  // Helmet does not set `Permissions-Policy`; this hook runs right after helmet's own.
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('permissions-policy', PERMISSIONS_POLICY);
  });
  // Q74, D18: the first hook that reads the request. A target that is not
  // origin-form, or whose path (before the query) holds `%`, `//` or a
  // backslash, answers the allowlist's own 404 before any other hook or the
  // router can normalize it.
  app.addHook('onRequest', async (request, reply) => {
    const url: string = request.url;
    const pathname: string = url.split('?', 1)[0] ?? '';
    const originForm: boolean = url.startsWith('/') && !url.startsWith('//');
    if (!originForm || /[%\\]|\/\//.test(pathname)) {
      reply.callNotFound();
      return reply;
    }
  });
  // Q67, D11: an error that reaches Fastify unmapped answers the generic
  // `INTERNAL` body, never the thrown message. Client errors Fastify and its
  // plugins raise on purpose (4xx) keep their own status and body.
  app.setErrorHandler(async (error, _request, reply) => {
    const { statusCode } = error as { statusCode?: unknown };
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send(error);
    }
    const mapped = toOrpcError(error);
    // Q76: only a genuinely unmapped error is a security-log signal.
    if (mapped.code === 'INTERNAL') {
      emitInternalError(error);
    }
    return reply.status(mapped.status).send(mapped.toJSON());
  });
  // D13, ZAP finding [10049] (Storable and Cacheable Content): default to
  // `no-store` on every response, including Fastify's 404, unless the handler
  // (e.g. Better Auth's get-session) already set its own Cache-Control.
  app.addHook('onSend', async (_request, reply) => {
    if (!reply.hasHeader('cache-control')) {
      reply.header('cache-control', 'no-store');
    }
  });
  // Exact-match allowlist; `credentials` is required for Better Auth's cookie.
  // A disallowed origin gets no CORS headers at all, not even `credentials`.
  const allowedOrigins = new Set(options.allowedOrigins);
  await app.register(fastifyCors, {
    delegator: (request, callback) => {
      const origin = request.headers.origin;
      if (origin !== undefined && allowedOrigins.has(origin)) {
        callback(null, { origin, credentials: true });
      } else {
        callback(null, { origin: false, credentials: false });
      }
    },
  });
  // oRPC reads the raw body itself; keep Fastify from consuming other types.
  app.addContentTypeParser('*', (_request, _payload, done) => {
    done(null, undefined);
  });

  // Route-level limits only (`global: false`); registered before any route that opts in.
  await app.register(fastifyRateLimit, { global: false });

  // Q33: liveness only. Unauthenticated, no dependency check, no detail.
  app.get('/healthz', () => ({ status: 'ok' }));

  // D18: deny-by-default. An unlisted path gets Fastify's own 404, identical
  // to any unknown route, before Better Auth is reached.
  app.addHook('onRequest', async (request, reply) => {
    const pathname: string = pathnameOf(request);
    if (!pathname.startsWith('/api/auth')) {
      return;
    }
    if (!isAllowedAuthPath(pathname)) {
      // No route matched (`/api/auth` itself): the 404 handler already answers, and
      // `callNotFound` inside it would send Fastify's bare text 404 instead.
      if (request.is404) {
        return;
      }
      reply.callNotFound();
      return reply;
    }
  });

  // Q66, D13: the `*` parser above skips Fastify's body limit for non-JSON types, so a
  // body-bearing `/v1/*` request must be `application/json` or it is refused with 415
  // in `onRequest`, before any body is read.
  app.addHook('onRequest', async (request, reply) => {
    const pathname: string = pathnameOf(request);
    if (pathname !== '/v1' && !pathname.startsWith('/v1/')) {
      return;
    }
    // The IdP's form-encoded callbacks (D26, Q36) have their own scoped parsers.
    if (pathname === BACKCHANNEL_LOGOUT_PATH || pathname === REAUTH_CALLBACK_PATH) {
      return;
    }
    const { headers } = request;
    const hasBody =
      headers['transfer-encoding'] !== undefined ||
      (headers['content-length'] !== undefined && headers['content-length'] !== '0');
    if (!hasBody) {
      return;
    }
    const mediaType = (headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase();
    if (mediaType !== 'application/json') {
      return reply
        .status(415)
        .send({ code: 'UNSUPPORTED_MEDIA_TYPE', status: 415, message: 'Unsupported media type' });
    }
    return undefined;
  });

  // Q60: a client-submitted ID token would bypass the authorization-code callback
  // (state, nonce, PKCE; D23-D26), so sign-in and linking refuse any body carrying one.
  app.addHook('preHandler', async (request, reply) => {
    const pathname: string = pathnameOf(request);
    if (
      request.method !== 'POST' ||
      (pathname !== '/api/auth/sign-in/social' && pathname !== '/api/auth/link-social')
    ) {
      return;
    }
    const body: unknown = request.body;
    if (typeof body === 'object' && body !== null && Object.hasOwn(body, 'idToken')) {
      return reply.status(400).send({ code: 'BAD_REQUEST', status: 400, message: 'Bad request' });
    }
    return undefined;
  });

  // D24 path (a): `/link-social` is a Better Auth native route, so D4's
  // procedure guard does not reach it, nor `/unlink-account` (Q43); the caller
  // needs a fresh MFA verification or password re-entry (Q49) before the request
  // reaches Better Auth.
  const assertLinkStepUp = createEnrolledStepUpCheck({ auth });
  app.addHook('preHandler', async (request, reply) => {
    const pathname: string = pathnameOf(request);
    if (
      request.method !== 'POST' ||
      (pathname !== '/api/auth/link-social' && pathname !== '/api/auth/unlink-account')
    ) {
      return;
    }
    try {
      await assertLinkStepUp(toWebHeaders(request));
    } catch (error) {
      const mapped = toOrpcError(error);
      return reply.status(mapped.status).send(mapped.toJSON());
    }
    return undefined;
  });

  // Q35, D23: Visma Connect's `form_post` callback arrives as
  // `application/x-www-form-urlencoded`. Only this scope keeps that body (as the raw
  // string Better Auth re-reads); the catch-all `*` parser stays for other routes.
  await app.register((scope, _opts, done) => {
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_request, body, parsed) => {
        parsed(null, body);
      },
    );
    scope.all('/api/auth/*', async (request, reply) => {
      const response = await (auth as unknown as AuthHandlerSurface).handler(
        toWebRequest(request, options.baseUrl),
      );
      reply.status(response.status);
      for (const [name, value] of response.headers) {
        if (name !== 'set-cookie') {
          reply.header(name, value);
        }
      }
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) {
        reply.header('set-cookie', cookies);
      }
      return reply.send(Buffer.from(await response.arrayBuffer()));
    });
    done();
  });

  // D26: public back-channel logout (Visma Connect's infrastructure is the
  // caller: no cookie, no CSRF header). Encapsulated so the form parser does
  // not change how any other route sees its body. Every well-formed request
  // answers the same 200, whatever the token's validity or session match.
  /** Verifies, replay-guards and applies one logout token; the outcome is the only thing returned. */
  async function handleLogoutToken(
    token: string,
    config: NonNullable<CreateAppOptions['sso']>,
    issuer: string,
  ): Promise<BackchannelLogoutOutcome> {
    const verified = await verifyLogoutToken(token, {
      issuer,
      discoveryUrl: config.discoveryUrl,
      clientId: config.clientId,
    });
    if (verified?.jti === undefined) {
      return 'invalid';
    }
    // Replay state (D26): one `auth.verification` row per accepted token,
    // recorded atomically; a second delivery inserts nothing and revokes nothing.
    const recorded = await options.authPool.query(
      `insert into auth.verification (id, identifier, value, expires_at)
       select $1, $2, $3, to_timestamp($4)
       where not exists (select 1 from auth.verification where identifier = $2)`,
      [
        randomUUID(),
        `backchannel-logout:${config.clientId}:${verified.jti}`,
        'processed',
        verified.exp + LOGOUT_JTI_SKEW_SECONDS,
      ],
    );
    if (recorded.rowCount !== 1) {
      return 'replay';
    }
    let revoked = 0;
    if (verified.sid !== undefined) {
      revoked =
        (
          await options.authPool.query('delete from auth.session where sso_sid = $1', [
            verified.sid,
          ])
        ).rowCount ?? 0;
    } else if (verified.sub !== undefined) {
      // No `sid`: revoke only the linked user's Visma Connect sessions (D26);
      // local sessions (`sso_sid` null) are never touched.
      revoked =
        (
          await options.authPool.query(
            `delete from auth.session
           where sso_sid is not null
             and user_id in (
               select user_id from auth.account
               where provider_id = 'visma-connect' and account_id = $1
             )`,
            [verified.sub],
          )
        ).rowCount ?? 0;
    }
    return revoked > 0 ? 'revoked' : 'no_match';
  }
  const sso = options.sso;
  // Without SSO configuration the route is disabled: it answers 404.
  await app.register((scope, _opts, done) => {
    if (sso === undefined || ssoIssuer === undefined) {
      // Explicit 404, so the `/v1/*` catch-all never answers for it.
      scope.post(BACKCHANNEL_LOGOUT_PATH, (_request, reply) =>
        reply.status(404).send({ defined: false, code: 'NOT_FOUND', status: 404 }),
      );
      done();
      return;
    }
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_request, body, parsed) => {
        const fields: Record<string, string> = Object.create(null) as Record<string, string>;
        for (const [name, value] of new URLSearchParams(body as string)) {
          if (name === 'logout_token') {
            fields[name] = value;
          }
        }
        parsed(null, fields);
      },
    );
    scope.post(
      BACKCHANNEL_LOGOUT_PATH,
      {
        config: {
          // Floor against abuse, keyed by source IP only: the caller is Visma
          // Connect's infrastructure, not a Tayzu principal (D26).
          rateLimit: {
            max:
              options.backchannelLogoutRateLimitPerMinute ??
              DEFAULT_BACKCHANNEL_LOGOUT_MAX_PER_MINUTE,
            timeWindow: 60_000,
            keyGenerator: (request: FastifyRequest): string => `backchannel-logout:${request.ip}`,
          },
        },
      },
      async (request, reply) => {
        const token = (request.body as Record<string, string> | undefined)?.['logout_token'];
        const malformed = typeof token !== 'string' || token === '';
        await withBackchannelLogoutTelemetry(async () => {
          if (malformed) {
            return 'invalid';
          }
          return handleLogoutToken(token, sso, ssoIssuer);
        });
        if (malformed) {
          return reply.status(400).send({ defined: false, code: 'BAD_REQUEST', status: 400 });
        }
        return reply.status(200).send({});
      },
    );
    done();
  });

  // Q36: the re-authorization callback (query redirect or `form_post`). The
  // single-use `state` binds it to the session; it answers a bare 200 or 400, or, with
  // the web app served (003 D11), a `303` to one of the fixed step-up locations.
  // 043 task 13.9: the callback's own limiter runs before the single-use `delete`.
  const redirectToWebApp = options.webDistDir !== undefined;
  const seeOther = (reply: FastifyReply, location: string): FastifyReply =>
    reply.status(303).header('location', location).send();
  const reauthorizationCallbackLimit = createAcceptRateLimitPreHandler({
    ...(redirectToWebApp && {
      onLimited: (reply: FastifyReply) => seeOther(reply, STEP_UP_RATE_LIMITED_LOCATION),
    }),
    scope: 'reauthorization_callback',
    store: createRateLimitBucketStore({
      adapter: ((await auth.$context) as { adapter: RateLimitBucketStoreOptions['adapter'] })
        .adapter,
      rules: {
        reauthorization_callback:
          options.reauthorizationCallbackRateLimit ?? DEFAULT_REAUTHORIZATION_CALLBACK_RATE_LIMIT,
      },
    }),
  });
  const callbackRoute = { preHandler: reauthorizationCallbackLimit };
  await app.register((scope, _opts, done) => {
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_request, body, parsed) => {
        const fields: Record<string, string> = Object.create(null) as Record<string, string>;
        for (const [name, value] of new URLSearchParams(body as string)) {
          if (name === 'code' || name === 'state') {
            fields[name] = value;
          }
        }
        parsed(null, fields);
      },
    );
    const handle = async (
      params: { code?: unknown; state?: unknown },
      reply: FastifyReply,
    ): Promise<unknown> => {
      const ok = reauthorization !== undefined && (await reauthorization.complete(params));
      if (redirectToWebApp) {
        return seeOther(reply, ok ? STEP_UP_COMPLETE_LOCATION : STEP_UP_FAILED_LOCATION);
      }
      return ok
        ? reply.status(200).send({})
        : reply.status(400).send({ defined: false, code: 'BAD_REQUEST', status: 400 });
    };
    scope.get(REAUTH_CALLBACK_PATH, callbackRoute, (request, reply) => {
      const query = request.query as Record<string, unknown>;
      return handle({ code: query['code'], state: query['state'] }, reply);
    });
    scope.post(REAUTH_CALLBACK_PATH, callbackRoute, (request, reply) => {
      const body = request.body as Record<string, unknown> | undefined;
      return handle({ code: body?.['code'], state: body?.['state'] }, reply);
    });
    done();
  });

  // Resolved once per request: the rate-limit key generator and the handler share it.
  const resolveOnce = oncePerRequest(resolveContext);

  const limited = new ORPCError('AUTH_RATE_LIMITED', {
    status: 429,
    message: 'Too many requests',
  });

  // D20: token exchange has no tenant/actor yet, so it gets its own bucket
  // (IP only, so varying `clientId` cannot mint a fresh bucket; Q56) and is exempt from the authenticated one below.
  if (options.tokenExchangeRateLimit !== undefined) {
    const check = app.createRateLimit({
      max: options.tokenExchangeRateLimit.max,
      timeWindow: options.tokenExchangeRateLimit.timeWindowMs,
      // Internal bucket key only: never logged or returned.
      keyGenerator: (request: FastifyRequest): string => `token:${request.ip}`,
    });
    app.addHook('preHandler', async (request, reply) => {
      if (!isTokenExchange(request)) {
        return;
      }
      const result = await check(request);
      if (!result.isAllowed && result.isExceeded) {
        emitRateLimited('token_exchange');
        return reply.status(429).header('retry-after', result.ttlInSeconds).send(limited.toJSON());
      }
      return undefined;
    });
  }

  // D5: machine credentials exchange a client id and secret for an access
  // token. No session: the credential is the authentication. Registered before
  // the `/v1/*` catch-all, so it never reaches the per-principal limiter.
  app.post(TOKEN_EXCHANGE_PATH, async (request, reply) => {
    const body = request.body as { clientId?: unknown; clientSecret?: unknown } | null | undefined;
    if (typeof body?.clientId !== 'string' || typeof body.clientSecret !== 'string') {
      return reply.status(400).send({ defined: false, code: 'BAD_REQUEST', status: 400 });
    }
    try {
      const { accessToken } = await exchangeMachineToken(
        auth,
        { clientId: body.clientId, clientSecret: body.clientSecret },
        { serviceAccountLookup, tenantDeletionLookup },
      );
      return await reply.status(200).send({ accessToken });
    } catch (error) {
      const mapped = toOrpcError(error);
      return reply.status(mapped.status).send(mapped.toJSON());
    }
  });

  if (identityEmail !== undefined) {
    const { notices, recoveryMailer, settings: emailSettings } = identityEmail;
    // 043 task 14.1b: the invitation acceptance is a plain public route (no session,
    // no catch-all), behind its own DB-backed limiter.
    const acceptFlow = createAcceptFlow({
      auth,
      authz,
      authRepository: createAuthRepository(options.authPool),
      authPool: options.authPool,
      userSync,
      ssoLinkShed,
      notices,
      stepUp: stepUpGuard,
      tenantDeletionLookup,
      ...(reauthorization === undefined ? {} : { reauthorization }),
    });
    app.post(
      INVITATION_ACCEPT_PATH,
      {
        preHandler: createAcceptRateLimitPreHandler({
          store: createRateLimitBucketStore({
            adapter: ((await auth.$context) as { adapter: RateLimitBucketStoreOptions['adapter'] })
              .adapter,
            rules: {
              invitation_accept:
                options.invitationAcceptRateLimit ?? DEFAULT_INVITATION_ACCEPT_RATE_LIMIT,
            },
          }),
        }),
      },
      async (request, reply) => {
        try {
          // Q24, Q38: the session is read only for a request that carries the CSRF
          // header and an allowed `Origin`; otherwise the flow sees no session, and an
          // existing account gets the uniform rejection (a new person needs no session).
          const csrfPresent = request.headers['x-csrf-token'] === 'orpc';
          const originAllowed =
            request.headers.origin !== undefined && allowedOrigins.has(request.headers.origin);
          const crossSiteSafe = csrfPresent && originAllowed;
          // Only a request that carries a cookie had a session to refuse (design D4 step 5).
          const crossSiteDenial =
            crossSiteSafe || request.headers.cookie === undefined
              ? undefined
              : csrfPresent
                ? 'origin_rejected'
                : 'csrf_rejected';
          const { userId } = await acceptFlow.acceptRequest({
            body: request.body,
            ...(crossSiteSafe && { headers: toWebHeaders(request) }),
            ...(crossSiteDenial !== undefined && { crossSiteDenial }),
          });
          return await reply.status(200).send({ userId });
        } catch (error) {
          const mapped = toOrpcError(error);
          return reply.status(mapped.status).send(mapped.toJSON());
        }
      },
    );

    // 044 task 6.1 (D2): the reset request is a plain public route. It answers the uniform
    // 200 whatever the account; only a malformed body answers otherwise.
    const resetMinResponseMs = emailSettings.passwordResetMinResponseMs ?? 400;
    const resetRequest = createPasswordResetRequestFlow({
      eligibility: createRecoveryEligibility({ authPool: options.authPool, userSync }),
      mailer: recoveryMailer,
      tokens: createResetTokenStore({
        authPool: options.authPool,
        withUserLock: createWithUserLock(options.authPool),
      }),
      linkBaseUrl: identityEmail.resetLinkBaseUrl,
    });
    // Fastify's own JSON parser answers a `__proto__` key with its own error code; this scope
    // keeps the body as plain data so the strict parser refuses it as CATALOG_VALIDATION_FAILED.
    // D2, D16: the per-IP limiter runs before the handler, on the DB-backed store.
    const resetRequestLimit = createAcceptRateLimitPreHandler({
      scope: 'password_reset_request',
      store: createRateLimitBucketStore({
        adapter: ((await auth.$context) as { adapter: RateLimitBucketStoreOptions['adapter'] })
          .adapter,
        rules: {
          password_reset_request: ruleOf(
            emailSettings.passwordResetRequestRateLimit ?? { max: 10, windowSeconds: 60 },
          ),
        },
      }),
    });
    // 044 task 8.3 (D2): the confirm route has its own scope and budget (default 10 per minute).
    const resetConfirm = createPasswordResetConfirmFlow({
      authPool: options.authPool,
      eligibility: createRecoveryEligibility({ authPool: options.authPool, userSync }),
      tokens: createResetTokenStore({
        authPool: options.authPool,
        withUserLock: createWithUserLock(options.authPool),
      }),
      withUserLock: createWithUserLock(options.authPool),
      mailer: recoveryMailer,
      secretConfig: ((await auth.$context) as { secretConfig: ResetFactorInput['secretConfig'] })
        .secretConfig,
    });
    const resetConfirmLimit = createAcceptRateLimitPreHandler({
      scope: 'password_reset_confirm',
      store: createRateLimitBucketStore({
        adapter: ((await auth.$context) as { adapter: RateLimitBucketStoreOptions['adapter'] })
          .adapter,
        rules: {
          password_reset_confirm: ruleOf(
            emailSettings.passwordResetConfirmRateLimit ?? { max: 10, windowSeconds: 60 },
          ),
        },
      }),
    });
    await app.register((scope, _opts, done) => {
      // Set before the limiter and the handler run, so every answer carries it, refusals included.
      scope.addHook('onRequest', (_request, reply, hookDone) => {
        applyNoCacheHeaders(reply);
        hookDone();
      });
      scope.addContentTypeParser(
        'application/json',
        { parseAs: 'string' },
        (_request, body, parsed) => {
          try {
            parsed(null, JSON.parse(body as string));
          } catch {
            parsed(null, undefined);
          }
        },
      );
      scope.post(
        PASSWORD_RESET_REQUEST_PATH,
        { preHandler: resetRequestLimit },
        async (request, reply) => {
          const startedAt = performance.now();
          try {
            // D2: both are required, checked before the strict parse and any lookup. The answer
            // depends only on the request's own headers (Q24), so it is a 400, not the uniform 200.
            await withIdentitySpan('identity.password_reset.request', {}, async () => {
              if (
                request.headers['x-csrf-token'] !== 'orpc' ||
                request.headers.origin === undefined ||
                !allowedOrigins.has(request.headers.origin)
              ) {
                throw new IdentityInputError();
              }
              await resetRequest.handle({ body: request.body, clientIp: request.ip });
            });
            // D4 padding: wait out the rest of the minimum duration (a timer, no busy-wait).
            const remaining = resetMinResponseMs - (performance.now() - startedAt);
            if (remaining > 0) {
              await new Promise<void>((resolve) => setTimeout(resolve, remaining));
            }
            return await reply.status(200).send({ accepted: true });
          } catch (error) {
            const mapped = toOrpcError(error);
            return reply.status(mapped.status).send(mapped.toJSON());
          }
        },
      );
      scope.post(
        PASSWORD_RESET_CONFIRM_PATH,
        { preHandler: resetConfirmLimit },
        async (request, reply) => {
          try {
            // D2: after the limiter and before any lookup; the refusal is the uniform one.
            const crossSiteDenial =
              request.headers['x-csrf-token'] !== 'orpc'
                ? 'csrf_rejected'
                : request.headers.origin === undefined ||
                    !allowedOrigins.has(request.headers.origin)
                  ? 'origin_rejected'
                  : undefined;
            await resetConfirm.handle({
              body: request.body,
              ...(crossSiteDenial !== undefined && { crossSiteDenial }),
            });
            return await reply.status(200).send({ completed: true });
          } catch (error) {
            const mapped = toOrpcError(error);
            return reply.status(mapped.status).send(mapped.toJSON());
          }
        },
      );
      done();
    });
    app.addHook('onClose', async () => {
      await recoveryMailer.drain();
    });
  }

  // D13: the authenticated per-principal budget. `principalKeyOf` resolves the request's
  // principal; a request without one shares its IP's `unauthenticated` bucket.
  const authenticatedRateLimit = (
    principalKeyOf: (request: FastifyRequest) => Promise<string | undefined>,
  ): { rateLimit?: object } =>
    options.rateLimit === undefined
      ? {}
      : {
          rateLimit: {
            max: options.rateLimit.max,
            timeWindow: options.rateLimit.timeWindowMs,
            allowList: isTokenExchange,
            // Internal bucket key only: never logged, returned or exported.
            keyGenerator: async (request: FastifyRequest): Promise<string> =>
              (await principalKeyOf(request)) ?? `unauthenticated:${request.ip}`,
            errorResponseBuilder: () => ({ ...limited.toJSON(), statusCode: 429 }),
          },
        };

  // 003 D8 (Q13, Q54): the shell's view of its own session, read from the session only.
  // The span covers the resolution; its gate is `unauthenticated` unless a state resolves.
  const resolveSessionState = createSessionStateResolver({ auth, revocationPool: appPool });
  const resolveSessionStateOnce = oncePerRequest((headers) =>
    withIdentitySpan('identity.session.me', { [SESSION_GATE]: 'unauthenticated' }, async (span) => {
      const state = await resolveSessionState(headers);
      span.setAttributes({ [SESSION_GATE]: state.gate, 'tayzu.tenant.id': state.organization.id });
      return state;
    }),
  );
  // Registered before the `/v1/*` catch-all, as token exchange is. Same bucket key shape as
  // the catch-all's session principal, so the budget follows the person, gated or not.
  app.get(
    ME_PATH,
    {
      config: authenticatedRateLimit(async (request) => {
        const resolved = await resolveSessionStateOnce(request);
        return 'error' in resolved
          ? undefined
          : `${resolved.value.organization.id}:user:${resolved.value.user.id}`;
      }),
    },
    async (request, reply) => {
      const resolved = await resolveSessionStateOnce(request);
      if ('error' in resolved) {
        // The catch-all's own mapping, so the `401` body is the anonymous one.
        const mapped = toOrpcError(resolved.error);
        return reply.status(mapped.status).send(mapped.toJSON());
      }
      return reply.status(200).header('cache-control', 'no-store').send(resolved.value);
    },
  );

  // The methods the merged router routes (Q141); `HEAD` is derived from `GET`.
  app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    url: '/v1/*',
    config: authenticatedRateLimit(async (request) => {
      const resolved = await resolveOnce(request);
      if ('error' in resolved) {
        return undefined;
      }
      const { tenantId, actor } = resolved.value;
      return `${tenantId}:${actor.type}:${actor.id}`;
    }),
    handler: async (request, reply) => {
      const resolved = await resolveOnce(request);
      if ('error' in resolved) {
        // Same mapping and body shape as any other error, via oRPC's own JSON.
        const mapped = toOrpcError(resolved.error);
        return reply.status(mapped.status).send(mapped.toJSON());
      }
      const context = resolved.value;
      // Q43, D4: an `admin`/`owner` user without an enrolled factor may only reach
      // MFA enrollment (the `/api/auth/two-factor/*` routes, outside `/v1`). Machine
      // principals are always `member` (Q28), so only a user can carry `admin` here.
      if (context.principal?.roles.includes('admin') === true) {
        const session = await (auth.api as AuthSessionSurface).getSession({
          headers: toWebHeaders(request),
        });
        if (session?.user?.twoFactorEnabled !== true) {
          const mapped = toOrpcError(new AuthStepUpError());
          return reply.status(mapped.status).send(mapped.toJSON());
        }
      }
      const result = await openApiHandler.handle(request, reply, {
        context: {
          ...context,
          [STEP_UP_HEADERS]: toWebHeaders(request),
          // Q42: the session headers `invite` and `cancelInvitation` forward to Better Auth.
          [REQUEST_HEADERS]: toWebHeaders(request),
        },
      });
      if (!result.matched) {
        return reply.status(404).send({ defined: false, code: 'NOT_FOUND', status: 404 });
      }
      return undefined;
    },
  });

  // 003 D9: the web build's assets and root build files, only when a build is configured.
  // Their own `Cache-Control` is set before `onSend`, so the `no-store` default leaves it.
  // The SPA fallback (Q28): the router prefers every more specific route over `/*`.
  if (options.webDistDir !== undefined) {
    await registerWebStatic(app, options.webDistDir);
    await registerSpaFallback(app, options.webDistDir, {
      rateLimit: options.spaFallbackRateLimit ?? DEFAULT_SPA_FALLBACK_RATE_LIMIT,
      rateLimitedBody: () => ({ ...limited.toJSON(), statusCode: 429 }),
    });
  }

  await app.ready();

  return {
    app,
    auth,
    async close(): Promise<void> {
      await app.close();
    },
  };
}
