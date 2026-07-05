ALTER TABLE "work_units" ADD COLUMN "network_access" text;--> statement-breakpoint
ALTER TABLE "work_units" ADD COLUMN "allowed_hosts" jsonb;