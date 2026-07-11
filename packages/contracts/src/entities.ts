import { z } from "zod";
import {
  Id,
  IsoDateTime,
  EngineType,
  ExtractionMethod,
  AttributeValue,
  Provenance,
} from "./common.js";

/* ─────────────────────────── Source Registry ─────────────────────────── */

/** Як підтверджено, що домен справді належить виробнику. */
export const SourceVerification = z.object({
  method: z.enum(["manual", "dns", "wikidata"]),
  verifiedBy: z.string(),
  verifiedAt: IsoDateTime,
});

export const CrawlPolicy = z.object({
  entrypoints: z.array(z.string().url()), // sitemap URL або каталожні розділи
  urlPatterns: z.array(z.string()), // рядки-регекси; які URL вважати сторінками товарів
  engineHint: EngineType.optional(),
  maxRps: z.number().positive().default(0.5), // ввічливість
  recrawlIntervalDays: z.number().int().positive().default(30),
});

export const ManufacturerSource = z.object({
  id: Id,
  name: z.string(), // "Bosch"
  domains: z.array(z.string()).min(1), // ["bosch.com", "bosch.ua"] — верифіковані
  verification: SourceVerification,
  crawlPolicy: CrawlPolicy,
  status: z.enum(["active", "paused", "blocked_by_robots"]),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ManufacturerSource = z.infer<typeof ManufacturerSource>;

/* ─────────────────────────── Page Snapshot ─────────────────────────── */

export const JsonCapture = z.object({
  requestUrl: z.string().url(),
  method: z.string(),
  status: z.number().int(),
  body: z.unknown(), // перехоплена XHR/GraphQL відповідь
});
export type JsonCapture = z.infer<typeof JsonCapture>;

/** Immutable-снапшот сторінки. Тіло (html/screenshots) лежить у object storage за snapshotRef. */
export const PageSnapshot = z.object({
  snapshotRef: z.string().min(1),
  url: z.string().url(),
  sourceId: Id,
  fetchedAt: IsoDateTime,
  engine: EngineType,
  httpStatus: z.number().int(),
  contentHash: z.string(), // sha256 фінального DOM — для skip незмінених сторінок
  htmlKey: z.string().nullable(), // ключ у object storage
  apiPayloads: z.array(JsonCapture).default([]),
  screenshotKeys: z.array(z.string()).default([]),
});
export type PageSnapshot = z.infer<typeof PageSnapshot>;

/* ─────────────────────────── Product Draft ─────────────────────────── */

export const RawAttribute = z.object({
  key: z.string(), // як названо на сайті: "Вага нетто"
  value: z.string(),
  unit: z.string().optional(),
});

export const MediaRef = z.object({
  type: z.enum(["image", "manual_pdf", "video"]),
  url: z.string().url(),
});

/** Сирий екстракт зі сторінки — ще не нормалізований, не злитий. */
export const ProductDraft = z.object({
  snapshotRef: z.string().min(1), // провенанс
  sourceId: Id,
  name: z.string(),
  brand: z.string(),
  mpn: z.string().optional(), // manufacturer part number — ключ для resolution
  gtin: z.string().optional(), // штрихкод — найсильніший ключ
  categoryRaw: z.array(z.string()), // хлібні крихти сайту
  attributesRaw: z.array(RawAttribute),
  descriptions: z.array(z.object({ section: z.string(), text: z.string() })),
  media: z.array(MediaRef),
  extractionMethod: ExtractionMethod,
  confidence: z.number().min(0).max(1),
});
export type ProductDraft = z.infer<typeof ProductDraft>;

/* ─────────────────────────── Canonical Product ─────────────────────────── */

export const ProductText = z.object({
  section: z.string(), // "overview" | "features" | ...
  text: z.string(),
  lang: z.string(), // ISO 639-1
  provenance: Provenance,
});

/** Канонічна сутність товару — результат нормалізації + entity resolution. */
export const Product = z.object({
  id: Id,
  revisionId: Id, // append-only версія; чат може відповідати "станом на"
  brand: z.string(),
  name: z.string(),
  mpn: z.string().nullable(),
  gtin: z.string().nullable(),
  categoryId: Id,
  categoryPath: z.array(z.string()), // ["Побутова техніка", "Пилососи", "Роботи-пилососи"]
  attributes: z.array(AttributeValue),
  texts: z.array(ProductText),
  media: z.array(MediaRef),
  sources: z.array(Provenance), // усі джерела, з яких зібрано цю сутність
  status: z.enum(["active", "merged_away", "retired"]),
  updatedAt: IsoDateTime,
});
export type Product = z.infer<typeof Product>;

/* ─────────────────────────── Retrieval Chunk ─────────────────────────── */

export const ChunkType = z.enum(["overview", "spec_group", "feature", "usecase"]);
export type ChunkType = z.infer<typeof ChunkType>;

/** Типізований чанк для індексації — поважає структуру товару. */
export const ProductChunk = z.object({
  id: Id, // productId:chunkType:ordinal
  productId: Id,
  revisionId: Id,
  chunkType: ChunkType,
  ordinal: z.number().int().nonnegative(),
  text: z.string(), // серіалізований у природну мову вміст
  payload: z.object({
    brand: z.string(),
    categoryPath: z.array(z.string()),
    attrs: z.record(z.union([z.number(), z.string(), z.boolean()])), // фільтровані атрибути
    sourceUrls: z.array(z.string().url()),
  }),
});
export type ProductChunk = z.infer<typeof ProductChunk>;
