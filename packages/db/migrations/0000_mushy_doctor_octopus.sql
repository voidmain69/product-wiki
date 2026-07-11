CREATE TYPE "public"."engine_type" AS ENUM('static', 'headless', 'api-replay', 'document');--> statement-breakpoint
CREATE TYPE "public"."extraction_method" AS ENUM('jsonld', 'microdata', 'api', 'recipe', 'llm');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('active', 'merged_away', 'retired');--> statement-breakpoint
CREATE TYPE "public"."source_status" AS ENUM('active', 'paused', 'blocked_by_robots');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "attribute_ontology" (
	"key" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"data_type" text NOT NULL,
	"unit_canonical" text,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"path" jsonb NOT NULL,
	CONSTRAINT "categories_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_queries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text NOT NULL,
	"intent" text NOT NULL,
	"query_text" text NOT NULL,
	"matched_product_ids" jsonb DEFAULT '[]'::jsonb,
	"no_results" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crawl_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"url" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"scheduled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "merge_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"left_product_id" uuid NOT NULL,
	"right_product_id" uuid NOT NULL,
	"similarity" double precision NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject" text NOT NULL,
	"payload" jsonb NOT NULL,
	"trace_id" text NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "page_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"url" text NOT NULL,
	"engine" "engine_type" NOT NULL,
	"http_status" integer NOT NULL,
	"content_hash" text NOT NULL,
	"html_key" text,
	"api_payloads" jsonb DEFAULT '[]'::jsonb,
	"screenshot_keys" jsonb DEFAULT '[]'::jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_attributes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"attr_key" text NOT NULL,
	"value_canonical" jsonb NOT NULL,
	"unit_canonical" text,
	"value_raw" text NOT NULL,
	"source_snapshot_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"name" text NOT NULL,
	"brand" text NOT NULL,
	"mpn" text,
	"gtin" text,
	"category_raw" jsonb NOT NULL,
	"attributes_raw" jsonb NOT NULL,
	"descriptions" jsonb NOT NULL,
	"media" jsonb NOT NULL,
	"extraction_method" "extraction_method" NOT NULL,
	"confidence" double precision NOT NULL,
	"normalized" boolean DEFAULT false NOT NULL,
	"resolved_product_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_texts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"section" text NOT NULL,
	"lang" text NOT NULL,
	"text" text NOT NULL,
	"source_snapshot_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"current_revision_id" uuid,
	"brand" text NOT NULL,
	"name" text NOT NULL,
	"mpn" text,
	"gtin" text,
	"category_id" uuid,
	"status" "product_status" DEFAULT 'active' NOT NULL,
	"merged_into" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"domains" jsonb NOT NULL,
	"verification" jsonb NOT NULL,
	"crawl_policy" jsonb NOT NULL,
	"status" "source_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crawl_tasks" ADD CONSTRAINT "crawl_tasks_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "page_snapshots" ADD CONSTRAINT "page_snapshots_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "product_attributes" ADD CONSTRAINT "product_attributes_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "product_attributes" ADD CONSTRAINT "product_attributes_attr_key_attribute_ontology_key_fk" FOREIGN KEY ("attr_key") REFERENCES "public"."attribute_ontology"("key") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "product_attributes" ADD CONSTRAINT "product_attributes_source_snapshot_id_page_snapshots_id_fk" FOREIGN KEY ("source_snapshot_id") REFERENCES "public"."page_snapshots"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "product_drafts" ADD CONSTRAINT "product_drafts_snapshot_id_page_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."page_snapshots"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "product_drafts" ADD CONSTRAINT "product_drafts_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "product_drafts" ADD CONSTRAINT "product_drafts_resolved_product_id_products_id_fk" FOREIGN KEY ("resolved_product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "product_revisions" ADD CONSTRAINT "product_revisions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "product_texts" ADD CONSTRAINT "product_texts_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "product_texts" ADD CONSTRAINT "product_texts_source_snapshot_id_page_snapshots_id_fk" FOREIGN KEY ("source_snapshot_id") REFERENCES "public"."page_snapshots"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_crawl_source_url" ON "crawl_tasks" USING btree ("source_id","url");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_crawl_status_prio" ON "crawl_tasks" USING btree ("status","priority");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_outbox_unpublished" ON "outbox" USING btree ("published_at","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_snap_url_hash" ON "page_snapshots" USING btree ("url","content_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_snap_source" ON "page_snapshots" USING btree ("source_id","fetched_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_attr_product" ON "product_attributes" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_attr_product_key_source" ON "product_attributes" USING btree ("product_id","attr_key","source_snapshot_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_draft_keys" ON "product_drafts" USING btree ("gtin","mpn","brand");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_product_gtin" ON "products" USING btree ("gtin");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_product_brand_mpn" ON "products" USING btree ("brand","mpn");