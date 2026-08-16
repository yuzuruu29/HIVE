CREATE TABLE "billing_checkouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"plan_id" text NOT NULL,
	"interval" text NOT NULL,
	"paypal_plan_id" text NOT NULL,
	"nonce_digest" text NOT NULL,
	"external_subscription_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "credit_reservations_tenant_request_idx";--> statement-breakpoint
UPDATE "credit_ledger" SET "balance_class" = 'subscription' WHERE "balance_class" IS NULL;--> statement-breakpoint
ALTER TABLE "credit_ledger" ALTER COLUMN "balance_class" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_events" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "billing_events" ADD COLUMN "payload" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_events" ADD COLUMN "processing_status" text DEFAULT 'received' NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_events" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_orders" ADD COLUMN "custom_id" text;--> statement-breakpoint
UPDATE "payment_orders" SET "custom_id" = 'legacy:' || "external_order_id" WHERE "custom_id" IS NULL;--> statement-breakpoint
ALTER TABLE "payment_orders" ALTER COLUMN "custom_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_checkouts" ADD CONSTRAINT "billing_checkouts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_checkouts" ADD CONSTRAINT "billing_checkouts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_checkouts_tenant_created_idx" ON "billing_checkouts" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_checkouts_external_subscription_unique" ON "billing_checkouts" USING btree ("external_subscription_id");--> statement-breakpoint
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_reservations_tenant_request_unique" ON "credit_reservations" USING btree ("tenant_id","request_id");--> statement-breakpoint
ALTER TABLE "billing_checkouts" ADD CONSTRAINT "billing_checkouts_interval_check" CHECK ("interval" IN ('monthly', 'annual'));--> statement-breakpoint
ALTER TABLE "billing_checkouts" ADD CONSTRAINT "billing_checkouts_status_check" CHECK ("status" IN ('pending', 'approved', 'completed', 'expired'));--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_balance_class_check" CHECK ("balance_class" IN ('promotional', 'subscription', 'purchased'));--> statement-breakpoint
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_amount_check" CHECK ("reserved_credits" > 0);--> statement-breakpoint
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_status_check" CHECK ("status" IN ('reserved', 'settled', 'released', 'expired'));--> statement-breakpoint
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_processing_status_check" CHECK ("processing_status" IN ('received', 'processing', 'processed', 'failed'));--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_amount_check" CHECK ("amount_cents" > 0 AND "credits_granted" >= 0);

ALTER TABLE "billing_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "billing_accounts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "billing_accounts_tenant" ON "billing_accounts" USING ("tenant_id"::text = current_setting('app.tenant_id', true)) WITH CHECK ("tenant_id"::text = current_setting('app.tenant_id', true));--> statement-breakpoint
CREATE POLICY "billing_accounts_service" ON "billing_accounts" USING (current_setting('app.is_service', true) = 'true') WITH CHECK (current_setting('app.is_service', true) = 'true');--> statement-breakpoint

ALTER TABLE "billing_checkouts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "billing_checkouts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "billing_checkouts_tenant" ON "billing_checkouts" USING ("tenant_id"::text = current_setting('app.tenant_id', true)) WITH CHECK ("tenant_id"::text = current_setting('app.tenant_id', true));--> statement-breakpoint
CREATE POLICY "billing_checkouts_service" ON "billing_checkouts" USING (current_setting('app.is_service', true) = 'true') WITH CHECK (current_setting('app.is_service', true) = 'true');--> statement-breakpoint

ALTER TABLE "subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "subscriptions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "subscriptions_tenant" ON "subscriptions" USING ("tenant_id"::text = current_setting('app.tenant_id', true)) WITH CHECK ("tenant_id"::text = current_setting('app.tenant_id', true));--> statement-breakpoint
CREATE POLICY "subscriptions_service" ON "subscriptions" USING (current_setting('app.is_service', true) = 'true') WITH CHECK (current_setting('app.is_service', true) = 'true');--> statement-breakpoint

ALTER TABLE "payment_orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment_orders" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "payment_orders_tenant" ON "payment_orders" USING ("tenant_id"::text = current_setting('app.tenant_id', true)) WITH CHECK ("tenant_id"::text = current_setting('app.tenant_id', true));--> statement-breakpoint
CREATE POLICY "payment_orders_service" ON "payment_orders" USING (current_setting('app.is_service', true) = 'true') WITH CHECK (current_setting('app.is_service', true) = 'true');--> statement-breakpoint

ALTER TABLE "entitlements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "entitlements" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "entitlements_tenant" ON "entitlements" USING ("tenant_id"::text = current_setting('app.tenant_id', true)) WITH CHECK ("tenant_id"::text = current_setting('app.tenant_id', true));--> statement-breakpoint
CREATE POLICY "entitlements_service" ON "entitlements" USING (current_setting('app.is_service', true) = 'true') WITH CHECK (current_setting('app.is_service', true) = 'true');--> statement-breakpoint

ALTER TABLE "credit_reservations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_reservations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "credit_reservations_tenant" ON "credit_reservations" USING ("tenant_id"::text = current_setting('app.tenant_id', true)) WITH CHECK ("tenant_id"::text = current_setting('app.tenant_id', true));--> statement-breakpoint
CREATE POLICY "credit_reservations_service" ON "credit_reservations" USING (current_setting('app.is_service', true) = 'true') WITH CHECK (current_setting('app.is_service', true) = 'true');--> statement-breakpoint

ALTER TABLE "analytics_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "analytics_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "analytics_events_tenant" ON "analytics_events" USING ("tenant_id"::text = current_setting('app.tenant_id', true)) WITH CHECK ("tenant_id"::text = current_setting('app.tenant_id', true));--> statement-breakpoint
CREATE POLICY "analytics_events_service" ON "analytics_events" USING (current_setting('app.is_service', true) = 'true') WITH CHECK (current_setting('app.is_service', true) = 'true');--> statement-breakpoint

ALTER TABLE "billing_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "billing_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "billing_events_service" ON "billing_events" USING (current_setting('app.is_service', true) = 'true') WITH CHECK (current_setting('app.is_service', true) = 'true');
