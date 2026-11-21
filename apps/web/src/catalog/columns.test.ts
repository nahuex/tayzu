/**
 * Catalog table columns (task 7.1, design D13, Q18 and Q36; spec "The catalog table
 * shows a blueprint's entities with sort and keyset paging" and "The entity page shows
 * details and relations").
 *
 * D13: "**Columns** come from the blueprint: identifier, title, then each spec property
 * in schema order, then each relation (target identifiers), then `updatedAt`. Headers
 * use the localized property title." D12: "Blueprint and property titles and
 * descriptions use their `{ en, es? }` value with `en` as the fallback."
 *
 * D13 (Q18, narrowed by Q36): "an entity whose identifier contains `/`, or is made only
 * of dots, is listed, but its link is disabled with a localized note [...] Identifiers
 * with `@`, `:` or `=` open normally, because neither the router nor the client encodes
 * those characters (D4, D12)."
 *
 * Decisions this test pins:
 * - The status schema is not a column source: the table shows the spec (D13 lists only
 *   spec properties and relations); status properties appear on the Details tab.
 * - "Schema order" is the key order of `blueprint.schema.properties` as the API returns
 *   it, and relations follow the key order of `blueprint.relations`. There is no order
 *   field in the contract, and the module never sorts.
 * - Column ids are namespaced, so a property or relation key never collides with a
 *   fixed column (a property may be called `title`).
 * - The fixed headers come from the `catalog` namespace through the `t` the caller
 *   passes (`table.columns.identifier`, `table.columns.title`,
 *   `table.columns.updatedAt`), so the module stays pure.
 *
 * Assumed API of `./columns.js`:
 *
 * ```ts
 * import type { CatalogContractClient } from '@tayzu/catalog/contract';
 * import type { Locale } from '../i18n/i18n.js';
 *
 * type Blueprint = Awaited<ReturnType<CatalogContractClient['blueprints']['get']>>;
 * type PropertyDefinition = Blueprint['schema']['properties'][string];
 * type RelationDefinition = Blueprint['relations'][string];
 *
 * export type CatalogColumn =
 *   | { id: 'identifier'; kind: 'identifier'; header: string }
 *   | { id: 'title'; kind: 'title'; header: string }
 *   | { id: `property:${string}`; kind: 'property'; key: string; header: string;
 *       definition: PropertyDefinition }
 *   | { id: `relation:${string}`; kind: 'relation'; key: string; header: string;
 *       definition: RelationDefinition }
 *   | { id: 'updatedAt'; kind: 'updatedAt'; header: string };
 *
 * // Pure. `t` is the `catalog` namespace's translate function in `locale`.
 * export function columnsFor(
 *   blueprint: Blueprint,
 *   locale: Locale,
 *   t: (key: string) => string,
 * ): CatalogColumn[];
 *
 * // False when the identifier contains `/` or is made only of dots; true otherwise.
 * export function isAddressableIdentifier(identifier: string): boolean;
 * ```
 */
import type { CatalogContractClient } from '@tayzu/catalog/contract';
import { describe, expect, it } from 'vitest';

import type { Locale } from '../i18n/i18n.js';

import { columnsFor, isAddressableIdentifier } from './columns.js';

type Blueprint = Awaited<ReturnType<CatalogContractClient['blueprints']['get']>>;

/** The `catalog` locale files, keyed `../i18n/locales/<lng>/catalog.json`. */
const CATALOG_FILES: Record<string, unknown> = import.meta.glob('../i18n/locales/*/catalog.json', {
  eager: true,
  import: 'default',
});

function lookup(locale: Locale, key: string): unknown {
  let node: unknown = CATALOG_FILES[`../i18n/locales/${locale}/catalog.json`];
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null || !Object.hasOwn(node, part)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** A `t` over the real `catalog` locale file; a missing key comes back marked. */
function tFor(locale: Locale): (key: string) => string {
  return (key) => {
    const value = lookup(locale, key);
    return typeof value === 'string' ? value : `missing:${key}`;
  };
}

const ACTOR = { type: 'user', id: 'u-1' } as const;

const EMPTY_SCHEMA: Blueprint['schema'] = { properties: {}, required: [] };

function blueprint(overrides: Partial<Blueprint> = {}): Blueprint {
  return {
    identifier: 'service',
    title: { en: 'Service', es: 'Servicio' },
    schema: EMPTY_SCHEMA,
    relations: {},
    version: 1,
    createdAt: '2026-11-01T00:00:00.000Z',
    createdBy: ACTOR,
    updatedAt: '2026-11-02T00:00:00.000Z',
    updatedBy: ACTOR,
    ...overrides,
  };
}

/**
 * Properties deliberately in neither alphabetical nor key-length order, one with a
 * Spanish title and one without, and one keyed like a fixed column.
 */
const SPEC_SCHEMA: Blueprint['schema'] = {
  properties: {
    tier: { type: 'string', title: { en: 'Tier', es: 'Nivel' }, enum: ['gold', 'silver'] },
    owner: { type: 'string', title: { en: 'Owner' }, format: 'email' },
    title: { type: 'string', title: { en: 'Display name', es: 'Nombre visible' } },
    docs: { type: 'string', title: { en: 'Docs', es: 'Documentación' }, format: 'url' },
    active: { type: 'boolean', title: { en: 'Active' } },
  },
  required: ['tier'],
};

const RELATIONS: Blueprint['relations'] = {
  team: { title: { en: 'Team', es: 'Equipo' }, target: 'team', many: false, required: true },
  dependsOn: {
    title: { en: 'Depends on' },
    target: 'service',
    many: true,
    required: false,
  },
};

/** A status schema with a key of its own and one shared with the spec. */
const STATUS_SCHEMA: Blueprint['schema'] = {
  properties: {
    health: { type: 'string', title: { en: 'Health', es: 'Salud' } },
    tier: { type: 'number', title: { en: 'Observed tier', es: 'Nivel observado' } },
  },
  required: [],
};

const FULL = blueprint({ schema: SPEC_SCHEMA, relations: RELATIONS, statusSchema: STATUS_SCHEMA });

describe('columnsFor: order', () => {
  it('lists identifier, title, the spec properties in schema order, the relations and updatedAt', () => {
    const columns = columnsFor(FULL, 'en', tFor('en'));
    expect(columns.map((column) => column.id)).toEqual([
      'identifier',
      'title',
      'property:tier',
      'property:owner',
      'property:title',
      'property:docs',
      'property:active',
      'relation:team',
      'relation:dependsOn',
      'updatedAt',
    ]);
    expect(columns.map((column) => column.kind)).toEqual([
      'identifier',
      'title',
      'property',
      'property',
      'property',
      'property',
      'property',
      'relation',
      'relation',
      'updatedAt',
    ]);
  });

  it('follows the key order it receives, without sorting', () => {
    const reversed = blueprint({
      schema: {
        properties: {
          active: { type: 'boolean', title: { en: 'Active' } },
          docs: { type: 'string', title: { en: 'Docs' }, format: 'url' },
          tier: { type: 'string', title: { en: 'Tier' } },
        },
        required: [],
      },
      relations: {
        dependsOn: { title: { en: 'Depends on' }, target: 'service', many: true, required: false },
        team: { title: { en: 'Team' }, target: 'team', many: false, required: false },
      },
    });
    expect(columnsFor(reversed, 'en', tFor('en')).map((column) => column.id)).toEqual([
      'identifier',
      'title',
      'property:active',
      'property:docs',
      'property:tier',
      'relation:dependsOn',
      'relation:team',
      'updatedAt',
    ]);
  });

  it('adds no column for a status property, and a key shared with the spec appears once', () => {
    const columns = columnsFor(FULL, 'en', tFor('en'));
    const ids = columns.map((column) => column.id);
    expect(ids).not.toContain('property:health');
    expect(ids.filter((id) => id === 'property:tier')).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);
    expect(columns.some((column) => column.header === 'Health')).toBe(false);
    expect(columns.some((column) => column.header === 'Observed tier')).toBe(false);
  });

  it('gives each property and relation column its key and its spec definition', () => {
    const columns = columnsFor(FULL, 'en', tFor('en'));
    const tier = columns.find((column) => column.id === 'property:tier');
    expect(tier).toMatchObject({
      kind: 'property',
      key: 'tier',
      definition: SPEC_SCHEMA.properties.tier,
    });
    const title = columns.find((column) => column.id === 'property:title');
    expect(title).toMatchObject({ kind: 'property', key: 'title' });
    const team = columns.find((column) => column.id === 'relation:team');
    expect(team).toMatchObject({ kind: 'relation', key: 'team', definition: RELATIONS.team });
    const dependsOn = columns.find((column) => column.id === 'relation:dependsOn');
    expect(dependsOn).toMatchObject({
      kind: 'relation',
      key: 'dependsOn',
      definition: RELATIONS.dependsOn,
    });
  });

  it('keeps only the fixed columns for a blueprint with no property and no relation', () => {
    const columns = columnsFor(blueprint(), 'en', tFor('en'));
    expect(columns.map((column) => column.id)).toEqual(['identifier', 'title', 'updatedAt']);
  });
});

describe('columnsFor: localized and fallback titles', () => {
  function headers(locale: Locale): Record<string, string> {
    return Object.fromEntries(
      columnsFor(FULL, locale, tFor(locale)).map((column) => [column.id, column.header]),
    );
  }

  it('uses the English property and relation titles in en, even when es exists', () => {
    expect(headers('en')).toMatchObject({
      'property:tier': 'Tier',
      'property:owner': 'Owner',
      'property:title': 'Display name',
      'property:docs': 'Docs',
      'property:active': 'Active',
      'relation:team': 'Team',
      'relation:dependsOn': 'Depends on',
    });
  });

  it('uses the Spanish titles in es and falls back to en where es is missing', () => {
    expect(headers('es')).toMatchObject({
      'property:tier': 'Nivel',
      'property:owner': 'Owner',
      'property:title': 'Nombre visible',
      'property:docs': 'Documentación',
      'property:active': 'Active',
      'relation:team': 'Equipo',
      'relation:dependsOn': 'Depends on',
    });
  });

  it.each(['en', 'es'] as const)(
    'takes the fixed headers from the %s catalog locale file',
    (locale) => {
      const byId = headers(locale);
      for (const [id, key] of [
        ['identifier', 'table.columns.identifier'],
        ['title', 'table.columns.title'],
        ['updatedAt', 'table.columns.updatedAt'],
      ] as const) {
        const expected = lookup(locale, key);
        expect(typeof expected, `${locale} ${key}`).toBe('string');
        expect(expected, `${locale} ${key}`).not.toBe('');
        expect(byId[id]).toBe(expected);
      }
    },
  );

  it('localizes the fixed headers: es differs from en', () => {
    const en = headers('en');
    const es = headers('es');
    for (const id of ['identifier', 'title', 'updatedAt']) {
      expect(es[id], id).not.toBe(en[id]);
    }
  });
});

describe('isAddressableIdentifier (Q18, Q36)', () => {
  it.each(['payments/api', 'a/b', 'team/payments/ledger'])(
    'marks %j, which contains /, as not addressable',
    (identifier) => {
      expect(isAddressableIdentifier(identifier)).toBe(false);
    },
  );

  it.each(['.', '..', '...', '....'])(
    'marks %j, made only of dots, as not addressable',
    (identifier) => {
      expect(isAddressableIdentifier(identifier)).toBe(false);
    },
  );

  it.each(['team@example.com:prod=1', 'alice@example.com', 'urn:service', 'key=value'])(
    'marks %j, with @, : or =, as addressable',
    (identifier) => {
      expect(isAddressableIdentifier(identifier)).toBe(true);
    },
  );

  it.each(['payments', 'payments.api', '.hidden', 'a..b', '..a', 'v1.2.3'])(
    'marks %j, which has dots but not only dots, as addressable',
    (identifier) => {
      expect(isAddressableIdentifier(identifier)).toBe(true);
    },
  );
});
