/**
 * The command dialog (design D14, D15 and Q85, Q90; spec "Users can search the catalog
 * from anywhere"), mounted by the shell on every signed-in route.
 *
 * It opens from the header trigger and on `Ctrl`+`K` or `Cmd`+`K` anywhere, text fields
 * included, with the browser's own shortcut prevented. Closing it returns focus to what
 * had it when it opened.
 *
 * The list is the Blueprints group, filtered locally by identifier and localized title
 * from the sidebar's cached `blueprints.list` (no request of its own), then the Entities
 * group, every `search.entities` item in the server's order (cmdk filters nothing), then
 * "See all results". `search.entities` is called 250 ms after the last keystroke, for a
 * query of 2 characters or more as the server counts them, with `q` as typed; the query's
 * `AbortSignal` reaches the request, so TanStack Query aborts the older one when the key
 * changes. Entity results, an error and "See all results" show only for an answer to the
 * query currently typed, so an older answer never shows, and they arrive together, so
 * cmdk selects the list's first option when the answer lands.
 *
 * The query lives only in component state and the in-memory query cache: never in the
 * URL while typing, never in storage (D15). A failure shows one localized text, never
 * the server's message.
 *
 * The `search` and `catalog` namespaces load on the first opening, inside the dialog's
 * own boundary, so the shell never waits for them.
 */
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { SearchIcon } from 'lucide-react';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  Command,
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';

import type { ApiClient } from '../api/client.js';
import { toApiError } from '../api/errors.js';
import { sidebarBlueprintsQuery, systemLast } from '../app/blueprint-sidebar.js';
import { isAddressableIdentifier } from '../catalog/columns.js';
import { currentLocale, localizedText, type Locale } from '../i18n/i18n.js';

import {
  MIN_QUERY_LENGTH,
  blueprintTitle,
  countedLength,
  type Blueprint,
  type SearchItem,
} from './search-results.js';

/** The delay after the last keystroke before `search.entities` is called (D14). */
const DEBOUNCE_MS = 250;

/** The most entity results the dialog asks for; "See all results" shows more. */
const COMMAND_LIMIT = 10;

interface CommandSearchProps {
  readonly apiClient: Pick<ApiClient, 'blueprints' | 'search'>;
  readonly queryClient: QueryClient;
}

/** `Ctrl`+`K` or `Cmd`+`K`, whatever else is held. */
function isSearchShortcut(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k';
}

/** The element that has focus, to return focus to it on close. */
function focusedElement(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

/** The header trigger and the dialog it opens. */
export function CommandSearch({ apiClient, queryClient }: CommandSearchProps): React.JSX.Element {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  // The dialog mounts on its first opening, and stays mounted for its closing animation.
  const [mounted, setMounted] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);

  const openDialog = useCallback((from: HTMLElement | null) => {
    returnFocus.current = from;
    setMounted(true);
    setOpen(true);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isSearchShortcut(event)) return;
      event.preventDefault();
      if (!open) openDialog(focusedElement());
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, openDialog]);

  const onCloseAutoFocus = (event: Event): void => {
    event.preventDefault();
    const target = returnFocus.current;
    returnFocus.current = null;
    if (target?.isConnected === true) target.focus();
  };

  return (
    <>
      <Button
        variant="outline"
        type="button"
        onClick={(event) => {
          openDialog(event.currentTarget);
        }}
      >
        <SearchIcon aria-hidden="true" />
        <span>{t('search.open')}</span>
        <kbd aria-hidden="true" className="ml-2 font-sans text-xs text-muted-foreground">
          Ctrl K
        </kbd>
      </Button>
      {mounted && (
        <Suspense fallback={null}>
          <SearchDialog
            apiClient={apiClient}
            queryClient={queryClient}
            open={open}
            onOpenChange={setOpen}
            onCloseAutoFocus={onCloseAutoFocus}
          />
        </Suspense>
      )}
    </>
  );
}

function SearchDialog({
  open,
  onOpenChange,
  onCloseAutoFocus,
  ...sources
}: CommandSearchProps & {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCloseAutoFocus: (event: Event) => void;
}): React.JSX.Element {
  // `catalog` too: the note of a result that cannot be opened lives there.
  const { t } = useTranslation(['search', 'catalog']);
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      onCloseAutoFocus={onCloseAutoFocus}
      title={t('command.title')}
      description={t('command.description')}
    >
      {/* Content unmounts on close, so every opening starts from an empty query. */}
      <SearchCommand
        {...sources}
        onDone={() => {
          onOpenChange(false);
        }}
      />
    </CommandDialog>
  );
}

/** `value` once it has stayed the same for `delay` milliseconds. */
function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(value);
    }, delay);
    return () => {
      clearTimeout(timer);
    };
  }, [value, delay]);
  return debounced;
}

/** The blueprints whose identifier or localized title holds `query`, any case. */
function matchingBlueprints(
  blueprints: readonly Blueprint[],
  query: string,
  locale: Locale,
): Blueprint[] {
  const needle = query.trim().toLocaleLowerCase(locale);
  return systemLast(blueprints).filter(
    (blueprint) =>
      blueprint.identifier.toLocaleLowerCase(locale).includes(needle) ||
      localizedText(blueprint.title, locale).toLocaleLowerCase(locale).includes(needle),
  );
}

/** Unique cmdk values per option kind; cmdk only compares them. */
function blueprintValue(identifier: string): string {
  return JSON.stringify(['blueprint', identifier]);
}
function entityValue(item: SearchItem): string {
  return JSON.stringify(['entity', item.blueprint, item.identifier]);
}
const SEE_ALL_VALUE = JSON.stringify(['seeAll']);

function SearchCommand({
  apiClient,
  queryClient,
  onDone,
}: CommandSearchProps & { readonly onDone: () => void }): React.JSX.Element {
  const { t, i18n } = useTranslation(['search', 'catalog']);
  const locale = currentLocale(i18n);
  const router = useRouter();
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search, DEBOUNCE_MS);
  const searchable = countedLength(q) >= MIN_QUERY_LENGTH;

  // The sidebar's own query, observed only: its cached answer, never a request.
  const blueprints = useQuery(
    { ...sidebarBlueprintsQuery(apiClient), enabled: false },
    queryClient,
  );
  const entities = useQuery(
    {
      queryKey: ['search', 'entities', { q, limit: COMMAND_LIMIT }],
      queryFn: ({ signal }) => apiClient.search.entities({ q, limit: COMMAND_LIMIT }, { signal }),
      enabled: searchable,
    },
    queryClient,
  );

  // Only an answer to the query as currently typed is shown.
  const current = searchable && q === search;
  const items = current ? entities.data?.items : undefined;
  const error = current && entities.error !== null ? toApiError(entities.error) : undefined;
  // The shell clears the session and lands on sign-in (Q69).
  const failed = error !== undefined && error.kind !== 'unauthenticated';
  const settled = items !== undefined || failed;

  const blueprintList = blueprints.data?.items ?? [];
  const shownBlueprints = matchingBlueprints(blueprintList, search, locale);

  return (
    <Command label={t('command.inputLabel')} shouldFilter={false} vimBindings={false}>
      <CommandInput value={search} onValueChange={setSearch} placeholder={t('placeholder')} />
      <CommandList>
        {shownBlueprints.length > 0 && (
          <CommandGroup heading={t('command.blueprints')}>
            {shownBlueprints.map((blueprint) => (
              <CommandItem
                key={blueprint.identifier}
                value={blueprintValue(blueprint.identifier)}
                onSelect={() => {
                  onDone();
                  void router.navigate({
                    to: '/catalog/$blueprint',
                    params: { blueprint: blueprint.identifier },
                  });
                }}
              >
                <span className="truncate">{localizedText(blueprint.title, locale)}</span>{' '}
                <span className="truncate text-xs text-muted-foreground">
                  {blueprint.identifier}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {items !== undefined && items.length > 0 && (
          <CommandGroup heading={t('command.entities')}>
            {items.map((item) => {
              const addressable = isAddressableIdentifier(item.identifier);
              return (
                <CommandItem
                  key={entityValue(item)}
                  value={entityValue(item)}
                  disabled={!addressable}
                  onSelect={() => {
                    onDone();
                    void router.navigate({
                      to: '/catalog/$blueprint/$entity',
                      params: { blueprint: item.blueprint, entity: item.identifier },
                    });
                  }}
                >
                  <div className="flex min-w-0 flex-col">
                    <div className="truncate">{item.title}</div>
                    <div className="flex gap-2 text-xs text-muted-foreground">
                      <span className="truncate">{item.identifier}</span>{' '}
                      <span className="truncate">
                        {blueprintTitle(blueprintList, item.blueprint, locale)}
                      </span>
                    </div>
                    {!addressable && (
                      <div className="text-xs text-muted-foreground">
                        {t('entity.notAddressable', { ns: 'catalog' })}
                      </div>
                    )}
                  </div>
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}
        {settled && (
          <CommandItem
            value={SEE_ALL_VALUE}
            onSelect={() => {
              onDone();
              void router.navigate({ to: '/search', search: { q: search } });
            }}
          >
            {t('command.seeAll')}
          </CommandItem>
        )}
      </CommandList>
      {failed && (
        <p role="alert" className="px-3 py-2 text-sm text-destructive">
          {t('command.error')}
        </p>
      )}
    </Command>
  );
}
