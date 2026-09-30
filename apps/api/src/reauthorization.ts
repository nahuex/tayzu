/**
 * Visma Connect step-up re-authorization over HTTP (task 23.8, design Q36, D25).
 *
 * `start` builds the authorization URL (`max_age=300`, `prompt=login`,
 * `acr_values=urn:idp:vismaconnect:mfa`, PKCE S256) for a session that Visma
 * Connect established, and remembers the `state` in `auth.verification`, bound
 * to that session's token. `complete` exchanges the callback's code and stores
 * the returned ID token under the session; `lookup` hands it to the step-up
 * guard, which validates `auth_time`, `acr`, `amr` and `sid` server-side (D25).
 * The callback never needs the cookie: the single-use, unguessable `state` is
 * the binding. Nothing from the provider or the token reaches logs or errors.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { AuthInstance } from '@tayzu/auth';
import type { createPool } from '@tayzu/db';

type Pool = ReturnType<typeof createPool>;

export interface ReauthorizationOptions {
  readonly auth: AuthInstance;
  readonly authPool: Pool;
  readonly discoveryUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Absolute URL of the callback route, registered at Visma Connect. */
  readonly redirectUri: string;
}

/** design D25: freshness threshold, the same 5 minutes as local step-up. */
const MAX_AGE_SECONDS = 300;
const ACR_VALUES = 'urn:idp:vismaconnect:mfa';
const STATE_TTL_SECONDS = 600;
/** The stored ID token lives as long as it can still pass D25's `auth_time` check. */
const RESULT_TTL_SECONDS = MAX_AGE_SECONDS + 30;
const HTTP_TIMEOUT_MS = 5_000;

const STATE_PREFIX = 'sso-reauth-state:';
const RESULT_PREFIX = 'sso-reauth-result:';

interface SessionSurface {
  getSession(args: { headers: Headers }): Promise<{
    session: { token: string; ssoSid?: string | null };
  } | null>;
}

interface Discovery {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
}

export interface Reauthorization {
  /** The authorization URL for a Visma-Connect-established session; `null` for any other caller. */
  start(headers: Headers): Promise<string | null>;
  /** The stored ID token for the caller's session, if a callback recorded one still in date. */
  lookup(headers: Headers): Promise<{ readonly idToken: string } | null>;
  /** Handles the callback; resolves `true` when an ID token was stored for the bound session. */
  complete(params: { readonly code?: unknown; readonly state?: unknown }): Promise<boolean>;
}

async function fetchDiscovery(url: string): Promise<Discovery | null> {
  const response = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (!response.ok) {
    return null;
  }
  const body = (await response.json()) as Record<string, unknown>;
  const authorizationEndpoint = body['authorization_endpoint'];
  const tokenEndpoint = body['token_endpoint'];
  if (typeof authorizationEndpoint !== 'string' || typeof tokenEndpoint !== 'string') {
    return null;
  }
  return { authorizationEndpoint, tokenEndpoint };
}

export function createReauthorization(options: ReauthorizationOptions): Reauthorization {
  const api = options.auth.api as SessionSurface;

  async function ssoSession(headers: Headers): Promise<string | null> {
    const found = await api.getSession({ headers }).catch(() => null);
    const sid = found?.session.ssoSid;
    return found !== null && typeof sid === 'string' && sid !== '' ? found.session.token : null;
  }

  async function store(identifier: string, value: string, ttlSeconds: number): Promise<void> {
    await options.authPool.query(
      `insert into auth.verification (id, identifier, value, expires_at)
       values ($1, $2, $3, now() + make_interval(secs => $4))`,
      [randomUUID(), identifier, value, ttlSeconds],
    );
  }

  return {
    async start(headers) {
      const token = await ssoSession(headers);
      if (token === null) {
        return null;
      }
      const discovery = await fetchDiscovery(options.discoveryUrl).catch(() => null);
      if (discovery === null) {
        return null;
      }
      const state = randomBytes(32).toString('base64url');
      const verifier = randomBytes(32).toString('base64url');
      await store(
        `${STATE_PREFIX}${state}`,
        JSON.stringify({ token, verifier }),
        STATE_TTL_SECONDS,
      );
      const url = new URL(discovery.authorizationEndpoint);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', options.clientId);
      url.searchParams.set('redirect_uri', options.redirectUri);
      url.searchParams.set('scope', 'openid');
      url.searchParams.set('state', state);
      url.searchParams.set(
        'code_challenge',
        createHash('sha256').update(verifier).digest('base64url'),
      );
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('max_age', String(MAX_AGE_SECONDS));
      url.searchParams.set('prompt', 'login');
      url.searchParams.set('acr_values', ACR_VALUES);
      return url.toString();
    },

    async lookup(headers) {
      const token = await ssoSession(headers);
      if (token === null) {
        return null;
      }
      const result = await options.authPool.query<{ value: string }>(
        `select value from auth.verification
         where identifier = $1 and expires_at > now()
         order by created_at desc limit 1`,
        [`${RESULT_PREFIX}${token}`],
      );
      const idToken = result.rows[0]?.value;
      return idToken === undefined ? null : { idToken };
    },

    async complete(params) {
      if (typeof params.code !== 'string' || typeof params.state !== 'string') {
        return false;
      }
      // Single use: the state row is consumed by the first callback that presents it.
      const consumed = await options.authPool.query<{ value: string }>(
        `delete from auth.verification
         where identifier = $1 and expires_at > now()
         returning value`,
        [`${STATE_PREFIX}${params.state}`],
      );
      const raw = consumed.rows[0]?.value;
      if (raw === undefined) {
        return false;
      }
      try {
        const { token, verifier } = JSON.parse(raw) as { token: string; verifier: string };
        const discovery = await fetchDiscovery(options.discoveryUrl);
        if (discovery === null) {
          return false;
        }
        const response = await fetch(discovery.tokenEndpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: params.code,
            redirect_uri: options.redirectUri,
            client_id: options.clientId,
            client_secret: options.clientSecret,
            code_verifier: verifier,
          }),
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
        if (!response.ok) {
          return false;
        }
        const body = (await response.json()) as Record<string, unknown>;
        const idToken = body['id_token'];
        if (typeof idToken !== 'string') {
          return false;
        }
        // The guard verifies signature and claims (D25); this only records the result.
        await options.authPool.query('delete from auth.verification where identifier = $1', [
          `${RESULT_PREFIX}${token}`,
        ]);
        await store(`${RESULT_PREFIX}${token}`, idToken, RESULT_TTL_SECONDS);
        return true;
      } catch {
        return false;
      }
    },
  };
}
