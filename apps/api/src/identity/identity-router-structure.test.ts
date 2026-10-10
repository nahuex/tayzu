/**
 * Task 5.3b of openspec/changes/043-identity-lifecycle-and-org-admin (spec
 * scenario "A route built without the wrapper is rejected": WHEN a procedure is
 * added to the identity router without the authorization wrapper, including by
 * chaining or by an unwrapped builder, THEN the structure test fails).
 *
 * The check is the brand, not a text scan for `.handler(` (bypassable by
 * chaining). Cases:
 *
 * - every procedure of the real identity router is branded;
 * - an unbranded procedure built by `os.handler(...)`, one built by chaining
 *   (`os.route(...).handler(...)`) and one built from an unwrapped builder are each
 *   reported, by their path in the router;
 * - the module of the wrapper does not export a base builder;
 * - `assertMayOnUser` no longer exists in the router source.
 *
 * ## Production symbols expected
 *
 * ```ts
 * // apps/api/src/identity/define-operation.ts
 * export function isIdentityOperation(procedure: unknown): boolean;
 * // Walks a router tree and returns the dotted path of every procedure that is not branded.
 * export function findUnbrandedProcedures(router: unknown): string[];
 * ```
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { os } from '@orpc/server';
import type { CerbosClient } from '@tayzu/authz';
import { describe, expect, it } from 'vitest';

import { createIdentityRouter } from '../identity-router.js';
import type { AuthRepository } from './auth-repository.js';
import * as defineOperation from './define-operation.js';

const { findUnbrandedProcedures } = defineOperation;

function realRouter() {
  return createIdentityRouter({
    auth: { api: {}, $context: Promise.resolve({}) },
    authz: {} as unknown as CerbosClient,
    authRepository: {} as unknown as AuthRepository,
  });
}

describe('identity router structure (task 5.3b)', () => {
  it('every procedure of the identity router is branded', () => {
    expect(findUnbrandedProcedures(realRouter())).toEqual([]);
  });

  it('fails on a procedure built with the bare builder', () => {
    const router = {
      identity: { users: { rogue: os.handler(() => 'x') } },
    };
    expect(findUnbrandedProcedures(router)).toEqual(['identity.users.rogue']);
  });

  it('fails on a procedure built by chaining', () => {
    const router = {
      identity: { users: { chained: os.route({ method: 'POST' }).handler(() => 'x') } },
    };
    expect(findUnbrandedProcedures(router)).toEqual(['identity.users.chained']);
  });

  it('fails on a procedure built from an unwrapped builder, and keeps the branded siblings out of the report', () => {
    const router = realRouter();
    const base = os.$context<Record<string, unknown>>();
    const tampered = {
      identity: {
        ...router.identity,
        users: { ...router.identity.users, sneaky: base.handler(() => 'x') },
      },
    };
    expect(findUnbrandedProcedures(tampered)).toEqual(['identity.users.sneaky']);
  });

  it('the wrapper module does not export a base builder', () => {
    for (const [name, value] of Object.entries(defineOperation)) {
      const handler = (value as { handler?: unknown } | null)?.handler;
      expect(typeof handler, `export ${name} must not be an oRPC builder`).not.toBe('function');
    }
  });

  it('assertMayOnUser is removed from the identity router', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../identity-router.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toContain('assertMayOnUser');
  });
});
