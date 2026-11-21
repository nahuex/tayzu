/**
 * The entity page, `/catalog/$blueprint/$entity` (design D13, D12, D16 and Q36, Q68,
 * Q84, Q85).
 *
 * The entity (`entities.get`) and its blueprint (`blueprints.get`, for the localized
 * title and, in the Details tab, the schema) are read once each; a tab switch reads
 * neither again. The header is a description list of identifier, blueprint (a link back
 * to the table, D13 having no breadcrumb), created and updated time and actor (the
 * localized type and the opaque id; a delegating `onBehalfOf` principal is not shown),
 * version and generation.
 *
 * The selected tab is the URL's `tab`; choosing one writes it there, and the route strips
 * the default `details` (Q68). Only the selected tab's panel is rendered. The Details
 * panel is `EntityDetails` (Q86).
 *
 * States, as the table's (Q84): a busy status while either call is pending; the
 * not-found page for a `not_found` answer of either call, the same for another tenant's
 * entity; otherwise one alert whose localized text depends on the error kind only, never
 * on the server's message.
 */
import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useRouter, useSearch } from '@tanstack/react-router';
import { Suspense } from 'react';
import { useTranslation } from 'react-i18next';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

import { useApiClient } from '../api/api-client-context.js';
import type { ApiClient } from '../api/client.js';
import { toApiError, type ApiError } from '../api/errors.js';
import { NotFoundPage } from '../app/not-found-page.js';
import { ENTITY_TABS, entitySearchSchema, type EntitySearch } from '../app/search-params.js';
import { currentLocale, localizedText } from '../i18n/i18n.js';
import { formatDate } from '../lib/format.js';

import { EntityDetails } from './entity-details.js';
import { Field } from './field.js';

type Entity = Awaited<ReturnType<ApiClient['entities']['get']>>;
type Actor = Entity['createdBy'];
type EntityTab = EntitySearch['tab'];

type ErrorMessageKey =
  'entity.error.forbidden' | 'entity.error.server' | 'entity.error.rateLimited';

/** The localized text of a failure, by kind only; every other kind is the generic one. */
function errorMessageKey(error: ApiError): ErrorMessageKey {
  switch (error.kind) {
    case 'forbidden':
      return 'entity.error.forbidden';
    case 'rate_limited':
      return 'entity.error.rateLimited';
    default:
      return 'entity.error.server';
  }
}

const ACTOR_TYPE_KEYS = {
  user: 'entity.actorType.user',
  agent: 'entity.actorType.agent',
  integration: 'entity.actorType.integration',
  system: 'entity.actorType.system',
} as const satisfies Record<Actor['type'], string>;

const TAB_KEYS = {
  details: 'entity.tabs.details',
  related: 'entity.tabs.related',
} as const satisfies Record<EntityTab, string>;

function isEntityTab(value: string): value is EntityTab {
  return (ENTITY_TABS as readonly string[]).includes(value);
}

function ActorValue({ actor }: { readonly actor: Actor }): React.JSX.Element {
  const { t } = useTranslation('catalog');
  return (
    <>
      <span>{t(ACTOR_TYPE_KEYS[actor.type])}</span>{' '}
      <span className="font-mono text-xs">{actor.id}</span>
    </>
  );
}

function EntityPageContent(): React.JSX.Element | null {
  const { t, i18n } = useTranslation('catalog');
  const locale = currentLocale(i18n);
  const apiClient = useApiClient();
  const router = useRouter();
  // `unknown`: the hooks are typed `any` inside the tree that the router type comes from.
  const params: unknown = useParams({ strict: false });
  const rawSearch: unknown = useSearch({ strict: false });
  const { blueprint, entity } = params as { blueprint: string; entity: string };
  const { tab } = entitySearchSchema.parse(rawSearch);

  const blueprintQuery = useQuery({
    queryKey: ['blueprints', 'get', { blueprint }],
    queryFn: () => apiClient.blueprints.get({ blueprint }),
  });
  const entityQuery = useQuery({
    queryKey: ['entities', 'get', { blueprint, entity }],
    queryFn: () => apiClient.entities.get({ blueprint, entity }),
  });

  const errors = [blueprintQuery.error, entityQuery.error]
    .filter((error) => error !== null)
    .map((error) => toApiError(error));
  if (errors.some((error) => error.kind === 'not_found')) return <NotFoundPage />;
  // The shell clears the session and lands on sign-in (Q69).
  if (errors.some((error) => error.kind === 'unauthenticated')) return null;
  const failure = errors[0];
  if (failure !== undefined) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <Alert variant="destructive">
          <AlertDescription>{t(errorMessageKey(failure))}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const definition = blueprintQuery.data;
  const item = entityQuery.data;
  if (definition === undefined || item === undefined) {
    return (
      <div className="p-4">
        <p role="status" aria-busy="true">
          {t('entity.loading')}
        </p>
      </div>
    );
  }

  const onTabChange = (value: string): void => {
    if (!isEntityTab(value)) return;
    void router.navigate({
      to: '/catalog/$blueprint/$entity',
      params: { blueprint, entity },
      search: { tab: value },
    });
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <h1 className="text-xl font-semibold">{item.title}</h1>
      <dl className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
        <Field label={t('entity.fields.identifier')}>
          <span className="font-mono">{item.identifier}</span>
        </Field>
        <Field label={t('entity.fields.blueprint')}>
          <Link
            to="/catalog/$blueprint"
            params={{ blueprint }}
            className="underline underline-offset-4"
          >
            {localizedText(definition.title, locale)}
          </Link>
        </Field>
        <Field label={t('entity.fields.createdAt')}>{formatDate(item.createdAt, locale)}</Field>
        <Field label={t('entity.fields.createdBy')}>
          <ActorValue actor={item.createdBy} />
        </Field>
        <Field label={t('entity.fields.updatedAt')}>{formatDate(item.updatedAt, locale)}</Field>
        <Field label={t('entity.fields.updatedBy')}>
          <ActorValue actor={item.updatedBy} />
        </Field>
        <Field label={t('entity.fields.version')}>{item.version}</Field>
        <Field label={t('entity.fields.generation')}>{item.generation}</Field>
      </dl>
      <Tabs value={tab} onValueChange={onTabChange}>
        <TabsList aria-label={t('entity.tabs.label')}>
          {ENTITY_TABS.map((value) => (
            <TabsTrigger key={value} value={value}>
              {t(TAB_KEYS[value])}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="details">
          <EntityDetails blueprint={definition} entity={item} locale={locale} />
        </TabsContent>
        {/* The Related panel's content comes with task 8.3. */}
        <TabsContent value="related" />
      </Tabs>
    </div>
  );
}

/** The `entity` page. The `catalog` namespace loads on demand, inside its own boundary. */
export function EntityPage(): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <EntityPageContent />
    </Suspense>
  );
}
