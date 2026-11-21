/**
 * Cells by type (task 7.2, design D13, D16 and Q70, ADR-0008; spec "The catalog table
 * shows a blueprint's entities with sort and keyset paging").
 *
 * D13 (Cells): "plain text for strings, numbers through `Intl.NumberFormat`, booleans as
 * a localized yes or no, `enum` values as plain text (no colors, `047`), `date-time`
 * through `Intl.DateTimeFormat`, `url` through the safe link, `email` as a `mailto:`
 * safe link, `markdown` as its first line in plain text, `yaml` and objects as truncated
 * monospace text, arrays joined and capped at 5 items with a "+N" count. Long text is
 * truncated with the full value in an accessible tooltip."
 * D13 (Safe rendering): "A URL value becomes a link only if it parses as an absolute
 * `http:` or `https:` URL (a `mailto:` link only for the `email` format), with
 * `rel="noopener noreferrer nofollow"` and `target="_blank"`; anything else is text."
 * ADR-0008: `string` (formats `date-time`, `url`, `email`, `markdown`, `yaml`; `enum`),
 * `number`, `integer`, `boolean`, `array` of those primitives, and a free-form `object`.
 * There is no `date` format.
 *
 * Spec, scenario "A dangerous URL value stays text": GIVEN an entity whose `url` property
 * holds `javascript:alert(1)`, WHEN the table and the entity page show it, THEN it is
 * shown as text and is not a link. (This file covers the table cell.)
 *
 * Assumed API:
 *
 * ```ts
 * // src/catalog/cells.tsx
 * // One property value of an entity, rendered by its blueprint property definition
 * // (the `PropertyDefinition` that `blueprints.get` returns, or an array's `items`).
 * // `value` is the raw JSON value, `undefined` when the entity has no such property.
 * // Texts come from the `catalog` namespace; the caller provides a `Suspense` boundary
 * // and a `TooltipProvider` (`@/components/ui/tooltip`) above it.
 * export function PropertyCell(props: {
 *   readonly value: unknown;
 *   readonly schema: PropertyDefinition;
 *   readonly locale: Locale;
 * }): React.JSX.Element;
 * ```
 *
 * Renderings:
 *
 * - `null` or absent (`undefined`), and an empty array: the empty marker, whose text for
 *   assistive technology is `catalog:cells.empty` ("No value", "Sin valor"). The visual
 *   marker is free. Never the words `null` or `undefined`.
 * - `string` without format, and `enum`: the value as React text (no markup parsed).
 * - `number` and `integer`: `formatNumber(value, locale)`.
 * - `boolean`: `catalog:cells.yes` / `catalog:cells.no` ("Yes"/"No", "Sí"/"No").
 * - `date-time`: `formatDate(value, locale)` (browser time zone). A value that does not
 *   parse as a date is shown as its raw text, and never throws.
 * - `url`: `SafeLink`; `email`: `SafeEmailLink` (the only `mailto:` link).
 * - `markdown`: the first non-blank line of the source, trimmed, as plain text (never
 *   rendered markdown: no link, emphasis, heading or image element).
 * - `yaml`: the value as text inside a `<code>` element.
 * - `object`: `JSON.stringify(value)` (compact) inside a `<code>` element.
 * - A value whose JSON type does not match its schema: `JSON.stringify(value)` inside a
 *   `<code>` element (it never throws).
 * - `array`: each item rendered by `items` as above, joined with ", ", at most 5 items;
 *   more items add a separate element whose text is `catalog:cells.more` with
 *   `count` = the hidden items ("+{{count}}" in both locales).
 * - Truncation: a displayed text (plain string, `enum`, markdown first line, `yaml`,
 *   object or mismatch JSON) longer than 100 code points shows its first 100 code points
 *   followed by "…" (U+2026), never splitting a surrogate pair. That text is a keyboard
 *   focusable tooltip trigger; focusing or hovering it opens a tooltip (`role="tooltip"`)
 *   whose text is exactly the full displayed text. A text of at most 100 code points is
 *   shown in full, with no tooltip and no tab stop.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Suspense, type ComponentProps } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';

import { createI18n, type Locale } from '../i18n/i18n.js';
import { formatDate, formatNumber } from '../lib/format.js';

import { PropertyCell } from './cells.js';

type CellProps = ComponentProps<typeof PropertyCell>;

const SAFE_REL = 'noopener noreferrer nofollow';
const SAFE_TARGET = '_blank';

/** D13's truncation length, in code points, and its ellipsis. */
const LIMIT = 100;
const ELLIPSIS = '…';

const TEXTS = {
  en: { empty: 'No value', yes: 'Yes', no: 'No' },
  es: { empty: 'Sin valor', yes: 'Sí', no: 'No' },
} as const;

const TITLE = { en: 'Property' };

const STRING = { type: 'string', title: TITLE } as const;
const NUMBER = { type: 'number', title: TITLE } as const;
const INTEGER = { type: 'integer', title: TITLE } as const;
const BOOLEAN = { type: 'boolean', title: TITLE } as const;
const OBJECT = { type: 'object', title: TITLE } as const;
const DATE_TIME = { type: 'string', format: 'date-time', title: TITLE } as const;
const URL_FORMAT = { type: 'string', format: 'url', title: TITLE } as const;
const EMAIL = { type: 'string', format: 'email', title: TITLE } as const;
const MARKDOWN = { type: 'string', format: 'markdown', title: TITLE } as const;
const YAML = { type: 'string', format: 'yaml', title: TITLE } as const;
const ENUM = { type: 'string', enum: ['bronze', 'silver', 'gold'], title: TITLE } as const;

/** An `array` property whose `items` is `items` (an ADR-0008 primitive definition). */
function arrayOf(items: Readonly<Record<string, unknown>>) {
  return { type: 'array', title: TITLE, items };
}

/** A deterministic text of `length` characters that is not a single repeated letter. */
function longText(length: number): string {
  return Array.from({ length }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
}

beforeAll(() => {
  // jsdom has no ResizeObserver, which the Radix tooltip's positioning uses.
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
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  window.localStorage.clear();
});

/** Renders one cell with i18n (the `catalog` namespace loaded) in `locale`. */
async function renderCell(value: unknown, schema: unknown, locale: Locale = 'en') {
  if (locale === 'es') window.localStorage.setItem('tayzu.locale', 'es');
  const i18n = await createI18n();
  await i18n.loadNamespaces('catalog');
  const view = render(
    <I18nextProvider i18n={i18n}>
      <TooltipProvider>
        <Suspense fallback={null}>
          <PropertyCell value={value} schema={schema as CellProps['schema']} locale={locale} />
        </Suspense>
      </TooltipProvider>
    </I18nextProvider>,
  );
  return view;
}

/** Every element of `root` that carries an `href`. */
function hrefs(root: HTMLElement): Element[] {
  return Array.from(root.querySelectorAll('[href]'));
}

describe('PropertyCell: empty values', () => {
  it.each([
    ['null', null],
    ['absent', undefined],
    ['an empty array', []],
  ])('shows %s as the empty marker', async (_label, value) => {
    const schema = Array.isArray(value) ? arrayOf(STRING) : STRING;
    const { container } = await renderCell(value, schema);
    expect(await screen.findByText(TEXTS.en.empty)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/null|undefined/);
  });

  it('localizes the empty marker', async () => {
    await renderCell(null, STRING, 'es');
    expect(await screen.findByText(TEXTS.es.empty)).toBeInTheDocument();
  });
});

describe('PropertyCell: strings and enum', () => {
  it('shows a string as plain text, never parsed as markup', async () => {
    const value = '<b>bold</b> & <img src=x onerror=alert(1)>';
    const { container } = await renderCell(value, STRING);
    expect(container.textContent).toBe(value);
    expect(container.querySelector('b, img')).toBeNull();
  });

  it('shows an enum value as plain text', async () => {
    const { container } = await renderCell('gold', ENUM);
    expect(container.textContent).toBe('gold');
  });
});

describe('PropertyCell: numbers and booleans', () => {
  it.each([
    ['en', 1234567.25, '1,234,567.25'],
    ['es', 1234567.25, '1.234.567,25'],
  ] as const)('formats a number in %s', async (locale, value, expected) => {
    const { container } = await renderCell(value, NUMBER, locale);
    expect(container.textContent).toBe(expected);
    expect(container.textContent).toBe(formatNumber(value, locale));
  });

  it('formats an integer', async () => {
    const { container } = await renderCell(42000, INTEGER);
    expect(container.textContent).toBe('42,000');
  });

  it.each([
    ['en', true, TEXTS.en.yes],
    ['en', false, TEXTS.en.no],
    ['es', true, TEXTS.es.yes],
    ['es', false, TEXTS.es.no],
  ] as const)(
    'shows a boolean in %s as a localized yes or no (%s)',
    async (locale, value, text) => {
      const { container } = await renderCell(value, BOOLEAN, locale);
      expect(await screen.findByText(text)).toBeInTheDocument();
      expect(container.textContent).toBe(text);
    },
  );
});

describe('PropertyCell: date-time', () => {
  it.each(['en', 'es'] as const)('formats a date-time through formatDate in %s', async (locale) => {
    const value = '2026-03-04T05:06:07.000Z';
    const { container } = await renderCell(value, DATE_TIME, locale);
    expect(container.textContent).toBe(formatDate(value, locale));
  });

  it('shows a date-time that does not parse as its raw text', async () => {
    const { container } = await renderCell('not a date', DATE_TIME);
    expect(container.textContent).toBe('not a date');
  });
});

describe('PropertyCell: email', () => {
  it('shows an email value as a mailto: link', async () => {
    await renderCell('ana@example.com', EMAIL);
    const link = screen.getByRole('link', { name: 'ana@example.com' });
    expect(link).toHaveAttribute('href', 'mailto:ana@example.com');
    expect(link).toHaveAttribute('rel', SAFE_REL);
    expect(link).toHaveAttribute('target', SAFE_TARGET);
  });
});

describe('PropertyCell: url', () => {
  it('shows an absolute https URL as a safe link', async () => {
    const value = 'https://docs.example.com/runbook?x=1';
    await renderCell(value, URL_FORMAT);
    const link = screen.getByRole('link', { name: value });
    expect(link).toHaveAttribute('href', value);
    expect(link).toHaveAttribute('rel', SAFE_REL);
    expect(link).toHaveAttribute('target', SAFE_TARGET);
  });

  it('shows an absolute http URL as a safe link', async () => {
    const value = 'http://intranet.example.com/';
    await renderCell(value, URL_FORMAT);
    expect(screen.getByRole('link', { name: value })).toHaveAttribute('href', value);
  });

  // Scenario "A dangerous URL value stays text".
  it('A dangerous URL value stays text', async () => {
    const value = 'javascript:alert(1)';
    const { container } = await renderCell(value, URL_FORMAT);
    expect(screen.queryByRole('link')).toBeNull();
    expect(hrefs(container)).toHaveLength(0);
    expect(container.textContent).toBe(value);
  });

  it.each([
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'mailto:ana@example.com',
    '//evil.example/path',
    '/relative/path',
    'not a url',
  ])('shows the url value %s as text, not a link', async (value) => {
    const { container } = await renderCell(value, URL_FORMAT);
    expect(screen.queryByRole('link')).toBeNull();
    expect(hrefs(container)).toHaveLength(0);
    expect(container.textContent).toBe(value);
  });
});

describe('PropertyCell: markdown', () => {
  it('shows a markdown value as its first line in plain text', async () => {
    const firstLine = '**Payments** runbook: see [the docs](https://example.com/docs)';
    const value = `${firstLine}\n\n# Second heading\n\n![pixel](https://example.com/p.png)\n<script>alert(1)</script>`;
    const { container } = await renderCell(value, MARKDOWN);
    expect(container.textContent).toBe(firstLine);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('heading')).toBeNull();
    expect(hrefs(container)).toHaveLength(0);
    expect(container.querySelector('strong, em, h1, img, script, p')).toBeNull();
  });

  it('skips leading blank lines and trims the first line', async () => {
    const { container } = await renderCell('\n  \n   First line  \nsecond line', MARKDOWN);
    expect(container.textContent).toBe('First line');
  });
});

describe('PropertyCell: yaml and objects', () => {
  it('shows a yaml value as monospace text', async () => {
    const value = 'tier: 1\nowners: [payments]';
    const { container } = await renderCell(value, YAML);
    const code = container.querySelector('code');
    expect(code).not.toBeNull();
    expect(code?.textContent).toBe(value);
  });

  it('shows an object as its compact JSON in monospace text', async () => {
    const value = { team: 'payments', tier: 1, tags: ['a', 'b'] };
    const { container } = await renderCell(value, OBJECT);
    const code = container.querySelector('code');
    expect(code).not.toBeNull();
    expect(code?.textContent).toBe('{"team":"payments","tier":1,"tags":["a","b"]}');
  });

  it('shows a value that does not match its schema as JSON text, without throwing', async () => {
    const { container } = await renderCell({ a: 1 }, STRING);
    expect(container.querySelector('code')?.textContent).toBe('{"a":1}');
  });
});

describe('PropertyCell: arrays', () => {
  it('joins up to 5 items with no count', async () => {
    const { container } = await renderCell(['a', 'b', 'c', 'd', 'e'], arrayOf({ type: 'string' }));
    expect(container.textContent).toBe('a, b, c, d, e');
    expect(screen.queryByText(/^\+\d+$/)).toBeNull();
  });

  it('caps an array at 5 items with a "+N" count', async () => {
    const value = ['a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'g7'];
    const { container } = await renderCell(value, arrayOf({ type: 'string' }));
    expect(screen.getByText('+2')).toBeInTheDocument();
    expect(container.textContent).toContain('a1, b2, c3, d4, e5');
    expect(container.textContent).not.toContain('f6');
    expect(container.textContent).not.toContain('g7');
  });

  it('localizes the count', async () => {
    const value = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    await renderCell(value, arrayOf({ type: 'integer' }), 'es');
    expect(screen.getByText('+4')).toBeInTheDocument();
  });

  it('renders number items through formatNumber', async () => {
    const { container } = await renderCell([1, 2, 3], arrayOf({ type: 'number' }));
    expect(container.textContent).toBe('1, 2, 3');
  });

  it('renders boolean items as a localized yes or no', async () => {
    const { container } = await renderCell([true, false], arrayOf({ type: 'boolean' }), 'es');
    expect(container.textContent).toBe(`${TEXTS.es.yes}, ${TEXTS.es.no}`);
  });

  it('renders date-time items through formatDate', async () => {
    const a = '2026-01-02T03:04:05.000Z';
    const b = '2026-07-08T09:10:11.000Z';
    const { container } = await renderCell(
      [a, b],
      arrayOf({ type: 'string', format: 'date-time' }),
    );
    expect(container.textContent).toBe(`${formatDate(a, 'en')}, ${formatDate(b, 'en')}`);
  });

  it('renders url items through the safe link, a dangerous one as text', async () => {
    const safe = 'https://example.com/a';
    const dangerous = 'javascript:alert(1)';
    const { container } = await renderCell(
      [safe, dangerous],
      arrayOf({ type: 'string', format: 'url' }),
    );
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', safe);
    expect(links[0]).toHaveAttribute('rel', SAFE_REL);
    expect(hrefs(container)).toHaveLength(1);
    expect(container.textContent).toBe(`${safe}, ${dangerous}`);
  });

  it('renders email items as mailto: links', async () => {
    await renderCell(
      ['ana@example.com', 'bo@example.com'],
      arrayOf({ type: 'string', format: 'email' }),
    );
    expect(screen.getByRole('link', { name: 'ana@example.com' })).toHaveAttribute(
      'href',
      'mailto:ana@example.com',
    );
    expect(screen.getByRole('link', { name: 'bo@example.com' })).toHaveAttribute(
      'href',
      'mailto:bo@example.com',
    );
  });
});

describe('PropertyCell: truncation', () => {
  it('truncates a 3000 character value with its full value in an accessible tooltip', async () => {
    const user = userEvent.setup();
    const value = longText(3000);
    const shown = `${value.slice(0, LIMIT)}${ELLIPSIS}`;
    await renderCell(value, STRING);

    const truncated = screen.getByText(shown);
    expect(truncated.textContent).toBe(shown);
    expect(screen.queryByRole('tooltip')).toBeNull();

    // Keyboard: the truncated text is a tab stop, and focus opens the tooltip.
    await user.tab();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toContainElement(truncated);
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toBe(value);

    // Pointer: hovering opens it too.
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
    await user.tab({ shift: true });
    await user.hover(truncated);
    expect((await screen.findByRole('tooltip')).textContent).toBe(value);
  });

  it('shows a value of exactly 100 characters in full, with no tooltip and no tab stop', async () => {
    const user = userEvent.setup();
    const value = longText(LIMIT);
    const { container } = await renderCell(value, STRING);
    expect(container.textContent).toBe(value);
    await user.tab();
    expect(document.activeElement).toBe(document.body);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('truncates a value of 101 characters', async () => {
    const value = longText(LIMIT + 1);
    await renderCell(value, STRING);
    expect(screen.getByText(`${value.slice(0, LIMIT)}${ELLIPSIS}`)).toBeInTheDocument();
  });

  it('counts code points and never splits a surrogate pair', async () => {
    const value = `${'a'.repeat(LIMIT - 1)}\u{1F600}${'b'.repeat(10)}`;
    await renderCell(value, STRING);
    expect(screen.getByText(`${'a'.repeat(LIMIT - 1)}\u{1F600}${ELLIPSIS}`)).toBeInTheDocument();
  });

  it('truncates a long markdown first line with the line in its tooltip', async () => {
    const user = userEvent.setup();
    const firstLine = longText(300);
    await renderCell(`${firstLine}\nsecond line`, MARKDOWN);
    const truncated = screen.getByText(`${firstLine.slice(0, LIMIT)}${ELLIPSIS}`);
    await user.hover(truncated);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(firstLine);
  });

  it('truncates a long object JSON with the full JSON in its tooltip', async () => {
    const user = userEvent.setup();
    const value = { description: longText(500) };
    const json = JSON.stringify(value);
    const { container } = await renderCell(value, OBJECT);
    const code = container.querySelector('code');
    if (code === null) throw new Error('The object cell has no code element');
    expect(within(code).getByText(`${json.slice(0, LIMIT)}${ELLIPSIS}`)).toBeInTheDocument();
    await user.tab();
    expect((await screen.findByRole('tooltip')).textContent).toBe(json);
  });
});
