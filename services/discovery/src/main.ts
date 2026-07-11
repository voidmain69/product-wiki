import { createHash } from "node:crypto";
import { request } from "undici";
import Redis from "ioredis";
import { eq } from "drizzle-orm";
import { createDb, sources, crawlTasks } from "@wiki/db";
import { EventBus, EventSubjects } from "@wiki/events";
import type { EventOf } from "@wiki/contracts/events";

/**
 * Discovery-воркер: споживає `source.registered`, знаходить сторінки товарів.
 * Пріоритет способів: 1) sitemap.xml (~80% виробників), 2) каталожний BFS (TODO),
 * 3) класифікатор сторінки (TODO). Фільтрує URL за crawlPolicy.urlPatterns,
 * дедуплікує через Redis-set, публікує `url.discovered`.
 */
async function main() {
  const db = createDb();
  const bus = await EventBus.connect();
  const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

  console.log("discovery: підписка на", EventSubjects.SourceRegistered);

  await bus.subscribe(
    EventSubjects.SourceRegistered,
    "discovery",
    async (event: EventOf<typeof EventSubjects.SourceRegistered>) => {
      const [source] = await db.select().from(sources).where(eq(sources.id, event.payload.sourceId)).limit(1);
      if (!source || source.status !== "active") return;

      const policy = source.crawlPolicy as { entrypoints: string[]; urlPatterns: string[] };
      const patterns = policy.urlPatterns.map((p) => new RegExp(p));

      for (const entry of policy.entrypoints) {
        const urls = entry.endsWith(".xml") ? await parseSitemap(entry) : [];
        for (const url of urls) {
          if (!patterns.some((r) => r.test(url))) continue;
          // дедуп per-source
          const isNew = await redis.sadd(`seen:${source.id}`, url);
          if (!isNew) continue;

          await db
            .insert(crawlTasks)
            .values({ sourceId: source.id, url, priority: 0, status: "queued" })
            .onConflictDoNothing();

          await bus.publish(EventSubjects.UrlDiscovered, {
            id: idFor(url), subject: EventSubjects.UrlDiscovered, traceId: idFor(url),
            occurredAt: new Date().toISOString(),
            payload: { sourceId: source.id, url, priority: 0 },
          });
        }
      }
      console.log(`discovery done for ${source.name}`);
    },
  );

  process.on("SIGTERM", async () => {
    await Promise.allSettled([bus.drain(), redis.quit()]);
    process.exit(0);
  });
}

/** Мінімальний парсер sitemap (плоский або index). Продакшн — потоковий XML-парсер. */
async function parseSitemap(url: string): Promise<string[]> {
  const res = await request(url, { maxRedirections: 3 });
  const xml = await res.body.text();
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!.trim());
  // якщо це sitemap-index — рекурсивно тягнемо вкладені
  if (/<sitemapindex/i.test(xml)) {
    const nested = await Promise.all(locs.map((l) => parseSitemap(l).catch(() => [])));
    return nested.flat();
  }
  return locs;
}

function idFor(seed: string): string {
  return createHash("sha1").update(seed).digest("hex").slice(0, 24);
}

main().catch((err) => {
  console.error("discovery fatal:", err);
  process.exit(1);
});
