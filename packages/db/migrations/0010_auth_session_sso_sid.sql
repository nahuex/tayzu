ALTER TABLE "auth"."session" ADD COLUMN "sso_sid" text;--> statement-breakpoint
ALTER TABLE "auth"."account" ADD CONSTRAINT "account_provider_account_uq" UNIQUE("provider_id","account_id");