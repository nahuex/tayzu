/**
 * The gate pages' sign-out (design D11, D12 and Q69, Q73): the shell's own sign-out, for
 * the pages the shell never wraps. It posts `/api/auth/sign-out`, then, whatever the
 * answer, clears the query cache and the session-bound stores and goes to `/sign-in`.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';

import { useAuthClient } from '../api/auth-client-context.js';
import { useEndSession } from '../app/use-end-session.js';

export function SignOutButton(): React.JSX.Element {
  const { t } = useTranslation('common');
  const authClient = useAuthClient();
  const { signOut } = useEndSession(useQueryClient());

  return (
    <Button
      type="button"
      variant="outline"
      onClick={() => {
        void signOut(authClient);
      }}
    >
      {t('signOut')}
    </Button>
  );
}
