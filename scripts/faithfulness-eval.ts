/**
 * Офлайн eval-харнес faithfulness: проганяє фіксований набір запитів через РЕАЛЬНИЙ
 * chat-пайплайн (runChat логує faithfulness у chat_queries), потім читає й звітує score
 * по кожному + середнє. Потребує піднятих ML (реальний BGE-M3, НЕ ML_DEV_MODE) + LLM.
 * Eval-рядки тегуються session_id `eval-<ts>-<i>` і прибираються після звіту (щоб не
 * псувати /analytics/demand). Manual-інструмент (не CI).
 *
 * Запуск: pnpm tsx scripts/faithfulness-eval.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createDb, chatQueries } from "@wiki/db";
import { createLLM } from "@wiki/llm";
import { MlClient, QdrantIndex } from "@wiki/retrieval";
import { runChat } from "@wiki/chat-orchestrator";

const ROOT = join(import.meta.dirname, "..");

/** Набір інформаційних запитів (info-intent → числові характеристики з контексту). */
const QUERIES = [
  "Які ключові характеристики монітора ASUS ProArt?",
  "Розкажи про навушники Philips Fidelio",
  "Яка роздільність і частота оновлення в моніторів ASUS?",
  "Які функції має бездротова миша Logitech?",
  "Розкажи про дитячі термометри Philips Avent",
];

function loadEnv(): void {
  try {
    for (const line of readFileSync(join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && m[1] && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch {
    /* дефолти */
  }
}

async function main() {
  loadEnv();
  const db = createDb();
  const deps = { db, llm: createLLM(), ml: new MlClient(), qdrant: new QdrantIndex(new MlClient()) };
  const runId = `eval-${Date.now()}`;

  console.log(`• прогін ${QUERIES.length} запитів через runChat (реальний LLM+ML)…`);
  for (let i = 0; i < QUERIES.length; i++) {
    const sid = `${runId}-${i}`;
    try {
      // драйнимо генератор (події не потрібні — цікавить лог faithfulness)
      for await (const _ of runChat(deps, { sessionId: sid, message: QUERIES[i]!, history: [] })) void _;
    } catch (e) {
      console.warn(`  ⚠ запит ${i} впав: ${(e as Error).message}`);
    }
    process.stdout.write(`\r  ${i + 1}/${QUERIES.length}`);
  }
  process.stdout.write("\n");

  const rows = (await db.execute(sql`
    select query_text, intent, faithfulness
    from ${chatQueries} where session_id like ${runId + "-%"} order by session_id
  `)) as unknown as { query_text: string; intent: string; faithfulness: number | null }[];

  console.log("\nРезультати faithfulness (частка заземлених чисел):");
  const scored: number[] = [];
  for (const r of rows) {
    const f = r.faithfulness;
    if (f !== null && f !== undefined) scored.push(Number(f));
    const label = f === null || f === undefined ? "— (не оцінено)" : (Number(f) * 100).toFixed(1) + "%";
    console.log(`  [${r.intent}] ${label}  ${r.query_text}`);
  }
  const avg = scored.length ? (scored.reduce((a, b) => a + b, 0) / scored.length) * 100 : null;
  console.log(`\nСереднє по ${scored.length} оцінених: ${avg === null ? "—" : avg.toFixed(1) + "%"}`);

  // прибираємо eval-рядки, щоб не спотворювати /analytics/demand
  await db.execute(sql`delete from ${chatQueries} where session_id like ${runId + "-%"}`);
  console.log("(eval-рядки прибрано з chat_queries)");
  process.exit(0);
}

main().catch((e) => {
  console.error("faithfulness-eval error:", e?.message ?? e);
  process.exit(1);
});
