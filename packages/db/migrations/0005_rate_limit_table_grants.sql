-- Custom SQL migration file, put your code below! -----
-- Companion custom SQL to 0004_rate_limit_table.sql (task 2.5, design D20;
-- `packages/db/CLAUDE.md`, "Any future migration that adds a table ... to
-- schema `auth` must grant `tayzu_auth` ... explicitly, in that same
-- migration"). 0003's `GRANT ... ON ALL TABLES IN SCHEMA auth` only covered
-- what existed in schema `auth` when it ran, so the table 0004 adds needs
-- its own explicit grant here, the same pattern every future auth-schema
-- table follows until a migrator-owned `ALTER DEFAULT PRIVILEGES` covers new
-- objects automatically (`packages/db/CLAUDE.md`).
GRANT SELECT, INSERT, UPDATE, DELETE ON "auth"."rate_limit" TO tayzu_auth;
