import { createHash } from "node:crypto";
import Redis from "ioredis";
import { createDb, sources, pageSnapshots, pageFreshness, productDrafts, chatQueries } from "@wiki/db";
import { EventBus, EventSubjects } from "@wiki/events";
import type { EventOf } from "@wiki/contracts/events";
import { and, eq, sql, desc, inArray } from "drizzle-orm";

/**
 * Scheduler-воркер: recrawl-хвилі за crawlPolicy.recrawlIntervalDays + попит із чату.
 * Пріоритет: застарілі (перевищено інтервал) + популярні (chat_queries.matched) —
 * останні тримаємо свіжими незалежно від інтервалу. Слухає page.unchanged.
 */
async function main() {
  const db = createDb();
  const bus = await EventBus.connect();
  const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

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
      const policy = s.crawlPolicy as { recrawlIntervalDays?: number; discoveryIntervalDays?: number };
      const cutoff = new Date(Date.now() - (policy.recrawlIntervalDays ?? 30) * 86_400_000);

      // ре-дискавері за інтервалом: NX+EX гарантує не частіше, ніж раз на інтервал
      // (навіть при рестартах/щогодинних тіках). Discovery через seen-set віддасть лише нові URL.
      const discDays = policy.discoveryIntervalDays ?? 7;
      const fresh = await redis.set(`discovery:next:${s.id}`, "1", "EX", discDays * 86_400, "NX");
      if (fresh) {
        await bus.publish(EventSubjects.DiscoveryRequested, {
          id: idFor(`disc:${s.id}:${Date.now()}`),
          subject: EventSubjects.DiscoveryRequested,
          traceId: idFor(`disc:${s.id}`),
          occurredAt: new Date().toISOString(),
          payload: { sourceId: s.id },
        });
        console.log(`scheduler: re-discovery requested for ${s.name}`);
      }

      // 1) застарілі: остання АКТИВНІСТЬ по URL старіша за cutoff. Активність =
      // GREATEST(остання зміна контенту, останній візит). page_snapshots фіксують лише
      // зміни (immutable), тож незмінені сторінки мали б «застиглий» fetched_at і
      // перевибирались щотіка — last_seen_at із page_freshness рухається на КОЖному візиті.
      const stale = await db
        .select({ url: pageSnapshots.url })
        .from(pageSnapshots)
        .leftJoin(
          pageFreshness,
          and(eq(pageFreshness.sourceId, pageSnapshots.sourceId), eq(pageFreshness.url, pageSnapshots.url)),
        )
        .where(eq(pageSnapshots.sourceId, s.id))
        .groupBy(pageSnapshots.url, pageFreshness.lastSeenAt)
        .having(
          sql`greatest(max(${pageSnapshots.fetchedAt}), coalesce(${pageFreshness.lastSeenAt}, 'epoch'::timestamptz)) < ${cutoff}`,
        )
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

  await bus.subscribe(
    EventSubjects.PageUnchanged,
    "scheduler",
    async (event: EventOf<typeof EventSubjects.PageUnchanged>) => {
      // hash збігся — фіксуємо «востаннє бачили», щоб recrawl не перевибирав цей URL
      // щотіка (fetched_at застиг на останній зміні). Ідемпотентно (at-least-once).
      const { sourceId, url } = event.payload;
      await db
        .insert(pageFreshness)
        .values({ sourceId, url })
        .onConflictDoUpdate({ target: [pageFreshness.sourceId, pageFreshness.url], set: { lastSeenAt: new Date() } });
    },
  );

  setInterval(() => void tick().catch(console.error), RECRAWL_TICK_MS);
  console.log("scheduler: recrawl tick every 1h");

  process.on("SIGTERM", async () => {
    await Promise.allSettled([bus.drain(), redis.quit()]);
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
