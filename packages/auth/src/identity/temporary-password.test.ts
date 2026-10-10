/**
 * Task 13.5b of openspec/changes/043-identity-lifecycle-and-org-admin, the generator
 * part that Resolved decision Q136 moves ahead of 8.1c: one shared generator of
 * policy-compliant temporary passwords, used by both call sites.
 *
 * Cases:
 *
 * - 1000 generated passwords all pass `validatePassword` (policy of 8.1), each with
 *   an upper-case letter, a lower-case letter, a digit and a symbol, within the
 *   policy length;
 * - the passwords are not constant (a CSPRNG draw, not a fixed string);
 * - `@tayzu/auth` exports the generator;
 * - `apps/api/src/identity-router.ts` and `packages/auth/src/bootstrap-admin.ts` use
 *   the shared generator and no longer draw their own `randomBytes` password.
 *
 * ## Production symbols expected
 *
 * ```ts
 * // packages/auth/src/identity/temporary-password.ts
 * export function generateTemporaryPassword(): string;
 * // packages/auth/src/index.ts
 * export { generateTemporaryPassword } from './identity/temporary-password.js';
 * ```
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, validatePassword } from './password-policy.js';
import { generateTemporaryPassword } from './temporary-password.js';

function readSource(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

describe('generateTemporaryPassword', () => {
  it('1000 generated passwords all pass the password policy', () => {
    for (let i = 0; i < 1000; i += 1) {
      const password = generateTemporaryPassword();
      const result = validatePassword(password);
      expect(result.ok).toBe(true);
    }
  });

  it('each generated password has an upper-case letter, a lower-case letter, a digit and a symbol, within the policy length', () => {
    for (let i = 0; i < 1000; i += 1) {
      const password = generateTemporaryPassword();
      const length = Array.from(password).length;
      expect(length).toBeGreaterThanOrEqual(PASSWORD_MIN_LENGTH);
      expect(length).toBeLessThanOrEqual(PASSWORD_MAX_LENGTH);
      expect(password).toMatch(/\p{Lu}/u);
      expect(password).toMatch(/\p{Ll}/u);
      expect(password).toMatch(/\p{Nd}/u);
      expect(password).toMatch(/[^\p{L}\p{N}]/u);
    }
  });

  it('draws different passwords', () => {
    const drawn = new Set<string>();
    for (let i = 0; i < 100; i += 1) drawn.add(generateTemporaryPassword());
    expect(drawn.size).toBe(100);
  });

  it('is exported from @tayzu/auth', () => {
    expect(readSource('../index.ts')).toMatch(
      /export\s*\{[^}]*\bgenerateTemporaryPassword\b[^}]*\}\s*from\s*'\.\/identity\/temporary-password\.js'/,
    );
  });
});

describe('the two call sites use the shared generator', () => {
  it('apps/api/src/identity-router.ts imports it from @tayzu/auth and draws no randomBytes of its own', () => {
    const source = readSource('../../../../apps/api/src/identity-router.ts');
    expect(source).toMatch(
      /import\s*\{[^}]*\bgenerateTemporaryPassword\b[^}]*\}\s*from\s*'@tayzu\/auth'/,
    );
    expect(source).not.toMatch(/\brandomBytes\b/);
    expect(source).not.toMatch(/function\s+generateTemporaryPassword\b/);
    expect(source).toMatch(/\bgenerateTemporaryPassword\(\)/);
  });

  it('packages/auth/src/bootstrap-admin.ts imports it from the password module and draws no randomBytes of its own', () => {
    const source = readSource('../bootstrap-admin.ts');
    expect(source).toMatch(
      /import\s*\{[^}]*\bgenerateTemporaryPassword\b[^}]*\}\s*from\s*'\.\/identity\/temporary-password\.js'/,
    );
    expect(source).not.toMatch(/\brandomBytes\b/);
    expect(source).not.toMatch(/function\s+generateTemporaryPassword\b/);
    expect(source).toMatch(/\bgenerateTemporaryPassword\(\)/);
  });
});
