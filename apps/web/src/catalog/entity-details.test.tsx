/**
 * The entity page's Details tab (task 8.2, design D13, D16 and Q16, Q70, Q82, Q85; spec
 * "The entity page shows details and relations").
 *
 * Spec (requirement): "The app MUST show an entity page with [...] a Details tab with the
 * spec properties and, when present, the status properties with their observed
 * generation, source and time".
 * Spec, scenario "Status shown next to spec": GIVEN an entity with status written by an
 * integration, WHEN the user opens its Details tab, THEN the status properties are shown
 * with their observed generation and source.
 * D13 (Entity page): "**Details tab**: the spec properties in schema order and, when
 * present, the status properties with `observedGeneration`, source and observed time;
 * markdown values rendered by the markdown renderer below."
 * D13 (Safe rendering): "Markdown goes through `react-markdown` with raw HTML skipped,
 * images disallowed [...], and a URL transform that keeps only `http:`, `https:` and
 * `mailto:`." Q70: a markdown link whose target is dropped renders as text, with no
 * `href`.
 * Q82: "schema order" is the key order the API returns; the UI never sorts.
 *
 * Contract (`entities.get`): `spec.properties` is a record of raw JSON values;
 * `status` is `null` or one whole-status object `{ properties, relations,
 * observedGeneration, observedAt, source }` (no per-property metadata). The blueprint
 * (`blueprints.get`, already read by the page, Q85) has `schema` and an optional
 * `statusSchema`, each `{ properties, required }`.
 *
 * Decisions this test pins:
 *
 * - The Details panel (the `tabpanel` named `catalog:entity.tabs.details`) holds two
 *   sections side by side, which is what "next to" means here: a `region` named
 *   `catalog:entity.details.spec.title` and a `region` named
 *   `catalog:entity.details.status.title` (for example a `<section>` labelled by its
 *   level-2 heading). A status schema is its own property schema, whose keys need not
 *   match the spec's, so status values are not paired with spec values by key.
 * - Spec region: a description list with one `<dt>` per property of `schema.properties`,
 *   in the order the API returns them (never sorted, and not the order of the entity's
 *   value object), each the localized property title followed by its `<dd>`. A
 *   property with no value is still listed, with the cells' empty marker
 *   (`catalog:cells.empty`).
 * - Values are rendered by type as the table cells are (D13 "Cells": numbers through
 *   `formatNumber`, booleans as `catalog:cells.yes` or `catalog:cells.no`, `url` through
 *   the safe link, `date-time` through `formatDate`), but in full: no truncation and no
 *   tooltip trigger on the Details tab, and a `markdown` value is the full `Markdown`
 *   rendering (`lib/markdown.tsx`), not its first line.
 * - Status region, when `status` is not null: the status properties of
 *   `statusSchema.properties` in the order the API returns them, as `<dt>`/`<dd>` pairs
 *   rendered like the spec's, and three `<dt>`/`<dd>` pairs:
 *   `catalog:entity.details.status.observedGeneration` (the number, as text),
 *   `catalog:entity.details.status.source` (the source, as React text) and
 *   `catalog:entity.details.status.observedAt` (`formatDate(observedAt, locale)`).
 *   Whether those three share the properties' `<dl>` is left open.
 * - Status region, when `status` is `null`: the note `catalog:entity.details.status.none`,
 *   and no observed generation, source, time or status property.
 * - Left open: how a stale status (observed generation below the entity's generation)
 *   reads (D13 does not say), whether relations appear on Details (D13 lists only
 *   properties; relations are the Related tab's), and the region when the blueprint has
 *   no status schema.
 * - English texts are pinned below; the key-parity test keeps `es` complete.
 *
 * The network is a fake `fetch` behind the real API and auth clients (D16), the page is
 * the router's real `entity` slot inside the real shell, and the query client is
 * `createQueryClient()` with no retry delay.
 */
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthClientProvider } from '../api/auth-client-context.js';
import { createAuthClient } from '../api/auth-client.js';
import { createApiClient } from '../api/client.js';
import { createQueryClient } from '../api/query-client.js';
import { createAppRouter, type PageName } from '../app/router.js';
import { createI18n, type Locale } from '../i18n/i18n.js';
import { formatDate, formatNumber } from '../lib/format.js';
import { SAFE_LINK_REL, SAFE_LINK_TARGET } from '../lib/safe-link.js';
import { createThemeStore } from '../state/theme.js';

// ---------------------------------------------------------------------------
// Locale texts

const LOCALE_FILES: Record<string, unknown> = import.meta.glob('../i18n/locales/*/*.json', {
  eager: true,
  import: 'default',
});

/** The `catalog:<key>` text in `locale`; a missing key fails the test as an assertion. */
function localeText(locale: Locale, key: string): string {
  let node: unknown = LOCALE_FILES[`../i18n/locales/${locale}/catalog.json`];
  for (const part of key.split('.')) {
    node =
      typeof node === 'object' && node !== null && Object.hasOwn(node, part)
        ? (node as Record<string, unknown>)[part]
        : undefined;
  }
  expect(typeof node === 'string' && node !== '', `catalog:${key} in ${locale}`).toBe(true);
  return node as string;
}

/** The pinned English texts of this task's `catalog:entity.details.*` keys. */
const PINNED = {
  'entity.details.spec.title': 'Spec',
  'entity.details.status.title': 'Status',
  'entity.details.status.observedGeneration': 'Observed generation',
  'entity.details.status.source': 'Source',
  'entity.details.status.observedAt': 'Observed',
  'entity.details.status.none': 'No status has been reported for this entity.',
} as const;

type PinnedKey = keyof typeof PINNED;

/** The English text of a pinned key, checked against the `en` locale file. */
function text(key: PinnedKey): string {
  const shown = localeText('en', key);
  expect(shown, `catalog:${key}`).toBe(PINNED[key]);
  return shown;
}

// ---------------------------------------------------------------------------
// Fixtures

type ActorType = 'user' | 'agent' | 'integration' | 'system';

interface Actor {
  readonly type: ActorType;
  readonly id: string;
}

const MEMBER: Actor = { type: 'user', id: 'u_1' };
const GITHUB: Actor = { type: 'integration', id: 'int_github' };

const ME = {
  user: { id: 'u_1', name: 'Mia Moreno', email: 'mia@example.com' },
  organization: { id: 'org_1', name: 'Acme' },
  role: 'member',
  signInMethod: 'password',
  mfa: { enrolled: false },
  gate: 'none',
} as const;

/**
 * The spec schema, in the order the API returns it: neither alphabetical by key nor by
 * title, in either locale.
 */
const SPEC_PROPERTIES = {
  tier: { type: 'string', title: { en: 'Tier', es: 'Nivel' } },
  replicas: { type: 'integer', title: { en: 'Replicas', es: 'Réplicas' } },
  description: {
    type: 'string',
    format: 'markdown',
    title: { en: 'Description', es: 'Descripción' },
  },
  docs: { type: 'string', format: 'url', title: { en: 'Documentation', es: 'Documentación' } },
  public: { type: 'boolean', title: { en: 'Public', es: 'Público' } },
  notes: { type: 'string', title: { en: 'Notes', es: 'Notas' } },
  runbook: { type: 'string', title: { en: 'Runbook', es: 'Manual' } },
} as const;

const SPEC_TITLES_EN = [
  'Tier',
  'Replicas',
  'Description',
  'Documentation',
  'Public',
  'Notes',
  'Runbook',
];
const SPEC_TITLES_ES = [
  'Nivel',
  'Réplicas',
  'Descripción',
  'Documentación',
  'Público',
  'Notas',
  'Manual',
];

/** The status schema, in the order the API returns it (not alphabetical). */
const STATUS_PROPERTIES = {
  readyReplicas: { type: 'integer', title: { en: 'Ready replicas', es: 'Réplicas listas' } },
  health: {
    type: 'string',
    enum: ['healthy', 'degraded'],
    title: { en: 'Health', es: 'Salud' },
  },
  lastDeployedAt: {
    type: 'string',
    format: 'date-time',
    title: { en: 'Last deployed', es: 'Último despliegue' },
  },
} as const;

const STATUS_TITLES_EN = ['Ready replicas', 'Health', 'Last deployed'];

const SERVICE = {
  identifier: 'service',
  title: { en: 'Service', es: 'Servicio' },
  schema: { properties: SPEC_PROPERTIES, required: [] },
  statusSchema: { properties: STATUS_PROPERTIES, required: [] },
  relations: {},
  version: 1,
  createdAt: '2026-08-01T10:00:00.000Z',
  createdBy: MEMBER,
  updatedAt: '2026-08-01T10:00:00.000Z',
  updatedBy: MEMBER,
};

/** A markdown value with raw HTML, an image and an unsafe link, none of which may render. */
const MARKDOWN = [
  'Handles **card payments** for the store.',
  '',
  '<script>window.__tayzuPwned = true</script>',
  '',
  '<img src="https://tracker.example/raw.gif" onerror="window.__tayzuPwned = true">',
  '',
  '<iframe src="https://evil.example/frame"></iframe>',
  '',
  'Some <b>raw</b> inline HTML.',
  '',
  '- Owned by the payments team',
  '- Runbook in [the wiki](https://wiki.example.com/payments)',
  '',
  '![pixel](https://tracker.example/pixel.png)',
  '',
  'Do not [click this](javascript:alert(1)).',
  '',
  'Last paragraph of the description.',
].join('\n');

/** Longer than the table cells' truncation limit (100 code points). */
const LONG_NOTE = `Rotate the signing keys every quarter. ${'Keep the old key for one week. '.repeat(4)}End of notes.`;

const OBSERVED_AT = '2026-11-04T12:00:00.000Z';
const LAST_DEPLOYED_AT = '2026-11-03T09:15:00.000Z';

function entity(identifier: string, title: string, extra: Record<string, unknown>) {
  return {
    blueprint: 'service',
    identifier,
    title,
    spec: { properties: {}, relations: {} },
    status: null,
    generation: 1,
    version: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    createdBy: MEMBER,
    updatedAt: '2026-10-01T00:00:00.000Z',
    updatedBy: MEMBER,
    ...extra,
  };
}

/**
 * An entity whose status an integration wrote. Its value object lists the properties in
 * an order of its own, so the Details tab must follow the schema, not the values.
 */
const PAYMENTS = entity('svc-payments', 'Payments API', {
  spec: {
    properties: {
      notes: LONG_NOTE,
      public: true,
      tier: 'gold',
      docs: 'https://docs.example.com/payments',
      replicas: 12000,
      description: MARKDOWN,
    },
    relations: {},
  },
  status: {
    properties: { health: 'degraded', lastDeployedAt: LAST_DEPLOYED_AT, readyReplicas: 2 },
    relations: {},
    observedGeneration: 3,
    observedAt: OBSERVED_AT,
    source: 'github-actions',
  },
  generation: 4,
  version: 7,
  updatedBy: GITHUB,
});

/** An entity no integration has reported on: `status` is `null`. */
const INVENTORY = entity('svc-inventory', 'Inventory', {
  spec: { properties: { tier: 'silver', replicas: 3 }, relations: {} },
  status: null,
});

const ENTITIES = [PAYMENTS, INVENTORY];

// ---------------------------------------------------------------------------
// The fake API

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const notFound = (): Response =>
  jsonResponse(404, { defined: false, code: 'CATALOG_NOT_FOUND', status: 404, message: 'x' });

/**
 * A fake `fetch` playing the API for a signed-in member: `GET /v1/me`, `blueprints.list`,
 * `blueprints.get`, `entities.list`, `entities.get` and `entities.listRelated` (empty).
 */
function createFakeServer() {
  const fetch = async (input: Request, init?: RequestInit): Promise<Response> => {
    await Promise.resolve();
    const request = new Request(input, init);
    const { pathname } = new URL(request.url);
    if (request.method !== 'GET') return jsonResponse(405, {});
    if (pathname === '/v1/me') return jsonResponse(200, ME);
    if (pathname === '/v1/blueprints') return jsonResponse(200, { items: [SERVICE] });
    if (pathname === '/v1/blueprints/service') return jsonResponse(200, SERVICE);
    if (pathname === '/v1/blueprints/service/entities') {
      return jsonResponse(200, { items: ENTITIES });
    }
    const match = /^\/v1\/blueprints\/service\/entities\/([^/]+)(\/related)?$/.exec(pathname);
    const found = ENTITIES.find((item) => item.identifier === match?.[1]);
    if (match === null || found === undefined) return notFound();
    return match[2] === undefined ? jsonResponse(200, found) : jsonResponse(200, { items: [] });
  };
  return { fetch };
}

// ---------------------------------------------------------------------------
// Rendering

function probe(name: PageName): ComponentType {
  return function Probe(): React.JSX.Element {
    return <div data-testid={`page-${name}`} />;
  };
}

/** Every slot but `catalogTable` and `entity` is a probe, so those two keep their pages. */
const PROBES = {
  signIn: probe('signIn'),
  forgotPassword: probe('forgotPassword'),
  resetPassword: probe('resetPassword'),
  acceptInvitation: probe('acceptInvitation'),
  changePassword: probe('changePassword'),
  mfaEnrol: probe('mfaEnrol'),
  stepUpComplete: probe('stepUpComplete'),
  home: probe('home'),
  search: probe('search'),
};

/** Renders the whole app as `main.tsx` does at `path`, with no retry delay. */
async function renderApp(path: string): Promise<void> {
  const server = createFakeServer();
  const history = createMemoryHistory({ initialEntries: [path] });
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({
    ...queryClient.getDefaultOptions(),
    queries: { ...queryClient.getDefaultOptions().queries, retryDelay: 0 },
  });
  const authClient = createAuthClient({ fetch: server.fetch });
  const apiClient = createApiClient({ fetch: server.fetch });
  const router = createAppRouter({
    history,
    pages: PROBES,
    session: { authClient, queryClient },
    shell: { apiClient, authClient, themeStore: createThemeStore() },
  });
  const i18n = await createI18n();
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <AuthClientProvider client={authClient}>
          <RouterProvider router={router} />
        </AuthClientProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

/** The shell's `main` landmark, once the entity page's heading is shown in it. */
async function findEntityMain(title: string): Promise<HTMLElement> {
  const main = await screen.findByRole('main', {}, { timeout: 3000 });
  await within(main).findByRole('heading', { level: 1, name: title }, { timeout: 3000 });
  return main;
}

/** The Details panel, named by its tab. */
async function findDetailsPanel(main: HTMLElement): Promise<HTMLElement> {
  return within(main).findByRole(
    'tabpanel',
    { name: localeText('en', 'entity.tabs.details') },
    { timeout: 3000 },
  );
}

/** The `region` named `name` inside `panel`, with its level-2 heading. */
function section(panel: HTMLElement, name: string): HTMLElement {
  const region = within(panel).getByRole('region', { name });
  expect(within(region).getByRole('heading', { level: 2, name })).toBeInTheDocument();
  return region;
}

/** The spec and status regions of the Details panel, once shown. */
async function findSections(
  panel: HTMLElement,
  locale: Locale = 'en',
): Promise<{ spec: HTMLElement; status: HTMLElement }> {
  const specName =
    locale === 'en'
      ? text('entity.details.spec.title')
      : localeText(locale, 'entity.details.spec.title');
  await within(panel).findByRole('region', { name: specName }, { timeout: 3000 });
  return {
    spec: section(panel, specName),
    status: section(
      panel,
      locale === 'en'
        ? text('entity.details.status.title')
        : localeText(locale, 'entity.details.status.title'),
    ),
  };
}

/** The trimmed texts of every `<dt>` in `scope`, in document order. */
function termTexts(scope: HTMLElement): string[] {
  return [...scope.querySelectorAll('dt')].map((term) => term.textContent.trim());
}

/** The `<dd>` that follows the one `<dt>` reading `label` in `scope`. */
function field(scope: HTMLElement, label: string): HTMLElement {
  const terms = [...scope.querySelectorAll('dt')].filter(
    (term) => term.textContent.trim() === label,
  );
  expect(terms, `one <dt> "${label}"`).toHaveLength(1);
  const value = terms[0]?.nextElementSibling;
  expect(value?.tagName, `the <dd> after "${label}"`).toBe('DD');
  return value as HTMLElement;
}

/** The text of an element with its white space collapsed. */
function shownText(element: Element): string {
  return element.textContent.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// jsdom gaps

/** Methods the Radix components call that jsdom does not implement. */
const ELEMENT_STUBS = [
  'hasPointerCapture',
  'setPointerCapture',
  'releasePointerCapture',
  'scrollIntoView',
] as const;

const addedStubs: string[] = [];

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {
        // Intentionally empty.
      }
      unobserve(): void {
        // Intentionally empty.
      }
      disconnect(): void {
        // Intentionally empty.
      }
    },
  );
  for (const name of ELEMENT_STUBS) {
    if (name in Element.prototype) continue;
    Object.defineProperty(Element.prototype, name, {
      configurable: true,
      writable: true,
      value: () => false,
    });
    addedStubs.push(name);
  }
});

afterAll(() => {
  vi.unstubAllGlobals();
  for (const name of addedStubs) Reflect.deleteProperty(Element.prototype, name);
});

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
  // jsdom does not implement scrolling; the router restores scroll on navigation.
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, '__tayzuPwned');
});

// ---------------------------------------------------------------------------
// Tests

describe('the Details tab', () => {
  it('Status shown next to spec', async () => {
    // GIVEN an entity with status written by an integration
    expect(PAYMENTS.updatedBy.type).toBe('integration');
    await renderApp('/catalog/service/svc-payments?tab=related');
    const main = await findEntityMain('Payments API');

    // WHEN the user opens its Details tab
    const user = userEvent.setup();
    await user.click(
      within(main).getByRole('tab', { name: localeText('en', 'entity.tabs.details') }),
    );
    const panel = await findDetailsPanel(main);

    // THEN the status properties are shown with their observed generation and source,
    // next to the spec (D13: and the observed time).
    const { spec, status } = await findSections(panel);

    const statusTitles = termTexts(status).filter((label) => STATUS_TITLES_EN.includes(label));
    expect(statusTitles, 'status properties in schema order').toEqual(STATUS_TITLES_EN);
    expect(shownText(field(status, 'Ready replicas'))).toBe(formatNumber(2, 'en'));
    expect(shownText(field(status, 'Health'))).toBe('degraded');
    expect(shownText(field(status, 'Last deployed'))).toBe(formatDate(LAST_DEPLOYED_AT, 'en'));

    expect(shownText(field(status, text('entity.details.status.observedGeneration')))).toBe('3');
    expect(shownText(field(status, text('entity.details.status.source')))).toBe('github-actions');
    expect(shownText(field(status, text('entity.details.status.observedAt')))).toBe(
      formatDate(OBSERVED_AT, 'en'),
    );
    expect(within(status).queryByText(text('entity.details.status.none'))).toBeNull();

    // Next to the spec, each in its own section.
    expect(termTexts(spec)).toEqual(SPEC_TITLES_EN);
    expect(shownText(field(spec, 'Tier'))).toBe('gold');
    expect(spec.contains(status)).toBe(false);
    expect(status.contains(spec)).toBe(false);
    for (const label of SPEC_TITLES_EN) expect(termTexts(status)).not.toContain(label);
    for (const label of STATUS_TITLES_EN) expect(termTexts(spec)).not.toContain(label);
    expect(spec.textContent).not.toContain('github-actions');
    expect(termTexts(spec)).not.toContain(PINNED['entity.details.status.observedGeneration']);
  });

  it('shows the note and no status values for an entity with no status', async () => {
    await renderApp('/catalog/service/svc-inventory');
    const main = await findEntityMain('Inventory');
    const panel = await findDetailsPanel(main);
    const { spec, status } = await findSections(panel);

    expect(termTexts(spec)).toEqual(SPEC_TITLES_EN);
    expect(shownText(field(spec, 'Tier'))).toBe('silver');
    expect(shownText(field(spec, 'Replicas'))).toBe(formatNumber(3, 'en'));

    expect(within(status).getByText(text('entity.details.status.none'))).toBeInTheDocument();
    expect(status.querySelectorAll('dt')).toHaveLength(0);
    for (const key of [
      'entity.details.status.observedGeneration',
      'entity.details.status.source',
      'entity.details.status.observedAt',
    ] as const) {
      expect(termTexts(panel)).not.toContain(text(key));
    }
    for (const label of STATUS_TITLES_EN) expect(termTexts(panel)).not.toContain(label);
  });

  it('renders a markdown value in full without raw HTML, images or unsafe links', async () => {
    await renderApp('/catalog/service/svc-payments');
    const main = await findEntityMain('Payments API');
    const panel = await findDetailsPanel(main);
    const { spec } = await findSections(panel);
    const value = field(spec, 'Description');

    // Rendered as markdown, in full (not the table's first line).
    expect(within(value).getByText('card payments').tagName).toBe('STRONG');
    expect(within(value).getAllByRole('listitem')).toHaveLength(2);
    expect(within(value).getByText('Last paragraph of the description.')).toBeInTheDocument();
    const link = within(value).getByRole('link', { name: 'the wiki' });
    expect(link).toHaveAttribute('href', 'https://wiki.example.com/payments');
    expect(link).toHaveAttribute('rel', SAFE_LINK_REL);
    expect(link).toHaveAttribute('target', SAFE_LINK_TARGET);

    // No raw HTML: neither as elements nor as text.
    expect(value.querySelector('script, img, iframe, b, [onerror]')).toBeNull();
    expect(main.querySelector('script, img, iframe, [onerror]')).toBeNull();
    expect(value.textContent).not.toContain('<script');
    expect(value.textContent).not.toContain('__tayzuPwned');
    expect(value.textContent).not.toContain('tracker.example');
    expect(value.textContent).not.toContain('evil.example');
    expect(Reflect.get(window, '__tayzuPwned')).toBeUndefined();

    // An unsafe link keeps its text and loses its target.
    expect(within(value).getByText('click this')).toBeInTheDocument();
    expect(within(value).queryByRole('link', { name: 'click this' })).toBeNull();
    expect(value.querySelectorAll('a[href]')).toHaveLength(1);
    expect(value.querySelector('[href^="javascript"]')).toBeNull();
  });

  it('shows the spec properties in schema order with full values', async () => {
    await renderApp('/catalog/service/svc-payments');
    const main = await findEntityMain('Payments API');
    const panel = await findDetailsPanel(main);
    const { spec } = await findSections(panel);

    expect(termTexts(spec)).toEqual(SPEC_TITLES_EN);
    expect(shownText(field(spec, 'Tier'))).toBe('gold');
    expect(shownText(field(spec, 'Replicas'))).toBe(formatNumber(12000, 'en'));
    expect(shownText(field(spec, 'Public'))).toBe(localeText('en', 'cells.yes'));
    const docs = within(field(spec, 'Documentation')).getByRole('link', {
      name: 'https://docs.example.com/payments',
    });
    expect(docs).toHaveAttribute('href', 'https://docs.example.com/payments');
    expect(docs).toHaveAttribute('rel', SAFE_LINK_REL);

    // Full values: no truncation, no tooltip trigger.
    const notes = field(spec, 'Notes');
    expect(Array.from(LONG_NOTE).length).toBeGreaterThan(100);
    expect(notes.textContent).toBe(LONG_NOTE);
    expect(within(notes).queryByRole('button')).toBeNull();

    // A property with no value is still listed, with the empty marker.
    expect(field(spec, 'Runbook')).toHaveTextContent(localeText('en', 'cells.empty'));
  });

  it('shows the localized property titles in Spanish, in the same order', async () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('es-ES');
    await renderApp('/catalog/service/svc-payments');
    const main = await findEntityMain('Payments API');
    const panel = await within(main).findByRole(
      'tabpanel',
      { name: localeText('es', 'entity.tabs.details') },
      { timeout: 3000 },
    );
    const { spec, status } = await findSections(panel, 'es');

    expect(termTexts(spec)).toEqual(SPEC_TITLES_ES);
    expect(
      termTexts(status).filter((label) =>
        ['Réplicas listas', 'Salud', 'Último despliegue'].includes(label),
      ),
    ).toEqual(['Réplicas listas', 'Salud', 'Último despliegue']);
    expect(shownText(field(status, localeText('es', 'entity.details.status.source')))).toBe(
      'github-actions',
    );
  });
});
