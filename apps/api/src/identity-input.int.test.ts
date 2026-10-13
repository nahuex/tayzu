/**
 * Task 14.10 of openspec/changes/043-identity-lifecycle-and-org-admin (spec requirement
 * "Identity procedures parse untrusted input strictly", scenario "Hostile or oversized input is
 * rejected before any work"; design D10 "Input contract"; task 5.3d).
 *
 * Task 14.10 Verify: "`identity-input.int.test.ts` calls each of the thirteen procedures through
 * `createRouterClient` as an admin (the wrapper's role check comes before the input is parsed,
 * design D10, so any other caller would get `AUTH_FORBIDDEN` instead of a parse error) with a
 * `__proto__`, a `constructor` and a `prototype` key at depth 1 and 3, an undeclared field and an
 * over-length value, asserting `CATALOG_VALIDATION_FAILED` and no lookup or write, and fails when
 * a procedure of the router is missing from it."
 *
 * Scenario: WHEN any procedure receives a body with a `__proto__`, `constructor` or `prototype`
 * key at any depth, an undeclared field, or a value over its length limit, THEN it fails with
 * `CATALOG_VALIDATION_FAILED` before any lookup, and nothing is created or changed.
 *
 * ## Built from the router's own procedure list
 *
 * The procedures are found by walking the router `createIdentityRouter` returns (`isProcedure`),
 * keyed by dotted path. The completeness test fails when a procedure of the router has no entry in
 * `VALID_INPUT` (so a new procedure cannot be forgotten) and when `VALID_INPUT` names a procedure
 * the router no longer has.
 *
 * ## Harness
 *
 * The router is built over recording spies: the auth repository, the Better Auth API and internal
 * adapter, the app pool, the `_user` writer, the user lock and the email gate. Every one of them is
 * wired (so a procedure that fails closed on a missing option cannot pass for the wrong reason) and
 * every call to any of them is recorded; "no lookup or write" is that the record is empty. Cerbos
 * is the real container (`localhost:3593`); the caller is an `admin` of a fresh random tenant.
 * Depth convention as in `parse-input.test.ts`: depth 1 is a key directly inside a section
 * (`body`, `params` or `query`, whichever the procedure declares); depth 3 is two objects further
 * down (`body.nested.a.<key>`). Hostile keys are built as own properties (as `JSON.parse` does).
 *
 * ## Production symbols expected
 *
 * None new: `createIdentityRouter` (`./identity-router.js`), `parseIdentityInput`
 * (`./identity/parse-input.js`) behind it. Procedures whose target is resolved by the wrapper
 * (`{user}`, `{invitation}`, `{credential}` paths) must be refused before that resolution reaches
 * the auth repository, which is what the spec's "before any lookup" asks for.
 */
import { randomUUID } from 'node:crypto';

import { createRouterClient, isProcedure } from '@orpc/server';
import { createCerbosClient } from '@tayzu/authz';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';

import { createIdentityRouter } from './identity-router.js';
import type { AuthRepository } from './identity/auth-repository.js';
import type { EmailTenantGate } from './identity/email-tenant-gate.js';
import type { UserSyncAdapter } from './identity/user-sync-adapter.js';

const HOSTILE_KEYS = ['__proto__', 'constructor', 'prototype'] as const;
const SECTIONS = ['body', 'params', 'query'] as const;
type Section = (typeof SECTIONS)[number];

type Input = Partial<Record<Section, Record<string, unknown>>>;

/** A valid input per procedure of the router, by dotted path. */
const VALID_INPUT: Readonly<Record<string, () => Input>> = {
  'identity.users.create': () => ({
    body: { email: `input-${randomUUID()}@example.test`, name: 'Input Contract', role: 'member' },
  }),
  'identity.users.invite': () => ({
    body: { email: `input-${randomUUID()}@example.test`, role: 'member' },
  }),
  'identity.users.cancelInvitation': () => ({ params: { invitation: randomUUID() } }),
  'identity.users.resendInvitation': () => ({ params: { invitation: randomUUID() } }),
  'identity.users.linkSsoAccount': () => ({
    params: { user: `input-${randomUUID()}@example.test` },
    body: { subject: `sub-${randomUUID()}` },
  }),
  'identity.users.setStatus': () => ({
    params: { user: `input-${randomUUID()}@example.test` },
    body: { status: 'Disabled' },
  }),
  'identity.users.unlinkSsoAccount': () => ({
    params: { user: `input-${randomUUID()}@example.test` },
  }),
  'identity.credentials.create': () => ({ body: { name: 'Input check', kind: 'integration' } }),
  'identity.credentials.list': () => ({ query: {} }),
  'identity.credentials.rotate': () => ({ params: { credential: randomUUID() } }),
  'identity.credentials.revoke': () => ({ params: { credential: randomUUID() } }),
  'identity.serviceAccounts.create': () => ({
    body: { identifier: `svc-in-${randomUUID().slice(0, 8)}` },
  }),
  'identity.serviceAccounts.delete': () => ({
    params: { user: `svc-in-${randomUUID().slice(0, 8)}` },
  }),
};

/** Dotted paths of every procedure in a router tree. */
function procedurePaths(router: unknown, prefix = ''): string[] {
  if (isProcedure(router)) return [prefix];
  if (typeof router !== 'object' || router === null) return [];
  return Object.entries(router).flatMap(([key, child]) =>
    procedurePaths(child, prefix === '' ? key : `${prefix}.${key}`),
  );
}

/** A recording stand-in: any property is another stand-in, any call is recorded and answers `undefined`. */
function spy(path: string, calls: string[]): unknown {
  return new Proxy(function recorded() {}, {
    get: (_target, property) =>
      typeof property === 'symbol' || property === 'then'
        ? undefined
        : spy(`${path}.${property}`, calls),
    apply: () => {
      calls.push(path);
      return Promise.resolve(undefined);
    },
  });
}

/** The section a procedure declares: where the hostile and oversized values go. */
function sectionOf(input: Input): Section {
  const found = SECTIONS.find((section) => input[section] !== undefined);
  if (found === undefined) throw new Error('the valid input has no section');
  return found;
}

function withOwnKey(
  source: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...source };
  Object.defineProperty(copy, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return copy;
}

function withSection(input: Input, section: Section, value: Record<string, unknown>): Input {
  return { ...input, [section]: value };
}

describe('every identity procedure parses untrusted input strictly (task 14.10)', () => {
  const calls: string[] = [];
  let paths: readonly string[];
  let client: unknown;
  let context: Record<string, unknown>;

  beforeAll(() => {
    const router = createIdentityRouter({
      auth: { api: spy('auth.api', calls), $context: Promise.resolve(spy('auth.$context', calls)) },
      authz: createCerbosClient({ address: 'localhost:3593', tls: false }),
      authRepository: spy('authRepository', calls) as AuthRepository,
      withUserLock: (userId: string) => {
        calls.push('withUserLock');
        return Promise.reject(new Error(`unexpected lock of ${userId}`));
      },
      emailGate: spy('emailGate', calls) as EmailTenantGate,
      invitationLinkBaseUrl: 'https://app.tayzu.test',
      appPool: spy('appPool', calls) as Pool,
      userSync: spy('userSync', calls) as UserSyncAdapter,
    });
    paths = procedurePaths(router);
    client = createRouterClient(router, { context: (raw: Record<string, unknown>) => raw });
    context = {
      tenantId: randomUUID(),
      actor: { type: 'user', id: `admin-${randomUUID()}` },
      principal: { roles: ['admin'] },
      __requestHeaders: new Headers(),
    };
  });

  async function call(path: string, input: Input): Promise<unknown> {
    let procedure: unknown = client;
    for (const segment of path.split('.')) {
      procedure = (procedure as Record<string, unknown>)[segment];
    }
    return await (procedure as (input: Input, options: { context: unknown }) => Promise<unknown>)(
      input,
      { context },
    );
  }

  it('lists the thirteen router procedures, and every one has an entry here', () => {
    expect(paths, 'the router has thirteen procedures').toHaveLength(13);
    const missing = paths.filter((path) => !(path in VALID_INPUT));
    expect(missing, 'procedures of the router missing from this test').toEqual([]);
    const stale = Object.keys(VALID_INPUT).filter((path) => !paths.includes(path));
    expect(stale, 'entries for procedures the router does not have').toEqual([]);
  });

  describe.each(Object.keys(VALID_INPUT))('%s', (path) => {
    async function expectRejected(input: Input): Promise<void> {
      calls.length = 0;
      await expect(call(path, input)).rejects.toMatchObject({ code: 'CATALOG_VALIDATION_FAILED' });
      expect(calls, 'no lookup or write before the refusal').toEqual([]);
    }

    function valid(): { input: Input; section: Section; fields: Record<string, unknown> } {
      const build = VALID_INPUT[path];
      if (build === undefined) throw new Error(`no valid input for ${path}`);
      const input = build();
      const section = sectionOf(input);
      return { input, section, fields: input[section] ?? {} };
    }

    it.each(HOSTILE_KEYS)('rejects a %s key at depth 1', async (key) => {
      const { input, section, fields } = valid();
      await expectRejected(withSection(input, section, withOwnKey(fields, key, 'x')));
    });

    it.each(HOSTILE_KEYS)('rejects a %s key at depth 3', async (key) => {
      const { input, section, fields } = valid();
      const nested = JSON.parse(`{"a":{"${key}":{"b":1}}}`) as unknown;
      await expectRejected(withSection(input, section, { ...fields, nested }));
    });

    it('rejects an undeclared field', async () => {
      const { input, section, fields } = valid();
      await expectRejected(withSection(input, section, { ...fields, unexpectedField: 'x' }));
    });

    it('rejects an over-length value', async () => {
      const { input, section, fields } = valid();
      const first = Object.keys(fields).find((name) => typeof fields[name] === 'string');
      const overLength = 'x'.repeat(5000);
      await expectRejected(
        withSection(input, section, { ...fields, [first ?? 'limit']: overLength }),
      );
    });
  });
});
