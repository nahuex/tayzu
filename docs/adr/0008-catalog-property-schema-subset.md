# ADR-0008: A restricted JSON Schema subset for blueprint properties

- **Status**: Accepted
- **Date**: 2026-09-27
- **Change**: [`001-catalog-core`](../../openspec/changes/archive/2026-09-28-001-catalog-core/design.md) (design D6)

## Context

Blueprints declare their properties as JSON Schema fragments, and entity
`spec` and `status` values are validated against them. Port accepts a broad
JSON Schema dialect. Tayzu needs the same expressiveness for everyday
catalog modelling, but a general JSON Schema validator on tenant-supplied
schemas opens several risks:

- **SSRF**: remote `$ref` makes the server fetch arbitrary URLs.
- **ReDoS**: `pattern` runs a backtracking regex engine on tenant data.
- **Resource exhaustion**: `format` validators, deep nesting and large `enum`
  lists can be abused.
- **Intractable follow-ups**: the schema-compatibility check (D7) and the
  form generator (003) must reason about every keyword a tenant can use.

## Decision

1. Property definitions use a **closed subset** of JSON Schema:
   - `string`, with `format` limited to `date-time`, `url`, `email`,
     `markdown` and `yaml`, and the keywords `minLength`, `maxLength`,
     `pattern`, `enum` and `default`;
   - `number` and `integer`, with `minimum`, `maximum`, `enum` and `default`;
   - `boolean`, with `default`;
   - `array` of the primitive types above, with `minItems`, `maxItems` and
     `uniqueItems`;
   - `object`, a free-form JSON object bounded by size and nesting depth.
2. Anything else is rejected at definition time with a JSON-Pointer issue.
   This explicitly includes `$ref`, `$id`, `$defs`, `if`/`then`/`else` and
   nested object schemas.
3. `pattern` is compiled with **RE2** (`re2js`, a pure-JS linear-time
   engine), at most 512 characters. Backreferences and lookaround are
   rejected.
4. Definitions are meta-validated by a strict parser. Entity values are then
   validated by Ajv against a schema **derived** from the parsed definition,
   so Ajv never compiles tenant JSON directly. Ajv uses the RE2 adapter as its
   regex engine and `ajv-formats` in `fast` mode.
5. `url` values must use the `http` or `https` scheme. Every formatted
   string is capped at 2048 characters before its format is checked.
   `markdown` and `yaml` are presentation hints and are never parsed on the
   server.

## Alternatives considered

- **Full JSON Schema, like Port.** Rejected because of the SSRF, ReDoS and
  compatibility-checking problems above.
- **`@cfworker/json-schema`** (no code generation). Rejected: it is slower on
  hot paths and less mature. The code-generation risk of Ajv is contained
  because Ajv only compiles the derived subset.
- **Native `re2` bindings.** Rejected: they need prebuilt native binaries,
  which adds supply-chain risk (SEC07). `re2js` is pure JavaScript.

## Consequences

- Tenants cannot express some advanced JSON Schema constraints. The subset
  can grow additively; each new keyword needs a compatibility rule (D7) and
  form support (003).
- Format and pattern validation have predictable, linear cost.
- The same meta-validation module is reused by 003's form generator, so the
  UI and the API accept exactly the same definitions.
