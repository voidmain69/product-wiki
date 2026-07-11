/**
 * E2E smoke-прогін ingest-пайплайна проти ЖИВОЇ інфраструктури, БЕЗ зовнішньої
 * мережі й БЕЗ LLM (детермінований JSON-LD-шлях). Доводить наскрізний потік:
 *
 *   register-source → source.registered → discovery → url.discovered → fetcher
 *     → page.fetched → extractor → draft.extracted → normalizer → draft.normalized
 *     → resolver → product.updated → канонічний товар з provenance у Postgres.
 *
 * Індексацію (product.updated → Qdrant) не запускаємо — вона потребує ML-сервісу.
 *
 * Герметичність: purge NATS-стріму + TRUNCATE доменних таблиць на старті, тож
 * жоден реальний домен не зачіпається — лише локальний fixture-сервер.
 *
 * Передумови: `pnpm infra:up` + `pnpm db:migrate && pnpm db:seed`.
 * Запуск: pnpm smoke:ingest
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sql, isNotNull, eq } from "drizzle-orm";
import { createDb, products, productAttributes, pageSnapshots, productDrafts, sources, crawlTasks } from "@wiki/db";
import { EventBus } from "@wiki/events";
import { MlClient, QdrantIndex, COLLECTION } from "@wiki/retrieval";
// @ts-expect-error — .mjs без типів (fixture лишається plain-JS для standalone-запуску)
import { startFixtureServer, FIXTURE_BRAND, FIXTURE_PRODUCT_COUNT } from "./fixture-server.mjs";

const ROOT = join(import.meta.dirname, "..");
const FIXTURE_PORT = 4599;
const INGEST_WORKERS = ["outbox-relay", "discovery", "fetcher", "extractor", "normalizer", "resolver"];

/** Чи доступний ML-сервіс (для indexing + retrieval). */
async function mlUp(): Promise<boolean> {
  const url = process.env.ML_HTTP_URL ?? "http://localhost:8080";
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Скидає колекцію Qdrant (герметичність retrieval-перевірки). */
async function resetQdrant(): Promise<void> {
  const url = process.env.QDRANT_URL ?? "http://localhost:6333";
  await fetch(`${url}/collections/${COLLECTION}`, { method: "DELETE" }).catch(() => void 0);
}

/** Завантажує .env у process.env (createDb/EventBus читають звідти). */
function loadEnv(): void {
  try {
    for (const line of readFileSync(join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && m[1] && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch {
    console.warn("! .env не знайдено — використовую дефолти оточення");
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function startWorker(name: string): ChildProcess & { tail: string[] } {
  const child = spawn(process.execPath, ["--import", "tsx", `services/${name}/src/main.ts`], {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  }) as ChildProcess & { tail: string[] };
  child.tail = [];
  const cap = (buf: Buffer) => {
    for (const l of buf.toString().split(/\r?\n/)) if (l.trim()) child.tail.push(`[${name}] ${l}`);
    while (child.tail.length > 25) child.tail.shift();
  };
  child.stdout!.on("data", cap);
  child.stderr!.on("data", cap);
  return child;
}

async function main() {
  loadEnv();
  const db = createDb();
  const bus = await EventBus.connect();
  const children: (ChildProcess & { tail: string[] })[] = [];
  let fixture: { close: () => void } | undefined;
  let ok = false;

  try {
    // ML доступний? Тоді додаємо indexing + retrieval до перевірки.
    const withIndex = await mlUp();
    const workers = withIndex ? [...INGEST_WORKERS, "indexer"] : INGEST_WORKERS;
    console.log(withIndex ? "• ML-сервіс доступний → + indexer/retrieval" : "• ML-сервіс недоступний → лише ingest");

    // 1. Герметичність: чистимо NATS-стрім, Qdrant-колекцію і доменні таблиці
    console.log("• purge NATS + Qdrant + TRUNCATE доменних таблиць");
    await bus.purge();
    if (withIndex) await resetQdrant();
    await db.execute(sql`TRUNCATE crawl_tasks, page_snapshots, product_drafts, product_attributes,
      product_texts, product_revisions, products, merge_queue, chat_queries, outbox, sources
      RESTART IDENTITY CASCADE`);

    // 2. Fixture-сайт виробника
    fixture = await startFixtureServer(FIXTURE_PORT);
    const origin = `http://127.0.0.1:${FIXTURE_PORT}`;

    // 3. Воркери (споживачі подій) — створюють свіжі durable-консюмери
    console.log(`• старт воркерів: ${workers.join(", ")}`);
    for (const w of workers) children.push(startWorker(w));
    await sleep(3500);

    // 4. Реєстрація fixture-джерела реальним CLI (source + outbox транзакційно)
    console.log("• register-source (fixture)");
    const src = {
      name: FIXTURE_BRAND,
      domains: ["127.0.0.1"],
      entrypoints: [`${origin}/sitemap.xml`],
      urlPatterns: ["/products/[^/]+$"],
      maxRps: 5,
      recrawlIntervalDays: 30,
    };
    const tmp = join(mkdtempSync(join(tmpdir(), "smoke-")), "source.json");
    writeFileSync(tmp, JSON.stringify(src));
    await runOnce("apps/api/src/cli/register-source.ts", tmp);

    // 5. Полінг канонічних товарів
    console.log(`• чекаю ${FIXTURE_PRODUCT_COUNT} канонічні товари...`);
    const deadline = Date.now() + 60_000;
    let count = 0;
    while (Date.now() < deadline) {
      const [snaps, drafts, prods] = await Promise.all([
        db.$count(pageSnapshots),
        db.$count(productDrafts),
        db.$count(products, isNotNull(products.currentRevisionId)),
      ]);
      count = prods;
      process.stdout.write(`\r  snapshots=${snaps} drafts=${drafts} products=${prods}   `);
      if (count >= FIXTURE_PRODUCT_COUNT) break;
      await sleep(1500);
    }
    process.stdout.write("\n");

    if (count < FIXTURE_PRODUCT_COUNT) {
      const [tasks] = await db.select({ n: sql<number>`count(*)` }).from(crawlTasks);
      const [srcCount] = await db.select({ n: sql<number>`count(*)` }).from(sources);
      console.error(`✗ FAIL: ${count}/${FIXTURE_PRODUCT_COUNT} товарів; crawl_tasks=${tasks?.n} sources=${srcCount?.n}`);
      for (const c of children) for (const l of c.tail) console.error("  " + l);
      throw new Error("pipeline did not complete");
    }

    // 6. Результат з provenance
    console.log("\n✓ Канонічні товари з provenance:\n");
    const rows = await db
      .select({
        product: sql<string>`${products.brand} || ' ' || ${products.name}`,
        attr: productAttributes.attrKey,
        value: productAttributes.valueRaw,
        unit: productAttributes.unitCanonical,
        sourceUrl: pageSnapshots.url,
      })
      .from(productAttributes)
      .innerJoin(products, eq(products.id, productAttributes.productId))
      .innerJoin(pageSnapshots, eq(pageSnapshots.id, productAttributes.sourceSnapshotId))
      .orderBy(products.name, productAttributes.attrKey);
    for (const r of rows) {
      const path = new URL(r.sourceUrl).pathname;
      console.log(`  ${r.product.padEnd(22)} ${r.attr.padEnd(14)} ${String(r.value).padEnd(6)} ${r.unit ?? ""}  ← ${path}`);
    }

    // 7. Індексація + retrieval (лише якщо ML доступний)
    if (withIndex) {
      const qdrant = new QdrantIndex(new MlClient());
      const qUrl = process.env.QDRANT_URL ?? "http://localhost:6333";

      // чекаємо, поки indexer наб'є чанки в Qdrant
      console.log("\n• чекаю індексацію в Qdrant...");
      const idxDeadline = Date.now() + 30_000;
      let pts = 0;
      while (Date.now() < idxDeadline) {
        const info = (await fetch(`${qUrl}/collections/${COLLECTION}`)
          .then((r) => r.json())
          .catch(() => null)) as { result?: { points_count?: number } } | null;
        pts = info?.result?.points_count ?? 0;
        if (pts > 0) break;
        await sleep(1500);
      }
      console.log(`  Qdrant points=${pts}`);
      if (pts === 0) throw new Error("indexer did not populate Qdrant");

      // дискримінуючий лексичний запит: "LiDAR ... 200 м²" є лише в RoboVac X40
      const [expected] = await db
        .select({ id: products.id, name: products.name })
        .from(products)
        .where(sql`${products.name} ILIKE '%RoboVac%'`)
        .limit(1);
      const hits = await qdrant.search("LiDAR навігація для великих квартир до 200 м²", {}, 10);
      const top = hits[0];
      console.log("\n✓ Retrieval (гібридний dense+sparse RRF):");
      console.log(`  запит → топ товар: ${top?.productId === expected?.id ? "RoboVac X40 ✓" : top?.productId} (score ${top?.score.toFixed(3)})`);
      if (!top || top.productId !== expected?.id) {
        throw new Error(`retrieval expected RoboVac X40 (${expected?.id}), got ${top?.productId}`);
      }
    }

    ok = true;
  } finally {
    for (const c of children) c.kill();
    fixture?.close();
    await bus.drain().catch(() => void 0);
  }

  console.log(ok ? "\n✓ SMOKE PASS — ingest працює наскрізь" : "\n✗ SMOKE FAIL");
  process.exit(ok ? 0 : 1);
}

/** Запускає одноразовий tsx-процес (CLI) і чекає завершення. */
function runOnce(script: string, ...args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ["--import", "tsx", script, ...args], { cwd: ROOT, env: process.env, stdio: "inherit" });
    c.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`))));
  });
}

main().catch((err) => {
  console.error("smoke-ingest error:", err.message);
  process.exit(1);
});
