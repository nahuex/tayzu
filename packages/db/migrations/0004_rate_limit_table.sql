CREATE TABLE "auth"."rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" timestamp with time zone NOT NULL,
	CONSTRAINT "rate_limit_key_uq" UNIQUE("key")
);
