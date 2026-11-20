/**
 * The header's locale selector (design D12, i18n): a menu of the supported locales, the
 * current one checked. Choosing one stores it, switches the texts and `<html lang>`.
 */
import { LanguagesIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { LOCALES, changeLocale, currentLocale } from '../i18n/i18n.js';

export function LocaleSelector(): React.JSX.Element {
  const { t, i18n } = useTranslation('common');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('locale.label')}>
          <LanguagesIcon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={currentLocale(i18n)}>
          {LOCALES.map((locale) => (
            <DropdownMenuRadioItem
              key={locale}
              value={locale}
              onSelect={() => {
                void changeLocale(i18n, locale);
              }}
            >
              {t(`locale.${locale}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
