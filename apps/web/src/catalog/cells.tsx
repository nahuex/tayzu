/**
 * Table cells by property type (design D13 and D16, ADR-0008).
 *
 * A cell renders one raw JSON property value by its blueprint property definition.
 * Every server string is React text, except `url` and `email` values, which go through
 * the safe links of `lib/`. A value whose JSON type does not match its definition is
 * shown as JSON text, so a cell never throws on unexpected data. Long text is cut to
 * `TRUNCATE_AT` code points, with the full text in a keyboard-reachable tooltip.
 */
import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

import type { Locale } from '../i18n/i18n.js';
import { formatDate, formatNumber } from '../lib/format.js';
import { SafeEmailLink, SafeLink } from '../lib/safe-link.js';

import type { PropertyDefinition } from './columns.js';

/** The longest text, in code points, shown without truncation. */
const TRUNCATE_AT = 100;

const ELLIPSIS = '…';

/** The most array items a cell shows before its "+N" count. */
const MAX_ARRAY_ITEMS = 5;

const ARRAY_SEPARATOR = ', ';

/** How a value is rendered, read from its definition (or an array's `items`). */
type ScalarKind =
  | 'text'
  | 'date-time'
  | 'url'
  | 'email'
  | 'markdown'
  | 'yaml'
  | 'number'
  | 'boolean'
  | 'object'
  | 'unknown';

type CellKind = ScalarKind | { readonly array: ScalarKind };

const STRING_FORMATS: Readonly<Record<string, ScalarKind | undefined>> = Object.assign(
  Object.create(null) as Record<string, ScalarKind | undefined>,
  {
    'date-time': 'date-time',
    url: 'url',
    email: 'email',
    markdown: 'markdown',
    yaml: 'yaml',
  } satisfies Record<string, ScalarKind>,
);

/**
 * The rendering of a scalar definition. Read from `unknown` so a definition the UI does
 * not know becomes `unknown` (JSON text) instead of a crash.
 */
function scalarKind(schema: unknown): ScalarKind {
  if (typeof schema !== 'object' || schema === null) return 'unknown';
  const { type, format } = schema as { type?: unknown; format?: unknown };
  switch (type) {
    case 'string':
      // `enum` values are plain text too (D13).
      return typeof format === 'string' ? (STRING_FORMATS[format] ?? 'text') : 'text';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'object':
      return 'object';
    default:
      return 'unknown';
  }
}

function cellKind(schema: unknown): CellKind {
  if (typeof schema === 'object' && schema !== null) {
    const { type, items } = schema as { type?: unknown; items?: unknown };
    if (type === 'array') return { array: scalarKind(items) };
  }
  return scalarKind(schema);
}

/** Compact JSON, or an empty string for a value JSON cannot encode. Never throws. */
function toJson(value: unknown): string {
  try {
    // `JSON.stringify` returns `undefined` for a value it cannot encode, despite its type.
    const json: unknown = JSON.stringify(value);
    return typeof json === 'string' ? json : '';
  } catch {
    return '';
  }
}

/** The first non-blank line of a markdown source, trimmed. */
function firstLine(source: string): string {
  for (const line of source.split(/\r\n|\r|\n/)) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed;
  }
  return '';
}

function isValidDate(value: string): boolean {
  return !Number.isNaN(new Date(value).getTime());
}

/**
 * `text` in full when it has at most `TRUNCATE_AT` code points. Longer text shows its
 * first `TRUNCATE_AT` code points and an ellipsis, as a focusable tooltip trigger whose
 * tooltip holds the full text.
 */
function TruncatedText({ text }: { readonly text: string }): JSX.Element {
  const codePoints = Array.from(text);
  if (codePoints.length <= TRUNCATE_AT) return <>{text}</>;
  const shown = `${codePoints.slice(0, TRUNCATE_AT).join('')}${ELLIPSIS}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="cursor-default text-left">
          {shown}
        </button>
      </TooltipTrigger>
      <TooltipContent className="whitespace-pre-wrap break-all">{text}</TooltipContent>
    </Tooltip>
  );
}

function Monospace({ text }: { readonly text: string }): JSX.Element {
  return (
    <code className="font-mono">
      <TruncatedText text={text} />
    </code>
  );
}

/** No value: a visual dash, and `cells.empty` for assistive technology. */
function EmptyMarker(): JSX.Element {
  const { t } = useTranslation('catalog');
  return (
    <span>
      <span aria-hidden="true">—</span>
      <span className="sr-only">{t('cells.empty')}</span>
    </span>
  );
}

function BooleanText({ value }: { readonly value: boolean }): JSX.Element {
  const { t } = useTranslation('catalog');
  return <>{value ? t('cells.yes') : t('cells.no')}</>;
}

function MoreCount({ count }: { readonly count: number }): JSX.Element {
  const { t } = useTranslation('catalog');
  return <span>{t('cells.more', { count })}</span>;
}

/** One non-array value by its scalar kind; a type mismatch is JSON text. */
function ScalarValue(props: {
  readonly value: unknown;
  readonly kind: ScalarKind;
  readonly locale: Locale;
}): JSX.Element {
  const { value, kind, locale } = props;
  if (value === null || value === undefined) return <EmptyMarker />;
  switch (kind) {
    case 'text':
      if (typeof value === 'string') return <TruncatedText text={value} />;
      break;
    case 'date-time':
      if (typeof value === 'string') {
        return isValidDate(value) ? (
          <>{formatDate(value, locale)}</>
        ) : (
          <TruncatedText text={value} />
        );
      }
      break;
    case 'url':
      if (typeof value === 'string') return <SafeLink href={value} />;
      break;
    case 'email':
      if (typeof value === 'string') return <SafeEmailLink address={value} />;
      break;
    case 'markdown':
      if (typeof value === 'string') return <TruncatedText text={firstLine(value)} />;
      break;
    case 'yaml':
      if (typeof value === 'string') return <Monospace text={value} />;
      break;
    case 'number':
      if (typeof value === 'number') return <>{formatNumber(value, locale)}</>;
      break;
    case 'boolean':
      if (typeof value === 'boolean') return <BooleanText value={value} />;
      break;
    case 'object':
    case 'unknown':
      break;
  }
  return <Monospace text={toJson(value)} />;
}

/** One property value of an entity, rendered by its blueprint property definition. */
export function PropertyCell(props: {
  readonly value: unknown;
  readonly schema: PropertyDefinition;
  readonly locale: Locale;
}): JSX.Element {
  const { value, locale } = props;
  const kind = cellKind(props.schema);
  if (typeof kind === 'string') return <ScalarValue value={value} kind={kind} locale={locale} />;
  if (value === null || value === undefined) return <EmptyMarker />;
  if (!Array.isArray(value)) return <Monospace text={toJson(value)} />;
  if (value.length === 0) return <EmptyMarker />;
  const items: readonly unknown[] = value;
  const hidden = items.length - MAX_ARRAY_ITEMS;
  return (
    <>
      {items.slice(0, MAX_ARRAY_ITEMS).map((item, index) => (
        // Items have no identity of their own, and the list never reorders.
        <span key={index}>
          {index > 0 && ARRAY_SEPARATOR}
          <ScalarValue value={item} kind={kind.array} locale={locale} />
        </span>
      ))}
      {hidden > 0 && (
        <>
          {' '}
          <MoreCount count={hidden} />
        </>
      )}
    </>
  );
}
