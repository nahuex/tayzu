/**
 * The header's theme toggle (design D12, Shell and Theme): a menu of the three theme
 * choices, the current one checked. The texts come from the `common` namespace.
 * The menu is not modal: a modal Radix menu hides the rest of the page with `aria-hidden`
 * while its controls stay focusable (axe `aria-hidden-focus`, design D16). Focus still
 * moves into the menu, and Escape returns it to the trigger.
 */
import type { LucideIcon } from 'lucide-react';
import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { THEMES, type Theme, type ThemeStore } from '../state/theme.js';

const THEME_ICONS: Record<Theme, LucideIcon> = {
  system: MonitorIcon,
  light: SunIcon,
  dark: MoonIcon,
};

export function ThemeToggle({ store }: { store: ThemeStore }): React.JSX.Element {
  const { t } = useTranslation('common');
  const theme = store((state) => state.theme);
  const setTheme = store((state) => state.setTheme);
  const CurrentIcon = THEME_ICONS[theme];

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('theme.label')}>
          <CurrentIcon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={theme}>
          {THEMES.map((choice) => (
            <DropdownMenuRadioItem
              key={choice}
              value={choice}
              onSelect={() => {
                setTheme(choice);
              }}
            >
              {t(`theme.${choice}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
