/**
 * Повний обхід одного джерела: реєструє source (source + outbox-подія в одній
 * транзакції — інваріант 2), піднімає воркер-набір і дає discovery обійти всі
 * entrypoints. Читає лише зі снапшотів/подій, ввічливо (maxRps джерела). Manual:
 * тягне живий сайт, тому НЕ в CI.
 *
 * Запуск: pnpm tsx scripts/full-ingest.ts <source.json> [--fresh]
 *   --fresh — очистити доменні таблиці перед обходом (чистий рахунок).
 *
 * Екстракція завершується канонічними товарами (resolver). indexer/ML тут не
 * піднімаємо — індексація потребує ембедингів (окремий крок з ML-сервісом).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDb, sources, products, productDrafts, pageSnapshots, crawlTasks, outbox } from "@wiki/db";
import { EventBus, EventSubjects } from "@wiki/events";

const ROOT = join(import.meta.dirname, "..");
const WORKERS = ["outbox-relay", "discovery", "fetcher", "extractor", "normalizer", "resolver"];

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
  const cap = (b: Buffer) => { for (const l of b.toString().split(/\r?\n/)) if (l.trim()) c.tail.push(`[${name}] ${l}`); while (c.tail.length > 30) c.tail.shift(); };
  c.stdout!.on("data", cap); c.stderr!.on("data", cap);
  return c;
}

async function main() {
  const srcPath = process.argv[2];
  const fresh = process.argv.includes("--fresh");
  if (!srcPath) { console.error("Використання: pnpm tsx scripts/full-ingest.ts <source.json> [--fresh]"); process.exit(1); }
  loadEnv();
  const src = JSON.parse(readFileSync(srcPath, "utf8"));
  const db = createDb();
  const bus = await EventBus.connect();
  const children: (ChildProcess & { tail: string[] })[] = [];

  try {
    if (fresh) {
      console.log("• purge NATS + TRUNCATE доменних таблиць");
      await bus.purge();
      await db.execute(sql`TRUNCATE crawl_tasks, page_snapshots, product_drafts, product_attributes,
        product_texts, product_revisions, products, merge_queue, chat_queries, outbox, sources RESTART IDENTITY CASCADE`);
    }

    // реєстрація джерела: source + outbox-подія source.registered в одній транзакції
    const now = new Date();
    const sourceId = await db.transaction(async (tx) => {
      const [row] = await tx.insert(sources).values({
        name: src.name,
        domains: src.domains,
        verification: { method: "manual", verifiedBy: "full-ingest", verifiedAt: now.toISOString() },
        crawlPolicy: { entrypoints: src.entrypoints ?? [], urlPatterns: src.urlPatterns ?? [], maxRps: src.maxRps ?? 0.5, recrawlIntervalDays: src.recrawlIntervalDays ?? 30, ...(src.engineHint ? { engineHint: src.engineHint } : {}) },
        status: "active",
      }).returning({ id: sources.id });
      const id = row!.id;
      const traceId = randomUUID();
      await tx.insert(outbox).values({
        subject: EventSubjects.SourceRegistered,
        traceId,
        payload: { id: randomUUID(), subject: EventSubjects.SourceRegistered, traceId, occurredAt: now.toISOString(), payload: { sourceId: id } },
      });
      return id;
    });
    console.log(`• джерело "${src.name}" → ${sourceId}`);

    console.log(`• старт воркерів: ${WORKERS.join(", ")}`);
    for (const w of WORKERS) children.push(startWorker(w));
    console.log("• outbox-relay доставить source.registered → discovery почне обхід sitemap");

    // моніторинг до плато: обхід великий, тому чекаємо, поки products перестане рости
    const deadline = Date.now() + 150 * 60_000; // хард-стоп 150 хв
    let lastProd = -1, stagnant = 0, discovered0 = false;
    while (Date.now() < deadline) {
      const [tasks, snaps, drafts, prods] = await Promise.all([
        db.$count(crawlTasks), db.$count(pageSnapshots), db.$count(productDrafts), db.$count(products),
      ]);
      const ts = new Date(now.getTime() + (Date.now() - now.getTime())).toISOString().slice(11, 19);
      console.log(`[${ts}] queued=${tasks} snapshots=${snaps} drafts=${drafts} products=${prods}`);
      if (tasks > 0) discovered0 = true;
      // плато: discovery відпрацював (є задачі) і products не росте 8 перевірок (~4 хв)
      stagnant = prods === lastProd ? stagnant + 1 : 0;
      lastProd = prods;
      if (discovered0 && snaps >= tasks && stagnant >= 8 && prods > 0) {
        console.log(`\n✓ Обхід завершено (плато): products=${prods}`);
        break;
      }
      await sleep(30_000);
    }

    const [{ n: total }] = await db.select({ n: sql<number>`count(*)::int` }).from(products);
    console.log(`\n===== ПІДСУМОК: ${total} канонічних товарів у БД =====`);
  } finally {
    for (const c of children) c.kill();
    await bus.drain().catch(() => void 0);
  }
  process.exit(0);
}

main().catch((e) => { console.error("full-ingest error:", e?.message ?? e); process.exit(1); });
