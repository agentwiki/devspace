CREATE TABLE "leases" (
	"name" text PRIMARY KEY NOT NULL,
	"holder" text NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"renewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
