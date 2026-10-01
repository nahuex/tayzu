CREATE TABLE "machine_credential_revocation" (
	"credential_id" text PRIMARY KEY NOT NULL,
	"revoked_at" timestamp with time zone NOT NULL,
	"tenant_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "machine_credential_revocation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "machine_credential_revocation" AS PERMISSIVE FOR ALL TO "tayzu_app" USING ("machine_credential_revocation"."tenant_id" = current_setting('app.tenant_id', true)) WITH CHECK ("machine_credential_revocation"."tenant_id" = current_setting('app.tenant_id', true));