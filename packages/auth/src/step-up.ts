/**
 * Step-up guard for high-risk operations (task 4.2, design D4;
 * `specs/auth-and-rbac/spec.md`, "Step-up authentication for high-risk
 * operations").
 *
 * Design D4: "every procedure whose `route.spec` carries `x-tayzu-risk:
 * high` is wrapped so that, for a `user` actor only, the guard calls
 * `auth.api.verifyTwoFactor`'s underlying freshness check (a
 * `twoFactorVerifiedAt` timestamp stored on the session, updated whenever
 * `/two-factor/verify` succeeds) and rejects with `AUTH_STEP_UP_REQUIRED` if
 * older than 5 minutes or absent. `agent`/`integration`/`system` actors skip
 * this guard entirely."
 *
 * The installed `better-auth@1.7.6` source (`dist/plugins/two-factor/
 * verify-two-factor.mjs`, `dist/plugins/two-factor/totp/index.mjs`,
 * `dist/plugins/two-factor/backup-codes/index.mjs`) has no built-in
 * `twoFactorVerifiedAt` field or freshness check of its own -- confirmed by
 * reading every `two-factor` plugin file before writing this module. This
 * package therefore records the freshness marker itself: `./auth.ts`'s
 * `hooks.after` writes a `verification` row (Better Auth's own generic
 * "short-lived value for an out-of-band check" table, already used for
 * `two-factor`'s own trust-device tokens) keyed by
 * `stepUpVerificationIdentifier(sessionToken)` whenever any `/two-factor/
 * verify-*` endpoint succeeds, with `expiresAt` set to the freshness window
 * below. This guard only ever reads that row back, through Better Auth's own
 * `internalAdapter.findVerificationValue` -- never a second, ad hoc database
 * connection, and never direct SQL.
 *
 * `createStepUpGuard({ auth })` follows the same `create*({ auth })` factory
 * convention `./context-resolver.ts`'s `createContextResolver({ auth })`
 * already establishes. `AssertStepUpParams` carries `headers` (so the guard
 * reads the caller's real, current session through `auth.api.getSession`,
 * rather than trusting a caller-supplied timestamp), `tenantId`/`actor`
 * (the same two fields a resolved `CatalogContext` already carries at the
 * point a pipeline integration calls this guard, immediately after context
 * resolution and before the operation itself runs -- design D4's own
 * ordering), `route.riskLevel` (a stand-in for "the invoked procedure's
 * route carries `x-tayzu-risk: high`" -- the real marker lives in
 * `@tayzu/catalog`'s oRPC contract, which this package cannot import), and
 * `operation` (`tayzu.catalog.operation`'s value on the blocked-case
 * telemetry below, `packages/catalog/src/service/pipeline.ts`'s own
 * `OPERATION_ATTRIBUTE`).
 *
 * Telemetry fix-up (`observability-auditor` BLOCK on this task): design.md's
 * Spans table also declares `auth.session.step_up_check`, unconditional on
 * every guard invocation for a `user` actor on a high-risk route -- fired
 * once per call, whether the guard then allows or blocks, with
 * `tayzu.auth.method` (always `'local'` today, see `LOCAL_AUTH_METHOD`) and
 * `tayzu.auth.step_up.fresh` recording the same freshness check
 * `emitStepUpRequired` only reports on the blocked case.
 */
import { SeverityNumber } from '@opentelemetry/api-logs';
import { sharedAttributeKeys } from '@tayzu/observability/semconv';

import type { AuthInstance } from './auth.js';
import { AuthStepUpError } from './errors.js';
import { isValidReauthorization } from './sso/reauthorization.js';
import type { VismaConnectOptions } from './sso/visma-connect.js';
import { logger, stepUpRequiredCounter, tracer } from './telemetry/instruments.js';

/** design.md, Conventions/D4: "an MFA verification is 'fresh' for 5 minutes." */
export const STEP_UP_FRESHNESS_MS = 5 * 60 * 1000;

/** design.md, Log/Metrics tables: `auth.security.step_up_required`'s/`tayzu.auth.step_up.required`'s shared attribute. */
const OPERATION_ATTRIBUTE = 'tayzu.catalog.operation';

/** design.md, Spans table: `auth.session.step_up_check`'s required attribute. */
const METHOD_ATTRIBUTE = 'tayzu.auth.method';
/** design.md, Spans table: `auth.session.step_up_check`'s conditional attribute. */
const FRESHNESS_ATTRIBUTE = 'tayzu.auth.step_up.fresh';

/**
 * design.md, Spans table: `auth.session.step_up_check`'s `tayzu.auth.method`
 * (`local`|`visma_connect`). No session in this package yet carries a Visma
 * Connect-established marker (`ssoSid`, design D25, task 21.2, not
 * implemented) -- `'local'` is the only value reachable today.
 */
const LOCAL_AUTH_METHOD = 'local';
/** design D25: the method recorded for a session established through Visma Connect. */
const VISMA_CONNECT_AUTH_METHOD = 'visma_connect';

const STEP_UP_VERIFICATION_IDENTIFIER_PREFIX = 'step-up-verified';

/**
 * The `verification` table `identifier` this module's freshness marker is
 * stored under, keyed by session token (never by user id, so a stale token
 * from a since-revoked session cannot carry a freshness marker forward onto
 * a different session). Exported so `./auth.ts`'s `hooks.after` writes under
 * the identical key this guard reads back.
 */
export function stepUpVerificationIdentifier(sessionToken: string): string {
  return `${STEP_UP_VERIFICATION_IDENTIFIER_PREFIX}:${sessionToken}`;
}

/** design Q51: the factor a step-up marker records (its `verification.value`). */
export type StepUpFactor = 'mfa' | 'password';

export interface StepUpGuardOptions {
  /** The Better Auth instance whose session/verification state the guard reads. */
  readonly auth: AuthInstance;
  /** The Visma Connect settings `createAuth` takes; needed to verify re-authorization ID tokens (D25). */
  readonly sso?: VismaConnectOptions;
}

export interface AssertStepUpParams {
  /** The caller's real request headers, so the guard reads its own current session. */
  readonly headers: Headers;
  readonly tenantId: string;
  readonly actor: {
    readonly type: string;
    readonly id: string;
  };
  /** A stand-in for the invoked procedure's route (design D4: `x-tayzu-risk: high`). */
  readonly route: {
    readonly riskLevel?: 'high';
  };
  /** `tayzu.catalog.operation`'s value on the blocked-case telemetry. */
  readonly operation: string;
  /**
   * design D25: the raw ID token the host's Visma Connect re-authorization
   * callback received. Only consulted for a session with `ssoSid` set.
   */
  readonly reauthorization?: { readonly idToken: string };
}

/** Resolves when the operation may proceed; rejects with `AuthStepUpError` otherwise. */
export type StepUpGuard = (params: AssertStepUpParams) => Promise<void>;

/** The slice of `auth.api.getSession`'s resolved value this module reads. */
interface SessionResult {
  readonly session: {
    readonly token: string;
    readonly ssoSid?: string | null;
  };
  readonly user?: {
    readonly twoFactorEnabled?: boolean | null;
  };
}

interface AuthApiSurface {
  getSession(args: { headers: Headers }): Promise<SessionResult | null>;
}

function apiOf(auth: AuthInstance): AuthApiSurface {
  return auth.api as AuthApiSurface;
}

/**
 * The slice of Better Auth's own `AuthContext` (`auth.$context`) this module
 * reads: its low-level internal adapter, the same primitive `./auth.ts`'s
 * `hooks.after` writes the freshness marker through.
 */
interface AuthContextSurface {
  readonly internalAdapter: {
    findVerificationValue(
      identifier: string,
    ): Promise<{ readonly expiresAt: Date; readonly value: string } | null>;
  };
}

function contextOf(auth: AuthInstance): Promise<AuthContextSurface> {
  return auth.$context as Promise<AuthContextSurface>;
}

/** design.md, Log events table: `auth.security.step_up_required`; Metrics table: `tayzu.auth.step_up.required`. */
function emitStepUpRequired(params: {
  readonly tenantId: string;
  readonly actorId: string;
  readonly operation: string;
}): void {
  logger.emit({
    eventName: 'auth.security.step_up_required',
    severityNumber: SeverityNumber.WARN,
    attributes: {
      [sharedAttributeKeys.tenantId]: params.tenantId,
      [sharedAttributeKeys.actorId]: params.actorId,
      [OPERATION_ATTRIBUTE]: params.operation,
    },
  });
  stepUpRequiredCounter.add(1, { [OPERATION_ATTRIBUTE]: params.operation });
}

/** design.md, Log events table: `auth.security.step_up_insufficient` (design D25). */
function emitStepUpInsufficient(params: {
  readonly tenantId: string;
  readonly actorId: string;
}): void {
  logger.emit({
    eventName: 'auth.security.step_up_insufficient',
    severityNumber: SeverityNumber.WARN,
    attributes: {
      [sharedAttributeKeys.tenantId]: params.tenantId,
      [sharedAttributeKeys.actorId]: params.actorId,
      [METHOD_ATTRIBUTE]: VISMA_CONNECT_AUTH_METHOD,
    },
  });
}

/**
 * design.md, Spans table: `auth.session.step_up_check` -- "any `x-tayzu-
 * risk: high` operation invoked by a `user` actor," unconditional on the
 * guard's own allow/block outcome (unlike `emitStepUpRequired` above, which
 * fires only on the blocked case).
 */
function recordStepUpCheck(fresh: boolean, method: string = LOCAL_AUTH_METHOD): void {
  tracer
    .startSpan('auth.session.step_up_check', {
      attributes: { [METHOD_ATTRIBUTE]: method, [FRESHNESS_ATTRIBUTE]: fresh },
    })
    .end();
}

/**
 * The one freshness check: a lookup failure fails closed, exactly like
 * `./context-resolver.ts`'s own membership re-check (treated as "no fresh
 * verification" rather than allowing the operation through). Design Q51: a
 * user with an enrolled MFA factor needs a fresh `mfa` marker; a `password`
 * marker (or an unrecognized value) satisfies step-up only without MFA.
 */
async function isFresh(
  auth: AuthInstance,
  sessionToken: string,
  mfaEnrolled: boolean,
): Promise<boolean> {
  const factor = await contextOf(auth)
    .then((context) => currentFreshFactor(context.internalAdapter, sessionToken))
    .catch(() => null);
  return factor === 'mfa' || (factor === 'password' && !mfaEnrolled);
}

/** The slice of Better Auth's internal adapter the marker lookup needs. */
export interface StepUpMarkerReader {
  findVerificationValue(
    identifier: string,
  ): Promise<{ readonly expiresAt: Date; readonly value: string } | null>;
}

/**
 * The session's fresh marker factor, or `null` when absent, expired,
 * unrecognized or unreadable (fail closed). Exported so `./auth.ts`'s hook
 * reads markers exactly as the guard does.
 */
export async function currentFreshFactor(
  reader: StepUpMarkerReader,
  sessionToken: string,
): Promise<StepUpFactor | null> {
  const verification = await reader
    .findVerificationValue(stepUpVerificationIdentifier(sessionToken))
    .catch(() => null);
  if (verification === null || verification.expiresAt.getTime() <= Date.now()) {
    return null;
  }
  return verification.value === 'mfa' || verification.value === 'password'
    ? verification.value
    : null;
}

/**
 * Design D24 path (a): a session-level check for Better Auth's native
 * `/link-social` route, which no oRPC procedure wraps. Resolves when the
 * caller may proceed; rejects with `AuthStepUpError` when the caller has no fresh
 * verification (MFA, or password re-entry for a user without MFA, Q49), or no
 * valid session at all (fail closed). Reuses
 * the same freshness check as `createStepUpGuard`; no second implementation.
 */
export function createEnrolledStepUpCheck(
  options: StepUpGuardOptions,
): (headers: Headers) => Promise<void> {
  const api = apiOf(options.auth);
  return async (headers: Headers): Promise<void> => {
    const session = await api.getSession({ headers });
    if (session === null) {
      throw new AuthStepUpError();
    }
    // Q43, Q49: with or without MFA the caller needs the freshness marker, written
    // by a fresh MFA verification or, without MFA, a fresh password re-entry.
    if (
      !(await isFresh(options.auth, session.session.token, session.user?.twoFactorEnabled === true))
    ) {
      throw new AuthStepUpError();
    }
  };
}

export function createStepUpGuard(options: StepUpGuardOptions): StepUpGuard {
  const api = apiOf(options.auth);

  return async (params: AssertStepUpParams): Promise<void> => {
    // design D4: only `x-tayzu-risk: high` operations are gated at all.
    if (params.route.riskLevel !== 'high') {
      return;
    }
    // design D4: "agent/integration/system actors skip this guard entirely."
    if (params.actor.type !== 'user') {
      return;
    }

    function rejectStepUp(): never {
      emitStepUpRequired({
        tenantId: params.tenantId,
        actorId: params.actor.id,
        operation: params.operation,
      });
      throw new AuthStepUpError();
    }

    const session = await api.getSession({ headers: params.headers });
    if (session === null) {
      recordStepUpCheck(false);
      rejectStepUp();
    }
    const { ssoSid } = session.session;

    // design D25: a Visma-Connect-established session delegates step-up to
    // Visma Connect; `twoFactorVerifiedAt` is not consulted at all.
    if (typeof ssoSid === 'string' && ssoSid !== '') {
      const idToken = params.reauthorization?.idToken;
      const valid =
        idToken !== undefined &&
        options.sso !== undefined &&
        (await isValidReauthorization(idToken, {
          discoveryUrl: options.sso.discoveryUrl,
          clientId: options.sso.clientId,
          sid: ssoSid,
        }));
      recordStepUpCheck(valid, VISMA_CONNECT_AUTH_METHOD);
      if (!valid) {
        if (idToken === undefined) {
          // No re-authorization returned yet: the caller must initiate one.
          rejectStepUp();
        }
        emitStepUpInsufficient({ tenantId: params.tenantId, actorId: params.actor.id });
        throw new AuthStepUpError();
      }
      return;
    }
    const sessionToken = session.session.token;

    const fresh = await isFresh(
      options.auth,
      sessionToken,
      session.user?.twoFactorEnabled === true,
    );
    recordStepUpCheck(fresh);

    if (!fresh) {
      rejectStepUp();
    }
  };
}
