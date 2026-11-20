/**
 * The not-found page (design D12 and D13): an unknown path, and later an unknown
 * blueprint or entity, including another tenant's, all look the same.
 */
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

export function NotFoundPage(): React.JSX.Element {
  const { t } = useTranslation('common');

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 p-8">
      <h1 className="text-2xl font-semibold">{t('notFound.title')}</h1>
      <p className="text-muted-foreground">{t('notFound.description')}</p>
      <Link to="/" className="underline underline-offset-4">
        {t('notFound.home')}
      </Link>
    </div>
  );
}
