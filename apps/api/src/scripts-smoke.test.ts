import { describe, expect, it } from 'vitest';

/**
 * `043` task 1.4: Vitest includes only `src/**`, so the maintenance scripts
 * under `apps/api/scripts/` are imported from here to prove each module
 * loads. Each script's behavior is tested by its own task.
 */
describe('@tayzu/api maintenance scripts smoke', () => {
  it.each([
    ['backfill-user-blueprint', () => import('../scripts/backfill-user-blueprint.js')],
    ['reconcile-users', () => import('../scripts/reconcile-users.js')],
    ['bootstrap-admin', () => import('../scripts/bootstrap-admin.js')],
  ])('loads scripts/%s.ts', async (_name, load) => {
    const module = await load();

    expect(module).toBeTypeOf('object');
  });
});
