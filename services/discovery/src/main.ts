import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { Agent, interceptors, request } from "undici";
import Redis from "ioredis";
import { eq } from "drizzle-orm";
import { createDb, sources, crawlTasks, pageSnapshots } from "@wiki/db";
import { EventBus, EventSubjects } from "@wiki/events";
import { ObjectStore } from "@wiki/storage";
import type { EventOf } from "@wiki/contracts/events";
import { parseSitemapXml } from "./sitemap.js";
import { isProductPage } from "./classify.js";
import { routeLinks } from "./bfs.js";

/** User-Agent із контактом (ввічливість, інваріант 8) — для sitemap-запитів. */
const USER_AGENT =
  "ProductWikiBot/0.1 (+https://product-wiki.example/bot; contact: Info_DIT@erc.ua)";

/** Межі каталожного BFS на джерело: щоб не обходити весь сайт (fallback без sitemap). */
const MAX_DEPTH = 3;
const MAX_BFS_PAGES = 60;
const BFS_TTL_SEC = 86_400; // лічильник бюджету живе добу (скидається на ре-дискавері)

interface CrawlPolicy {
  entrypoints: string[];
  urlPatterns: string[];
}

/**
 * Discovery-воркер. Два способи знайти сторінки товарів:
 *   1) sitemap.xml (≈80% виробників) — на `source.registered` парсимо й ставимо в чергу
 *      товарні URL (kind=product);
 *   2) каталожний BFS — коли entrypoint не sitemap: ставимо його як kind=listing і далі
 *      ПОДІЄВО обходимо через ВВІЧЛИВИЙ fetcher (robots + rate-limit), а на `page.fetched`
 *      (kind=listing) дістаємо посилання й розкладаємо на product/listing.
 * Ніякого власного HTTP до сторінок товарів — лише fetcher (інваріант 8).
 */
async function main() {
  const db = createDb();
  const bus = await EventBus.connect();
  const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
  const store = new ObjectStore();

  /** Ідемпотентно ставить URL у чергу (dedup per-source у Redis), публікує url.discovered. */
  async function enqueueUrl(
    sourceId: string,
    url: string,
    kind: "product" | "listing",
    depth: number,
  ): Promise<boolean> {
    const isNew = await redis.sadd(`seen:${sourceId}`, url);
    if (!isNew) return false;
    await db.insert(crawlTasks).values({ sourceId, url, priority: 0, status: "queued" }).onConflictDoNothing();
    await bus.publish(EventSubjects.UrlDiscovered, {
      id: idFor(`${kind}:${url}`),
      subject: EventSubjects.UrlDiscovered,
      traceId: idFor(url),
      occurredAt: new Date().toISOString(),
      // product — дефолт у консюмерів, тож kind/depth ставимо лише для listing (BC).
      payload: { sourceId, url, priority: 0, ...(kind === "listing" ? { kind, depth } : {}) },
    });
    return true;
  }

  console.log("discovery: підписка на", EventSubjects.SourceRegistered, "+", EventSubjects.PageFetched);

  // ── Спосіб 1/2 старт: sitemap → product; не-sitemap entrypoint → listing (BFS) ──
  await bus.subscribe(
    EventSubjects.SourceRegistered,
    "discovery",
    async (event: EventOf<typeof EventSubjects.SourceRegistered>) => {
      const [source] = await db.select().from(sources).where(eq(sources.id, event.payload.sourceId)).limit(1);
      if (!source || source.status !== "active") return;

      const policy = source.crawlPolicy as CrawlPolicy;
      const patterns = policy.urlPatterns.map((p) => new RegExp(p));
      await redis.del(`bfs:pages:${source.id}`); // свіжий бюджет обходу на (ре)реєстрацію

      for (const entry of policy.entrypoints) {
        if (entry.endsWith(".xml") || entry.endsWith(".xml.gz")) {
          const urls = await parseSitemap(entry).catch((e) => {
            console.warn(`sitemap ${entry}: ${(e as Error).message}`);
            return [] as string[];
          });
          for (const url of urls) {
            if (patterns.some((r) => r.test(url))) await enqueueUrl(source.id, url, "product", 0);
          }
        } else {
          // не-sitemap: каталожна сторінка → обхід через fetcher (kind=listing)
          await enqueueUrl(source.id, entry, "listing", 0);
        }
      }
      console.log(`discovery done for ${source.name}`);
    },
  );

  // ── BFS-крок: каталожну (listing) сторінку завантажив fetcher → дістаємо посилання ──
  await bus.subscribe(
    EventSubjects.PageFetched,
    "discovery-bfs",
    async (event: EventOf<typeof EventSubjects.PageFetched>) => {
      if ((event.payload.kind ?? "product") !== "listing") return; // товарні сторінки — не наша справа
      const { sourceId, snapshotRef, url } = event.payload;
      const depth = event.payload.depth ?? 0;

      const [snap] = await db
        .select({ htmlKey: pageSnapshots.htmlKey })
        .from(pageSnapshots)
        .where(eq(pageSnapshots.id, snapshotRef))
        .limit(1);
      if (!snap?.htmlKey) return;
      const [source] = await db.select().from(sources).where(eq(sources.id, sourceId)).limit(1);
      if (!source || source.status !== "active") return;

      const policy = source.crawlPolicy as CrawlPolicy;
      const patterns = policy.urlPatterns.map((p) => new RegExp(p));
      const domains = (source.domains as string[]) ?? [];
      const html = await store.getText(snap.htmlKey);

      // Якщо «каталожна» сторінка насправді товарна — екстрактор її вже обробив
      // детермінованими рівнями; посилання (нав/related) не розкручуємо.
      if (isProductPage(html)) return;

      const { products, listings } = routeLinks(html, url, patterns, domains, depth, MAX_DEPTH);
      for (const p of products) await enqueueUrl(sourceId, p, "product", 0);

      // Каталожні — під бюджет (щоб не обходити весь сайт).
      const budgetKey = `bfs:pages:${sourceId}`;
      let used = Number(await redis.get(budgetKey)) || 0;
      for (const l of listings) {
        if (used >= MAX_BFS_PAGES) break;
        if (await enqueueUrl(sourceId, l, "listing", depth + 1)) {
          used = await redis.incr(budgetKey);
          await redis.expire(budgetKey, BFS_TTL_SEC);
        }
      }
    },
  );

  process.on("SIGTERM", async () => {
    await Promise.allSettled([bus.drain(), redis.quit()]);
    process.exit(0);
  });
}

// undici 8: опцію `maxRedirections` на request прибрано — редиректи лише через інтерцептор.
const redirectDispatcher = new Agent().compose(interceptors.redirect({ maxRedirections: 3 }));

/**
 * Завантажує sitemap і повертає сторінкові URL. Index — рекурсія з guard (глибина ≤2 +
 * відвідані), .gz (Content-Encoding або суфікс), UA з контактом. Парсинг — `parseSitemapXml`.
 */
async function parseSitemap(url: string, seen = new Set<string>(), depth = 0): Promise<string[]> {
  if (depth > 2 || seen.has(url)) return [];
  seen.add(url);
  const res = await request(url, {
    dispatcher: redirectDispatcher,
    headers: { "user-agent": USER_AGENT },
  });
  let buf = Buffer.from(await res.body.arrayBuffer());
  const enc = res.headers["content-encoding"];
  if (url.endsWith(".gz") || enc === "gzip" || enc === "x-gzip") {
    try {
      buf = gunzipSync(buf);
    } catch {
      /* не gzip попри суфікс — лишаємо як є */
    }
  }
  const { entries, nested } = parseSitemapXml(buf.toString("utf8"));
  if (nested.length) {
    const sub = await Promise.all(nested.map((n) => parseSitemap(n, seen, depth + 1).catch(() => [])));
    return sub.flat();
  }
  return entries.map((e) => e.loc);
}

function idFor(seed: string): string {
  return createHash("sha1").update(seed).digest("hex").slice(0, 24);
}

main().catch((err) => {
  console.error("discovery fatal:", err);
  process.exit(1);
});
