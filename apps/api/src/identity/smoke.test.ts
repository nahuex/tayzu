import { describe, expect, it } from 'vitest';

/** `043` task 1.4: the identity orchestration modules of `apps/api` load. */
describe('@tayzu/api identity modules smoke', () => {
  it.each([
    ['invitations', () => import('./invitations.js')],
    ['service-accounts', () => import('./service-accounts.js')],
    ['credentials', () => import('./credentials.js')],
  ])('loads identity/%s.ts', async (_name, load) => {
    const module = await load();

    expect(module).toBeTypeOf('object');
  });
});
