/**
 * Machine-credential token exchange (task 5.3, design D5; `specs/auth-and-
 * rbac/spec.md`, "Machine credentials").
 *
 * "A new procedure, `POST /v1/auth/token`, is **not** part of Better Auth's
 * own route set. It calls `auth.api.verifyApiKey({ body: { key } })`; on
 * success it mints a 1-hour token via the `jwt` plugin (`auth.api.getToken`-
 * equivalent, scoped to `{ tenantId: key.referenceId, actor: { type: key.
 * metadata.actorKind, id: key.id } }`), signed with the `jwt` plugin's own
 * key ... On failure it returns `AUTH_INVALID_CREDENTIALS`." "`actorKind`
 * (`integration` or `agent`) is fixed at credential-creation time via the
 * config's `metadata`, never chosen by the caller of `POST /v1/auth/token`."
 *
 * `auth.api.verifyApiKey` is scoped to the `machine-credential` config
 * (`./machine-credentials.ts`'s own `MACHINE_CREDENTIAL_CONFIG_ID`, mirrored
 * here): the installed `@better-auth/api-key@1.7.6` route falls back to a
 * config literally named `"default"` when `configId` is omitted
 * (`resolveConfiguration`, `dist/index.mjs`), and `./auth.ts` registers no
 * such config -- design D5's own `{ body: { key } }` quote elides this
 * scoping detail, confirmed by running this file's own tests unscoped first
 * and observing `NO_DEFAULT_API_KEY_CONFIGURATION_FOUND`.
 *
 * The installed `better-auth@1.7.6` `jwt` plugin's own session-bound `/token`
 * route (`getToken`, `dist/plugins/jwt/index.mjs`) requires a live session
 * (`sessionMiddleware`) and signs `ctx.context.session.user` -- not usable
 * here, where the caller authenticates with a client id/secret pair, not a
 * session. `auth.api.signJWT` (the same plugin's `serverOnly` endpoint, `dist/
 * plugins/jwt/index.mjs`) signs an arbitrary caller-supplied payload with the
 * identical `jwt` plugin key instead: this module's "`auth.api.getToken`-
 * equivalent" per design D5's own wording. Passing an explicit `exp` claim
 * (now + one hour) is read as-is by `signJWT` (`dist/plugins/jwt/sign.mjs`:
 * `exp = payload.exp ?? defaultExp`), which is this module's one-hour
 * expiry -- no `overrideOptions` needed.
 *
 * `auth.api.verifyApiKey` (`@better-auth/api-key@1.7.6`, `dist/index.mjs`)
 * never throws on an invalid, mismatched, or disabled (revoked) key: every
 * failure is caught internally and returned as `{ valid: false, key: null,
 * error: { code, message } }`. This module treats every such outcome
 * identically from the *caller's* point of view, per the requirement text
 * ("On failure it returns `AUTH_INVALID_CREDENTIALS`") -- a caller cannot
 * distinguish an unknown client id from a revoked one. Internally, though,
 * `error.code` (confirmed against the installed source: `defineErrorCodes`,
 * `@better-auth/core/utils/error-codes.mjs`, tags every `API_KEY_ERROR_CODES`
 * entry with its own key as `code`) is read once, for telemetry only, to
 * recover the credential's `actorKind` on the one rejection reason where the
 * row was actually found (`KEY_DISABLED`, see this module's own
 * `disabledCredentialKind` and the "Telemetry on the failure paths" section
 * below) -- never to change the response shape or timing.
 *
 * ## Telemetry on the failure paths (`observability-auditor` fix-up)
 *
 * design.md, "Observability contract": every rejection also emits the
 * `auth.token.exchange` span, the `tayzu.auth.token.exchanges` counter
 * (`tayzu.auth.exchange.outcome: 'invalid_credentials'`), and the
 * `auth.security.token_exchange_failed` WARN log -- not only the success
 * path. `tayzu.auth.credential.kind` is present on all three only when the
 * credential was actually found (disabled); it is absent when
 * `verifyApiKey`'s own lookup-by-secret never found a row at all (an unknown
 * client id or the right client id with a wrong secret), since nothing in
 * that response tells this module what kind such a row would have been.
 * `disabledCredentialKind` recovers the known case with one direct row
 * lookup, by `clientId`, through the same low-level adapter primitive
 * `./step-up.ts`'s own freshness check already uses (`auth.$context`'s
 * `adapter`/`internalAdapter`, never a second, ad hoc database connection) --
 * a lookup failure there fails safe by omitting the attribute, never by
 * changing the thrown error.
 *
 * Task 5.4 fix (surfaced by `context-resolver.int.test.ts`'s own "fresh
 * machine access token" scenario, which calls this function's real output
 * through `./context-resolver.ts`'s new access-token branch): the installed
 * `better-auth@1.7.6` `jwt` plugin's own `verifyJWT` (`dist/plugins/jwt/
 * verify.mjs`) unconditionally rejects any payload lacking a truthy `sub` or
 * `aud`, independent of signature or expiry validity -- confirmed against
 * the installed source by running this module's own output through
 * `verifyJWT` directly. `sub` is set here, to the credential's own client id
 * (the same id the `actor.id` claim already carries). `aud` (and `iss`) are
 * *not* set per-payload here: both `signJWT` and `verifyJWT` fall back
 * identically to `ctx.context.options.baseURL` when the plugin's own
 * `jwt.issuer`/`jwt.audience` option is unset -- an empty string, never
 * `undefined` (confirmed against the installed `create-context.mjs`), which
 * is why the plugin needed a real, non-empty `jwt.issuer`/`jwt.audience`
 * configured once in `./auth.ts` (`MACHINE_TOKEN_ISSUER`/`_AUDIENCE`) rather
 * than a differing constant passed per call here, which would only make
 * `verifyJWT`'s own issuer/audience check fail against that empty-string
 * default instead.
 */
import { SeverityNumber } from '@opentelemetry/api-logs';

import type { AuthInstance } from './auth.js';
import { AuthInvalidCredentialsError } from './errors.js';
import type { MachineCredentialActorKind } from './machine-credentials.js';
import { logger, tokenExchangesCounter, tracer } from './telemetry/instruments.js';

/** design D5: the one `apiKey` plugin config machine credentials live under (mirrors `./machine-credentials.ts`'s own `MACHINE_CREDENTIAL_CONFIG_ID`). */
const MACHINE_CREDENTIAL_CONFIG_ID = 'machine-credential';

/** design D5: the config `verifyApiKey` looks the credential up under. */
const ACTOR_KIND_METADATA_KEY = 'actorKind';

/** design D5: "a 1-hour access token." */
const ONE_HOUR_SECONDS = 60 * 60;

/** design.md, Spans/Metrics tables: `tayzu.auth.credential.kind` (`integration`|`agent`). */
const CREDENTIAL_KIND_ATTRIBUTE = 'tayzu.auth.credential.kind';
/** design.md, Metrics table: `tayzu.auth.exchange.outcome` (`success`|`invalid_credentials`). */
const EXCHANGE_OUTCOME_ATTRIBUTE = 'tayzu.auth.exchange.outcome';

export interface ExchangeMachineTokenParams {
  /**
   * The credential's client id (`CreatedMachineCredential['id']`).
   * `verifyApiKey` itself looks the credential up by its secret alone; this
   * field is only used on a `KEY_DISABLED` rejection, to recover the
   * disabled credential's own `actorKind` for failure telemetry (see this
   * module's own doc comment, "Telemetry on the failure paths").
   */
  readonly clientId: string;
  /** The credential's client secret (`CreatedMachineCredential['secret']`). */
  readonly clientSecret: string;
}

/** design D5, requirement text: "MUST return an access token." */
export interface ExchangedMachineToken {
  readonly accessToken: string;
}

/**
 * The narrow slice of `auth.api.verifyApiKey`'s installed response
 * (`@better-auth/api-key@1.7.6`, `dist/index-BJOGXZav.d.mts`) this module
 * reads. `error.code` is only read on a rejection, to tell a
 * `KEY_DISABLED` row (found, but disabled) apart from every other rejection
 * reason (no row found at all) -- see this module's own doc comment.
 */
interface VerifiedApiKey {
  readonly valid: boolean;
  readonly error: { readonly code?: string } | null;
  readonly key: {
    readonly id: string;
    readonly referenceId: string;
    readonly metadata: Record<string, unknown> | null;
  } | null;
}

/** The narrow slice of `auth.api.signJWT`'s installed response (`better-auth@1.7.6`, `dist/plugins/jwt/index.mjs`) this module reads. */
interface SignedJwt {
  readonly token: string;
}

interface AuthApiSurface {
  verifyApiKey(args: { body: { key: string; configId: string } }): Promise<VerifiedApiKey>;
  signJWT(args: { body: { payload: Record<string, unknown> } }): Promise<SignedJwt>;
}

function apiOf(auth: AuthInstance): AuthApiSurface {
  return auth.api as AuthApiSurface;
}

/**
 * The one row-shaped slice `disabledCredentialKind` reads directly off the
 * `apikey` table, through the same low-level `auth.$context` adapter
 * primitive `./step-up.ts`'s own freshness check already uses -- never a
 * second, ad hoc database connection, and never direct SQL.
 */
interface StoredMachineCredentialRow {
  readonly metadata: Record<string, unknown> | null;
}

interface AdapterSurface {
  findOne<T>(args: {
    model: string;
    where: readonly { field: string; value: string }[];
  }): Promise<T | null>;
}

interface AuthContextSurface {
  readonly adapter: AdapterSurface;
}

function contextOf(auth: AuthInstance): Promise<AuthContextSurface> {
  return auth.$context as Promise<AuthContextSurface>;
}

/** `@better-auth/api-key@1.7.6`'s own model name for the `apiKey` table (`dist/index.mjs`'s `API_KEY_TABLE_NAME`). */
const API_KEY_TABLE_NAME = 'apikey';

/** `verifyApiKey`'s own rejection code (`@better-auth/api-key@1.7.6`'s `API_KEY_ERROR_CODES.KEY_DISABLED.code`) for "the row was found, but disabled." */
const KEY_DISABLED_ERROR_CODE = 'KEY_DISABLED';

/**
 * Recovers a disabled machine credential's own `actorKind`, for failure
 * telemetry only (see this module's own doc comment, "Telemetry on the
 * failure paths"): `verifyApiKey`'s own public response discards `key` on
 * every rejection, including a disabled key it otherwise found by its real
 * secret. Any lookup failure here (the row is gone, or the database is
 * unreachable) resolves to `undefined` -- the caller-visible
 * `AuthInvalidCredentialsError` never depends on this succeeding.
 */
async function disabledCredentialKind(
  auth: AuthInstance,
  clientId: string,
): Promise<MachineCredentialActorKind | undefined> {
  const kind = await contextOf(auth)
    .then((context) =>
      context.adapter.findOne<StoredMachineCredentialRow>({
        model: API_KEY_TABLE_NAME,
        where: [{ field: 'id', value: clientId }],
      }),
    )
    .then((row) => row?.metadata?.[ACTOR_KIND_METADATA_KEY])
    .catch(() => undefined);
  return kind === 'integration' || kind === 'agent' ? kind : undefined;
}

/** design.md, Spans table: `auth.token.exchange`; Metrics table: `tayzu.auth.token.exchanges`. */
function recordSuccessfulExchange(actorKind: MachineCredentialActorKind): void {
  tracer
    .startSpan('auth.token.exchange', { attributes: { [CREDENTIAL_KIND_ATTRIBUTE]: actorKind } })
    .end();
  tokenExchangesCounter.add(1, {
    [CREDENTIAL_KIND_ATTRIBUTE]: actorKind,
    [EXCHANGE_OUTCOME_ATTRIBUTE]: 'success',
  });
}

/**
 * design.md, Spans table: `auth.token.exchange`; Metrics table: `tayzu.auth.
 * token.exchanges`; Log events table: `auth.security.token_exchange_failed`.
 * `actorKind` is only known (and only present as an attribute) when the
 * credential was found but disabled (see this module's own doc comment) --
 * absent for every other rejection reason, per design.md's own closed
 * `integration`|`agent` enum naming no third value for "unknown."
 */
function recordFailedExchange(actorKind: MachineCredentialActorKind | undefined): void {
  const kindAttributes = actorKind === undefined ? {} : { [CREDENTIAL_KIND_ATTRIBUTE]: actorKind };

  tracer.startSpan('auth.token.exchange', { attributes: kindAttributes }).end();

  tokenExchangesCounter.add(1, {
    ...kindAttributes,
    [EXCHANGE_OUTCOME_ATTRIBUTE]: 'invalid_credentials',
  });

  logger.emit({
    eventName: 'auth.security.token_exchange_failed',
    severityNumber: SeverityNumber.WARN,
    attributes: kindAttributes,
  });
}

/**
 * Exchanges a machine credential's client id and secret for a 1-hour access
 * token (design D5). Rejects with `AuthInvalidCredentialsError` on an
 * unknown, mismatched, or revoked credential -- see this module's own doc
 * comment for why every such case is indistinguishable from the caller's
 * side.
 */
export async function exchangeMachineToken(
  auth: AuthInstance,
  params: ExchangeMachineTokenParams,
): Promise<ExchangedMachineToken> {
  const api = apiOf(auth);

  const verified = await api.verifyApiKey({
    body: { key: params.clientSecret, configId: MACHINE_CREDENTIAL_CONFIG_ID },
  });
  const key = verified.valid ? verified.key : null;
  if (key === null) {
    // "Wrong secret is rejected" never finds a row by secret at all; only a
    // `KEY_DISABLED` rejection found a real, disabled row worth recovering
    // the kind of (see this module's own doc comment).
    const knownKind =
      verified.error?.code === KEY_DISABLED_ERROR_CODE
        ? await disabledCredentialKind(auth, params.clientId)
        : undefined;
    recordFailedExchange(knownKind);
    throw new AuthInvalidCredentialsError();
  }

  const actorKind = key.metadata?.[ACTOR_KIND_METADATA_KEY];
  if (actorKind !== 'integration' && actorKind !== 'agent') {
    recordFailedExchange(undefined);
    throw new AuthInvalidCredentialsError();
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const signed = await api.signJWT({
    body: {
      payload: {
        tenantId: key.referenceId,
        actor: { type: actorKind, id: key.id },
        sub: key.id,
        iat: nowSeconds,
        exp: nowSeconds + ONE_HOUR_SECONDS,
      },
    },
  });

  recordSuccessfulExchange(actorKind);

  return { accessToken: signed.token };
}
