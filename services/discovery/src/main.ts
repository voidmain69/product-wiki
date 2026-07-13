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
      const domains = (source.domains as string[]) ?? [];

      for (const entry of policy.entrypoints) {
        // sitemap (≈80% виробників), інакше — каталожний BFS із класифікатором сторінок
        const urls = entry.endsWith(".xml") ? await parseSitemap(entry) : await crawlCatalog(entry, patterns, domains);
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

/**
 * Каталожний BFS — fallback, коли нема sitemap. Ходить по лістингах у межах домену,
 * збирає товарні URL (за urlPatterns або класифікатором сторінки). Обмежений
 * (maxPages/maxDepth), щоб не обходити весь сайт; ввічливість fetch-у — на fetcher-і.
 */
async function crawlCatalog(
  start: string,
  patterns: RegExp[],
  domains: string[],
  opts: { maxPages: number; maxDepth: number } = { maxPages: 60, maxDepth: 3 },
): Promise<string[]> {
  const products = new Set<string>();
  const seen = new Set<string>([start]);
  let frontier: { url: string; depth: number }[] = [{ url: start, depth: 0 }];
  let fetched = 0;

  while (frontier.length && fetched < opts.maxPages) {
    const next: { url: string; depth: number }[] = [];
    for (const { url, depth } of frontier) {
      if (fetched >= opts.maxPages) break;
      fetched++;
      const html = await fetchText(url).catch(() => "");
      if (!html) continue;
      // сама сторінка може бути товарною (класифікатор), навіть якщо URL не за патерном
      if (patterns.some((r) => r.test(url)) || isProductPage(html)) products.add(url);

      for (const link of extractLinks(html, url)) {
        if (!sameHost(link, domains) || seen.has(link)) continue;
        if (patterns.some((r) => r.test(link))) {
          products.add(link);
        } else if (depth < opts.maxDepth) {
          seen.add(link);
          next.push({ url: link, depth: depth + 1 });
        }
      }
    }
    frontier = next;
  }
  return [...products];
}

async function fetchText(url: string): Promise<string> {
  const res = await request(url, { maxRedirections: 3 });
  return res.body.text();
}

/** Класифікатор: сторінка товару має schema.org/Product або спец-блок теххарактеристик. */
function isProductPage(html: string): boolean {
  return /"@type"\s*:\s*"Product"/.test(html) || /rowTableTitle|PDTechSpec/.test(html);
}

function extractLinks(html: string, base: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
    try {
      out.push(new URL(m[1]!, base).toString());
    } catch {
      /* невалідний href */
    }
  }
  return out;
}

function sameHost(url: string, domains: string[]): boolean {
  try {
    const host = new URL(url).host.replace(/^www\./, "");
    return domains.some((d) => host === d.replace(/^www\./, ""));
  } catch {
    return false;
  }
}

function idFor(seed: string): string {
  return createHash("sha1").update(seed).digest("hex").slice(0, 24);
}

main().catch((err) => {
  console.error("discovery fatal:", err);
  process.exit(1);
});
