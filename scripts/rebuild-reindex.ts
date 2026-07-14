/**
 * Етап E — консолідований reindex. Знімки ревізій застаріли (старі ключі/значення/бренд/
 * категорії до dedup/renormalize/ontology-apply/taxonomy). Крок 1: перебудовуємо СВІЖИЙ
 * (дедуплікований, з нормалізованими brand/categoryPath) знімок кожного активного товару
 * (refreshCanonical) — лише БД, без ML. Крок 2: ПАЧКАМИ з паузами емітимо product.updated,
 * щоб indexer наздоганяв рівномірно й не поклав GPU-TEI (як сталось на суцільному беклозі).
 *
 * Індексувати запускати з INDEXER_SKIP_USECASE=1 (без usecase-LLM — легше на GPU).
 * Запуск: pnpm tsx scripts/rebuild-reindex.ts [--batch N] [--pause MS]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createDb, products, productRevisions } from "@wiki/db";
import { EventBus, EventSubjects } from "@wiki/events";
import { refreshCanonical } from "./merge-core.js";

const ROOT = join(import.meta.dirname, "..");
const argN = (flag: string, def: number) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
};
const BATCH = argN("--batch", 40);
const PAUSE = argN("--pause", 2500);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  const bus = await EventBus.connect();

  const rows = await db
    .select({ id: products.id, cp: products.categoryPath, rev: products.currentRevisionId })
    .from(products)
    .where(eq(products.status, "active"));
  console.log(`• перебудовую знімки ${rows.length} активних товарів (БД, без ML)…`);

  const toReindex: { productId: string; revisionId: string }[] = [];
  let n = 0;
  for (const r of rows) {
    // медіа — з поточного знімка ревізії (categoryPath уже нормалізований у products)
    let media: { type: string; url: string }[] = [];
    if (r.rev) {
      const [rev] = await db.select({ snapshot: productRevisions.snapshot }).from(productRevisions).where(eq(productRevisions.id, r.rev)).limit(1);
      const m = (rev?.snapshot as { media?: { type: string; url: string }[] } | undefined)?.media;
      if (Array.isArray(m)) media = m;
    }
    const revisionId = await db.transaction((tx) => refreshCanonical(tx, r.id, (r.cp as string[]) ?? [], media));
    toReindex.push({ productId: r.id, revisionId });
    if (++n % 200 === 0) console.log(`  … ${n}/${rows.length}`);
  }
  console.log(`✓ перебудовано ${toReindex.length} знімків`);

  console.log(`• емітую product.updated пачками по ${BATCH} з паузою ${PAUSE}ms (щоб не перевантажити TEI)…`);
  for (let i = 0; i < toReindex.length; i += BATCH) {
    for (const r of toReindex.slice(i, i + BATCH)) {
      await bus
        .publish(EventSubjects.ProductUpdated, {
          id: `rebuild-${r.revisionId}`,
          subject: EventSubjects.ProductUpdated,
          traceId: `rebuild-${r.productId}`,
          occurredAt: new Date().toISOString(),
          payload: { productId: r.productId, revisionId: r.revisionId },
        })
        .catch(() => void 0);
    }
    process.stdout.write(`\r  емітнуто ${Math.min(i + BATCH, toReindex.length)}/${toReindex.length}`);
    if (i + BATCH < toReindex.length) await sleep(PAUSE);
  }
  process.stdout.write("\n");
  console.log(`✓ емітнуто ${toReindex.length} подій. Indexer добиває у фоні (стеж за points_count у Qdrant і /embed на TEI).`);
  await bus.drain();
  process.exit(0);
}

main().catch((e) => {
  console.error("rebuild-reindex error:", e?.message ?? e);
  process.exit(1);
});
