/**
 * Assumed API of `./errors.js` (task 2.1):
 *
 * ```ts
 * type CatalogErrorCode =
 *   | 'CATALOG_CONTEXT_REQUIRED'
 *   | 'CATALOG_VALIDATION_FAILED'
 *   | 'CATALOG_NOT_FOUND'
 *   | 'CATALOG_ALREADY_EXISTS'
 *   | 'CATALOG_VERSION_CONFLICT'
 *   | 'CATALOG_REFERENCE_VIOLATION'
 *   | 'CATALOG_SCHEMA_INCOMPATIBLE'
 *   | 'CATALOG_RESERVED_IDENTIFIER'
 *   | 'CATALOG_LIMIT_EXCEEDED';
 *
 * const CATALOG_ERROR_CODES: readonly CatalogErrorCode[]; // exact list above, in this order
 *
 * interface CatalogErrorIssue { path: string; message: string } // path is a JSON Pointer
 *
 * class CatalogError extends Error {
 *   readonly code: CatalogErrorCode;
 *   readonly issues?: readonly CatalogErrorIssue[];
 *   readonly details?: Readonly<Record<string, unknown>>;
 *   constructor(
 *     code: CatalogErrorCode,
 *     message: string,
 *     options?: { issues?: readonly CatalogErrorIssue[]; details?: Record<string, unknown> },
 *   );
 * }
 *
 * function isCatalogError(error: unknown): error is CatalogError;
 * ```
 *
 * This is the stable code list from the spec's Conventions section
 * ("Error codes"). `issues` carries JSON Pointer paths, `details` carries any
 * extra machine-readable data (for example a rejection `reason` or a limit
 * name). Both are preserved exactly as given to the constructor.
 */
import { describe, expect, it } from 'vitest';
import {
  CATALOG_ERROR_CODES,
  CatalogError,
  isCatalogError,
  type CatalogErrorCode,
} from './errors.js';

const EXPECTED_CODES: readonly CatalogErrorCode[] = [
  'CATALOG_CONTEXT_REQUIRED',
  'CATALOG_VALIDATION_FAILED',
  'CATALOG_NOT_FOUND',
  'CATALOG_ALREADY_EXISTS',
  'CATALOG_VERSION_CONFLICT',
  'CATALOG_REFERENCE_VIOLATION',
  'CATALOG_SCHEMA_INCOMPATIBLE',
  'CATALOG_RESERVED_IDENTIFIER',
  'CATALOG_LIMIT_EXCEEDED',
];

describe('CATALOG_ERROR_CODES', () => {
  it('matches the spec Conventions error code list exactly', () => {
    expect(CATALOG_ERROR_CODES).toEqual(EXPECTED_CODES);
  });
});

describe('CatalogError', () => {
  it.each(EXPECTED_CODES)('is constructible with code %s', (code) => {
    const error = new CatalogError(code, 'boom');

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(code);
    expect(error.message).toBe('boom');
  });

  it('preserves issues given at construction', () => {
    const issues = [
      { path: '/title/en', message: 'is required' },
      { path: '/identifier', message: 'is invalid' },
    ];

    const error = new CatalogError('CATALOG_VALIDATION_FAILED', 'invalid', { issues });

    expect(error.issues).toEqual(issues);
  });

  it('preserves details given at construction', () => {
    const details = { reason: 'missing_tenant' };

    const error = new CatalogError('CATALOG_CONTEXT_REQUIRED', 'no context', { details });

    expect(error.details).toEqual(details);
  });

  it('leaves issues and details undefined when not given', () => {
    const error = new CatalogError('CATALOG_NOT_FOUND', 'gone');

    expect(error.issues).toBeUndefined();
    expect(error.details).toBeUndefined();
  });
});

describe('isCatalogError', () => {
  it('returns true for a CatalogError instance', () => {
    const error = new CatalogError('CATALOG_NOT_FOUND', 'gone');

    expect(isCatalogError(error)).toBe(true);
  });

  it('returns false for a plain Error', () => {
    expect(isCatalogError(new Error('plain'))).toBe(false);
  });

  it('returns false for a non-error value', () => {
    expect(isCatalogError({ code: 'CATALOG_NOT_FOUND' })).toBe(false);
    expect(isCatalogError(undefined)).toBe(false);
    expect(isCatalogError(null)).toBe(false);
  });
});
