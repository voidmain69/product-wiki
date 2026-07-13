/**
 * BC3: перенормалізація значень атрибутів під новий парсер + unit-хінти онтології.
 * Крок 1 — проставляє attribute_ontology.unit_canonical за міткою (guessUnit) ТІЛЬКИ для
 *   ключів, де значення переважно «голі» числа (інакше хінт беззмістовний і ризикований).
 * Крок 2 — переганяє value_raw → value_canonical/unit_canonical для всіх атрибутів
 *   (детермінований parser + хінт ключа для голих чисел).
 * Без LLM (інваріанти 4/5/7). Ідемпотентно. Реіндекс — окремо (scripts/reindex.ts).
 *
 * Запуск: pnpm tsx scripts/renormalize.ts [--dry]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createDb, attributeOntology, productAttributes } from "@wiki/db";
import { normalizeValue, guessUnit } from "../services/normalizer/src/units.js";

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

  // ── Крок 1: unit-хінти онтології ────────────────────────────────────────
  const keys = await db
    .select({ key: attributeOntology.key, label: attributeOntology.label, unit: attributeOntology.unitCanonical })
    .from(attributeOntology);

  let hintsSet = 0;
  for (const k of keys) {
    if (k.unit) continue;
    const guess = guessUnit(k.label);
    if (!guess) continue;
    // safety: застосовуємо хінт лише якщо значення ключа переважно «голі» числа
    // (parser повернув число без юніта). Інакше значення вже несуть свою одиницю/діапазон.
    const samples = (await db.execute(sql`
      select distinct value_raw from ${productAttributes} where attr_key = ${k.key} limit 20
    `)) as unknown as { value_raw: string }[];
    if (!samples.length) continue;
    const bare = samples.filter((s) => {
      const n = normalizeValue(s.value_raw);
      return typeof n.value === "number" && n.unit === null;
    }).length;
    if (bare / samples.length < 0.5) continue;

    if (!DRY) await db.update(attributeOntology).set({ unitCanonical: guess }).where(sql`${attributeOntology.key} = ${k.key}`);
    hintsSet++;
  }
  console.log(`✓ unit-хінтів проставлено: ${hintsSet}${DRY ? " (DRY)" : ""}`);

  // ── Крок 2: перенормалізація за УНІКАЛЬНИМИ (ключ, value_raw) парами ───────
  // (їх ~13x менше, ніж рядків) → set-based UPDATE...FROM VALUES одним hash-join'ом.
  const hint = new Map<string, string | null>(
    (await db.select({ key: attributeOntology.key, unit: attributeOntology.unitCanonical }).from(attributeOntology)).map((o) => [o.key, o.unit]),
  );

  const pairs = (await db.execute(sql`
    select attr_key, value_raw, count(*)::int as n from ${productAttributes} group by attr_key, value_raw
  `)) as unknown as { attr_key: string; value_raw: string; n: number }[];
  console.log(`• ${pairs.length} унікальних (ключ, значення) пар${DRY ? " (DRY)" : ""}`);

  let withUnit = 0;
  const upd = pairs.map((p) => {
    const { value, unit } = normalizeValue(p.value_raw, hint.get(p.attr_key) ?? undefined);
    if (unit) withUnit += p.n;
    return { k: p.attr_key, r: p.value_raw, vc: JSON.stringify(value), uc: unit };
  });

  if (!DRY) {
    // temp-таблиця + один set-based UPDATE (у транзакції — щоб temp жила на одному
    // зʼєднанні пулу). Insert батчами, оновлення — одним hash-join'ом за (ключ, значення).
    await db.transaction(async (tx) => {
      await tx.execute(sql`create temp table renorm_map (k text, r text, vc jsonb, uc text) on commit drop`);
      const CH = 500;
      for (let i = 0; i < upd.length; i += CH) {
        const rows = upd.slice(i, i + CH).map((u) => sql`(${u.k}, ${u.r}, ${u.vc}::jsonb, ${u.uc}::text)`);
        await tx.execute(sql`insert into renorm_map (k, r, vc, uc) values ${sql.join(rows, sql`, `)}`);
        process.stdout.write(`  … insert ${Math.min(i + CH, upd.length)}/${upd.length}\r`);
      }
      await tx.execute(sql`create index on renorm_map (k, r)`);
      process.stdout.write("\n  … UPDATE join…\n");
      await tx.execute(sql`
        update ${productAttributes} pa
        set value_canonical = m.vc, unit_canonical = m.uc
        from renorm_map m
        where pa.attr_key = m.k and pa.value_raw = m.r
      `);
    });
  }

  const total = pairs.reduce((s, p) => s + p.n, 0);
  console.log(`✓ перенормалізовано ${total} атрибутів; з одиницею тепер: ${withUnit} (${Math.round((100 * withUnit) / Math.max(1, total))}%)`);
  if (!DRY) console.log("→ запусти scripts/reindex.ts, щоб оновити Qdrant новими value/unit.");
  process.exit(0);
}

main().catch((e) => {
  console.error("renormalize error:", e?.message ?? e);
  process.exit(1);
});
