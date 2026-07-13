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
type RawAttr = { key: string; value: string; unit?: string };

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
    // деякі виробники (ASUS) дублюють бренд у name ("ASUS TUF Gaming A15") — зрізаємо,
    // бо canonical показує brand+name окремо, інакше виходить "ASUS ASUS TUF...".
    name: stripBrandPrefix(String(p.name ?? ""), brand),
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

/**
 * Прибирає провідний бренд із назви, якщо JSON-LD його дублює.
 * Зрізаємо лише на межі слова (наступний символ — пробіл/роздільник), щоб не
 * поламати назви, де бренд є підрядком (напр. "ASUSTeK" при бренді "ASUS").
 * Порожню назву ніколи не повертаємо — краще лишити дубль, ніж втратити ім'я.
 */
function stripBrandPrefix(name: string, brand: string): string {
  const n = name.trim();
  const b = brand.trim();
  if (!b || n.length <= b.length) return n;
  if (n.slice(0, b.length).toLowerCase() !== b.toLowerCase()) return n;
  const rest = n.slice(b.length);
  if (!/^[\s\-–—:|]/.test(rest)) return n; // бренд — частина слова, не префікс
  const stripped = rest.replace(/^[\s\-–—:|]+/, "").trim();
  return stripped || n;
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

/* ── Рівень 3: site recipe — spec-таблиця та хлібні крихти ──────────────── */

/**
 * Витягує пари «Мітка :Значення» зі спец-блоку виробника. Багато SPA (ASUS/Nuxt)
 * рендерять теххарактеристики одним рядком через `<BR>`: `Тип панелі :IPS<BR>...`.
 * Детермінований парсер (без LLM): значення беруться дослівно як на сторінці, тож
 * self-check зайвий. Повертаємо [] якщо пар мало (не спец-таблиця, а випадковий <BR>).
 */
export function fromSpecBlob(html: string): RawAttr[] {
  // \uXXXX у вбудованому JSON-стані → символи; <BR> лишаємо роздільником пар
  const text = html.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const seen = new Set<string>();
  const attrs: RawAttr[] = [];
  for (const seg of text.split(/<\s*br\s*\/?\s*>/i)) {
    // трейлінг «Мітка :Значення» в кінці сегмента (перед наступним <BR>)
    const m = seg.match(/([^<>:"{}[\]]{2,60})\s:\s?([^<>"{}[\]]{1,120})\s*$/);
    if (!m || !m[1] || !m[2]) continue;
    const key = m[1].trim().replace(/^[",]+/, "").trim();
    const value = m[2].trim();
    if (!key || !value || /^https?:/.test(value) || /[{}\\]/.test(key + value)) continue;
    const k = key.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    attrs.push({ key, value });
  }
  return attrs.length >= 5 ? attrs : [];
}

/**
 * rowTable-формат ASUS /techspec/ (мат.плати, ноутбуки, GPU тощо): мітка у
 * `.rowTableTitle`, значення — у сусідньому `.rowTableItemViewBox`. Доповнює
 * `<BR>`-парсер (монітори); разом покривають більшість категорій. Значення беруться
 * дослівно зі сторінки — self-check зайвий.
 */
export function fromSpecTable(html: string): RawAttr[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const attrs: RawAttr[] = [];
  $(".rowTableTitle").each((_, el) => {
    const key = $(el).text().trim();
    const value = $(el).parent().nextAll(".rowTableItemViewBox").first().text().replace(/\s+/g, " ").trim();
    if (!key || !value) return;
    const k = key.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    attrs.push({ key, value });
  });
  return attrs.length >= 3 ? attrs : [];
}

/** schema.org BreadcrumbList → { назва товару (останній рівень), категорія }. */
export function fromBreadcrumb(html: string): { name: string; categoryPath: string[] } | null {
  const $ = cheerio.load(html);
  for (const raw of $('script[type="application/ld+json"]').map((_, el) => $(el).text()).get()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const list = findByType(parsed, "BreadcrumbList");
    const items = list?.itemListElement;
    if (!Array.isArray(items) || items.length < 2) continue;
    const names = items
      .map((it) => String((it as Record<string, unknown>).name ?? "").trim())
      .filter(Boolean);
    if (names.length < 2) continue;
    return { name: names[names.length - 1]!, categoryPath: names.slice(0, -1) };
  }
  return null;
}

function findByType(node: unknown, type: string): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = findByType(n, type);
      if (f) return f;
    }
    return null;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const t = obj["@type"];
    if (t === type || (Array.isArray(t) && t.includes(type))) return obj;
    if (Array.isArray(obj["@graph"])) return findByType(obj["@graph"], type);
  }
  return null;
}

/** Бренд із хосту курируваного джерела (spec-сторінка ASUS не має Product-JSON-LD). */
const BRAND_BY_HOST: Record<string, string> = { "asus.com": "ASUS" };
function brandFromHost(url: string): string {
  try {
    const host = new URL(url).host.replace(/^www\./, "");
    return BRAND_BY_HOST[host] ?? host.split(".")[0]!.toUpperCase();
  } catch {
    return "";
  }
}

/** Мерж атрибутів: JSON-LD (additionalProperty) має пріоритет, spec-блок доповнює. */
function mergeAttrs(base: RawAttr[], extra: RawAttr[]): RawAttr[] {
  const seen = new Set(base.map((a) => a.key.toLowerCase().trim()));
  return [...base, ...extra.filter((a) => !seen.has(a.key.toLowerCase().trim()))];
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
  // Спец-характеристики — детерміновано, двома форматами ASUS /techspec/:
  //   <BR>-блок (монітори) + rowTable-DOM (мат.плати/ноутбуки/GPU). Тягнемо завжди й
  //   доповнюємо ними будь-який рівень (JSON-LD зазвичай має лише name/brand).
  const specAttrs = mergeAttrs(fromSpecBlob(input.html), fromSpecTable(input.html));

  // 1. JSON-LD (Product) + мерж спец-блоку
  const jsonld = fromJsonLd(input.html);
  if (jsonld && jsonld.name) {
    return finalize(input, { ...jsonld, attributesRaw: mergeAttrs(jsonld.attributesRaw, specAttrs) }, "jsonld", 0.95);
  }

  // 2. API payloads (спрощено: якщо є перехоплений JSON із полем name)
  //    Повна реалізація — мапінг per-source; тут — місток.

  // 3. Site recipe: спец-сторінка (напр. ASUS /techspec/) без Product-JSON-LD, але зі
  //    спец-блоком і хлібними крихтами. Назву й категорію беремо з BreadcrumbList,
  //    бренд — з курируваного джерела за хостом. Факти — лише зі сторінки (provenance).
  if (specAttrs.length) {
    const crumb = fromBreadcrumb(input.html);
    const brand = brandFromHost(input.url);
    if (crumb?.name && brand) {
      return finalize(
        input,
        { name: stripBrandPrefix(crumb.name, brand), brand, categoryRaw: crumb.categoryPath, attributesRaw: specAttrs, descriptions: [], media: [] },
        "recipe",
        0.9,
      );
    }
  }

  // 4. LLM fallback
  const llmDraft = await fromLlm(llm, input.html).catch(() => null);
  if (llmDraft && llmDraft.name) {
    return finalize(input, { ...llmDraft, attributesRaw: mergeAttrs(llmDraft.attributesRaw, specAttrs) }, "llm", 0.6);
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
