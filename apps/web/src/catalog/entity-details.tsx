/**
 * The entity page's Details tab (design D13, Q82 and Q86).
 *
 * Two regions side by side, Spec and Status, each labelled by its level-2 heading. Spec
 * is a description list of every property of `schema.properties`, in the order the API
 * returns them (never sorted), with full values: no truncation, and markdown rendered
 * whole by the safe renderer. Status, when the entity has one, lists the properties of
 * `statusSchema.properties` the same way, then the whole status's observed generation,
 * source and observed time, once each. A status schema is its own property schema, so
 * status values are never paired with spec values by key. With no status, the region
 * shows a note and no term.
 */
import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { ApiClient } from '../api/client.js';
import { localizedText, type Locale } from '../i18n/i18n.js';
import { formatDate } from '../lib/format.js';

import { PropertyValue } from './cells.js';
import type { PropertyDefinition } from './columns.js';
import { Field } from './field.js';

type Blueprint = Awaited<ReturnType<ApiClient['blueprints']['get']>>;
type Entity = Awaited<ReturnType<ApiClient['entities']['get']>>;

/** The value of `key` in a raw JSON value record, own keys only. */
function valueOf(values: Readonly<Record<string, unknown>>, key: string): unknown {
  return Object.hasOwn(values, key) ? values[key] : undefined;
}

/** One `Field` per property of `properties`, in the order the API returns them. */
function PropertyFields(props: {
  readonly properties: Readonly<Record<string, PropertyDefinition>>;
  readonly values: Readonly<Record<string, unknown>>;
  readonly locale: Locale;
}): React.JSX.Element {
  const { properties, values, locale } = props;
  return (
    <>
      {Object.entries(properties).map(([key, definition]) => (
        <Field key={key} label={localizedText(definition.title, locale)}>
          <PropertyValue value={valueOf(values, key)} schema={definition} locale={locale} full />
        </Field>
      ))}
    </>
  );
}

/** A region labelled by its level-2 heading. */
function Section(props: {
  readonly title: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3">
      <h2 id={headingId} className="text-base font-semibold">
        {props.title}
      </h2>
      {props.children}
    </section>
  );
}

/** The Details panel's content: the Spec and Status regions of `entity`. */
export function EntityDetails(props: {
  readonly blueprint: Blueprint;
  readonly entity: Entity;
  readonly locale: Locale;
}): React.JSX.Element {
  const { blueprint, entity, locale } = props;
  const { t } = useTranslation('catalog');
  const status = entity.status;
  return (
    <div className="grid gap-6 pt-4 md:grid-cols-2">
      <Section title={t('entity.details.spec.title')}>
        <dl className="flex flex-col gap-3 text-sm">
          <PropertyFields
            properties={blueprint.schema.properties}
            values={entity.spec.properties}
            locale={locale}
          />
        </dl>
      </Section>
      <Section title={t('entity.details.status.title')}>
        {status === null ? (
          <p className="text-sm text-muted-foreground">{t('entity.details.status.none')}</p>
        ) : (
          <dl className="flex flex-col gap-3 text-sm">
            <PropertyFields
              properties={blueprint.statusSchema?.properties ?? {}}
              values={status.properties}
              locale={locale}
            />
            <Field label={t('entity.details.status.observedGeneration')}>
              {String(status.observedGeneration)}
            </Field>
            <Field label={t('entity.details.status.source')}>{status.source}</Field>
            <Field label={t('entity.details.status.observedAt')}>
              {formatDate(status.observedAt, locale)}
            </Field>
          </dl>
        )}
      </Section>
    </div>
  );
}
