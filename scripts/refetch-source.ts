/**
 * Точковий re-fetch уже відкритих URL джерела через РЕАЛЬНИЙ пайплайн: публікує
 * `url.discovered` для наявних у page_snapshots URL цього джерела, оминаючи discovery
 * (без нового обходу sitemap). Fetcher перезавантажує сторінки поточним адаптером,
 * і, якщо contentHash змінився (напр. новий api-replay-адаптер додав apiPayloads),
 * екстрактор переекстрактовує з новими даними; resolver доклеює атрибути до наявного
 * товару (URL-родина), не плодячи дублів.
 *
 * Потрібен після зміни адаптера/каскаду, коли товари вже в БД, але без спеків.
 *
 * Запуск: pnpm tsx scripts/refetch-source.ts <sourceId> [limit]
 *   (мають бути підняті воркери: fetcher → extractor → normalizer → resolver → indexer)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createDb, pageSnapshots } from "@wiki/db";
import { EventBus, EventSubjects } from "@wiki/events";
import { eq } from "drizzle-orm";

const ROOT = join(import.meta.dirname, "..");

function loadEnv(): void {
  try {
    for (const line of readFileSync(join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && m[1] && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch {
    /* дефолти оточення */
  }
}

async function main() {
  loadEnv();
  const sourceId = process.argv[2];
  const limit = process.argv[3] ? Number(process.argv[3]) : Infinity;
  if (!sourceId) {
    console.error("Використання: pnpm tsx scripts/refetch-source.ts <sourceId> [limit]");
    process.exit(1);
  }

  const db = createDb();
  const bus = await EventBus.connect();

  // унікальні URL цього джерела (по одному знімку на URL достатньо — fetcher візьме свіжий)
  const snaps = await db
    .select({ url: pageSnapshots.url })
    .from(pageSnapshots)
    .where(eq(pageSnapshots.sourceId, sourceId));
  const urls = [...new Set(snaps.map((s) => s.url))].slice(0, limit);

  console.log(`• публікую url.discovered для ${urls.length} URL джерела ${sourceId}`);
  let n = 0;
  for (const url of urls) {
    await bus.publish(EventSubjects.UrlDiscovered, {
      id: idFor(`refetch:${url}`),
      subject: EventSubjects.UrlDiscovered,
      traceId: idFor(`refetch:${url}`),
      occurredAt: new Date().toISOString(),
      payload: { sourceId, url, priority: 1 },
    });
    if (++n % 50 === 0) console.log(`  … ${n}/${urls.length}`);
  }
  console.log(`✓ опубліковано ${n} подій. Пайплайн обробляє асинхронно (стеж за логами воркерів).`);
  await bus.drain();
  process.exit(0);
}

function idFor(seed: string): string {
  return createHash("sha1").update(seed).digest("hex").slice(0, 24);
}

main().catch((e) => {
  console.error("refetch-source error:", e?.message ?? e);
  process.exit(1);
});
