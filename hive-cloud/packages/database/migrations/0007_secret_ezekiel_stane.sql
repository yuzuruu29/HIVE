ALTER TYPE "public"."provider_kind" ADD VALUE 'openai' BEFORE 'custom';--> statement-breakpoint
ALTER TYPE "public"."provider_kind" ADD VALUE 'anthropic' BEFORE 'custom';--> statement-breakpoint
CREATE TABLE "analytics_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"user_id" uuid,
	"event_name" text NOT NULL,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_accounts" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"paypal_payer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload_hash" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"reserved_credits" integer NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entitlements" (
	"tenant_id" uuid NOT NULL,
	"plan_id" text NOT NULL,
	"plan_version" integer DEFAULT 1 NOT NULL,
	"limits_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_price_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_microusd_per_token" integer NOT NULL,
	"output_microusd_per_token" integer NOT NULL,
	"cache_read_microusd_per_token" integer,
	"source_url" text NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"external_order_id" text NOT NULL,
	"external_capture_id" text,
	"sku" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"credits_granted" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text DEFAULT 'paypal' NOT NULL,
	"external_subscription_id" text NOT NULL,
	"plan_version" text NOT NULL,
	"status" text NOT NULL,
	"current_period_start" timestamp with time zone NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"paid_through" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD COLUMN "balance_class" text DEFAULT 'subscription';--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD COLUMN "payment_event_id" text;--> statement-breakpoint
ALTER TABLE "router_requests" ADD COLUMN "price_snapshot_id" uuid;--> statement-breakpoint
ALTER TABLE "router_requests" ADD COLUMN "prompt_cache_hit_tokens" integer;--> statement-breakpoint
ALTER TABLE "router_requests" ADD COLUMN "prompt_cache_write_tokens" integer;--> statement-breakpoint
ALTER TABLE "router_requests" ADD COLUMN "provider_cost_microusd" integer;--> statement-breakpoint
ALTER TABLE "router_requests" ADD COLUMN "reserved_credits" integer;--> statement-breakpoint
ALTER TABLE "router_requests" ADD COLUMN "debited_credits" integer;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analytics_events_name_created_idx" ON "analytics_events" USING btree ("event_name","created_at");--> statement-breakpoint
CREATE INDEX "analytics_events_tenant_idx" ON "analytics_events" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_events_external_event_id_unique" ON "billing_events" USING btree ("external_event_id");--> statement-breakpoint
CREATE INDEX "credit_reservations_tenant_request_idx" ON "credit_reservations" USING btree ("tenant_id","request_id");--> statement-breakpoint
CREATE INDEX "entitlements_tenant_effective_idx" ON "entitlements" USING btree ("tenant_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "price_snapshots_provider_model_effective_idx" ON "model_price_snapshots" USING btree ("provider","model","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_orders_external_order_unique" ON "payment_orders" USING btree ("external_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_external_id_unique" ON "subscriptions" USING btree ("external_subscription_id");--> statement-breakpoint
CREATE INDEX "subscriptions_tenant_idx" ON "subscriptions" USING btree ("tenant_id");