/**
 * 003 task 10.1 (design D16, D10, Resolved decision Q38): the smoke spec of the e2e
 * stack. The app's sign-in page loads over `https:`, through the TLS proxy whose
 * certificate Chromium trusts (no `ignoreHTTPSErrors`), under the strict CSP of D10,
 * and raises no policy violation, no console error and no request to another origin
 * (the shared fixture fails the test on any of them; the violations are also asserted
 * here, because they are what this spec is about).
 */
import { expect, settle, test } from './fixtures/test.js';

test.use({ locale: 'en-US' });

test('The sign-in page loads over https: with no CSP violation', async ({ page, seed, guard }) => {
  expect(new URL(seed.appOrigin).protocol).toBe('https:');

  const response = await page.goto(new URL('/sign-in', seed.appOrigin).href);

  expect(response?.status()).toBe(200);
  const loaded = new URL(page.url());
  expect(loaded.protocol).toBe('https:');
  expect(loaded.origin).toBe(seed.appOrigin);
  expect(loaded.pathname).toBe('/sign-in');
  // A verified TLS connection: the browser trusted the proxy's certificate.
  expect(await response?.securityDetails()).toEqual(
    expect.objectContaining({ subjectName: 'localhost' }),
  );
  // The policy is enforced, so "no violation" means something.
  expect(response?.headers()['content-security-policy']).toContain("script-src 'self'");

  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to Tayzu' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await settle(page);

  expect(guard.cspViolations).toEqual([]);
});
