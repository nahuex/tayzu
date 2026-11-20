/**
 * The error model of the web app (design D4, D15, Q63).
 *
 * Every failure, from an oRPC catalog call or from a plain route (Better Auth,
 * the accept and reset routes, `GET /v1/me`), becomes one value of a closed
 * set of kinds. Only the kind, the issue paths, the reference-violation
 * referrers and count, the step-up `reauthorizationUrl` and `Retry-After` are
 * kept. The server's `message` never is, except a password-policy rule name on
 * `/newPassword` or `/password`, which is kept as a rule id for the UI to
 * localize. Better Auth's `/change-password` answers (Q63, Q73) become issues
 * too: its top-level `rule` on `/newPassword`, the breach check as the
 * `breached` rule, and a wrong current password on `/currentPassword`. Every
 * input is untrusted: types are checked before reading and only own properties
 * are read.
 */
import { ORPCError } from '@orpc/client';

export const API_ERROR_KINDS = [
  'unauthenticated',
  'forbidden',
  'not_found',
  'step_up_required',
  'validation',
  'reference_violation',
  'rate_limited',
  'conflict',
  'server',
] as const;

export type ApiErrorKind = (typeof API_ERROR_KINDS)[number];

/** The rule names of the server's password policy, plus the breach check. */
export type PasswordRule =
  'length' | 'uppercase' | 'lowercase' | 'digit' | 'symbol' | 'character' | 'denylist' | 'breached';

export interface ValidationIssue {
  /** The JSON Pointer, as the server sent it. */
  readonly path: string;
  /** Only on `/newPassword` or `/password`, and only a known rule. */
  readonly rule?: PasswordRule;
}

export type ApiError =
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'step_up_required'; readonly reauthorizationUrl?: string }
  | { readonly kind: 'validation'; readonly issues: readonly ValidationIssue[] }
  | {
      readonly kind: 'reference_violation';
      readonly referrers: readonly string[];
      readonly notVisible: number;
    }
  | { readonly kind: 'rate_limited'; readonly retryAfterSeconds?: number }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'server' };

const PASSWORD_RULES: ReadonlySet<string> = new Set<PasswordRule>([
  'length',
  'uppercase',
  'lowercase',
  'digit',
  'symbol',
  'character',
  'denylist',
  'breached',
]);

/** The issue paths whose message is a password-policy rule name. */
const PASSWORD_PATHS: ReadonlySet<string> = new Set(['/newPassword', '/password']);

/** A known password rule, else `undefined`: an unknown name is never kept. */
function passwordRuleOf(value: unknown): PasswordRule | undefined {
  return typeof value === 'string' && PASSWORD_RULES.has(value)
    ? (value as PasswordRule)
    : undefined;
}

/** Bounds the work spent on an answer; the server sends far fewer. */
const MAX_ISSUES = 100;
const MAX_REFERRERS = 100;

const SERVER: ApiError = { kind: 'server' };

/** Reads an own property of a plain object (not an array), or `undefined`. */
function own(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}

function ownArray(value: unknown, key: string): readonly unknown[] {
  const array = own(value, key);
  return Array.isArray(array) ? (array as unknown[]) : [];
}

/**
 * The step-up target the server sends: the identity provider's authorize URL
 * (absolute `http:` or `https:`), or an in-app path. Anything else is dropped.
 */
function reauthorizationUrlOf(data: unknown): string | undefined {
  const url = own(data, 'reauthorizationUrl');
  if (typeof url !== 'string') return undefined;
  if (url.startsWith('/') && !url.startsWith('//') && !url.startsWith('/\\')) return url;
  if (!URL.canParse(url)) return undefined;
  const { protocol } = new URL(url);
  return protocol === 'https:' || protocol === 'http:' ? url : undefined;
}

function issuesOf(data: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const issue of ownArray(data, 'issues').slice(0, MAX_ISSUES)) {
    const path = own(issue, 'path');
    if (typeof path !== 'string') continue;
    const message = own(issue, 'message');
    const rule = PASSWORD_PATHS.has(path) ? passwordRuleOf(message) : undefined;
    issues.push(rule === undefined ? { path } : { path, rule });
  }
  return issues;
}

function referenceViolationOf(data: unknown): ApiError {
  const details = own(data, 'details');
  const referrers = ownArray(details, 'referrers')
    .slice(0, MAX_REFERRERS)
    .filter((referrer): referrer is string => typeof referrer === 'string');
  const count = own(details, 'notVisible');
  const notVisible =
    typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : 0;
  return { kind: 'reference_violation', referrers, notVisible };
}

/** One validation issue on `path`, with `rule` when it is a known password rule. */
function passwordIssue(path: string, rule: unknown): ApiError {
  const known = passwordRuleOf(rule);
  return { kind: 'validation', issues: [known === undefined ? { path } : { path, rule: known }] };
}

/**
 * Maps an error code, its `data` and the whole `body` to a kind; an unknown code is
 * `server`. `body` is a plain route's answer, where Better Auth puts its `rule`.
 */
function fromCode(code: unknown, data: unknown, body?: unknown): ApiError {
  switch (code) {
    case 'AUTH_FORBIDDEN':
    case 'CATALOG_RESERVED_IDENTIFIER':
      return { kind: 'forbidden' };
    case 'CATALOG_NOT_FOUND':
      return { kind: 'not_found' };
    case 'AUTH_STEP_UP_REQUIRED': {
      const reauthorizationUrl = reauthorizationUrlOf(data);
      return reauthorizationUrl === undefined
        ? { kind: 'step_up_required' }
        : { kind: 'step_up_required', reauthorizationUrl };
    }
    case 'CATALOG_VALIDATION_FAILED':
    case 'CATALOG_LIMIT_EXCEEDED':
      return { kind: 'validation', issues: issuesOf(data) };
    case 'CATALOG_REFERENCE_VIOLATION':
      return referenceViolationOf(data);
    case 'PASSWORD_POLICY_VIOLATION':
      return passwordIssue('/newPassword', own(body, 'rule'));
    case 'PASSWORD_COMPROMISED':
      return passwordIssue('/newPassword', 'breached');
    case 'INVALID_PASSWORD':
      return passwordIssue('/currentPassword', undefined);
    case 'AUTH_RATE_LIMITED':
      return { kind: 'rate_limited' };
    case 'CATALOG_ALREADY_EXISTS':
    case 'CATALOG_VERSION_CONFLICT':
    case 'CATALOG_SCHEMA_INCOMPATIBLE':
      return { kind: 'conflict' };
    default:
      return SERVER;
  }
}

/** A status that decides the kind whatever the body says. */
function fromStatus(status: unknown): ApiError | undefined {
  if (status === 401) return { kind: 'unauthenticated' };
  if (status === 429) return { kind: 'rate_limited' };
  return undefined;
}

/**
 * Maps what an oRPC call (or a `fetch`) rejects with. Only an `ORPCError` is
 * an answer of the API; a network `TypeError` or any other value is `server`.
 * An `ORPCError` carries no headers, so `retryAfterSeconds` is never set here.
 */
export function toApiError(error: unknown): ApiError {
  if (!(error instanceof ORPCError)) return SERVER;
  const { code, status, data } = error as ORPCError<string, unknown>;
  return fromStatus(status) ?? fromCode(code, data);
}

/** `Retry-After` as delta-seconds; an HTTP date or anything else is dropped. */
function retryAfterSecondsOf(headers: Headers): number | undefined {
  const value = headers.get('retry-after')?.trim();
  if (value === undefined || !/^\d{1,9}$/.test(value)) return undefined;
  return Number(value);
}

async function jsonBodyOf(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text()) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Maps a plain route's non-2xx `Response`, body not yet read: an
 * `ORPCError#toJSON()` body (`{ code, status, message, data }`) or Better
 * Auth's `{ code, message }`. A body that is not JSON maps by status alone.
 */
export async function apiErrorFromResponse(response: Response): Promise<ApiError> {
  if (response.status === 429) {
    const retryAfterSeconds = retryAfterSecondsOf(response.headers);
    return retryAfterSeconds === undefined
      ? { kind: 'rate_limited' }
      : { kind: 'rate_limited', retryAfterSeconds };
  }
  const byStatus = fromStatus(response.status);
  if (byStatus !== undefined) return byStatus;
  const body = await jsonBodyOf(response);
  return fromCode(own(body, 'code'), own(body, 'data'), body);
}
