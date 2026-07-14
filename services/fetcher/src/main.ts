import { createHash } from "node:crypto";
import Redis from "ioredis";
import { desc, eq } from "drizzle-orm";
import { createDb, pageSnapshots, sources, outbox } from "@wiki/db";
import { EventBus, EventSubjects } from "@wiki/events";
import { AdapterRegistry } from "@wiki/engine-adapters";
import { ObjectStore } from "@wiki/storage";
import type { EventOf } from "@wiki/contracts/events";
import { DomainRateLimiter } from "./rate-limiter.js";
import { RobotsGate } from "./robots.js";

/**
 * Fetcher-воркер: споживає `url.discovered`, завантажує сторінку відповідним
 * адаптером (з автодетекцією рушія), зберігає immutable-снапшот у object storage,
 * пише метадані в Postgres і публікує `page.fetched` (або `page.unchanged`
 * при збігу contentHash — економія 70-90% обробки на recrawl).
 */

const USER_AGENT =
  "ProductWikiBot/0.1 (+https://product-wiki.example/bot; contact: Info_DIT@erc.ua)";

async function main() {
  const db = createDb();
  const bus = await EventBus.connect();
  const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
  const store = new ObjectStore();
  await store.ensureBucket();
  const registry = new AdapterRegistry();
  const limiter = new DomainRateLimiter(redis);
  const robots = new RobotsGate(redis, USER_AGENT);

  console.log("fetcher: підписка на", EventSubjects.UrlDiscovered);

  await bus.subscribe(
    EventSubjects.UrlDiscovered,
    "fetcher",
    async (event: EventOf<typeof EventSubjects.UrlDiscovered>) => {
      const { sourceId, url } = event.payload;
      // BFS-метадані протягуємо наскрізь у page.fetched (discovery/extractor гілкуються по kind)
      const kind = event.payload.kind ?? "product";
      const depth = event.payload.depth ?? 0;

      const [source] = await db.select().from(sources).where(eq(sources.id, sourceId)).limit(1);
      if (!source || source.status !== "active") return;

      const policy = source.crawlPolicy as { maxRps?: number; engineHint?: string };
      const domain = new URL(url).hostname;

      // 0. robots.txt — жорстке правило (інваріант 8): заборонено → не чіпаємо
      if (!(await robots.allowed(url))) {
        console.warn(`robots.txt disallow: ${url}`);
        return;
      }

      await limiter.acquire(domain, policy.maxRps ?? 0.5);

      // 1. Завантаження (детекція рушія всередині registry.fetch)
      const result = await registry.fetch({
        url,
        sourceId,
        maxRps: policy.maxRps ?? 0.5,
        engineHint: policy.engineHint as never,
        userAgent: USER_AGENT,
      });

      // 2. Skip незмінених сторінок за contentHash — порівнюємо з НАЙСВІЖІШИМ снапшотом
      // (desc), інакше зміна A→B→… лишала б порівняння проти найстарішого й писала дублі.
      const prev = await db
        .select({ hash: pageSnapshots.contentHash })
        .from(pageSnapshots)
        .where(eq(pageSnapshots.url, url))
        .orderBy(desc(pageSnapshots.fetchedAt))
        .limit(1);
      if (prev[0]?.hash === result.snapshot.contentHash) {
        await bus.publish(EventSubjects.PageUnchanged, {
          id: newId(), subject: EventSubjects.PageUnchanged, traceId: event.traceId,
          occurredAt: new Date().toISOString(),
          payload: { sourceId, url, contentHash: result.snapshot.contentHash },
        });
        return;
      }

      // 3. Вивантаження тіла в object storage (immutable)
      const sha = result.snapshot.contentHash.slice(0, 16);
      let htmlKey: string | null = null;
      if (result.htmlBody) {
        htmlKey = await store.putText(`${sourceId}/${sha}/page.html`, result.htmlBody);
      }
      const screenshotKeys: string[] = [];
      for (const shot of result.screenshots) {
        const key = await store.putBytes(`${sourceId}/${sha}/${shot.key}`, shot.bytes, "image/png");
        screenshotKeys.push(key);
      }

      // 4. Транзакційно: снапшот + подія в outbox
      await db.transaction(async (tx) => {
        const [snap] = await tx
          .insert(pageSnapshots)
          .values({
            sourceId,
            url,
            engine: result.snapshot.engine,
            httpStatus: result.snapshot.httpStatus,
            contentHash: result.snapshot.contentHash,
            htmlKey,
            apiPayloads: result.snapshot.apiPayloads,
            screenshotKeys,
          })
          .returning({ id: pageSnapshots.id });

        const snapshotRef = snap!.id;
        await tx.insert(outbox).values({
          subject: EventSubjects.PageFetched,
          traceId: event.traceId,
          payload: {
            id: newId(), subject: EventSubjects.PageFetched, traceId: event.traceId,
            occurredAt: new Date().toISOString(),
            payload: { sourceId, snapshotRef, url, kind, depth },
          },
        });
      });

      console.log(`fetched ${url} via ${result.engine}`);
    },
  );

  process.on("SIGTERM", async () => {
    await Promise.allSettled([bus.drain(), registry.dispose(), redis.quit()]);
    process.exit(0);
  });
}

function newId(): string {
  return createHash("sha1").update(`${Date.now()}:${Math.random()}`).digest("hex").slice(0, 24);
}

main().catch((err) => {
  console.error("fetcher fatal:", err);
  process.exit(1);
});
