/**
 * Assumed API of `./context.js` (task 2.2):
 *
 * ```ts
 * type ActorType = 'user' | 'agent' | 'integration' | 'system';
 * interface Principal { type: ActorType; id: string }
 * interface CatalogContext { tenantId: string; actor: Principal & { onBehalfOf?: Principal } }
 *
 * function parseCatalogContext(input: unknown): CatalogContext;
 * ```
 *
 * `parseCatalogContext` fails closed: any deviation from the spec Conventions
 * rules throws `CatalogError('CATALOG_CONTEXT_REQUIRED', ..., { details: {
 * reason: 'missing_tenant' | 'invalid_actor' } })`. `reason` is
 * `'missing_tenant'` whenever `tenantId` is absent or does not match
 * `^[A-Za-z0-9_-]{1,64}$`, and `'invalid_actor'` whenever `actor` (or a given
 * `actor.onBehalfOf`) is absent, has an unknown `type`, or has an `id` that
 * does not match `^[A-Za-z0-9_.:-]{1,128}$`. This mirrors the
 * `tayzu.catalog.context.reason` metric attribute in design D3 / the
 * Observability contract.
 *
 * On success the function returns the parsed `CatalogContext`, unchanged in
 * shape (no defaulting, no extra fields invented).
 */
import { describe, expect, it } from 'vitest';
import { parseCatalogContext } from './context.js';
import { isCatalogError } from './errors.js';

function expectContextRejected(input: unknown, reason: 'missing_tenant' | 'invalid_actor'): void {
  try {
    parseCatalogContext(input);
    expect.unreachable('parseCatalogContext should have thrown');
  } catch (error) {
    expect(isCatalogError(error)).toBe(true);
    if (!isCatalogError(error)) throw error;
    expect(error.code).toBe('CATALOG_CONTEXT_REQUIRED');
    expect(error.details).toMatchObject({ reason });
  }
}

const VALID_TENANT_ID = 't1';
const VALID_ACTOR = { type: 'user', id: 'alice' };

describe('parseCatalogContext', () => {
  it('accepts a well-formed context unchanged', () => {
    const input = { tenantId: VALID_TENANT_ID, actor: VALID_ACTOR };

    const context = parseCatalogContext(input);

    expect(context).toEqual({ tenantId: VALID_TENANT_ID, actor: VALID_ACTOR });
  });

  it('accepts a well-formed onBehalfOf principal', () => {
    const input = {
      tenantId: VALID_TENANT_ID,
      actor: { type: 'agent', id: 'agent-1', onBehalfOf: { type: 'user', id: 'alice' } },
    };

    const context = parseCatalogContext(input);

    expect(context.actor.onBehalfOf).toEqual({ type: 'user', id: 'alice' });
  });

  it('"Operation without tenant context is rejected": fails with CATALOG_CONTEXT_REQUIRED, reason missing_tenant', () => {
    expectContextRejected({ actor: VALID_ACTOR }, 'missing_tenant');
  });

  it('"Unknown actor type is rejected": fails with CATALOG_CONTEXT_REQUIRED, reason invalid_actor', () => {
    expectContextRejected(
      { tenantId: VALID_TENANT_ID, actor: { type: 'robot', id: 'x' } },
      'invalid_actor',
    );
  });

  it('"Malformed tenant or actor ID is rejected": a malformed tenantId is missing_tenant', () => {
    expectContextRejected({ tenantId: "x'; --", actor: VALID_ACTOR }, 'missing_tenant');
  });

  it('"Malformed tenant or actor ID is rejected": a malformed actor id is invalid_actor', () => {
    expectContextRejected(
      { tenantId: VALID_TENANT_ID, actor: { type: 'user', id: 'alice@example.com' } },
      'invalid_actor',
    );
  });

  it('rejects an empty actor id', () => {
    expectContextRejected(
      { tenantId: VALID_TENANT_ID, actor: { type: 'user', id: '' } },
      'invalid_actor',
    );
  });

  it('rejects a 65-character tenantId', () => {
    const tenantId = 'a'.repeat(65);

    expectContextRejected({ tenantId, actor: VALID_ACTOR }, 'missing_tenant');
  });

  it('accepts a 64-character tenantId', () => {
    const tenantId = 'a'.repeat(64);

    const context = parseCatalogContext({ tenantId, actor: VALID_ACTOR });

    expect(context.tenantId).toBe(tenantId);
  });

  it('rejects an invalid onBehalfOf principal', () => {
    expectContextRejected(
      {
        tenantId: VALID_TENANT_ID,
        actor: { type: 'agent', id: 'agent-1', onBehalfOf: { type: 'robot', id: 'x' } },
      },
      'invalid_actor',
    );
  });

  it('rejects a missing actor entirely', () => {
    expectContextRejected({ tenantId: VALID_TENANT_ID }, 'invalid_actor');
  });

  it('rejects a null or undefined context with CATALOG_CONTEXT_REQUIRED', () => {
    for (const input of [null, undefined]) {
      try {
        parseCatalogContext(input);
        expect.unreachable('parseCatalogContext should have thrown');
      } catch (error) {
        expect(isCatalogError(error)).toBe(true);
        if (!isCatalogError(error)) throw error;
        expect(error.code).toBe('CATALOG_CONTEXT_REQUIRED');
      }
    }
  });
});
