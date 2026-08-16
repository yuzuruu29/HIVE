CREATE TABLE IF NOT EXISTS "usage_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"window_key" text NOT NULL,
	"metric" text NOT NULL,
	"window_start" bigint NOT NULL,
	"window_end" bigint NOT NULL,
	"count" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_usage_windows_lookup" ON "usage_windows" USING btree ("window_key", "metric", "window_start");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_usage_windows_cleanup" ON "usage_windows" USING btree ("window_end");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_overrides" (
	"tenant_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"max_override" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "usage_overrides" ADD CONSTRAINT "usage_overrides_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_usage_overrides_lookup" ON "usage_overrides" USING btree ("tenant_id", "metric");
