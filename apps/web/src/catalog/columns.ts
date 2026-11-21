/**
 * Catalog table columns (design D13, Q18 and Q36).
 *
 * The columns come from the blueprint: identifier, title, each spec property in schema
 * order, each relation, then `updatedAt`. "Schema order" is the key order the API
 * returns; nothing is sorted. The status schema is not a column source (its properties
 * show on the Details tab). Column ids are namespaced (`property:<key>`,
 * `relation:<key>`), so a key never collides with a fixed column.
 */
import type { CatalogContractClient } from '@tayzu/catalog/contract';

import { localizedText } from '../i18n/i18n.js';
import type { Locale } from '../i18n/i18n.js';

type Blueprint = Awaited<ReturnType<CatalogContractClient['blueprints']['get']>>;
type PropertyDefinition = Blueprint['schema']['properties'][string];
type RelationDefinition = Blueprint['relations'][string];

export type CatalogColumn =
  | { id: 'identifier'; kind: 'identifier'; header: string }
  | { id: 'title'; kind: 'title'; header: string }
  | {
      id: `property:${string}`;
      kind: 'property';
      key: string;
      header: string;
      definition: PropertyDefinition;
    }
  | {
      id: `relation:${string}`;
      kind: 'relation';
      key: string;
      header: string;
      definition: RelationDefinition;
    }
  | { id: 'updatedAt'; kind: 'updatedAt'; header: string };

/**
 * The table columns of `blueprint`. Pure: `t` is the `catalog` namespace's translate
 * function in `locale`, used for the fixed headers.
 */
export function columnsFor(
  blueprint: Blueprint,
  locale: Locale,
  t: (key: string) => string,
): CatalogColumn[] {
  const properties = Object.entries(blueprint.schema.properties).map(
    ([key, definition]): CatalogColumn => ({
      id: `property:${key}`,
      kind: 'property',
      key,
      header: localizedText(definition.title, locale),
      definition,
    }),
  );
  const relations = Object.entries(blueprint.relations).map(
    ([key, definition]): CatalogColumn => ({
      id: `relation:${key}`,
      kind: 'relation',
      key,
      header: localizedText(definition.title, locale),
      definition,
    }),
  );
  return [
    { id: 'identifier', kind: 'identifier', header: t('table.columns.identifier') },
    { id: 'title', kind: 'title', header: t('table.columns.title') },
    ...properties,
    ...relations,
    { id: 'updatedAt', kind: 'updatedAt', header: t('table.columns.updatedAt') },
  ];
}

/**
 * Whether an entity can be opened by URL (Q18, narrowed by Q36). An identifier with `/`
 * or made only of dots cannot be a route segment, so its link is disabled; `@`, `:` and
 * `=` travel unencoded and open normally.
 */
export function isAddressableIdentifier(identifier: string): boolean {
  return !identifier.includes('/') && !/^\.+$/.test(identifier);
}
