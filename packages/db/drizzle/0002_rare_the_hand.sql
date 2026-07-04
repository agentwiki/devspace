ALTER TABLE "events" ADD COLUMN "claimed_by" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "claimed_at" timestamp with time zone;