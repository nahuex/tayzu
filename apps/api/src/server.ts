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
import { createHash, randomUUID } from 'node:crypto';

import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import { OpenAPIHandler } from '@orpc/openapi/fastify';
import { ORPCError } from '@orpc/server';
import { SimpleCsrfProtectionHandlerPlugin } from '@orpc/server/plugins';
import {
  authSchema,
  createAuth,
  createContextResolver,
  createEnrolledStepUpCheck,
  createStepUpGuard,
  emitRateLimited,
  isAllowedAuthPath,
  verifyLogoutToken,
  withBackchannelLogoutTelemetry,
  type AuthInstance,
  type BackchannelLogoutOutcome,
  type CreateAuthOptions,
} from '@tayzu/auth';
import { createCerbosClient } from '@tayzu/authz';
import type { createPool } from '@tayzu/db';
import { createBlueprintService, createCatalogRouter, createEntityService } from '@tayzu/catalog';
import { drizzle } from 'drizzle-orm/node-postgres';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

import { errorMappingInterceptor, toOrpcError } from './error-mapping.js';

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
  readonly tokenExchangeRateLimit?: { readonly max: number; readonly timeWindowMs: number };
  /** Visma Connect SSO (D23), forwarded to `createAuth`; omitted: SSO is not registered. */
  readonly sso?: CreateAuthOptions['sso'];
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

const STEP_UP_HEADERS = '__stepUpHeaders';

interface StepUpHandlerContext {
  readonly [STEP_UP_HEADERS]: Headers;
  readonly tenantId: string;
  readonly actor: { readonly type: string; readonly id: string };
}

const TOKEN_EXCHANGE_PATH = '/v1/auth/token';
/** Skew added to the token's `exp` for the replay record's lifetime (D26). */
const LOGOUT_JTI_SKEW_SECONDS = 30;
/** Generous per-IP floor (D26): high enough not to drop legitimate logout bursts. */
const BACKCHANNEL_LOGOUT_RATE_LIMIT = { max: 600, timeWindowMs: 60_000 };
const BACKCHANNEL_LOGOUT_PATH = '/v1/auth/visma-connect/backchannel-logout';

function isTokenExchange(request: FastifyRequest): boolean {
  return request.method === 'POST' && request.url.split('?', 1)[0] === TOKEN_EXCHANGE_PATH;
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

function toWebRequest(request: FastifyRequest): Request {
  const headers = toWebHeaders(request);
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  let body: string | undefined;
  if (hasBody && request.body !== undefined && request.body !== null) {
    body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
    headers.delete('content-length');
  }
  return new Request(`http://${request.headers.host ?? 'localhost'}${request.url}`, {
    method: request.method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

export async function createApp(options: CreateAppOptions): Promise<App> {
  // The auth handle runs on the host's `tayzu_auth` pool; the catalog and
  // revocation pool run as `tayzu_app` so RLS applies.
  const authDb = drizzle(options.authPool, { schema: authSchema });
  const appPool = options.appPool;

  const auth = createAuth({
    db: authDb,
    secret: options.authSecret,
    ...(options.sso === undefined ? {} : { sso: options.sso }),
  });
  const resolveContext = createContextResolver({ auth, revocationPool: appPool });

  const authz = createCerbosClient({
    address: options.cerbosAddress,
    tls: !CERBOS_TLS_LOOPBACK_ONLY.test(options.cerbosAddress),
  });
  const router = createCatalogRouter({
    blueprints: createBlueprintService({ pool: appPool, authz }),
    entities: createEntityService({ pool: appPool, authz }),
  });
  // D4: the guard runs after context resolution and before the operation, for
  // every procedure whose route spec carries `x-tayzu-risk: high`. The caller's
  // headers travel in the handler context, under a private key.
  const stepUpGuard = createStepUpGuard({
    auth,
    ...(options.sso === undefined ? {} : { sso: options.sso }),
  });
  const openApiHandler = new OpenAPIHandler(router, {
    clientInterceptors: [
      errorMappingInterceptor,
      async (interceptorOptions) => {
        const { context, path, procedure } = interceptorOptions;
        const route = procedure['~orpc'].route;
        const resolvedSpec = typeof route.spec === 'function' ? route.spec({}) : route.spec;
        const stepUpContext = context as unknown as StepUpHandlerContext;
        await stepUpGuard({
          headers: stepUpContext[STEP_UP_HEADERS],
          tenantId: stepUpContext.tenantId,
          actor: stepUpContext.actor,
          route: {
            ...(resolvedSpec !== undefined &&
            (resolvedSpec as Record<string, unknown>)['x-tayzu-risk'] === 'high'
              ? { riskLevel: 'high' as const }
              : {}),
          },
          operation: path.join('.'),
        });
        return interceptorOptions.next();
      },
    ],
    // D13: custom-header CSRF check (default `x-csrf-token: orpc`) on every
    // mutating route. Fail closed: only an explicit GET/HEAD route is exempt.
    plugins: [
      new SimpleCsrfProtectionHandlerPlugin({
        exclude: ({ procedure }) => {
          const method = procedure['~orpc'].route.method;
          return method === 'GET' || method === 'HEAD';
        },
      }),
    ],
  });

  // Only a proxy on a private or loopback address (the ACA ingress) may set
  // the client address via `X-Forwarded-For`; a public peer's header is ignored.
  const app = Fastify({
    trustProxy: ['loopback', 'linklocal', 'uniquelocal'],
    ...(options.bodyLimit === undefined ? {} : { bodyLimit: options.bodyLimit }),
  });
  // D13: JSON API, so no CSP (003's concern); helmet's other defaults apply globally.
  // HSTS (task 11.12): one year, subdomains included (helmet's default is 180 days).
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: false,
    strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true },
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
    if (!request.url.startsWith('/api/auth')) {
      return;
    }
    const pathname = request.url.split('?', 1)[0] ?? '';
    if (!isAllowedAuthPath(pathname)) {
      reply.callNotFound();
    }
  });

  // D24 path (a): `/link-social` is a Better Auth native route, so D4's
  // procedure guard does not reach it; an MFA-enrolled caller needs a fresh
  // verification before the request reaches Better Auth.
  const assertLinkStepUp = createEnrolledStepUpCheck({ auth });
  app.addHook('preHandler', async (request, reply) => {
    if (request.method !== 'POST' || request.url.split('?', 1)[0] !== '/api/auth/link-social') {
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

  app.all('/api/auth/*', async (request, reply) => {
    const response = await (auth as unknown as AuthHandlerSurface).handler(toWebRequest(request));
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

  // D26: public back-channel logout (Visma Connect's infrastructure is the
  // caller: no cookie, no CSRF header). Encapsulated so the form parser does
  // not change how any other route sees its body. Every well-formed request
  // answers the same 200, whatever the token's validity or session match.
  /** Verifies, replay-guards and applies one logout token; the outcome is the only thing returned. */
  async function handleLogoutToken(
    token: string,
    config: NonNullable<CreateAppOptions['sso']>,
  ): Promise<BackchannelLogoutOutcome> {
    const verified = await verifyLogoutToken(token, {
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
  await app.register((scope, _opts, done) => {
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
            max: BACKCHANNEL_LOGOUT_RATE_LIMIT.max,
            timeWindow: BACKCHANNEL_LOGOUT_RATE_LIMIT.timeWindowMs,
            keyGenerator: (request: FastifyRequest): string => `backchannel-logout:${request.ip}`,
          },
        },
      },
      async (request, reply) => {
        const token = (request.body as Record<string, string> | undefined)?.['logout_token'];
        const malformed = typeof token !== 'string' || token === '';
        await withBackchannelLogoutTelemetry(async () => {
          if (malformed || sso === undefined) {
            return 'invalid';
          }
          return handleLogoutToken(token, sso);
        });
        if (malformed) {
          return reply.status(400).send({ defined: false, code: 'BAD_REQUEST', status: 400 });
        }
        return reply.status(200).send({});
      },
    );
    done();
  });

  // Resolved once per request: the rate-limit key generator and the handler share it.
  type Resolution = { context: Awaited<ReturnType<typeof resolveContext>> } | { error: unknown };
  const resolutions = new WeakMap<FastifyRequest, Promise<Resolution>>();
  const resolveOnce = (request: FastifyRequest): Promise<Resolution> => {
    let pending = resolutions.get(request);
    if (pending === undefined) {
      pending = resolveContext(toWebHeaders(request)).then(
        (context): Resolution => ({ context }),
        (error: unknown): Resolution => ({ error }),
      );
      resolutions.set(request, pending);
    }
    return pending;
  };

  const limited = new ORPCError('AUTH_RATE_LIMITED', {
    status: 429,
    message: 'Too many requests',
  });

  // D20: token exchange has no tenant/actor yet, so it gets its own bucket
  // (IP + client id) and is exempt from the authenticated one below.
  if (options.tokenExchangeRateLimit !== undefined) {
    const check = app.createRateLimit({
      max: options.tokenExchangeRateLimit.max,
      timeWindow: options.tokenExchangeRateLimit.timeWindowMs,
      // Internal bucket key only: hashed to bound its size, never logged or returned.
      keyGenerator: (request: FastifyRequest): string => {
        const body = request.body as { clientId?: unknown } | null | undefined;
        const clientId = typeof body?.clientId === 'string' ? body.clientId : '';
        return `token:${request.ip}:${createHash('sha256').update(clientId).digest('hex')}`;
      },
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

  let v1Config: { rateLimit?: object } = {};
  if (options.rateLimit !== undefined) {
    v1Config = {
      rateLimit: {
        max: options.rateLimit.max,
        timeWindow: options.rateLimit.timeWindowMs,
        allowList: isTokenExchange,
        // Internal bucket key only: never logged, returned or exported.
        keyGenerator: async (request: FastifyRequest): Promise<string> => {
          const resolved = await resolveOnce(request);
          if ('error' in resolved) {
            return `unauthenticated:${request.ip}`;
          }
          const { tenantId, actor } = resolved.context;
          return `${tenantId}:${actor.type}:${actor.id}`;
        },
        errorResponseBuilder: () => ({ ...limited.toJSON(), statusCode: 429 }),
      },
    };
  }

  app.all('/v1/*', { config: v1Config }, async (request, reply) => {
    const resolved = await resolveOnce(request);
    if ('error' in resolved) {
      // Same mapping and body shape as any other error, via oRPC's own JSON.
      const mapped = toOrpcError(resolved.error);
      return reply.status(mapped.status).send(mapped.toJSON());
    }
    const context = resolved.context;
    const result = await openApiHandler.handle(request, reply, {
      context: { ...context, [STEP_UP_HEADERS]: toWebHeaders(request) },
    });
    if (!result.matched) {
      return reply.status(404).send({ defined: false, code: 'NOT_FOUND', status: 404 });
    }
    return undefined;
  });

  await app.ready();

  return {
    app,
    auth,
    async close(): Promise<void> {
      await app.close();
    },
  };
}
