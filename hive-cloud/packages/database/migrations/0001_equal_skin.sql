ALTER TABLE "audit_events" ADD COLUMN "request_id" text;--> statement-breakpoint
ALTER TABLE "router_requests" ADD COLUMN "router_policy" text DEFAULT 'free-first-balanced' NOT NULL;--> statement-breakpoint
ALTER TABLE "router_requests" ADD COLUMN "required_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "router_requests" ADD COLUMN "cost_class" text;--> statement-breakpoint
ALTER TABLE "router_requests" ADD COLUMN "fallback_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "router_requests" ADD COLUMN "completed_at" timestamp with time zone;