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
import { createHash } from 'node:crypto';

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
  isAllowedAuthPath,
  type AuthInstance,
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

const TOKEN_EXCHANGE_PATH = '/v1/auth/token';

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

  const auth = createAuth({ db: authDb, secret: options.authSecret });
  const resolveContext = createContextResolver({ auth, revocationPool: appPool });

  const authz = createCerbosClient({
    address: options.cerbosAddress,
    tls: !CERBOS_TLS_LOOPBACK_ONLY.test(options.cerbosAddress),
  });
  const router = createCatalogRouter({
    blueprints: createBlueprintService({ pool: appPool, authz }),
    entities: createEntityService({ pool: appPool, authz }),
  });
  const openApiHandler = new OpenAPIHandler(router, {
    clientInterceptors: [errorMappingInterceptor],
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
  if (options.rateLimit !== undefined || options.tokenExchangeRateLimit !== undefined) {
    await app.register(fastifyRateLimit, { global: false });
  }

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
      context: { ...context },
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
