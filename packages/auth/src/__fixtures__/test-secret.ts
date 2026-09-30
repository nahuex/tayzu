import { randomUUID } from 'node:crypto';

/**
 * The one `BETTER_AUTH_SECRET` every test that builds Better Auth (or the app)
 * uses. Better Auth's jwt plugin stores its signing key in the shared
 * `auth.jwks` table, encrypted with this secret, so every suite must agree on
 * it or whichever suite writes the key first breaks the others with a decrypt
 * error. Test-only: never a real secret.
 */
export const TEST_SECRET = 'int-test-only-secret-not-used-for-anything-real-0123456789';

/**
 * A password for users the tests create. Generated once per test process, so
 * no password literal lives in the repository (gitleaks flags them).
 */
export const TEST_PASSWORD = `Tz-${randomUUID()}`;
