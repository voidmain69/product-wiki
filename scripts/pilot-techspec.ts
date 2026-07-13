/**
 * Пілот re-fetch ASUS /techspec/ (bounded, НЕ руйнівний): доводить, що спец-каскад
 * витягує реальні характеристики й вони доходять до канонічного товару та вікі-панелі.
 *
 * На відміну від smoke-real, НЕ робить TRUNCATE — переиспользує наявне джерело й
 * товари. Бере N базових URL зі снапшотів, конструює /techspec/ і публікує рівно
 * стільки url.discovered. Resolver матчить існуючий товар за brand+name і додає
 * атрибути новою ревізією; indexer реіндексує. Manual-only (тягне живий сайт).
 *
 * Запуск: pnpm tsx scripts/pilot-techspec.ts [N=20]
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createDb, pageSnapshots, productAttributes } from "@wiki/db";
import { EventBus, EventSubjects } from "@wiki/events";

const ROOT = join(import.meta.dirname, "..");
const WORKERS = ["outbox-relay", "fetcher", "extractor", "normalizer", "resolver", "indexer"];

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function startWorker(name: string, extraEnv: Record<string, string> = {}): ChildProcess & { tail: string[] } {
  const c = spawn(process.execPath, ["--import", "tsx", `services/${name}/src/main.ts`], {
    cwd: ROOT,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  }) as ChildProcess & { tail: string[] };
  c.tail = [];
  const cap = (b: Buffer) => {
    for (const l of b.toString().split(/\r?\n/)) if (l.trim()) c.tail.push(`[${name}] ${l}`);
    while (c.tail.length > 25) c.tail.shift();
  };
  c.stdout!.on("data", cap);
  c.stderr!.on("data", cap);
  return c;
}

/** Базовий product-URL → сторінка теххарактеристик (.../model/ → .../model/techspec/). */
function techspecUrl(base: string): string {
  const u = base.endsWith("/") ? base : base + "/";
  return u + "techspec/";
}

async function main() {
  const n = Number(process.argv[2] ?? 20);
  loadEnv();
  const db = createDb();
  const bus = await EventBus.connect();
  const children: (ChildProcess & { tail: string[] })[] = [];

  try {
    // джерело + URL беремо з наявних снапшотів (нічого не чистимо).
    // Пілот — на моніторах: /techspec/ підтверджено 200 саме для цієї категорії
    // (для деяких інших категорій ASUS /techspec/ віддає 404 — покриття перевіримо
    // на повному прогоні).
    const all = await db
      .select({ id: pageSnapshots.id, sourceId: pageSnapshots.sourceId, url: pageSnapshots.url })
      .from(pageSnapshots);
    if (!all.length) throw new Error("немає снапшотів — спершу зроби ingest");
    const offset = Number(process.argv[3] ?? 0);
    const catPattern = process.argv[4] ?? "/monitors/"; // категорія (regex) для оцінки покриття

    // Режим reextract:<regex> — переганяємо ІСНУЮЧІ /techspec/-снапшоти через екстрактор
    // (без ASUS-трафіку), щоб перевірити оновлений каскад. Інакше — живий re-fetch.
    const reextract = catPattern.startsWith("reextract:");
    const catRe = new RegExp(reextract ? catPattern.slice("reextract:".length) : catPattern);

    const attrsBefore = await db.$count(productAttributes);
    console.log(`• product_attributes до: ${attrsBefore}`);
    console.log("• purge NATS-стріму (backlog; Postgres не чіпаємо)");
    await bus.purge();

    const workers = reextract ? WORKERS.filter((w) => w !== "fetcher") : WORKERS;
    console.log(`• старт воркерів: ${workers.join(", ")}`);
    for (const w of workers) children.push(startWorker(w, w === "indexer" ? { INDEXER_SKIP_USECASE: "1" } : {}));
    await sleep(4000);

    if (reextract) {
      const snaps = all.filter((r) => catRe.test(r.url) && /techspec/.test(r.url)).slice(offset, offset + n);
      console.log(`• re-extract ${snaps.length} існуючих /techspec/-снапшотів:`);
      for (const s of snaps) {
        console.log("   ", s.url);
        await bus.publish(EventSubjects.PageFetched, {
          id: randomUUID(),
          subject: EventSubjects.PageFetched,
          traceId: randomUUID(),
          occurredAt: new Date().toISOString(),
          payload: { sourceId: s.sourceId, snapshotRef: s.id, url: s.url },
        });
      }
    } else {
      const inCat = all.filter((r) => catRe.test(r.url) && !/techspec/.test(r.url));
      const rows = (inCat.length ? inCat : all).slice(offset, offset + n);
      const sourceId = rows[0]!.sourceId;
      const urls = rows.map((r) => techspecUrl(r.url));
      console.log(`• пілот на ${urls.length} /techspec/ сторінках (live fetch):`);
      for (const u of urls) console.log("   ", u);
      for (const url of urls) {
        await bus.publish(EventSubjects.UrlDiscovered, {
          id: randomUUID(),
          subject: EventSubjects.UrlDiscovered,
          traceId: randomUUID(),
          occurredAt: new Date().toISOString(),
          payload: { sourceId, url, priority: 1 },
        });
      }
    }

    // моніторимо, поки атрибути ростуть, тоді ще трохи (индексація) — до плато
    const deadline = Date.now() + 180_000;
    let last = -1;
    let stagnant = 0;
    while (Date.now() < deadline) {
      const attrs = await db.$count(productAttributes);
      const gained = attrs - attrsBefore;
      process.stdout.write(`\r  product_attributes=${attrs} (+${gained})   `);
      stagnant = attrs === last ? stagnant + 1 : 0;
      last = attrs;
      if (gained > 0 && stagnant >= 6) break; // ~30с без змін після появи атрибутів
      await sleep(5000);
    }
    process.stdout.write("\n");

    const attrsAfter = await db.$count(productAttributes);
    console.log(`\n===== ПІДСУМОК: +${attrsAfter - attrsBefore} атрибутів на ${urls.length} товарів =====`);
    console.log("  (перелік наповнених товарів — окремою перевіркою через API/psql)");

    if (attrsAfter <= attrsBefore) {
      console.error("\n✗ атрибути не зʼявились — лог воркерів:");
      for (const c of children) for (const l of c.tail.slice(-6)) console.error("  " + l);
    }
  } finally {
    for (const c of children) c.kill();
    await bus.drain().catch(() => void 0);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("pilot error:", e?.message ?? e);
  process.exit(1);
});
