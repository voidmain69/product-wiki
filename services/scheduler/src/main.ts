import { createHash } from "node:crypto";
import { createDb, sources, pageSnapshots, productDrafts, chatQueries } from "@wiki/db";
import { EventBus, EventSubjects } from "@wiki/events";
import { eq, sql, desc, inArray } from "drizzle-orm";

/**
 * Scheduler-воркер: recrawl-хвилі за crawlPolicy.recrawlIntervalDays + попит із чату.
 * Пріоритет: застарілі (перевищено інтервал) + популярні (chat_queries.matched) —
 * останні тримаємо свіжими незалежно від інтервалу. Слухає page.unchanged.
 */
async function main() {
  const db = createDb();
  const bus = await EventBus.connect();

  // periodic recrawl tick
  const RECRAWL_TICK_MS = 60 * 60 * 1000; // щогодини перевіряємо, що пора перезібрати
  const tick = async () => {
    const active = await db.select().from(sources).where(eq(sources.status, "active"));

    // попит: гарячі товари з останніх запитів чату
    const recent = await db
      .select({ ids: chatQueries.matchedProductIds })
      .from(chatQueries)
      .orderBy(desc(chatQueries.createdAt))
      .limit(100);
    const hot = [...new Set(recent.flatMap((r) => r.ids ?? []))];

    for (const s of active) {
      const policy = s.crawlPolicy as { recrawlIntervalDays?: number };
      const cutoff = new Date(Date.now() - (policy.recrawlIntervalDays ?? 30) * 86_400_000);

      // 1) застарілі: остання версія URL старіша за cutoff
      const stale = await db
        .select({ url: pageSnapshots.url })
        .from(pageSnapshots)
        .where(eq(pageSnapshots.sourceId, s.id))
        .groupBy(pageSnapshots.url)
        .having(sql`max(${pageSnapshots.fetchedAt}) < ${cutoff}`)
        .limit(50);

      // 2) популярні за попитом чату — свіжими незалежно від інтервалу
      const hotUrls = hot.length
        ? await db
            .select({ url: pageSnapshots.url })
            .from(productDrafts)
            .innerJoin(pageSnapshots, eq(productDrafts.snapshotId, pageSnapshots.id))
            .where(inArray(productDrafts.resolvedProductId, hot))
            .limit(50)
        : [];

      const targets = [...new Set([...stale.map((x) => x.url), ...hotUrls.map((x) => x.url)])];
      for (const url of targets) {
        await bus.publish(EventSubjects.UrlDiscovered, {
          id: idFor(`recrawl:${url}:${Date.now()}`),
          subject: EventSubjects.UrlDiscovered, traceId: idFor(url),
          occurredAt: new Date().toISOString(),
          payload: { sourceId: s.id, url, priority: 2 },
        });
      }
      if (targets.length) console.log(`scheduler: recrawl ${targets.length} URLs for ${s.name}`);
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
