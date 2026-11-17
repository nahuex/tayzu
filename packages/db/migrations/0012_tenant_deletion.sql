CREATE TABLE "tenant_deletion_marker" (
	"tenant_id" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purge_after" timestamp with time zone NOT NULL,
	"requested_by" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"catalog_purged_at" timestamp with time zone,
	"auth_purged_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" text,
	CONSTRAINT "tenant_deletion_marker_state_check" CHECK ("tenant_deletion_marker"."state" in ('pending', 'cancelled', 'purged')),
	CONSTRAINT "tenant_deletion_marker_purge_window_check" CHECK ("tenant_deletion_marker"."purge_after" >= "tenant_deletion_marker"."requested_at" + interval '7 days' and "tenant_deletion_marker"."purge_after" <= "tenant_deletion_marker"."requested_at" + interval '14 days')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_deletion_marker_one_pending_uq" ON "tenant_deletion_marker" USING btree ("tenant_id") WHERE "tenant_deletion_marker"."state" = 'pending';