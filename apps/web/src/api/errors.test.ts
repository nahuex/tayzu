/**
 * The error model of the web app (task 5.2, design D4 and D15; scenario "An
 * internal error shows no server text").
 *
 * Every failure, from an oRPC catalog call or from a plain route (Better
 * Auth, the accept and reset routes, `GET /v1/me`), becomes one value of a
 * closed set of kinds. Only the kind, the issue paths, the reference-violation
 * referrers and count, the step-up `reauthorizationUrl` and `Retry-After` are
 * kept; the server's `message` never is, except a password-policy rule name on
 * `/newPassword` (reset confirm) or `/password` (invitation accept), which is
 * kept as a rule id for the UI to localize (task 5.5).
 *
 * Assumed API of `./errors.js`:
 *
 * ```ts
 * export const API_ERROR_KINDS: readonly [
 *   'unauthenticated', 'forbidden', 'not_found', 'step_up_required', 'validation',
 *   'reference_violation', 'rate_limited', 'conflict', 'server',
 * ];
 * export type ApiErrorKind = (typeof API_ERROR_KINDS)[number];
 *
 * // The rule names of `@tayzu/auth`'s password policy, plus the breach check.
 * export type PasswordRule =
 *   | 'length' | 'uppercase' | 'lowercase' | 'digit' | 'symbol' | 'character'
 *   | 'denylist' | 'breached';
 *
 * export interface ValidationIssue {
 *   readonly path: string;          // the JSON Pointer, as the server sent it
 *   readonly rule?: PasswordRule;   // only on /newPassword or /password, only a known rule
 * }
 *
 * export type ApiError =
 *   | { readonly kind: 'unauthenticated' }
 *   | { readonly kind: 'forbidden' }
 *   | { readonly kind: 'not_found' }
 *   | { readonly kind: 'step_up_required'; readonly reauthorizationUrl?: string }
 *   | { readonly kind: 'validation'; readonly issues: readonly ValidationIssue[] }
 *   | {
 *       readonly kind: 'reference_violation';
 *       readonly referrers: readonly string[]; // [] when the server names none
 *       readonly notVisible: number;           // 0 when the server sends no count
 *     }
 *   | { readonly kind: 'rate_limited'; readonly retryAfterSeconds?: number }
 *   | { readonly kind: 'conflict' }
 *   | { readonly kind: 'server' };
 *
 * // Anything an oRPC call (or a `fetch`) rejects with: an `ORPCError` from
 * // `@orpc/client`, a network `TypeError`, or any other value (-> `server`).
 * export function toApiError(error: unknown): ApiError;
 *
 * // A plain route's non-2xx `Response`, body not yet read. Reads the JSON body
 * // (an `ORPCError#toJSON()` body or Better Auth's `{ code, message }`) and the
 * // `Retry-After` header (delta-seconds). A body that is not JSON maps by status.
 * export function apiErrorFromResponse(response: Response): Promise<ApiError>;
 * ```
 *
 * The oRPC fixtures go through the real `createApiClient` with a fake `fetch`
 * answering the server's wire bodies (`ORPCError#toJSON()`, as `apps/api`'s
 * `toOrpcError` and its limiters send them), so the test sees exactly what the
 * client rejects with. Every server message carries `MARKER`, and no mapped
 * model may contain it.
 */
import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';

import { createApiClient } from './client.js';
import { API_ERROR_KINDS, apiErrorFromResponse, toApiError, type ApiError } from './errors.js';

const MARKER = 'SERVER-TEXT-MARKER-7f3a';

/** The server's error body: `ORPCError#toJSON()`, as `apps/api` sends it. */
function errorBody(code: string, status: number, data?: unknown): Record<string, unknown> {
  const message = `${MARKER} ${code}`;
  const error =
    data === undefined
      ? new ORPCError(code, { status, message })
      : new ORPCError(code, { status, message, data });
  return JSON.parse(JSON.stringify(error.toJSON())) as Record<string, unknown>;
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** What the oRPC client rejects with when the server answers `respond()`. */
async function catalogRejection(respond: () => Promise<Response>): Promise<unknown> {
  const client = createApiClient({ fetch: respond });
  try {
    await client.entities.get({ blueprint: 'service', entity: 'checkout' });
  } catch (error) {
    return error;
  }
  throw new Error('expected the catalog call to fail');
}

async function mapCatalogAnswer(response: Response): Promise<ApiError> {
  return toApiError(await catalogRejection(() => Promise.resolve(response)));
}

function expectNoServerText(model: ApiError): void {
  expect(JSON.stringify(model)).not.toContain(MARKER);
}

describe('the error model (design D4)', () => {
  it('has exactly the closed set of kinds', () => {
    expect([...API_ERROR_KINDS].sort()).toEqual(
      [
        'conflict',
        'forbidden',
        'not_found',
        'rate_limited',
        'reference_violation',
        'server',
        'step_up_required',
        'unauthenticated',
        'validation',
      ].sort(),
    );
  });

  describe('oRPC catalog calls', () => {
    it('maps CATALOG_CONTEXT_REQUIRED (401) to unauthenticated', async () => {
      const model = await mapCatalogAnswer(
        jsonResponse(401, errorBody('CATALOG_CONTEXT_REQUIRED', 401)),
      );
      expect(model).toEqual({ kind: 'unauthenticated' });
      expectNoServerText(model);
    });

    it('maps AUTH_FORBIDDEN (403) to forbidden', async () => {
      const model = await mapCatalogAnswer(jsonResponse(403, errorBody('AUTH_FORBIDDEN', 403)));
      expect(model).toEqual({ kind: 'forbidden' });
      expectNoServerText(model);
    });

    it('maps CATALOG_NOT_FOUND (404, also every cross-tenant answer) to not_found', async () => {
      const model = await mapCatalogAnswer(
        jsonResponse(404, errorBody('CATALOG_NOT_FOUND', 404, {})),
      );
      expect(model).toEqual({ kind: 'not_found' });
      expectNoServerText(model);
    });

    it('maps AUTH_STEP_UP_REQUIRED (403) with a reauthorizationUrl to step_up_required, keeping the URL', async () => {
      const reauthorizationUrl =
        'https://connect.visma.com/connect/authorize?client_id=tayzu&state=abc123&prompt=login';
      const model = await mapCatalogAnswer(
        jsonResponse(403, errorBody('AUTH_STEP_UP_REQUIRED', 403, { reauthorizationUrl })),
      );
      expect(model).toEqual({ kind: 'step_up_required', reauthorizationUrl });
      expectNoServerText(model);
    });

    it('maps AUTH_STEP_UP_REQUIRED (403) without data to step_up_required with no URL', async () => {
      const model = await mapCatalogAnswer(
        jsonResponse(403, errorBody('AUTH_STEP_UP_REQUIRED', 403)),
      );
      expect(model).toEqual({ kind: 'step_up_required' });
      expectNoServerText(model);
    });

    it('A validation answer is rendered by path only: CATALOG_VALIDATION_FAILED keeps the issue paths and drops every message', async () => {
      const model = await mapCatalogAnswer(
        jsonResponse(
          400,
          errorBody('CATALOG_VALIDATION_FAILED', 400, {
            issues: [
              { path: '/spec/properties/port', message: `${MARKER} must be integer` },
              { path: '/title', message: `${MARKER} Invalid value` },
            ],
          }),
        ),
      );
      expect(model).toEqual({
        kind: 'validation',
        issues: [{ path: '/spec/properties/port' }, { path: '/title' }],
      });
      expectNoServerText(model);
    });

    it('maps CATALOG_REFERENCE_VIOLATION (422) to reference_violation, keeping the referrers and the not-visible count', async () => {
      const model = await mapCatalogAnswer(
        jsonResponse(
          422,
          errorBody('CATALOG_REFERENCE_VIOLATION', 422, {
            details: { referrers: ['checkout', 'payments'], notVisible: 3 },
          }),
        ),
      );
      expect(model).toEqual({
        kind: 'reference_violation',
        referrers: ['checkout', 'payments'],
        notVisible: 3,
      });
      expectNoServerText(model);
    });

    it('maps CATALOG_REFERENCE_VIOLATION with every referrer visible to a not-visible count of 0', async () => {
      const model = await mapCatalogAnswer(
        jsonResponse(
          422,
          errorBody('CATALOG_REFERENCE_VIOLATION', 422, { details: { referrers: ['checkout'] } }),
        ),
      );
      expect(model).toEqual({
        kind: 'reference_violation',
        referrers: ['checkout'],
        notVisible: 0,
      });
      expectNoServerText(model);
    });

    it('maps CATALOG_REFERENCE_VIOLATION without details to no referrers and a count of 0', async () => {
      const model = await mapCatalogAnswer(
        jsonResponse(422, errorBody('CATALOG_REFERENCE_VIOLATION', 422, {})),
      );
      expect(model).toEqual({ kind: 'reference_violation', referrers: [], notVisible: 0 });
      expectNoServerText(model);
    });

    it('maps AUTH_RATE_LIMITED (429) to rate_limited', async () => {
      const model = await mapCatalogAnswer(
        jsonResponse(429, errorBody('AUTH_RATE_LIMITED', 429), { 'retry-after': '30' }),
      );
      expect(model).toMatchObject({ kind: 'rate_limited' });
      expectNoServerText(model);
    });

    it("maps the per-principal limiter's 429 body (with its extra statusCode field) to rate_limited", async () => {
      const model = await mapCatalogAnswer(
        jsonResponse(429, { ...errorBody('AUTH_RATE_LIMITED', 429), statusCode: 429 }),
      );
      expect(model).toMatchObject({ kind: 'rate_limited' });
      expectNoServerText(model);
    });

    it.each(['CATALOG_ALREADY_EXISTS', 'CATALOG_VERSION_CONFLICT'])(
      'maps %s (409) to conflict',
      async (code) => {
        const model = await mapCatalogAnswer(jsonResponse(409, errorBody(code, 409, {})));
        expect(model).toEqual({ kind: 'conflict' });
        expectNoServerText(model);
      },
    );

    it('maps CATALOG_SCHEMA_INCOMPATIBLE (409) to conflict', async () => {
      const model = await mapCatalogAnswer(
        jsonResponse(
          409,
          errorBody('CATALOG_SCHEMA_INCOMPATIBLE', 409, {
            details: { violations: [], notVisible: 1 },
          }),
        ),
      );
      expect(model).toMatchObject({ kind: 'conflict' });
      expectNoServerText(model);
    });

    it.each([
      ['CATALOG_LIMIT_EXCEEDED', 422, { details: { limit: 'search.maxLimit' } }],
      ['CATALOG_RESERVED_IDENTIFIER', 403, {}],
    ] as const)(
      'maps %s to a kind of the closed set, with no server text',
      async (code, status, data) => {
        const model = await mapCatalogAnswer(jsonResponse(status, errorBody(code, status, data)));
        expect(API_ERROR_KINDS).toContain(model.kind);
        expectNoServerText(model);
      },
    );

    it('maps an unknown code to server', async () => {
      const model = await mapCatalogAnswer(
        jsonResponse(400, errorBody('SOMETHING_NEW', 400, { detail: MARKER })),
      );
      expect(model).toEqual({ kind: 'server' });
      expectNoServerText(model);
    });

    it('maps a malformed error answer (a proxy page, not an oRPC error) to server', async () => {
      const model = await mapCatalogAnswer(
        new Response(`<html><body>${MARKER} Bad Gateway</body></html>`, {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
      );
      expect(model).toEqual({ kind: 'server' });
      expectNoServerText(model);
    });

    it('maps a network failure to server', async () => {
      const rejection = await catalogRejection(() =>
        Promise.reject(new TypeError(`${MARKER} Failed to fetch`)),
      );
      const model = toApiError(rejection);
      expect(model).toEqual({ kind: 'server' });
      expectNoServerText(model);
    });

    describe('Scenario: An internal error shows no server text', () => {
      it('GIVEN the API answers a call with INTERNAL and a message, WHEN the failure is mapped, THEN the model is the generic server kind and holds no part of the message', async () => {
        const model = await mapCatalogAnswer(
          jsonResponse(500, errorBody('INTERNAL', 500, { detail: `${MARKER} in data` })),
        );
        expect(model).toEqual({ kind: 'server' });
        expectNoServerText(model);
      });
    });
  });

  describe('values that are not answers of the API', () => {
    it.each([
      ['a plain Error', new Error(`${MARKER} boom`)],
      ['a string', `${MARKER} boom`],
      ['undefined', undefined],
      ['null', null],
      [
        'an object with a known code that is not an ORPCError',
        { code: 'CATALOG_NOT_FOUND', message: MARKER },
      ],
    ])('maps %s to server', (_name, thrown) => {
      const model = toApiError(thrown);
      expect(model).toEqual({ kind: 'server' });
      expectNoServerText(model);
    });
  });

  describe('plain routes (Better Auth, accept, reset confirm)', () => {
    it("maps Better Auth's 401 sign-in failure to unauthenticated", async () => {
      const model = await apiErrorFromResponse(
        jsonResponse(401, {
          code: 'INVALID_EMAIL_OR_PASSWORD',
          message: `${MARKER} Invalid email or password`,
        }),
      );
      expect(model).toEqual({ kind: 'unauthenticated' });
      expectNoServerText(model);
    });

    it('maps the uniform 401 of GET /v1/me (CATALOG_CONTEXT_REQUIRED) to unauthenticated', async () => {
      const model = await apiErrorFromResponse(
        jsonResponse(401, errorBody('CATALOG_CONTEXT_REQUIRED', 401)),
      );
      expect(model).toEqual({ kind: 'unauthenticated' });
      expectNoServerText(model);
    });

    it("maps the reset confirm's uniform 404 to not_found", async () => {
      const model = await apiErrorFromResponse(
        jsonResponse(404, errorBody('CATALOG_NOT_FOUND', 404)),
      );
      expect(model).toEqual({ kind: 'not_found' });
      expectNoServerText(model);
    });

    it('maps AUTH_STEP_UP_REQUIRED on the reset confirm (no data) to step_up_required with no URL', async () => {
      const model = await apiErrorFromResponse(
        jsonResponse(403, errorBody('AUTH_STEP_UP_REQUIRED', 403)),
      );
      expect(model).toEqual({ kind: 'step_up_required' });
      expectNoServerText(model);
    });

    it("maps the accept route's AUTH_STEP_UP_REQUIRED with a reauthorizationUrl, keeping the URL", async () => {
      const reauthorizationUrl = 'https://connect.visma.com/connect/authorize?state=xyz';
      const model = await apiErrorFromResponse(
        jsonResponse(403, errorBody('AUTH_STEP_UP_REQUIRED', 403, { reauthorizationUrl })),
      );
      expect(model).toEqual({ kind: 'step_up_required', reauthorizationUrl });
      expectNoServerText(model);
    });

    it("maps Better Auth's AUTH_STEP_UP_REQUIRED ({ code, message }) to step_up_required", async () => {
      const model = await apiErrorFromResponse(
        jsonResponse(403, {
          code: 'AUTH_STEP_UP_REQUIRED',
          message: `${MARKER} AUTH_STEP_UP_REQUIRED`,
        }),
      );
      expect(model).toEqual({ kind: 'step_up_required' });
      expectNoServerText(model);
    });

    it('maps AUTH_RATE_LIMITED (429) of the accept and reset limiter to rate_limited, keeping Retry-After', async () => {
      const model = await apiErrorFromResponse(
        jsonResponse(429, errorBody('AUTH_RATE_LIMITED', 429), { 'retry-after': '42' }),
      );
      expect(model).toEqual({ kind: 'rate_limited', retryAfterSeconds: 42 });
      expectNoServerText(model);
    });

    it("maps the pre-auth limiter's AUTH_RATE_LIMITED ({ code, message }) on sign-in to rate_limited, keeping Retry-After", async () => {
      const model = await apiErrorFromResponse(
        jsonResponse(
          429,
          { code: 'AUTH_RATE_LIMITED', message: `${MARKER} Too many attempts. Try again later.` },
          { 'retry-after': '30' },
        ),
      );
      expect(model).toEqual({ kind: 'rate_limited', retryAfterSeconds: 30 });
      expectNoServerText(model);
    });

    it('maps AUTH_RATE_LIMITED without Retry-After to rate_limited with no delay', async () => {
      const model = await apiErrorFromResponse(
        jsonResponse(429, errorBody('AUTH_RATE_LIMITED', 429)),
      );
      expect(model).toEqual({ kind: 'rate_limited' });
      expectNoServerText(model);
    });

    describe('password-policy rules', () => {
      const RULES = [
        'length',
        'uppercase',
        'lowercase',
        'digit',
        'symbol',
        'character',
        'denylist',
        'breached',
      ] as const;

      it.each(RULES)(
        'A password-policy rule is mapped: rule %s on /newPassword (reset confirm) is kept as its rule id',
        async (rule) => {
          const model = await apiErrorFromResponse(
            jsonResponse(
              400,
              errorBody('CATALOG_VALIDATION_FAILED', 400, {
                issues: [{ path: '/newPassword', message: rule }],
              }),
            ),
          );
          expect(model).toEqual({ kind: 'validation', issues: [{ path: '/newPassword', rule }] });
          expectNoServerText(model);
        },
      );

      it.each(RULES)(
        'A password-policy rule is mapped: rule %s on /password (invitation accept) is kept as its rule id',
        async (rule) => {
          const model = await apiErrorFromResponse(
            jsonResponse(
              400,
              errorBody('CATALOG_VALIDATION_FAILED', 400, {
                issues: [{ path: '/password', message: rule }],
              }),
            ),
          );
          expect(model).toEqual({ kind: 'validation', issues: [{ path: '/password', rule }] });
          expectNoServerText(model);
        },
      );

      it('An unknown rule is shown as the generic message: the issue keeps its path and no rule', async () => {
        const unknownRule = `${MARKER}-entropy`;
        const model = await apiErrorFromResponse(
          jsonResponse(
            400,
            errorBody('CATALOG_VALIDATION_FAILED', 400, {
              issues: [{ path: '/newPassword', message: unknownRule }],
            }),
          ),
        );
        expect(model).toEqual({ kind: 'validation', issues: [{ path: '/newPassword' }] });
        expectNoServerText(model);
      });

      it('A rule name on any other path is not kept: the issue keeps its path only', async () => {
        const model = await apiErrorFromResponse(
          jsonResponse(
            400,
            errorBody('CATALOG_VALIDATION_FAILED', 400, {
              issues: [
                { path: '/token', message: 'length' },
                { path: '/newPassword/0', message: 'digit' },
              ],
            }),
          ),
        );
        expect(model).toEqual({
          kind: 'validation',
          issues: [{ path: '/token' }, { path: '/newPassword/0' }],
        });
      });
    });

    it('maps an unknown code to server', async () => {
      const model = await apiErrorFromResponse(
        jsonResponse(400, {
          code: 'TRUST_DEVICE_NOT_SUPPORTED',
          message: `${MARKER} not supported`,
        }),
      );
      expect(model).toEqual({ kind: 'server' });
      expectNoServerText(model);
    });

    it('maps a body that is not JSON to server', async () => {
      const model = await apiErrorFromResponse(
        new Response(`<html>${MARKER}</html>`, {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
      );
      expect(model).toEqual({ kind: 'server' });
      expectNoServerText(model);
    });

    describe('Scenario: An internal error shows no server text', () => {
      it('GIVEN a plain route answers INTERNAL and a message, WHEN the failure is mapped, THEN the model is the generic server kind and holds no part of the message', async () => {
        const model = await apiErrorFromResponse(
          jsonResponse(500, errorBody('INTERNAL', 500, { detail: `${MARKER} in data` })),
        );
        expect(model).toEqual({ kind: 'server' });
        expectNoServerText(model);
      });
    });
  });
});
