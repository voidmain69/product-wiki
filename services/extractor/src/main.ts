import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb, pageSnapshots, productDrafts, sources, outbox } from "@wiki/db";
import { EventBus, EventSubjects } from "@wiki/events";
import { ObjectStore } from "@wiki/storage";
import { createLLM } from "@wiki/llm";
import type { EventOf } from "@wiki/contracts/events";
import { runCascade, detectHtmlLang } from "./cascade.js";

/**
 * Extractor-воркер: споживає `page.fetched`, читає raw HTML зі снапшота,
 * проганяє каскад екстракції → ProductDraft у Postgres, публікує `draft.extracted`.
 * Ідемпотентність за snapshotRef.
 */
async function main() {
  const db = createDb();
  const bus = await EventBus.connect();
  const store = new ObjectStore();
  const llm = createLLM();

  // Курована мова джерела (crawlPolicy.lang) кешується per-source; має пріоритет над
  // фолбек-детекцією з <html lang>. Лінива підвантажка + кеш (джерел небагато).
  const policyLangCache = new Map<string, string | null>();
  async function policyLang(sourceId: string): Promise<string | null> {
    const cached = policyLangCache.get(sourceId);
    if (cached !== undefined) return cached;
    const [src] = await db
      .select({ crawlPolicy: sources.crawlPolicy })
      .from(sources)
      .where(eq(sources.id, sourceId))
      .limit(1);
    const lang = (src?.crawlPolicy as { lang?: string } | undefined)?.lang ?? null;
    policyLangCache.set(sourceId, lang);
    return lang;
  }

  console.log("extractor: підписка на", EventSubjects.PageFetched);

  await bus.subscribe(
    EventSubjects.PageFetched,
    "extractor",
    async (event: EventOf<typeof EventSubjects.PageFetched>) => {
      const { snapshotRef, sourceId, url } = event.payload;

      const [snap] = await db
        .select()
        .from(pageSnapshots)
        .where(eq(pageSnapshots.id, snapshotRef))
        .limit(1);
      if (!snap || !snap.htmlKey) return;

      const html = await store.getText(snap.htmlKey);
      const draft = await runCascade(
        { html, url, sourceId, snapshotRef, apiPayloads: (snap.apiPayloads as unknown[]) ?? [] },
        llm,
      );
      if (!draft) {
        console.warn(`extractor: нема даних для ${url}`);
        return;
      }

      // Мова: куроване джерело → <html lang> → null (resolver підставить "uk").
      const lang = (await policyLang(sourceId)) ?? detectHtmlLang(html);

      await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(productDrafts)
          .values({
            snapshotId: snapshotRef,
            sourceId,
            name: draft.name,
            brand: draft.brand,
            mpn: draft.mpn ?? null,
            gtin: draft.gtin ?? null,
            categoryRaw: draft.categoryRaw,
            attributesRaw: draft.attributesRaw,
            descriptions: draft.descriptions,
            media: draft.media,
            extractionMethod: draft.extractionMethod,
            confidence: draft.confidence,
            lang,
          })
          .returning({ id: productDrafts.id });

        await tx.insert(outbox).values({
          subject: EventSubjects.DraftExtracted,
          traceId: event.traceId,
          payload: {
            id: newId(), subject: EventSubjects.DraftExtracted, traceId: event.traceId,
            occurredAt: new Date().toISOString(),
            payload: { sourceId, snapshotRef, draftId: row!.id },
          },
        });
      });

      console.log(`extracted [${draft.extractionMethod}] ${draft.brand} ${draft.name}`);
    },
  );

  process.on("SIGTERM", async () => {
    await bus.drain();
    process.exit(0);
  });
}

function newId(): string {
  return createHash("sha1").update(`${Date.now()}:${Math.random()}`).digest("hex").slice(0, 24);
}

main().catch((err) => {
  console.error("extractor fatal:", err);
  process.exit(1);
});
