/**
 * The expired-password page (design D11 and Q68, Q73): `/change-password` renders it
 * under the `password_expired` gate. The user cannot change an expired temporary
 * password, so the page only says an administrator must set a new one, and offers
 * sign-out.
 */
import { Suspense } from 'react';
import { useTranslation } from 'react-i18next';

import { SignOutButton } from './sign-out-button.js';

function PasswordExpiredContent(): React.JSX.Element {
  const { t } = useTranslation('auth');
  return (
    <main className="mx-auto flex w-full max-w-sm flex-col gap-6 p-8">
      <h1 className="text-2xl font-semibold">{t('passwordExpired.title')}</h1>
      <p>{t('passwordExpired.description')}</p>
      <SignOutButton />
    </main>
  );
}

/** The `auth` namespace loads on demand, inside the page's own boundary. */
export function PasswordExpiredPage(): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <PasswordExpiredContent />
    </Suspense>
  );
}
