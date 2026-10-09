import { describe, expect, it } from 'vitest';

/** `043` task 1.4: the identity modules of `@tayzu/auth` load. */
describe('@tayzu/auth identity modules smoke', () => {
  it.each([
    ['user-status', () => import('./user-status.js')],
    ['invitation-token', () => import('./invitation-token.js')],
    ['password-policy', () => import('./password-policy.js')],
    ['email/sender', () => import('./email/sender.js')],
    ['ports', () => import('./ports.js')],
    ['common-passwords', () => import('./common-passwords.js')],
  ])('loads identity/%s.ts', async (_name, load) => {
    const module = await load();

    expect(module).toBeTypeOf('object');
  });
});
