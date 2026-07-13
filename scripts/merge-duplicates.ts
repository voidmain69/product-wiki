/**
 * Одноразове злиття точних дублів товарів (brand+name) — легасі до URL-family-фіксу
 * та гонок resolver-а. Append-only: дублі → status='merged_away' + merged_into=canonical.
 * Канонічним стає найповніший товар (найбільше унікальних атрибутів). Спільна логіка —
 * у scripts/merge-core.ts.
 *
 * Ідемпотентно: повторний прогін не знайде дублів (фільтр status='active').
 * Запуск: pnpm tsx scripts/merge-duplicates.ts [--dry]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createDb, products } from "@wiki/db";
import { EventBus } from "@wiki/events";
import { MlClient, QdrantIndex } from "@wiki/retrieval";
import { memberStats, rankCanonical, absorbDuplicate, refreshCanonical, bestCategoryMedia, postMerge } from "./merge-core.js";

const ROOT = join(import.meta.dirname, "..");
const DRY = process.argv.includes("--dry");

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
  const db = createDb();

  const groups = (await db.execute(sql`
    select brand, name
    from ${products}
    where ${products.status} = 'active'
    group by brand, name
    having count(*) > 1
    order by count(*) desc
  `)) as unknown as { brand: string; name: string }[];

  console.log(`• знайдено ${groups.length} груп дублів${DRY ? " (DRY RUN)" : ""}`);
  if (!groups.length) process.exit(0);

  const bus = DRY ? null : await EventBus.connect();
  const qdrant = DRY ? null : new QdrantIndex(new MlClient());

  let merged = 0;
  const toReindex: { productId: string; revisionId: string }[] = [];
  const toPurge: string[] = [];

  for (const g of groups) {
    const ids = (await db.execute(sql`select id from ${products} where brand=${g.brand} and name=${g.name} and status='active'`)) as unknown as { id: string }[];
    const ordered = rankCanonical(await memberStats(db, ids.map((r) => r.id)));
    if (ordered.length < 2) continue;
    const [canonical, ...dups] = ordered;

    if (DRY) {
      console.log(`  ${g.brand} ${g.name}: canonical ${canonical!.id.slice(0, 8)} (${canonical!.attrs} attrs) ← ${dups.map((d) => d.id.slice(0, 8)).join(", ")}`);
      merged += dups.length;
      continue;
    }

    const { categoryPath, media } = bestCategoryMedia(ordered);
    const revisionId = await db.transaction(async (tx) => {
      for (const d of dups) await absorbDuplicate(tx, canonical!.id, d.id);
      return refreshCanonical(tx, canonical!.id, categoryPath, media);
    });

    merged += dups.length;
    toReindex.push({ productId: canonical!.id, revisionId });
    for (const d of dups) toPurge.push(d.id);
    if (merged % 50 === 0) console.log(`  … злито ${merged} дублів`);
  }

  console.log(`✓ DB: злито ${merged} дублів у ${groups.length} груп`);
  if (!DRY) await postMerge(bus!, qdrant!, toPurge, toReindex);
  process.exit(0);
}

main().catch((e) => {
  console.error("merge-duplicates error:", e?.message ?? e);
  process.exit(1);
});
