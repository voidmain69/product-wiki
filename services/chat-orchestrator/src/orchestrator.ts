import { eq } from "drizzle-orm";
import type { Database } from "@wiki/db";
import { products, productRevisions, productAttributes, attributeOntology, pageSnapshots, chatQueries } from "@wiki/db";
import type { LLMProvider } from "@wiki/llm";
import { buildAnswerMessages } from "@wiki/llm";
import type { MlClient, QdrantIndex } from "@wiki/retrieval";
import type { ChatStreamEvent, RetrievedChunk } from "@wiki/contracts";
import { classifyIntent, toRetrievalFilters } from "./intent.js";
import { buildComparison } from "./compare.js";
import { resolveProductsByName } from "./resolve.js";

export interface OrchestratorDeps {
  db: Database;
  llm: LLMProvider;
  qdrant: QdrantIndex;
  ml: MlClient;
}

export interface ChatContext {
  sessionId: string;
  message: string;
  history: { role: string; content: string }[];
  productContextId?: string;
}

/**
 * RAG-пайплайн як async-генератор SSE-подій. Кроки:
 *  1) intent + фільтри  2) hybrid retrieval  3) rerank  4) дотягнути canonical
 *  5) генерація з цитатами (стрім). Для compare — детермінований diff замість LLM-таблиці.
 */
export async function* runChat(
  deps: OrchestratorDeps,
  ctx: ChatContext,
): AsyncGenerator<ChatStreamEvent> {
  const { db, llm, qdrant, ml } = deps;

  yield { type: "session", sessionId: ctx.sessionId };

  // 1. Розуміння запиту
  const intent = await classifyIntent(llm, ctx.message, ctx.history);
  yield { type: "intent", intent: intent.intent };

  if (intent.intent === "out_of_scope") {
    for (const t of scopeMessage()) yield { type: "token", text: t };
    yield { type: "done" };
    return;
  }

  // Гілка порівняння — детермінована таблиця
  if (intent.intent === "compare" && (intent.filters.productNames?.length ?? 0) >= 2) {
    const resolved = await resolveProductsByName(db, intent.filters.productNames!);
    if (resolved.length >= 2) {
      const table = await buildComparison(
        db,
        resolved.map((r) => r.id),
        resolved.map((r) => r.name),
      );
      yield { type: "comparison", table };
      // LLM коментує лише значущі відмінності
      const diffs = table.rows.filter((r) => r.differs);
      const summary = await llm.generate([
        { role: "system", content: "Коротко прокоментуй ключові відмінності товарів за таблицею. Без вигадок." },
        { role: "user", content: JSON.stringify({ products: table.productNames, diffs }) },
      ]);
      yield { type: "token", text: summary };
      yield { type: "done" };
      return;
    }
  }

  // 2. Hybrid retrieval
  const filters = toRetrievalFilters(intent);
  if (ctx.productContextId) filters.productIds = [ctx.productContextId];
  const candidates = await qdrant.search(intent.searchQuery, filters, 50);

  if (candidates.length === 0) {
    for (const t of noDataMessage()) yield { type: "token", text: t };
    yield { type: "done" };
    // Сигнал scheduler-у, куди розширювати каталог (попит без покриття).
    await logQuery(db, ctx.sessionId, intent.intent, ctx.message, [], true);
    return;
  }

  // 3. Rerank → top-8
  const reranked = await rerank(ml, intent.searchQuery, candidates, 8);

  // 4. Картки товарів (dedupe за productId)
  const seen = new Set<string>();
  for (const chunk of reranked) {
    if (seen.has(chunk.productId)) continue;
    seen.add(chunk.productId);
    const card = await buildProductCard(db, chunk.productId);
    if (card) yield { type: "product_card", card };
  }

  // 5. Цитати: дедуп за джерелом ДО нумерації, щоб маркери [n] у відповіді LLM,
  //    emitted-цитати і показ на фронті збігались 1:1. Заповнюємо назву та дату знімка.
  const citeChunks: RetrievedChunk[] = [];
  const seenUrl = new Set<string>();
  for (const c of reranked) {
    const url = c.sourceUrls[0] ?? "";
    if (seenUrl.has(url)) continue;
    seenUrl.add(url);
    citeChunks.push(c);
  }
  let idx = 0;
  for (const chunk of citeChunks) {
    idx++;
    yield {
      type: "citation",
      citation: {
        marker: idx,
        productId: chunk.productId,
        productName: await productName(db, chunk.productId),
        sourceUrl: chunk.sourceUrls[0] ?? "",
        snapshotDate: await snapshotDate(db, chunk.sourceUrls[0]),
      },
    };
  }

  const messages = buildAnswerMessages(ctx.message, citeChunks);
  for await (const token of llm.stream(messages, { temperature: 0.2 })) {
    yield { type: "token", text: token };
  }
  yield { type: "done" };
  await logQuery(db, ctx.sessionId, intent.intent, ctx.message, [...seen], false);
}

async function rerank(
  ml: MlClient,
  query: string,
  candidates: RetrievedChunk[],
  topK: number,
): Promise<RetrievedChunk[]> {
  const ranking = await ml.rerank(query, candidates.map((c) => c.text), topK);
  return ranking.map((r) => candidates[r.index]!).filter(Boolean);
}

async function buildProductCard(db: Database, productId: string) {
  const [p] = await db.select().from(products).where(eq(products.id, productId)).limit(1);
  if (!p) return null;

  let categoryPath: string[] = [];
  let thumbnail: string | null = null;
  if (p.currentRevisionId) {
    const [rev] = await db
      .select({ snapshot: productRevisions.snapshot })
      .from(productRevisions)
      .where(eq(productRevisions.id, p.currentRevisionId))
      .limit(1);
    const snap = rev?.snapshot as { categoryPath?: string[]; media?: { type: string; url: string }[] } | undefined;
    categoryPath = snap?.categoryPath ?? [];
    thumbnail = snap?.media?.find((m) => m.type === "image" && /^https?:\/\//.test(m.url))?.url ?? null;
  }
  const specs = await db
    .select({ label: attributeOntology.label, value: productAttributes.valueRaw, unit: productAttributes.unitCanonical })
    .from(productAttributes)
    .innerJoin(attributeOntology, eq(productAttributes.attrKey, attributeOntology.key))
    .where(eq(productAttributes.productId, productId))
    .limit(4);

  return {
    productId: p.id,
    brand: p.brand,
    name: p.name,
    categoryPath,
    thumbnail,
    keySpecs: specs.map((s) => ({ label: s.label, value: `${s.value}${s.unit ? " " + s.unit : ""}` })),
  };
}

/** Назва товару для цитати (бренд + модель). */
async function productName(db: Database, productId: string): Promise<string> {
  const [p] = await db.select({ brand: products.brand, name: products.name }).from(products).where(eq(products.id, productId)).limit(1);
  return p ? `${p.brand} ${p.name}` : "";
}

/** Дата свіжості даних цитати — з знімка сторінки-джерела. */
async function snapshotDate(db: Database, url: string | undefined): Promise<string> {
  if (!url) return "";
  const [s] = await db.select({ at: pageSnapshots.fetchedAt }).from(pageSnapshots).where(eq(pageSnapshots.url, url)).limit(1);
  return s ? s.at.toISOString() : "";
}

/** Аналітика попиту → сигнал scheduler-у (no_results = куди розширювати каталог). */
async function logQuery(
  db: Database,
  sessionId: string,
  intent: string,
  queryText: string,
  matchedProductIds: string[],
  noResults: boolean,
): Promise<void> {
  await db
    .insert(chatQueries)
    .values({ sessionId, intent, queryText, matchedProductIds, noResults })
    .catch(() => void 0); // аналітика best-effort, не ламає відповідь
}

function scopeMessage(): string[] {
  return [
    "Я допомагаю лише з інформацією про товари: характеристики, підбір за потребами та порівняння. ",
    "Спробуйте, наприклад: «порадь тихий робот-пилосос до 15000 грн».",
  ];
}

function noDataMessage(): string[] {
  return ["У мене поки немає даних від виробника, щоб відповісти на це. Ми постійно розширюємо каталог."];
}
