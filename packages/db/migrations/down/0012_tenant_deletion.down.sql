-- Down script for 0012_tenant_deletion.sql (045 task 2.1, design D1).
-- Dropping the table drops its CHECK constraints and its partial unique index.
-- Run the down script of 0013_tenant_deletion_grants first: its policies and
-- grants are on this table.
DROP INDEX IF EXISTS "tenant_deletion_marker_one_pending_uq";
DROP TABLE IF EXISTS "tenant_deletion_marker";
