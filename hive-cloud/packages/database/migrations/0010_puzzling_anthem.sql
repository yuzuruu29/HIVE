ALTER TABLE "credit_reservations" ADD COLUMN "price_snapshot_id" text;--> statement-breakpoint
ALTER TABLE "credit_reservations" ADD COLUMN "settled_credits" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_reservations" ADD COLUMN "provider_cost_microusd" integer;
