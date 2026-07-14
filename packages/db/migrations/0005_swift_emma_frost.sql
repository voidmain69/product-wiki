CREATE TABLE "page_freshness" (
	"source_id" uuid NOT NULL,
	"url" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_freshness_source_id_url_pk" PRIMARY KEY("source_id","url")
);
--> statement-breakpoint
ALTER TABLE "page_freshness" ADD CONSTRAINT "page_freshness_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;