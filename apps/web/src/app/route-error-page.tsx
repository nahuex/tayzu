/**
 * The root route's error component (design D12, D15 and Q68): a failed session read,
 * or any other route failure, shows one generic localized message and fails closed.
 * The error itself is never rendered. Task 5.11 replaces it with the real error
 * boundary.
 */
import { useTranslation } from 'react-i18next';

export function RouteErrorPage(): React.JSX.Element {
  const { t } = useTranslation('common');

  return (
    <div role="alert" className="mx-auto flex max-w-xl flex-col gap-4 p-8">
      <h1 className="text-2xl font-semibold">{t('routeError.title')}</h1>
      <p className="text-muted-foreground">{t('routeError.description')}</p>
    </div>
  );
}
