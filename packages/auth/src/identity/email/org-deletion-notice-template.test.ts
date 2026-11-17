import { describe, expect, it } from 'vitest';

import { renderOrgDeletionNotice } from './org-deletion-notice-template.js';
import type { EmailTemplate } from './sender.js';

/**
 * `045` task 4.1 (design D5, Resolved decision Q27): the fixed org-deletion notice, the
 * eighth kind of the closed `EmailTemplate` union. Scenario "The deletion notice carries
 * no free text" of `specs/org-deletion-and-data-retention/spec.md`:
 *
 * - GIVEN an organization named `<b>Pay now</b>` and an admin with a markup-bearing name
 * - WHEN the org-deletion notice is sent
 * - THEN neither string appears, the notice has no link, and its only variable is the
 *   purge date
 *
 * ## Production symbols expected
 *
 * `sender.ts`: `EmailTemplate` gains `{ kind: 'OrgDeletionNotice'; purgeDate: string }`.
 * `org-deletion-notice-template.ts`: `renderOrgDeletionNotice(template)` returns a
 * `RenderedEmail` with a fixed subject and a fixed body into which only `purgeDate` is
 * interpolated.
 */

type OrgDeletionTemplate = Extract<EmailTemplate, { kind: 'OrgDeletionNotice' }>;
type Rendered = { subject: string; html: string; text: string };

const PURGE_DATE = '2026-12-01';
const OTHER_PURGE_DATE = '2027-03-15';
const SENTINEL = '@@PURGE_DATE@@';

const MARKUP_ORG = '<b>Pay now</b>';
const MARKUP_ADMIN = '<img src="https://evil.example/x.png"><script>alert(1)</script>Mallory';

function template(purgeDate: string = PURGE_DATE): OrgDeletionTemplate {
  return { kind: 'OrgDeletionNotice', purgeDate };
}

function render(input: object = template()): Rendered {
  return renderOrgDeletionNotice(input as OrgDeletionTemplate);
}

function decodeEntities(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&#x27;', "'")
    .replaceAll('&amp;', '&');
}

/** Every opening tag of the document with its decoded attributes. */
function parseTags(html: string): { name: string; attributes: Record<string, string> }[] {
  const tags: { name: string; attributes: Record<string, string> }[] = [];
  for (const match of html.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^<>]*?)?)\s*\/?>/g)) {
    const attributes: Record<string, string> = {};
    for (const attr of (match[2] ?? '').matchAll(
      /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g,
    )) {
      attributes[(attr[1] ?? '').toLowerCase()] = decodeEntities(
        attr[2] ?? attr[3] ?? attr[4] ?? '',
      );
    }
    tags.push({ name: (match[1] ?? '').toLowerCase(), attributes });
  }
  return tags;
}

function visibleText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ');
}

function urlsIn(value: string): string[] {
  return value.match(/(?:https?|ftp|mailto|javascript|data):[^\s"'<>]*/gi) ?? [];
}

function withSentinel(rendered: Rendered, purgeDate: string): Rendered {
  return {
    subject: rendered.subject.replaceAll(purgeDate, SENTINEL),
    html: rendered.html.replaceAll(purgeDate, SENTINEL),
    text: rendered.text.replaceAll(purgeDate, SENTINEL),
  };
}

describe('renderOrgDeletionNotice: The deletion notice carries no free text', () => {
  // The port gives the template nothing but the purge date. These tests also smuggle
  // organization and admin free text onto the template object, as a caller that
  // mistakenly forwarded it would, and require that it never shows.
  const smuggled = {
    ...template(),
    organizationName: MARKUP_ORG,
    organization: { name: MARKUP_ORG },
    adminName: MARKUP_ADMIN,
    admin: { name: MARKUP_ADMIN },
    actorName: MARKUP_ADMIN,
    name: MARKUP_ORG,
    link: 'https://evil.example/restore',
    to: 'victim@example.com',
  };

  it('neither the organization name nor the admin name appears in the subject, the HTML or the text', () => {
    const { subject, html, text } = render(smuggled);
    for (const part of [subject, html, text, visibleText(html)]) {
      expect(part).not.toContain(MARKUP_ORG);
      expect(part).not.toContain('Pay now');
      expect(part).not.toContain('Mallory');
      expect(part).not.toContain('evil.example');
      expect(part).not.toContain('alert(1)');
      expect(part).not.toContain('victim@example.com');
    }
    const tags = parseTags(html).map((tag) => tag.name);
    expect(tags).not.toContain('b');
    expect(tags).not.toContain('img');
    expect(tags).not.toContain('script');
  });

  it('renders the same output with or without the smuggled free text', () => {
    expect(render(smuggled)).toEqual(render(template()));
  });

  it('the notice has no link', () => {
    const { subject, html, text } = render(smuggled);
    const tags = parseTags(html);
    expect(tags.filter((tag) => tag.name === 'a')).toEqual([]);
    expect(
      tags.filter((tag) =>
        ['form', 'img', 'script', 'iframe', 'link', 'area', 'base', 'meta'].includes(tag.name),
      ),
    ).toEqual([]);
    expect(
      tags.filter((tag) =>
        ['href', 'src', 'action', 'formaction', 'srcset', 'background', 'data', 'poster'].some(
          (name) => name in tag.attributes,
        ),
      ),
    ).toEqual([]);
    for (const part of [subject, html, text, visibleText(html)]) {
      expect(urlsIn(part)).toEqual([]);
      expect(part).not.toMatch(/https?:\/\//i);
      expect(part).not.toMatch(/\bwww\./i);
      expect(part).not.toMatch(/\S+@\S+\.\S+/);
    }
  });

  it('its only variable is the purge date', () => {
    const first = render(template(PURGE_DATE));
    const second = render(template(OTHER_PURGE_DATE));

    // The purge date is shown in both bodies.
    expect(visibleText(first.html)).toContain(PURGE_DATE);
    expect(first.text).toContain(PURGE_DATE);
    expect(visibleText(second.html)).toContain(OTHER_PURGE_DATE);
    expect(second.text).toContain(OTHER_PURGE_DATE);

    // With the date masked, two different purge dates give the same output: nothing else
    // varies.
    expect(first).not.toEqual(second);
    expect(withSentinel(first, PURGE_DATE)).toEqual(withSentinel(second, OTHER_PURGE_DATE));

    // No unfilled placeholder or stringified value is left behind.
    for (const part of [first.subject, first.html, first.text]) {
      expect(part).not.toMatch(
        /\{\{|\}\}|\$\{|\{[A-Za-z_]+\}|%s|%\{|<%|\bundefined\b|\bnull\b|\[object /,
      );
    }
  });
});

describe('renderOrgDeletionNotice: fixed subject and body', () => {
  it('renders a non-empty single-line subject, an HTML body and a text body', () => {
    const rendered = render();
    expect(rendered.subject.length).toBeGreaterThan(0);
    expect(rendered.subject).not.toMatch(/[\r\n]/);
    expect(rendered.html.length).toBeGreaterThan(0);
    expect(rendered.text.length).toBeGreaterThan(0);
  });

  it('the subject is fixed: it does not depend on the purge date and does not contain it', () => {
    const first = render(template(PURGE_DATE));
    const second = render(template(OTHER_PURGE_DATE));
    expect(first.subject).toBe(second.subject);
    expect(first.subject).not.toContain(PURGE_DATE);
  });

  it('is deterministic for the same purge date', () => {
    expect(render(template())).toEqual(render(template()));
  });
});
