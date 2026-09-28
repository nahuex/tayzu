/**
 * Task 10.4 (openspec/changes/archive/2026-09-28-001-catalog-core/tasks.md): "Document the
 * telemetry reference in `docs/catalog/catalog-core.md` ... Verify:
 * markdownlint passes, and every name in the doc exists in `contract.ts`".
 *
 * This test reads `docs/catalog/catalog-core.md`'s `## Telemetry` section
 * (resolved relative to the repo root from `import.meta.url`, never a
 * hard-coded absolute path) and extracts every backtick-quoted token that
 * looks like a span name (`catalog.*`), a metric name (`tayzu.catalog.*`) or
 * an attribute key (`tayzu.*`, `error.type`, `db.*`, `exception.*`). It then
 * checks the contract both ways, so the doc can never drift silently from
 * `./contract.ts` (the executable mirror of design.md's "Observability
 * contract"):
 *
 * 1. Every such name the doc mentions must exist in `contract.ts`, either as
 *    a span name, a metric name, a log event name, or an attribute key that
 *    some span (including the four common operation-span attributes), some
 *    metric or some log event declares.
 * 2. Conversely, every span, metric and log event name `contract.ts`
 *    declares must appear, backtick-quoted, somewhere in that section.
 *
 * `docs/catalog/catalog-core.md` has no `## Telemetry` section yet (red
 * phase), so both directions fail: direction 1 has nothing to check yet
 * (there is no doc content to extract from), and direction 2 fails for
 * every one of `contract.ts`'s 16 spans, 7 metrics and 4 log events, because
 * none of them can be found in a section that does not exist.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { COMMON_OPERATION_SPAN_ATTRIBUTES, LOG_EVENTS, METRICS, SPANS } from './contract.js';

/** `packages/catalog/src/telemetry/` -> repo root -> `docs/catalog/catalog-core.md`. */
const DOC_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/catalog/catalog-core.md',
);

/** Matches a span (`catalog.*`), a metric (`tayzu.catalog.*`), or an attribute key (`tayzu.*`, `error.type`, `db.*`, `exception.*`). */
const SIGNAL_TOKEN_PATTERN =
  /^(?:catalog\.[a-z0-9_.]+|tayzu\.[a-z0-9_.]+|db\.[a-z0-9_.]+|exception\.[a-z0-9_.]+|error\.type)$/;

/** Removes fenced code blocks first, so a KQL example's triple backticks never confuse single-backtick extraction. */
function stripFencedCodeBlocks(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, '');
}

/** Returns the body of the level-2 `## <heading>` section, up to the next level-2 heading or the end of the file. */
function extractSection(markdown: string, heading: string): string {
  const headingPattern = new RegExp(`^##\\s+${heading}\\s*$`, 'm');
  const match = headingPattern.exec(markdown);
  if (!match) {
    throw new Error(`docs/catalog/catalog-core.md has no "## ${heading}" section yet`);
  }
  const rest = markdown.slice(match.index + match[0].length);
  const nextHeading = /^##\s+/m.exec(rest);
  return nextHeading ? rest.slice(0, nextHeading.index) : rest;
}

/** Every distinct backtick-quoted token in `section` that looks like a span, metric or attribute-key name. */
function extractSignalTokens(section: string): string[] {
  const tokens = section.match(/`([^`]+)`/g) ?? [];
  const names = tokens.map((token) => token.slice(1, -1));
  return [...new Set(names.filter((name) => SIGNAL_TOKEN_PATTERN.test(name)))];
}

/** Every span, metric and log event name, plus every attribute key any of them declares (contract.ts's complete vocabulary). */
function contractVocabulary(): Set<string> {
  const names = new Set<string>(COMMON_OPERATION_SPAN_ATTRIBUTES);
  for (const span of SPANS) {
    names.add(span.name);
    for (const attribute of span.requiredAttributes) names.add(attribute);
    for (const attribute of span.conditionalAttributes) names.add(attribute);
  }
  for (const metric of METRICS) {
    names.add(metric.name);
    for (const attribute of metric.attributes) names.add(attribute);
  }
  for (const logEvent of LOG_EVENTS) {
    names.add(logEvent.name);
    for (const attribute of logEvent.attributes) names.add(attribute);
  }
  return names;
}

const CONTRACT_SIGNAL_NAMES: readonly string[] = [
  ...SPANS.map((span) => span.name),
  ...METRICS.map((metric) => metric.name),
  ...LOG_EVENTS.map((logEvent) => logEvent.name),
];

describe('docs/catalog/catalog-core.md, "## Telemetry" section (task 10.4)', () => {
  const rawMarkdown = readFileSync(DOC_PATH, 'utf8');
  const markdown = stripFencedCodeBlocks(rawMarkdown);

  it('has a "## Telemetry" section', () => {
    expect(() => extractSection(markdown, 'Telemetry')).not.toThrow();
  });

  const section = (() => {
    try {
      return extractSection(markdown, 'Telemetry');
    } catch {
      return '';
    }
  })();

  const docSignalTokens = extractSignalTokens(section);
  const vocabulary = contractVocabulary();

  it('mentions at least one span, metric or attribute name in that section', () => {
    expect(docSignalTokens.length).toBeGreaterThan(0);
  });

  it.each(docSignalTokens.map((name) => [name] as const))(
    'doc name `%s` exists in telemetry/contract.ts (as a span, metric, log event or attribute)',
    (name) => {
      expect(vocabulary.has(name)).toBe(true);
    },
  );

  it.each(CONTRACT_SIGNAL_NAMES.map((name) => [name] as const))(
    'contract.ts name `%s` is documented, backtick-quoted, in the "## Telemetry" section',
    (name) => {
      expect(docSignalTokens).toContain(name);
    },
  );
});
