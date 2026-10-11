/**
 * Shared helpers of the SSO link shed tests (task 8.5h): a random IP per
 * request (so the rate limiter never interferes), the OIDC stub round trip for
 * a sign-in or a `/link-social` and a pool wrapper that fails the statements a
 * test selects. Nothing here imports `@tayzu/auth`, so importing it cannot
 * create the package's instruments before the telemetry harness registers.
 */
import { randomInt } from 'node:crypto';

import type { Pool } from 'pg';

export const ORIGIN = 'http://localhost:3000';
export const AUTH_BASE_URL = `${ORIGIN}/api/auth`;
export const PROVIDER_ID = 'visma-connect';
export const MARKER_PREFIX = 'sso-link:';

export function randomIp(): string {
  const octet = (): string => randomInt(1, 255).toString(10);
  return `10.${octet()}.${octet()}.${octet()}`;
}

/** A `cookie` request header value from a response's `Set-Cookie` headers (possibly empty). */
export function cookieHeaderFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((raw) => raw.split(';')[0])
    .join('; ');
}

/** True when the response sets a session token cookie. */
export function setsSessionCookie(response: Response): boolean {
  return response.headers.getSetCookie().some((c) => c.includes('session_token'));
}

export type Handler = (request: Request) => Promise<Response>;

export interface OidcRoundTrip {
  /** The response of the last request of the flow. */
  readonly response: Response;
  /** Every cookie the flow's callback responses set, as one `cookie` header value. */
  readonly cookie: string;
}

/**
 * Starts `path` (`/sign-in/social` or `/link-social`) at the provider, lets the
 * stub approve, posts the `form_post` callback and follows its same-URL `GET`.
 * The caller sets the stub's subject first.
 */
export async function oidcRoundTrip(
  handler: Handler,
  path: '/sign-in/social' | '/link-social',
  cookie: string,
): Promise<OidcRoundTrip> {
  const initiated = await handler(
    new Request(`${AUTH_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': randomIp(),
        origin: ORIGIN,
        ...(cookie === '' ? {} : { cookie }),
      },
      body: JSON.stringify({ provider: PROVIDER_ID, callbackURL: '/' }),
    }),
  );
  if (initiated.status !== 200) {
    throw new Error(`the flow did not start: ${String(initiated.status)}`);
  }
  const { url } = (await initiated.json()) as { url: string };
  const page = await (await fetch(url, { redirect: 'manual' })).text();
  const inputs = Object.fromEntries(
    [...page.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [
      m[1] ?? '',
      m[2] ?? '',
    ]),
  );
  const code = inputs['code'];
  const state = inputs['state'];
  if (code === undefined || state === undefined) {
    throw new Error('the OIDC stub did not return code and state');
  }
  const params = new URLSearchParams({
    code,
    state,
    ...(inputs['iss'] === undefined ? {} : { iss: inputs['iss'] }),
  });
  const callbackCookie = [cookie, cookieHeaderFrom(initiated)]
    .filter((part) => part !== '')
    .join('; ');
  const headers = (extra: Record<string, string>): Record<string, string> => ({
    'x-forwarded-for': randomIp(),
    ...(callbackCookie === '' ? {} : { cookie: callbackCookie }),
    ...extra,
  });
  const posted = await handler(
    new Request(`${AUTH_BASE_URL}/callback/${PROVIDER_ID}`, {
      method: 'POST',
      headers: headers({
        'content-type': 'application/x-www-form-urlencoded',
        origin: ORIGIN,
      }),
      body: params.toString(),
    }),
  );
  const location = posted.headers.get('location');
  if (
    posted.status >= 300 &&
    posted.status < 400 &&
    location !== null &&
    new URL(location, AUTH_BASE_URL).pathname.endsWith(`/callback/${PROVIDER_ID}`)
  ) {
    const followed = await handler(
      new Request(new URL(location, AUTH_BASE_URL), { method: 'GET', headers: headers({}) }),
    );
    return {
      response: followed,
      cookie: [cookieHeaderFrom(posted), cookieHeaderFrom(followed)]
        .filter((part) => part !== '')
        .join('; '),
    };
  }
  return { response: posted, cookie: cookieHeaderFrom(posted) };
}

/** The text and bind values of a `pg` query call, whichever overload it used. */
function queryParts(args: readonly unknown[]): { text: string; values: readonly unknown[] } {
  const [first, second] = args;
  const config = (typeof first === 'object' ? first : null) as {
    text?: unknown;
    values?: unknown;
  } | null;
  const text = typeof first === 'string' ? first : config?.text;
  const values = Array.isArray(second) ? (second as unknown[]) : config?.values;
  return {
    text: typeof text === 'string' ? text : '',
    values: Array.isArray(values) ? (values as unknown[]) : [],
  };
}

/**
 * A pool whose `query` rejects every statement for which `blocks` answers true
 * (pool-level and on the clients it hands out) and passes everything else.
 */
export function poolFailing(
  pool: Pool,
  blocks: (text: string, values: readonly unknown[]) => boolean,
): Pool {
  const wrap = <T extends object>(target: T, overrides: Record<string, unknown>): T =>
    new Proxy(target, {
      get(object, property) {
        if (typeof property === 'string' && property in overrides) return overrides[property];
        const value: unknown = Reflect.get(object, property, object);
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(object)
          : value;
      },
    });
  const guardedQuery =
    (target: { query: (...args: unknown[]) => unknown }) =>
    (...args: unknown[]): unknown => {
      const { text, values } = queryParts(args);
      return blocks(text, values)
        ? Promise.reject(new Error('injected statement failure'))
        : target.query(...args);
    };
  return wrap(pool, {
    query: guardedQuery(pool as unknown as { query: (...args: unknown[]) => unknown }),
    connect: async (...args: unknown[]): Promise<unknown> => {
      const client = await (pool.connect as (...a: unknown[]) => Promise<object>).apply(pool, args);
      return wrap(client, {
        query: guardedQuery(client as unknown as { query: (...a: unknown[]) => unknown }),
      });
    },
  });
}
