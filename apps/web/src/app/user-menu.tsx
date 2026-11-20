/**
 * The header's user menu (design D12, Shell, and D11): the user's name, the
 * organization's name and the localized role, from the session (`GET /v1/me`), the MFA
 * enrolment page when the user is not enrolled (Q74), and sign-out. Server strings are
 * rendered as text only.
 */
import { Link } from '@tanstack/react-router';
import { UserIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import type { Me } from '../api/auth-client.js';

export function UserMenu({
  me,
  onSignOut,
}: {
  me: Me | undefined;
  onSignOut: () => void;
}): React.JSX.Element {
  const { t } = useTranslation('common');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('userMenu.label')}>
          <UserIcon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-48">
        {me !== undefined && (
          <>
            <DropdownMenuLabel className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-foreground">{me.user.name}</span>
              <span>{me.organization.name}</span>
              <span>{t(`role.${me.role}`)}</span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
          </>
        )}
        {me?.mfa.enrolled === false && (
          <DropdownMenuItem asChild>
            <Link to="/mfa/enrol">{t('userMenu.setUpMfa')}</Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={onSignOut}>{t('signOut')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
