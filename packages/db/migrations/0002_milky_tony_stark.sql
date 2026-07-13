DROP INDEX IF EXISTS "ix_prodrev_category_gin";--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "category_path" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "thumbnail" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_product_category_gin" ON "products" USING gin (("category_path") jsonb_path_ops);