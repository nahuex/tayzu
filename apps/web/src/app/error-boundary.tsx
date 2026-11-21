/**
 * The error boundary (design D12, D15 and Q68): any render or route failure shows one
 * generic localized message with a reload action, and fails closed. The error, its
 * message and its stack are never rendered, and nothing is written to the console, so
 * tenant free text never leaves the page.
 *
 * React 19 hands every error to the root's handlers, whose defaults call `console.error`
 * or `reportError`; `createAppRoot` replaces them with silent ones. TanStack Router's own
 * route boundary warns on the console outside a production build, so the root route
 * wraps its outlet in `AppErrorBoundary`, which catches a route error first.
 */
import { Component, type ReactNode } from 'react';
import { createRoot, type Root, type RootOptions } from 'react-dom/client';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';

import { reloadPage } from './reload.js';

/** The generic error page. It takes no error and shows none. */
export function ErrorPage(): React.JSX.Element {
  const { t } = useTranslation('common');

  return (
    <div role="alert" className="mx-auto flex max-w-xl flex-col items-start gap-4 p-8">
      <h1 className="text-2xl font-semibold">{t('routeError.title')}</h1>
      <p className="text-muted-foreground">{t('routeError.description')}</p>
      <Button type="button" onClick={reloadPage}>
        {t('routeError.reload')}
      </Button>
    </div>
  );
}

interface AppErrorBoundaryState {
  failed: boolean;
}

/**
 * Renders `ErrorPage` instead of its children once any of them throws. Only the fact of
 * the failure is kept, never the error itself.
 */
export class AppErrorBoundary extends Component<{ children?: ReactNode }, AppErrorBoundaryState> {
  override state: AppErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? <ErrorPage /> : this.props.children;
  }
}

/** Does nothing: the root error handlers are silent (D15, no client logging). */
function ignoreError(): void {
  // Intentionally empty.
}

/** The silent root error handlers that `createAppRoot` passes to `createRoot`. */
export const ROOT_ERROR_OPTIONS: Required<
  Pick<RootOptions, 'onCaughtError' | 'onUncaughtError' | 'onRecoverableError'>
> = {
  onCaughtError: ignoreError,
  onUncaughtError: ignoreError,
  onRecoverableError: ignoreError,
};

/** The app's React root, created with the silent error handlers. */
export function createAppRoot(container: Element): Root {
  return createRoot(container, ROOT_ERROR_OPTIONS);
}
