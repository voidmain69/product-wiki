import { sql } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
  text,
  timestamp,
  integer,
  doublePrecision,
  jsonb,
  boolean,
  uuid,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Канонічна модель даних. Ключові інваріанти:
 *  - page_snapshots immutable (append-only), тіло — в object storage;
 *  - product_revisions append-only (версіонування);
 *  - provenance на рівні атрибута (product_attributes.source_snapshot_id);
 *  - outbox для transactional-публікації подій.
 */

export const sourceStatus = pgEnum("source_status", ["active", "paused", "blocked_by_robots"]);
export const engineType = pgEnum("engine_type", ["static", "headless", "api-replay", "document"]);
export const productStatus = pgEnum("product_status", ["active", "merged_away", "retired"]);
export const extractionMethod = pgEnum("extraction_method", [
  "jsonld",
  "microdata",
  "api",
  "recipe",
  "llm",
]);

/* ─────────────────────────── Source Registry ─────────────────────────── */

export const sources = pgTable("sources", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  domains: jsonb("domains").$type<string[]>().notNull(),
  verification: jsonb("verification").notNull(),
  crawlPolicy: jsonb("crawl_policy").notNull(),
  status: sourceStatus("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ─────────────────────────── Crawl ─────────────────────────── */

export const crawlTasks = pgTable(
  "crawl_tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id),
    url: text("url").notNull(),
    priority: integer("priority").notNull().default(0),
    status: text("status").notNull().default("queued"), // queued|fetching|done|failed
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uqUrl: uniqueIndex("uq_crawl_source_url").on(t.sourceId, t.url),
    byStatus: index("ix_crawl_status_prio").on(t.status, t.priority),
  }),
);

export const pageSnapshots = pgTable(
  "page_snapshots",
  {
    // snapshotRef == id; тіло (html/screenshots) лежить у object storage
    id: uuid("id").defaultRandom().primaryKey(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id),
    url: text("url").notNull(),
    engine: engineType("engine").notNull(),
    httpStatus: integer("http_status").notNull(),
    contentHash: text("content_hash").notNull(),
    htmlKey: text("html_key"),
    apiPayloads: jsonb("api_payloads").$type<unknown[]>().default([]),
    screenshotKeys: jsonb("screenshot_keys").$type<string[]>().default([]),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byUrlHash: index("ix_snap_url_hash").on(t.url, t.contentHash),
    bySource: index("ix_snap_source").on(t.sourceId, t.fetchedAt),
  }),
);

/* ─────────────────────────── Drafts ─────────────────────────── */

export const productDrafts = pgTable(
  "product_drafts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => pageSnapshots.id),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id),
    name: text("name").notNull(),
    brand: text("brand").notNull(),
    mpn: text("mpn"),
    gtin: text("gtin"),
    categoryRaw: jsonb("category_raw").$type<string[]>().notNull(),
    attributesRaw: jsonb("attributes_raw").notNull(),
    descriptions: jsonb("descriptions").notNull(),
    media: jsonb("media").notNull(),
    extractionMethod: extractionMethod("extraction_method").notNull(),
    confidence: doublePrecision("confidence").notNull(),
    normalized: boolean("normalized").notNull().default(false),
    resolvedProductId: uuid("resolved_product_id").references(() => products.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byKeys: index("ix_draft_keys").on(t.gtin, t.mpn, t.brand),
  }),
);

/* ─────────────────────────── Taxonomy ─────────────────────────── */

export const categories = pgTable("categories", {
  id: uuid("id").defaultRandom().primaryKey(),
  parentId: uuid("parent_id"),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  path: jsonb("path").$type<string[]>().notNull(),
});

export const attributeOntology = pgTable("attribute_ontology", {
  key: text("key").primaryKey(), // "weight_net"
  label: text("label").notNull(), // "Вага нетто"
  dataType: text("data_type").notNull(), // number|string|boolean|enum
  unitCanonical: text("unit_canonical"), // "kg"
  aliases: jsonb("aliases").$type<string[]>().notNull().default([]), // ["вага","weight",...]
});

/* ─────────────────────────── Canonical products ─────────────────────────── */

export const products = pgTable(
  "products",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    currentRevisionId: uuid("current_revision_id"),
    brand: text("brand").notNull(),
    name: text("name").notNull(),
    mpn: text("mpn"),
    gtin: text("gtin"),
    categoryId: uuid("category_id").references(() => categories.id),
    // денормалізовані з поточної ревізії поля для каталогу — щоб фільтр/фасети/список
    // не чіпали величезний snapshot усіх ревізій (containment по history = seq-scan+detoast).
    categoryPath: jsonb("category_path").$type<string[]>().notNull().default([]),
    thumbnail: text("thumbnail"),
    status: productStatus("status").notNull().default("active"),
    mergedInto: uuid("merged_into"), // якщо merged_away → на що злито
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uqGtin: uniqueIndex("uq_product_gtin").on(t.gtin),
    byBrandMpn: index("ix_product_brand_mpn").on(t.brand, t.mpn),
    // Один активний канонічний товар на (brand, name) — закриває гонку resolver-а
    // (два консюмери не знайшли товар і обидва вставили) + легасі-дублі. Partial:
    // merged_away/retired-версії можуть повторювати назву.
    uqBrandNameActive: uniqueIndex("uq_product_brand_name_active")
      .on(t.brand, t.name)
      .where(sql`status = 'active'`),
    // GIN за denormalized categoryPath (лише поточні товари, 1 рядок/товар) — швидкий
    // containment для фільтра каталогу за категорією.
    categoryGin: index("ix_product_category_gin").using("gin", sql`(${t.categoryPath}) jsonb_path_ops`),
  }),
);

export const productRevisions = pgTable("product_revisions", {
  id: uuid("id").defaultRandom().primaryKey(),
  productId: uuid("product_id")
    .notNull()
    .references(() => products.id),
  // повний знімок канонічної сутності на момент ревізії (denormalized, append-only)
  snapshot: jsonb("snapshot").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const productAttributes = pgTable(
  "product_attributes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
    attrKey: text("attr_key").notNull().references(() => attributeOntology.key),
    valueCanonical: jsonb("value_canonical").notNull(), // number|string|boolean
    unitCanonical: text("unit_canonical"),
    valueRaw: text("value_raw").notNull(),
    // provenance на рівні атрибута — кожна цифра знає своє джерело
    sourceSnapshotId: uuid("source_snapshot_id")
      .notNull()
      .references(() => pageSnapshots.id),
  },
  (t) => ({
    byProduct: index("ix_attr_product").on(t.productId),
    uqProductKeySource: uniqueIndex("uq_attr_product_key_source").on(
      t.productId,
      t.attrKey,
      t.sourceSnapshotId,
    ),
  }),
);

export const productTexts = pgTable("product_texts", {
  id: uuid("id").defaultRandom().primaryKey(),
  productId: uuid("product_id")
    .notNull()
    .references(() => products.id),
  section: text("section").notNull(),
  lang: text("lang").notNull(),
  text: text("text").notNull(),
  sourceSnapshotId: uuid("source_snapshot_id")
    .notNull()
    .references(() => pageSnapshots.id),
});

/* ─────────────────────────── Entity resolution queue ─────────────────────────── */

export const mergeQueue = pgTable("merge_queue", {
  id: uuid("id").defaultRandom().primaryKey(),
  leftProductId: uuid("left_product_id").notNull(),
  rightProductId: uuid("right_product_id").notNull(),
  similarity: doublePrecision("similarity").notNull(),
  status: text("status").notNull().default("pending"), // pending|merged|rejected
  decidedBy: text("decided_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ─────────────────────────── Transactional outbox ─────────────────────────── */

export const outbox = pgTable(
  "outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    subject: text("subject").notNull(),
    payload: jsonb("payload").notNull(),
    traceId: text("trace_id").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    unpublished: index("ix_outbox_unpublished").on(t.publishedAt, t.createdAt),
  }),
);

/* ─────────────────────────── Chat analytics (попит → scheduler) ─────────────────────────── */

export const chatQueries = pgTable("chat_queries", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: text("session_id").notNull(),
  intent: text("intent").notNull(),
  queryText: text("query_text").notNull(),
  matchedProductIds: jsonb("matched_product_ids").$type<string[]>().default([]),
  noResults: boolean("no_results").notNull().default(false), // куди розширювати каталог
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const schema = {
  sources,
  crawlTasks,
  pageSnapshots,
  productDrafts,
  categories,
  attributeOntology,
  products,
  productRevisions,
  productAttributes,
  productTexts,
  mergeQueue,
  outbox,
  chatQueries,
};
