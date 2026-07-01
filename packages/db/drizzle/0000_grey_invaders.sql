CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"external_channel_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"work_unit_id" text,
	"payload" jsonb NOT NULL,
	"emitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" text,
	"name" text NOT NULL,
	"ciphertext" text NOT NULL,
	"key_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_units" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"env_id" text,
	"agent_session_id" text,
	"state" text DEFAULT 'CREATED' NOT NULL,
	"repo_url" text,
	"branch" text,
	"pr_number" integer,
	"pr_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "work_units" ADD CONSTRAINT "work_units_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_platform_channel_uq" ON "conversations" USING btree ("platform","external_channel_id");--> statement-breakpoint
CREATE INDEX "events_topic_idx" ON "events" USING btree ("topic");--> statement-breakpoint
CREATE INDEX "events_work_unit_idx" ON "events" USING btree ("work_unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "secrets_user_conv_name_uq" ON "secrets" USING btree ("user_id","conversation_id","name");--> statement-breakpoint
CREATE INDEX "work_units_conversation_idx" ON "work_units" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "work_units_state_idx" ON "work_units" USING btree ("state");