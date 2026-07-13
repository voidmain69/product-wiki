import { z } from "zod";
import { Id } from "./common.js";

/** DTO публічного/внутрішнього API та SSE-подій чату. */

/* ── Chat request ──────────────────────────────────────────────────────── */

export const ChatRole = z.enum(["user", "assistant"]);

export const ChatMessage = z.object({
  role: ChatRole,
  content: z.string(),
});

export const ChatRequest = z.object({
  sessionId: Id.optional(), // якщо нема — створюється нова сесія
  message: z.string().min(1).max(2000),
  // необов'язкова прив'язка до товару (напр. "запитати про цей товар")
  productContextId: Id.optional(),
  // явні фільтри з UI (чипи композера): звужують retrieval поверх intent-фільтрів
  filters: z
    .object({
      brand: z.string().optional(),
      categoryPath: z.array(z.string()).optional(),
    })
    .optional(),
});
export type ChatRequest = z.infer<typeof ChatRequest>;

/* ── Intent класифікація ───────────────────────────────────────────────── */

export const ChatIntent = z.enum([
  "info", // характеристики конкретного товару
  "recommend", // підбір за потребами
  "compare", // порівняння товарів
  "followup", // уточнення в контексті діалогу
  "out_of_scope", // поза межами сервісу
]);
export type ChatIntent = z.infer<typeof ChatIntent>;

/* ── Цитати та картки товарів ──────────────────────────────────────────── */

export const Citation = z.object({
  marker: z.number().int(), // [n] у тексті
  productId: Id,
  productName: z.string(),
  sourceUrl: z.string().url(), // сторінка виробника
  snapshotDate: z.string(), // дата свіжості даних
});
export type Citation = z.infer<typeof Citation>;

export const ProductCard = z.object({
  productId: Id,
  brand: z.string(),
  name: z.string(),
  categoryPath: z.array(z.string()),
  thumbnail: z.string().url().nullable(),
  keySpecs: z.array(z.object({ label: z.string(), value: z.string() })),
});
export type ProductCard = z.infer<typeof ProductCard>;

/* ── SSE-події стріму чату ─────────────────────────────────────────────── */

export const ChatStreamEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session"), sessionId: Id }),
  z.object({ type: z.literal("intent"), intent: ChatIntent }),
  z.object({ type: z.literal("token"), text: z.string() }),
  z.object({ type: z.literal("citation"), citation: Citation }),
  z.object({ type: z.literal("product_card"), card: ProductCard }),
  z.object({ type: z.literal("comparison"), table: z.unknown() }), // ComparisonTable
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({ type: z.literal("done") }),
]);
export type ChatStreamEvent = z.infer<typeof ChatStreamEvent>;

/* ── Детермінована таблиця порівняння (будується кодом, не LLM) ─────────── */

export const ComparisonRow = z.object({
  attrKey: z.string(),
  label: z.string(),
  values: z.array(z.string().nullable()), // по одному на товар
  differs: z.boolean(), // підсвітка відмінностей
});

export const ComparisonTable = z.object({
  productIds: z.array(Id),
  productNames: z.array(z.string()),
  rows: z.array(ComparisonRow),
});
export type ComparisonTable = z.infer<typeof ComparisonTable>;

/* ── Product REST DTO (для SSR-сторінок «вікіпедії» та списку) ──────────── */

export const ProductListItem = z.object({
  productId: Id,
  brand: z.string(),
  name: z.string(),
  categoryPath: z.array(z.string()),
  thumbnail: z.string().url().nullable(),
  keySpecs: z.array(z.object({ label: z.string(), value: z.string() })),
  updatedAt: z.string(), // ISO — для свіжості й сортування у каталозі
});
export type ProductListItem = z.infer<typeof ProductListItem>;

/** Відповідь списку товарів: сторінка + повна кількість (для пагінації). */
export const ProductListResponse = z.object({
  items: z.array(ProductListItem),
  total: z.number().int().nonnegative(),
});
export type ProductListResponse = z.infer<typeof ProductListResponse>;

/** Фасети каталогу: доступні бренди й категорії з лічильниками (для фільтрів). */
export const FacetBucket = z.object({ value: z.string(), count: z.number().int().nonnegative() });
export const ProductFacets = z.object({
  brands: z.array(FacetBucket),
  categories: z.array(FacetBucket),
});
export type ProductFacets = z.infer<typeof ProductFacets>;

/** Атрибут з provenance — кожна цифра знає своє першоджерело (інваріант 5). */
export const ProductDetailAttribute = z.object({
  key: z.string(),
  label: z.string(),
  value: z.string(),
  unit: z.string().nullable(),
  sourceUrl: z.string().url(),
  snapshotDate: z.string(),
});

export const ProductDetail = z.object({
  productId: Id,
  brand: z.string(),
  name: z.string(),
  mpn: z.string().nullable(),
  gtin: z.string().nullable(),
  categoryPath: z.array(z.string()),
  updatedAt: z.string(),
  images: z.array(z.string().url()),
  attributes: z.array(ProductDetailAttribute),
  texts: z.array(z.object({ section: z.string(), text: z.string(), sourceUrl: z.string().url() })),
  sources: z.array(z.object({ url: z.string().url(), fetchedAt: z.string() })),
});
export type ProductDetail = z.infer<typeof ProductDetail>;

/* ── Retrieval (внутрішній контракт orchestrator ↔ retrieval) ──────────── */

export const RetrievalFilters = z.object({
  categoryPath: z.array(z.string()).optional(),
  brand: z.string().optional(),
  productIds: z.array(Id).optional(),
  attrRanges: z
    .record(z.object({ gte: z.number().optional(), lte: z.number().optional() }))
    .optional(),
});
export type RetrievalFilters = z.infer<typeof RetrievalFilters>;

export const RetrievedChunk = z.object({
  chunkId: Id,
  productId: Id,
  chunkType: z.string(),
  text: z.string(),
  score: z.number(),
  sourceUrls: z.array(z.string().url()),
});
export type RetrievedChunk = z.infer<typeof RetrievedChunk>;
