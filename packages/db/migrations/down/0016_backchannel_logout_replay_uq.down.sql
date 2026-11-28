-- Down script for 0016_backchannel_logout_replay_uq.sql (048 task 7.4, design D8, Q14).
-- Drops the partial unique index of the back-channel logout replay guard. No
-- grant to revoke: the index needs none.
DROP INDEX IF EXISTS "auth"."verification_backchannel_logout_uq";
