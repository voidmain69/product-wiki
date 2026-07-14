/**
 * Звіт попиту для куратора: найчастіші no_results-запити (чого бракує в каталозі) за
 * період + частка «не знаю». Сигнал, які нові джерела реєструвати (петля людська).
 *
 * Запуск: pnpm tsx scripts/demand-report.ts [days=30] [limit=20]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, gte, sql, desc } from "drizzle-orm";
import { createDb, chatQueries } from "@wiki/db";

const ROOT = join(import.meta.dirname, "..");

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
  const days = Math.max(1, Math.floor(Number(process.argv[2])) || 30);
  const limit = Math.max(1, Math.floor(Number(process.argv[3])) || 20);
  const cutoff = new Date(Date.now() - days * 86_400_000);

  const [{ total }] = (await db
    .select({ total: sql<number>`count(*)::int` })
    .from(chatQueries)
    .where(gte(chatQueries.createdAt, cutoff))) as [{ total: number }];
  const [{ nr }] = (await db
    .select({ nr: sql<number>`count(*)::int` })
    .from(chatQueries)
    .where(and(gte(chatQueries.createdAt, cutoff), eq(chatQueries.noResults, true)))) as [{ nr: number }];

  const topNoResults = await db
    .select({ q: chatQueries.queryText, n: sql<number>`count(*)::int`, last: sql<string>`max(${chatQueries.createdAt})` })
    .from(chatQueries)
    .where(and(gte(chatQueries.createdAt, cutoff), eq(chatQueries.noResults, true)))
    .groupBy(chatQueries.queryText)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);

  const share = total > 0 ? ((nr / total) * 100).toFixed(1) : "0.0";
  console.log(`\nПопит за ${days} дн.: усього запитів ${total}, «не знаю» ${nr} (${share}%)\n`);
  if (!topNoResults.length) {
    console.log("Немає no_results-запитів за період — каталог покриває попит.");
    process.exit(0);
  }
  console.log(`Топ ${topNoResults.length} «не знаю» (чого бракує → кандидати на нові джерела):`);
  for (const r of topNoResults) {
    console.log(`  ${String(r.n).padStart(4)}×  ${r.q}   (востаннє ${new Date(r.last).toISOString().slice(0, 10)})`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("demand-report error:", e?.message ?? e);
  process.exit(1);
});
