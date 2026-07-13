/**
 * BC (одноразово, ідемпотентно): проставляє product_texts.lang за курованою мовою
 * джерела (sources.crawl_policy->>'lang'). Виправляє тексти, збережені resolver-ом до
 * фіксу хардкоду lang:"uk" (напр. англомовний Logitech). Джерело правди — crawlPolicy.lang,
 * тож спершу онови sources (crawl_policy) для не-укр джерел, потім запусти цей скрипт.
 *
 * Re-run resolver-а НЕ робимо (він наплодив би зайвих ревізій/дублів текстів). Стале lang
 * у product_revisions.snapshot.texts[] лишиться до наступної ревізії — прийнятно (chunker
 * і merge-core беруть lang з product_texts, не зі snapshot; самозагоїться на recrawl).
 *
 * Запуск: pnpm tsx scripts/backfill-text-lang.ts [--dry]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createDb } from "@wiki/db";

const ROOT = join(import.meta.dirname, "..");
const DRY = process.argv.includes("--dry");

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

  // Тексти, чия мова розходиться з курованою мовою джерела (через provenance-снапшот).
  const preview = (await db.execute(sql`
    select s.crawl_policy->>'lang' as lang, count(*)::int as n
    from product_texts pt
    join page_snapshots ps on ps.id = pt.source_snapshot_id
    join sources s on s.id = ps.source_id
    where s.crawl_policy->>'lang' is not null
      and pt.lang <> s.crawl_policy->>'lang'
    group by s.crawl_policy->>'lang'
  `)) as unknown as { lang: string; n: number }[];

  const total = preview.reduce((acc, r) => acc + Number(r.n), 0);
  if (!total) {
    console.log("Нема текстів для оновлення (усі lang уже відповідають джерелу).");
    process.exit(0);
  }
  for (const r of preview) console.log(`  → ${r.lang}: ${r.n} текст(ів)`);

  if (DRY) {
    console.log(`(DRY) оновилось би ${total} текст(ів).`);
    process.exit(0);
  }

  await db.execute(sql`
    update product_texts pt
    set lang = s.crawl_policy->>'lang'
    from page_snapshots ps
    join sources s on s.id = ps.source_id
    where ps.id = pt.source_snapshot_id
      and s.crawl_policy->>'lang' is not null
      and pt.lang <> s.crawl_policy->>'lang'
  `);
  console.log(`✓ оновлено ${total} текст(ів) product_texts.lang.`);
  process.exit(0);
}

main().catch((e) => {
  console.error("backfill-text-lang error:", e?.message ?? e);
  process.exit(1);
});
