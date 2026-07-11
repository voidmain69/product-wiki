import * as cheerio from "cheerio";
import { z } from "zod";
import type { LLMProvider } from "@wiki/llm";
import type { ProductDraft } from "@wiki/contracts";

/**
 * Каскад екстракції: від детермінованого до LLM. Правило — LLM ЛИШЕ як останній
 * рубіж (дешевше, детермінованіше, менше галюцинацій). Порядок:
 *   1) JSON-LD schema.org/Product   (~60% сайтів)
 *   2) перехоплені API-payload-и     (найчистіші дані)
 *   3) site recipe (CSS-селектори)   (кешується per-source)
 *   4) LLM extraction зі схемою + self-check (значення має бути на сторінці)
 */

export interface ExtractInput {
  html: string;
  url: string;
  sourceId: string;
  snapshotRef: string;
  apiPayloads: unknown[];
}

type DraftCore = Omit<ProductDraft, "snapshotRef" | "sourceId" | "extractionMethod" | "confidence">;

/* ── Рівень 1: JSON-LD ─────────────────────────────────────────────────── */

export function fromJsonLd(html: string): DraftCore | null {
  const $ = cheerio.load(html);
  const blocks = $('script[type="application/ld+json"]')
    .map((_, el) => $(el).text())
    .get();

  for (const raw of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const product = findProduct(parsed);
    if (product) return mapSchemaOrgProduct(product);
  }
  return null;
}

function findProduct(node: unknown): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const found = findProduct(n);
      if (found) return found;
    }
    return null;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const type = obj["@type"];
    if (type === "Product" || (Array.isArray(type) && type.includes("Product"))) return obj;
    if (Array.isArray(obj["@graph"])) return findProduct(obj["@graph"]);
  }
  return null;
}

function mapSchemaOrgProduct(p: Record<string, unknown>): DraftCore {
  const brand =
    typeof p.brand === "string"
      ? p.brand
      : ((p.brand as Record<string, unknown>)?.name as string) ?? "";
  const attributesRaw = Array.isArray(p.additionalProperty)
    ? (p.additionalProperty as Record<string, unknown>[]).map((a) => ({
        key: String(a.name ?? ""),
        value: String(a.value ?? ""),
        unit: a.unitText ? String(a.unitText) : undefined,
      }))
    : [];
  return {
    name: String(p.name ?? ""),
    brand,
    // ідентифікатори реально лежать не лише в топ-рівні Product, а й у вкладених
    // model[] (ProductModel-варіанти) та offers[] (Offer) — саме так робить Logitech
    // та багато виробників. Шукаємо в усіх трьох місцях.
    mpn: firstIdentifier(p, ["mpn"]),
    gtin: firstIdentifier(p, ["gtin13", "gtin", "gtin14", "gtin8"]),
    categoryRaw: p.category ? [String(p.category)] : [],
    attributesRaw,
    descriptions: p.description ? [{ section: "overview", text: String(p.description) }] : [],
    media: normalizeImages(p.image),
  };
}

/** Перший знайдений ідентифікатор: топ-рівень Product → model[] → offers[]. */
function firstIdentifier(p: Record<string, unknown>, keys: string[]): string | undefined {
  const scan = (obj: unknown): string | undefined => {
    if (!obj || typeof obj !== "object") return undefined;
    const rec = obj as Record<string, unknown>;
    for (const k of keys) {
      const v = rec[k];
      if (typeof v === "string" || typeof v === "number") return String(v);
    }
    return undefined;
  };
  const nested = (v: unknown): Record<string, unknown>[] =>
    Array.isArray(v) ? (v as Record<string, unknown>[]) : v ? [v as Record<string, unknown>] : [];

  return (
    scan(p) ??
    nested(p.model).map(scan).find(Boolean) ??
    nested(p.offers).map(scan).find(Boolean)
  );
}

function normalizeImages(image: unknown): DraftCore["media"] {
  const urls = Array.isArray(image) ? image : image ? [image] : [];
  return urls
    .filter((u): u is string => typeof u === "string")
    .map((url) => ({ type: "image" as const, url }));
}

/* ── Рівень 4: LLM зі схемою + self-check ──────────────────────────────── */

const LlmDraftSchema = z.object({
  name: z.string(),
  brand: z.string(),
  mpn: z.string().optional(),
  gtin: z.string().optional(),
  categoryRaw: z.array(z.string()),
  attributesRaw: z.array(z.object({ key: z.string(), value: z.string(), unit: z.string().optional() })),
  descriptions: z.array(z.object({ section: z.string(), text: z.string() })),
});

export async function fromLlm(llm: LLMProvider, html: string): Promise<DraftCore | null> {
  const text = readableText(html).slice(0, 12_000);
  const draft = await llm.generateStructured(
    [
      {
        role: "system",
        content:
          "Витягни дані про товар зі сторінки виробника. Поверни JSON суворо за схемою. " +
          "НЕ вигадуй значень: якщо характеристики немає на сторінці — не додавай її. " +
          "Копіюй значення дослівно як на сторінці.",
      },
      { role: "user", content: text },
    ],
    LlmDraftSchema,
  );

  // self-check: кожне значення атрибута має зустрічатись у тексті сторінки
  const haystack = text.toLowerCase();
  const attributesRaw = draft.attributesRaw.filter((a) =>
    haystack.includes(a.value.toLowerCase().slice(0, 40)),
  );

  return { ...draft, media: [], attributesRaw };
}

function readableText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, nav, footer, header, noscript").remove();
  return $("body").text().replace(/\s+/g, " ").trim();
}

/* ── Оркестрація каскаду ───────────────────────────────────────────────── */

export async function runCascade(
  input: ExtractInput,
  llm: LLMProvider,
): Promise<ProductDraft | null> {
  // 1. JSON-LD
  const jsonld = fromJsonLd(input.html);
  if (jsonld && jsonld.name) {
    return finalize(input, jsonld, "jsonld", 0.95);
  }

  // 2. API payloads (спрощено: якщо є перехоплений JSON із полем name)
  //    Повна реалізація — мапінг per-source; тут — місток.

  // 4. LLM fallback
  const llmDraft = await fromLlm(llm, input.html).catch(() => null);
  if (llmDraft && llmDraft.name) {
    return finalize(input, llmDraft, "llm", 0.6);
  }

  return null;
}

function finalize(
  input: ExtractInput,
  core: DraftCore,
  method: ProductDraft["extractionMethod"],
  confidence: number,
): ProductDraft {
  return {
    snapshotRef: input.snapshotRef,
    sourceId: input.sourceId,
    ...core,
    media: core.media ?? [],
    extractionMethod: method,
    confidence,
  };
}
