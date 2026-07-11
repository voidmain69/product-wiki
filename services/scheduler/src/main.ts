import { createHash } from "node:crypto";
import { createDb, sources, crawlTasks } from "@wiki/db";
import { EventBus, EventSubjects } from "@wiki/events";
import { eq } from "drizzle-orm";

/**
 * Scheduler-воркер: recrawl-хвилі за crawlPolicy.recrawlIntervalDays + позачергові
 * задачі. Пріоритет: нові > популярні (за попитом чату — chat_queries) > хвіст.
 * Скелет Фази 1: періодично публікує url.discovered для активних джерел (демо).
 * Слухає page.unchanged, щоб оновлювати last_seen (тут — лог).
 */
async function main() {
  const db = createDb();
  const bus = await EventBus.connect();

  // periodic recrawl tick
  const RECRAWL_TICK_MS = 60 * 60 * 1000; // щогодини перевіряємо, що пора перезібрати
  const tick = async () => {
    const active = await db.select().from(sources).where(eq(sources.status, "active"));
    for (const s of active) {
      // TODO: обрати URL, у яких (now - last fetched) > recrawlIntervalDays,
      // ранжувати за попитом з chat_queries.no_results / matched_product_ids
      const queued = await db
        .select({ url: crawlTasks.url })
        .from(crawlTasks)
        .where(eq(crawlTasks.sourceId, s.id))
        .limit(50);
      for (const t of queued) {
        await bus.publish(EventSubjects.UrlDiscovered, {
          id: idFor(`recrawl:${t.url}:${Date.now()}`),
          subject: EventSubjects.UrlDiscovered, traceId: idFor(t.url),
          occurredAt: new Date().toISOString(),
          payload: { sourceId: s.id, url: t.url, priority: 1 },
        });
      }
    }
  };

  await bus.subscribe(EventSubjects.PageUnchanged, "scheduler", async (event) => {
    // hash збігся — просто оновлюємо last_seen (тут лог)
    console.log(`unchanged: ${event.payload.url}`);
  });

  setInterval(() => void tick().catch(console.error), RECRAWL_TICK_MS);
  console.log("scheduler: recrawl tick every 1h");

  process.on("SIGTERM", async () => {
    await bus.drain();
    process.exit(0);
  });
}

function idFor(seed: string): string {
  return createHash("sha1").update(seed).digest("hex").slice(0, 24);
}

main().catch((err) => {
  console.error("scheduler fatal:", err);
  process.exit(1);
});
