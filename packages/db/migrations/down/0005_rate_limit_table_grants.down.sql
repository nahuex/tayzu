-- Down script for 0005_rate_limit_table_grants.sql (task 2.5, design D20).
REVOKE SELECT, INSERT, UPDATE, DELETE ON "auth"."rate_limit" FROM tayzu_auth;
