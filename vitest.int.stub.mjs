/**
 * Shared stub of the breached-password range query (task 8.1a).
 *
 * Better Auth's `haveIBeenPwned` plugin hardcodes `api.pwnedpasswords.com`
 * and also covers `/admin/create-user`, so every test that reaches
 * `createAuth(` or `createUser` would call the real service (or fail
 * closed). This module wraps the global `fetch`: a request for that host
 * answers an empty range (no password is breached), and every other request
 * passes through untouched. A test that needs a breached or an unreachable
 * answer installs its own `fetch` over this one.
 *
 * It is an `.mjs` file because a `.ts` file in `NODE_OPTIONS` depends on
 * loader ordering. Vitest loads it as a `setupFiles` entry of the `int`
 * project; a child process (the bootstrap CLI, the API server of
 * `scripts/ci/dast.sh`) loads it with `NODE_OPTIONS=--import`.
 */
const BREACH_HOST = 'api.pwnedpasswords.com';

function requestUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function isBreachRangeQuery(input) {
  try {
    return new URL(requestUrl(input)).hostname === BREACH_HOST;
  } catch {
    return false;
  }
}

const STUB_MARK = Symbol.for('tayzu.vitest.int.stub');

if (globalThis.fetch[STUB_MARK] !== true) {
  const realFetch = globalThis.fetch;
  const stubbedFetch = (input, init) =>
    isBreachRangeQuery(input)
      ? Promise.resolve(
          new Response('', { status: 200, headers: { 'content-type': 'text/plain' } }),
        )
      : realFetch(input, init);
  stubbedFetch[STUB_MARK] = true;
  globalThis.fetch = stubbedFetch;
}
