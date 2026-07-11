/**
 * Bounded live ingest ОДНІЄЇ реальної сторінки виробника (без sitemap-краулу) —
 * доводить crawl (robots.txt) → extract (JSON-LD) → normalize → resolve на живих
 * даних, ввічливо (рівно один fetch). Manual-only: тягне зовнішній сайт, тому НЕ
 * в CI. Джерело реєструється з JSON, URL публікується напряму як url.discovered.
 *
 * Запуск: pnpm smoke:real <source.json> <product-url>
 *   pnpm smoke:real infra/sources/logitech.json https://www.logitech.com/en-us/products/mice/mx-master-3s.html
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sql, desc } from "drizzle-orm";
import { createDb, sources, products, productDrafts, pageSnapshots } from "@wiki/db";
import { EventBus, EventSubjects } from "@wiki/events";

const ROOT = join(import.meta.dirname, "..");
const WORKERS = ["outbox-relay", "fetcher", "extractor", "normalizer", "resolver"];

function loadEnv(): void {
  try {
    for (const line of readFileSync(join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && m[1] && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch { /* дефолти оточення */ }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function startWorker(name: string): ChildProcess & { tail: string[] } {
  const c = spawn(process.execPath, ["--import", "tsx", `services/${name}/src/main.ts`], {
    cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"],
  }) as ChildProcess & { tail: string[] };
  c.tail = [];
  const cap = (b: Buffer) => { for (const l of b.toString().split(/\r?\n/)) if (l.trim()) c.tail.push(`[${name}] ${l}`); while (c.tail.length > 20) c.tail.shift(); };
  c.stdout!.on("data", cap); c.stderr!.on("data", cap);
  return c;
}

async function main() {
  const [srcPath, url] = process.argv.slice(2);
  if (!srcPath || !url) { console.error("Використання: pnpm smoke:real <source.json> <product-url>"); process.exit(1); }
  loadEnv();
  const src = JSON.parse(readFileSync(srcPath, "utf8"));
  const db = createDb();
  const bus = await EventBus.connect();
  const children: (ChildProcess & { tail: string[] })[] = [];
  let ok = false;

  try {
    console.log("• purge NATS + TRUNCATE доменних таблиць");
    await bus.purge();
    await db.execute(sql`TRUNCATE crawl_tasks, page_snapshots, product_drafts, product_attributes,
      product_texts, product_revisions, products, merge_queue, chat_queries, outbox, sources RESTART IDENTITY CASCADE`);

    const [row] = await db.insert(sources).values({
      name: src.name,
      domains: src.domains,
      verification: { method: "manual", verifiedBy: "smoke-real", verifiedAt: new Date().toISOString() },
      crawlPolicy: { entrypoints: src.entrypoints ?? [], urlPatterns: src.urlPatterns ?? [], maxRps: src.maxRps ?? 0.5, recrawlIntervalDays: src.recrawlIntervalDays ?? 30, ...(src.engineHint ? { engineHint: src.engineHint } : {}) },
      status: "active",
    }).returning({ id: sources.id });
    const sourceId = row!.id;
    console.log(`• джерело "${src.name}" → ${sourceId}`);

    console.log(`• старт воркерів: ${WORKERS.join(", ")}`);
    for (const w of WORKERS) children.push(startWorker(w));
    await sleep(3500);

    // публікуємо РІВНО один url.discovered (без sitemap-краулу) — ввічливо
    const traceId = randomUUID();
    await bus.publish(EventSubjects.UrlDiscovered, {
      id: randomUUID(), subject: EventSubjects.UrlDiscovered, traceId,
      occurredAt: new Date().toISOString(), payload: { sourceId, url, priority: 1 },
    });
    console.log(`• url.discovered → ${url}`);

    const deadline = Date.now() + 45_000;
    let prod = 0;
    while (Date.now() < deadline) {
      const [snaps, drafts, prods] = await Promise.all([db.$count(pageSnapshots), db.$count(productDrafts), db.$count(products)]);
      prod = prods;
      process.stdout.write(`\r  snapshots=${snaps} drafts=${drafts} products=${prods}   `);
      if (prod >= 1 && snaps >= 1 && drafts >= 1) break;
      await sleep(1500);
    }
    process.stdout.write("\n");

    if (prod < 1) {
      console.error("✗ FAIL: канонічний товар не створено");
      for (const c of children) for (const l of c.tail) console.error("  " + l);
      throw new Error("no product");
    }

    const [p] = await db.select().from(products).orderBy(desc(products.updatedAt)).limit(1);
    const [snap] = await db.select({ url: pageSnapshots.url }).from(pageSnapshots).limit(1);
    console.log("\n✓ Реальний товар з живого сайту виробника:");
    console.log(`  ${p?.brand} ${p?.name}`);
    console.log(`  mpn=${p?.mpn ?? "—"} gtin=${p?.gtin ?? "—"}`);
    console.log(`  provenance: ${snap?.url}`);
    ok = true;
  } finally {
    for (const c of children) c.kill();
    await bus.drain().catch(() => void 0);
  }
  console.log(ok ? "\n✓ REAL SMOKE PASS — жива екстракція працює" : "\n✗ REAL SMOKE FAIL");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("smoke-real error:", e.message); process.exit(1); });
