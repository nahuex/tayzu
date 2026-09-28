CREATE TABLE "catalog_blueprint" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"identifier" text NOT NULL,
	"title" jsonb NOT NULL,
	"description" jsonb,
	"icon" text,
	"schema" jsonb NOT NULL,
	"status_schema" jsonb,
	"version" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_by_type" text NOT NULL,
	"created_by_id" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by_type" text NOT NULL,
	"updated_by_id" text NOT NULL,
	CONSTRAINT "catalog_blueprint_tenant_identifier_uq" UNIQUE("tenant_id","identifier"),
	CONSTRAINT "catalog_blueprint_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "catalog_blueprint_created_by_type_check" CHECK ("catalog_blueprint"."created_by_type" in ('user', 'agent', 'integration', 'system')),
	CONSTRAINT "catalog_blueprint_updated_by_type_check" CHECK ("catalog_blueprint"."updated_by_type" in ('user', 'agent', 'integration', 'system'))
);
--> statement-breakpoint
CREATE TABLE "catalog_change_event" (
	"tenant_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"on_behalf_of_type" text,
	"on_behalf_of_id" text,
	"action" text NOT NULL,
	"resource_kind" text NOT NULL,
	"blueprint_identifier" text NOT NULL,
	"resource_identifier" text NOT NULL,
	"version" integer NOT NULL,
	"changed_fields" text[] NOT NULL,
	"snapshot" jsonb NOT NULL,
	"trace_id" text,
	CONSTRAINT "catalog_change_event_pkey" PRIMARY KEY("tenant_id","seq"),
	CONSTRAINT "catalog_change_event_actor_type_check" CHECK ("catalog_change_event"."actor_type" in ('user', 'agent', 'integration', 'system')),
	CONSTRAINT "catalog_change_event_on_behalf_of_type_check" CHECK ("catalog_change_event"."on_behalf_of_type" is null or "catalog_change_event"."on_behalf_of_type" in ('user', 'agent', 'integration', 'system')),
	CONSTRAINT "catalog_change_event_on_behalf_of_pair_check" CHECK (("catalog_change_event"."on_behalf_of_type" is null and "catalog_change_event"."on_behalf_of_id" is null)
          or ("catalog_change_event"."on_behalf_of_type" is not null and "catalog_change_event"."on_behalf_of_id" is not null)),
	CONSTRAINT "catalog_change_event_action_check" CHECK ("catalog_change_event"."action" in ('created', 'updated', 'status_updated', 'deleted')),
	CONSTRAINT "catalog_change_event_resource_kind_check" CHECK ("catalog_change_event"."resource_kind" in ('blueprint', 'entity'))
);
--> statement-breakpoint
CREATE TABLE "catalog_entity" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"blueprint_id" uuid NOT NULL,
	"identifier" text NOT NULL,
	"title" text NOT NULL,
	"icon" text,
	"spec_properties" jsonb NOT NULL,
	"status_properties" jsonb,
	"status_observed_generation" integer,
	"status_observed_at" timestamp with time zone,
	"status_source" text,
	"generation" integer NOT NULL,
	"version" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_by_type" text NOT NULL,
	"created_by_id" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by_type" text NOT NULL,
	"updated_by_id" text NOT NULL,
	CONSTRAINT "catalog_entity_tenant_blueprint_identifier_uq" UNIQUE("tenant_id","blueprint_id","identifier"),
	CONSTRAINT "catalog_entity_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "catalog_entity_created_by_type_check" CHECK ("catalog_entity"."created_by_type" in ('user', 'agent', 'integration', 'system')),
	CONSTRAINT "catalog_entity_updated_by_type_check" CHECK ("catalog_entity"."updated_by_type" in ('user', 'agent', 'integration', 'system'))
);
--> statement-breakpoint
CREATE TABLE "catalog_entity_relation" (
	"tenant_id" text NOT NULL,
	"source_entity_id" uuid NOT NULL,
	"relation_definition_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"target_entity_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "catalog_entity_relation_pkey" PRIMARY KEY("tenant_id","source_entity_id","relation_definition_id","scope","target_entity_id"),
	CONSTRAINT "catalog_entity_relation_scope_check" CHECK ("catalog_entity_relation"."scope" in ('spec', 'status'))
);
--> statement-breakpoint
CREATE TABLE "catalog_relation_definition" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"source_blueprint_id" uuid NOT NULL,
	"identifier" text NOT NULL,
	"title" jsonb NOT NULL,
	"target_blueprint_id" uuid NOT NULL,
	"many" boolean NOT NULL,
	"required" boolean NOT NULL,
	CONSTRAINT "catalog_relation_definition_tenant_source_identifier_uq" UNIQUE("tenant_id","source_blueprint_id","identifier"),
	CONSTRAINT "catalog_relation_definition_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "catalog_relation_definition_many_required_check" CHECK (NOT ("catalog_relation_definition"."many" AND "catalog_relation_definition"."required"))
);
--> statement-breakpoint
CREATE TABLE "catalog_tenant_sequence" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"last_seq" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "catalog_entity" ADD CONSTRAINT "catalog_entity_blueprint_fk" FOREIGN KEY ("tenant_id","blueprint_id") REFERENCES "public"."catalog_blueprint"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_entity_relation" ADD CONSTRAINT "catalog_entity_relation_source_fk" FOREIGN KEY ("tenant_id","source_entity_id") REFERENCES "public"."catalog_entity"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_entity_relation" ADD CONSTRAINT "catalog_entity_relation_target_fk" FOREIGN KEY ("tenant_id","target_entity_id") REFERENCES "public"."catalog_entity"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_entity_relation" ADD CONSTRAINT "catalog_entity_relation_definition_fk" FOREIGN KEY ("tenant_id","relation_definition_id") REFERENCES "public"."catalog_relation_definition"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_relation_definition" ADD CONSTRAINT "catalog_relation_definition_source_blueprint_fk" FOREIGN KEY ("tenant_id","source_blueprint_id") REFERENCES "public"."catalog_blueprint"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_relation_definition" ADD CONSTRAINT "catalog_relation_definition_target_blueprint_fk" FOREIGN KEY ("tenant_id","target_blueprint_id") REFERENCES "public"."catalog_blueprint"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "catalog_change_event_resource_history_idx" ON "catalog_change_event" USING btree ("tenant_id","blueprint_identifier","resource_identifier","seq");--> statement-breakpoint
CREATE INDEX "catalog_entity_relation_tenant_target_idx" ON "catalog_entity_relation" USING btree ("tenant_id","target_entity_id");