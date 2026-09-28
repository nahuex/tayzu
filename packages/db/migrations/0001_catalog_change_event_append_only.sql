-- Custom SQL migration file, put your code below! -----
-- Append-only trigger for catalog_change_event (design D4, D9; task 5.1).
-- Not expressible in Drizzle's table definitions, so this migration is
-- hand-written rather than generated. It makes the change-event log
-- tamper-resistant in 001 without needing database roles: a raw UPDATE,
-- DELETE or TRUNCATE all raise. 002 complements this with
-- REVOKE UPDATE, DELETE, TRUNCATE for the runtime role; this trigger stays as
-- a second layer, because a table owner can still disable it.
CREATE FUNCTION catalog_change_event_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'catalog_change_event is append-only: % is not allowed', TG_OP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER catalog_change_event_append_only
    BEFORE UPDATE OR DELETE ON catalog_change_event
    FOR EACH ROW
    EXECUTE FUNCTION catalog_change_event_append_only();
--> statement-breakpoint
CREATE TRIGGER catalog_change_event_append_only_truncate
    BEFORE TRUNCATE ON catalog_change_event
    FOR EACH STATEMENT
    EXECUTE FUNCTION catalog_change_event_append_only();
