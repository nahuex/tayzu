/**
 * The error boundary (task 5.11, design D15 and D12, Q68; spec "The UI never carries the
 * tenant, the cookie or tenant free text outside the page", scenario "An internal error
 * shows no server text").
 *
 * D15 (No client logging): "`console` is banned by lint, there is no logging or telemetry
 * library, and the error boundary renders a generic localized message with a "reload"
 * action, never an error message or stack. Tenant free text (titles, descriptions,
 * property values, validation messages) therefore never leaves the page."
 * Spec: "It MUST NOT log to the console [...]". Scenario: "GIVEN the API answers a call
 * with `INTERNAL` and a message, WHEN the app renders the failure, THEN the page shows the
 * generic localized error and not the message."
 * Q68: "a 5xx or network failure fails closed on an error state", shown by the root
 * route's error component, which this task replaces with the real boundary.
 *
 * Why the root options: React 19 hands every error an error boundary catches to the
 * root's `onCaughtError`, whose default calls `console.error` (in the production build
 * too), and its default `onUncaughtError` and `onRecoverableError` call `reportError`,
 * which the browser prints. TanStack Router's own route boundary `console.warn`s every
 * error it catches outside a production build. So the app's root is created with silent
 * handlers, and a route error is caught by the app's boundary before it reaches the
 * router's.
 *
 * Assumed API of `./error-boundary.js` (`src/app/error-boundary.tsx`):
 *
 * ```ts
 * import type { Component, ReactNode } from 'react';
 * import type { Root, RootOptions } from 'react-dom/client';
 *
 * // A class error boundary: on any error of its children it renders `ErrorPage` and
 * // nothing else. It never logs, and never renders the error, its message or stack.
 * export class AppErrorBoundary extends Component<{ children?: ReactNode }> {}
 *
 * // The generic page (D15): `role="alert"`, a level-1 heading `common:routeError.title`,
 * // the text `common:routeError.description`, and a button `common:routeError.reload`
 * // that calls `reloadPage()` of `./reload.js`. It takes no error prop and shows none.
 * // It is also the root route's `errorComponent` (replacing `RouteErrorPage`).
 * export function ErrorPage(): React.JSX.Element;
 *
 * // The silent handlers `createAppRoot` passes to `createRoot`: each one does nothing
 * // (no console call, no `reportError`, no throw).
 * export const ROOT_ERROR_OPTIONS: Required<
 *   Pick<RootOptions, 'onCaughtError' | 'onUncaughtError' | 'onRecoverableError'>
 * >;
 *
 * // `createRoot(container, ROOT_ERROR_OPTIONS)`; `main.tsx` renders the app through it.
 * export function createAppRoot(container: Element): Root;
 * ```
 *
 * `./reload.js` (`src/app/reload.ts`) exports `reloadPage(): void`, which calls
 * `window.location.reload()`. jsdom's `location.reload` can be neither replaced nor
 * spied on (it is an unforgeable, read-only property) and logs "not implemented" when
 * called, so this test mocks the module.
 *
 * `createAppRouter` (`./router.js`): a route component that throws, or a protected route
 * whose session read fails, shows the same `ErrorPage`, with no console call.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode, type ReactNode } from 'react';
import type { Root } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import type { i18n as I18n } from 'i18next';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { createAuthClient } from '../api/auth-client.js';
import { createI18n } from '../i18n/i18n.js';

import { AppErrorBoundary, ROOT_ERROR_OPTIONS, createAppRoot } from './error-boundary.js';
import { reloadPage } from './reload.js';
import { createAppRouter } from './router.js';

vi.mock('./reload.js', () => ({ reloadPage: vi.fn() }));

/** A recognizable marker standing for tenant free text inside an error message. */
const MARKER = 'tz-leak-marker-5f0c9a';

/** The tenant free text a thrown error carries, as a title would. */
const ERROR_MESSAGE = `${MARKER}: the title "Payments API" failed to render`;

/** Every error a throwing child raised, so the test can look for its stack. */
const thrownErrors: Error[] = [];

/** A child that throws during render, every time it renders. */
function ThrowingWidget(): React.JSX.Element {
  const error = new Error(ERROR_MESSAGE);
  thrownErrors.push(error);
  throw error;
}

/** The console methods spied on: the page must call none of them. */
type ConsoleMethod = 'error' | 'warn' | 'log' | 'info' | 'debug';

let consoleSpies: Record<ConsoleMethod, MockInstance>;

/** Every console call recorded so far, by method: all empty when nothing was written. */
function consoleCalls(): Record<ConsoleMethod, unknown[][]> {
  return {
    error: consoleSpies.error.mock.calls,
    warn: consoleSpies.warn.mock.calls,
    log: consoleSpies.log.mock.calls,
    info: consoleSpies.info.mock.calls,
    debug: consoleSpies.debug.mock.calls,
  };
}

const NO_CONSOLE_CALL = { error: [], warn: [], log: [], info: [], debug: [] };

let mounted: { root: Root; container: HTMLElement } | undefined;

/** Renders `ui` the way `main.tsx` does: through `createAppRoot`, in strict mode. */
async function renderInAppRoot(ui: ReactNode): Promise<void> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createAppRoot(container);
  mounted = { root, container };
  await act(async () => {
    root.render(<StrictMode>{ui}</StrictMode>);
  });
}

/** The generic page's localized texts, read from the same i18n instance. */
function genericTexts(i18n: I18n): { title: string; description: string; reload: string } {
  const texts = {
    title: i18n.t('routeError.title', { ns: 'common' }),
    description: i18n.t('routeError.description', { ns: 'common' }),
    reload: i18n.t('routeError.reload', { ns: 'common' }),
  };
  // Each key exists in the locale file: i18next answers the key itself for a missing one.
  expect(texts.title).not.toBe('routeError.title');
  expect(texts.description).not.toBe('routeError.description');
  expect(texts.reload).not.toBe('routeError.reload');
  return texts;
}

/** Waits for the generic page and checks its heading, text and reload button. */
async function expectGenericPage(i18n: I18n): Promise<HTMLElement> {
  const { title, description, reload } = genericTexts(i18n);
  const alert = await screen.findByRole('alert');
  expect(screen.getByRole('heading', { level: 1, name: title })).toBeInTheDocument();
  expect(screen.getByText(description)).toBeInTheDocument();
  const button = screen.getByRole('button', { name: reload });
  expect(alert).toContainElement(button);
  return button;
}

/** The marker, the error message and every stack frame are absent from the document. */
function expectNoErrorDetails(): void {
  const text = document.body.textContent;
  const markup = document.documentElement.outerHTML;
  expect(text).not.toContain(MARKER);
  expect(markup).not.toContain(MARKER);
  expect(text).not.toContain('ThrowingWidget');
  expect(text).not.toContain('error-boundary.test');
  for (const error of thrownErrors) {
    const frames = (error.stack ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(text).not.toContain(frame);
      expect(markup).not.toContain(frame);
    }
  }
}

beforeEach(() => {
  window.localStorage.clear();
  thrownErrors.length = 0;
  vi.mocked(reloadPage).mockClear();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  consoleSpies = {
    error: vi.spyOn(console, 'error').mockImplementation(() => undefined),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    log: vi.spyOn(console, 'log').mockImplementation(() => undefined),
    info: vi.spyOn(console, 'info').mockImplementation(() => undefined),
    debug: vi.spyOn(console, 'debug').mockImplementation(() => undefined),
  };
});

afterEach(async () => {
  if (mounted !== undefined) {
    const { root, container } = mounted;
    mounted = undefined;
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
  vi.restoreAllMocks();
});

describe('the error boundary', () => {
  it('renders the generic localized message with a reload action for a throwing child', async () => {
    const i18n = await createI18n();

    await renderInAppRoot(
      <I18nextProvider i18n={i18n}>
        <AppErrorBoundary>
          <ThrowingWidget />
        </AppErrorBoundary>
      </I18nextProvider>,
    );

    await expectGenericPage(i18n);
    expect(thrownErrors.length).toBeGreaterThan(0);
  });

  it('renders the generic message in the chosen locale', async () => {
    window.localStorage.setItem('tayzu.locale', 'es');
    const i18n = await createI18n();
    expect(i18n.language).toBe('es');

    await renderInAppRoot(
      <I18nextProvider i18n={i18n}>
        <AppErrorBoundary>
          <ThrowingWidget />
        </AppErrorBoundary>
      </I18nextProvider>,
    );

    await expectGenericPage(i18n);
    const english = await createI18n();
    await english.changeLanguage('en');
    expect(genericTexts(i18n).reload).not.toBe(genericTexts(english).reload);
  });

  it('keeps the error message and its stack out of the DOM', async () => {
    const i18n = await createI18n();

    await renderInAppRoot(
      <I18nextProvider i18n={i18n}>
        <AppErrorBoundary>
          <ThrowingWidget />
        </AppErrorBoundary>
      </I18nextProvider>,
    );

    await expectGenericPage(i18n);
    expectNoErrorDetails();
  });

  it('reloads the page when the reload action is used', async () => {
    const user = userEvent.setup();
    const i18n = await createI18n();

    await renderInAppRoot(
      <I18nextProvider i18n={i18n}>
        <AppErrorBoundary>
          <ThrowingWidget />
        </AppErrorBoundary>
      </I18nextProvider>,
    );
    const button = await expectGenericPage(i18n);
    expect(reloadPage).not.toHaveBeenCalled();

    await user.click(button);

    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  it('writes nothing to the console during the throw, the recovery page and the reload', async () => {
    const user = userEvent.setup();
    const i18n = await createI18n();

    await renderInAppRoot(
      <I18nextProvider i18n={i18n}>
        <AppErrorBoundary>
          <ThrowingWidget />
        </AppErrorBoundary>
      </I18nextProvider>,
    );
    const button = await expectGenericPage(i18n);
    await user.click(button);

    expect(thrownErrors.length).toBeGreaterThan(0);
    expect(consoleCalls()).toEqual(NO_CONSOLE_CALL);
  });
});

describe('the root error options', () => {
  it('handle a caught, an uncaught and a recoverable error silently', () => {
    const windowErrors: Event[] = [];
    const onWindowError = (event: Event): void => {
      windowErrors.push(event);
    };
    window.addEventListener('error', onWindowError);
    const error = new Error(ERROR_MESSAGE);
    const componentStack = '\n    in ThrowingWidget (at error-boundary.test.tsx:1:1)';

    try {
      expect(() => {
        ROOT_ERROR_OPTIONS.onCaughtError(error, { componentStack, errorBoundary: undefined });
      }).not.toThrow();
      expect(() => {
        ROOT_ERROR_OPTIONS.onUncaughtError(error, { componentStack });
      }).not.toThrow();
      expect(() => {
        ROOT_ERROR_OPTIONS.onRecoverableError(error, { componentStack });
      }).not.toThrow();
    } finally {
      window.removeEventListener('error', onWindowError);
    }

    expect(windowErrors).toEqual([]);
    expect(consoleCalls()).toEqual(NO_CONSOLE_CALL);
  });
});

describe('a route error', () => {
  it('shows the same generic page, without the error, when a route component throws', async () => {
    const user = userEvent.setup();
    const i18n = await createI18n();
    const history = createMemoryHistory({ initialEntries: ['/catalog/service'] });
    const router = createAppRouter({ history, pages: { catalogTable: ThrowingWidget } });

    await renderInAppRoot(
      <I18nextProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nextProvider>,
    );
    const button = await expectGenericPage(i18n);
    expect(thrownErrors.length).toBeGreaterThan(0);
    expectNoErrorDetails();

    await user.click(button);

    expect(reloadPage).toHaveBeenCalledTimes(1);
    expect(consoleCalls()).toEqual(NO_CONSOLE_CALL);
  });

  it('shows the generic page, and not the server message, when the session read fails', async () => {
    const i18n = await createI18n();
    const history = createMemoryHistory({ initialEntries: ['/catalog/service'] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
    const authClient = createAuthClient({
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({ code: 'INTERNAL_SERVER_ERROR', status: 500, message: ERROR_MESSAGE }),
            { status: 500, headers: { 'content-type': 'application/json' } },
          ),
        ),
    });
    const router = createAppRouter({ history, session: { authClient, queryClient } });

    await renderInAppRoot(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </I18nextProvider>,
    );

    await expectGenericPage(i18n);
    expectNoErrorDetails();
    expect(consoleCalls()).toEqual(NO_CONSOLE_CALL);
  });
});
