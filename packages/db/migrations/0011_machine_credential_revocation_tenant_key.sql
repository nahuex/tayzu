ALTER TABLE "machine_credential_revocation" DROP CONSTRAINT "machine_credential_revocation_pkey";--> statement-breakpoint
ALTER TABLE "machine_credential_revocation" ADD CONSTRAINT "machine_credential_revocation_pkey" PRIMARY KEY("tenant_id","credential_id");
