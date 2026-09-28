/**
 * Assumed API of `./entity-validator.js` (tasks 4.1, 4.2):
 *
 * ```ts
 * export interface EntityPropertyValidator {
 *   // Validates `properties` against the compiled schema and returns a
 *   // fresh object with every omitted property that declares a `default`
 *   // filled in. An explicitly given value always wins over a `default`.
 *   // `path` is the JSON Pointer of the properties bag itself (default
 *   // `/spec/properties`; the same compiled validator is reused with
 *   // `/status/properties` for a `statusSchema` in task 8.4). An issue for
 *   // property `<name>` is reported at `${path}/<name>`.
 *   validate(properties: unknown, path?: string): Record<string, unknown>;
 * }
 *
 * function compileEntityValidator(
 *   schema: ParsedPropertySchema,   // ./blueprint-definition.js
 *   limits?: CatalogLimits,         // ./limits.js
 * ): EntityPropertyValidator;
 * ```
 *
 * Derives an Ajv (draft 2020-12) schema from the already meta-validated
 * `ParsedPropertySchema` (design D6): `additionalProperties: false`,
 * `required` copied verbatim, one sub-schema per declared property
 * translated from its `PropertyDefinition`. Ajv runs with `strict: true`,
 * `allErrors: true`, `useDefaults` (task 4.2), and `code.regExp` set to an
 * RE2 adapter over `re2js`, so the `pattern` keyword never runs a native,
 * backtracking regular expression against entity input. `ajv-formats` is
 * registered in `mode: 'fast'`, restricted to `date-time`, `email` and `uri`
 * (exposed as the `url` format). A custom keyword additionally restricts
 * `url` values to the `http` and `https` schemes, rejecting `javascript:`,
 * `data:`, `ftp:` and every other scheme. Every string property that
 * declares a `format` also gets `maxLength: limits.formattedString.maxLength`
 * (2048) applied in the derived schema, so an over-cap value is rejected as
 * a length violation independently of whether it is otherwise a
 * syntactically valid value of that format: the format's (non-RE2) regular
 * expression is never evaluated against more than
 * `limits.formattedString.maxLength` characters.
 *
 * Every violation throws `CatalogError('CATALOG_VALIDATION_FAILED', ...,
 * { issues: [{ path, message }] })`, with one issue per offending property,
 * reported at `${path}/<name>`.
 */
import { describe, expect, it } from 'vitest';
import { compileEntityValidator } from './entity-validator.js';
import { parseBlueprintDefinition } from './blueprint-definition.js';
import { isCatalogError } from './errors.js';
import { defaultCatalogLimits } from './limits.js';

/** Builds a real, meta-validated `ParsedPropertySchema` via the already-tested parser. */
function schemaFor(properties: Record<string, unknown>, required: string[] = []) {
  const blueprint = parseBlueprintDefinition({
    identifier: 'service',
    title: { en: 'Service' },
    schema: { properties, required },
  });
  return blueprint.schema;
}

function expectValidationRejected(run: () => unknown, issuePath?: string): void {
  try {
    run();
    expect.unreachable('validate should have thrown');
  } catch (error) {
    expect(isCatalogError(error)).toBe(true);
    if (!isCatalogError(error)) throw error;
    expect(error.code).toBe('CATALOG_VALIDATION_FAILED');
    if (issuePath) {
      expect(error.issues?.some((issue) => issue.path === issuePath)).toBe(true);
    }
  }
}

describe('"Spec violating the schema is rejected"', () => {
  it('rejects a wrong-typed property value at /spec/properties/language', () => {
    const schema = schemaFor(
      { language: { type: 'string', title: { en: 'Language' } } },
      ['language'],
    );
    const validator = compileEntityValidator(schema);

    expectValidationRejected(() => validator.validate({ language: 42 }), '/spec/properties/language');
  });
});

describe('"Undeclared property is rejected"', () => {
  it('rejects a property not declared on the blueprint at /spec/properties/colour', () => {
    const schema = schemaFor(
      { language: { type: 'string', title: { en: 'Language' } } },
      ['language'],
    );
    const validator = compileEntityValidator(schema);

    expectValidationRejected(
      () => validator.validate({ language: 'go', colour: 'red' }),
      '/spec/properties/colour',
    );
  });

  it('rejects it even when it is the only property given (additionalProperties: false)', () => {
    const schema = schemaFor({ language: { type: 'string', title: { en: 'Language' } } });
    const validator = compileEntityValidator(schema);

    expectValidationRejected(() => validator.validate({ colour: 'red' }), '/spec/properties/colour');
  });
});

describe('a missing required property (no default) is rejected', () => {
  it('rejects an entity omitting a required property with no default, at /spec/properties/language', () => {
    const schema = schemaFor(
      { language: { type: 'string', title: { en: 'Language' } } },
      ['language'],
    );
    const validator = compileEntityValidator(schema);

    expectValidationRejected(() => validator.validate({}), '/spec/properties/language');
  });
});

describe('"Non-HTTP URL value is rejected"', () => {
  const schema = schemaFor({ docs: { type: 'string', title: { en: 'Docs' }, format: 'url' } });

  it.each(['javascript:alert(1)', 'data:text/plain;base64,aGk=', 'ftp://example.com/file'])(
    'rejects scheme in "%s" at /spec/properties/docs',
    (value) => {
      const validator = compileEntityValidator(schema);

      expectValidationRejected(() => validator.validate({ docs: value }), '/spec/properties/docs');
    },
  );

  it('accepts an http URL', () => {
    const validator = compileEntityValidator(schema);

    expect(validator.validate({ docs: 'http://example.com/readme' })).toEqual({
      docs: 'http://example.com/readme',
    });
  });

  it('accepts an https URL', () => {
    const validator = compileEntityValidator(schema);

    expect(validator.validate({ docs: 'https://example.com/readme' })).toEqual({
      docs: 'https://example.com/readme',
    });
  });
});

describe('the 2048-character cap on formatted strings is checked before the format itself', () => {
  const schema = schemaFor({ docs: { type: 'string', title: { en: 'Docs' }, format: 'url' } });
  const prefix = 'http://a.com/';
  const cap = defaultCatalogLimits.formattedString.maxLength;

  it(`accepts a syntactically valid URL of exactly ${String(cap)} characters (boundary)`, () => {
    const value = prefix + 'a'.repeat(cap - prefix.length);
    expect(value.length).toBe(cap);
    const validator = compileEntityValidator(schema);

    expect(validator.validate({ docs: value })).toEqual({ docs: value });
  });

  it(`rejects an otherwise syntactically valid URL of ${String(cap + 1)} characters at /spec/properties/docs`, () => {
    const value = prefix + 'a'.repeat(cap + 1 - prefix.length);
    expect(value.length).toBe(cap + 1);
    const validator = compileEntityValidator(schema);

    // This value would pass an `http`/`https` URL format check on its own:
    // rejecting it proves the length cap is enforced independently of (and
    // not conditioned on) the value already being an invalid URL.
    expectValidationRejected(() => validator.validate({ docs: value }), '/spec/properties/docs');
  });

  it('rejects an over-cap value that is also an invalid scheme', () => {
    const value = 'javascript:' + 'a'.repeat(cap + 100);
    const validator = compileEntityValidator(schema);

    expectValidationRejected(() => validator.validate({ docs: value }), '/spec/properties/docs');
  });
});

describe('"Default is applied"', () => {
  it('stores and returns the default when the property is omitted', () => {
    const schema = schemaFor({
      tier: { type: 'string', title: { en: 'Tier' }, default: 'bronze' },
    });
    const validator = compileEntityValidator(schema);

    expect(validator.validate({})).toEqual({ tier: 'bronze' });
  });

  it('an explicitly given value wins over the default', () => {
    const schema = schemaFor({
      tier: { type: 'string', title: { en: 'Tier' }, default: 'bronze' },
    });
    const validator = compileEntityValidator(schema);

    expect(validator.validate({ tier: 'gold' })).toEqual({ tier: 'gold' });
  });
});

describe('pattern validation on the derived schema (RE2 regExp adapter)', () => {
  const schema = schemaFor({
    code: { type: 'string', title: { en: 'Code' }, pattern: '^[a-z]+$' },
  });

  it('rejects a value that does not match the declared pattern', () => {
    const validator = compileEntityValidator(schema);

    expectValidationRejected(() => validator.validate({ code: 'ABC123' }), '/spec/properties/code');
  });

  it('accepts a value that matches the declared pattern', () => {
    const validator = compileEntityValidator(schema);

    expect(validator.validate({ code: 'abc' })).toEqual({ code: 'abc' });
  });
});

describe('the validator can be reused for a statusSchema with a different base path', () => {
  it('reports an issue at /status/properties/<name> when validating with that path', () => {
    const schema = schemaFor({ language: { type: 'string', title: { en: 'Language' } } });
    const validator = compileEntityValidator(schema);

    expectValidationRejected(
      () => validator.validate({ language: 42 }, '/status/properties'),
      '/status/properties/language',
    );
  });
});
