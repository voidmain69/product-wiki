/**
 * Звіт якості каталогу (READ-ONLY): де дірки в даних активних товарів — щоб бачити,
 * куди спрямувати докрал/нормалізацію. Нічого не змінює.
 *
 * Метрики: товари без атрибутів / без категорії / без зображення / з порожнім брендом;
 * attr-конфлікти між джерелами (той самий ключ, різні значення); розмір merge_queue.
 *
 * Запуск: pnpm tsx scripts/quality-report.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createDb } from "@wiki/db";

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

async function scalar(db: ReturnType<typeof createDb>, q: ReturnType<typeof sql>): Promise<number> {
  const rows = (await db.execute(q)) as unknown as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}

async function main() {
  loadEnv();
  const db = createDb();

  const total = await scalar(db, sql`select count(*)::int n from products where status='active'`);
  const noAttrs = await scalar(
    db,
    sql`select count(*)::int n from products p where p.status='active'
        and not exists (select 1 from product_attributes a where a.product_id = p.id)`,
  );
  const noCategory = await scalar(
    db,
    sql`select count(*)::int n from products where status='active'
        and jsonb_array_length(coalesce(category_path,'[]'::jsonb)) = 0`,
  );
  const noThumb = await scalar(
    db,
    sql`select count(*)::int n from products where status='active' and coalesce(thumbnail,'') = ''`,
  );
  const blankBrand = await scalar(
    db,
    sql`select count(*)::int n from products where status='active' and coalesce(trim(brand),'') = ''`,
  );
  // attr-конфлікти: (товар, ключ), де провенанс-рядки дають різні канонічні значення
  const attrConflicts = await scalar(
    db,
    sql`select count(*)::int n from (
          select product_id, attr_key from product_attributes
          group by product_id, attr_key having count(distinct value_canonical) > 1
        ) t`,
  );
  const mergePending = await scalar(db, sql`select count(*)::int n from merge_queue where status='pending'`);

  const pct = (n: number) => (total > 0 ? ((n / total) * 100).toFixed(1) + "%" : "—");
  console.log(`\nЯкість каталогу — активних товарів: ${total}\n`);
  console.log(`  без атрибутів:        ${String(noAttrs).padStart(5)}  (${pct(noAttrs)})`);
  console.log(`  без категорії:        ${String(noCategory).padStart(5)}  (${pct(noCategory)})`);
  console.log(`  без зображення:       ${String(noThumb).padStart(5)}  (${pct(noThumb)})`);
  console.log(`  порожній бренд:       ${String(blankBrand).padStart(5)}  (${pct(blankBrand)})`);
  console.log(`  attr-конфлікти:       ${String(attrConflicts).padStart(5)}  (пар товар×ключ)`);
  console.log(`  merge_queue pending:  ${String(mergePending).padStart(5)}`);
  console.log("");
  process.exit(0);
}

main().catch((e) => {
  console.error("quality-report error:", e?.message ?? e);
  process.exit(1);
});
