-- Down script for 0002_auth_schema.sql (Migration Plan, task 2.2).
-- Every Better Auth table lives in its own schema (design D2), so dropping
-- the schema cascades to every table and constraint in one statement,
-- mirroring 0000's down-script simplicity for this still-greenfield database.
DROP SCHEMA IF EXISTS "auth" CASCADE;
