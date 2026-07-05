CREATE TABLE "transcripts" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"work_unit_id" text,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"seq" bigserial NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "transcripts_conversation_seq_idx" ON "transcripts" USING btree ("conversation_id","seq");