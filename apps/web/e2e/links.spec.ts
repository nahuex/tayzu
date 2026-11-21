/**
 * 003 task 10.6 (design D11, D12, D16 and Resolved decisions Q68, Q78, Q79, Q92): the
 * link pages end to end, the page gates of the archived changes `043` (invitations) and
 * `044` (password reset), against the stack of `scripts/ci/e2e.sh`, through the shared
 * fixture (every test also fails on a CSP violation, a console error, an undeclared
 * error answer or a request to another origin).
 *
 * - "A new invitee creates their account": the seed's invitation link, then the new
 *   account path, then a sign-in with the chosen password.
 * - "The reset fragment is stripped before any request": the seed's reset link of a
 *   member without MFA, completed, then a sign-in with the new password.
 * - "A reset for an MFA-enrolled user asks for the factor": the seed's reset link of a
 *   member with TOTP.
 * - The forgot-password page shows one message for an existing and an unknown email.
 *
 * On both link pages every request is recorded (`watchLinkRequests`): it must be
 * same-origin, carry no `Referer` header, and carry neither the link's identifier nor its
 * token before the user submits. An init script also records, at every `fetch`,
 * `XMLHttpRequest` and `sendBeacon` call of the page (the page's own requests), whether
 * the address still had a fragment, so "`location.hash` empty before the first request"
 * is read in the page at the moment of the call. The script loads and the document
 * request are not the page's own requests, and a fragment is never sent on the wire.
 *
 * Every link is single-use and this spec's own: no other spec opens it. Recorded URLs
 * keep their origin and path only; no identifier, token or password reaches an
 * assertion message or a report.
 */
import type { Page, Request } from '@playwright/test';

import { apiGet } from './fixtures/browser-api.js';
import { expect, test, totpCode, type E2eSeed } from './fixtures/test.js';

test.use({ locale: 'en-US' });

const TOTP_STEP_MS = 30_000;
/** After the step boundary, so the server's clock is in the same step. */
const STEP_MARGIN_MS = 1_000;

const ACCEPT_PATH = '/v1/auth/invitations/accept';
const CONFIRM_PATH = '/v1/auth/password-reset/confirm';
const PAGE_CALLS = '__tayzuPageCalls';

/**
 * Runs in every document before its own scripts: wraps the page's request APIs and
 * records, per call, the target's path and whether the address had no fragment.
 * Nothing of the fragment itself is kept.
 */
const PAGE_CALL_RECORDER = `(() => {
  const calls = [];
  Object.defineProperty(window, ${JSON.stringify(PAGE_CALLS)}, { value: calls });
  const note = (target) => {
    let path = '(unparsable)';
    try {
      const raw = typeof target === 'object' && target !== null && 'url' in target
        ? target.url
        : String(target);
      path = new URL(raw, window.location.href).pathname;
    } catch {}
    calls.push({
      path,
      fragmentGone: window.location.hash === '' && !window.location.href.includes('#'),
    });
  };
  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    note(input);
    return originalFetch.call(this, input, init);
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    note(url);
    return originalOpen.call(this, method, url, ...rest);
  };
  if (typeof navigator.sendBeacon === 'function') {
    const originalBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => {
      note(url);
      return originalBeacon(url, data);
    };
  }
})();`;

interface PageCall {
  readonly path: string;
  readonly fragmentGone: boolean;
}

/** One request of the page, reduced to what the assertions need: no value is kept. */
interface RequestRecord {
  readonly method: string;
  /** `origin + pathname`, without query or fragment. */
  readonly target: string;
  readonly sameOrigin: boolean;
  readonly hasReferer: boolean;
  readonly carriesLinkSecret: boolean;
}

interface LinkRequestWatch {
  /** Every request so far, once their headers are read. */
  records(): Promise<RequestRecord[]>;
}

/** The link's identifier and token, from its fragment (`#<idName>=<id>&token=<token>`). */
function linkSecrets(link: string, idName: 'invitation' | 'reset'): readonly string[] {
  const fragment = new URLSearchParams(new URL(link).hash.slice(1));
  const id = fragment.get(idName);
  const token = fragment.get('token');
  if (id === null || id === '' || token === null || token === '') {
    throw new Error('A seeded link has no identifier or token in its fragment.');
  }
  return [id, token];
}

function isNetworkRequest(url: string): boolean {
  return url.startsWith('http:') || url.startsWith('https:') || url.startsWith('ws');
}

/** Records every network request of the page from now on (Referer, origin, link secrets). */
function watchLinkRequests(
  page: Page,
  seed: E2eSeed,
  secrets: readonly string[],
): LinkRequestWatch {
  const pending: Promise<RequestRecord>[] = [];
  const carries = (value: string | null | undefined): boolean =>
    value !== null && value !== undefined && secrets.some((secret) => value.includes(secret));

  const record = async (request: Request): Promise<RequestRecord> => {
    const url = new URL(request.url());
    // A fragment is never sent on the wire, whatever the recorded URL holds.
    const sent = `${url.origin}${url.pathname}${url.search}`;
    const headers = await request.allHeaders().catch(() => request.headers());
    return {
      method: request.method(),
      target: `${url.origin}${url.pathname}`,
      sameOrigin: url.origin === seed.appOrigin,
      hasReferer: Object.keys(headers).some((name) => name.toLowerCase() === 'referer'),
      carriesLinkSecret:
        carries(sent) ||
        carries(request.postData()) ||
        Object.values(headers).some((value) => carries(value)),
    };
  };

  page.on('request', (request) => {
    if (isNetworkRequest(request.url())) pending.push(record(request));
  });
  return { records: () => Promise.all(pending) };
}

async function pageCalls(page: Page): Promise<PageCall[]> {
  const calls: unknown = await page.evaluate(`[...window[${JSON.stringify(PAGE_CALLS)}]]`);
  return calls as PageCall[];
}

/** The common checks of a link page's requests, once the flow is over. */
async function expectCleanRequests(watch: LinkRequestWatch): Promise<RequestRecord[]> {
  const records = await watch.records();
  expect(records.length).toBeGreaterThan(0);
  expect(
    records.filter((record) => !record.sameOrigin).map((record) => record.target),
    'every request is same-origin',
  ).toEqual([]);
  expect(
    records.filter((record) => record.hasReferer).map((record) => record.target),
    'no request carries a Referer header',
  ).toEqual([]);
  return records;
}

/** The targets of the recorded requests that carry the link's identifier or token. */
function carriers(records: readonly RequestRecord[]): string[] {
  return records
    .filter((record) => record.carriesLinkSecret)
    .map((record) => `${record.method} ${record.target}`);
}

/** The code of a TOTP step no one has used yet: the next one, once it starts. */
async function unusedTotpCode(secret: string): Promise<string> {
  const now = Date.now();
  const nextStep = (Math.floor(now / TOTP_STEP_MS) + 1) * TOTP_STEP_MS;
  await new Promise((resolve) => setTimeout(resolve, nextStep - now + STEP_MARGIN_MS));
  return totpCode(secret, Date.now() / 1000);
}

/**
 * Waits until the address is `path` on the app's origin with no fragment. Only a boolean
 * reaches the assertion, so a failure never prints the address (it may hold the link).
 */
async function expectAddressWithoutFragment(page: Page, origin: string, path: string) {
  await expect
    .poll(
      () => {
        const url = new URL(page.url());
        return url.origin === origin && url.pathname === path && !page.url().includes('#');
      },
      { message: `the address is ${path} with no fragment` },
    )
    .toBe(true);
}

/** Fills the sign-in form; the caller asserts where it lands. */
async function signIn(page: Page, email: string, password: string): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to Tayzu' })).toBeVisible();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test('A new invitee creates their account', async ({ page, seed }) => {
  const invitation = seed.tenants.a.links.invitation;
  const origin = seed.appOrigin;
  await page.addInitScript({ content: PAGE_CALL_RECORDER });
  const watch = watchLinkRequests(page, seed, linkSecrets(invitation.link, 'invitation'));

  // GIVEN a valid invitation link for an email with no account
  // WHEN the invitee opens it
  await page.goto(invitation.link);

  // The address shows the fixed path with no fragment.
  await expectAddressWithoutFragment(page, origin, '/accept-invitation');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Accept your invitation' }),
  ).toBeVisible();

  // AND chooses a password
  await page.getByRole('button', { name: 'Create a new account' }).click();
  await page.getByLabel('Password', { exact: true }).fill(invitation.password);
  await page.getByLabel('Confirm password').fill(invitation.password);

  // Nothing has been sent by the page before the user's submit, and no request so far
  // carries the identifier or the token.
  expect(await pageCalls(page)).toEqual([]);
  expect(carriers(await watch.records()), 'no request carries the link before submit').toEqual([]);

  // AND accepts
  await page.getByRole('button', { name: 'Create account and accept' }).click();

  // THEN the account is created
  await expect(
    page.getByRole('status').filter({ hasText: 'Your account has been created.' }),
  ).toBeVisible();
  const atSubmit = await watch.records();
  expect(carriers(atSubmit)).toEqual([`POST ${origin}${ACCEPT_PATH}`]);

  // `location.hash` was empty at the page's first request, and at every one after it.
  const calls = await pageCalls(page);
  expect(calls[0]).toEqual({ path: ACCEPT_PATH, fragmentGone: true });
  expect(calls.filter((call) => !call.fragmentGone)).toEqual([]);

  // AND they can sign in
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/sign-in');
  await signIn(page, invitation.email, invitation.password);
  await expect(page).toHaveURL((url) => url.pathname === '/');
  await expect(page.getByRole('navigation', { name: 'Catalog' })).toBeVisible();
  const me = await apiGet(page, '/v1/me');
  expect(me.status).toBe(200);
  expect(me.body).toEqual(
    expect.objectContaining({
      user: expect.objectContaining({ email: invitation.email }),
      organization: expect.objectContaining({ id: seed.tenants.a.id }),
      role: 'member',
      gate: 'none',
    }),
  );

  // Every request of the flow was same-origin, with no Referer header, and only the
  // accept carried the link.
  const records = await expectCleanRequests(watch);
  expect(carriers(records)).toEqual([`POST ${origin}${ACCEPT_PATH}`]);
});

test('The reset fragment is stripped before any request', async ({ page, seed }) => {
  const reset = seed.tenants.a.links.passwordReset;
  const origin = seed.appOrigin;
  await page.addInitScript({ content: PAGE_CALL_RECORDER });
  const watch = watchLinkRequests(page, seed, linkSecrets(reset.link, 'reset'));

  // GIVEN a valid reset link
  // WHEN a user opens it
  await page.goto(reset.link);

  // THEN the address shows `/reset-password` with no fragment
  await expectAddressWithoutFragment(page, origin, '/reset-password');
  await expect(page.getByRole('heading', { level: 1, name: 'Reset your password' })).toBeVisible();

  // AND no request carries the token until the user submits (the page made none yet)
  await page.getByLabel('New password', { exact: true }).fill(reset.newPassword);
  await page.getByLabel('Confirm new password').fill(reset.newPassword);
  expect(await pageCalls(page)).toEqual([]);
  expect(carriers(await watch.records()), 'no request carries the link before submit').toEqual([]);

  await page.getByRole('button', { name: 'Reset password', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Your password has been reset.' }),
  ).toBeVisible();

  // The submit is the page's first request, made with the fragment already gone, and the
  // only one that carries the link.
  const calls = await pageCalls(page);
  expect(calls[0]).toEqual({ path: CONFIRM_PATH, fragmentGone: true });
  expect(calls.filter((call) => !call.fragmentGone)).toEqual([]);
  expect(carriers(await watch.records())).toEqual([`POST ${origin}${CONFIRM_PATH}`]);

  // The reset took effect: the new password signs the user in.
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/sign-in');
  await signIn(page, reset.email, reset.newPassword);
  await expect(page).toHaveURL((url) => url.pathname === '/');
  await expect(page.getByRole('navigation', { name: 'Catalog' })).toBeVisible();

  const records = await expectCleanRequests(watch);
  expect(carriers(records)).toEqual([`POST ${origin}${CONFIRM_PATH}`]);
});

test('A reset for an MFA-enrolled user asks for the factor', async ({ page, seed, guard }) => {
  // Up to one TOTP step of waiting, on top of the flow itself.
  test.setTimeout(90_000);
  const reset = seed.tenants.a.links.passwordResetWithMfa;
  const user = seed.tenants.a.users.resetWithMfa;
  const origin = seed.appOrigin;
  await page.addInitScript({ content: PAGE_CALL_RECORDER });
  const watch = watchLinkRequests(page, seed, linkSecrets(reset.link, 'reset'));
  const confirmations: number[] = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin === origin && url.pathname === CONFIRM_PATH) {
      confirmations.push(response.status());
    }
  });

  // GIVEN a valid reset link for a user with TOTP
  await page.goto(reset.link);
  await expectAddressWithoutFragment(page, origin, '/reset-password');
  await expect(page.getByRole('heading', { level: 1, name: 'Reset your password' })).toBeVisible();
  await expect(page.getByLabel('Authentication code')).toHaveCount(0);

  // WHEN they submit a new password without a factor: `403 AUTH_STEP_UP_REQUIRED` (Q92)
  guard.expectApiError(403, CONFIRM_PATH);
  await page.getByLabel('New password', { exact: true }).fill(reset.newPassword);
  await page.getByLabel('Confirm new password').fill(reset.newPassword);
  await page.getByRole('button', { name: 'Reset password', exact: true }).click();

  // THEN the page asks for a code
  await expect(
    page.getByText(
      'This account uses two-factor authentication. Enter a code to reset your password.',
    ),
  ).toBeVisible();
  const code = page.getByLabel('Authentication code');
  await expect(code).toBeVisible();
  expect(confirmations).toEqual([403]);

  // AND submitting again with a valid code completes the reset (the password fields are
  // emptied after every submit, Q78, so they are typed again)
  await page.getByLabel('New password', { exact: true }).fill(reset.newPassword);
  await page.getByLabel('Confirm new password').fill(reset.newPassword);
  await code.fill(await unusedTotpCode(user.totpSecret));
  await page.getByRole('button', { name: 'Reset password', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Your password has been reset.' }),
  ).toBeVisible();
  expect(confirmations).toHaveLength(2);
  expect(confirmations[1]).toBeGreaterThanOrEqual(200);
  expect(confirmations[1]).toBeLessThan(300);

  const calls = await pageCalls(page);
  expect(calls.map((call) => call.path)).toEqual([CONFIRM_PATH, CONFIRM_PATH]);
  expect(calls.filter((call) => !call.fragmentGone)).toEqual([]);

  // The reset took effect: the new password is accepted, and the sign-in asks for the
  // second factor next.
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/sign-in');
  await signIn(page, reset.email, reset.newPassword);
  await expect(page.getByLabel('Authentication code')).toBeVisible();
  await expect(page).toHaveURL((url) => url.pathname === '/sign-in');

  const records = await expectCleanRequests(watch);
  expect(carriers(records)).toEqual([
    `POST ${origin}${CONFIRM_PATH}`,
    `POST ${origin}${CONFIRM_PATH}`,
  ]);
});

test('The forgot-password page shows the same message for every email', async ({ page, seed }) => {
  const sent = 'If an account exists for this email, a link to reset the password has been sent.';
  const unknown = `e2e-unknown-${String(Date.now())}@example.test`;
  const messages: string[] = [];

  for (const email of [seed.tenants.a.users.member.email, unknown]) {
    await page.goto('/sign-in');
    await page.getByRole('link', { name: 'Forgot your password?' }).click();
    await expect(page).toHaveURL((url) => url.pathname === '/forgot-password');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Forgot your password?' }),
    ).toBeVisible();

    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Send reset link', exact: true }).click();

    const status = page.getByRole('status').filter({ hasText: sent });
    await expect(status).toBeVisible();
    messages.push(((await status.textContent()) ?? '').trim());
    await expect(page.getByLabel('Email')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Back to sign-in' })).toBeVisible();
  }

  // An existing account and an unknown email get the same message.
  expect(messages).toEqual([sent, sent]);
});
