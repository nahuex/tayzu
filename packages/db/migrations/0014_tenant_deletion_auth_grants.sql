-- Custom SQL migration file, put your code below! --
-- Hand-written custom SQL (045 design D1, D2, Migration Plan; task 2.3;
-- Resolved decisions Q49, Q59, Q65, Q82, Q150, Q151 and Q161). Grants and
-- row-level security policies are not expressible through Drizzle's table
-- definitions (`packages/auth/src/persistence/schema.ts`), so this migration
-- is hand-written, the same pattern 0003, 0005 and 0013 already used.
--
-- The Better Auth side of the deletion access model, in its own Checkpoint 3
-- review so that the approved 0013 stays immutable (Q82). Purge step 2 runs
-- as `tayzu_purge` (design D2), so the Better Auth rows get the same
-- boundary as the catalog rows (Q49): row-level security itself, not code,
-- limits what the purge role can read and delete.
--
-- - Row-level security is enabled on the nine Better Auth tables step 2
--   deletes from, named one by one: `organization`, `member`, `invitation`,
--   `apikey`, `session`, `user`, `account`, `two_factor` and
--   `verification`.
-- - `tayzu_auth` keeps full access to every tenant's rows on each of them
--   through a permissive policy `USING (true) WITH CHECK (true)` (Q59 as
--   reworded by Q65): Better Auth's behavior is unchanged, and the due-tenant
--   restriction applies to the purge role only.
-- - `tayzu_purge` gets `USAGE` on schema `auth` (0003 revoked it from
--   PUBLIC) and an explicit table-level `GRANT SELECT, DELETE` on each of the
--   nine tables (a policy grants nothing without the privilege), and nothing
--   else on schema `auth`: no `CREATE`, no sequence, and no grant on
--   `auth.jwks` or `auth.rate_limit` (Q151) or any other table.
-- - Each table gets a `SELECT` and a `DELETE` policy for `tayzu_purge`,
--   because a `DELETE ... WHERE` needs a `SELECT` policy as well as the
--   `DELETE` one. The two carry the same predicate, except on `auth.member`,
--   whose `SELECT` policy admits every row (Q65).
--
-- The predicates, each written out in full in every policy:
--
-- - "Due" is the predicate of 0013: a marker of the tenant with
--   `state = 'pending' AND purge_after <= now()`. The tenant id is the
--   organization id. A policy's subquery runs as `tayzu_purge`, under its
--   own policies, so the marker subquery restates the due predicate rather
--   than relying on what `purge_due_select` on the marker admits (that
--   policy also admits the marker this transaction has just turned `purged`,
--   Q161 (1) and (4)): once the marker is `purged`, no Better Auth row is
--   admitted any more.
-- - An organization-keyed row is admitted when its organization is due:
--   the organization itself by `id`, `member` and `invitation` by
--   `organization_id`, `apikey` by `reference_id`, and a `session` by
--   `active_organization_id` (neither of the last two has a foreign key).
-- - The user predicate admits a user who has at least one membership and no
--   membership in a tenant that is not due. "At least one" is explicit:
--   without it, a user with no membership at all would satisfy "every
--   membership is in a due tenant" vacuously. The membership subqueries see
--   every `auth.member` row through the read-only `purge_read_all` policy
--   (Q65), so a membership in a tenant that is not due is always seen. It
--   admits `user` by `id`, and `account` and `two_factor` by `user_id`.
-- - A `session` is admitted when its active organization is due or its user
--   passes the user predicate.
-- - An `auth.verification` row is admitted by its identifier family only:
--   each family matches by its exact prefix, and the rest of the identifier
--   is joined to the row it names (Q150). `invitation-accept:<invitationId>`
--   and `invitation-shed:<invitationId>` join the invitation, whose
--   organization must be due; `step-up-verified:<sessionToken>` joins the
--   session by `token`, under the session rule above; `temp-password:<userId>`
--   and `mfa-reenrol:<userId>` take the user predicate of the user they
--   name; `sso-link:<accountId>` joins the `account` row by its own `id`,
--   whose user must pass the user predicate. Nothing matches on `value`, and
--   `password-reset:<id>` (and every other family) gets no disjunct: it is
--   exempt (Q150). Since every family joins a row, step 2 deletes a
--   verification row before the row its policy joins (design D2, task 6.2).
--
-- No function is created and no ownership is transferred (Q48, Q49): every
-- rule is a grant or a policy.
--
-- `FORCE ROW LEVEL SECURITY` is deliberately not set on these tables: the
-- design does not ask for it, the owner is the migration role
-- (`tayzu_migrator`), which no runtime path uses, and the runtime roles are
-- bound by these policies either way. The catalog tables are forced because
-- their policies are the tenant isolation of `tayzu_app` (0006, 0009); here
-- `tayzu_auth` is unrestricted by design.
GRANT USAGE ON SCHEMA auth TO tayzu_purge;
--> statement-breakpoint
-- `auth.organization`: the tenant itself, deleted last in step 2. Each table's
-- `tayzu_auth` policy is created before its row-level security is enabled, so
-- that Better Auth never sees the table with no policy.
CREATE POLICY auth_full_access ON auth.organization AS PERMISSIVE FOR ALL TO tayzu_auth
  USING (true)
  WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, DELETE ON auth.organization TO tayzu_purge;
--> statement-breakpoint
CREATE POLICY purge_due_select ON auth.organization AS PERMISSIVE FOR SELECT TO tayzu_purge
  USING (EXISTS (
    SELECT 1 FROM public.tenant_deletion_marker m
     WHERE m.tenant_id = organization.id
       AND m.state = 'pending' AND m.purge_after <= now()
  ));
--> statement-breakpoint
CREATE POLICY purge_due_delete ON auth.organization AS PERMISSIVE FOR DELETE TO tayzu_purge
  USING (EXISTS (
    SELECT 1 FROM public.tenant_deletion_marker m
     WHERE m.tenant_id = organization.id
       AND m.state = 'pending' AND m.purge_after <= now()
  ));
--> statement-breakpoint
ALTER TABLE auth.organization ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- `auth.member`: every row is readable (Q65), so that the user predicate sees
-- a user's memberships in tenants that are not due; the `DELETE` stays
-- limited to a due tenant, and its `DELETE ... WHERE` reads through the
-- read-only policy.
CREATE POLICY auth_full_access ON auth.member AS PERMISSIVE FOR ALL TO tayzu_auth
  USING (true)
  WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, DELETE ON auth.member TO tayzu_purge;
--> statement-breakpoint
CREATE POLICY purge_read_all ON auth.member AS PERMISSIVE FOR SELECT TO tayzu_purge
  USING (true);
--> statement-breakpoint
CREATE POLICY purge_due_delete ON auth.member AS PERMISSIVE FOR DELETE TO tayzu_purge
  USING (EXISTS (
    SELECT 1 FROM public.tenant_deletion_marker m
     WHERE m.tenant_id = member.organization_id
       AND m.state = 'pending' AND m.purge_after <= now()
  ));
--> statement-breakpoint
ALTER TABLE auth.member ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- `auth.invitation`: by its organization.
CREATE POLICY auth_full_access ON auth.invitation AS PERMISSIVE FOR ALL TO tayzu_auth
  USING (true)
  WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, DELETE ON auth.invitation TO tayzu_purge;
--> statement-breakpoint
CREATE POLICY purge_due_select ON auth.invitation AS PERMISSIVE FOR SELECT TO tayzu_purge
  USING (EXISTS (
    SELECT 1 FROM public.tenant_deletion_marker m
     WHERE m.tenant_id = invitation.organization_id
       AND m.state = 'pending' AND m.purge_after <= now()
  ));
--> statement-breakpoint
CREATE POLICY purge_due_delete ON auth.invitation AS PERMISSIVE FOR DELETE TO tayzu_purge
  USING (EXISTS (
    SELECT 1 FROM public.tenant_deletion_marker m
     WHERE m.tenant_id = invitation.organization_id
       AND m.state = 'pending' AND m.purge_after <= now()
  ));
--> statement-breakpoint
ALTER TABLE auth.invitation ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- `auth.apikey`: an organization's key by `reference_id`, which has no
-- foreign key.
CREATE POLICY auth_full_access ON auth.apikey AS PERMISSIVE FOR ALL TO tayzu_auth
  USING (true)
  WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, DELETE ON auth.apikey TO tayzu_purge;
--> statement-breakpoint
CREATE POLICY purge_due_select ON auth.apikey AS PERMISSIVE FOR SELECT TO tayzu_purge
  USING (EXISTS (
    SELECT 1 FROM public.tenant_deletion_marker m
     WHERE m.tenant_id = apikey.reference_id
       AND m.state = 'pending' AND m.purge_after <= now()
  ));
--> statement-breakpoint
CREATE POLICY purge_due_delete ON auth.apikey AS PERMISSIVE FOR DELETE TO tayzu_purge
  USING (EXISTS (
    SELECT 1 FROM public.tenant_deletion_marker m
     WHERE m.tenant_id = apikey.reference_id
       AND m.state = 'pending' AND m.purge_after <= now()
  ));
--> statement-breakpoint
ALTER TABLE auth.apikey ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- `auth.session`: by `active_organization_id` (no foreign key; the sessions
-- of users who stay) or by the user predicate of its `user_id` (the sessions
-- of a user who leaves, whatever their active organization).
CREATE POLICY auth_full_access ON auth.session AS PERMISSIVE FOR ALL TO tayzu_auth
  USING (true)
  WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, DELETE ON auth.session TO tayzu_purge;
--> statement-breakpoint
CREATE POLICY purge_due_select ON auth.session AS PERMISSIVE FOR SELECT TO tayzu_purge
  USING (
    EXISTS (
      SELECT 1 FROM public.tenant_deletion_marker m
       WHERE m.tenant_id = session.active_organization_id
         AND m.state = 'pending' AND m.purge_after <= now()
    )
    OR (
      EXISTS (SELECT 1 FROM auth.member mb WHERE mb.user_id = session.user_id)
      AND NOT EXISTS (
        SELECT 1 FROM auth.member mb
         WHERE mb.user_id = session.user_id
           AND NOT EXISTS (
             SELECT 1 FROM public.tenant_deletion_marker m
              WHERE m.tenant_id = mb.organization_id
                AND m.state = 'pending' AND m.purge_after <= now()
           )
      )
    )
  );
--> statement-breakpoint
CREATE POLICY purge_due_delete ON auth.session AS PERMISSIVE FOR DELETE TO tayzu_purge
  USING (
    EXISTS (
      SELECT 1 FROM public.tenant_deletion_marker m
       WHERE m.tenant_id = session.active_organization_id
         AND m.state = 'pending' AND m.purge_after <= now()
    )
    OR (
      EXISTS (SELECT 1 FROM auth.member mb WHERE mb.user_id = session.user_id)
      AND NOT EXISTS (
        SELECT 1 FROM auth.member mb
         WHERE mb.user_id = session.user_id
           AND NOT EXISTS (
             SELECT 1 FROM public.tenant_deletion_marker m
              WHERE m.tenant_id = mb.organization_id
                AND m.state = 'pending' AND m.purge_after <= now()
           )
      )
    )
  );
--> statement-breakpoint
ALTER TABLE auth.session ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- `auth.user`: the user predicate. Step 2 deletes a user while its
-- membership in the due tenant still exists, so "at least one" holds.
CREATE POLICY auth_full_access ON auth."user" AS PERMISSIVE FOR ALL TO tayzu_auth
  USING (true)
  WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, DELETE ON auth."user" TO tayzu_purge;
--> statement-breakpoint
CREATE POLICY purge_due_select ON auth."user" AS PERMISSIVE FOR SELECT TO tayzu_purge
  USING (
    EXISTS (SELECT 1 FROM auth.member mb WHERE mb.user_id = "user".id)
    AND NOT EXISTS (
      SELECT 1 FROM auth.member mb
       WHERE mb.user_id = "user".id
         AND NOT EXISTS (
           SELECT 1 FROM public.tenant_deletion_marker m
            WHERE m.tenant_id = mb.organization_id
              AND m.state = 'pending' AND m.purge_after <= now()
         )
    )
  );
--> statement-breakpoint
CREATE POLICY purge_due_delete ON auth."user" AS PERMISSIVE FOR DELETE TO tayzu_purge
  USING (
    EXISTS (SELECT 1 FROM auth.member mb WHERE mb.user_id = "user".id)
    AND NOT EXISTS (
      SELECT 1 FROM auth.member mb
       WHERE mb.user_id = "user".id
         AND NOT EXISTS (
           SELECT 1 FROM public.tenant_deletion_marker m
            WHERE m.tenant_id = mb.organization_id
              AND m.state = 'pending' AND m.purge_after <= now()
         )
    )
  );
--> statement-breakpoint
ALTER TABLE auth."user" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- `auth.account`: the user predicate of its `user_id`.
CREATE POLICY auth_full_access ON auth.account AS PERMISSIVE FOR ALL TO tayzu_auth
  USING (true)
  WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, DELETE ON auth.account TO tayzu_purge;
--> statement-breakpoint
CREATE POLICY purge_due_select ON auth.account AS PERMISSIVE FOR SELECT TO tayzu_purge
  USING (
    EXISTS (SELECT 1 FROM auth.member mb WHERE mb.user_id = account.user_id)
    AND NOT EXISTS (
      SELECT 1 FROM auth.member mb
       WHERE mb.user_id = account.user_id
         AND NOT EXISTS (
           SELECT 1 FROM public.tenant_deletion_marker m
            WHERE m.tenant_id = mb.organization_id
              AND m.state = 'pending' AND m.purge_after <= now()
         )
    )
  );
--> statement-breakpoint
CREATE POLICY purge_due_delete ON auth.account AS PERMISSIVE FOR DELETE TO tayzu_purge
  USING (
    EXISTS (SELECT 1 FROM auth.member mb WHERE mb.user_id = account.user_id)
    AND NOT EXISTS (
      SELECT 1 FROM auth.member mb
       WHERE mb.user_id = account.user_id
         AND NOT EXISTS (
           SELECT 1 FROM public.tenant_deletion_marker m
            WHERE m.tenant_id = mb.organization_id
              AND m.state = 'pending' AND m.purge_after <= now()
         )
    )
  );
--> statement-breakpoint
ALTER TABLE auth.account ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- `auth.two_factor`: the user predicate of its `user_id`.
CREATE POLICY auth_full_access ON auth.two_factor AS PERMISSIVE FOR ALL TO tayzu_auth
  USING (true)
  WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, DELETE ON auth.two_factor TO tayzu_purge;
--> statement-breakpoint
CREATE POLICY purge_due_select ON auth.two_factor AS PERMISSIVE FOR SELECT TO tayzu_purge
  USING (
    EXISTS (SELECT 1 FROM auth.member mb WHERE mb.user_id = two_factor.user_id)
    AND NOT EXISTS (
      SELECT 1 FROM auth.member mb
       WHERE mb.user_id = two_factor.user_id
         AND NOT EXISTS (
           SELECT 1 FROM public.tenant_deletion_marker m
            WHERE m.tenant_id = mb.organization_id
              AND m.state = 'pending' AND m.purge_after <= now()
         )
    )
  );
--> statement-breakpoint
CREATE POLICY purge_due_delete ON auth.two_factor AS PERMISSIVE FOR DELETE TO tayzu_purge
  USING (
    EXISTS (SELECT 1 FROM auth.member mb WHERE mb.user_id = two_factor.user_id)
    AND NOT EXISTS (
      SELECT 1 FROM auth.member mb
       WHERE mb.user_id = two_factor.user_id
         AND NOT EXISTS (
           SELECT 1 FROM public.tenant_deletion_marker m
            WHERE m.tenant_id = mb.organization_id
              AND m.state = 'pending' AND m.purge_after <= now()
         )
    )
  );
--> statement-breakpoint
ALTER TABLE auth.two_factor ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- `auth.verification`: by identifier family (Q150), one disjunct per family,
-- each an exact prefix (`starts_with`) and the rest of the identifier
-- (`substr` after the prefix) joined to the row it names. The joined
-- `invitation`, `session` and `account` rows are read as `tayzu_purge`, under
-- their own policies, which admit the same rows the disjuncts restate.
-- `password-reset:` has no disjunct, and `value` is never read.
CREATE POLICY auth_full_access ON auth.verification AS PERMISSIVE FOR ALL TO tayzu_auth
  USING (true)
  WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, DELETE ON auth.verification TO tayzu_purge;
--> statement-breakpoint
CREATE POLICY purge_due_select ON auth.verification AS PERMISSIVE FOR SELECT TO tayzu_purge
  USING (
    -- `invitation-accept:<invitationId>`: an invitation of a due tenant.
    (
      starts_with(verification.identifier, 'invitation-accept:')
      AND EXISTS (
        SELECT 1 FROM auth.invitation i
         WHERE i.id = substr(verification.identifier, char_length('invitation-accept:') + 1)
           AND EXISTS (
             SELECT 1 FROM public.tenant_deletion_marker m
              WHERE m.tenant_id = i.organization_id
                AND m.state = 'pending' AND m.purge_after <= now()
           )
      )
    )
    -- `invitation-shed:<invitationId>`: the same join.
    OR (
      starts_with(verification.identifier, 'invitation-shed:')
      AND EXISTS (
        SELECT 1 FROM auth.invitation i
         WHERE i.id = substr(verification.identifier, char_length('invitation-shed:') + 1)
           AND EXISTS (
             SELECT 1 FROM public.tenant_deletion_marker m
              WHERE m.tenant_id = i.organization_id
                AND m.state = 'pending' AND m.purge_after <= now()
           )
      )
    )
    -- `step-up-verified:<sessionToken>`: a session step 2 deletes, under the
    -- session rule (a due active organization, or the user predicate).
    OR (
      starts_with(verification.identifier, 'step-up-verified:')
      AND EXISTS (
        SELECT 1 FROM auth.session s
         WHERE s.token = substr(verification.identifier, char_length('step-up-verified:') + 1)
           AND (
             EXISTS (
               SELECT 1 FROM public.tenant_deletion_marker m
                WHERE m.tenant_id = s.active_organization_id
                  AND m.state = 'pending' AND m.purge_after <= now()
             )
             OR (
               EXISTS (SELECT 1 FROM auth.member mb WHERE mb.user_id = s.user_id)
               AND NOT EXISTS (
                 SELECT 1 FROM auth.member mb
                  WHERE mb.user_id = s.user_id
                    AND NOT EXISTS (
                      SELECT 1 FROM public.tenant_deletion_marker m
                       WHERE m.tenant_id = mb.organization_id
                         AND m.state = 'pending' AND m.purge_after <= now()
                    )
               )
             )
           )
      )
    )
    -- `temp-password:<userId>`: the user predicate of the named user.
    OR (
      starts_with(verification.identifier, 'temp-password:')
      AND EXISTS (
        SELECT 1 FROM auth.member mb
         WHERE mb.user_id = substr(verification.identifier, char_length('temp-password:') + 1)
      )
      AND NOT EXISTS (
        SELECT 1 FROM auth.member mb
         WHERE mb.user_id = substr(verification.identifier, char_length('temp-password:') + 1)
           AND NOT EXISTS (
             SELECT 1 FROM public.tenant_deletion_marker m
              WHERE m.tenant_id = mb.organization_id
                AND m.state = 'pending' AND m.purge_after <= now()
           )
      )
    )
    -- `mfa-reenrol:<userId>` (044's marker, far-future expiry): the same.
    OR (
      starts_with(verification.identifier, 'mfa-reenrol:')
      AND EXISTS (
        SELECT 1 FROM auth.member mb
         WHERE mb.user_id = substr(verification.identifier, char_length('mfa-reenrol:') + 1)
      )
      AND NOT EXISTS (
        SELECT 1 FROM auth.member mb
         WHERE mb.user_id = substr(verification.identifier, char_length('mfa-reenrol:') + 1)
           AND NOT EXISTS (
             SELECT 1 FROM public.tenant_deletion_marker m
              WHERE m.tenant_id = mb.organization_id
                AND m.state = 'pending' AND m.purge_after <= now()
           )
      )
    )
    -- `sso-link:<accountId>`: the `account` row of that id, whose user
    -- passes the user predicate.
    OR (
      starts_with(verification.identifier, 'sso-link:')
      AND EXISTS (
        SELECT 1 FROM auth.account a
         WHERE a.id = substr(verification.identifier, char_length('sso-link:') + 1)
           AND EXISTS (SELECT 1 FROM auth.member mb WHERE mb.user_id = a.user_id)
           AND NOT EXISTS (
             SELECT 1 FROM auth.member mb
              WHERE mb.user_id = a.user_id
                AND NOT EXISTS (
                  SELECT 1 FROM public.tenant_deletion_marker m
                   WHERE m.tenant_id = mb.organization_id
                     AND m.state = 'pending' AND m.purge_after <= now()
                )
           )
      )
    )
  );
--> statement-breakpoint
CREATE POLICY purge_due_delete ON auth.verification AS PERMISSIVE FOR DELETE TO tayzu_purge
  USING (
    -- `invitation-accept:<invitationId>`: an invitation of a due tenant.
    (
      starts_with(verification.identifier, 'invitation-accept:')
      AND EXISTS (
        SELECT 1 FROM auth.invitation i
         WHERE i.id = substr(verification.identifier, char_length('invitation-accept:') + 1)
           AND EXISTS (
             SELECT 1 FROM public.tenant_deletion_marker m
              WHERE m.tenant_id = i.organization_id
                AND m.state = 'pending' AND m.purge_after <= now()
           )
      )
    )
    -- `invitation-shed:<invitationId>`: the same join.
    OR (
      starts_with(verification.identifier, 'invitation-shed:')
      AND EXISTS (
        SELECT 1 FROM auth.invitation i
         WHERE i.id = substr(verification.identifier, char_length('invitation-shed:') + 1)
           AND EXISTS (
             SELECT 1 FROM public.tenant_deletion_marker m
              WHERE m.tenant_id = i.organization_id
                AND m.state = 'pending' AND m.purge_after <= now()
           )
      )
    )
    -- `step-up-verified:<sessionToken>`: a session step 2 deletes, under the
    -- session rule (a due active organization, or the user predicate).
    OR (
      starts_with(verification.identifier, 'step-up-verified:')
      AND EXISTS (
        SELECT 1 FROM auth.session s
         WHERE s.token = substr(verification.identifier, char_length('step-up-verified:') + 1)
           AND (
             EXISTS (
               SELECT 1 FROM public.tenant_deletion_marker m
                WHERE m.tenant_id = s.active_organization_id
                  AND m.state = 'pending' AND m.purge_after <= now()
             )
             OR (
               EXISTS (SELECT 1 FROM auth.member mb WHERE mb.user_id = s.user_id)
               AND NOT EXISTS (
                 SELECT 1 FROM auth.member mb
                  WHERE mb.user_id = s.user_id
                    AND NOT EXISTS (
                      SELECT 1 FROM public.tenant_deletion_marker m
                       WHERE m.tenant_id = mb.organization_id
                         AND m.state = 'pending' AND m.purge_after <= now()
                    )
               )
             )
           )
      )
    )
    -- `temp-password:<userId>`: the user predicate of the named user.
    OR (
      starts_with(verification.identifier, 'temp-password:')
      AND EXISTS (
        SELECT 1 FROM auth.member mb
         WHERE mb.user_id = substr(verification.identifier, char_length('temp-password:') + 1)
      )
      AND NOT EXISTS (
        SELECT 1 FROM auth.member mb
         WHERE mb.user_id = substr(verification.identifier, char_length('temp-password:') + 1)
           AND NOT EXISTS (
             SELECT 1 FROM public.tenant_deletion_marker m
              WHERE m.tenant_id = mb.organization_id
                AND m.state = 'pending' AND m.purge_after <= now()
           )
      )
    )
    -- `mfa-reenrol:<userId>` (044's marker, far-future expiry): the same.
    OR (
      starts_with(verification.identifier, 'mfa-reenrol:')
      AND EXISTS (
        SELECT 1 FROM auth.member mb
         WHERE mb.user_id = substr(verification.identifier, char_length('mfa-reenrol:') + 1)
      )
      AND NOT EXISTS (
        SELECT 1 FROM auth.member mb
         WHERE mb.user_id = substr(verification.identifier, char_length('mfa-reenrol:') + 1)
           AND NOT EXISTS (
             SELECT 1 FROM public.tenant_deletion_marker m
              WHERE m.tenant_id = mb.organization_id
                AND m.state = 'pending' AND m.purge_after <= now()
           )
      )
    )
    -- `sso-link:<accountId>`: the `account` row of that id, whose user
    -- passes the user predicate.
    OR (
      starts_with(verification.identifier, 'sso-link:')
      AND EXISTS (
        SELECT 1 FROM auth.account a
         WHERE a.id = substr(verification.identifier, char_length('sso-link:') + 1)
           AND EXISTS (SELECT 1 FROM auth.member mb WHERE mb.user_id = a.user_id)
           AND NOT EXISTS (
             SELECT 1 FROM auth.member mb
              WHERE mb.user_id = a.user_id
                AND NOT EXISTS (
                  SELECT 1 FROM public.tenant_deletion_marker m
                   WHERE m.tenant_id = mb.organization_id
                     AND m.state = 'pending' AND m.purge_after <= now()
                )
           )
      )
    )
  );
--> statement-breakpoint
ALTER TABLE auth.verification ENABLE ROW LEVEL SECURITY;
