/**
 * Task 13.3 of openspec/changes/043-identity-lifecycle-and-org-admin (Resolved
 * decision Q74; `002` Q42): the user, credential and bootstrap lifecycle events
 * are declared in the separate identity contract module, before any route
 * mounts them.
 *
 * Verify clause: "`identity-contract.test.ts` ... asserts the four names are
 * declared in the module, with both forms of `catalog.audit.user_created`."
 *
 * Design, log events table: `catalog.audit.user_created` carries
 * `tayzu.actor.id` (the admin) for the source `admin`, and
 * `tayzu.identity.operator.id` in its place for the source `bootstrap`
 * (Resolved decision Q116).
 *
 * ## Production symbols expected
 *
 * `IDENTITY_LOG_EVENTS` (`./identity-contract.js`) lists the four names
 * `catalog.audit.user_created`, `catalog.audit.credential_created`,
 * `catalog.audit.credential_rotated` and `catalog.security.credential_revoked`.
 * An entry is either the bare name or an object with a `name` field. The entry
 * of `catalog.audit.user_created` must describe both forms, so a bare string
 * cannot express it: it is an object that names `tayzu.actor.id`,
 * `tayzu.identity.operator.id` and the two sources `admin` and `bootstrap`.
 *
 * ## Why this fails right now
 *
 * `IDENTITY_LOG_EVENTS` is empty (assertion failure).
 */
import { describe, expect, it } from 'vitest';

import { IDENTITY_LOG_EVENTS } from './identity-contract.js';

function nameOf(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  if (typeof entry === 'object' && entry !== null) {
    const { name } = entry as { name?: unknown };
    return typeof name === 'string' ? name : undefined;
  }
  return undefined;
}

function entryOf(name: string): unknown {
  return (IDENTITY_LOG_EVENTS as readonly unknown[]).find((entry) => nameOf(entry) === name);
}

describe('the identity contract declares the 002 Q42 lifecycle events (task 13.3)', () => {
  it.each([
    'catalog.audit.user_created',
    'catalog.audit.credential_created',
    'catalog.audit.credential_rotated',
    'catalog.security.credential_revoked',
  ])('declares %s exactly once', (name) => {
    const matches = (IDENTITY_LOG_EVENTS as readonly unknown[]).filter(
      (entry) => nameOf(entry) === name,
    );
    expect(matches).toHaveLength(1);
  });

  it('declares both forms of catalog.audit.user_created: the admin form and the bootstrap form with the operator id in place of the actor id', () => {
    const entry = entryOf('catalog.audit.user_created');
    expect(entry, 'the event is declared').toBeDefined();
    expect(typeof entry, 'an object, because a bare name cannot carry two forms').toBe('object');
    const serialized = JSON.stringify(entry);
    expect(serialized).toContain('tayzu.actor.id');
    expect(serialized).toContain('tayzu.identity.operator.id');
    expect(serialized).toContain('tayzu.identity.user.source');
    expect(serialized).toContain('"admin"');
    expect(serialized).toContain('"bootstrap"');
  });

  it('declares no catalog name in the authz-pinned contract.ts (it stays untouched)', async () => {
    const authContract = await import('./contract.js');
    const names = authContract.LOG_EVENTS.map((event) => event.name);
    expect(names.filter((name) => name.startsWith('catalog.'))).toEqual([]);
  });
});
