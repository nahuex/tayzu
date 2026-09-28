/**
 * Registers a `node-postgres` text parser for `name[]` (OID 1003), the array
 * type Postgres uses for `pg_attribute.attname`, `pg_constraint.conname` and
 * similar catalog columns. `pg-types` ships parsers for `text[]`, `varchar[]`
 * and `char[]` (all structurally identical comma-separated array literals),
 * but not for `name[]`, so an unregistered `name[]` value is returned as its
 * raw literal (for example `"{id}"`) instead of a JavaScript array. System-
 * catalog introspection (`information_schema`/`pg_catalog`, as task 5.1's
 * `schema.int.test.ts` does) is the only place this package emits `name[]`,
 * so reusing the existing `text[]` (OID 1009) parser is exact and sufficient.
 *
 * `pg-types`' parser table is a module-level singleton shared by every `pg`
 * client and pool in the process, so importing this module once (from this
 * package's entry point) is enough to fix every connection, including the
 * ones test files open directly with `drizzle-orm/node-postgres`.
 *
 * `@types/pg` (via `pg-types`) types `setTypeParser`'s OID as its own
 * `TypeId` enum, which only lists a curated subset of base types and cannot
 * be imported by name here (`pg-types` is a transitive dependency of `pg`,
 * not a direct one). `Parameters<...>` reads the same nominal type off the
 * function itself instead, so the two real OIDs below are asserted to it
 * without an unchecked `any`.
 */
import pg from 'pg';

type SetTypeParserArgs = Parameters<typeof pg.types.setTypeParser>;
type PgTypeId = SetTypeParserArgs[0];
type PgTypeParser = SetTypeParserArgs[2];

const NAME_ARRAY_OID = 1003 as PgTypeId;
const TEXT_ARRAY_OID = 1009 as PgTypeId;

const textArrayParser = pg.types.getTypeParser(TEXT_ARRAY_OID, 'text') as PgTypeParser;

pg.types.setTypeParser(NAME_ARRAY_OID, 'text', textArrayParser);
