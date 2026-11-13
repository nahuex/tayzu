import { describe, expect, it } from 'vitest';

import {
  renderAccountCreatedNotice,
  renderMfaChangedNotice,
  renderMfaResetNotice,
  renderPasswordChangedNotice,
} from './recovery-notice-templates.js';
import type { EmailTemplate } from './sender.js';

/**
 * `044` task 3.3 (design D8, Resolved decisions Q16, Q21, Q30): the four fixed recovery
 * notices. Scenario "A notice carries no free text" of
 * `specs/password-reset-and-account-recovery/spec.md` for `AccountCreatedNotice` and
 * `MfaResetNotice`, plus the cases of the task's Verify clause.
 */

type NoticeKind =
  'PasswordChangedNotice' | 'MfaChangedNotice' | 'MfaResetNotice' | 'AccountCreatedNotice';
type Rendered = { subject: string; html: string; text: string };

const MARKUP_ORG = '<b>Pay now</b>';
const MARKUP_ADMIN = '<img src="https://evil.example/x.png"><script>alert(1)</script>Mallory';

const renderers: Record<NoticeKind, (template: never) => Rendered> = {
  PasswordChangedNotice: renderPasswordChangedNotice,
  MfaChangedNotice: renderMfaChangedNotice,
  MfaResetNotice: renderMfaResetNotice,
  AccountCreatedNotice: renderAccountCreatedNotice,
};

const KINDS: NoticeKind[] = [
  'PasswordChangedNotice',
  'MfaChangedNotice',
  'MfaResetNotice',
  'AccountCreatedNotice',
];

function template<K extends NoticeKind>(kind: K): Extract<EmailTemplate, { kind: K }> {
  return { kind } as Extract<EmailTemplate, { kind: K }>;
}

function render(kind: NoticeKind, input: object = template(kind)): Rendered {
  return renderers[kind](input as never);
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

function parseTagNames(html: string): string[] {
  return [...html.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)/g)].map((m) => (m[1] ?? '').toLowerCase());
}

function visibleText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ');
}

function urlsIn(value: string): string[] {
  return value.match(/(?:https?|ftp|mailto|javascript|data):[^\s"'<>]*/gi) ?? [];
}

function sentencesOf(value: string): string[] {
  return value
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function sentenceWith(value: string, needle: RegExp): string | undefined {
  return sentencesOf(value).find((s) => needle.test(s));
}

describe('recovery notices: A notice carries no free text', () => {
  const smuggled = {
    organizationName: MARKUP_ORG,
    organization: { name: MARKUP_ORG },
    adminName: MARKUP_ADMIN,
    admin: { name: MARKUP_ADMIN },
    name: MARKUP_ORG,
    link: 'https://evil.example/reset',
    to: 'victim@example.com',
  };

  for (const kind of ['AccountCreatedNotice', 'MfaResetNotice'] as const) {
    it(`${kind}: neither the organization name nor the admin name appears`, () => {
      const { subject, html, text } = render(kind, { kind, ...smuggled });
      for (const part of [subject, html, text]) {
        expect(part).not.toContain(MARKUP_ORG);
        expect(part).not.toContain('Pay now');
        expect(part).not.toContain('Mallory');
        expect(part).not.toContain('evil.example');
        expect(part).not.toContain('alert(1)');
        expect(part).not.toContain('victim@example.com');
      }
    });

    it(`${kind}: has no link and renders the same output with or without smuggled values`, () => {
      const plain = render(kind);
      expect(render(kind, { kind, ...smuggled })).toEqual(plain);
      expect(parseTagNames(plain.html)).not.toContain('a');
    });
  }
});

describe.each(KINDS)('%s', (kind) => {
  it('each notice has a fixed subject, no URL, no placeholder', () => {
    const rendered = render(kind);
    expect(rendered.subject.length).toBeGreaterThan(0);
    expect(rendered.subject).not.toMatch(/[\r\n]/);
    expect(rendered.html.length).toBeGreaterThan(0);
    expect(rendered.text.length).toBeGreaterThan(0);

    // Fixed: deterministic and independent of any smuggled value.
    expect(render(kind)).toEqual(rendered);
    expect(
      render(kind, { kind, link: 'https://x.example/y', name: 'Zed', expiryText: '1 hour' }),
    ).toEqual(rendered);

    // No URL, no link element, no address in any part.
    for (const part of [rendered.subject, rendered.html, rendered.text]) {
      expect(urlsIn(part)).toEqual([]);
      expect(part).not.toMatch(/https?:\/\//i);
      expect(part).not.toMatch(
        /\{\{|\}\}|\$\{|\{[A-Za-z_]+\}|%s|%\{|<%|\bundefined\b|\bnull\b|\[object /,
      );
      expect(part).not.toMatch(/\S+@\S+\.\S+/);
    }
    const tags = parseTagNames(rendered.html);
    for (const forbidden of ['a', 'img', 'form', 'script', 'iframe', 'link']) {
      expect(tags).not.toContain(forbidden);
    }
    expect(rendered.html).not.toMatch(/\b(?:href|src|action)\s*=/i);
  });
});

describe('recovery notices: fixed texts', () => {
  const REVIEW = /service accounts/i;

  it('the password-changed text names service accounts, credentials and linked sign-ins', () => {
    const { html, text } = render('PasswordChangedNotice');
    for (const body of [visibleText(html), text]) {
      const lower = body.toLowerCase();
      expect(lower).toContain('service accounts');
      expect(lower).toContain('credentials');
      expect(lower).toContain('linked sign-ins');
    }
  });

  it('the MFA-reset text carries the same fixed sentence as the password-changed text', () => {
    const changed = render('PasswordChangedNotice');
    const reset = render('MfaResetNotice');

    const changedText = sentenceWith(changed.text, REVIEW);
    const resetText = sentenceWith(reset.text, REVIEW);
    expect(changedText).toBeDefined();
    expect(resetText).toBe(changedText);

    const changedHtml = sentenceWith(visibleText(changed.html), REVIEW);
    const resetHtml = sentenceWith(visibleText(reset.html), REVIEW);
    expect(changedHtml).toBeDefined();
    expect(resetHtml).toBe(changedHtml);

    expect(resetText?.toLowerCase()).toContain('credentials');
    expect(resetText?.toLowerCase()).toContain('linked sign-ins');
  });

  it('the account-created text names the platform operator', () => {
    const { html, text } = render('AccountCreatedNotice');
    for (const body of [visibleText(html), text]) {
      const lower = body.toLowerCase();
      expect(lower).toContain('forgot-password');
      expect(lower).toContain('platform operator');
      expect(lower).toContain('code');
    }
    const operator = sentenceWith(text, /platform operator/i);
    expect(operator).toBeDefined();
    expect(operator).toMatch(/\bcode\b/i);
  });
});
