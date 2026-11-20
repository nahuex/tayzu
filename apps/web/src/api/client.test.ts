/**
 * The oRPC client of the web app (task 5.1, design D4 and Q36; scenario "A
 * mutating call carries the CSRF header and no tenant").
 *
 * Assumed API of `./client.js`:
 *
 * ```ts
 * import type { ContractRouterClient } from '@orpc/contract';
 * import type { catalogContract } from '@tayzu/catalog/contract';
 *
 * export type ApiClient = ContractRouterClient<typeof catalogContract>;
 *
 * export interface ApiClientOptions {
 *   // Defaults to the global `fetch`. The link calls it with the final
 *   // `Request`; any second argument is applied on top of that request.
 *   readonly fetch?: (request: Request, init?: RequestInit) => Promise<Response>;
 * }
 *
 * // `OpenAPILink` over `catalogContract`, `url: window.location.origin`,
 * // `SimpleCsrfProtectionLinkPlugin`, and path parameters sent with
 * // `encodeURIComponent` and then `%40`, `%3A` and `%3D` turned back into
 * // `@`, `:` and `=`.
 * export function createApiClient(options?: ApiClientOptions): ApiClient;
 * ```
 *
 * The fake `fetch` rebuilds the effective request (`new Request(request,
 * init)`), so whatever the client sends, through the request or the second
 * argument, is what the assertions see.
 */
import { describe, expect, it } from 'vitest';

import { createApiClient } from './client.js';

interface RecordedRequest {
  readonly request: Request;
  readonly url: URL;
  readonly body: string;
}

function createFakeFetch(respond: () => Response) {
  const calls: RecordedRequest[] = [];
  const fetch = async (input: Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    calls.push({ request, url: new URL(request.url), body: await request.clone().text() });
    return respond();
  };
  return { fetch, calls };
}

function onlyCall(calls: readonly RecordedRequest[]): RecordedRequest {
  expect(calls).toHaveLength(1);
  const [call] = calls;
  if (call === undefined) throw new Error('expected one recorded request');
  return call;
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

function emptyList(): Response {
  return Response.json({ items: [] });
}

function anEntity(): Response {
  return Response.json({
    blueprint: 'service',
    identifier: 'team@example.com:prod=1',
    title: 'Team',
    spec: { properties: {}, relations: {} },
    status: null,
    generation: 1,
    version: 1,
    createdAt: '2026-11-20T00:00:00.000Z',
    createdBy: { type: 'user', id: 'u1' },
    updatedAt: '2026-11-20T00:00:00.000Z',
    updatedBy: { type: 'user', id: 'u1' },
  });
}

function headerNames(request: Request): string[] {
  return [...request.headers.keys()];
}

function expectNoTenant(call: RecordedRequest): void {
  expect(headerNames(call.request).filter((name) => /tenant/i.test(name))).toEqual([]);
  expect([...call.url.searchParams.keys()].filter((key) => /tenant/i.test(key))).toEqual([]);
  expect(call.url.pathname).not.toMatch(/tenant/i);
  expect(call.body).not.toMatch(/tenant/i);
}

function expectBrowserOwnedCredentials(call: RecordedRequest): void {
  expect(call.request.credentials).toBe('same-origin');
  expect(call.request.headers.has('authorization')).toBe(false);
  expect(call.request.headers.has('cookie')).toBe(false);
}

describe('createApiClient', () => {
  describe('A mutating call carries the CSRF header and no tenant', () => {
    it('sends entities.delete as DELETE with x-csrf-token: orpc and no tenant field, header or parameter', async () => {
      const { fetch, calls } = createFakeFetch(noContent);
      const client = createApiClient({ fetch });

      await client.entities.delete({
        params: { blueprint: 'service', entity: 'checkout' },
        query: { detachReferences: true },
      });

      const call = onlyCall(calls);
      expect(call.request.method).toBe('DELETE');
      expect(call.url.origin).toBe(window.location.origin);
      expect(call.url.pathname).toBe('/v1/blueprints/service/entities/checkout');
      expect([...call.url.searchParams.keys()]).toEqual(['detachReferences']);
      expect(call.url.searchParams.get('detachReferences')).toBe('true');
      expect(call.request.headers.get('x-csrf-token')).toBe('orpc');
      expectNoTenant(call);
      expect(call.body).toBe('');
    });

    it('sends the cookie through the browser only: credentials stay same-origin, with no Authorization or Cookie header', async () => {
      const { fetch, calls } = createFakeFetch(noContent);
      const client = createApiClient({ fetch });

      await client.entities.delete({
        params: { blueprint: 'service', entity: 'checkout' },
        query: {},
      });

      expectBrowserOwnedCredentials(onlyCall(calls));
    });
  });

  describe('entities.list', () => {
    it('requests the REST path with sort, order, cursor and pageSize in the query and the blueprint only in the path', async () => {
      const { fetch, calls } = createFakeFetch(emptyList);
      const client = createApiClient({ fetch });

      const result = await client.entities.list({
        blueprint: 'service',
        sort: 'updatedAt',
        order: 'desc',
        cursor: 'eyJrIjoiYSJ9==',
        pageSize: 25,
      });

      expect(result).toEqual({ items: [] });
      const call = onlyCall(calls);
      expect(call.request.method).toBe('GET');
      expect(call.url.origin).toBe(window.location.origin);
      expect(call.url.pathname).toBe('/v1/blueprints/service/entities');
      expect([...call.url.searchParams.keys()].sort()).toEqual([
        'cursor',
        'order',
        'pageSize',
        'sort',
      ]);
      expect(call.url.searchParams.get('sort')).toBe('updatedAt');
      expect(call.url.searchParams.get('order')).toBe('desc');
      expect(call.url.searchParams.get('cursor')).toBe('eyJrIjoiYSJ9==');
      expect(call.url.searchParams.get('pageSize')).toBe('25');
      expect(call.body).toBe('');
      expectNoTenant(call);
    });

    it('leaves credentials at same-origin and sends no Authorization header', async () => {
      const { fetch, calls } = createFakeFetch(emptyList);
      const client = createApiClient({ fetch });

      await client.entities.list({ blueprint: 'service', sort: 'title', cursor: 'next' });

      expectBrowserOwnedCredentials(onlyCall(calls));
    });
  });

  describe('path parameters (Q36)', () => {
    it('requests the entity team@example.com:prod=1 with no % in its path', async () => {
      const { fetch, calls } = createFakeFetch(anEntity);
      const client = createApiClient({ fetch });

      await client.entities.get({ blueprint: 'service', entity: 'team@example.com:prod=1' });

      const call = onlyCall(calls);
      expect(call.request.method).toBe('GET');
      expect(call.url.origin).toBe(window.location.origin);
      expect(call.url.pathname).toBe('/v1/blueprints/service/entities/team@example.com:prod=1');
      expect(call.url.pathname).not.toContain('%');
      expect(call.request.url).not.toContain('%');
      expectBrowserOwnedCredentials(call);
    });

    it('deletes the entity team@example.com:prod=1 with no % in its path', async () => {
      const { fetch, calls } = createFakeFetch(noContent);
      const client = createApiClient({ fetch });

      await client.entities.delete({
        params: { blueprint: 'service', entity: 'team@example.com:prod=1' },
        query: {},
      });

      const call = onlyCall(calls);
      expect(call.request.method).toBe('DELETE');
      expect(call.url.pathname).toBe('/v1/blueprints/service/entities/team@example.com:prod=1');
      expect(call.request.url).not.toContain('%');
      expect(call.request.headers.get('x-csrf-token')).toBe('orpc');
    });

    it('keeps every other character percent-encoded, including a literal %', async () => {
      const { fetch, calls } = createFakeFetch(anEntity);
      const client = createApiClient({ fetch });

      await client.entities.get({ blueprint: 'service', entity: 'a b?c#d%40' });

      const call = onlyCall(calls);
      expect(call.url.pathname).toBe('/v1/blueprints/service/entities/a%20b%3Fc%23d%2540');
      expect(call.url.search).toBe('');
      expect(call.url.hash).toBe('');
    });
  });
});
