/**
 * Етап D — бекфіл таксономії наявних товарів під нову нормалізацію:
 *   1) суб-бренди → материнський (Avent/Fidelio/Evnia → Philips), з guard проти колізії
 *      за unique(brand,name) WHERE active; порожній бренд HDP-проєкторів → Philips;
 *   2) categoryPath → normalizeCategoryPath (розбиття композитів, прибирання серій/шуму, дедуп).
 * Оновлює денормалізовані колонки products.brand / products.category_path (веб-фасети/фільтр/
 * картки одразу чисті). Qdrant-payload категорій оновиться на наступному reindex (Етап E).
 *
 * Запуск: pnpm tsx scripts/normalize-taxonomy.ts [--dry]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createDb, products } from "@wiki/db";
import { normalizeBrand, normalizeCategoryPath } from "../services/resolver/src/taxonomy.js";

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

  // ── 1. Бренди ────────────────────────────────────────────────────────────
  const brandRows = (await db.execute(sql`
    select brand, count(*)::int as n from ${products} where status='active' group by brand
  `)) as unknown as { brand: string | null; n: number }[];

  let brandUpdated = 0;
  for (const r of brandRows) {
    const from = r.brand ?? "";
    const to = normalizeBrand(from);
    if (to === from) continue;
    // guard: не зливати, якщо у материнського бренду вже є активний товар із тією ж назвою
    if (!DRY) {
      const res = (await db.execute(sql`
        update ${products} p set brand = ${to}
        where p.status='active' and p.brand = ${from}
          and not exists (select 1 from ${products} q where q.status='active' and q.brand = ${to} and q.name = p.name and q.id <> p.id)
      `)) as unknown as { count?: number };
      brandUpdated += res.count ?? 0;
    }
    console.log(`  brand: "${from}" → "${to}" (${r.n} товар(ів))`);
  }
  // порожній бренд HDP-проєкторів → Philips (3 товари)
  if (!DRY) {
    const res = (await db.execute(sql`
      update ${products} set brand='Philips' where status='active' and coalesce(brand,'')='' and name ~ '^HDP'
    `)) as unknown as { count?: number };
    if (res.count) console.log(`  brand: (порожній HDP) → "Philips" (${res.count})`);
  }
  // ── 2. Категорії ─────────────────────────────────────────────────────────
  const catRows = await db
    .select({ id: products.id, cp: products.categoryPath })
    .from(products)
    .where(sql`status='active' and jsonb_array_length(coalesce(category_path,'[]'::jsonb)) > 0`);

  let catChanged = 0;
  for (const r of catRows) {
    const norm = normalizeCategoryPath((r.cp as string[]) ?? []);
    if (JSON.stringify(norm) === JSON.stringify(r.cp)) continue;
    catChanged++;
    if (!DRY) {
      await db.execute(sql`update ${products} set category_path = ${JSON.stringify(norm)}::jsonb where id = ${r.id}`);
    }
  }

  console.log(`\n✓ бренди: оновлено ${brandUpdated}${DRY ? " (DRY — оцінка)" : ""}; категорії: змінено ${catChanged}${DRY ? " (DRY)" : ""}`);
  const stillSub = (await db.execute(sql`
    select brand, count(*)::int n from ${products} where status='active' and lower(brand) in ('avent','philips fidelio','evnia') group by brand
  `)) as unknown as { brand: string; n: number }[];
  if (stillSub.length) {
    console.log(`⚠ лишились суб-бренди (колізія назв із Philips): ${stillSub.map((s) => `${s.brand}(${s.n})`).join(", ")}`);
  }
  if (!DRY) console.log("→ для Qdrant-фільтра категорій потрібен reindex (Етап E).");
  process.exit(0);
}

main().catch((e) => {
  console.error("normalize-taxonomy error:", e?.message ?? e);
  process.exit(1);
});
