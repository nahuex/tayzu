/**
 * Pre-authentication rate limiting (task 2.5, design D20;
 * `specs/auth-and-rbac/spec.md`, "Pre-authentication rate limiting protects
 * against credential stuffing").
 *
 * Better Auth 1.7.6's own built-in `rateLimit` (`ctx.rateLimit`,
 * `onRequestRateLimit`, `dist/api/rate-limiter/index.mjs`) can only ever key
 * a bucket by `` `${ip}|${path}` `` -- it has no email dimension -- and its
 * blocked response is returned directly from the router's `onRequest` stage
 * as a generic `{ message }` body with an `X-Retry-After` header (verified
 * against the installed source), which never reaches any downstream
 * response-shaping hook (`better-call@1.4.0`'s `dist/router.mjs`: `if (onReq
 * instanceof Response) return onReq;`). Neither dimension the design asks for
 * (email keying, the `AUTH_RATE_LIMITED`/`Retry-After` shape) is reachable
 * through that built-in mechanism, so this module implements D20's intent as
 * a small Better Auth plugin instead (orchestrator decision, task 2.5): a
 * `BetterAuthPlugin.onRequest` hook, which runs at the same `onRequest`
 * router stage the built-in limiter itself runs at -- before route
 * validation -- for every path this module's rule table names.
 *
 * `./auth.ts` disables the built-in limiter outright (`rateLimit: { enabled:
 * false, storage: "database" }`) so it can never race this plugin for the
 * same request, while still configuring `storage: "database"` so Better
 * Auth's own schema derivation (`getAuthTables`) registers the `rateLimit`
 * model this module's buckets live in (`../persistence/schema.ts`) --
 * accessed here exclusively through the Better Auth adapter (`ctx.adapter`),
 * never a second database pool, per the design's "reuse Better Auth's own
 * rateLimit model shape" instruction.
 *
 * Two buckets are consumed per matched request: one keyed by the caller's IP
 * address (Better Auth's own `getIP`, honoring `advanced.ipAddress.
 * ipAddressHeaders`; a fixed fallback key when no trustworthy IP can be
 * resolved, so an untraceable caller fails closed into one shared bucket
 * rather than bypassing the limit entirely), one keyed by the submitted
 * email, normalized (trimmed, lowercased) from a *clone* of the request body
 * so the original request stream still reaches Better Auth's own route
 * handler untouched. Both bucket keys are hashed (SHA-256 of
 * `scope:kind:value`) before they ever reach a SQL parameter, so neither an
 * IP address nor an email is ever persisted in clear (design D20's own
 * "neither the caller's IP address nor their email appears on either
 * signal" extends to storage, not only to telemetry). A request is blocked
 * when *either* bucket has exhausted its limit -- an attacker cannot bypass
 * the IP bucket by rotating emails, nor the email bucket by rotating IPs.
 *
 * The rule table below only wires `/sign-in/email` (task 2.5's own scope);
 * `/two-factor/verify` and any sign-up/email-verification route are later
 * tasks' concern and extend `PRE_AUTH_RATE_LIMIT_RULES` and
 * `PreAuthRateLimitOptions` the same way, not a new mechanism.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { getIP } from 'better-auth/api';
import type { BetterAuthPlugin, DBAdapter } from 'better-auth/types';

import { SeverityNumber } from '@opentelemetry/api-logs';

import { logger, rateLimitEventsCounter } from '../telemetry/instruments.js';

/** design.md, Metrics/Log events tables: `tayzu.auth.rate_limit.scope`'s closed enum (design D20). */
export type RateLimitScope = 'sign_in' | 'two_factor_verify' | 'token_exchange';

/** design.md, Log events table: `auth.security.rate_limited`'s only attribute (design D20). */
const RATE_LIMIT_SCOPE_ATTRIBUTE = 'tayzu.auth.rate_limit.scope';

/** A test-writer/orchestrator design choice (task 2.5): the design leaves the exact limit to configuration. */
export interface RateLimitRuleOptions {
  /** The rolling window, in seconds. */
  readonly window: number;
  /** The maximum number of attempts allowed within the window. */
  readonly max: number;
}

/**
 * `CreateAuthOptions.rateLimit` (task 2.5). Only `signIn` is wired this task;
 * later tasks (`/two-factor/verify`, sign-up/email-verification) extend this
 * interface, not replace it.
 */
export interface PreAuthRateLimitOptions {
  readonly signIn?: RateLimitRuleOptions;
  /** One bucket family shared by every `/two-factor/verify-*` route (task 11.18). */
  readonly twoFactorVerify?: RateLimitRuleOptions;
  /** One bucket family shared by every email-verification route (task 11.18); scope `sign_in`-style keys, see rule table. */
  readonly emailVerification?: RateLimitRuleOptions;
  /**
   * One bucket family shared by every allowlisted route that checks the
   * current password (task 24.2, design Q52): per IP and per authenticated
   * user id, resolved from the session cookie.
   */
  readonly passwordCheck?: RateLimitRuleOptions;
  /**
   * Second bucket for the `/two-factor/verify-*` routes, per session user id
   * (task 28.1, design Q80): applies only when the request carries a valid
   * session cookie, on top of the per-IP `twoFactorVerify` bucket.
   */
  readonly twoFactorVerifyUser?: RateLimitRuleOptions;
}

/** The narrow shape this module needs from `CreateAuthOptions` (avoids importing `../auth.ts`, which imports this module). */
export interface PreAuthRateLimitHostOptions {
  readonly rateLimit?: PreAuthRateLimitOptions;
}

interface PreAuthRateLimitRule {
  /** The path, normalized the same way Better Auth's own router normalizes it (relative to `ctx.baseURL`). */
  readonly path: string;
  readonly scope: RateLimitScope;
  /** `false` for routes whose request carries no email: only the IP bucket applies (an empty-email bucket would be shared by every caller). */
  readonly keyedByEmail: boolean;
  /** `true` for routes that carry no email but an authenticated session: a second bucket keyed by the session's user id (task 24.2). */
  readonly keyedByUser?: boolean;
  /** Key namespace of the user bucket, never shared between rule families. */
  readonly userNamespace?: string;
  /** Limit of the user bucket; defaults to `ruleOptions`. */
  readonly userRuleOptions?: (
    options: PreAuthRateLimitHostOptions,
  ) => RateLimitRuleOptions | undefined;
  readonly ruleOptions: (options: PreAuthRateLimitHostOptions) => RateLimitRuleOptions | undefined;
}

/** Allowlisted routes that check the current password (design Q52, task 24.2). */
const PASSWORD_CHECK_PATHS: readonly string[] = [
  '/verify-password',
  '/change-password',
  '/two-factor/enable',
  '/two-factor/generate-backup-codes',
  '/link-social',
];

/**
 * Extensible by design (task 2.5's own text): a later task adds one more
 * entry here (for example `{ path: '/two-factor/verify', scope:
 * 'two_factor_verify', ruleOptions: (options) => options.rateLimit?.
 * twoFactorVerify }`), never a second mechanism.
 */
const PRE_AUTH_RATE_LIMIT_RULES: readonly PreAuthRateLimitRule[] = [
  {
    path: '/sign-in/email',
    scope: 'sign_in',
    keyedByEmail: true,
    ruleOptions: (options) => options.rateLimit?.signIn,
  },
  {
    path: '/two-factor/verify-totp',
    scope: 'two_factor_verify',
    keyedByEmail: false,
    keyedByUser: true,
    userNamespace: 'two_factor_verify_user',
    userRuleOptions: (options) => options.rateLimit?.twoFactorVerifyUser,
    ruleOptions: (options) => options.rateLimit?.twoFactorVerify,
  },
  {
    path: '/two-factor/verify-backup-code',
    scope: 'two_factor_verify',
    keyedByEmail: false,
    keyedByUser: true,
    userNamespace: 'two_factor_verify_user',
    userRuleOptions: (options) => options.rateLimit?.twoFactorVerifyUser,
    ruleOptions: (options) => options.rateLimit?.twoFactorVerify,
  },
  {
    path: '/two-factor/verify-otp',
    scope: 'two_factor_verify',
    keyedByEmail: false,
    keyedByUser: true,
    userNamespace: 'two_factor_verify_user',
    userRuleOptions: (options) => options.rateLimit?.twoFactorVerifyUser,
    ruleOptions: (options) => options.rateLimit?.twoFactorVerify,
  },
  ...PASSWORD_CHECK_PATHS.map((path): PreAuthRateLimitRule => ({
    path,
    scope: 'sign_in',
    keyedByEmail: false,
    keyedByUser: true,
    userNamespace: 'password_check',
    ruleOptions: (options) => options.rateLimit?.passwordCheck,
  })),
  {
    path: '/send-verification-email',
    scope: 'sign_in',
    keyedByEmail: true,
    ruleOptions: (options) => options.rateLimit?.emailVerification,
  },
  {
    path: '/verify-email',
    scope: 'sign_in',
    keyedByEmail: false,
    ruleOptions: (options) => options.rateLimit?.emailVerification,
  },
];

/** Used only when no trustworthy client IP can be resolved (design D20: fail closed, not unlimited). */
const FALLBACK_IP_KEY = 'no-trusted-ip';

const RATE_LIMIT_MODEL = 'rateLimit';

/** Mirrors `../persistence/schema.ts`'s `rateLimit` table (`id`, `key`, `count`, `last_request`). */
interface RateLimitBucketRow {
  readonly key: string;
  readonly count: number;
  readonly lastRequest: Date;
}

interface ConsumeResult {
  readonly allowed: boolean;
  /** Seconds until the bucket frees up; only meaningful when `allowed` is `false`. */
  readonly retryAfterSeconds: number | null;
}

/** SHA-256 of `scope:kind:value`, hex-encoded: no IP address or email is ever persisted in clear (design D20). */
function hashBucketKey(
  scope: RateLimitScope,
  kind: 'ip' | 'email' | 'user',
  value: string,
): string {
  return createHash('sha256').update(`${scope}:${kind}:${value}`).digest('hex');
}

/** Mirrors Better Auth's own `normalizePathname` (`@better-auth/core/utils/url`), relative to the per-request `ctx.baseURL`. */
function requestPath(request: Request, baseURL: string): string {
  const basePath = new URL(baseURL).pathname.replace(/\/+$/, '');
  const pathname = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
  if (basePath === '') {
    return pathname;
  }
  if (pathname === basePath) {
    return '/';
  }
  if (pathname.startsWith(`${basePath}/`)) {
    return pathname.slice(basePath.length) || '/';
  }
  return pathname;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Reads and normalizes (trim, lowercase) the `email` field from a *clone* of
 * `request`'s body, so the original body stream is left untouched for
 * Better Auth's own route handler to read afterward. Malformed JSON or a
 * missing/non-string `email` field normalize to the empty string, which
 * still buckets every such request together rather than skipping the check.
 */
async function readNormalizedEmail(request: Request): Promise<string> {
  try {
    const body: unknown = await request.clone().json();
    if (isRecord(body) && Object.hasOwn(body, 'email') && typeof body.email === 'string') {
      return body.email.trim().toLowerCase();
    }
  } catch {
    // Malformed JSON: falls through to the empty-email bucket below.
  }
  return '';
}

/**
 * Resolves the authenticated user id from the signed session cookie, or
 * `null` (no cookie, bad signature, unknown or expired session). The HMAC is
 * verified before any lookup so a forged cookie can never name another
 * user's bucket. Better Auth's signed-cookie format: `value.base64(HMAC-SHA256)`,
 * URL-encoded.
 */
async function resolveSessionUserId(
  request: Request,
  ctx: Parameters<NonNullable<BetterAuthPlugin['onRequest']>>[1],
): Promise<string | null> {
  const cookieName = ctx.authCookies.sessionToken.name;
  const header = request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1 || part.slice(0, separator).trim() !== cookieName) {
      continue;
    }
    let signed: string;
    try {
      signed = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
    const dot = signed.lastIndexOf('.');
    if (dot < 1) {
      return null;
    }
    const token = signed.slice(0, dot);
    const expected = createHmac('sha256', ctx.secret).update(token).digest('base64');
    const provided = Buffer.from(signed.slice(dot + 1));
    const wanted = Buffer.from(expected);
    if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) {
      return null;
    }
    const found = await ctx.internalAdapter.findSession(token);
    return found?.session.userId ?? null;
  }
  return null;
}

/**
 * Atomically records one request against `key` within `rule.window` and
 * reports whether it is allowed, using `adapter`'s race-safe `incrementOne`
 * primitive (the same one Better Auth's own database-backed rate-limit
 * storage would use) so concurrent requests across every ACA replica cannot
 * all pass a stale read before any increment lands (design D20, "storage
 * shared across every running replica").
 */
async function consumeRateLimitBucket(
  adapter: DBAdapter,
  key: string,
  rule: RateLimitRuleOptions,
): Promise<ConsumeResult> {
  const now = Date.now();
  const windowMs = rule.window * 1000;

  if (await tryCreateBucket(adapter, key, now)) {
    return { allowed: true, retryAfterSeconds: null };
  }

  const row = await adapter.findOne<RateLimitBucketRow>({
    model: RATE_LIMIT_MODEL,
    where: [{ field: 'key', value: key }],
  });
  if (row === null) {
    // The row disappeared between the failed create and this read (for
    // example, pruned concurrently): fail closed rather than treat the
    // bucket as unlimited.
    return { allowed: false, retryAfterSeconds: rule.window };
  }

  if (now - row.lastRequest.getTime() >= windowMs) {
    const reset = await adapter.incrementOne<RateLimitBucketRow>({
      model: RATE_LIMIT_MODEL,
      where: [
        { field: 'key', value: key },
        { field: 'lastRequest', operator: 'lte', value: row.lastRequest },
      ],
      increment: {},
      set: { count: 1, lastRequest: new Date(now) },
    });
    if (reset !== null) {
      return { allowed: true, retryAfterSeconds: null };
    }
  } else {
    const incremented = await adapter.incrementOne<RateLimitBucketRow>({
      model: RATE_LIMIT_MODEL,
      where: [
        { field: 'key', value: key },
        { field: 'lastRequest', operator: 'gt', value: new Date(now - windowMs) },
        { field: 'count', operator: 'lt', value: rule.max },
      ],
      increment: { count: 1 },
      set: { lastRequest: new Date(now) },
    });
    if (incremented !== null) {
      return { allowed: true, retryAfterSeconds: null };
    }
  }

  const blocking = await adapter.findOne<RateLimitBucketRow>({
    model: RATE_LIMIT_MODEL,
    where: [{ field: 'key', value: key }],
  });
  const lastRequestMs = blocking?.lastRequest.getTime() ?? now;
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((lastRequestMs + windowMs - now) / 1000)),
  };
}

/** `true` when a fresh bucket row was created for `key` (first request in the window); `false` if one already existed or the create raced and lost. */
async function tryCreateBucket(adapter: DBAdapter, key: string, now: number): Promise<boolean> {
  const existing = await adapter.findOne<RateLimitBucketRow>({
    model: RATE_LIMIT_MODEL,
    where: [{ field: 'key', value: key }],
  });
  if (existing !== null) {
    return false;
  }
  try {
    await adapter.create<{ key: string; count: number; lastRequest: Date }>({
      model: RATE_LIMIT_MODEL,
      data: { key, count: 1, lastRequest: new Date(now) },
    });
    return true;
  } catch {
    // Lost the create race to a concurrent request for the same key.
    return false;
  }
}

function rateLimitedResponse(retryAfterSeconds: number): Response {
  return new Response(
    JSON.stringify({
      code: 'AUTH_RATE_LIMITED',
      message: 'Too many attempts. Try again later.',
    }),
    {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': String(retryAfterSeconds),
      },
    },
  );
}

/** design.md, Log events table `auth.security.rate_limited` / Metrics table `tayzu.auth.rate_limit.events` (design D20): no IP or email attribute, ever. */
export function emitRateLimited(scope: RateLimitScope): void {
  logger.emit({
    eventName: 'auth.security.rate_limited',
    severityNumber: SeverityNumber.WARN,
    attributes: { [RATE_LIMIT_SCOPE_ATTRIBUTE]: scope },
  });
  rateLimitEventsCounter.add(1, { [RATE_LIMIT_SCOPE_ATTRIBUTE]: scope });
}

/**
 * Builds the `onRequest` plugin task 2.5 registers in `./auth.ts`'s
 * `plugins` array. A no-op (returns `undefined`, letting Better Auth's own
 * routing continue) for any path not in `PRE_AUTH_RATE_LIMIT_RULES`, or for
 * a matched path whose rule has no configured limit (`options.rateLimit` not
 * supplied by the host).
 */
export function preAuthRateLimitPlugin(options: PreAuthRateLimitHostOptions): BetterAuthPlugin {
  return {
    id: 'tayzu-pre-auth-rate-limit',
    onRequest: async (request, ctx) => {
      const path = requestPath(request, ctx.baseURL);
      const rule = PRE_AUTH_RATE_LIMIT_RULES.find((candidate) => candidate.path === path);
      if (rule === undefined) {
        return;
      }
      const ruleOptions = rule.ruleOptions(options);
      if (ruleOptions === undefined) {
        return;
      }

      const ip = getIP(request, ctx.options) ?? FALLBACK_IP_KEY;
      const ipKey = hashBucketKey(rule.scope, 'ip', ip);
      // Email-verification and password-check routes get their own key namespace so they never share a bucket with sign-in.
      const namespace =
        rule.path === '/send-verification-email' || rule.path === '/verify-email'
          ? 'email_verification'
          : PASSWORD_CHECK_PATHS.includes(rule.path)
            ? 'password_check'
            : rule.scope;
      const [ipResult, emailResult] = await Promise.all([
        consumeRateLimitBucket(
          ctx.adapter,
          namespace === rule.scope ? ipKey : hashBucketKey(rule.scope, 'ip', `${namespace}:${ip}`),
          ruleOptions,
        ),
        rule.keyedByEmail
          ? readNormalizedEmail(request).then((email) =>
              consumeRateLimitBucket(
                ctx.adapter,
                hashBucketKey(
                  rule.scope,
                  'email',
                  namespace === rule.scope ? email : `${namespace}:${email}`,
                ),
                ruleOptions,
              ),
            )
          : Promise.resolve<ConsumeResult>({ allowed: true, retryAfterSeconds: null }),
      ]);
      // An unauthenticated caller has no user bucket: the IP bucket above still applies.
      const userOptions =
        rule.keyedByUser === true ? (rule.userRuleOptions ?? rule.ruleOptions)(options) : undefined;
      const userId = userOptions === undefined ? null : await resolveSessionUserId(request, ctx);
      const userResult =
        userId === null || userOptions === undefined
          ? ({ allowed: true, retryAfterSeconds: null } satisfies ConsumeResult)
          : await consumeRateLimitBucket(
              ctx.adapter,
              hashBucketKey(rule.scope, 'user', `${rule.userNamespace ?? namespace}:${userId}`),
              userOptions,
            );

      if (ipResult.allowed && emailResult.allowed && userResult.allowed) {
        return;
      }

      const retryAfterSeconds = Math.max(
        ipResult.retryAfterSeconds ?? 0,
        emailResult.retryAfterSeconds ?? 0,
        userResult.retryAfterSeconds ?? 0,
        1,
      );
      emitRateLimited(rule.scope);
      return { response: rateLimitedResponse(retryAfterSeconds) };
    },
  };
}
