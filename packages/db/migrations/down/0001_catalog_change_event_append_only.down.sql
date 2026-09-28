-- Down script for 0001_catalog_change_event_append_only.sql (task 5.1).
DROP TRIGGER IF EXISTS catalog_change_event_append_only_truncate ON catalog_change_event;
DROP TRIGGER IF EXISTS catalog_change_event_append_only ON catalog_change_event;
DROP FUNCTION IF EXISTS catalog_change_event_append_only();
