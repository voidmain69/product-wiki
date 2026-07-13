import { eq } from "drizzle-orm";
import { createDb, productRevisions } from "@wiki/db";
import { EventBus, EventSubjects } from "@wiki/events";
import { MlClient, QdrantIndex } from "@wiki/retrieval";
import { createLLM } from "@wiki/llm";
import type { Product } from "@wiki/contracts";
import type { EventOf } from "@wiki/contracts/events";
import { buildChunks } from "./chunker.js";

/**
 * Indexer-воркер: споживає `product.updated`, будує типізовані чанки,
 * ембедить (BGE-M3, dense+sparse), upsert-ить у Qdrant і видаляє чанки старих
 * ревізій. Реіндексує ЛИШЕ змінений товар (не всю колекцію).
 */
async function main() {
  const db = createDb();
  const bus = await EventBus.connect();
  const ml = new MlClient();
  const qdrant = new QdrantIndex(ml);
  const llm = createLLM();
  await qdrant.ensureCollection();

  console.log("indexer: підписка на", EventSubjects.ProductUpdated);

  await bus.subscribe(
    EventSubjects.ProductUpdated,
    "indexer",
    async (event: EventOf<typeof EventSubjects.ProductUpdated>) => {
      const { productId, revisionId } = event.payload;

      const [rev] = await db
        .select({ snapshot: productRevisions.snapshot })
        .from(productRevisions)
        .where(eq(productRevisions.id, revisionId))
        .limit(1);
      if (!rev) return;
      const product = rev.snapshot as Product;
      // snapshot створюється ДО присвоєння id ревізії, тож проставляємо їх з події:
      // chunk.revisionId має збігатися з keepRevisionId, інакше deleteStale видалить
      // щойно вставлені точки (стара ревізія = все, що != поточна).
      product.id = productId;
      product.revisionId = revisionId;

      // usecase-чанк: LLM один раз описує "для кого і яких потреб" з фактів картки.
      // Коштує один LLM-виклик на товар — для масового бекфілу його можна пропустити
      // (INDEXER_SKIP_USECASE=1): overview/spec/feature несуть основний сигнал пошуку,
      // а usecase доіндексовується пізніше окремим повільним проходом.
      const usecase =
        process.env.INDEXER_SKIP_USECASE === "1"
          ? undefined
          : await llm
              .generate([
                {
                  role: "system",
                  content:
                    "На основі фактів про товар опиши 2-3 реченнями, для кого і яких потреб він підходить. " +
                    "Спирайся ЛИШЕ на надані характеристики, без вигадок і оцінок. " +
                    "Пиши українською, навіть якщо характеристики подані іншою мовою.",
                },
                {
                  role: "user",
                  content: JSON.stringify({
                    name: product.name,
                    category: product.categoryPath,
                    attributes: product.attributes.map((a) => ({ k: a.key, v: a.valueRaw })),
                  }),
                },
              ])
              .catch(() => undefined);

      const chunks = buildChunks(product, usecase);
      await qdrant.upsertChunks(chunks);
      await qdrant.deleteStale(productId, revisionId);

      await bus.publish(EventSubjects.ProductIndexed, {
        id: `${revisionId}-idx`,
        subject: EventSubjects.ProductIndexed,
        traceId: event.traceId,
        occurredAt: new Date().toISOString(),
        payload: { productId, revisionId, chunkCount: chunks.length },
      });

      console.log(`indexed ${product.brand} ${product.name} (${chunks.length} chunks)`);
    },
  );

  process.on("SIGTERM", async () => {
    await bus.drain();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("indexer fatal:", err);
  process.exit(1);
});
