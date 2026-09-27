/**
 * Assumed API of `./localized-text.js` (task 2.4):
 *
 * ```ts
 * interface LocalizedText { en: string; es?: string }
 *
 * function parseLocalizedText(value: unknown, path: string, maxLength: number): LocalizedText;
 * ```
 *
 * `path` is the JSON Pointer of the localized-text field itself (for example
 * `/title`), so a per-locale issue is reported at `${path}/${locale}`.
 * `maxLength` is the caller-supplied per-locale character limit: 256 for
 * titles, 4096 for descriptions (spec Conventions default limits table). The
 * supported locales are exactly `en` (required) and `es` (optional, per the
 * spec's "Blueprint definition" requirement). Any other locale key is
 * rejected. On success the function returns a plain object with only the
 * given, supported locale keys.
 *
 * Throws `CatalogError('CATALOG_VALIDATION_FAILED', ..., { issues: [{ path,
 * message }] })` on failure.
 */
import { describe, expect, it } from 'vitest';
import { parseLocalizedText } from './localized-text.js';
import { isCatalogError } from './errors.js';

const TITLE_MAX_LENGTH = 256;
const DESCRIPTION_MAX_LENGTH = 4096;

function expectRejected(fn: () => unknown, path: string): void {
  try {
    fn();
    expect.unreachable('parseLocalizedText should have thrown');
  } catch (error) {
    expect(isCatalogError(error)).toBe(true);
    if (!isCatalogError(error)) throw error;
    expect(error.code).toBe('CATALOG_VALIDATION_FAILED');
    expect(error.issues).toBeDefined();
    expect(error.issues?.[0]).toMatchObject({ path });
  }
}

describe('parseLocalizedText', () => {
  it('accepts a valid title with en and es', () => {
    const value = { en: 'Service', es: 'Servicio' };

    expect(parseLocalizedText(value, '/title', TITLE_MAX_LENGTH)).toEqual(value);
  });

  it('accepts en alone', () => {
    const value = { en: 'Service' };

    expect(parseLocalizedText(value, '/title', TITLE_MAX_LENGTH)).toEqual(value);
  });

  it('"Missing English title is rejected": fails with an issue at /title/en', () => {
    expectRejected(
      () => parseLocalizedText({ es: 'Servicio' }, '/title', TITLE_MAX_LENGTH),
      '/title/en',
    );
  });

  it('"Unsupported locale is rejected": fails with an issue at /title/xx', () => {
    expectRejected(
      () => parseLocalizedText({ en: 'Service', xx: '?' }, '/title', TITLE_MAX_LENGTH),
      '/title/xx',
    );
  });

  it('enforces the 256-character per-locale limit for titles (boundary)', () => {
    const ok = 'a'.repeat(256);
    const tooLong = 'a'.repeat(257);

    expect(parseLocalizedText({ en: ok }, '/title', TITLE_MAX_LENGTH)).toEqual({ en: ok });
    expectRejected(
      () => parseLocalizedText({ en: tooLong }, '/title', TITLE_MAX_LENGTH),
      '/title/en',
    );
  });

  it('enforces the 4096-character per-locale limit for descriptions (boundary)', () => {
    const ok = 'a'.repeat(4096);
    const tooLong = 'a'.repeat(4097);

    expect(parseLocalizedText({ en: ok }, '/description', DESCRIPTION_MAX_LENGTH)).toEqual({
      en: ok,
    });
    expectRejected(
      () => parseLocalizedText({ en: tooLong }, '/description', DESCRIPTION_MAX_LENGTH),
      '/description/en',
    );
  });

  it('applies the per-locale limit to es as well as en', () => {
    const tooLong = 'a'.repeat(257);

    expectRejected(
      () => parseLocalizedText({ en: 'Service', es: tooLong }, '/title', TITLE_MAX_LENGTH),
      '/title/es',
    );
  });
});
